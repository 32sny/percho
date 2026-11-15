import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageControlHandle } from "../src/session/message-control";
import {
	assistantTurn,
	cleanupSdkTest,
	type Gate,
	gate,
	isSummaryRequest,
	MODEL_20K,
	messageText,
	requireControl,
	response,
	sdkFixture,
	textTurn,
	withTimeout,
} from "./message-control-sdk-harness";

/**
 * P1-6-S2：准备取消与结算边界。
 *
 * 只用真实公开入口（控制 handle submit/stop/subscribe、session.prompt、真实扩展命令/事件回调、
 * 真实工具信号）与真实 SDK 会话；门闩只挂外部输入（模型流、认证、工具、扩展 hook），
 * 不替换运行入口、控制器、队列或仲裁方法。
 *
 * 本文件覆盖 S2 必验组中此前未覆盖的部分；input/auth/before-agent/images 四组准备取消、
 * interrupt/二次 stop/30s blocked 已在 message-control-sdk.test.ts 中保留并通过。
 */

afterEach(async () => {
	await cleanupSdkTest();
});

function identity(session: AgentSession, control: MessageControlHandle) {
	return { sessionId: session.sessionId, runtimeId: control.getSnapshot().runtimeId };
}

function request(session: AgentSession, control: MessageControlHandle, id: string, text = id) {
	return { ...identity(session, control), requestId: id, mode: "queue" as const, payload: { text } };
}

function stopRequest(session: AgentSession, control: MessageControlHandle, id: string) {
	return { ...identity(session, control), requestId: id };
}

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function usage(totalTokens: number): AssistantMessage["usage"] {
	return { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: COST };
}

/** 真实失败/长历史：末端 assistant 带 19k usage，越过 20k 模型的阈值，供准备阶段压缩。 */
function compactionHistory(manager: SessionManager) {
	let timestamp = 1;
	for (let index = 0; index < 6; index++) {
		manager.appendMessage({
			role: "user",
			timestamp: timestamp++,
			content: [{ type: "text", text: `history ${index} ${"x".repeat(4_000)}` }],
		});
		manager.appendMessage({
			role: "assistant",
			api: MODEL_20K.api,
			provider: MODEL_20K.provider,
			model: MODEL_20K.id,
			timestamp: timestamp++,
			stopReason: "stop",
			content: [{ type: "text", text: `answer ${index}` }],
			usage: usage(1_000),
		});
	}
	manager.appendMessage({
		role: "assistant",
		api: MODEL_20K.api,
		provider: MODEL_20K.provider,
		model: MODEL_20K.id,
		timestamp,
		stopReason: "stop",
		content: [{ type: "text", text: "recent" }],
		usage: usage(19_000),
	});
}

interface WorkingTool {
	fixture: Awaited<ReturnType<typeof sdkFixture>>;
	session: AgentSession;
	control: MessageControlHandle;
	log: string[];
	release: Gate<void>;
}

/** 真实非合作工具：忽略 abort，只在门闩释放后返回；模型流只喂事件，不模拟仲裁。 */
async function workingTool(): Promise<WorkingTool> {
	const entered = gate(),
		release = gate();
	const log: string[] = [];
	const tool: ToolDefinition = {
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
	};
	const fixture = await sdkFixture({ tools: [tool] });
	let calls = 0;
	fixture.session.agent.streamFunction = (_model, context, options) => {
		fixture.requests.push(structuredClone(context.messages));
		log.push(`model:${++calls}`);
		return response(
			options?.signal?.aborted
				? assistantTurn([], "aborted")
				: calls === 1
					? assistantTurn(
							[{ type: "toolCall", id: "gate-1", name: "controlled_gate", arguments: {} }],
							"toolUse",
						)
					: textTurn("done"),
		);
	};
	fixture.session.subscribe((event) => {
		if (event.type === "message_start" && event.message.role === "user")
			log.push(`user:${messageText(event.message.content)}`);
	});
	const control = requireControl(fixture.session);
	expect(fixture.session.getActiveToolNames()).toContain("controlled_gate");
	return { fixture, session: fixture.session, control, log, release };
}

