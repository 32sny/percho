import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assistantTurn,
	cleanupSdkTest,
	gate,
	installHostPolicy,
	isSummaryRequest,
	MODEL_20K,
	messageText,
	requireControl,
	response,
	sdkFixture,
	textTurn,
	waitForCondition,
	withTimeout,
} from "./message-control-sdk-harness";

/**
 * 托管 retry 契约（§6.5 retry 作用域）。真实 SessionManager 失败 entry + 真实 retryLastFailedTurn。
 * 当前安装的 SDK 已提供 enableMessageControl；requireControl() 仍保留为接口就绪性断言，
 * 缺失时按 BLOCKED_MISSING_API 明确失败，不返回 mock handle。
 */

afterEach(async () => {
	await cleanupSdkTest();
});

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function usage(totalTokens: number): AssistantMessage["usage"] {
	return { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: COST };
}

/** 真实失败历史：足够的历史 token 供 retry 后真实压缩切分，末端是失败 assistant。 */
function retryHistory(manager: SessionManager) {
	let timestamp = 1;
	for (let index = 0; index < 6; index++) {
		manager.appendMessage({
			role: "user",
			timestamp: timestamp++,
			content: [{ type: "text", text: `history ${index} ${"z".repeat(4_000)}` }],
		});
		manager.appendMessage({
			role: "assistant",
			api: MODEL_20K.api,
			provider: MODEL_20K.provider,
			model: MODEL_20K.id,
			timestamp: timestamp++,
			stopReason: "stop",
			content: [{ type: "text", text: `history answer ${index}` }],
			usage: usage(1_000),
		});
	}
	manager.appendMessage({
		role: "user",
		timestamp: timestamp++,
		content: [{ type: "text", text: "修改文件" }],
	});
	manager.appendMessage({
		role: "assistant",
		api: MODEL_20K.api,
		provider: MODEL_20K.provider,
		model: MODEL_20K.id,
		timestamp: timestamp++,
		stopReason: "toolUse",
		content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "a.ts" } }],
		usage: usage(10),
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "edit-1",
		toolName: "edit",
		timestamp: timestamp++,
		isError: false,
		content: [{ type: "text", text: "Successfully edited a.ts" }],
	});
	const failedTimestamp = timestamp;
	manager.appendMessage({
		role: "assistant",
		api: MODEL_20K.api,
		provider: MODEL_20K.provider,
		model: MODEL_20K.id,
		timestamp: failedTimestamp,
		stopReason: "error",
		errorMessage: "fetch failed",
		content: [{ type: "text", text: "partial" }],
		usage: usage(10),
	});
}

/** 末端是真实失败 assistant；前一条成功回复带 19k usage 让 pre-run 压缩越过 20k 阈值。 */
function pausedHistory(manager: SessionManager) {
	let timestamp = 1;
	for (let index = 0; index < 6; index++) {
		manager.appendMessage({
			role: "user",
			timestamp: timestamp++,
			content: [{ type: "text", text: `paused history ${index} ${"y".repeat(4_000)}` }],
		});
		manager.appendMessage({
			role: "assistant",
			api: MODEL_20K.api,
			provider: MODEL_20K.provider,
			model: MODEL_20K.id,
			timestamp: timestamp++,
			stopReason: "stop",
			content: [{ type: "text", text: `paused answer ${index}` }],
			usage: usage(1_000),
		});
	}
	// 最近一次成功回复携带 19k usage：真实宿主阈值估算越过 20k 模型阈值。
	manager.appendMessage({
		role: "assistant",
		api: MODEL_20K.api,
		provider: MODEL_20K.provider,
		model: MODEL_20K.id,
		timestamp: timestamp++,
		stopReason: "stop",
		content: [{ type: "text", text: "recent" }],
		usage: usage(19_000),
	});
	manager.appendMessage({
		role: "assistant",
		api: MODEL_20K.api,
		provider: MODEL_20K.provider,
		model: MODEL_20K.id,
		timestamp: timestamp++,
		stopReason: "error",
		errorMessage: "fetch failed",
		content: [{ type: "text", text: "partial" }],
		usage: usage(10),
	});
}

