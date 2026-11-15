import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageControlHandle } from "../src/session/message-control";
import {
	assistantTurn,
	cleanupSdkTest,
	type Gate,
	gate,
	MODEL,
	messageText,
	requireControl,
	response,
	type SdkFixtureOptions,
	sdkFixture,
	withTimeout,
} from "./message-control-sdk-harness";

/**
 * 真实 SDK 消息控制契约。P1-5 只准备测试与门闩：
 * - 所有行为用例先经过 requireControl()；接口缺失时抛出 BLOCKED_MISSING_API，不写 expect，也不 skip/todo。
 * - 门闩、spy、假 timer、会话与临时目录统一由 cleanupSdkTest() 清理，原测试失败时也会释放非合作工具。
 */

afterEach(async () => {
	await cleanupSdkTest();
});

async function fixture(tools: ToolDefinition[] = [], options: Partial<SdkFixtureOptions> = {}) {
	return sdkFixture({ ...options, tools });
}

function identity(session: AgentSession, control: MessageControlHandle) {
	return {
		sessionId: session.sessionId,
		runtimeId: control.getSnapshot().runtimeId,
	};
}

function request(
	session: AgentSession,
	id: string,
	mode: "queue" | "steer" | "interrupt" = "queue",
	text = id,
) {
	return {
		...identity(session, requireControl(session)),
		requestId: id,
		mode,
		payload: { text },
	};
}

const turn = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") =>
	assistantTurn(content, stopReason);

