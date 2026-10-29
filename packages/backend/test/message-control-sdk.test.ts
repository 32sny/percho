import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	createExtensionRuntime,
	type ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

const MODEL = {
	id: "message-control-test",
	name: "message-control-test",
	provider: "test",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<"openai-completions">;

const sessions: Array<{ dispose(): void }> = [];
const dirs: string[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(tools: ToolDefinition[] = []) {
	const root = resolve("../../.local/tmp/message-control-sdk-tests");
	mkdirSync(root, { recursive: true });
	const dir = mkdtempSync(`${root}/case-`);
	dirs.push(dir);
	const sessionManager = SessionManager.create(dir, dir);
	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "Test assistant",
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: MODEL,
		modelRuntime: {
			getModel: () => MODEL,
			hasConfiguredAuth: () => true,
			checkAuth: async () => ({ type: "api_key", key: "test-key" }),
			getAuth: async () => undefined,
		} as unknown as ModelRuntime,
		sessionManager,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		}),
		resourceLoader,
		tools: tools.map((tool) => tool.name),
		customTools: tools,
	});
	sessions.push(session);
	if (tools.length) session.setActiveToolsByName(tools.map((tool) => tool.name));
	const requests: unknown[] = [];
	session.agent.streamFunction = async (_model, context) => {
		requests.push(structuredClone(context.messages));
		const stream = createAssistantMessageEventStream();
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				role: "assistant",
				api: MODEL.api,
				provider: MODEL.provider,
				model: MODEL.id,
				timestamp: Date.now(),
				stopReason: "stop",
				content: [{ type: "text", text: "done" }],
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		});
		return stream;
	};
	return { session, requests };
}

function gate<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
function request(
	session: AgentSession,
	id: string,
	mode: "queue" | "steer" | "interrupt" = "queue",
	text = id,
) {
	return {
		sessionId: session.sessionId,
		runtimeId: session.enableMessageControl().getSnapshot().runtimeId,
		requestId: id,
		mode,
		payload: { text },
	};
}
const turn = (content: unknown[], stopReason = "stop") => ({
	role: "assistant",
	api: MODEL.api,
	provider: MODEL.provider,
	model: MODEL.id,
	timestamp: Date.now(),
	stopReason,
	content,
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});
function response(message: ReturnType<typeof turn>) {
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "done", message };
		},
		result: async () => message,
	};
}
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
				return { content: [{ type: "text", text: "ok" }] };
			},
		},
	]);
	let calls = 0;
	session.agent.streamFunction = (async (
		_model: unknown,
		_context: unknown,
		options: { signal?: AbortSignal },
	) => {
		log.push(`model:${++calls}`);
		return response(
			options.signal?.aborted
				? turn([], "aborted")
				: calls === 1
					? turn([{ type: "toolCall", id: "gate-1", name: "controlled_gate", arguments: {} }], "toolUse")
					: turn([{ type: "text", text: "done" }]),
		);
	}) as typeof session.agent.streamFunction;
	session.subscribe((event) => {
		if (event.type === "message_start" && event.message.role === "user")
			log.push(
				`user:${event.message.content
					.filter((p) => p.type === "text")
					.map((p) => p.text)
					.join("")}`,
			);
	});
	const c = session.enableMessageControl();
	expect(session.getActiveToolNames()).toContain("controlled_gate");
	await c.submit(request(session, "old"));
	await vi.waitFor(() => expect(log).toContain("tool:start"));
	await entered.promise;
	return { session, c, log, release, requests };
}

