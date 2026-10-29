import type { SessionHoverPreviewRequest, SessionHoverPreviewResult } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionHoverPreviewCache } from "../../stores/session-hover-preview";
import { createSessionHoverPager } from "./useSessionHoverPages";

const target = (sessionId = "parent") => ({ sessionId, cwd: "/project", messageCount: 2, modifiedAt: 1 });
function page(request: SessionHoverPreviewRequest, revision = "r1"): SessionHoverPreviewResult {
	const offset = request.childrenOffset ?? 0;
	const count = Math.min(6, 9 - offset);
	return {
		status: "empty",
		sessionId: request.sessionId,
		relations: {
			children: Array.from({ length: count }, (_, i) => ({
				sessionFile: `/${request.sessionId}/child-${offset + i}.jsonl`,
				agent: "Explore",
				status: "done",
			})),
			offset,
			total: 9,
			hidden: Math.max(0, 9 - offset - count),
			revision,
		},
	};
}
function gate<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
const cleanups: (() => void)[] = [];
function setup(fetch = vi.fn(async (r: SessionHoverPreviewRequest) => page(r))) {
	const cache = createSessionHoverPreviewCache(fetch);
	const pager = createSessionHoverPager(cache);
	cleanups.push(pager.connect());
	pager.setTarget(target());
	return { cache, pager, fetch };
}
const count = (pager: ReturnType<typeof createSessionHoverPager>) =>
	pager.getSnapshot().preview?.relations?.children.length;
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
});
afterEach(() => {
	for (const off of cleanups.splice(0)) off();
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("悬停分页控制器与实际单在途缓存", () => {
	it("只读首屏，点击一次追加其余三条，再收起到六条", async () => {
		const { pager, fetch } = setup();
		await flush();
		expect(count(pager)).toBe(6);
		pager.loadMore();
		expect(pager.getSnapshot().loadingMore).toBe(true);
		pager.loadMore(); // 连击不得多发
		await flush();
		expect(count(pager)).toBe(9);
		expect(pager.getSnapshot().preview?.relations?.hidden).toBe(0);
		pager.collapse();
		expect(count(pager)).toBe(6);
		expect(pager.getSnapshot().expanded).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("翻页期间收起，迟到后页不能自动再展开", async () => {
		const later = gate<SessionHoverPreviewResult>();
		const fetch = vi.fn(async (r: SessionHoverPreviewRequest) =>
			r.childrenOffset ? later.promise : page(r),
		);
		const { pager } = setup(fetch);
		await flush();
		pager.loadMore();
		pager.collapse();
		expect(count(pager)).toBe(6);
		later.resolve(page({ ...target(), childrenOffset: 6 }));
		await flush();
		expect(count(pager)).toBe(6);
		expect(pager.getSnapshot().expanded).toBe(false);
	});

	it("翻页失败保留前页，重试作废失败缓存并真正重发", async () => {
		let failed = false;
		const fetch = vi.fn(async (r: SessionHoverPreviewRequest) => {
			if (r.childrenOffset && !failed) {
				failed = true;
				throw new Error("temporary");
			}
			return page(r);
		});
		const { pager } = setup(fetch);
		await flush();
		pager.loadMore();
		await flush();
		expect(count(pager)).toBe(6);
		expect(pager.getSnapshot().moreError).toBe(true);
		pager.loadMore();
		await flush();
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(count(pager)).toBe(9);
		expect(pager.getSnapshot().moreError).toBe(false);
	});

	it("后页 revision 改变，清旧缓存回到新首屏，不循环拼接", async () => {
		let revision = "r1";
		const fetch = vi.fn(async (r: SessionHoverPreviewRequest) => {
			if (r.childrenOffset) revision = "r2";
			return page(r, revision);
		});
		const { pager } = setup(fetch);
		await flush();
		pager.loadMore();
		await flush();
		expect(count(pager)).toBe(6);
		expect(pager.getSnapshot().expanded).toBe(false);
		expect(pager.getSnapshot().preview?.relations?.revision).toBe("r2");
		expect(fetch.mock.calls.map(([r]) => r.childrenOffset ?? 0)).toEqual([0, 6, 0]);
		pager.loadMore();
		await flush();
		expect(count(pager)).toBe(9);
	});

	it("已完成后页过期或撤回失效，应刷新首屏而不是偷偷重取后页", async () => {
		const { cache, pager, fetch } = setup();
		await flush();
		pager.loadMore();
		await flush();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(count(pager)).toBe(6);
		expect(fetch.mock.calls.map(([r]) => r.childrenOffset ?? 0)).toEqual([0, 6, 0]);
		pager.loadMore();
		await flush();
		expect(count(pager)).toBe(9);
		cache.invalidate("parent");
		await flush();
		expect(count(pager)).toBe(6);
		expect(pager.getSnapshot().expanded).toBe(false);
	});

	it("换目标或关闭时旧页不能覆盖新卡，仍只有一个在途", async () => {
		const later = gate<SessionHoverPreviewResult>();
		const fetch = vi.fn(async (r: SessionHoverPreviewRequest) =>
			r.childrenOffset ? later.promise : page(r),
		);
		const { pager, cache } = setup(fetch);
		await flush();
		pager.loadMore();
		pager.setTarget(target("other"));
		expect(pager.getSnapshot().preview).toBeNull();
		expect(fetch).toHaveBeenCalledTimes(2);
		later.resolve(page({ ...target(), childrenOffset: 6 }));
		await flush();
		expect(pager.getSnapshot().preview?.sessionId).toBe("other");
		expect(count(pager)).toBe(6);
		cache.setTarget(null);
		expect(pager.getSnapshot().preview).toBeNull();
		pager.setTarget(target("other"));
		expect(count(pager)).toBe(6);
	});

	it("相同语义 target 不重置展开，也不重新请求", async () => {
		const { pager, fetch } = setup();
		await flush();
		pager.loadMore();
		await flush();
		pager.setTarget({ ...target() });
		expect(count(pager)).toBe(9);
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