describe("S2 preparation awaits and hand-off", () => {
	it("[§6.5 prepare-command] cancels while a real extension command awaits and never sends the old input", async () => {
		const entered = gate(),
			release = gate();
		const commands: string[] = [];
		const fixture = await sdkFixture({
			extensions: [
				(pi) => {
					pi.registerCommand("gated-command", {
						description: "real inline extension command that awaits",
						handler: async () => {
							commands.push("entered");
							entered.resolve();
							await release.promise;
							commands.push("left");
						},
					});
				},
			],
		});
		const control = requireControl(fixture.session);
		const old = control.submit(request(fixture.session, control, "/gated-command"));
		await withTimeout(entered.promise, 5_000, "extension command entered");
		const urgent = await control.submit({
			...request(fixture.session, control, "command-urgent"),
			mode: "interrupt",
		});
		expect(urgent).toMatchObject({ ok: true, value: { disposition: "interrupting" } });
		release.resolve();
		const cancelled = await withTimeout(old, 5_000, "cancelled command settles");
		await withTimeout(control.waitForIdle(), 5_000, "idle after command cancellation");

		expect(commands).toEqual(["entered", "left"]);
		expect(cancelled).toMatchObject({ ok: false, error: { code: "preflight_failed" } });
		expect(fixture.requests).toHaveLength(1);
		expect(JSON.stringify(fixture.requests[0])).toContain("command-urgent");
		expect(JSON.stringify(fixture.requests)).not.toContain("gated-command");
		expect(fixture.session.isIdle).toBe(true);
		expect(control.getSnapshot().phase).toBe("idle");
	});

	it("[§6.5 prepare-compaction] cancels during the real pre-request threshold compaction await", async () => {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: compactionHistory,
			settings: {
				compaction: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 2_000 },
				retry: { enabled: false },
				cacheWarming: "off",
			},
			noDefaultStream: true,
		});
		const control = requireControl(fixture.session);
		const entered = gate(),
			release = gate();
		const modelRequests: unknown[][] = [];
		const summaryRequests: unknown[][] = [];
		fixture.session.agent.streamFunction = async (_model, context) => {
			if (isSummaryRequest(context)) {
				summaryRequests.push(structuredClone(context.messages));
				entered.resolve();
				await release.promise;
				return response(textTurn("## Summary\n- prepare checkpoint"));
			}
			modelRequests.push(structuredClone(context.messages));
			return response(textTurn("after compaction", 2_000, MODEL_20K));
		};
		const ends: Array<{ reason?: string; aborted?: boolean; result?: unknown }> = [];
		fixture.session.subscribe((event) => {
			if (event.type === "compaction_end") ends.push(event);
		});

		const old = control.submit(request(fixture.session, control, "before compaction"));
		await withTimeout(entered.promise, 5_000, "prepare compaction summary gate");
		// 可达性：`_prepareRun` 的 checkCompaction 在第一个模型请求之前就进入真实压缩 await。
		expect(fixture.session.isCompacting).toBe(true);
		expect(modelRequests).toHaveLength(0);

		const urgent = await control.submit({
			...request(fixture.session, control, "compaction-urgent"),
			mode: "interrupt",
		});
		expect(urgent).toMatchObject({ ok: true, value: { disposition: "interrupting" } });
		release.resolve();
		await withTimeout(old, 5_000, "cancelled preparation settles");
		await withTimeout(control.waitForIdle(), 5_000, "idle after compaction cancellation");

		// 第一个摘要请求被中断；随后恢复派发的替代输入再跑一次真实阈值压缩。
		expect(ends).toMatchObject([
			{ reason: "threshold", aborted: true, result: undefined },
			{ reason: "threshold", aborted: false },
		]);
		expect(summaryRequests).toHaveLength(2);
		expect(modelRequests).toHaveLength(1);
		expect(JSON.stringify(modelRequests[0])).toContain("compaction-urgent");
		expect(JSON.stringify(modelRequests)).not.toContain("before compaction");
		expect(fixture.session.isIdle).toBe(true);
		expect(control.getSnapshot().phase).toBe("idle");
	});

	it("[§6.5 preflight-stop] a synchronous stop in the started preflight publication never sends the first request", async () => {
		const fixture = await sdkFixture();
		const control = requireControl(fixture.session);
		let stops = 0;
		const unsubscribe = control.subscribe((update) => {
			if (update.snapshot.phase === "running") {
				stops++;
				control.stop(stopRequest(fixture.session, control, "preflight-stop"));
			}
		});
		const ack = await withTimeout(
			control.submit(request(fixture.session, control, "preflight-old")),
			5_000,
			"preflight submit settles",
		);
		unsubscribe();
		await withTimeout(control.waitForIdle(), 5_000, "preflight stop settles");

		expect(stops).toBe(1);
		expect(ack).toMatchObject({ ok: false, error: { code: "preflight_failed" } });
		expect(fixture.requests).toHaveLength(0);
		expect(JSON.stringify(fixture.session.messages)).not.toContain("preflight-old");
		expect(fixture.session.isIdle).toBe(true);
		expect(control.getSnapshot()).toMatchObject({
			phase: "idle",
			autoDispatchPaused: true,
			items: [expect.objectContaining({ messageId: "preflight-old", state: "held" })],
		});

		// 取消之后，显式新输入仍能启动一次真实运行（held 的 queue 槽位仍属旧消息，故用 steer）。
		const next = await control.submit({
			...request(fixture.session, control, "preflight-next"),
			mode: "steer",
		});
		expect(next).toMatchObject({ ok: true, value: { disposition: "started" } });
		await withTimeout(control.waitForIdle(), 5_000, "explicit input after preflight stop");
		expect(fixture.requests).toHaveLength(1);
		expect(JSON.stringify(fixture.requests[0])).toContain("preflight-next");
	});

	it("[§6.5 preflight-dispose] a synchronous dispose in the preflight publication leaves no run and no pending item", async () => {
		const fixture = await sdkFixture();
		const control = requireControl(fixture.session);
		let disposed = 0;
		const unsubscribe = control.subscribe((update) => {
			if (update.snapshot.phase === "running") {
				disposed++;
				control.dispose();
			}
		});
		const ack = await withTimeout(
			control.submit(request(fixture.session, control, "preflight-disposed")),
			5_000,
			"preflight dispose settles",
		);
		unsubscribe();
		await withTimeout(control.waitForIdle(), 5_000, "disposed preflight settles");

		expect(disposed).toBe(1);
		expect(ack).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(fixture.requests).toHaveLength(0);
		expect(fixture.session.isIdle).toBe(true);
		expect(control.getSnapshot()).toMatchObject({ phase: "idle", items: [] });
	});
});