async function retryFixture(
	options: { compaction?: boolean; history?: (manager: SessionManager) => void } = {},
) {
	const fixture = await sdkFixture({
		model: MODEL_20K,
		history: options.history ?? retryHistory,
		settings: {
			compaction: options.compaction
				? { enabled: true, reserveTokens: 2_000, keepRecentTokens: 2_000 }
				: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		},
		noDefaultStream: true,
	});
	const terminal = fixture.session.sessionManager.getBranch().findLast((entry) => entry.type === "message");
	if (terminal?.type !== "message") throw new Error("missing persisted failure entry");
	return {
		fixture,
		ref: { timestamp: terminal.message.timestamp, entryId: terminal.id },
	};
}

function identity(session: { sessionId: string }, control: { getSnapshot(): { runtimeId: string } }) {
	return { sessionId: session.sessionId, runtimeId: control.getSnapshot().runtimeId };
}

function countUserText(session: Pick<AgentSession, "messages">, text: string) {
	return session.messages
		.filter((message) => message.role === "user")
		.filter((message) => messageText((message as unknown as { content: never }).content).includes(text))
		.length;
}

function queuedTexts(session: Pick<AgentSession, "agent">) {
	return session.agent
		.getQueuedMessages()
		.filter((message) => (message as { role?: string }).role === "user")
		.map((message) => messageText((message as unknown as { content: never }).content));
}

function userMessages(session: Pick<AgentSession, "messages">) {
	return session.messages.filter((message) => message.role === "user");
}

function toolResults(session: Pick<AgentSession, "messages">) {
	return session.messages.filter((message) => message.role === "toolResult");
}

/** 真实失败响应：stopReason=error 的 assistant，供再次失败的重试用例。 */
function errorTurn(text: string, errorMessage: string): AssistantMessage {
	const turn = assistantTurn([{ type: "text", text }], "error", MODEL_20K);
	turn.errorMessage = errorMessage;
	return turn;
}

