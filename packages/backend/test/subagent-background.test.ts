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

		// 3. applyPerchoSubagentNotification 纯函数直接校验
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
