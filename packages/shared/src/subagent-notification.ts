import type { SubagentRunStatus, SubagentRunSummary } from "./subagent";

/**
 * pi-subagents 后台完成通知解析（custom 消息 `<task-notification>`）。
 *
 * 后台派工时 `Agent` 一次性返回、之后不再更新工具结果，Percho 只能靠这条通知把
 * 派工时装出的"运行中"行收尾：`<tool-use-id>` 对应那次 Agent 调用（与 subagentRuns
 * 的 key 前缀一致），`<task-id>` 是 agent id，`<status>` 给终态，`<usage>` 给
 * token / 工具次数 / 耗时。
 */

export const PERCHO_SUBAGENT_NOTIFICATION_TYPE = "percho-subagent-notification";

export interface PerchoSubagentNotificationRun {
	runId: string;
	index?: number;
	agent: string;
	status: "running" | "queued" | "done" | "error" | "aborted";
	sessionFile?: string;
	exitCode?: number;
	error?: string;
	tokens?: number;
	summary?: SubagentRunSummary;
}

export interface PerchoSubagentNotificationDetails {
	runId: string;
	mode: "single" | "parallel";
	status: "running" | "done" | "error" | "aborted";
	runs: PerchoSubagentNotificationRun[];
}

export function parsePerchoSubagentNotification(details: unknown): PerchoSubagentNotificationDetails | null {
	if (!details || typeof details !== "object") return null;
	const d = details as Record<string, unknown>;
	if (typeof d.runId !== "string" || d.runId.length === 0) return null;
	if (d.mode !== "single" && d.mode !== "parallel") return null;
	if (d.status !== "running" && d.status !== "done" && d.status !== "error" && d.status !== "aborted") {
		return null;
	}
	if (!Array.isArray(d.runs)) return null;
	const runs: PerchoSubagentNotificationRun[] = [];
	for (const raw of d.runs) {
		if (!raw || typeof raw !== "object") continue;
		const r = raw as Record<string, unknown>;
		if (typeof r.agent !== "string") continue;
		const status = r.status;
		if (
			status !== "running" &&
			status !== "queued" &&
			status !== "done" &&
			status !== "error" &&
			status !== "aborted"
		) {
			continue;
		}
		runs.push({
			runId: typeof r.runId === "string" ? r.runId : d.runId,
			...(typeof r.index === "number" ? { index: r.index } : {}),
			agent: r.agent,
			status,
			...(typeof r.sessionFile === "string" ? { sessionFile: r.sessionFile } : {}),
			...(typeof r.exitCode === "number" ? { exitCode: r.exitCode } : {}),
			...(typeof r.error === "string" ? { error: r.error } : {}),
			...(typeof r.tokens === "number" ? { tokens: r.tokens } : {}),
			...(r.summary && typeof r.summary === "object" ? { summary: r.summary as SubagentRunSummary } : {}),
		});
	}
	return { runId: d.runId, mode: d.mode, status: d.status, runs };
}

const TERMINAL_RUN_STATUSES = new Set<SubagentRunStatus>(["done", "error", "aborted"]);

function isTerminalRunStatus(status: SubagentRunStatus): boolean {
	return TERMINAL_RUN_STATUSES.has(status);
}

/**
 * 在通知里找到本次 run 对应的条目。
 *
 * 一个后台批次的**所有** run 共用批次级 `runId`，单看 runId 无法区分并行批次的兄弟项：
 * 多项通知时必须再按 `index`（无 index 时按 `sessionFile`）定位，否则会把 A 的结果写到 B 上。
 */
function findNotificationRun<T extends { runId?: string; index?: number; sessionFile?: string }>(
	run: T,
	notif: PerchoSubagentNotificationDetails,
): PerchoSubagentNotificationDetails["runs"][number] | undefined {
	const sameRunId = notif.runs.filter((item) => run.runId != null && item.runId === run.runId);
	const sameSessionFile = (item: PerchoSubagentNotificationDetails["runs"][number]) =>
		Boolean(item.sessionFile && run.sessionFile && item.sessionFile === run.sessionFile);
	if (notif.runs.length > 1) {
		return (
			sameRunId.find((item) => item.index != null && run.index != null && item.index === run.index) ??
			sameRunId.find(sameSessionFile)
		);
	}
	return sameRunId[0] ?? notif.runs.find(sameSessionFile);
}

