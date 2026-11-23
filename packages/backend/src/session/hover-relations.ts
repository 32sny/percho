import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import {
	extractSubagentRuns,
	PERCHO_SUBAGENT_NOTIFICATION_TYPE,
	type PerchoSubagentNotificationDetails,
	type PerchoSubagentNotificationRun,
	parsePerchoSubagentNotification,
	projectSessionHoverAgent,
	projectSessionHoverTask,
	SESSION_HOVER_PAGE_SIZE,
	type SessionHoverLiveRun,
	type SessionHoverRelationChild,
	type SessionHoverRelationParent,
	type SessionHoverRelations,
	type SessionHoverRoleCount,
} from "@percho/shared";
import {
	checkMemoryBudget,
	fail,
	fileMatchesId,
	type GetLoadedHoverSession,
	type HoverHistorySnapshot,
	object,
	readFileHoverHistory,
	readLoadedHoverHistory,
} from "./hover-history";
import { PiSubagentRelationLimitError, resolvePiSubagentRelations } from "./pi-subagent-relations";
import { backendSessionPathKey as pathKey } from "./session-paths";
import {
	isOrdinarySessionPath,
	validateOrdinarySessionFile,
	validateSubagentSessionFile,
} from "./subagent-paths";
import { collectRelationRecords } from "./subagent-relation-records";

function liveStatus(
	run: SessionHoverLiveRun,
	previous?: SessionHoverRelationChild,
): SessionHoverRelationChild["status"] {
	if (run.status === "running") return "running";
	if (run.exitCode !== undefined) return run.exitCode === 0 ? "done" : "error";
	if (run.status === "error") return "error";
	return previous?.status ?? "unknown";
}

function mergeLiveRelations(
	history: SessionHoverRelationChild[],
	runs: SessionHoverLiveRun[],
): SessionHoverRelationChild[] {
	if (!Array.isArray(runs)) fail("limit_exceeded");
	// 先有界遍历，不能先 JSON.stringify 无界的 IPC 输入再量体积。
	try {
		checkMemoryBudget([runs], false);
	} catch {
		fail("limit_exceeded");
	}
	for (const run of runs) {
		if (
			!object(run) ||
			typeof run.sessionFile !== "string" ||
			typeof run.agent !== "string" ||
			(run.task !== undefined && typeof run.task !== "string") ||
			(run.exitCode !== undefined && (typeof run.exitCode !== "number" || !Number.isFinite(run.exitCode))) ||
			(run.status !== "running" && run.status !== "done" && run.status !== "error") ||
			(run.source !== "committed" && run.source !== "streaming")
		)
			fail("limit_exceeded");
	}
	const byPath = new Map<string, SessionHoverRelationChild>();
	for (const child of history) {
		const key = pathKey(child.sessionFile);
		byPath.delete(key);
		byPath.set(key, child);
	}
	// committed 只覆盖当前分支已有行；不能靠旧 transcript 复活撤回的派工。
	for (const run of runs) {
		if (run.source !== "committed" || !isAbsolute(run.sessionFile)) continue;
		const key = pathKey(run.sessionFile);
		const previous = byPath.get(key);
		if (previous) byPath.set(key, { ...previous, status: liveStatus(run, previous) });
	}
	const streaming = new Map<string, SessionHoverRelationChild>();
	for (const run of runs) {
		if (run.source !== "streaming" || !isAbsolute(run.sessionFile)) continue;
		const key = pathKey(run.sessionFile);
		const previous = streaming.get(key) ?? byPath.get(key);
		const taskFirstLine = projectSessionHoverTask(run.task, run.sessionFile);
		const idMatch = /_([0-9a-fA-F-]{8,})\.jsonl$/i.exec(run.sessionFile);
		byPath.delete(key);
		streaming.delete(key);
		streaming.set(key, {
			...previous,
			sessionFile: run.sessionFile,
			...(idMatch?.[1] ? { sessionId: idMatch[1] } : {}),
			agent: projectSessionHoverAgent(run.agent, run.sessionFile),
			taskFirstLine,
			status: liveStatus(run, previous),
		});
	}
	return [...streaming.values()].reverse().concat([...byPath.values()].reverse());
}

