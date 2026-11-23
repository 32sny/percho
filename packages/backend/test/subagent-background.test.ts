import {
	applyPerchoSubagentNotification,
	emptyTranscript,
	extractSubagentRuns,
	PERCHO_SUBAGENT_NOTIFICATION_TYPE,
	parsePerchoSubagentNotification,
	reduceEvent,
} from "@percho/shared";
import { describe, expect, it, vi } from "vitest";
import { toBranchSessionMessages } from "../src/session/messages";
import { BackgroundSubagentManager } from "../src/tools/subagent/background";

describe("BackgroundSubagentManager & percho-subagent-notification", () => {
	it("parsePerchoSubagentNotification 解析合法通知并拒绝非法载荷", () => {
		expect(parsePerchoSubagentNotification(null)).toBeNull();
		expect(
			parsePerchoSubagentNotification({ runId: "", mode: "single", status: "done", runs: [] }),
		).toBeNull();
		const parsed = parsePerchoSubagentNotification({
			runId: "bg_12345678",
			mode: "parallel",
			status: "done",
			runs: [
				{
					runId: "bg_12345678",
					index: 1,
					agent: "scout",
					status: "done",
					sessionFile: "/tmp/sub.jsonl",
					exitCode: 0,
					tokens: 420,
				},
			],
		});
		expect(parsed).not.toBeNull();
		expect(parsed?.runs[0]?.agent).toBe("scout");
		expect(parsed?.runs[0]?.tokens).toBe(420);
	});

	it("extractSubagentRuns 识别 mode=background 的初始运行中/排队中卡片", () => {
		const runs = extractSubagentRuns({
			mode: "background",
			runId: "bg_abc",
			results: [
				{
					agent: "scout",
					status: "running",
					index: 1,
					artifactPaths: { jsonlPath: "/tmp/s1.jsonl" },
				},
				{
					agent: "Explore",
					status: "queued",
					index: 2,
					artifactPaths: {},
				},
			],
		});
		expect(runs).toEqual([
			expect.objectContaining({
				agent: "scout",
				status: "running",
				index: 1,
				runId: "bg_abc",
				background: true,
				sessionFile: "/tmp/s1.jsonl",
			}),
			expect.objectContaining({
				agent: "Explore",
				status: "queued",
				index: 2,
				runId: "bg_abc",
				background: true,
			}),
		]);
	});

	it("toBranchSessionMessages 与 reduceEvent 消费 percho-subagent-notification 原地更新卡片且不产假气泡", () => {
		const notifDetails = {
			runId: "bg_abc",
			mode: "single" as const,
			status: "done" as const,
			runs: [
				{
					runId: "bg_abc",
					agent: "scout",
					status: "done" as const,
					sessionFile: "/tmp/s1.jsonl",
					exitCode: 0,
					tokens: 321,
					summary: {
						changedFiles: [],
						commands: [],
						failedCommands: 0,
						durationMs: 1200,
					},
				},
			],
		};

		// 1. 历史回放路径（assistant toolCall + toolResult + custom_message）
		const messages = toBranchSessionMessages([
			{
				type: "message",
				id: "m0",
				parentId: null,
				timestamp: "2026-11-22T00:00:00.000Z",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "tc1",
							name: "subagent",
							arguments: { agent: "scout", task: "check", run_in_background: true },
						},
					],
					timestamp: 900,
				},
			},
			{
				type: "message",
				id: "m1",
				parentId: "m0",
				timestamp: "2026-11-22T00:00:00.500Z",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "subagent",
					content: [{ type: "text", text: "Dispatched" }],
					details: {
						mode: "background",
						runId: "bg_abc",
						results: [
							{
								agent: "scout",
								status: "running",
								artifactPaths: { jsonlPath: "/tmp/s1.jsonl" },
							},
						],
					},
					isError: false,
					timestamp: 1000,
				},
			},
			{
				type: "custom_message",
				id: "m2",
				parentId: "m1",
				timestamp: "2026-11-22T00:00:02.000Z",
				customType: PERCHO_SUBAGENT_NOTIFICATION_TYPE,
				content: "<subagent-notification>done</subagent-notification>",
				display: false,
				details: notifDetails,
			},
		] as never);

		expect(messages).toHaveLength(2);
		expect(messages[0]?.role).toBe("assistant");
		const replayed = messages[1];
		expect(replayed?.role).toBe("subagent");
		if (replayed?.role !== "subagent") throw new Error("expected a replayed subagent message");
		expect(replayed.runs[0]?.status).toBe("done");
		expect(replayed.runs[0]?.tokens).toBe(321);
		expect(replayed.runs[0]?.summary?.durationMs).toBe(1200);

		// 2. 实时 reducer 路径（先开工建流式容器，与真实事件序一致）
		let state = emptyTranscript();
		state = reduceEvent(state, { type: "agent_start" } as never);
		state = reduceEvent(state, {
			type: "tool_execution_start",
			toolCallId: "tc1",
			toolName: "subagent",
			args: { agent: "scout", task: "check", run_in_background: true },
		} as never);
		state = reduceEvent(state, {
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "subagent",
			result: {
				content: [{ type: "text", text: "Dispatched" }],
				details: {
					mode: "background",
					runId: "bg_abc",
					results: [
						{
							agent: "scout",
							status: "running",
							artifactPaths: { jsonlPath: "/tmp/s1.jsonl" },
						},
					],
				},
			},
			isError: false,
		} as never);
		// 后台完成通知在 message_start 被消费（不产气泡，只原地收尾卡片）
		state = reduceEvent(state, {
			type: "message_start",
			message: {
				role: "custom",
				customType: PERCHO_SUBAGENT_NOTIFICATION_TYPE,
				content: "<subagent-notification>done</subagent-notification>",
				display: false,
				details: notifDetails,
				timestamp: 2000,
			},
		} as never);
		state = reduceEvent(state, {
			type: "turn_end",
			message: { role: "assistant", content: [], timestamp: 2000 },
		} as never);

		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]?.kind).toBe("subagent");
		if (state.messages[0]?.kind === "subagent") {
			expect(state.messages[0].runs[0]?.status).toBe("done");
			expect(state.messages[0].runs[0]?.tokens).toBe(321);
		}

		// 3. subagent_background_update 事件（中间进度）：刷新 tokens 但不产气泡，且终态不回退
		let progress = emptyTranscript();
		progress = reduceEvent(progress, { type: "agent_start" } as never);
		progress = reduceEvent(progress, {
			type: "tool_execution_start",
			toolCallId: "tc-progress",
			toolName: "subagent",
			args: { agent: "scout", task: "进度用例", run_in_background: true },
		} as never);
		progress = reduceEvent(progress, {
			type: "tool_execution_end",
			toolCallId: "tc-progress",
			toolName: "subagent",
			result: {
				content: [{ type: "text", text: "Dispatched" }],
				details: {
					mode: "background",
					runId: "bg_pg",
					results: [{ agent: "scout", status: "running", artifactPaths: { jsonlPath: "/tmp/p.jsonl" } }],
				},
			},
			isError: false,
		} as never);
		progress = reduceEvent(progress, {
			type: "turn_end",
			message: { role: "assistant", content: [], timestamp: 1 },
		} as never);

		progress = reduceEvent(progress, {
			type: "subagent_background_update",
			notification: {
				runId: "bg_pg",
				mode: "single",
				status: "running",
				runs: [{ runId: "bg_pg", agent: "scout", status: "running", tokens: 42 }],
			},
		} as never);
		const afterProgress = progress.messages.find((m) => m.kind === "subagent");
		expect(afterProgress?.kind === "subagent" && afterProgress.runs[0]?.tokens).toBe(42);
		expect(afterProgress?.kind === "subagent" && afterProgress.runs[0]?.status).toBe("running");

		progress = reduceEvent(progress, {
			type: "subagent_background_update",
			notification: {
				runId: "bg_pg",
				mode: "single",
				status: "done",
				runs: [{ runId: "bg_pg", agent: "scout", status: "done", tokens: 50, exitCode: 0 }],
			},
		} as never);
		// 迟到的 running 快照不得把终态打回运行中
		progress = reduceEvent(progress, {
			type: "subagent_background_update",
			notification: {
				runId: "bg_pg",
				mode: "single",
				status: "running",
				runs: [{ runId: "bg_pg", agent: "scout", status: "running", tokens: 60 }],
			},
		} as never);
		const afterDone = progress.messages.find((m) => m.kind === "subagent");
		expect(afterDone?.kind === "subagent" && afterDone.runs[0]?.status).toBe("done");
		expect(afterDone?.kind === "subagent" && afterDone.runs[0]?.tokens).toBe(50);
		expect(progress.messages).toHaveLength(1);

		// 4. applyPerchoSubagentNotification 纯函数直接校验
		const updated = applyPerchoSubagentNotification(
			[
				{
					key: "tc1:0",
					agent: "scout",
					status: "running",
					runId: "bg_abc",
					background: true,
				},
			],
			notifDetails,
		);
		expect(updated[0]?.status).toBe("done");
	});

	it("BackgroundSubagentManager.stop 与 abortForParent 正确中止并清理", async () => {
		const manager = new BackgroundSubagentManager();
		const onComplete = vi.fn(async () => {});
		const dispatched = manager.dispatch({
			parentSessionId: "parent-1",
			mode: "single",
			definitions: [
				{
					task: { agent: "scout", task: "long task" },
					cwd: process.cwd(),
					agent: {
						name: "scout",
						description: "scout",
						tools: ["read"],
						systemPrompt: "test",
						source: "builtin",
					},
				},
			],
			projectTrusted: true,
			deps: {
				getModelRuntime: async () => {
					throw new Error("aborted");
				},
				getSubagentModel: async () => undefined,
				getSubagentThinkingLevel: async () => undefined,
				gate: { confirm: async () => false } as never,
				traces: { record: () => {} } as never,
			},
			onComplete,
		});

		expect(dispatched.runId).toMatch(/^bg_/);
		expect(dispatched.results[0]?.status).toBe("running");
		expect(dispatched.results[0]?.artifactPaths.jsonlPath).toBeTruthy();
		expect(manager.hasRunning("parent-1")).toBe(true);

		const stopped = await manager.stop("parent-1", dispatched.runId);
		expect(stopped.stopped).toBe(true);
		expect(stopped.batch?.status).toBe("aborted");
		expect(manager.hasRunning("parent-1")).toBe(false);
		expect(onComplete).toHaveBeenCalledTimes(1);

		await manager.disposeAll();
	});
});