export function applyPerchoSubagentNotification<
	T extends {
		runId?: string;
		index?: number;
		sessionFile?: string;
		status: SubagentRunStatus;
		exitCode?: number;
		tokens?: number;
		summary?: SubagentRunSummary;
	},
>(runs: readonly T[], notif: PerchoSubagentNotificationDetails): T[] | null {
	let changed = false;
	const next = runs.map((run) => {
		const match = findNotificationRun(run, notif);
		if (!match) return run;
		// 终态不回退：后台批次先推进度快照、再推终态，IPC/唤醒乱序或重投时，
		// 迟到的 running 快照不得把已收尾的卡片打回运行中（否则卡片永久转圈）。
		if (isTerminalRunStatus(run.status) && !isTerminalRunStatus(match.status)) return run;
		changed = true;
		return {
			...run,
			status: match.status,
			...(match.sessionFile ? { sessionFile: match.sessionFile } : {}),
			...(match.exitCode != null ? { exitCode: match.exitCode } : {}),
			...(match.tokens != null ? { tokens: match.tokens } : {}),
			...(match.summary ? { summary: match.summary } : {}),
		};
	});
	return changed ? next : null;
}
export interface SubagentNotification {
	/** Agent 调用的 toolCallId（与 subagentRuns key 前缀一致） */
	toolUseId?: string;
	/** pi-subagents 的 agent id（后台派工返回的 Agent ID） */
	agentId?: string;
	status: "done" | "error";
	tokens?: number;
	toolUses?: number;
	durationMs?: number;
}

const MARKER = "<task-notification>";

/** 从 custom 消息正文解析通知；不是通知消息返回 null */
export function parseSubagentNotification(content: unknown): SubagentNotification | null {
	if (typeof content !== "string" || !content.includes(MARKER)) return null;
	const pick = (tag: string): string | undefined => {
		// 用 indexOf 切片而不是正则：这里要的就是"两个闭合标签之间的全部内容"，
		// 正则会引入转义噪音，且 tag 来自调用方常量，不存在注入面。
		const open = `<${tag}>`;
		const close = `</${tag}>`;
		const start = content.indexOf(open);
		if (start < 0) return undefined;
		const end = content.indexOf(close, start + open.length);
		if (end < 0) return undefined;
		const value = content.slice(start + open.length, end).trim();
		return value && value.length > 0 ? value : undefined;
	};
	const num = (tag: string): number | undefined => {
		const raw = pick(tag);
		if (!raw) return undefined;
		const value = Number(raw.replace(/[^0-9.]/g, ""));
		return Number.isFinite(value) ? Math.round(value) : undefined;
	};
	// `<status>` 是人间可读串（Done / Error: … / Aborted … / Stopped），只分成功与失败两类
	const statusLabel = pick("status") ?? "";
	const failed = /error|abort|stop|fail/i.test(statusLabel);
	return {
		toolUseId: pick("tool-use-id"),
		agentId: pick("task-id"),
		status: failed ? "error" : "done",
		tokens: num("total_tokens"),
		toolUses: num("tool_uses"),
		durationMs: num("duration_ms"),
	};
}

/** 通知能落到的最小行形状（实时 SubagentRunUi 与历史回放的 SubagentRunData 都满足） */
interface NotifiableRun {
	agentId?: string;
	status: string;
	tokens?: number;
	exitCode?: number;
}

/**
 * 把通知应用到一组子代理行：优先按 key 前缀（`toolCallId:index`）匹配，其次按 agentId。
 * 命中返回新数组，全部未命中返回 null（调用方据此跳过状态更新，避免无谓重渲染）。
 */
export function applySubagentNotification<R extends NotifiableRun>(
	runs: R[],
	notif: SubagentNotification,
	keyOf?: (run: R, index: number) => string | undefined,
): R[] | null {
	let hit = false;
	const next = runs.map((run, index) => {
		const byKey =
			notif.toolUseId !== undefined && keyOf
				? (keyOf(run, index)?.startsWith(`${notif.toolUseId}:`) ?? false)
				: false;
		const byId = notif.agentId !== undefined && run.agentId === notif.agentId;
		if (!byKey && !byId) return run;
		hit = true;
		return {
			...run,
			status: notif.status,
			...(notif.tokens !== undefined ? { tokens: notif.tokens } : {}),
			...(notif.status === "error" ? { exitCode: 1 } : {}),
		} as R;
	});
	return hit ? next : null;
}
