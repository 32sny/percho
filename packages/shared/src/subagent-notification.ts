/**
 * pi-subagents 后台完成通知解析（custom 消息 `<task-notification>`）。
 *
 * 后台派工时 `Agent` 一次性返回、之后不再更新工具结果，Percho 只能靠这条通知把
 * 派工时装出的"运行中"行收尾：`<tool-use-id>` 对应那次 Agent 调用（与 subagentRuns
 * 的 key 前缀一致），`<task-id>` 是 agent id，`<status>` 给终态，`<usage>` 给
 * token / 工具次数 / 耗时。
 */
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
