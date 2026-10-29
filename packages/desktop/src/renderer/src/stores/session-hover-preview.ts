import type {
	SessionHoverLiveRun,
	SessionHoverPreviewRequest,
	SessionHoverPreviewResult,
	SessionMeta,
} from "@percho/shared";
import { getPi } from "../api";
import { hoverLiveFingerprint } from "./session-hover-key";

export type SessionHoverPreviewTarget = Pick<
	SessionMeta,
	"sessionId" | "cwd" | "modifiedAt" | "messageCount"
> & {
	liveRuns?: SessionHoverLiveRun[];
	childrenOffset?: number;
};
export interface SessionHoverPreviewSnapshot {
	readonly key: string;
	readonly result: SessionHoverPreviewResult | null;
}
type FetchPreview = (request: SessionHoverPreviewRequest) => Promise<SessionHoverPreviewResult>;
type Target = { key: string; meta: SessionHoverPreviewTarget };
type CacheEntry = {
	result: SessionHoverPreviewResult;
	dependencies: Set<string>;
	expiresAt: number;
	bytes: number;
};
type Flight = Target & { invalidated: boolean; changedIds: Set<string> };
const SUCCESS_TTL = 30_000;
const FAILURE_TTL = 5_000;
const MAX_PENDING_INVALIDATIONS = 1024;

export function sessionHoverPreviewKey(meta: SessionHoverPreviewTarget): string {
	return JSON.stringify([
		meta.sessionId,
		meta.cwd,
		meta.modifiedAt ?? null,
		meta.messageCount ?? null,
		hoverLiveFingerprint(meta.liveRuns),
		meta.childrenOffset && meta.childrenOffset > 0 ? meta.childrenOffset : null,
	]);
}

function dependenciesOf(result: SessionHoverPreviewResult): Set<string> {
	const ids = new Set([result.sessionId]);
	for (const id of result.dependencySessionIds ?? []) if (id) ids.add(id);
	if (result.relations?.parent) ids.add(result.relations.parent.sessionId);
	return ids;
}

/**
 * 100 项/8MiB 双预算 LRU + 一个在途槽。临时超限结果仅供当前目标显示，换目标即释放。
 * 计费字节是字符串序列化体积与固定条目开销的保守估算，不等于精确 JS 堆大小。
 */
export function createSessionHoverPreviewCache(
	fetchPreview: FetchPreview,
	{ maxBytes = 8 * 1024 * 1024, capacity = 100 }: { maxBytes?: number; capacity?: number } = {},
) {
	const entries = new Map<string, CacheEntry>();
	const listeners = new Set<() => void>();
	let bytes = 0;
	let target: Target | null = null;
	let flight: Flight | null = null;
	let snapshot: SessionHoverPreviewSnapshot | null = null;
	let transient: (CacheEntry & { key: string }) | null = null;
	let expiryTimer: ReturnType<typeof setTimeout> | undefined;

	function publish(next: SessionHoverPreviewSnapshot | null) {
		if (snapshot?.key === next?.key && snapshot?.result === next?.result) return;
		snapshot = next;
		for (const listener of listeners) listener();
	}
	function forget(key: string) {
		const entry = entries.get(key);
		if (entry) bytes -= entry.bytes;
		entries.delete(key);
	}
	function fresh(key: string): CacheEntry | undefined {
		const entry = entries.get(key);
		if (entry) {
			if (entry.expiresAt <= Date.now()) forget(key);
			else {
				entries.delete(key);
				entries.set(key, entry);
				return entry;
			}
		}
		if (transient?.key === key) {
			if (transient.expiresAt > Date.now()) return transient;
			transient = null;
		}
		return undefined;
	}
	function remember(key: string, result: SessionHoverPreviewResult, dependencies: Set<string>) {
		const now = Date.now();
		for (const [oldKey, entry] of entries) if (entry.expiresAt <= now) forget(oldKey);
		forget(key);
		const entry: CacheEntry = {
			result,
			dependencies,
			expiresAt: now + (result.status === "unavailable" ? FAILURE_TTL : SUCCESS_TTL),
			bytes: 256 + key.length * 2 + JSON.stringify(result).length * 2,
		};
		if (entry.bytes > maxBytes || capacity <= 0) {
			if (target?.key === key) transient = { ...entry, key };
			return;
		}
		entries.set(key, entry);
		bytes += entry.bytes;
		while (entries.size > capacity || bytes > maxBytes) {
			const oldest = entries.keys().next().value;
			if (oldest === undefined) break;
			forget(oldest);
		}
	}
	function reconcile(): void {
		clearTimeout(expiryTimer);
		expiryTimer = undefined;
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
		const job: Flight = { ...wanted, invalidated: false, changedIds: new Set() };
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
				if (result.sessionId !== job.meta.sessionId)
					result = { status: "unavailable", sessionId: job.meta.sessionId, reason: "identity_mismatch" };
				else if (result.status === "ok" && result.source !== "current-branch-first-user-text")
					result = { status: "unavailable", sessionId: job.meta.sessionId, reason: "unsafe_projection" };
			} catch {
				result = { status: "unavailable", sessionId: job.meta.sessionId, reason: "read_failed" };
			}
			const dependencies = dependenciesOf(result);
			const stale = job.invalidated || [...dependencies].some((id) => job.changedIds.has(id));
			if (!stale) remember(job.key, result, dependencies);
			flight = null;
			reconcile();
		})();
	}
	function invalidateMany(sessionIds?: readonly string[], refresh = true): void {
		const changed = sessionIds ? new Set(sessionIds) : undefined;
		if (changed?.size === 0) return;
		const affected = (entry: CacheEntry) => !changed || [...entry.dependencies].some((id) => changed.has(id));
		for (const [key, entry] of entries) if (affected(entry)) forget(key);
		if (transient && affected(transient)) transient = null;
		if (flight) {
			if (!changed || changed.has(flight.meta.sessionId)) flight.invalidated = true;
			else
				for (const id of changed) {
					flight.changedIds.add(id);
					if (flight.changedIds.size > MAX_PENDING_INVALIDATIONS) {
						flight.invalidated = true;
						flight.changedIds.clear();
						break;
					}
				}
		}
		if (refresh) reconcile();
	}

	return {
		getSnapshot: () => snapshot,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		setTarget(meta: SessionHoverPreviewTarget | null) {
			const key = meta ? sessionHoverPreviewKey(meta) : null;
			if (key !== target?.key) {
				transient = null;
				target =
					meta && key
						? {
								key,
								meta: {
									...meta,
									...(meta.liveRuns ? { liveRuns: meta.liveRuns.map((run) => ({ ...run })) } : {}),
								},
							}
						: null;
			}
			reconcile();
		},
		invalidate(sessionId?: string, refresh = true) {
			invalidateMany(sessionId === undefined ? undefined : [sessionId], refresh);
		},
		invalidateMany,
		getSessionIds(): string[] {
			const ids = new Set<string>();
			for (const entry of entries.values()) for (const id of entry.dependencies) ids.add(id);
			if (transient) for (const id of transient.dependencies) ids.add(id);
			if (flight) ids.add(flight.meta.sessionId);
			if (target) ids.add(target.meta.sessionId);
			return [...ids];
		},
		getCacheStats: () => ({ entries: entries.size, bytes, transientBytes: transient?.bytes ?? 0 }),
	};
}

export const sessionHoverPreview = createSessionHoverPreviewCache((request) =>
	getPi().getSessionHoverPreview(request),
);
