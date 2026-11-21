import { messagesToUIMessages, type SessionHistoryWindow, type SessionNavigationEntry } from "@percho/shared";
import { useSyncExternalStore } from "react";
import { getPi } from "../api";
import { useTranscriptStore } from "./transcript";

/** 历史就绪不是「收过实时事件」：打开中 agent 可抢先创建一个不完整 transcript。 */
const ready = new Set<string>();
const pending = new Map<string, { generation: number; isOpen: () => boolean }>();
const inFlight = new Map<string, number>();
const olderTasks = new Map<string, Promise<boolean>>();
const historyWindows = new Map<string, SessionHistoryWindow>();
const historyListeners = new Set<() => void>();

function subscribeHistory(listener: () => void): () => void {
	historyListeners.add(listener);
	return () => historyListeners.delete(listener);
}

export function getSessionHistoryWindow(sessionId: string | null): SessionHistoryWindow | undefined {
	return sessionId ? historyWindows.get(sessionId) : undefined;
}

export function useSessionHistoryWindow(sessionId: string | null): SessionHistoryWindow | undefined {
	return useSyncExternalStore(subscribeHistory, () => getSessionHistoryWindow(sessionId));
}

function notifyHistory(): void {
	for (const listener of historyListeners) listener();
}
let generation = 0;
let fallbackGeneration = 0;
const openEpoch = new Map<string, number>();

/** 关闭同 ID 会话后再次打开时，旧 IPC 响应不得落入新实例。 */
export function historyOpenEpoch(sessionId: string): number {
	return openEpoch.get(sessionId) ?? 0;
}

export function isHistoryReady(sessionId: string): boolean {
	return ready.has(sessionId);
}

export function hasPendingSessionHistory(sessionId: string): boolean {
	return pending.has(sessionId);
}

export function clearSessionHistory(sessionId: string): void {
	openEpoch.set(sessionId, historyOpenEpoch(sessionId) + 1);
	ready.delete(sessionId);
	pending.delete(sessionId);
	inFlight.delete(sessionId);
	olderTasks.delete(sessionId);
	if (historyWindows.delete(sessionId)) notifyHistory();
	// 旧请求靠 generation 复核；新一轮可以独立发请求，不被旧实例的迟到 IPC 堵住。
}

export function setSessionHistoryWindow(sessionId: string, window: SessionHistoryWindow): void {
	historyWindows.set(sessionId, window);
	notifyHistory();
}

function isOversizedHistoryPage(error: unknown): boolean {
	return String(error).includes("HISTORY_PAGE_TOO_LARGE");
}

async function loadFullHistoryFallback(sessionId: string): Promise<SessionHistoryWindow> {
	const messages = await getPi().getSessionMessages({ sessionId });
	return {
		messages,
		hasOlder: false,
		startIndex: 0,
		generation: `fallback:${sessionId}:${++fallbackGeneration}`,
	};
}

export async function requestSessionHistoryWindow(sessionId: string): Promise<SessionHistoryWindow> {
	const pi = getPi() as ReturnType<typeof getPi> & {
		getSessionHistoryWindow?: (request: { sessionId: string }) => Promise<SessionHistoryWindow>;
	};
	if (!pi.getSessionHistoryWindow) return loadFullHistoryFallback(sessionId);
	try {
		return await pi.getSessionHistoryWindow({ sessionId });
	} catch (error) {
		if (!isOversizedHistoryPage(error)) throw error;
		console.warn("历史首屏包含超预算 turn，回退到兼容的全量读取");
		return loadFullHistoryFallback(sessionId);
	}
}

export function historyWindowMessages(window: SessionHistoryWindow) {
	return messagesToUIMessages(window.messages).map((message) => ({
		...message,
		id: `history:${window.generation}:${window.startIndex}:${message.id}`,
	}));
}

async function restoreOversizedHistoryPage(
	sessionId: string,
	previous: SessionHistoryWindow,
	requestGeneration: number,
	isOpen: () => boolean,
	beforePrepend?: () => void,
): Promise<boolean> {
	try {
		const fullHistory = await loadFullHistoryFallback(sessionId);
		const first = previous.messages[0];
		const firstEntryId = first && "entryId" in first ? first.entryId : undefined;
		if (!first || !firstEntryId) {
			console.warn("超预算历史回退缺少首条消息的定位标识");
			return false;
		}
		const boundary = fullHistory.messages.findIndex(
			(message) => message.role === first.role && "entryId" in message && message.entryId === firstEntryId,
		);
		if (boundary < 0) {
			console.warn("超预算历史回退未找到当前历史的起点");
			return false;
		}
		const fallback = { ...fullHistory, messages: fullHistory.messages.slice(0, boundary) };
		if (
			inFlight.get(sessionId) !== requestGeneration ||
			historyWindows.get(sessionId) !== previous ||
			!isOpen()
		) {
			return false;
		}
		beforePrepend?.();
		if (fallback.messages.length > 0) {
			useTranscriptStore.getState().prependHistory(sessionId, historyWindowMessages(fallback));
		}
		setSessionHistoryWindow(sessionId, { ...fallback, generation: previous.generation });
		return true;
	} catch (error) {
		console.warn("超预算历史回退读取失败", error);
		return false;
	}
}

