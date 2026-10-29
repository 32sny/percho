import {
	SESSION_HOVER_PAGE_SIZE,
	type SessionHoverPreviewResult,
	type SessionHoverRelationChild,
} from "@percho/shared";
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import {
	type createSessionHoverPreviewCache,
	type SessionHoverPreviewSnapshot,
	type SessionHoverPreviewTarget,
	sessionHoverPreview,
	sessionHoverPreviewKey,
} from "../../stores/session-hover-preview";

const PAGE_SIZE = SESSION_HOVER_PAGE_SIZE;
export interface SessionHoverPages {
	sourceKey: string;
	first: SessionHoverPreviewResult;
	children: SessionHoverRelationChild[];
	hidden: number;
	total: number;
	revision?: string;
	offset: number;
}

/** 只有完整同版、连续页才能追加；无 revision 的旧响应仅用于首屏。 */
export function mergeSessionHoverPage(
	before: SessionHoverPages | null,
	result: SessionHoverPreviewResult,
	sourceKey: string,
	offset: number,
): SessionHoverPages | null {
	const page = result.relations;
	const children = page?.children ?? [];
	const hidden = page?.hidden ?? 0;
	const total = page?.total ?? children.length + hidden;
	if (
		!Number.isSafeInteger(total) ||
		total < 0 ||
		!Number.isSafeInteger(hidden) ||
		hidden < 0 ||
		children.length > PAGE_SIZE ||
		(page?.offset !== undefined && page.offset !== offset)
	)
		return null;
	if (offset === 0) {
		if (hidden !== total - children.length) return null;
		return { sourceKey, first: result, children, hidden, total, revision: page?.revision, offset };
	}
	if (
		!before ||
		before.sourceKey !== sourceKey ||
		result.sessionId !== before.first.sessionId ||
		!page?.revision ||
		page.revision !== before.revision ||
		page.offset !== offset ||
		offset !== before.children.length ||
		page.total !== before.total ||
		children.length !== Math.min(PAGE_SIZE, Math.max(0, total - offset)) ||
		hidden !== Math.max(0, total - offset - children.length)
	)
		return null;
	const files = new Set(before.children.map((c) => c.sessionFile));
	for (const child of children) {
		if (files.has(child.sessionFile)) return null;
		files.add(child.sessionFile);
	}
	return { ...before, children: [...before.children, ...children], hidden, offset };
}

export function visibleSessionHoverChildren(state: SessionHoverPages | null, expanded: boolean) {
	if (!state) return { children: [] as SessionHoverRelationChild[], hidden: 0 };
	const children = expanded ? state.children : state.children.slice(0, PAGE_SIZE);
	return { children, hidden: Math.max(0, state.total - children.length) };
}

interface PageView {
	preview: SessionHoverPreviewResult | null;
	loadingMore: boolean;
	moreError: boolean;
	expanded: boolean;
}
const EMPTY: PageView = { preview: null, loadingMore: false, moreError: false, expanded: false };
type Cache = ReturnType<typeof createSessionHoverPreviewCache>;