async function workingTool() {
	const entered = gate(),
		release = gate();
	const log: string[] = [];
	const { session, requests } = await fixture([
		{
			name: "controlled_gate",
			label: "gate",
			description: "memory-only test tool",
			parameters: Type.Object({}),
			execute: async (_id, _args, signal) => {
				log.push("tool:start");
				signal?.addEventListener("abort", () => log.push("tool:abort"), { once: true });
				entered.resolve();
				await release.promise;
				log.push("tool:end");
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		},
	]);
	let calls = 0;
	session.agent.streamFunction = (_model, context, options) => {
		requests.push(structuredClone(context.messages));
		log.push(`model:${++calls}`);
		return response(
			options?.signal?.aborted
				? turn([], "aborted")
				: calls === 1
					? turn([{ type: "toolCall", id: "gate-1", name: "controlled_gate", arguments: {} }], "toolUse")
					: turn([{ type: "text", text: "done" }]),
		);
	};
	session.subscribe((event) => {
		if (event.type === "message_start" && event.message.role === "user")
			log.push(`user:${messageText(event.message.content)}`);
	});
	const c = requireControl(session);
	expect(session.getActiveToolNames()).toContain("controlled_gate");
	await c.submit(request(session, "old"));
	await vi.waitFor(() => expect(log).toContain("tool:start"));
	await withTimeout(entered.promise, 5000, "working tool entered");
	return { session, c, log, release, requests };
}

describe("AgentSession message control (idle, identity, queue boundaries)", () => {
	it("[§6.5 idle] submits an idle message through the real agent loop and correlates its identity", async () => {
		const { session, requests } = await fixture();
		const control = requireControl(session);
		const runtimeId = control.getSnapshot().runtimeId;
		const ack = await control.submit({
			sessionId: session.sessionId,
			runtimeId,
			requestId: "request-a",
			mode: "queue",
			payload: { text: "hello" },
		});
		expect(ack).toMatchObject({
			ok: true,
			value: { requestId: "request-a", messageId: "request-a", disposition: "started" },
		});
		await control.waitForIdle();
		expect(requests).toHaveLength(1);
		expect(
			session.messages.some(
				(message) => message.role === "user" && JSON.stringify(message.content).includes("hello"),
			),
		).toBe(true);
		expect(control.getSnapshot().phase).toBe("idle");
	});

	it("[§6.5 identity] is idempotent for identical request IDs and rejects stale revisions", async () => {
		const { session } = await fixture();
		const control = requireControl(session);
		const request = {
			sessionId: session.sessionId,
			runtimeId: control.getSnapshot().runtimeId,
			requestId: "same-request",
			mode: "queue" as const,
			payload: { text: "same payload" },
		};
		const first = await control.submit(request);
		const duplicate = await control.submit(request);
		expect(duplicate).toEqual(first);
		const conflict = await control.submit({ ...request, payload: { text: "different payload" } });
		expect(conflict).toMatchObject({ ok: false, error: { code: "request_id_conflict" } });
		const stale = control.recover({
			...request,
			requestId: "stale-recovery",
			messageId: "missing",
			expectedRevision: 0,
		});
		expect(stale).toMatchObject({ ok: false, error: { code: "stale_revision" } });
		await control.waitForIdle();
	});

	it.each(["queue", "steer"] as const)(
		"[§6.5 boundaries] %s respects actual tool-result boundaries",
		async (mode) => {
			const { session, c, log, release } = await workingTool();
			await c.submit(request(session, "next", mode));
			await vi.waitFor(() => expect(session.agent.hasQueuedMessages()).toBe(true));
			expect(log).not.toContain("user:next");
			release.resolve();
			await c.waitForIdle();
			expect(log.indexOf("tool:end")).toBeLessThan(log.indexOf("user:next"));
			if (mode === "steer") expect(log.indexOf("user:next")).toBeLessThan(log.indexOf("model:2"));
			else expect(log.indexOf("user:next")).toBeGreaterThan(log.indexOf("model:2"));
			expect(c.getSnapshot().items).toEqual([]);
		},
	);

	it("[§6.5 interrupt] waits for an uncooperative tool, freezes the old queue, then runs only the new input", async () => {
		const { session, c, log, release } = await workingTool();
		await c.submit(request(session, "queued"));
		await vi.waitFor(() => expect(session.agent.hasQueuedMessages()).toBe(true));
		const result = await c.submit(request(session, "urgent", "interrupt"));
		expect(result).toMatchObject({ ok: true, value: { disposition: "interrupting" } });
		expect(log).toContain("tool:abort");
		expect(log).not.toContain("user:urgent");
		expect(c.getSnapshot().items.find((i) => i.messageId === "queued")?.state).toBe("held");
		expect(await c.submit(request(session, "urgent-2", "interrupt"))).toMatchObject({
			ok: false,
			error: { code: "busy" },
		});
		release.resolve();
		await c.waitForIdle();
		expect(log.indexOf("tool:end")).toBeLessThan(log.indexOf("user:urgent"));
		expect(log).not.toContain("user:queued");
		expect(c.getSnapshot().phase).toBe("idle");
	});

	it("[§6.5 stop-payload] stop preserves full queued payloads, pauses external wake-ups, and permits a later explicit user send", async () => {
		const { session, c, log, release } = await workingTool();
		// Queue an image without needing to normalize it: it will be recovered, never submitted.
		session.agent.state.model = { ...MODEL, input: ["text", "image"] };
		const payload = {
			text: "with image",
			images: [{ mimeType: "image/png", data: "eA==" }],
			draft: {
				text: "raw",
				attachments: ["a.ts"],
				quotes: ["quote"],
				slashCommand: null,
				imageNames: ["picture"],
			},
		};
		await c.submit({ ...request(session, "image-queue"), payload });
		await vi.waitFor(() => expect(session.agent.hasQueuedMessages()).toBe(true));
		c.stop(request(session, "stop"));
		await session.sendUserMessage("external notification", { deliverAs: "followUp" });
		release.resolve();
		await c.waitForIdle();
		expect(log).not.toContain("user:with image");
		expect(log).not.toContain("user:external notification");
		expect(c.getSnapshot().autoDispatchPaused).toBe(true);
		const recovered = c.recover({
			...request(session, "recover"),
			messageId: "image-queue",
			expectedRevision: c.getSnapshot().revision,
		});
		expect(recovered).toMatchObject({ ok: true, value: { payload } });
		await c.submit(request(session, "manual-new", "steer"));
		await c.waitForIdle();
		expect(log).toContain("user:external notification");
		expect(log).toContain("user:manual-new");
		expect(log).not.toContain("user:with image");
	});

	it("[§6.5 second-stop] a second stop cancels interrupt's send-after-stop promise", async () => {
		const { session, c, log, release } = await workingTool();
		await c.submit(request(session, "urgent", "interrupt"));
		c.stop(request(session, "stop-again"));
		release.resolve();
		await c.waitForIdle();
		expect(log).not.toContain("user:urgent");
		expect(c.getSnapshot().items).toContainEqual(
			expect.objectContaining({ messageId: "urgent", state: "held" }),
		);
	});

	it("[§6.5 30s-blocked] a 30-second timeout never permits late automatic submission", async () => {
		const { session, c, log, release } = await workingTool();
		vi.useFakeTimers();
		try {
			await c.submit(request(session, "urgent", "interrupt"));
			await vi.advanceTimersByTimeAsync(5000);
			expect(c.getSnapshot().operation?.slow).toBe(true);
			await vi.advanceTimersByTimeAsync(25000);
			expect(c.getSnapshot()).toMatchObject({
				phase: "blocked",
				operation: { sendAfterStop: false },
			});
			release.resolve();
			await c.waitForIdle();
			expect(log).not.toContain("user:urgent");
			expect(c.getSnapshot()).toMatchObject({ phase: "idle", autoDispatchPaused: true });
		} finally {
			vi.useRealTimers();
		}
	});

	it("[§6.5 mode-change] removes actual transport entries on recover/discard and changes mode without duplicate execution", async () => {
		const { session, c, log, release } = await workingTool();
		await c.submit(request(session, "next"));
		await vi.waitFor(() => expect(session.agent.hasQueuedMessages()).toBe(true));
		const converted = await c.changePending({
			...request(session, "convert"),
			messageId: "next",
			expectedRevision: c.getSnapshot().revision,
			action: "steer",
		});
		expect(converted.ok).toBe(true);
		release.resolve();
		await c.waitForIdle();
		expect(log.filter((s) => s === "user:next")).toHaveLength(1);
		expect(log.indexOf("user:next")).toBeLessThan(log.indexOf("model:2"));
	});

	it("[§6.5 nested-input] nested input and settled callbacks can await public input without deadlock", async () => {
		const { session, requests } = await fixture();
		const internals = session as unknown as {
			_runInputHandlers: (
				text: string,
				images: unknown,
				source: string,
				behavior?: string,
			) => Promise<{ text: string; images: unknown }>;
		};
		const original = internals._runInputHandlers.bind(session);
		vi.spyOn(internals, "_runInputHandlers").mockImplementation(async (text, images, source, behavior) => {
			if (text === "parent") await session.sendUserMessage("nested");
			return original(text, images, source, behavior);
		});
		const c = requireControl(session);
		await c.submit(request(session, "parent"));
		await c.waitForIdle();
		expect(requests.length).toBeGreaterThan(0);
		expect(JSON.stringify(session.messages)).toContain("nested");
	});

	it("[§6.5 settled-followup] a settled callback enqueues external input without waiting on itself", async () => {
		const { session, requests } = await fixture();
		const internal = session as unknown as {
			_extensionRunner: { emit: (event: { type: string }) => Promise<unknown> };
		};
		const emit = internal._extensionRunner.emit.bind(internal._extensionRunner);
		let sent = false;
		vi.spyOn(internal._extensionRunner, "emit").mockImplementation(async (event) => {
			if (event.type === "agent_settled" && !sent) {
				sent = true;
				await session.sendUserMessage("settled-followup");
			}
			return emit(event);
		});
		const c = requireControl(session);
		await c.submit(request(session, "parent"));
		await c.waitForIdle();
		expect(requests).toHaveLength(2);
		expect(c.getSnapshot().items).toEqual([]);
	});

	it("[§6.5 interrupt-handled] interrupt replacement handled by input keeps wake-ups paused", async () => {
		const { session, c, log, release } = await workingTool();
		const internal = session as unknown as {
			_runInputHandlers: (
				text: string,
				images: unknown,
				source: string,
				behavior?: string,
			) => Promise<{ text: string; images: unknown } | undefined>;
		};
		const original = internal._runInputHandlers.bind(session);
		vi.spyOn(internal, "_runInputHandlers").mockImplementation(async (text, images, source, behavior) => {
			if (text === "handled-new") {
				await session.sendUserMessage("handler-wakeup");
				return undefined;
			}
			return original(text, images, source, behavior);
		});
		await c.submit(request(session, "handled-new", "interrupt"));
		release.resolve();
		await c.waitForIdle();
		expect(log).not.toContain("user:handled-new");
		expect(log).not.toContain("user:handler-wakeup");
		expect(c.getSnapshot().autoDispatchPaused).toBe(true);
	});

	it("[§6.5 capacity] capacity and stale identities reject without aborting work", async () => {
		const { session, c, log, release } = await workingTool();
		await c.submit(request(session, "queued"));
		expect(await c.submit(request(session, "overfull"))).toMatchObject({
			ok: false,
			error: { code: "queue_full" },
		});
		expect(
			await c.submit({ ...request(session, "wrong", "interrupt"), runtimeId: "old-runtime" }),
		).toMatchObject({ ok: false, error: { code: "stale_runtime" } });
		expect(await c.submit(request(session, "command", "interrupt", "/danger"))).toMatchObject({
			ok: false,
			error: { code: "command_mode_unsupported" },
		});
		expect(log).not.toContain("tool:abort");
		release.resolve();
		await c.waitForIdle();
	});

	it("[§6.5 identity-in-content] identical text uses distinct IDs and the IDs never enter provider messages", async () => {
		const { session, requests } = await fixture();
		const ids: string[] = [];
		session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user")
				ids.push((event as { controlMessageId?: string }).controlMessageId ?? "missing");
		});
		const c = requireControl(session);
		await c.submit(request(session, "first-id", "queue", "same text"));
		await c.waitForIdle();
		await c.submit(request(session, "second-id", "queue", "same text"));
		await c.waitForIdle();
		expect(ids).toEqual(["first-id", "second-id"]);
		expect(JSON.stringify(requests)).not.toContain("controlMessageId");
		expect(JSON.stringify(requests)).not.toContain("first-id");
	});

	it("[§6.5 custom-once] custom triggerTurn commits exactly once and leaves no pending ghost", async () => {
		const { session, requests } = await fixture();
		const c = requireControl(session);
		let customs = 0;
		session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "custom" && ++customs > 2)
				session.dispose();
		});
		await session.sendCustomMessage(
			{ customType: "bounded-test", content: "custom instruction", display: true },
			{ triggerTurn: true },
		);
		await c.waitForIdle();
		expect(customs).toBe(1);
		expect(requests).toHaveLength(1);
		expect(c.getSnapshot().items).toEqual([]);
	});
});

