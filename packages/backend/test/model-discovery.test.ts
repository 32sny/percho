import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_DISCOVERY_LIMITS,
	type DiscoveryRequest,
	type DiscoveryResponse,
	discoverModelList,
	formatLimitWarning,
	parseModelLimits,
	resolveModelListPlan,
} from "../src/settings/model-discovery";

/**
 * A1 契约测试：样例真源是 scripts/fixtures/provider-discovery-a1.json（脱敏，非真实站点响应）。
 * 这里把 fixture 的 reply 语义翻译成 HTTP 响应，回放后核对请求路径序列与结果。
 */

const ORIGIN = "https://relay.example";
const FIXTURE = JSON.parse(
	readFileSync(new URL("../../../scripts/fixtures/provider-discovery-a1.json", import.meta.url), "utf8"),
) as {
	endpoints: {
		id: string;
		base: string;
		api?: string;
		reply: (string | number)[];
		calls: string[];
		result: "ok" | "error";
	}[];
	limits: {
		id: string;
		raw: Record<string, unknown>;
		expected: Record<string, number>;
		warnings: string[];
	}[];
};

const JSON_HEADERS = { contentType: "application/json; charset=utf-8" } as const;

function json(status: number, value: unknown): DiscoveryResponse {
	return { status, ...JSON_HEADERS, body: JSON.stringify(value) };
}