/**
 * 全量角色聚合（必须在分页 slice 之前做完）：大小写不敏感去重，label 保留首次出现的展示形式，
 * status 取该角色最新一项 —— `valid` 的顺序就是「最新在前」（合并后的 live/历史顺序）。
 */
function aggregateRoleCounts(valid: readonly SessionHoverRelationChild[]): SessionHoverRoleCount[] {
	const byRole = new Map<string, SessionHoverRoleCount>();
	for (const child of valid) {
		if (typeof child.agent !== "string") continue;
		const label = child.agent;
		const key = label.toLowerCase();
		if (!key.trim()) continue;
		const existing = byRole.get(key);
		if (existing) existing.count += 1;
		else byRole.set(key, { label, count: 1, status: child.status });
	}
	return [...byRole.values()];
}

export interface HoverParentResolution {
	parent?: SessionHoverRelationParent;
	dependencySessionIds: string[];
}

/** 一层反向关系；依赖是失效线索，不是导航授权。父不可读时仍保留合法候选ID。 */
export async function resolveHoverParent(
	history: HoverHistorySnapshot,
	getLoadedSession?: GetLoadedHoverSession,
): Promise<HoverParentResolution> {
	const none: HoverParentResolution = { dependencySessionIds: [] };
	const childFile = history.sessionFile;
	const parentPath = history.header.parentSession;
	if (!childFile || typeof parentPath !== "string" || !isAbsolute(parentPath)) return none;
	const parentFile = resolve(parentPath);
	let dependencySessionIds: string[] = [];
	try {
		if (!(await validateOrdinarySessionFile(childFile)) || !fileMatchesId(childFile, history.sessionId))
			return none;
		if (!isOrdinarySessionPath(parentFile) || pathKey(parentFile) === pathKey(childFile)) return none;
		const parentId = basename(parentFile)
			.replace(/\.jsonl$/i, "")
			.split("_")
			.at(-1);
		if (!parentId || !/^[0-9a-f-]{8,}$/i.test(parentId) || parentId === history.sessionId) return none;
		dependencySessionIds = [parentId];
		// 必须在读取父文件之前校验真实路径；不能为保留负缓存依赖而省掉这道门。
		if (!(await validateOrdinarySessionFile(parentFile))) return { dependencySessionIds };
		const loaded = getLoadedSession?.(parentId);
		if (
			loaded &&
			(!fileMatchesId(loaded.manager.getSessionFile?.() ?? "", parentId) ||
				pathKey(loaded.manager.getSessionFile?.() ?? "") !== pathKey(parentFile))
		)
			return { dependencySessionIds };
		const parentHistory = loaded
			? readLoadedHoverHistory(parentId, history.cwd, loaded.cwd, loaded.manager)
			: await readFileHoverHistory(parentId, history.cwd, parentFile);
		const relations = await resolvePiSubagentRelations(
			parentHistory.branch,
			{
				cwd: parentHistory.cwd,
				sessionFile: parentFile,
			},
			{},
			collectRelationRecords(parentHistory.branch, parentHistory.sessionId, parentFile),
		);
		const found = [...relations.byEntryId.values()].some(
			(item) => item.sessionId === history.sessionId && pathKey(item.sessionFile) === pathKey(childFile),
		);
		if (!found) return { dependencySessionIds };
		let latestName: unknown;
		for (const entry of parentHistory.branch) if (entry.type === "session_info") latestName = entry.name;
		const name = projectSessionHoverTask(latestName, parentFile);
		return {
			dependencySessionIds,
			parent: {
				sessionId: parentId,
				sessionFile: parentFile,
				cwd: parentHistory.cwd,
				...(name ? { name } : {}),
			},
		};
	} catch {
		return { dependencySessionIds };
	}
}

/** 收集、合并与文件验证在分页前完成，revision 只由完整有序集合产生。 */
/** 后台批次实时快照（后台管理器为真源）；补出通知尚未落盘的排队项。 */
export type ResolveBackgroundBatch = (runId: string) => PerchoSubagentNotificationDetails | null;