describe("S2 synchronous stop/dispose from settled handlers", () => {
	it("[§6.5 settle-stop] a settled handler that stops and resubmits never starts an old-generation run", async () => {
		let control: MessageControlHandle | undefined;
		let session: AgentSession | undefined;
		let settled = 0;
		const late: unknown[] = [];
		const fixture = await sdkFixture({
			extensions: [
				(pi) => {
					pi.on("agent_settled", async () => {
						settled++;
						if (settled > 1 || !control || !session) return;
						control.stop(stopRequest(session, control, "settle-stop"));
						// 旧代 settled 回调里的重入输入：必须排队，不能就地启动旧代 run。
						late.push(await session.prompt("late-settled"));
					});
				},
			],
		});
		session = fixture.session;
		control = requireControl(fixture.session);

		await withTimeout(control.submit(request(session, control, "settle-first")), 5_000, "first run submit");
		await withTimeout(control.waitForIdle(), 5_000, "settled handler settles");

		expect(settled).toBe(1);
		expect(late).toEqual(["queued"]);
		expect(fixture.requests).toHaveLength(1);
		expect(JSON.stringify(fixture.requests)).not.toContain("late-settled");
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: true,
			items: [expect.objectContaining({ preview: "late-settled", state: "queued" })],
		});

		// 只有显式新输入才恢复派发；迟到输入作为后续轮次交付一次。
		await withTimeout(
			control.submit(request(session, control, "settle-next")),
			5_000,
			"explicit input after settled stop",
		);
		await withTimeout(control.waitForIdle(), 5_000, "explicit run after settled stop");
		// 显式输入一轮，迟到输入作为同 run 的后续轮次交付一次；没有独立的旧代 run。
		expect(fixture.requests).toHaveLength(3);
		expect(JSON.stringify(fixture.requests[1])).toContain("settle-next");
		expect(JSON.stringify(fixture.requests[1])).not.toContain("late-settled");
		expect(JSON.stringify(fixture.requests[2])).toContain("late-settled");
		expect(
			fixture.session.messages.filter(
				(message) => message.role === "user" && JSON.stringify(message.content).includes("late-settled"),
			),
		).toHaveLength(1);
		expect(control.getSnapshot().items).toEqual([]);
	});

	it("[§6.5 settle-dispose] a settled handler that disposes leaves no new run or pending control state", async () => {
		let control: MessageControlHandle | undefined;
		let disposed = 0;
		const fixture = await sdkFixture({
			extensions: [
				(pi) => {
					pi.on("agent_settled", () => {
						if (disposed > 0 || !control) return;
						disposed++;
						control.dispose();
					});
				},
			],
		});
		control = requireControl(fixture.session);

		await withTimeout(
			control.submit(request(fixture.session, control, "settle-dispose")),
			5_000,
			"submit before settled dispose",
		);
		await withTimeout(control.waitForIdle(), 5_000, "settled dispose settles");

		expect(disposed).toBe(1);
		expect(fixture.requests).toHaveLength(1);
		expect(fixture.session.isIdle).toBe(true);
		expect(control.getSnapshot()).toMatchObject({ phase: "idle", items: [] });
		expect(await control.submit(request(fixture.session, control, "after-settled-dispose"))).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
	});
});