describe("managed public entry points (prompt/steer/followUp/custom nextTurn)", () => {
	it("[§6.5 public-prompt] public prompt is managed and commits once", async () => {
		const { session, requests } = await fixture();
		const control = requireControl(session);
		const starts: string[] = [];
		session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user")
				starts.push(messageText(event.message.content));
		});
		await session.prompt("public prompt");
		await control.waitForIdle();
		expect(requests).toHaveLength(1);
		expect(starts.filter((text) => text === "public prompt")).toHaveLength(1);
		expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(control.getSnapshot().items).toEqual([]);
	});

	it("[§6.5 public-steer] public steer is injected once into the running turn", async () => {
		const { session, c, log, release } = await workingTool();
		await session.steer("public steer");
		await vi.waitFor(() => expect(session.agent.hasQueuedMessages()).toBe(true));
		release.resolve();
		await c.waitForIdle();
		expect(log.filter((entry) => entry === "user:public steer")).toHaveLength(1);
		expect(log.indexOf("user:public steer")).toBeLessThan(log.indexOf("model:2"));
	});

	it("[§6.5 public-followup] public followUp is delivered once after the turn", async () => {
		const { session, c, log, release } = await workingTool();
		await session.followUp("public followup");
		release.resolve();
		await c.waitForIdle();
		expect(log.filter((entry) => entry === "user:public followup")).toHaveLength(1);
		expect(log.indexOf("user:public followup")).toBeGreaterThan(log.indexOf("model:2"));
	});

	it("[§6.5 custom-next-turn] sendCustomMessage deliverAs=nextTurn is consumed once by the next prompt", async () => {
		const { session, requests } = await fixture();
		const control = requireControl(session);
		await session.sendCustomMessage(
			{ customType: "next-turn-test", content: "next-turn context", display: true },
			{ deliverAs: "nextTurn" },
		);
		expect(control.getSnapshot().items).toEqual([]);
		await session.prompt("after next turn");
		await control.waitForIdle();
		expect(requests).toHaveLength(1);
		expect(JSON.stringify(requests[0]).split("next-turn context")).toHaveLength(2);
		expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(control.getSnapshot().items).toEqual([]);
	});
});

