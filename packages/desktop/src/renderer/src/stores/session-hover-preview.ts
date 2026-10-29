import type {
	SessionHoverLiveRun,
	SessionHoverPreviewRequest,
	SessionHoverPreviewResult,
	SessionMeta,
} from "@percho/shared";
import { getPi } from "../api";

export type SessionHoverPreviewTarget = Pick<
	SessionMeta,
	"sessionId" | "cwd" | "modifiedAt" | "messageCount"
> & { liveRuns?: SessionHoverLiveRun[]; childrenOffset?: number };
export interface SessionHoverPreviewSnapshot {
	readonly key: string;
	/** null = 当前目标等待/读取中；失败也使用 shared 的窄 DTO，不另造 IPC 结果类型。 */
	readonly result: SessionHoverPreviewResult | null;
}

type FetchPreview = (request: SessionHoverPreviewRequest) => Promise<SessionHoverPreviewResult>;
type Target = { key: string; meta: SessionHoverPreviewTarget };
type CacheEntry = { sessionId: string; result: SessionHoverPreviewResult; expiresAt: number };

const CAPACITY = 100;
const SUCCESS_TTL = 30_000;
const FAILURE_TTL = 5_000;

export function sessionHoverPreviewKey(meta: SessionHoverPreviewTarget): string {
	const runs = meta.liveRuns?.length
		? meta.liveRuns.map((run) => [
				run.sessionFile,
				run.agent,
				run.task ?? null,
				run.status,
				run.exitCode ?? null,
				run.source,
			])
		: null;
	return JSON.stringify([
		meta.sessionId,
		meta.cwd,
		meta.modifiedAt ?? null,
		meta.messageCount ?? null,
		runs,
		meta.childrenOffset && meta.childrenOffset > 0 ? meta.childrenOffset : null,
	]);
}

/**
 * 全侧栏的单消费者读模型：一份目标 + 一个在途槽，目标本身就是唯一的「最新待请求」。
 * 不为掠过的行创建 Promise 队列。旧请求可以入 LRU，但只由当前 key 发布；失效请求连缓存也不能回填。
 * snapshot 只在 key/result 真变时替换，供 useSyncExternalStore 使用，不在渲染阶段计算新对象。
 */
export function createSessionHoverPreviewCache(fetchPreview: FetchPreview) {
	const entries = new Map<string, CacheEntry>();
	const listeners = new Set<() => void>();
	let target: Target | null = null;
	let flight: (Target & { invalidated: boolean }) | null = null;
	let snapshot: SessionHoverPreviewSnapshot | null = null;
	let expiryTimer: ReturnType<typeof setTimeout> | undefined;

	function publish(next: SessionHoverPreviewSnapshot | null): void {
		if (snapshot?.key === next?.key && snapshot?.result === next?.result) return;
		snapshot = next;
		for (const listener of listeners) listener();
	}

	function clearExpiry(): void {
		clearTimeout(expiryTimer);
		expiryTimer = undefined;
	}

	function fresh(key: string): CacheEntry | undefined {
		const entry = entries.get(key);
		if (!entry) return undefined;
		entries.delete(key);
		if (entry.expiresAt <= Date.now()) return undefined;
		entries.set(key, entry); // 命中提升 LRU，但不延长绝对过期时间
		return entry;
	}

	function remember(key: string, result: SessionHoverPreviewResult): void {
		const now = Date.now();
		for (const [entryKey, entry] of entries) {
			if (entry.expiresAt <= now) entries.delete(entryKey);
		}
		entries.delete(key);
		entries.set(key, {
			sessionId: result.sessionId,
			result,
			expiresAt: now + (result.status === "unavailable" ? FAILURE_TTL : SUCCESS_TTL),
		});
		while (entries.size > CAPACITY) {
			const oldest = entries.keys().next().value;
			if (oldest !== undefined) entries.delete(oldest);
		}
	}

	function reconcile(): void {
		clearExpiry();
		const wanted = target;
		if (!wanted) {
			publish(null);
			return;
		}
		const cached = fresh(wanted.key);
		if (cached) {
			publish({ key: wanted.key, result: cached.result });
			if (target === wanted) expiryTimer = setTimeout(reconcile, Math.max(1, cached.expiresAt - Date.now()));
			return;
		}
		publish({ key: wanted.key, result: null });
		if (target !== wanted || flight) return;
		const job = { ...wanted, invalidated: false };
		flight = job;
		void (async () => {
			let result: SessionHoverPreviewResult;
			try {
				result = await fetchPreview({
					sessionId: job.meta.sessionId,
					cwd: job.meta.cwd,
					...(job.meta.liveRuns?.length ? { liveRuns: job.meta.liveRuns } : {}),
					...(job.meta.childrenOffset && job.meta.childrenOffset > 0
						? { childrenOffset: job.meta.childrenOffset }
						: {}),
				});
				if (result.sessionId !== job.meta.sessionId) {
					result = { status: "unavailable", sessionId: job.meta.sessionId, reason: "identity_mismatch" };
				} else if (result.status === "ok" && result.source !== "current-branch-first-user-text") {
					result = { status: "unavailable", sessionId: job.meta.sessionId, reason: "unsafe_projection" };
				}
			} catch {
				// 不把 IPC 内部错误或提问写进日志/toast；基本详情不受影响。
				result = { status: "unavailable", sessionId: job.meta.sessionId, reason: "read_failed" };
			}
			if (!job.invalidated) remember(job.key, result);
			flight = null;
			reconcile();
		})();
	}

	return {
		getSnapshot: () => snapshot,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		setTarget(meta: SessionHoverPreviewTarget | null): void {
			const key = meta ? sessionHoverPreviewKey(meta) : null;
			if (key !== target?.key) target = meta && key ? { key, meta: { ...meta } } : null;
			reconcile();
		},
		/** 删除/移动/撤回/重载：保留在途占位直至真正结束，不能伪取消后突破一个在途的预算。 */
		invalidate(sessionId?: string, refresh = true): void {
			for (const [key, entry] of entries) {
				if (sessionId === undefined || entry.sessionId === sessionId) entries.delete(key);
			}
			if (flight && (sessionId === undefined || flight.meta.sessionId === sessionId))
				flight.invalidated = true;
			if (refresh) reconcile();
		},
		/** 生命周期订阅只检查有缓存/请求的 id，最多 100 缓存 + 在途/当前目标，不遍历整份历史。 */
		getSessionIds(): string[] {
			const ids = new Set([...entries.values()].map((entry) => entry.sessionId));
			if (flight) ids.add(flight.meta.sessionId);
			if (target) ids.add(target.meta.sessionId);
			return [...ids];
		},
	};
}

export const sessionHoverPreview = createSessionHoverPreviewCache((request) =>
	getPi().getSessionHoverPreview(request),
);