describe("managed retry (real failure entry)", () => {
	it("[§6.5 retry-basic] retry adds no user, does not replay tools, and a managed submit works after settlement", async () => {
		const { fixture, ref } = await retryFixture();
		const control = requireControl(fixture.session);
		const events: string[] = [];
		fixture.session.subscribe((event) => events.push(event.type));
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			return response(textTurn("recovered"));
		};

		const userCountBefore = fixture.session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message" && entry.message.role === "user").length;
		await withTimeout(fixture.session.retryLastFailedTurn(ref), 5_000, "managed retry settles");
		await control.waitForIdle();
		expect(fixture.requests).toHaveLength(1);
		const sent = fixture.requests[0] as Array<{ role: string; content: unknown }>;
		// 历史本身含多轮 user；重试不得新增任何一条。
		expect(sent.filter((message) => message.role === "user")).toHaveLength(userCountBefore);
		expect(JSON.stringify(sent)).toContain("Successfully edited a.ts");
		expect(
			sent.some(
				(message) => message.role === "assistant" && JSON.stringify(message).includes("fetch failed"),
			),
		).toBe(false);
		expect(events).not.toContain("tool_execution_start");
		expect(
			fixture.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "user"),
		).toHaveLength(userCountBefore);
		expect(
			fixture.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "toolResult"),
		).toHaveLength(1);

		const ack = await control.submit({
			...identity(fixture.session, control),
			requestId: "after-retry",
			mode: "queue",
			payload: { text: "after retry" },
		});
		expect(ack).toMatchObject({ ok: true });
		await control.waitForIdle();
		expect(fixture.requests).toHaveLength(2);
		expect(JSON.stringify(fixture.requests[1])).toContain("after retry");
	});

	it("[§6.5 retry-busy] a concurrent retry is rejected while the first retry is running", async () => {
		const { fixture, ref } = await retryFixture();
		const control = requireControl(fixture.session);
		const entered = gate(),
			release = gate();
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			entered.resolve();
			await release.promise;
			return response(textTurn("done"));
		};
		const first = fixture.session.retryLastFailedTurn(ref);
		await withTimeout(entered.promise, 5_000, "retry request entered");
		await expect(fixture.session.retryLastFailedTurn(ref)).rejects.toThrow(/busy|Cannot retry/i);
		release.resolve();
		await withTimeout(first, 5_000, "first retry settles");
		await control.waitForIdle();
		expect(fixture.requests).toHaveLength(1);
	});

	it("[§6.5 retry-paused] a paused control rejects retry without starting a run", async () => {
		const { fixture, ref } = await retryFixture();
		const control = requireControl(fixture.session);
		control.stop({ ...identity(fixture.session, control), requestId: "retry-pause" });
		await control.waitForIdle();
		await expect(fixture.session.retryLastFailedTurn(ref)).rejects.toThrow(/busy|paused/i);
		expect(fixture.requests).toHaveLength(0);
	});

	it("[§6.5 retry-cancel] cancelling at the real summary auth await never sends the late summary", async () => {
		const { fixture, ref } = await retryFixture({ compaction: true });
		const control = requireControl(fixture.session);
		const modelRequests: unknown[][] = [];
		const summaryRequests: string[] = [];
		fixture.session.agent.streamFunction = async (_model, context) => {
			// SDK normalize 后没有 context.systemPrompt，摘要请求只能看 messages 的首条 system 消息。
			if (isSummaryRequest(context)) {
				summaryRequests.push(JSON.stringify(context.messages));
				return response(textTurn("## Summary\n- retry"));
			}
			modelRequests.push(structuredClone(context.messages));
			// 让 retry 的回复越过压缩阈值，从而进入真实 post-run 自动压缩准备。
			return response(textTurn("retry response", 19_000, MODEL_20K));
		};
		const entered = gate(),
			release = gate();
		const runtime = fixture.session.modelRuntime as unknown as {
			getAuth: (model: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
		};
		vi.spyOn(runtime, "getAuth").mockImplementation(async (_model, options) => {
			entered.resolve();
			await release.promise;
			// 真实认证实现会响应取消信号；这里不伪造控制器，只让 auth await 可取消。
			options?.signal?.throwIfAborted();
			return undefined;
		});

		const retry = fixture.session.retryLastFailedTurn(ref);
		await withTimeout(entered.promise, 5_000, "retry summary auth gate");
		control.stop({ ...identity(fixture.session, control), requestId: "retry-cancel" });
		release.resolve();
		await withTimeout(retry, 5_000, "retry settles after cancellation");
		await control.waitForIdle();
		expect(modelRequests).toHaveLength(1);
		expect(summaryRequests).toHaveLength(0);
	});

	it("[§6.5 retry-repeat-fail] a retry that fails again keeps the entry retryable and adds no user", async () => {
		const { fixture, ref } = await retryFixture();
		const control = requireControl(fixture.session);
		let modelCalls = 0;
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			modelCalls++;
			return response(errorTurn("partial again", "fetch failed"));
		};
		const usersBefore = userMessages(fixture.session).length;
		await withTimeout(fixture.session.retryLastFailedTurn(ref), 5_000, "first retry settles");
		await control.waitForIdle();
		expect(modelCalls).toBe(1);
		const terminal = fixture.session.sessionManager.getBranch().findLast((entry) => entry.type === "message");
		if (terminal?.type !== "message") throw new Error("missing failure entry after the retry");
		expect(terminal.message).toMatchObject({ role: "assistant", stopReason: "error" });
		// 再次失败仍不新增 user、不重放已执行工具。
		expect(userMessages(fixture.session)).toHaveLength(usersBefore);
		expect(toolResults(fixture.session)).toHaveLength(1);

		// 旧 ref 已不是终端失败响应；新 ref 仍可继续重试（未被丢弃）。
		await expect(fixture.session.retryLastFailedTurn(ref)).rejects.toThrow(
			/no longer the current retry target/i,
		);
		const nextRef = { timestamp: terminal.message.timestamp, entryId: terminal.id };
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			modelCalls++;
			return response(textTurn("recovered"));
		};
		await withTimeout(fixture.session.retryLastFailedTurn(nextRef), 5_000, "second retry settles");
		await control.waitForIdle();
		expect(modelCalls).toBe(2);
		expect(userMessages(fixture.session)).toHaveLength(usersBefore);
		expect(toolResults(fixture.session)).toHaveLength(1);
	});

	it("[§6.5 retry-stale-ref] stale failure references are rejected before any model request", async () => {
		const { fixture, ref } = await retryFixture();
		const control = requireControl(fixture.session);
		let modelCalls = 0;
		fixture.session.agent.streamFunction = async () => {
			modelCalls++;
			return response(textTurn("must not run"));
		};
		await expect(
			fixture.session.retryLastFailedTurn({ timestamp: ref.timestamp + 1, entryId: ref.entryId }),
		).rejects.toThrow(/no longer the current retry target/i);
		await expect(
			fixture.session.retryLastFailedTurn({ timestamp: ref.timestamp, entryId: "missing-entry" }),
		).rejects.toThrow(/no longer the current retry target/i);
		expect(modelCalls).toBe(0);
		expect(fixture.requests).toHaveLength(0);
		expect(control.getSnapshot()).toMatchObject({ autoDispatchPaused: false, items: [] });
	});

	/**
	 * 宿主等待用户（真实 managed stop 的 `_abortUncontrolled` 路径）下，重试不得启动，
	 * 且已 held 的用户项不得被拒绝过程清理。
	 */
	it("[§6.5 retry-awaiting-user] a host awaiting the user rejects retry and keeps held items held", async () => {
		const { fixture, ref } = await retryFixture({ compaction: true });
		installHostPolicy(fixture.session);
		const control = requireControl(fixture.session);
		const entered = gate(),
			release = gate();
		let modelCalls = 0;
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			modelCalls++;
			if (modelCalls === 1) {
				entered.resolve();
				await release.promise;
			}
			return response(textTurn("reply", 100, MODEL_20K));
		};
		const base = identity(fixture.session, control);
		expect(
			await control.submit({
				...base,
				requestId: "await-initial",
				mode: "queue",
				payload: { text: "await-initial" },
			}),
		).toMatchObject({ ok: true, value: { disposition: "started" } });
		await withTimeout(entered.promise, 5_000, "awaiting-user run entered");
		expect(
			await control.submit({
				...base,
				requestId: "await-held",
				mode: "queue",
				payload: { text: "await-held" },
			}),
		).toMatchObject({ ok: true, value: { disposition: "queued" } });
		await waitForCondition(
			() => queuedTexts(fixture.session).includes("await-held"),
			5_000,
			"held item prepared into the real SDK queue",
		);
		control.stop({ ...base, requestId: "await-stop" });
		release.resolve();
		await control.waitForIdle();
		const paused = control.getSnapshot();
		expect(paused).toMatchObject({
			autoDispatchPaused: true,
			items: [expect.objectContaining({ messageId: "await-held", state: "held" })],
		});

		// 真实宿主等待用户：重试拒绝，不启动运行，也不动 held 身份。
		await expect(fixture.session.retryLastFailedTurn(ref)).rejects.toThrow(/busy|paused/i);
		expect(modelCalls).toBe(1);
		const afterReject = control.getSnapshot();
		expect(afterReject.revision).toBe(paused.revision);
		expect(afterReject).toMatchObject({
			autoDispatchPaused: true,
			items: [expect.objectContaining({ messageId: "await-held", state: "held" })],
		});
		expect(queuedTexts(fixture.session)).toEqual([]);
		expect(countUserText(fixture.session, "await-held")).toBe(0);
	});

	/**
	 * 真实宿主压缩失败形成的 `compactionPause` 是暂停态：重试必须拒绝，不得再发模型请求。
	 * 失败结果由重试自身越阈值的回复触发（真实 post-run 压缩），不是手改私有标志。
	 */
	it("[§6.5 retry-host-pause] a real host compaction pause rejects retry and keeps held items held", async () => {
		const { fixture, ref } = await retryFixture({ compaction: true, history: pausedHistory });
		const host = installHostPolicy(fixture.session);
		const control = requireControl(fixture.session);
		let modelCalls = 0;
		let summaryCalls = 0;
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			if (isSummaryRequest(context)) {
				summaryCalls++;
				throw new Error("summary boom");
			}
			modelCalls++;
			return response(textTurn("should not run", 100, MODEL_20K));
		};
		// 真实托管输入：pre-run 宿主压缩失败 → 宿主暂停，输入保持 held。
		expect(
			await control.submit({
				...identity(fixture.session, control),
				requestId: "pause-held",
				mode: "queue",
				payload: { text: "pause-held" },
			}),
		).toMatchObject({ ok: true, value: { disposition: "started" } });
		await waitForCondition(
			() => fixture.session.compactionPause?.reason === "failed",
			5_000,
			"real host compaction pause",
		);
		await waitForCondition(
			() =>
				control.getSnapshot().items.some((item) => item.messageId === "pause-held" && item.state === "held"),
			5_000,
			"held item after host compaction failure",
		);
		await control.waitForIdle();
		expect(summaryCalls).toBe(1);
		expect(host.calls.map((call) => call.status)).toContain("failed");
		expect(modelCalls).toBe(0);
		expect(countUserText(fixture.session, "pause-held")).toBe(0);
		const paused = control.getSnapshot();
		expect(paused).toMatchObject({
			autoDispatchPaused: true,
			items: [expect.objectContaining({ messageId: "pause-held", state: "held" })],
		});

		// 宿主压缩暂停下重试不启动；held 身份与暂停状态不被拒绝过程改动。
		await expect(fixture.session.retryLastFailedTurn(ref)).rejects.toThrow(/busy|paused/i);
		expect(modelCalls).toBe(0);
		expect(fixture.session.compactionPause?.reason).toBe("failed");
		const afterReject = control.getSnapshot();
		expect(afterReject.revision).toBe(paused.revision);
		expect(afterReject).toMatchObject({
			autoDispatchPaused: true,
			items: [expect.objectContaining({ messageId: "pause-held", state: "held" })],
		});
	}, 20_000);

	it("[§6.5 retry-dispose] disposing during an in-flight retry commits nothing late", async () => {
		const { fixture, ref } = await retryFixture();
		const control = requireControl(fixture.session);
		const entered = gate(),
			release = gate();
		let modelCalls = 0;
		fixture.session.agent.streamFunction = async () => {
			modelCalls++;
			entered.resolve();
			await release.promise;
			return response(textTurn("late reply"));
		};
		const usersBefore = userMessages(fixture.session).length;
		const retry = fixture.session.retryLastFailedTurn(ref).then(
			() => "settled" as const,
			(error: unknown) => error,
		);
		await withTimeout(entered.promise, 5_000, "retry request entered");
		control.dispose();
		release.resolve();
		await withTimeout(retry, 5_000, "retry settles after dispose");
		expect(modelCalls).toBe(1);
		expect(userMessages(fixture.session)).toHaveLength(usersBefore);
		// 迟到续体不落库：原失败 entry 仍在。
		expect(fixture.session.sessionManager.getEntry(ref.entryId)).toBeDefined();
	});

	it("[§6.5 retry-queue-steer] queue and steer accepted during a retry commit exactly once", async () => {
		const { fixture, ref } = await retryFixture();
		const control = requireControl(fixture.session);
		const entered = gate(),
			release = gate();
		let modelCalls = 0;
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			modelCalls++;
			if (modelCalls === 1) {
				entered.resolve();
				await release.promise;
			}
			return response(textTurn(`reply ${modelCalls}`));
		};
		const base = identity(fixture.session, control);
		const usersBefore = userMessages(fixture.session).length;
		const retry = fixture.session.retryLastFailedTurn(ref);
		await withTimeout(entered.promise, 5_000, "retry request entered");
		expect(
			await control.submit({
				...base,
				requestId: "retry-q",
				mode: "queue",
				payload: { text: "retry-q" },
			}),
		).toMatchObject({ ok: true, value: { disposition: "queued" } });
		expect(
			await control.submit({
				...base,
				requestId: "retry-s",
				mode: "steer",
				payload: { text: "retry-s" },
			}),
		).toMatchObject({ ok: true, value: { disposition: "queued" } });
		release.resolve();
		await withTimeout(retry, 5_000, "retry settles");
		await control.waitForIdle();
		expect(countUserText(fixture.session, "retry-q")).toBe(1);
		expect(countUserText(fixture.session, "retry-s")).toBe(1);
		expect(userMessages(fixture.session)).toHaveLength(usersBefore + 2);
		const lastRequest = JSON.stringify(fixture.requests.at(-1));
		expect(lastRequest.split("retry-q").length - 1).toBe(1);
		expect(lastRequest.split("retry-s").length - 1).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ items: [] });
	});

	it("[§6.5 retry-interrupt] an interrupt during a retry stops once and commits the target once", async () => {
		const { fixture, ref } = await retryFixture();
		const control = requireControl(fixture.session);
		const entered = gate(),
			release = gate();
		let modelCalls = 0;
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			modelCalls++;
			if (modelCalls === 1) {
				entered.resolve();
				await release.promise;
			}
			return response(textTurn(`reply ${modelCalls}`));
		};
		const base = identity(fixture.session, control);
		const usersBefore = userMessages(fixture.session).length;
		const retry = fixture.session.retryLastFailedTurn(ref).then(
			() => "settled" as const,
			(error: unknown) => error,
		);
		await withTimeout(entered.promise, 5_000, "retry request entered");
		const ack = await control.submit({
			...base,
			requestId: "retry-i",
			mode: "interrupt",
			payload: { text: "retry-i" },
		});
		expect(ack).toMatchObject({ ok: true, value: { disposition: "interrupting" } });
		release.resolve();
		await withTimeout(retry, 5_000, "retry settles after interrupt");
		await control.waitForIdle();
		expect(countUserText(fixture.session, "retry-i")).toBe(1);
		expect(userMessages(fixture.session)).toHaveLength(usersBefore + 1);
		expect(control.getSnapshot()).toMatchObject({ items: [] });
	});

	/**
	 * 重试成功后本地恢复闭环仍可用：stop 形成的 held 用户项可被显式 recover + resend，
	 * 且只 commit 一次（prepared 显式恢复 grant 不被 prompt grant 生命周期误清）。
	 */
	it("[§6.5 retry-recover] after a successful retry a held user item recovers and commits once", async () => {
		const { fixture, ref } = await retryFixture({ compaction: true });
		installHostPolicy(fixture.session);
		const control = requireControl(fixture.session);
		const entered = gate(),
			release = gate();
		let modelCalls = 0;
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			modelCalls++;
			if (modelCalls === 2) {
				entered.resolve();
				await release.promise;
			}
			return response(textTurn(`reply ${modelCalls}`, 100, MODEL_20K));
		};
		await withTimeout(fixture.session.retryLastFailedTurn(ref), 5_000, "retry settles");
		await control.waitForIdle();
		expect(modelCalls).toBe(1);
		const base = identity(fixture.session, control);
		expect(
			await control.submit({
				...base,
				requestId: "post-retry",
				mode: "queue",
				payload: { text: "post-retry" },
			}),
		).toMatchObject({ ok: true, value: { disposition: "started" } });
		await withTimeout(entered.promise, 5_000, "post-retry run entered");
		expect(
			await control.submit({
				...base,
				requestId: "post-retry-held",
				mode: "queue",
				payload: { text: "post-retry-held" },
			}),
		).toMatchObject({ ok: true, value: { disposition: "queued" } });
		await waitForCondition(
			() => queuedTexts(fixture.session).includes("post-retry-held"),
			5_000,
			"held item prepared into the real SDK queue",
		);
		control.stop({ ...base, requestId: "post-retry-stop" });
		release.resolve();
		await control.waitForIdle();
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: true,
			items: [expect.objectContaining({ messageId: "post-retry-held", state: "held" })],
		});

		const recovered = control.recover({
			...base,
			requestId: "post-retry-recover",
			messageId: "post-retry-held",
			expectedRevision: control.getSnapshot().revision,
		});
		if (!recovered.ok) throw new Error(`recover failed: ${recovered.error.message}`);
		const resend = await control.submit({
			...base,
			requestId: "post-retry-resend",
			mode: "queue",
			payload: recovered.value.payload,
			recovery: {
				messageId: "post-retry-held",
				expectedRevision: control.getSnapshot().revision,
			},
		});
		expect(resend).toMatchObject({ ok: true, value: { disposition: "started" } });
		await control.waitForIdle();
		expect(countUserText(fixture.session, "post-retry-held")).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ items: [] });
	});

	it("[§6.5 retry-stale-scope] stale runtime and revision rejections leave the held item untouched", async () => {
		const { fixture } = await retryFixture();
		const control = requireControl(fixture.session);
		const entered = gate(),
			release = gate();
		let modelCalls = 0;
		fixture.session.agent.streamFunction = async () => {
			modelCalls++;
			entered.resolve();
			await release.promise;
			return response(textTurn("reply"));
		};
		const base = identity(fixture.session, control);
		expect(
			await control.submit({
				...base,
				requestId: "stale-initial",
				mode: "queue",
				payload: { text: "stale-initial" },
			}),
		).toMatchObject({ ok: true, value: { disposition: "started" } });
		await withTimeout(entered.promise, 5_000, "stale-scope run entered");
		expect(
			await control.submit({
				...base,
				requestId: "stale-held",
				mode: "queue",
				payload: { text: "stale-held" },
			}),
		).toMatchObject({ ok: true, value: { disposition: "queued" } });
		await waitForCondition(
			() => queuedTexts(fixture.session).includes("stale-held"),
			5_000,
			"held item prepared into the real SDK queue",
		);
		control.stop({ ...base, requestId: "stale-stop" });
		release.resolve();
		await control.waitForIdle();
		const revision = control.getSnapshot().revision;
		expect(control.getSnapshot()).toMatchObject({
			items: [expect.objectContaining({ messageId: "stale-held", state: "held" })],
		});

		// 过期 runtime 与过期 revision 都在写入前拒绝，held 身份与队列保持不变。
		expect(
			await control.submit({
				sessionId: fixture.session.sessionId,
				runtimeId: "stale-runtime",
				requestId: "stale-runtime-request",
				mode: "queue",
				payload: { text: "stale-runtime" },
			}),
		).toMatchObject({ ok: false, error: { code: "stale_runtime" } });
		expect(
			control.recover({
				...base,
				requestId: "stale-recover",
				messageId: "stale-held",
				expectedRevision: revision - 1,
			}),
		).toMatchObject({ ok: false, error: { code: "stale_revision" } });
		expect(
			await control.changePending({
				...base,
				requestId: "stale-change",
				messageId: "stale-held",
				expectedRevision: revision - 1,
				action: "resend",
			}),
		).toMatchObject({ ok: false, error: { code: "stale_revision" } });
		expect(
			await control.submit({
				...base,
				requestId: "stale-resend",
				mode: "queue",
				payload: { text: "stale-resend" },
				recovery: { messageId: "stale-held", expectedRevision: revision - 1 },
			}),
		).toMatchObject({ ok: false, error: { code: "stale_revision" } });
		const afterReject = control.getSnapshot();
		expect(afterReject.revision).toBe(revision);
		expect(afterReject).toMatchObject({
			items: [expect.objectContaining({ messageId: "stale-held", state: "held" })],
		});
		expect(modelCalls).toBe(1);
		expect(countUserText(fixture.session, "stale-held")).toBe(0);
	});
});

