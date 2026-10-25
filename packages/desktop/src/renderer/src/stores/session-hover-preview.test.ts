import type { SessionHoverPreviewRequest, SessionHoverPreviewResult } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionHoverPreviewCache, sessionHoverPreviewKey } from "./session-hover-preview";

const target = (sessionId: string, modifiedAt = 100) => ({
	sessionId,
	cwd: "C:/project",
	modifiedAt,
	messageCount: 3,
});
const ok = (sessionId: string, text = `提问 ${sessionId}`): SessionHoverPreviewResult => ({
	status: "ok",
	sessionId,
	source: "current-branch-first-user-text",
	text,
});
const unavailable = (sessionId: string): SessionHoverPreviewResult => ({
	status: "unavailable",
	sessionId,
	reason: "read_failed",
});
function deferred<T>() {
	let resolve!: (result: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
const loader = () =>
	vi.fn<(request: SessionHoverPreviewRequest) => Promise<SessionHoverPreviewResult>>()
		.mockImplementation(async ({ sessionId }) => ok(sessionId));

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("悬停预览键与 single-flight", () => {
	it("键包含 id、cwd、modifiedAt、messageCount，缺失值不与 0 混用", () => {
		const base = target("A");
		const key = sessionHoverPreviewKey(base);
		for (const changed of [
			{ ...base, sessionId: "B" },
			{ ...base, cwd: "D:/project" },
			{ ...base, modifiedAt: 101 },
			{ ...base, messageCount: 4 },
			{ ...base, modifiedAt: undefined },
		]) {
			expect(sessionHoverPreviewKey(changed)).not.toBe(key);
		}
		expect(sessionHoverPreviewKey({ ...base, modifiedAt: undefined })).not.toBe(
			sessionHoverPreviewKey({ ...base, modifiedAt: 0 }),
		);
		expect(sessionHoverPreviewKey({ ...base, sessionId: "a|b", cwd: "c" })).not.toBe(
			sessionHoverPreviewKey({ ...base, sessionId: "a", cwd: "b|c" }),
		);
	});

	it("无打开目标时不查询；同键反复选择只发一个请求", async () => {
		const gate = deferred<SessionHoverPreviewResult>();
		const fetch = loader().mockReturnValue(gate.promise);
		const cache = createSessionHoverPreviewCache(fetch);
		expect(cache.getSnapshot()).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
		cache.setTarget(target("A"));
		const loading = cache.getSnapshot();
		cache.setTarget({ ...target("A") });
		expect(cache.getSnapshot()).toBe(loading);
		expect(fetch).toHaveBeenCalledExactlyOnceWith({ sessionId: "A", cwd: "C:/project" });
		gate.resolve(ok("A"));
		await flush();
		expect(cache.getSnapshot()?.result).toEqual(ok("A"));
	});

	it("全局一个在途，只保留最新待请求目标，不排队所有掠过条目", async () => {
		const first = deferred<SessionHoverPreviewResult>();
		const last = deferred<SessionHoverPreviewResult>();
		const fetch = loader().mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
		const cache = createSessionHoverPreviewCache(fetch);
		cache.setTarget(target("A"));
		cache.setTarget(target("B"));
		cache.setTarget(target("C"));
		cache.setTarget(target("D"));
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(cache.getSnapshot()).toEqual({ key: sessionHoverPreviewKey(target("D")), result: null });
		first.resolve(ok("A"));
		await flush();
		expect(fetch.mock.calls.map(([request]) => request.sessionId)).toEqual(["A", "D"]);
		expect(cache.getSnapshot()?.result).toBeNull(); // A 的迟到结果不能串进 D
		last.resolve(ok("D"));
		await flush();
		expect(cache.getSnapshot()?.result).toEqual(ok("D"));
	});

	it("A → B → A 复用仍在途的 A，B 不会被发出", async () => {
		const gate = deferred<SessionHoverPreviewResult>();
		const fetch = loader().mockReturnValue(gate.promise);
		const cache = createSessionHoverPreviewCache(fetch);
		cache.setTarget(target("A"));
		cache.setTarget(target("B"));
		cache.setTarget(target("A"));
		gate.resolve(ok("A"));
		await flush();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(cache.getSnapshot()?.result).toEqual(ok("A"));
	});

	it("关闭卡片移除待请求目标；已发请求可受控缓存但不能重新开卡", async () => {
		const gate = deferred<SessionHoverPreviewResult>();
		const fetch = loader().mockReturnValue(gate.promise);
		const cache = createSessionHoverPreviewCache(fetch);
		cache.setTarget(target("A"));
		cache.setTarget(target("B"));
		cache.setTarget(null);
		gate.resolve(ok("A"));
		await flush();
		expect(cache.getSnapshot()).toBeNull();
		expect(fetch).toHaveBeenCalledTimes(1);
		cache.setTarget(target("A"));
		expect(cache.getSnapshot()?.result).toEqual(ok("A"));
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("同 id 不同版本的迟到结果不能覆盖新版本", async () => {
		const old = deferred<SessionHoverPreviewResult>();
		const fetch = loader().mockReturnValueOnce(old.promise);
		const cache = createSessionHoverPreviewCache(fetch);
		cache.setTarget(target("A", 100));
		cache.setTarget(target("A", 200));
		old.resolve(ok("A", "旧分支"));
		await flush();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(cache.getSnapshot()).toEqual({
			key: sessionHoverPreviewKey(target("A", 200)),
			result: ok("A"),
		});
	});

	it("返回 sessionId 不匹配时只给 identity_mismatch，不泄漏另一会话文本", async () => {
		const cache = createSessionHoverPreviewCache(loader().mockResolvedValue(ok("other", "不能展示")));
		cache.setTarget(target("A"));
		await flush();
		expect(cache.getSnapshot()?.result).toEqual({
			status: "unavailable",
			sessionId: "A",
			reason: "identity_mismatch",
		});
	});
});

describe("缓存 TTL、LRU 与稳定订阅", () => {
	it.each(["ok", "empty"] as const)("%s 缓存 30 秒，命中不延长过期时间", async (status) => {
		const result: SessionHoverPreviewResult = status === "ok" ? ok("A") : { status, sessionId: "A" };
		const fetch = loader().mockResolvedValue(result);
		const cache = createSessionHoverPreviewCache(fetch);
		cache.setTarget(target("A"));
		await flush();
		cache.setTarget(null);
		await vi.advanceTimersByTimeAsync(29_999);
		cache.setTarget(target("A"));
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(cache.getSnapshot()?.result).toEqual(result);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetch).toHaveBeenCalledTimes(2); // 打开的卡片到期也刷新
	});

	it("失败只缓存 5 秒，IPC reject 降级为 inline read_failed", async () => {
		const fetch = loader().mockRejectedValue(new Error("不应进入 toast 或正文的内部错误"));
		const cache = createSessionHoverPreviewCache(fetch);
		cache.setTarget(target("A"));
		await flush();
		expect(cache.getSnapshot()?.result).toEqual(unavailable("A"));
		await vi.advanceTimersByTimeAsync(4_999);
		expect(fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("同步 IPC 异常也降级，并释放唯一在途槽", async () => {
		const fetch = loader().mockImplementationOnce(() => {
			throw new Error("preload 未注入");
		});
		const cache = createSessionHoverPreviewCache(fetch);
		cache.setTarget(target("A"));
		await flush();
		expect(cache.getSnapshot()?.result).toEqual(unavailable("A"));
		cache.setTarget(target("B"));
		await flush();
		expect(cache.getSnapshot()?.result).toEqual(ok("B"));
	});

	it("TTL 从响应完成时计算，关闭卡片后不做后台轮询", async () => {
		const gate = deferred<SessionHoverPreviewResult>();
		const fetch = loader().mockReturnValueOnce(gate.promise);
		const cache = createSessionHoverPreviewCache(fetch);
		cache.setTarget(target("A"));
		await vi.advanceTimersByTimeAsync(20_000);
		gate.resolve(ok("A"));
		await flush();
		cache.setTarget(null);
		await vi.advanceTimersByTimeAsync(29_999);
		cache.setTarget(target("A"));
		expect(fetch).toHaveBeenCalledTimes(1);
		cache.setTarget(null);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetch).toHaveBeenCalledTimes(1);
		cache.setTarget(target("A"));
		await flush();
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("最多保留 100 项，命中提升 LRU，淘汰最久未访问项", async () => {
		const fetch = loader();
		const cache = createSessionHoverPreviewCache(fetch);
		for (let index = 0; index < 100; index++) {
			cache.setTarget(target(String(index)));
			await flush();
		}
		cache.setTarget(target("0")); // 保留 0，应淘汰 1
		cache.setTarget(target("100"));
		await flush();
		expect(fetch).toHaveBeenCalledTimes(101);
		cache.setTarget(target("0"));
		expect(fetch).toHaveBeenCalledTimes(101);
		cache.setTarget(target("1"));
		await flush();
		expect(fetch).toHaveBeenCalledTimes(102);
		expect(cache.getSessionIds()).toHaveLength(100);
	});

	it("重复选择相同缓存项保持 snapshot 引用，不制造 useSyncExternalStore 渲染循环", async () => {
		const cache = createSessionHoverPreviewCache(loader());
		const listener = vi.fn();
		const unsubscribe = cache.subscribe(listener);
		cache.setTarget(target("A"));
		await flush();
		const before = cache.getSnapshot();
		const notifications = listener.mock.calls.length;
		cache.setTarget({ ...target("A") });
		expect(cache.getSnapshot()).toBe(before);
		expect(listener).toHaveBeenCalledTimes(notifications);
		unsubscribe();
		cache.setTarget(null);
		expect(listener).toHaveBeenCalledTimes(notifications);
	});
});

describe("删除、移动、撤回与重载失效", () => {
	it("失效指定会话的所有 cwd/版本，不影响其他会话", async () => {
		const fetch = loader();
		const cache = createSessionHoverPreviewCache(fetch);
		for (const item of [target("A"), { ...target("A"), cwd: "D:/moved" }, target("B")]) {
			cache.setTarget(item);
			await flush();
		}
		cache.setTarget(null);
		cache.invalidate("A");
		cache.setTarget(target("B"));
		expect(fetch).toHaveBeenCalledTimes(3);
		cache.setTarget(target("A"));
		await flush();
		cache.setTarget({ ...target("A"), cwd: "D:/moved" });
		await flush();
		expect(fetch).toHaveBeenCalledTimes(5);
	});

	it("失效在途结果不能回填缓存，仍须等待它释放槽后读取当前目标", async () => {
		const stale = deferred<SessionHoverPreviewResult>();
		const fresh = deferred<SessionHoverPreviewResult>();
		const fetch = loader().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
		const cache = createSessionHoverPreviewCache(fetch);
		cache.setTarget(target("A"));
		cache.invalidate("A");
		cache.setTarget(target("A"));
		expect(fetch).toHaveBeenCalledTimes(1);
		stale.resolve(ok("A", "撤回前"));
		await flush();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(cache.getSnapshot()?.result).toBeNull();
		fresh.resolve(ok("A", "撤回后"));
		await flush();
		expect(cache.getSnapshot()?.result).toEqual(ok("A", "撤回后"));
	});

	it("重载清空所有缓存；旧请求完成不能复活已删除项", async () => {
		const stale = deferred<SessionHoverPreviewResult>();
		const fetch = loader().mockReturnValueOnce(stale.promise);
		const cache = createSessionHoverPreviewCache(fetch);
		cache.setTarget(target("A"));
		cache.setTarget(null);
		cache.invalidate();
		stale.resolve(ok("A", "已删除"));
		await flush();
		expect(cache.getSnapshot()).toBeNull();
		cache.setTarget(target("A"));
		await flush();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(cache.getSnapshot()?.result).toEqual(ok("A"));
	});

	it("失效旧目标时不能取消另一个最新待请求目标", async () => {
		const stale = deferred<SessionHoverPreviewResult>();
		const fetch = loader().mockReturnValueOnce(stale.promise);
		const cache = createSessionHoverPreviewCache(fetch);
		cache.setTarget(target("A"));
		cache.setTarget(target("B"));
		cache.invalidate("A");
		stale.resolve(ok("A"));
		await flush();
		expect(fetch.mock.calls.map(([request]) => request.sessionId)).toEqual(["A", "B"]);
		expect(cache.getSnapshot()?.result).toEqual(ok("B"));
	});
});
