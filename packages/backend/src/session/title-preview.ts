import { type SessionHoverLiveRun, type SessionHoverPreviewResult, safeUserFirstLine } from "@percho/shared";
import {
	FIRST_LINE_BYTES,
	fail,
	type GetLoadedHoverSession,
	type HoverHistorySnapshot,
	type HoverSessionManager,
	object,
	PreviewFailure,
	type Reason,
	readFileHoverHistory,
	readLoadedHoverHistory,
} from "./hover-history";
import { projectHoverRelations, resolveHoverParent } from "./hover-relations";

function firstQuestion(history: HoverHistorySnapshot): SessionHoverPreviewResult {
	const sessionId = history.sessionId;
	for (const entry of history.branch) {
		if (entry.type !== "message" || !object(entry.message) || entry.message.role !== "user") continue;
		const line = safeUserFirstLine(entry.message.content);
		if (line.status === "empty") continue;
		if (line.status !== "ok") return { status: "unavailable", sessionId, reason: line.status };
		if (Buffer.byteLength(line.text, "utf8") > FIRST_LINE_BYTES)
			return { status: "unavailable", sessionId, reason: "limit_exceeded" };
		return { status: "ok", sessionId, source: "current-branch-first-user-text", text: line.text };
	}
	return { status: "empty", sessionId };
}

/** 查询入口只做编排：快照真值、关系投影、首条文本，各自保持独立失败边界。 */
async function queryPreview(
	sessionId: string,
	load: () => HoverHistorySnapshot | Promise<HoverHistorySnapshot>,
	liveRuns: SessionHoverLiveRun[],
	offset: number,
	fallback: Reason,
	getLoadedSession?: GetLoadedHoverSession,
): Promise<SessionHoverPreviewResult> {
	let dependencySessionIds: string[] = [];
	try {
		if (!Number.isSafeInteger(offset) || offset < 0) fail("identity_mismatch");
		const history = await load();
		const parent = await resolveHoverParent(history, getLoadedSession);
		dependencySessionIds = parent.dependencySessionIds;
		const relations = await projectHoverRelations(history, liveRuns, offset, parent.parent);
		return {
			...firstQuestion(history),
			...(relations ? { relations } : {}),
			...(dependencySessionIds.length ? { dependencySessionIds } : {}),
		};
	} catch (error) {
		return {
			status: "unavailable",
			sessionId,
			reason: error instanceof PreviewFailure ? error.reason : fallback,
			...(dependencySessionIds.length ? { dependencySessionIds } : {}),
		};
	}
}

export function previewLoadedSession(
	sessionId: string,
	cwd: string,
	registeredCwd: string,
	manager: HoverSessionManager,
	liveRuns: SessionHoverLiveRun[] = [],
	offset = 0,
	getLoadedSession?: GetLoadedHoverSession,
): Promise<SessionHoverPreviewResult> {
	return queryPreview(
		sessionId,
		() => readLoadedHoverHistory(sessionId, cwd, registeredCwd, manager),
		liveRuns,
		offset,
		"invalid_history",
		getLoadedSession,
	);
}

export function previewSessionFile(
	sessionId: string,
	cwd: string,
	file: string,
	offset = 0,
	getLoadedSession?: GetLoadedHoverSession,
): Promise<SessionHoverPreviewResult> {
	return queryPreview(
		sessionId,
		() => readFileHoverHistory(sessionId, cwd, file),
		[],
		offset,
		"read_failed",
		getLoadedSession,
	);
}