describe("preparation cancellation and dispose", () => {
	async function prepareThenCancel(
		session: AgentSession,
		control: MessageControlHandle,
		entered: Promise<void>,
		release: Gate<void>,
		oldText: string,
		requests: unknown[][],
	) {
		const first = control.submit(request(session, oldText));
		await withTimeout(entered, 5000, `preparation gate for ${oldText}`);
		await control.submit(request(session, "urgent", "interrupt"));
		release.resolve();
		await withTimeout(first, 5000, `old submit settles (${oldText})`);
		await control.waitForIdle();
		expect(requests).toHaveLength(1);
		expect(JSON.stringify(requests)).toContain("urgent");
		expect(JSON.stringify(requests)).not.toContain(oldText);
	}

	it("[§6.5 prepare-input] cancels while the input handler awaits without sending the old input", async () => {
		const { session, requests } = await fixture();
		const entered = gate(),
			release = gate();
		const internals = session as unknown as {
			_runInputHandlers: (
				text: string,
				images: unknown,
				source: string,
				behavior?: string,
			) => Promise<{ text: string; images: unknown } | undefined>;
		};
		const original = internals._runInputHandlers.bind(session);
		vi.spyOn(internals, "_runInputHandlers").mockImplementation(async (text, images, source, behavior) => {
			if (text === "prep-input-old") {
				entered.resolve();
				await release.promise;
			}
			return original(text, images, source, behavior);
		});
		const control = requireControl(session);
		await prepareThenCancel(session, control, entered.promise, release, "prep-input-old", requests);
	});

	it("[§6.5 prepare-auth] cancels while modelRuntime.checkAuth awaits without sending the old input", async () => {
		const { session, requests } = await fixture([], { hasConfiguredAuth: false });
		const entered = gate(),
			release = gate();
		const runtime = session.modelRuntime as unknown as {
			checkAuth: (provider: string) => Promise<{ type: string; key: string }>;
		};
		vi.spyOn(runtime, "checkAuth").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return { type: "api_key", key: "test-key" };
		});
		const control = requireControl(session);
		await prepareThenCancel(session, control, entered.promise, release, "prep-auth-old", requests);
	});

	it("[§6.5 prepare-before-agent-start] cancels while the before_agent_start hook awaits", async () => {
		const { session, requests } = await fixture();
		const entered = gate(),
			release = gate();
		const runner = (
			session as unknown as {
				_extensionRunner: {
					emitBeforeAgentStart: (trigger: unknown, options: unknown) => Promise<unknown>;
				};
			}
		)._extensionRunner;
		const original = runner.emitBeforeAgentStart.bind(runner);
		vi.spyOn(runner, "emitBeforeAgentStart").mockImplementation(async (trigger, options) => {
			entered.resolve();
			await release.promise;
			return original(trigger, options);
		});
		const control = requireControl(session);
		await prepareThenCancel(session, control, entered.promise, release, "prep-before-start-old", requests);
	});

	it("[§6.5 prepare-images] cancels during image normalization without sending the old input", async () => {
		const { session, requests } = await fixture();
		const entered = gate(),
			release = gate();
		let calls = 0;
		const internals = session as unknown as {
			_normalizePromptImages: () => Promise<{ images: never[]; hints: string[] }>;
		};
		vi.spyOn(internals, "_normalizePromptImages").mockImplementation(async () => {
			if (++calls === 1) {
				entered.resolve();
				await release.promise;
			}
			return { images: [], hints: [] };
		});
		const control = requireControl(session);
		await prepareThenCancel(session, control, entered.promise, release, "prep-images-old", requests);
	});

	it("[§6.5 prepare-dispose] dispose during preparation settles and never starts the old input", async () => {
		const { session, requests } = await fixture();
		const entered = gate(),
			release = gate();
		const internals = session as unknown as {
			_normalizePromptImages: () => Promise<{ images: never[]; hints: string[] }>;
		};
		vi.spyOn(internals, "_normalizePromptImages").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return { images: [], hints: [] };
		});
		const control = requireControl(session);
		const pending = control.submit(request(session, "dispose-old"));
		await withTimeout(entered.promise, 5000, "dispose preparation gate");
		session.dispose();
		release.resolve();
		const result = await withTimeout(pending, 5000, "disposed submit settles");
		expect(result.ok).toBe(false);
		expect(requests).toHaveLength(0);
		expect(JSON.stringify(requests)).not.toContain("dispose-old");
	});
});