describe("BackgroundSubagentManager 生命周期收口", () => {
	const scoutDef = (task: string) => ({
		task: { agent: "scout", task },
		cwd: process.cwd(),
		agent: {
			name: "scout",
			description: "scout",
			tools: ["read"],
			systemPrompt: "test",
			source: "builtin" as const,
		},
	});
	/** getModelRuntime 挂起直到 release()，然后以失败结束（模拟子会话起跑前的异常） */
	function gatedDeps() {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const registered = new Set<string>();
		const deps = {
			getModelRuntime: async () => {
				await gate;
				throw new Error("runtime unavailable");
			},
			getSubagentModel: async () => undefined,
			getSubagentThinkingLevel: async () => undefined,
			gate: { confirm: async () => false } as never,
			traces: { record: () => {} } as never,
			registerRun: (handle: { sessionId: string }) => {
				registered.add(handle.sessionId);
			},
			unregisterRun: (sessionId: string) => {
				registered.delete(sessionId);
			},
		};
		return { deps, registered, release: () => release() };
	}

	it("子会话起跑前失败时注销后台占位句柄，不残留「工作中」条目", async () => {
		const manager = new BackgroundSubagentManager();
		const { deps, registered, release } = gatedDeps();
		const dispatched = manager.dispatch({
			parentSessionId: "p",
			mode: "single",
			definitions: [scoutDef("t")],
			projectTrusted: true,
			deps,
		});
		expect(registered.size).toBe(1);
		release();
		await manager.wait("p", dispatched.runId, 5_000);
		expect(manager.list("p", dispatched.runId)[0]?.status).toBe("error");
		expect(registered.size).toBe(0);
	});

	it("subagent_wait 已等到结果时，完成通知只落盘不再唤醒新一轮", async () => {
		const manager = new BackgroundSubagentManager();
		const { deps, release } = gatedDeps();
		const onComplete = vi.fn(async () => {});
		const dispatched = manager.dispatch({
			parentSessionId: "p",
			mode: "single",
			definitions: [scoutDef("t")],
			projectTrusted: true,
			deps,
			onComplete,
		});
		const waiting = manager.wait("p", dispatched.runId, 5_000);
		release();
		const res = await waiting;
		expect(res.timedOut).toBe(false);
		expect(onComplete).toHaveBeenCalledTimes(1);
		expect(onComplete.mock.calls[0]?.[3]).toEqual({ triggerTurn: false });
	});

	it("无人等待时完成通知照常唤醒父会话", async () => {
		const manager = new BackgroundSubagentManager();
		const { deps, release } = gatedDeps();
		const onComplete = vi.fn(async () => {});
		const dispatched = manager.dispatch({
			parentSessionId: "p",
			mode: "single",
			definitions: [scoutDef("t")],
			projectTrusted: true,
			deps,
			onComplete,
		});
		release();
		await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
		expect(manager.list("p", dispatched.runId)[0]?.status).toBe("error");
		expect(onComplete.mock.calls[0]?.[3]).toEqual({ triggerTurn: true });
	});

	it("subagent_stop 主动停止不唤醒新一轮；删除父会话时完全不投递", async () => {
		const manager = new BackgroundSubagentManager();
		const stopCase = gatedDeps();
		const onStopComplete = vi.fn(async () => {});
		const stopped = manager.dispatch({
			parentSessionId: "p",
			mode: "single",
			definitions: [scoutDef("t")],
			projectTrusted: true,
			deps: stopCase.deps,
			onComplete: onStopComplete,
		});
		const stopping = manager.stop("p", stopped.runId);
		stopCase.release();
		await stopping;
		expect(onStopComplete).toHaveBeenCalledTimes(1);
		expect(onStopComplete.mock.calls[0]?.[3]).toEqual({ triggerTurn: false });

		const deleteCase = gatedDeps();
		const onDeleteComplete = vi.fn(async () => {});
		manager.dispatch({
			parentSessionId: "q",
			mode: "single",
			definitions: [scoutDef("t")],
			projectTrusted: true,
			deps: deleteCase.deps,
			onComplete: onDeleteComplete,
		});
		const aborting = manager.abortForParent("q");
		deleteCase.release();
		await aborting;
		expect(onDeleteComplete).not.toHaveBeenCalled();
	});
});

