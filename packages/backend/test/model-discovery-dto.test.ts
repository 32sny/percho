import { describe, expect, it } from "vitest";
import { toModelDiscoveryResult } from "../src/settings/settings";

describe("toModelDiscoveryResult", () => {
	it("逐条给出上限候选与告警，缺值不代填", () => {
		const dto = toModelDiscoveryResult({
			ok: true,
			path: "/v1/models",
			tried: [],
			truncated: false,
			duplicates: 1,
			models: [
				{
					id: "m-1",
					name: "Model One",
					raw: { context_length: "128000", max_input_tokens: 96000, max_output_tokens: 16384 },
				},
				{ id: "m-2", raw: { context_window: 128000, max_context_length: 64000 } },
				{ id: "m-3", raw: { context_window: 32000, max_output_tokens: 64000 } },
				{ id: "m-4", raw: {} },
			],
		});

		expect(dto.ok).toBe(true);
		expect(dto.path).toBe("/v1/models");
		expect(dto.duplicates).toBe(1);
		expect(dto.models.map((model) => model.id)).toEqual(["m-1", "m-2", "m-3", "m-4"]);
		expect(dto.models[0]).toEqual({
			id: "m-1",
			name: "Model One",
			contextWindow: 128000,
			maxTokens: 16384,
			inputLimit: 96000,
			sources: {
				contextWindow: [{ key: "context_length", value: 128000 }],
				inputLimit: [{ key: "max_input_tokens", value: 96000 }],
				maxTokens: [{ key: "max_output_tokens", value: 16384 }],
			},
			warnings: [],
		});
		// 冲突：不给窗口值，只留告警与来源（UI 用它解释差异）
		expect(dto.models[1]).toEqual({
			id: "m-2",
			sources: {
				contextWindow: [
					{ key: "context_window", value: 128000 },
					{ key: "max_context_length", value: 64000 },
				],
				inputLimit: [],
				maxTokens: [],
			},
			warnings: ["contextWindow:conflict"],
		});
		// 单项超总窗口：两者都不导入，但值留在来源里供一键采用
		expect(dto.models[2]).toEqual({
			id: "m-3",
			sources: {
				contextWindow: [{ key: "context_window", value: 32000 }],
				inputLimit: [],
				maxTokens: [{ key: "max_output_tokens", value: 64000 }],
			},
			warnings: ["contextWindow:inconsistent", "maxTokens:inconsistent"],
		});
		expect(dto.models[3]).toEqual({
			id: "m-4",
			sources: { contextWindow: [], inputLimit: [], maxTokens: [] },
			warnings: [],
		});
	});

	it("失败时只带原因与已试路径，不带候选与响应体", () => {
		const dto = toModelDiscoveryResult({
			ok: false,
			reason: "not-found",
			tried: [
				{ path: "/api/models", reason: "not-found" },
				{ path: "/api/v1/models", reason: "not-found" },
			],
		});
		expect(dto).toEqual({
			ok: false,
			models: [],
			reason: "not-found",
			tried: [
				{ path: "/api/models", reason: "not-found" },
				{ path: "/api/v1/models", reason: "not-found" },
			],
		});
		expect(JSON.stringify(dto)).not.toContain("Authorization");
	});
});

describe("toModelDiscoveryResult 思考档位", () => {
	it("接口声明了 efforts 才带 thinking，未声明则不带", () => {
		const dto = toModelDiscoveryResult({
			ok: true,
			path: "/v1/models",
			tried: [],
			truncated: false,
			duplicates: 0,
			models: [
				{
					id: "m-reasoning",
					raw: {
						supports_reasoning: true,
						only_reasoning: true,
						reasoning_supported_efforts: ["low", "high", "max"],
						can_disable_thinking: true,
					},
				},
				{ id: "m-plain", raw: { context_length: 128000 } },
			],
		});
		expect(dto.models[0]?.thinking).toEqual({
			supported: ["low", "high", "max"],
			canDisable: true,
		});
		expect(dto.models[1]?.thinking).toBeUndefined();
	});
});