describe("AgentSession message control", () => {
	it("submits an idle message through the real agent loop and correlates its identity", async () => {
		const { session, requests } = await fixture();
		const control = session.enableMessageControl();
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
		control.dispose();
	});

	it("is idempotent for identical request IDs and rejects stale revisions", async () => {
		const { session } = await fixture();
		const control = session.enableMessageControl();
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

	it.each(["queue", "steer"] as const)("%s respects actual tool-result boundaries", async (mode) => {
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
	});

	it("interrupt waits for an uncooperative tool, freezes the old queue, then runs only the new input", async () => {
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

	it("cancels a preparing prompt without allowing its continuation to start a model", async () => {
		const { session, requests } = await fixture();
		const entered = gate(),
			release = gate();
		const internals = session as unknown as {
			_normalizePromptImages: () => Promise<{ images: never[]; hints: string[] }>;
		};
		let calls = 0;
		internals._normalizePromptImages = async () => {
			if (++calls === 1) {
				entered.resolve();
				await release.promise;
			}
			return { images: [], hints: [] };
		};
		const c = session.enableMessageControl();
		const first = c.submit(request(session, "preparing-old"));
		await entered.promise;
		await c.submit(request(session, "urgent", "interrupt"));
		expect(requests).toHaveLength(0);
		release.resolve();
		await first;
		await c.waitForIdle();
		expect(requests).toHaveLength(1);
		expect(JSON.stringify(requests)).not.toContain("preparing-old");
		expect(JSON.stringify(requests)).toContain("urgent");
	});

	it("stop preserves full queued payloads, pauses external wake-ups, and permits a later explicit user send", async () => {
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
		expect(log).toContain("user:manual-new");
		expect(log).toContain("user:external notification");
		expect(log).not.toContain("user:with image");
	});

	it("a second stop cancels interrupt's send-after-stop promise", async () => {
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

	it("30-second timeout never permits late automatic submission", async () => {
		const { session, c, log, release } = await workingTool();
		vi.useFakeTimers();
		try {
			await c.submit(request(session, "urgent", "interrupt"));
			await vi.advanceTimersByTimeAsync(5000);
			expect(c.getSnapshot().operation?.slow).toBe(true);
			await vi.advanceTimersByTimeAsync(25000);
			expect(c.getSnapshot()).toMatchObject({ phase: "blocked", operation: { sendAfterStop: false } });
			release.resolve();
			await c.waitForIdle();
			expect(log).not.toContain("user:urgent");
			expect(c.getSnapshot()).toMatchObject({ phase: "idle", autoDispatchPaused: true });
		} finally {
			vi.useRealTimers();
		}
	});

	it("removes actual transport entries on recover/discard and changes mode without duplicate execution", async () => {
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

	it("nested input and settled callbacks can await public input without deadlock", async () => {
		const { session, requests } = await fixture();
		const internals = session as unknown as {
			_runInputHandlers: (text: string, images: unknown) => Promise<{ text: string; images: unknown }>;
		};
		internals._runInputHandlers = async (text, images) => {
			if (text === "parent") await session.sendUserMessage("nested");
			return { text, images };
		};
		const c = session.enableMessageControl();
		await c.submit(request(session, "parent"));
		await c.waitForIdle();
		expect(requests.length).toBeGreaterThan(0);
		expect(JSON.stringify(session.messages)).toContain("nested");
	});

	it("a settled callback enqueues external input without waiting on itself", async () => {
		const { session, requests } = await fixture();
		const internal = session as unknown as {
			_extensionRunner: { emit: (event: { type: string }) => Promise<unknown> };
		};
		const emit = internal._extensionRunner.emit.bind(internal._extensionRunner);
		let sent = false;
		internal._extensionRunner.emit = async (event) => {
			if (event.type === "agent_settled" && !sent) {
				sent = true;
				await session.sendUserMessage("settled-followup");
			}
			return emit(event);
		};
		const c = session.enableMessageControl();
		await c.submit(request(session, "parent"));
		await c.waitForIdle();
		expect(requests).toHaveLength(2);
		expect(c.getSnapshot().items).toEqual([]);
	});

	it("interrupt replacement handled by input keeps wake-ups paused", async () => {
		const { session, c, log, release } = await workingTool();
		const internal = session as unknown as {
			_runInputHandlers: (
				text: string,
				images: unknown,
			) => Promise<{ text: string; images: unknown } | undefined>;
		};
		internal._runInputHandlers = async (text, images) => {
			if (text === "handled-new") {
				await session.sendUserMessage("handler-wakeup");
				return undefined;
			}
			return { text, images };
		};
		await c.submit(request(session, "handled-new", "interrupt"));
		release.resolve();
		await c.waitForIdle();
		expect(log).not.toContain("user:handled-new");
		expect(log).not.toContain("user:handler-wakeup");
		expect(c.getSnapshot().autoDispatchPaused).toBe(true);
	});

	it("capacity and stale identities reject without aborting work", async () => {
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

	it("identical text uses distinct IDs and the IDs never enter provider messages", async () => {
		const { session, requests } = await fixture();
		const ids: string[] = [];
		session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user")
				ids.push((event as { controlMessageId?: string }).controlMessageId ?? "missing");
		});
		const c = session.enableMessageControl();
		await c.submit(request(session, "first-id", "queue", "same text"));
		await c.waitForIdle();
		await c.submit(request(session, "second-id", "queue", "same text"));
		await c.waitForIdle();
		expect(ids).toEqual(["first-id", "second-id"]);
		expect(JSON.stringify(requests)).not.toContain("controlMessageId");
		expect(JSON.stringify(requests)).not.toContain("first-id");
	});

	it("manual compaction rejects all modes, auto compaction retains queue semantics", async () => {
		const { session } = await fixture();
		const internal = session as unknown as { _compactionAbortController?: AbortController };
		const c = session.enableMessageControl();
		internal._compactionAbortController = new AbortController();
		for (const mode of ["queue", "steer", "interrupt"] as const)
			expect(await c.submit(request(session, mode, mode))).toMatchObject({
				ok: false,
				error: { code: "compacting" },
			});
		internal._compactionAbortController = undefined;
	});

	it("custom triggerTurn commits exactly once and leaves no pending ghost", async () => {
		const { session, requests } = await fixture();
		const c = session.enableMessageControl();
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

	it("unmanaged SDK prompting remains available", async () => {
		const { session, requests } = await fixture();
		await session.prompt("unmanaged");
		expect(requests).toHaveLength(1);
	});
});
