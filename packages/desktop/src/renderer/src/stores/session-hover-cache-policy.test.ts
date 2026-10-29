import type { SessionHoverPreviewRequest, SessionHoverPreviewResult } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionHoverPreviewCache, sessionHoverPreviewKey } from "./session-hover-preview";

const target = { sessionId: "child", cwd: "C:/project", messageCount: 2, modifiedAt: 1 };
const result = (linked = true): SessionHoverPreviewResult => ({
	status: "empty",
	sessionId: "child",
	dependencySessionIds: ["parent"],
	...(linked
		? {
				relations: {
					children: [],
					hidden: 0,
					parent: { sessionId: "parent", cwd: "C:/project", sessionFile: "C:/project/p.jsonl" },
				},
			}
		: {}),
});
const flush = () => vi.advanceTimersByTimeAsync(0);
function gate<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(100_000);
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("父依赖失效", () => {
	it.each([true, false])("父变动刷新正/负子关系缓存（原先关联=%s）", async (linked) => {
		const fetch = vi.fn(async () => result(linked));
		const cache = createSessionHoverPreviewCache(fetch);
		cache.setTarget(target);
		await flush();
		linked = !linked;
		cache.invalidate("parent");
		await flush();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(!!cache.getSnapshot()?.result?.relations?.parent).toBe(linked);
		cache.setTarget(null);
	});
	it("首次在途时还不知道父依赖，也不能回填父变动前的结果", async () => {
		const old = gate<SessionHoverPreviewResult>();
		const fetch = vi
			.fn<(_: SessionHoverPreviewRequest) => Promise<SessionHoverPreviewResult>>()
			.mockReturnValueOnce(old.promise)
			.mockResolvedValue(result(false));
		const cache = createSessionHoverPreviewCache(fetch);
		cache.setTarget(target);
		cache.invalidate("parent");
		expect(fetch).toHaveBeenCalledTimes(1);
		old.resolve(result(true));
		await flush();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(cache.getSnapshot()?.result?.relations?.parent).toBeUndefined();
		cache.setTarget(null);
	});
	it("无关会话变动不丢弃首次在途结果", async () => {
		const old = gate<SessionHoverPreviewResult>();
		const fetch = vi.fn().mockReturnValue(old.promise);
		const cache = createSessionHoverPreviewCache(fetch);
		cache.setTarget(target);
		cache.invalidateMany(["other", "unrelated"]);
		old.resolve(result());
		await flush();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(cache.getSnapshot()?.result?.relations?.parent?.sessionId).toBe("parent");
		cache.setTarget(null);
	});
	it("在途变动 ID 超过预算时保守丢弃，不无限保留变动集合", async () => {
		const old = gate<SessionHoverPreviewResult>();
		const fetch = vi
			.fn<(_: SessionHoverPreviewRequest) => Promise<SessionHoverPreviewResult>>()
			.mockReturnValueOnce(old.promise)
			.mockResolvedValue(result(false));
		const cache = createSessionHoverPreviewCache(fetch);
		cache.setTarget(target);
		cache.invalidateMany(Array.from({ length: 1025 }, (_, i) => `changed-${i}`));
		old.resolve(result());
		await flush();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(cache.getSnapshot()?.result?.relations?.parent).toBeUndefined();
		cache.setTarget(null);
	});
	it("兼容旧正向 parent 字段的依赖识别", async () => {
		const legacy = result();
		delete legacy.dependencySessionIds;
		const fetch = vi.fn(async () => legacy);
		const cache = createSessionHoverPreviewCache(fetch);
		cache.setTarget(target);
		await flush();
		cache.invalidate("parent");
		await flush();
		expect(fetch).toHaveBeenCalledTimes(2);
		cache.setTarget(null);
	});
	it("父依赖的全部缓存页一次批量失效，不主动重开已关闭卡片", async () => {
		const fetch = vi.fn(async () => result());
		const cache = createSessionHoverPreviewCache(fetch);
		cache.setTarget(target);
		await flush();
		cache.setTarget({ ...target, childrenOffset: 6 });
		await flush();
		cache.setTarget(null);
		cache.invalidateMany(["parent", "parent"]);
		expect(fetch).toHaveBeenCalledTimes(2);
		cache.setTarget(target);
		await flush();
		cache.setTarget({ ...target, childrenOffset: 6 });
		await flush();
		expect(fetch).toHaveBeenCalledTimes(4);
		cache.setTarget(null);
	});
});