describe("prompt host resume grant ownership", () => {
	const COMPACTION_SETTINGS = {
		compaction: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 2_000 },
		retry: { enabled: false },
		cacheWarming: "off" as const,
	};

	/**
	 * 前次观察的最小复现：普通 `_promptUncontrolled`/`_preparePrompt` 在宿主暂停/等待用户时设置
	 * `_hostResumeBatch`，随后真实认证检查失败使授权无人消费；后来普通 prepared run
	 * （扩展来源 resend，无显式用户恢复意图）不应继承该授权解除宿主等待。
	 *
	 * 全程真实 API：真实宿主策略、控制器 submit/stop/recover/changePending、真实认证运行时与内存模型流。
	 */
	it("[§6.5 prompt-grant-scope] a failed interactive prompt leaves no host resume grant for a later ordinary prepared run", async () => {
		const modelEntered = gate(),
			modelRelease = gate();
		const fixture = await sdkFixture({
			model: MODEL_20K,
			settings: COMPACTION_SETTINGS,
			noDefaultStream: true,
			hasConfiguredAuth: false,
		});
		const host = installHostPolicy(fixture.session);
		const control = requireControl(fixture.session);
		let modelCalls = 0;
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			modelCalls++;
			if (modelCalls === 1) {
				modelEntered.resolve();
				await modelRelease.promise;
			}
			return response(textTurn("done", 100, MODEL_20K));
		};

		const base = identity(fixture.session, control);
		const initial = await control.submit({
			...base,
			requestId: "grant-initial",
			mode: "queue",
			payload: { text: "grant-initial" },
		});
		expect(initial).toMatchObject({ ok: true, value: { disposition: "started" } });
		await withTimeout(modelEntered.promise, 5_000, "initial run entered");

		// 运行中投递一条未 commit 的用户项与一条扩展项：二者都走真实 prepared。
		expect(
			await control.submit({
				...base,
				requestId: "grant-held",
				mode: "queue",
				payload: { text: "grant-held" },
			}),
		).toMatchObject({ ok: true, value: { disposition: "queued" } });
		expect(
			await control.submit(
				{ ...base, requestId: "grant-ext", mode: "queue", payload: { text: "grant-ext" } },
				"extension",
			),
		).toMatchObject({ ok: true, value: { disposition: "queued" } });
		await waitForCondition(
			() => queuedTexts(fixture.session).join(",") === "grant-held,grant-ext",
			5_000,
			"held and extension prepared into the real SDK queue",
		);

		// 用户 stop：宿主进入 waiting-for-user，未 commit 的用户目标保留为 held。
		control.stop({ ...base, requestId: "grant-stop" });
		modelRelease.resolve();
		await control.waitForIdle();
		expect(countUserText(fixture.session, "grant-initial")).toBe(1);
		expect(countUserText(fixture.session, "grant-held")).toBe(0);
		expect(countUserText(fixture.session, "grant-ext")).toBe(0);
		expect(queuedTexts(fixture.session)).toEqual([]);
		// 被 stop 的这次运行没有结算出回复，宿主策略不会收到结果；之后也不得新增。
		const hostCallsAfterStop = host.calls.length;
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: true,
			items: [
				expect.objectContaining({ messageId: "grant-held", state: "held" }),
				expect.objectContaining({ messageId: "grant-ext", state: "queued" }),
			],
		});

		// 用户显式恢复目标，但准备期真实认证检查失败：本次交互授权无人消费。
		const authEntered = gate(),
			authRelease = gate();
		const runtime = fixture.session.modelRuntime as unknown as {
			checkAuth: (provider: string) => Promise<unknown>;
		};
		vi.spyOn(runtime, "checkAuth").mockImplementation(async () => {
			authEntered.resolve();
			await authRelease.promise;
			return undefined;
		});
		expect(
			control.recover({
				...base,
				requestId: "grant-recover",
				messageId: "grant-held",
				expectedRevision: control.getSnapshot().revision,
			}),
		).toMatchObject({ ok: true });
		const failedResend = control.submit({
			...base,
			requestId: "grant-resend",
			mode: "queue",
			payload: { text: "grant-retry-text" },
			recovery: {
				messageId: "grant-held",
				expectedRevision: control.getSnapshot().revision,
			},
		});
		await withTimeout(authEntered.promise, 5_000, "recovery auth gate");
		authRelease.resolve();
		expect(await failedResend).toMatchObject({ ok: false, error: { code: "preflight_failed" } });
		await control.waitForIdle();
		expect(countUserText(fixture.session, "grant-retry-text")).toBe(0);
		expect(modelCalls).toBe(1);
		// 失败的交互授权被撤销：回收后的普通 prepared run 不得再产生宿主结果。
		expect(host.calls).toHaveLength(hostCallsAfterStop);
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: true,
			items: [
				expect.objectContaining({ messageId: "grant-held", state: "held" }),
				expect.objectContaining({ messageId: "grant-ext", state: "queued" }),
			],
		});

		// 普通 prepared run（扩展来源 resend，无用户同模式恢复意图）：不得解除宿主等待、不得投递。
		const ordinary = await control.changePending({
			...base,
			requestId: "grant-ordinary",
			messageId: "grant-ext",
			expectedRevision: control.getSnapshot().revision,
			action: "resend",
		});
		expect(ordinary).toMatchObject({ ok: true });
		await control.waitForIdle();
		expect(countUserText(fixture.session, "grant-ext")).toBe(0);
		expect(modelCalls).toBe(1);
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: true,
			items: [
				expect.objectContaining({ messageId: "grant-held", state: "held" }),
				expect.objectContaining({ messageId: "grant-ext", state: "held" }),
			],
		});
	});
});