/** 把 fixture 的一条 reply 变成响应；timeout 走真实总时限（请求挂到 abort 才失败） */
function toResponse(reply: string | number, signal: AbortSignal): Promise<DiscoveryResponse> {
	if (typeof reply === "number") return Promise.resolve({ status: reply, ...JSON_HEADERS, body: "" });
	switch (reply) {
		case "list":
			return Promise.resolve(
				json(200, [
					{ id: "m-1", name: "Model One", context_length: "128000", max_output_tokens: 16384 },
					{ id: "m-2" },
				]),
			);
		case "empty":
			return Promise.resolve(json(200, []));
		case "html":
			return Promise.resolve({
				status: 200,
				contentType: "text/html; charset=utf-8",
				body: "<!doctype html><html><body>login</body></html>",
			});
		case "object":
			return Promise.resolve(json(200, { object: "list" }));
		case "timeout":
			return new Promise((_, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		default:
			throw new Error(`fixture 里未知的 reply：${reply}`);
	}
}

function makeReplay(replies: (string | number)[]) {
	const queue = [...replies];
	const calls: string[] = [];
	const request: DiscoveryRequest = async (url, { signal }) => {
		const { pathname, search } = new URL(url);
		calls.push(`${pathname}${search}`);
		const reply = queue.shift();
		if (reply === undefined) throw new Error(`多出一次请求：${calls.join(" -> ")}`);
		return toResponse(reply, signal);
	};
	return { calls, request, pending: () => queue.length };
}

describe("A1 端点样例回放", () => {
	for (const testCase of FIXTURE.endpoints) {
		it(`${testCase.id}：${testCase.base} → ${testCase.result}`, async () => {
			const { calls, request, pending } = makeReplay(testCase.reply);
			const result = await discoverModelList(
				`${ORIGIN}${testCase.base}`,
				testCase.api ?? "openai-completions",
				request,
				{
					limits: { ...DEFAULT_DISCOVERY_LIMITS, timeoutMs: 50 },
				},
			);
			expect(calls, "实际请求路径序列").toEqual(testCase.calls);
			expect(result.ok, "结果").toBe(testCase.result === "ok");
			expect(pending(), "不应遗留未消费的 fixture reply").toBe(0);
			for (const url of calls) expect(url.startsWith("//"), "路径不应带上跨源前缀").toBe(false);
		});
	}

	it("失败结果按原因区分，不做路径重试", async () => {
		const cases: [string, number][] = [
			["/api", 401],
			["/api", 403],
			["/api", 429],
			["/api", 500],
			["/api", 302],
		];
		const expected = ["auth", "auth", "rate-limited", "server", "redirect"] as const;
		for (const [index, [base, status]] of cases.entries()) {
			const { calls, request } = makeReplay([status, "list"]);
			const result = await discoverModelList(`${ORIGIN}${base}`, "openai-completions", request);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe(expected[index]);
				expect(result.tried).toEqual([{ path: "/api/models", reason: expected[index] }]);
			}
			expect(calls).toEqual(["/api/models"]);
		}
	});

	it("合法空清单算成功，不是路径错误", async () => {
		const { request } = makeReplay(["empty"]);
		const result = await discoverModelList(`${ORIGIN}/api`, "openai-completions", request);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.models).toEqual([]);
			expect(result.truncated).toBe(false);
			expect(result.path).toBe("/api/models");
		}
	});

	it("重复 id 去重、条目数上限标记截断", async () => {
		const { request } = makeReplay(["list"]);
		const all = await discoverModelList(`${ORIGIN}/api`, "openai-completions", request);
		expect(all.ok).toBe(true);
		if (all.ok) {
			expect(all.models.map((model) => model.id)).toEqual(["m-1", "m-2"]);
			expect(all.models[0]?.name).toBe("Model One");
			expect(all.truncated).toBe(false);
		}

		const capped = await discoverModelList(
			`${ORIGIN}/api`,
			"openai-completions",
			makeReplay(["list"]).request,
			{
				limits: { ...DEFAULT_DISCOVERY_LIMITS, maxItems: 1 },
			},
		);
		expect(capped.ok).toBe(true);
		if (capped.ok) {
			expect(capped.models).toHaveLength(1);
			expect(capped.truncated).toBe(true);
		}
	});

	it("响应体积超上限直接失败", async () => {
		const { request } = makeReplay(["list"]);
		const result = await discoverModelList(`${ORIGIN}/api`, "openai-completions", request, {
			limits: { ...DEFAULT_DISCOVERY_LIMITS, maxBytes: 16 },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("too-large");
	});

	it("外部取消报 aborted，且不再发后续请求", async () => {
		const controller = new AbortController();
		const calls: string[] = [];
		const request: DiscoveryRequest = async (url, { signal }) => {
			calls.push(new URL(url).pathname);
			return new Promise((_, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				controller.abort();
			});
		};
		const result = await discoverModelList(`${ORIGIN}/api`, "openai-completions", request, {
			signal: controller.signal,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("aborted");
		expect(calls).toEqual(["/api/models"]);
	});
});

describe("A1 端点生成", () => {
	it("基址路径决定候选请求，且不跨源", () => {
		expect(resolveModelListPlan("https://relay.example", "openai-completions")).toEqual({
			ok: true,
			first: "https://relay.example/models",
			retry: "https://relay.example/v1/models",
		});
		expect(resolveModelListPlan("https://relay.example/api/", "openai-completions")).toEqual({
			ok: true,
			first: "https://relay.example/api/models",
			retry: "https://relay.example/api/v1/models",
		});
		expect(resolveModelListPlan("https://relay.example/tenant/api", "openai-completions")).toEqual({
			ok: true,
			first: "https://relay.example/tenant/api/models",
			retry: null,
		});
		expect(resolveModelListPlan("https://relay.example/api/v1", "openai-completions")).toEqual({
			ok: true,
			first: "https://relay.example/api/v1/models",
			retry: null,
		});
	});

	it("只有 openai-compatible 协议才允许补试版本路径", () => {
		expect(resolveModelListPlan("https://relay.example/api", "openai-responses")).toEqual({
			ok: true,
			first: "https://relay.example/api/models",
			retry: "https://relay.example/api/v1/models",
		});
		for (const api of ["anthropic-messages", "google-generative-ai", ""]) {
			const plan = resolveModelListPlan("https://relay.example", api);
			expect(plan.ok).toBe(true);
			if (plan.ok) expect(plan.retry).toBeNull();
		}
	});

	it("拒绝凭证、查询串、片段与非 http(s)，且不回显基址内容", () => {
		for (const [baseUrl, detail] of [
			["https://user:secret@relay.example/api", "has-credentials"],
			["https://relay.example/api?key=secret", "has-query"],
			["https://relay.example/api#frag", "has-fragment"],
			["relay.example/api", "not-http"],
			["ftp://relay.example/api", "not-http"],
		] as const) {
			const plan = resolveModelListPlan(baseUrl, "openai-completions");
			expect(plan.ok).toBe(false);
			if (plan.ok) continue;
			expect(plan.detail).toBe(detail);
			expect(JSON.stringify(plan)).not.toContain("secret");
		}
	});
});

describe("A1 上限样例回放", () => {
	for (const testCase of FIXTURE.limits) {
		it(`${testCase.id}：${JSON.stringify(testCase.raw)}`, () => {
			const parsed = parseModelLimits({ id: "m-1", ...testCase.raw });
			expect(parsed.candidates, "候选").toEqual(testCase.expected);
			expect(parsed.warnings.map(formatLimitWarning).sort(), "告警").toEqual([...testCase.warnings].sort());
		});
	}

	it("冲突与不一致都保留来源，便于展示差异", () => {
		const conflict = parseModelLimits({ context_window: 128000, max_context_length: 64000 });
		expect(conflict.sources.contextWindow).toEqual([
			{ key: "context_window", value: 128000 },
			{ key: "max_context_length", value: 64000 },
		]);
		expect(conflict.candidates.contextWindow).toBeUndefined();

		const overflow = parseModelLimits({ context_window: 32000, max_input_tokens: 64000 });
		expect(overflow.sources.contextWindow).toEqual([{ key: "context_window", value: 32000 }]);
		expect(overflow.sources.inputLimit).toEqual([{ key: "max_input_tokens", value: 64000 }]);
		expect(overflow.candidates).toEqual({});
	});

	it("同义键等值合并来源、缺键不代填、布尔不算数值", () => {
		const merged = parseModelLimits({ context_window: "128000", context_length: 128000 });
		expect(merged.candidates).toEqual({ contextWindow: 128000 });
		expect(merged.sources.contextWindow).toHaveLength(2);
		expect(merged.warnings).toEqual([]);

		const idOnly = parseModelLimits({ id: "m-1" });
		expect(idOnly.candidates).toEqual({});
		expect(idOnly.warnings).toEqual([]);

		const booled = parseModelLimits({ context_window: true, max_output_tokens: false });
		expect(booled.candidates).toEqual({});
		expect(booled.warnings.map(formatLimitWarning)).toEqual([
			"context_window:invalid",
			"max_output_tokens:invalid",
		]);
	});
});