describe("后台卡片历史回放以后台管理器真实状态为准", () => {
	const dispatchBranch = (status: "running" | "queued") =>
		[
			{
				type: "message",
				id: "a0",
				parentId: null,
				timestamp: "2026-11-22T00:00:00.000Z",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "tcb",
							name: "subagent",
							arguments: { agent: "scout", task: "bg", run_in_background: true },
						},
					],
					timestamp: 900,
				},
			},
			{
				type: "message",
				id: "a1",
				parentId: "a0",
				timestamp: "2026-11-22T00:00:00.500Z",
				message: {
					role: "toolResult",
					toolCallId: "tcb",
					toolName: "subagent",
					content: [{ type: "text", text: "Dispatched" }],
					details: {
						mode: "background",
						runId: "bg_orphan",
						results: [{ agent: "scout", status, artifactPaths: { jsonlPath: "/tmp/o.jsonl" } }],
					},
					isError: false,
					timestamp: 1000,
				},
			},
		] as never;
	const runsOf = (messages: ReturnType<typeof toBranchSessionMessages>) => {
		const sub = messages.find((m) => m.role === "subagent");
		if (sub?.role !== "subagent") throw new Error("expected subagent message");
		return sub.runs;
	};

	it("管理器不认识的批次（应用重启/崩溃后无终态通知）收口为 aborted，不永久运行中", () => {
		for (const status of ["running", "queued"] as const) {
			const runs = runsOf(
				toBranchSessionMessages(dispatchBranch(status), { resolveBackgroundBatch: () => null }),
			);
			expect(runs[0]?.status).toBe("aborted");
		}
	});

	it("管理器仍在跟踪的批次采用其实时状态（终态通知尚未落盘的窗口期也不误判）", () => {
		const resolve = (runId: string) =>
			runId === "bg_orphan"
				? {
						runId,
						mode: "single" as const,
						status: "done" as const,
						runs: [{ runId, agent: "scout", status: "done" as const, tokens: 77, exitCode: 0 }],
					}
				: null;
		const runs = runsOf(
			toBranchSessionMessages(dispatchBranch("running"), { resolveBackgroundBatch: resolve }),
		);
		expect(runs[0]?.status).toBe("done");
		expect(runs[0]?.tokens).toBe(77);
	});

	it("未提供解析器时保持原样（子会话摘要等纯投影场景）", () => {
		expect(runsOf(toBranchSessionMessages(dispatchBranch("running")))[0]?.status).toBe("running");
	});
});