describe("缓存体积与紧凑身份", () => {
	it("合法大任务不进入key，任一语义字段变化仍能区分", () => {
		const run = {
			sessionFile: "C:/project/c.jsonl",
			agent: "Explore",
			task: "SECRET_TASK_" + "x".repeat(128 * 1024 - 12),
			status: "done" as const,
			exitCode: 0,
			source: "committed" as const,
		};
		const base = { ...target, liveRuns: [run] };
		const key = sessionHoverPreviewKey(base);
		expect(key.length).toBeLessThan(300);
		expect(key).not.toContain("SECRET_TASK_");
		expect(sessionHoverPreviewKey({ ...base, liveRuns: [{ ...run }] })).toBe(key);
		for (const patch of [
			{ task: "different" },
			{ agent: "fixer" },
			{ exitCode: 1 },
			{ status: "error" as const },
			{ source: "streaming" as const },
			{ sessionFile: "C:/other.jsonl" },
		]) {
			expect(sessionHoverPreviewKey({ ...base, liveRuns: [{ ...run, ...patch }] })).not.toBe(key);
		}
	});
	it("按总计费字节淘汰，而不仅是条目数", async () => {
		const fetch = vi.fn(
			async ({ sessionId }: SessionHoverPreviewRequest): Promise<SessionHoverPreviewResult> => ({
				status: "ok",
				sessionId,
				source: "current-branch-first-user-text",
				text: "x".repeat(200),
			}),
		);
		const cache = createSessionHoverPreviewCache(fetch, { maxBytes: 1600 });
		for (const id of ["a", "b", "c", "d"]) {
			cache.setTarget({ ...target, sessionId: id });
			await flush();
		}
		expect(cache.getCacheStats().bytes).toBeLessThanOrEqual(1600);
		expect(cache.getCacheStats().entries).toBeLessThan(4);
		cache.setTarget(null);
	});
	it("超大响应当前仍可显示，不进入LRU且不立即无限重读，关闭释放", async () => {
		const large: SessionHoverPreviewResult = {
			status: "ok",
			sessionId: "child",
			source: "current-branch-first-user-text",
			text: "x".repeat(2000),
		};
		const fetch = vi.fn(async () => large);
		const cache = createSessionHoverPreviewCache(fetch, { maxBytes: 512 });
		cache.setTarget(target);
		await flush();
		expect(cache.getSnapshot()?.result).toEqual(large);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(cache.getCacheStats().entries).toBe(0);
		expect(cache.getCacheStats().transientBytes).toBeGreaterThan(512);
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetch).toHaveBeenCalledTimes(1);
		cache.setTarget(null);
		expect(cache.getCacheStats().transientBytes).toBe(0);
	});
	it("迟到的超大响应不为另一目标保留临时大对象", async () => {
		const old = gate<SessionHoverPreviewResult>();
		const fetch = vi
			.fn<(_: SessionHoverPreviewRequest) => Promise<SessionHoverPreviewResult>>()
			.mockReturnValueOnce(old.promise)
			.mockResolvedValue({ status: "empty", sessionId: "other" });
		const cache = createSessionHoverPreviewCache(fetch, { maxBytes: 512 });
		cache.setTarget(target);
		cache.setTarget({ ...target, sessionId: "other" });
		old.resolve({
			status: "ok",
			sessionId: "child",
			source: "current-branch-first-user-text",
			text: "x".repeat(2000),
		});
		await flush();
		expect(cache.getSnapshot()?.result?.sessionId).toBe("other");
		expect(cache.getCacheStats().transientBytes).toBe(0);
		cache.setTarget(null);
	});
});