/** Load and prepend one older page; stale responses never cross a reset or session switch. */
export async function loadOlderSessionHistory(
	sessionId: string,
	isOpen: () => boolean,
	beforePrepend?: () => void,
): Promise<boolean | null> {
	if (inFlight.has(sessionId)) return null;
	const work = prependOlderPage(sessionId, isOpen, beforePrepend);
	olderTasks.set(sessionId, work);
	try {
		return await work;
	} finally {
		if (olderTasks.get(sessionId) === work) olderTasks.delete(sessionId);
	}
}

async function prependOlderPage(
	sessionId: string,
	isOpen: () => boolean,
	beforePrepend?: () => void,
): Promise<boolean> {
	const previous = historyWindows.get(sessionId);
	if (!previous?.hasOlder || !previous.cursor || !isOpen()) return false;
	const requestGeneration = ++generation;
	inFlight.set(sessionId, requestGeneration);
	try {
		const next = await getPi().getSessionHistoryPage({ sessionId, cursor: previous.cursor });
		if (
			inFlight.get(sessionId) !== requestGeneration ||
			historyWindows.get(sessionId) !== previous ||
			!isOpen()
		) {
			return false;
		}
		if (next.generation !== previous.generation || next.startIndex >= previous.startIndex) return false;
		beforePrepend?.();
		useTranscriptStore.getState().prependHistory(sessionId, historyWindowMessages(next));
		setSessionHistoryWindow(sessionId, next);
		return true;
	} catch (error) {
		if (isOversizedHistoryPage(error)) {
			return await restoreOversizedHistoryPage(sessionId, previous, requestGeneration, isOpen, beforePrepend);
		}
		console.warn("加载更早的会话历史失败", error);
		return false;
	} finally {
		if (inFlight.get(sessionId) === requestGeneration) inFlight.delete(sessionId);
	}
}

export async function loadSessionNavigation(
	sessionId: string,
	generation: string,
): Promise<SessionNavigationEntry[] | null> {
	try {
		return await getPi().getSessionNavigation({ sessionId, generation });
	} catch (error) {
		// An old host or a replaced snapshot must not prevent navigation among loaded rows.
		console.warn("读取会话导航索引失败", error);
		return null;
	}
}

/** Load until the target is a real UI row; cancellation prevents committing a late page. */
export async function loadHistoryThrough(
	sessionId: string,
	entryId: string,
	isCurrent: () => boolean,
): Promise<boolean> {
	while (isCurrent()) {
		const messages = useTranscriptStore.getState().bySession[sessionId]?.messages;
		if (messages?.some((message) => message.kind === "user" && message.entryId === entryId)) return true;
		const pendingPage = olderTasks.get(sessionId);
		if (pendingPage) {
			// A scroll/jump may have been cancelled by this newer intent. Let its IPC settle,
			// then retry with our own validity predicate instead of racing the same cursor.
			await pendingPage;
			continue;
		}
		if (!(await loadOlderSessionHistory(sessionId, isCurrent))) return false;
	}
	return false;
}

/** 只在首屏历史真正落到 UI 后发 ACK；失败的 ACK 由 backend 有限等待兜底。 */
export function finishSessionHistory(sessionId: string): void {
	pending.delete(sessionId);
	ready.add(sessionId);
	void getPi()
		.markSessionHistoryReady({ sessionId })
		.catch((error: unknown) => {
			console.warn("会话历史就绪回执失败", error);
		});
}

/** 活跃 run 时不能用静态快照覆盖流式态，记录待补历史，idle / settled 后拉最新快照。 */
export function deferSessionHistory(sessionId: string, isOpen: () => boolean): void {
	if (ready.has(sessionId)) return;
	pending.set(sessionId, { generation: ++generation, isOpen });
	void retrySessionHistory(sessionId);
}

export async function retrySessionHistory(sessionId: string): Promise<void> {
	const work = pending.get(sessionId);
	if (!work || inFlight.get(sessionId) === work.generation || !work.isOpen()) return;
	if (useTranscriptStore.getState().bySession[sessionId]?.agentActive) return;
	inFlight.set(sessionId, work.generation);
	let stale = false;
	try {
		// 快照必须重新读取：先前被丢弃的那一份可能不含刚结束的 run。
		const before = useTranscriptStore.getState().bySession[sessionId];
		const history = await requestSessionHistoryWindow(sessionId);
		const after = useTranscriptStore.getState().bySession[sessionId];
		if (pending.get(sessionId)?.generation !== work.generation || !work.isOpen()) {
			stale = true;
			return;
		}
		if (after?.agentActive || before !== after) {
			stale = !after?.agentActive; // 刚结束的新事件已进 UI：重新取一份，不复用旧快照
			return;
		}
		useTranscriptStore.getState().loadHistory(sessionId, historyWindowMessages(history));
		setSessionHistoryWindow(sessionId, history);
		finishSessionHistory(sessionId);
	} catch (error) {
		console.warn("会话历史补拉失败，等待下次重试", error);
	} finally {
		if (inFlight.get(sessionId) === work.generation) inFlight.delete(sessionId);
		if (stale && pending.has(sessionId)) void retrySessionHistory(sessionId);
	}
}
