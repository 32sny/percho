import {
	composerDocumentText,
	readComposerDocument,
	type SessionHoverLiveRun,
	type SessionHoverPreviewResult,
	safeUserFirstLine,
} from "@percho/shared";
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
	type TreeEntry,
} from "./hover-history";
import { projectHoverRelations, type ResolveBackgroundBatch, resolveHoverParent } from "./hover-relations";

/** 只接受非空字符串：模型字段不能把用户内容/未校验对象当成模型名。 */
function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text ? text : undefined;
}

/**
 * 当前分支最后一次有效模型。真实会话格式是 `model_change` entry（provider + modelId）；
 * 旧会话没有该 entry 时，兼容回退到最后一条 assistant 消息的 provider + model。
 */
function branchModel(branch: readonly TreeEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "model_change") continue;
		const provider = nonEmpty(entry.provider);
		const modelId = nonEmpty(entry.modelId);
		if (provider && modelId) return `${provider}/${modelId}`;
	}
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message" || !object(entry.message)) continue;
		if (entry.message.role !== "assistant") continue;
		const provider = nonEmpty(entry.message.provider);
		const model = nonEmpty(entry.message.model);
		if (provider && model) return `${provider}/${model}`;
	}
	return undefined;
}

function firstQuestion(history: HoverHistorySnapshot): SessionHoverPreviewResult {
	const sessionId = history.sessionId;
	for (const entry of history.branch) {
		if (entry.type !== "message" || !object(entry.message) || entry.message.role !== "user") continue;
		const document = readComposerDocument(entry.message);
		const line = safeUserFirstLine(document ? composerDocumentText(document) : entry.message.content);
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
	resolveBackgroundBatch?: ResolveBackgroundBatch,
): Promise<SessionHoverPreviewResult> {
	let dependencySessionIds: string[] = [];
	try {
		if (!Number.isSafeInteger(offset) || offset < 0) fail("identity_mismatch");
		const history = await load();
		const parent = await resolveHoverParent(history, getLoadedSession);
		dependencySessionIds = parent.dependencySessionIds;
		const relations = await projectHoverRelations(
			history,
			liveRuns,
			offset,
			parent.parent,
			resolveBackgroundBatch,
		);
		const model = branchModel(history.branch);
		return {
			...firstQuestion(history),
			...(model ? { model } : {}),
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
	resolveBackgroundBatch?: ResolveBackgroundBatch,
): Promise<SessionHoverPreviewResult> {
	return queryPreview(
		sessionId,
		() => readLoadedHoverHistory(sessionId, cwd, registeredCwd, manager),
		liveRuns,
		offset,
		"invalid_history",
		getLoadedSession,
		resolveBackgroundBatch,
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
