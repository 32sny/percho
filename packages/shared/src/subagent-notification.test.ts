import { describe, expect, it } from "vitest";
import type { SubagentRunStatus } from "./subagent";
import {
	applyPerchoSubagentNotification,
	type PerchoSubagentNotificationDetails,
} from "./subagent-notification";

interface Row {
	runId?: string;
	index?: number;
	sessionFile?: string;
	status: SubagentRunStatus;
	tokens?: number;
}

const BATCH = "bg_shared0001";

function notif(
	status: PerchoSubagentNotificationDetails["status"],
	runs: PerchoSubagentNotificationDetails["runs"],
): PerchoSubagentNotificationDetails {
	return { runId: BATCH, mode: runs.length > 1 ? "parallel" : "single", status, runs };
}

describe("applyPerchoSubagentNotification", () => {
	it("单 run：批次级 runId 直接命中并写入终态", () => {
		const runs: Row[] = [{ runId: BATCH, status: "running" }];
		const next = applyPerchoSubagentNotification(
			runs,
			notif("done", [{ runId: BATCH, agent: "scout", status: "done", tokens: 321, exitCode: 0 }]),
		);
		expect(next).toEqual([{ runId: BATCH, status: "done", tokens: 321, exitCode: 0 }]);
	});

	it("并行批次：兄弟项共用 runId，必须按 index 定位（否则 A 的结果写到 B 上）", () => {
		const runs: Row[] = [
			{ runId: BATCH, index: 1, status: "running" },
			{ runId: BATCH, index: 2, status: "running" },
		];
		const next = applyPerchoSubagentNotification(
			runs,
			notif("running", [
				{ runId: BATCH, index: 1, agent: "scout", status: "running", tokens: 10 },
				{ runId: BATCH, index: 2, agent: "Explore", status: "done", tokens: 99, exitCode: 0 },
			]),
		);
		expect(next).toEqual([
			{ runId: BATCH, index: 1, status: "running", tokens: 10 },
			{ runId: BATCH, index: 2, status: "done", tokens: 99, exitCode: 0 },
		]);
	});

	it("并行批次：run 没有 index 时退回 sessionFile 定位", () => {
		const runs: Row[] = [{ runId: BATCH, sessionFile: "/a/one.jsonl", status: "running" }];
		const next = applyPerchoSubagentNotification(
			runs,
			notif("done", [
				{ runId: BATCH, index: 1, agent: "scout", status: "done", sessionFile: "/a/two.jsonl" },
				{ runId: BATCH, index: 2, agent: "scout", status: "done", sessionFile: "/a/one.jsonl", tokens: 7 },
			]),
		);
		expect(next?.[0]).toMatchObject({ status: "done", tokens: 7, sessionFile: "/a/one.jsonl" });
	});

	it("终态不回退：迟到的 running 进度不得把已完成卡片打回运行中", () => {
		const runs: Row[] = [{ runId: BATCH, status: "done", tokens: 50 }];
		const next = applyPerchoSubagentNotification(
			runs,
			notif("running", [{ runId: BATCH, agent: "scout", status: "running", tokens: 60 }]),
		);
		expect(next).toBeNull();
	});

	it("终态可继续演进（done → error 仍允许覆盖，保留最后一次失败原因）", () => {
		const runs: Row[] = [{ runId: BATCH, status: "done" }];
		const next = applyPerchoSubagentNotification(
			runs,
			notif("error", [{ runId: BATCH, agent: "scout", status: "error", exitCode: 1 }]),
		);
		expect(next?.[0]).toMatchObject({ status: "error", exitCode: 1 });
	});

	it("找不到匹配项时返回 null（调用方据此判断是否有变化）", () => {
		const runs: Row[] = [{ runId: "bg_other", status: "running" }];
		expect(applyPerchoSubagentNotification(runs, notif("done", []))).toBeNull();
	});
});