describe("recovering, stale revision and explicit edit resend", () => {
	it("[§6.5 recovering] the same runtime recovers repeatedly, rejects stale revisions and resends an edited payload once", async () => {
		const { session, c, log, release, requests } = await workingTool();
		session.agent.state.model = { ...MODEL, input: ["text", "image"] };
		const payload = {
			text: "recover-source",
			images: [{ mimeType: "image/png", data: "eA==" }],
			draft: {
				text: "draft text",
				attachments: ["a.ts"],
				quotes: ["q"],
				slashCommand: null,
				imageNames: ["picture"],
			},
		};
		await c.submit({ ...request(session, "recover-item"), payload });
		await vi.waitFor(() => expect(session.agent.hasQueuedMessages()).toBe(true));
		c.stop(request(session, "recover-stop"));
		await vi.waitFor(() =>
			expect(c.getSnapshot().items.find((item) => item.messageId === "recover-item")?.state).toBe("held"),
		);
		release.resolve();
		await c.waitForIdle();

		const heldRevision = c.getSnapshot().revision;
		const first = c.recover({
			...request(session, "recover-1"),
			messageId: "recover-item",
			expectedRevision: heldRevision,
		});
		expect(first).toMatchObject({
			ok: true,
			value: { messageId: "recover-item", payload },
		});
		expect(c.getSnapshot().items.find((item) => item.messageId === "recover-item")?.state).toBe("recovering");
		const recoveredRevision = c.getSnapshot().revision;
		const second = c.recover({
			...request(session, "recover-2"),
			messageId: "recover-item",
			expectedRevision: recoveredRevision,
		});
		expect(second).toMatchObject({
			ok: true,
			value: { messageId: "recover-item", payload },
		});
		expect(second.ok && second.value.snapshot.runtimeId).toBe(first.ok && first.value.snapshot.runtimeId);

		expect(
			c.recover({
				...request(session, "recover-stale"),
				messageId: "recover-item",
				expectedRevision: heldRevision,
			}),
		).toMatchObject({ ok: false, error: { code: "stale_revision" } });

		const beforeResend = requests.length;
		const resend = await c.submit({
			...request(session, "recover-resend"),
			mode: "queue",
			payload: { text: "recover-edited" },
			recovery: {
				messageId: "recover-item",
				expectedRevision: c.getSnapshot().revision,
			},
		});
		expect(resend).toMatchObject({
			ok: true,
			value: { messageId: "recover-item", disposition: "started" },
		});
		await c.waitForIdle();
		expect(requests.length).toBe(beforeResend + 1);
		expect(JSON.stringify(requests.slice(beforeResend))).toContain("recover-edited");
		expect(JSON.stringify(requests.slice(beforeResend))).not.toContain("recover-source");
		expect(log.filter((entry) => entry === "user:recover-edited")).toHaveLength(1);
		expect(log).not.toContain("user:recover-source");
		expect(c.getSnapshot().items).toEqual([]);
	});
});

describe("compaction guard", () => {
	it("[§6.5 manual-guard] only the private manual-compaction flag guard is asserted (auto semantics live in the real-compaction suite)", async () => {
		const { session } = await fixture();
		const internal = session as unknown as { _compactionAbortController?: AbortController };
		const control = requireControl(session);
		const previous = internal._compactionAbortController;
		internal._compactionAbortController = new AbortController();
		try {
			for (const mode of ["queue", "steer", "interrupt"] as const)
				expect(await control.submit(request(session, mode, mode))).toMatchObject({
					ok: false,
					error: { code: "compacting" },
				});
		} finally {
			internal._compactionAbortController = previous;
		}
	});
});

describe("unmanaged SDK prompting", () => {
	it("[§6.5 unmanaged] unmanaged SDK prompting remains available", async () => {
		const { session, requests } = await fixture();
		await session.prompt("unmanaged");
		expect(requests).toHaveLength(1);
	});
});