describe("S2 stop/dispose during a real tool", () => {
	it("[§6.5 tool-stop] stop waits for an uncooperative tool and never starts a parallel run", async () => {
		const { session, control, log, release, fixture } = await workingTool();
		// 当前装的 SDK 里 enableMessageControl 未安装 host 租约（preparePendingRequest），
		// 因此本用例走无 host 钩子的路径；host 变体由 core-abort.test.ts 用真实
		// setCompactionPolicy 安装后验证。
		expect(session.agent.preparePendingRequest).toBeUndefined();
		await control.submit(request(session, control, "tool-old"));
		await vi.waitFor(() => expect(log).toContain("tool:start"));
		await control.submit(request(session, control, "tool-queued"));
		await vi.waitFor(() => expect(session.agent.hasQueuedMessages()).toBe(true));

		const ack = control.stop(stopRequest(session, control, "tool-stop"));
		expect(ack).toMatchObject({ ok: true, value: { snapshot: { phase: "interrupting" } } });
		expect(log).not.toContain("tool:end");
		expect(session.isIdle).toBe(false);
		expect(control.getSnapshot().phase).toBe("interrupting");

		release.resolve();
		await withTimeout(control.waitForIdle(), 5_000, "idle after tool stop");

		// 取消闸：stop 后工具批次结束即退出，不再进入下一次 provider-stream，也不留空 aborted assistant。
		const modelCalls = () => log.filter((entry) => entry.startsWith("model:"));
		expect(modelCalls()).toHaveLength(1);
		expect(
			session.messages.filter(
				(message) => message.role === "assistant" && (message as AssistantMessage).stopReason === "aborted",
			),
		).toHaveLength(0);
		expect(log).toContain("tool:end");
		expect(log.filter((entry) => entry === "user:tool-old")).toHaveLength(1);
		expect(log).not.toContain("user:tool-queued");
		expect(fixture.requests.length).toBeGreaterThanOrEqual(1);
		expect(JSON.stringify(fixture.requests)).not.toContain("tool-queued");
		expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(session.isIdle).toBe(true);
		expect(control.getSnapshot()).toMatchObject({ phase: "idle", autoDispatchPaused: true });
		expect(control.getSnapshot().items).toEqual([
			expect.objectContaining({ messageId: "tool-queued", state: "held" }),
		]);

		// 显式新输入仍然能启动（held 的 queue 槽位仍属旧消息，故用 steer）。
		await control.submit({ ...request(session, control, "tool-next"), mode: "steer" });
		await withTimeout(control.waitForIdle(), 5_000, "explicit run after tool stop");
		expect(log).toContain("user:tool-next");
		// 新 run 才是下一次 stream：取消本身没有偷跑一次 provider 调用。
		expect(modelCalls()).toHaveLength(2);
	});

	it("[§6.5 tool-stop-deadlines] slow/blocked deadlines never release the stopped queue automatically", async () => {
		const { session, control, log, release, fixture } = await workingTool();
		await control.submit(request(session, control, "deadline-old"));
		await vi.waitFor(() => expect(log).toContain("tool:start"));
		await control.submit(request(session, control, "deadline-queued"));
		await vi.waitFor(() => expect(session.agent.hasQueuedMessages()).toBe(true));

		vi.useFakeTimers();
		try {
			control.stop(stopRequest(session, control, "deadline-stop"));
			await vi.advanceTimersByTimeAsync(5_000);
			expect(control.getSnapshot().operation?.slow).toBe(true);
			await vi.advanceTimersByTimeAsync(25_000);
			expect(control.getSnapshot()).toMatchObject({ phase: "blocked" });
		} finally {
			vi.useRealTimers();
		}
		release.resolve();
		await withTimeout(control.waitForIdle(), 5_000, "idle after blocked stop");
		expect(log).not.toContain("user:deadline-queued");
		expect(JSON.stringify(fixture.requests)).not.toContain("deadline-queued");
		expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(control.getSnapshot().items).toEqual([
			expect.objectContaining({ messageId: "deadline-queued", state: "held" }),
		]);
		expect(control.getSnapshot()).toMatchObject({ phase: "idle", autoDispatchPaused: true });
	});

	it("[§6.5 tool-dispose] dispose during a real tool (and its waiting stop) leaves no run or pending control", async () => {
		const { session, control, log, release } = await workingTool();
		await control.submit(request(session, control, "tool-dispose-old"));
		await vi.waitFor(() => expect(log).toContain("tool:start"));
		await control.submit(request(session, control, "tool-dispose-queued"));
		await vi.waitFor(() => expect(session.agent.hasQueuedMessages()).toBe(true));
		expect(control.stop(stopRequest(session, control, "tool-dispose-stop"))).toMatchObject({
			ok: true,
			value: { snapshot: { phase: "interrupting" } },
		});
		session.dispose();
		// 销毁后不得留下旧记录，也不得报告一个永远不会结算的 stop。
		expect(control.getSnapshot().items).toEqual([]);
		expect(control.getSnapshot().operation).toBeUndefined();

		release.resolve();
		await withTimeout(session.waitForIdle(), 5_000, "disposed tool run finishes");

		expect(log).toContain("tool:end");
		expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(control.getSnapshot().items).toEqual([]);
		expect(await control.submit(request(session, control, "after-tool-dispose"))).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
	});
});
