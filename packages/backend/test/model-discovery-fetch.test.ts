import { describe, expect, it } from "vitest";
import { DEFAULT_DISCOVERY_LIMITS, type DiscoveryLimits } from "../src/settings/model-discovery";
import {
	discoverProviderModels,
	type FetchLike,
	makeDiscoveryRequest,
} from "../src/settings/model-discovery-fetch";

const ORIGIN = "https://relay.example";
const KEY = "sk-test-should-never-leak";

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
	const seen: { url: string; init: RequestInit }[] = [];
	const impl: FetchLike = async (url, init) => {
		seen.push({ url, init });
		return handler(url, init);
	};
	return { seen, impl };
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

describe("发现请求适配器", () => {
	it("GET、带 Accept；有 key 才带 Authorization；redirect 为 manual", async () => {
		const list = [{ id: "m-1", name: "模型一" }];
		const withKey = fakeFetch(() => jsonResponse(list));
		const result = await discoverProviderModels(
			{ baseUrl: `${ORIGIN}/api`, api: "openai-completions", apiKey: KEY },
			{ fetchImpl: withKey.impl },
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.models[0]?.name).toBe("模型一");
		expect(withKey.seen).toHaveLength(1);
		const [call] = withKey.seen;
		expect(call?.url).toBe(`${ORIGIN}/api/models`);
		expect(call?.init.method).toBe("GET");
		expect(headersOf(call?.init ?? {}).Accept).toBe("application/json");
		expect(headersOf(call?.init ?? {}).Authorization).toBe(`Bearer ${KEY}`);
		expect(call?.init.redirect).toBe("manual");

		const withoutKey = fakeFetch(() => jsonResponse(list));
		await discoverProviderModels(
			{ baseUrl: `${ORIGIN}/api`, api: "openai-completions" },
			{ fetchImpl: withoutKey.impl },
		);
		expect(headersOf(withoutKey.seen[0]?.init ?? {}).Authorization).toBeUndefined();
	});

	it("key 不出现在结果、已试路径与错误文案里", async () => {
		const { impl } = fakeFetch(() => jsonResponse({ object: "list" }));
		const result = await discoverProviderModels(
			{ baseUrl: `${ORIGIN}/api`, api: "openai-completions", apiKey: KEY },
			{ fetchImpl: impl },
		);
		expect(result.ok).toBe(false);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(KEY);
		expect(serialized).not.toContain("sk-test");
		if (!result.ok) expect(result.tried.every((entry) => !entry.path.includes(KEY))).toBe(true);
	});

	it("3xx 不跟随，第二次地址也不再请求", async () => {
		const { seen, impl } = fakeFetch(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: "https://evil.example/steal" },
				}),
		);
		const result = await discoverProviderModels(
			{ baseUrl: `${ORIGIN}/api`, api: "openai-completions", apiKey: KEY },
			{ fetchImpl: impl },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("redirect");
			expect(result.tried).toEqual([{ path: "/api/models", reason: "redirect" }]);
		}
		expect(seen).toHaveLength(1);
	});

	it("读取阶段超字节上限即判 too-large，不把大响应整体读进内存", async () => {
		const big = new Response("x".repeat(4096), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
		const { impl } = fakeFetch(() => big);
		const limits: DiscoveryLimits = { ...DEFAULT_DISCOVERY_LIMITS, maxBytes: 128 };
		const result = await discoverProviderModels(
			{ baseUrl: `${ORIGIN}/tenant/api`, api: "openai-completions" },
			{ fetchImpl: impl, limits },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("too-large");
	});

	it("content-type 直通：200 HTML 按路径错误上报", async () => {
		const { impl } = fakeFetch(
			() =>
				new Response("<!doctype html><html><body>login</body></html>", {
					status: 200,
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
		);
		const result = await discoverProviderModels(
			{ baseUrl: `${ORIGIN}/tenant/api`, api: "openai-completions" },
			{ fetchImpl: impl },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("html");
	});

	it("404 后按计划补试版本路径，成功即返回", async () => {
		const { seen, impl } = fakeFetch((url) =>
			url.endsWith("/api/models")
				? new Response("", { status: 404 })
				: jsonResponse([{ id: "m-1", context_window: "128000" }]),
		);
		const result = await discoverProviderModels(
			{ baseUrl: `${ORIGIN}/api`, api: "openai-completions" },
			{ fetchImpl: impl },
		);
		expect(result.ok).toBe(true);
		expect(seen.map((call) => new URL(call.url).pathname)).toEqual(["/api/models", "/api/v1/models"]);
		if (result.ok) expect(result.tried).toEqual([{ path: "/api/models", reason: "not-found" }]);
		if (result.ok) expect(result.path).toBe("/api/v1/models");
	});

	it("凭证型基址直接拒绝，不发任何请求", async () => {
		const { seen, impl } = fakeFetch(() => jsonResponse([]));
		const result = await discoverProviderModels(
			{ baseUrl: "https://user:pass@relay.example/api", api: "openai-completions", apiKey: KEY },
			{ fetchImpl: impl },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("invalid-url");
		expect(seen).toHaveLength(0);
		expect(JSON.stringify(result)).not.toContain("pass");
		expect(JSON.stringify(result)).not.toContain("user");
	});

	it("外部取消透传到 fetch，结果报 aborted", async () => {
		const controller = new AbortController();
		const { seen, impl } = fakeFetch((_url, init) => {
			const signal = init.signal as AbortSignal;
			return new Promise((_, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				// 先挂监听再取消，否则「已 abort 的 signal 不再派发」会让用例自己挂死
				controller.abort();
			});
		});
		const result = await discoverProviderModels(
			{ baseUrl: `${ORIGIN}/api`, api: "openai-completions" },
			{ fetchImpl: impl, signal: controller.signal },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("aborted");
		expect(seen).toHaveLength(1);
	});

	it("网络错误与无 body 响应都不崩", async () => {
		const boom: FetchLike = async () => {
			throw new TypeError("fetch failed");
		};
		const failed = await discoverProviderModels(
			{ baseUrl: `${ORIGIN}/api`, api: "openai-completions" },
			{ fetchImpl: boom },
		);
		expect(failed.ok).toBe(false);
		if (!failed.ok) expect(failed.reason).toBe("network");

		const empty = fakeFetch(() => new Response(null, { status: 200 }));
		const result = await discoverProviderModels(
			{ baseUrl: `${ORIGIN}/tenant/api`, api: "openai-completions" },
			{ fetchImpl: empty.impl },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("shape");
	});

	it("makeDiscoveryRequest 单独使用时上限与默认值一致", async () => {
		const { impl } = fakeFetch(
			() =>
				new Response("x".repeat(64), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const request = makeDiscoveryRequest({ maxBytes: 32, fetchImpl: impl });
		const response = await request(`${ORIGIN}/models`, { signal: new AbortController().signal });
		expect(response.status).toBe(200);
		expect(response.bodyTooLarge).toBe(true);
		expect(response.body).toBe("");
	});
});