/** 每张实际挂载的卡片一份页视图，所有网络请求仍通过原缓存的单在途槽。 */
export function createSessionHoverPager(cache: Cache) {
	let base: SessionHoverPreviewTarget | null = null;
	let sourceKey = "";
	let requestedKey = "";
	let offset = 0;
	let pages: SessionHoverPages | null = null;
	let view = EMPTY;
	let lastSnapshot: SessionHoverPreviewSnapshot | null = null;
	let preserveFirstPending = false;
	const listeners = new Set<() => void>();

	function publish(next: PageView) {
		if (
			next.preview === view.preview &&
			next.loadingMore === view.loadingMore &&
			next.moreError === view.moreError &&
			next.expanded === view.expanded
		)
			return;
		view = next;
		for (const listener of listeners) listener();
	}
	function display(loadingMore = false, moreError = false): PageView {
		if (!pages) return EMPTY;
		const expanded = offset > 0;
		const visible = visibleSessionHoverChildren(pages, expanded);
		return {
			preview: pages.first.relations
				? { ...pages.first, relations: { ...pages.first.relations, ...visible } }
				: pages.first,
			loadingMore,
			moreError,
			expanded,
		};
	}
	function request() {
		if (!base) return;
		const target = { ...base, childrenOffset: offset };
		requestedKey = sessionHoverPreviewKey(target);
		cache.setTarget(target);
		// 缓存命中同一个对象时不一定 publish；新挂载的 pager 仍须领取现有快照。
		onCache();
	}
	function resetToFirst() {
		if (!base) return;
		offset = 0;
		pages = null;
		preserveFirstPending = false;
		lastSnapshot = null;
		// 先失效不重发，避免在当前后页上递归发起多余请求。
		cache.invalidate(base.sessionId, false);
		request();
	}
	function clear() {
		base = null;
		sourceKey = "";
		requestedKey = "";
		offset = 0;
		pages = null;
		lastSnapshot = null;
		preserveFirstPending = false;
		publish(EMPTY);
	}
	function onCache() {
		if (!base) return;
		const snapshot = cache.getSnapshot();
		if (!snapshot) {
			clear();
			return;
		} // Provider 立即 dismiss，不得自行重新开卡
		if (snapshot.key !== requestedKey || snapshot === lastSnapshot) return;
		lastSnapshot = snapshot;
		const result = snapshot.result;
		if (!result) {
			if (offset > 0 && pages?.offset === offset) {
				resetToFirst(); // 已完成页变 pending = TTL/撤回/重载，不是新翻页
				return;
			}
			if (offset === 0 && !preserveFirstPending) pages = null;
			publish(offset > 0 ? display(true) : preserveFirstPending ? display() : EMPTY);
			return;
		}
		preserveFirstPending = false;
		if (offset > 0 && result.status === "unavailable" && !result.relations) {
			publish(display(false, true));
			return;
		}
		const merged = mergeSessionHoverPage(pages, result, sourceKey, offset);
		if (!merged && offset > 0) {
			resetToFirst();
			return;
		}
		pages = merged;
		publish(merged ? display() : { ...EMPTY, preview: { ...result, relations: undefined } });
	}

	return {
		getSnapshot: () => view,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		connect() {
			const off = cache.subscribe(onCache);
			return () => {
				off();
				clear();
				cache.setTarget(null);
			};
		},
		setTarget(target: SessionHoverPreviewTarget) {
			const first = { ...target, childrenOffset: 0 };
			const key = sessionHoverPreviewKey(first);
			if (base && key === sourceKey) return;
			base = first;
			sourceKey = key;
			offset = 0;
			pages = null;
			preserveFirstPending = false;
			lastSnapshot = null;
			publish(EMPTY);
			request();
		},
		loadMore() {
			if (!base || !pages || view.loadingMore || pages.hidden <= 0) return;
			if (!pages.revision) {
				publish(display(false, true));
				return;
			}
			offset = pages.children.length;
			preserveFirstPending = false;
			lastSnapshot = null;
			if (view.moreError) cache.invalidate(base.sessionId, false);
			request();
		},
		collapse() {
			if (!base || !pages) return;
			offset = 0;
			pages = mergeSessionHoverPage(null, pages.first, sourceKey, 0);
			preserveFirstPending = true;
			lastSnapshot = null;
			publish(display());
			request();
		},
	};
}

export function useSessionHoverPages(target: SessionHoverPreviewTarget) {
	const [pager] = useState(() => createSessionHoverPager(sessionHoverPreview));
	const view = useSyncExternalStore(pager.subscribe, pager.getSnapshot, pager.getSnapshot);
	useLayoutEffect(() => pager.connect(), [pager]);
	useLayoutEffect(() => {
		pager.setTarget(target);
	}, [pager, target]);
	return { ...view, loadMore: pager.loadMore, collapse: pager.collapse };
}