function notificationChildStatus(
	status: PerchoSubagentNotificationRun["status"],
): SessionHoverRelationChild["status"] {
	return status === "running" || status === "queued" ? "running" : status === "done" ? "done" : "error";
}

export async function projectHoverRelations(
	history: HoverHistorySnapshot,
	liveRuns: SessionHoverLiveRun[],
	offset: number,
	parent?: SessionHoverRelationParent,
	resolveBackgroundBatch?: ResolveBackgroundBatch,
): Promise<SessionHoverRelations | undefined> {
	const safeRecords = collectRelationRecords(history.branch, history.sessionId, history.sessionFile);
	let plugin: Awaited<ReturnType<typeof resolvePiSubagentRelations>>;
	try {
		plugin = await resolvePiSubagentRelations(
			history.branch,
			{
				cwd: history.cwd,
				sessionFile: history.sessionFile,
			},
			{},
			safeRecords.map(({ entryId, record }) => ({ entryId, record })),
		);
	} catch (error) {
		return fail(error instanceof PiSubagentRelationLimitError ? "limit_exceeded" : "read_failed");
	}
	const children: Array<{
		child: SessionHoverRelationChild;
		order: number;
		finishedAt: number;
		toolCallId: string;
	}> = [];
	for (const { entryId, record, anchorIndex } of safeRecords) {
		if (record.toolName === "Agent") {
			const child = plugin.byEntryId.get(entryId);
			if (child)
				children.push({
					child,
					order: anchorIndex,
					finishedAt: record.finishedAt,
					toolCallId: record.toolCallId,
				});
		}
	}
	for (const { record, anchorIndex } of safeRecords) {
		if (record.toolName === "subagent") {
			for (const run of record.runs ?? []) {
				const idMatch = /_([0-9a-fA-F-]{8,})\.jsonl$/i.exec(run.sessionFile);
				const taskFirstLine = projectSessionHoverTask(run.taskFirstLine, run.sessionFile);
				children.push({
					child: {
						sessionFile: run.sessionFile,
						...(idMatch?.[1] ? { sessionId: idMatch[1] } : {}),
						agent: projectSessionHoverAgent(run.agent, run.sessionFile),
						...(taskFirstLine !== undefined ? { taskFirstLine } : {}),
						status: run.exitCode === undefined ? "unknown" : run.exitCode === 0 ? "done" : "error",
						createdAt: record.startedAt,
					},
					order: anchorIndex,
					finishedAt: record.finishedAt,
					toolCallId: record.toolCallId,
				});
			}
		}
	}
	// 后台派工回执里排队项没有会话文件（起跑才分配）：记下锚点，等终态通知 / 实时快照带着文件补进来
	const backgroundAnchors = new Map<string, { order: number; createdAt: number; toolCallId: string }>();
	const applyBackgroundNotification = (notif: PerchoSubagentNotificationDetails) => {
		const anchor = backgroundAnchors.get(notif.runId);
		for (const item of notif.runs) {
			if (!item.sessionFile) continue;
			const status = notificationChildStatus(item.status);
			const target = children.find((c) => c.child.sessionFile === item.sessionFile);
			if (target) {
				target.child = { ...target.child, status };
				continue;
			}
			if (!anchor) continue;
			const idMatch = /_([0-9a-fA-F-]{8,})\.jsonl$/i.exec(item.sessionFile);
			children.push({
				child: {
					sessionFile: item.sessionFile,
					...(idMatch?.[1] ? { sessionId: idMatch[1] } : {}),
					agent: projectSessionHoverAgent(item.agent, item.sessionFile),
					status,
					...(Number.isFinite(anchor.createdAt) ? { createdAt: anchor.createdAt } : {}),
				},
				order: anchor.order,
				finishedAt: Number.isFinite(anchor.createdAt) ? anchor.createdAt : 0,
				toolCallId: anchor.toolCallId,
			});
		}
	};
	for (const entry of history.branch) {
		if (entry.type === "custom_message" && entry.customType === PERCHO_SUBAGENT_NOTIFICATION_TYPE) {
			const notif = parsePerchoSubagentNotification(entry.details);
			if (notif) applyBackgroundNotification(notif);
			continue;
		}
		if (entry.type !== "message" || !object(entry.message) || entry.message.role !== "toolResult") continue;
		const pluginChild = plugin.byEntryId.get(entry.id);
		if (pluginChild) {
			children.push({
				child: pluginChild,
				order: history.branch.indexOf(entry),
				finishedAt: Number(entry.timestamp) || 0,
				toolCallId: entry.id,
			});
			continue;
		}
		let runs: ReturnType<typeof extractSubagentRuns>;
		try {
			runs = extractSubagentRuns(entry.message.details);
		} catch {
			continue;
		}
		const createdAt =
			typeof entry.timestamp === "number"
				? entry.timestamp
				: typeof entry.timestamp === "string"
					? Date.parse(entry.timestamp)
					: NaN;
		for (const run of runs ?? []) {
			if (run.background && run.runId && !backgroundAnchors.has(run.runId)) {
				backgroundAnchors.set(run.runId, {
					order: history.branch.indexOf(entry),
					createdAt,
					toolCallId: entry.id,
				});
			}
			if (!run.sessionFile) continue;
			const idMatch = /_([0-9a-fA-F-]{8,})\.jsonl$/i.exec(run.sessionFile);
			const taskFirstLine = projectSessionHoverTask(run.task, run.sessionFile);
			// 持久化里的 running/queued 只是派工回执（后台批次的终态靠后续通知）：没有通知就无法证明仍在跑
			// （应用退出/崩溃后批次已不存在），投影为 unknown；父会话已加载时由 committed 实时项覆盖真实状态。
			const status: SessionHoverRelationChild["status"] =
				run.status === "running" || run.status === "queued"
					? "unknown"
					: run.status === "aborted"
						? "error"
						: run.exitCode == null || !Number.isFinite(run.exitCode)
							? "unknown"
							: run.exitCode === 0
								? "done"
								: "error";
			children.push({
				child: {
					sessionFile: run.sessionFile,
					...(idMatch?.[1] ? { sessionId: idMatch[1] } : {}),
					agent: projectSessionHoverAgent(run.agent, run.sessionFile),
					...(taskFirstLine !== undefined ? { taskFirstLine } : {}),
					status,
					...(Number.isFinite(createdAt) ? { createdAt } : {}),
				},
				order: history.branch.indexOf(entry),
				finishedAt: Number.isFinite(createdAt) ? createdAt : 0,
				toolCallId: entry.id,
			});
		}
	}
	if (resolveBackgroundBatch) {
		for (const runId of backgroundAnchors.keys()) {
			const live = resolveBackgroundBatch(runId);
			if (live) applyBackgroundNotification(live);
		}
	}
	children.sort(
		(a, b) => a.order - b.order || a.finishedAt - b.finishedAt || a.toolCallId.localeCompare(b.toolCallId),
	);
	const merged = mergeLiveRelations(
		children.map(({ child }) => child),
		liveRuns,
	);
	const valid: SessionHoverRelationChild[] = [];
	for (let i = 0; i < merged.length; i += 16) {
		const batch = await Promise.all(
			merged.slice(i, i + 16).map(async (item) => {
				const file = plugin.validatedFiles.has(pathKey(item.sessionFile))
					? await validateOrdinarySessionFile(item.sessionFile)
					: await validateSubagentSessionFile(item.sessionFile);
				return file ? { ...item, sessionFile: file } : undefined;
			}),
		);
		for (const item of batch) if (item) valid.push(item);
	}
	if (!valid.length && !parent) return undefined;
	const hash = createHash("sha256");
	for (const item of valid) {
		hash.update(
			JSON.stringify([
				item.sessionId ?? null,
				item.sessionFile,
				item.agent,
				item.taskFirstLine ?? null,
				item.status,
				item.createdAt ?? null,
			]),
		);
		hash.update("\n");
	}
	const roleCounts = aggregateRoleCounts(valid);
	const page = valid.slice(offset, offset + SESSION_HOVER_PAGE_SIZE);
	return {
		children: page,
		roleCounts,
		hidden: Math.max(0, valid.length - offset - page.length),
		offset,
		total: valid.length,
		revision: hash.digest("hex"),
		...(parent ? { parent } : {}),
	};
}
