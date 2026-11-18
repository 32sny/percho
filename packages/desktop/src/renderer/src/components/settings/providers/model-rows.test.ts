import { describe, expect, it } from "vitest";
import {
	adoptDiscoveredLimits,
	applyDiscoveredModel,
	EMPTY_MODEL_ROW,
	filterDiscoveredModels,
	formatTokenCount,
	modelsToRows,
	parseThinkingLevels,
	parseTokenCount,
	rowsToModelInputs,
	rowsValid,
	splitPastedModelIds,
} from "./model-rows";

describe("parseTokenCount", () => {
	it("解析裸数字与 k/M 后缀", () => {
		expect(parseTokenCount("256000")).toBe(256000);
		expect(parseTokenCount("256k")).toBe(256000);
		expect(parseTokenCount("128K")).toBe(128000);
		expect(parseTokenCount(" 16k ")).toBe(16000);
		expect(parseTokenCount("1.5k")).toBe(1500);
		expect(parseTokenCount("1M")).toBe(1_000_000);
		expect(parseTokenCount("0.5m")).toBe(500_000);
	});

	it("拒绝非法输入", () => {
		expect(parseTokenCount("abc")).toBeNull();
		expect(parseTokenCount("0")).toBeNull();
		expect(parseTokenCount("-5")).toBeNull();
		expect(parseTokenCount("1.5")).toBeNull(); // 非整数
		expect(parseTokenCount("0.0001k")).toBeNull(); // 0.1 token 非整数
		expect(parseTokenCount("")).toBeNull();
	});
});

describe("formatTokenCount", () => {
	it("整千折 k、整百万折 M，其余原样", () => {
		expect(formatTokenCount(256000)).toBe("256k");
		expect(formatTokenCount(128000)).toBe("128k");
		expect(formatTokenCount(1_000_000)).toBe("1M");
		expect(formatTokenCount(1048576)).toBe("1048576");
		expect(formatTokenCount(999)).toBe("999");
		expect(formatTokenCount(65536)).toBe("65536");
	});
});

describe("rowsValid / rowsToModelInputs", () => {
	it("全空行合法：模型列表留空 = 沿用内置模型列表（仅覆写 baseUrl）", () => {
		expect(
			rowsValid([
				{
					id: "",
					contextWindow: "",
					maxTokens: "",
					reasoning: false,
					imageInput: false,
					thinkingLevels: "",
					allowThinkingOff: true,
				},
			]),
		).toBe(true);
		expect(
			rowsValid([
				{
					id: "",
					contextWindow: "",
					maxTokens: "",
					reasoning: false,
					imageInput: false,
					thinkingLevels: "",
					allowThinkingOff: true,
				},
				{
					id: "",
					contextWindow: "",
					maxTokens: "",
					reasoning: false,
					imageInput: false,
					thinkingLevels: "",
					allowThinkingOff: true,
				},
			]),
		).toBe(true);
		expect(
			rowsValid([
				{
					id: "gpt-5",
					contextWindow: "",
					maxTokens: "",
					reasoning: false,
					imageInput: false,
					thinkingLevels: "",
					allowThinkingOff: true,
				},
			]),
		).toBe(true);
	});

	it("全空行转换为空数组（不落盘 models 键）", () => {
		expect(
			rowsToModelInputs([
				{
					id: "",
					contextWindow: "",
					maxTokens: "",
					reasoning: false,
					imageInput: false,
					thinkingLevels: "",
					allowThinkingOff: true,
				},
			]),
		).toEqual([]);
	});

	it("ctx/out 留空合法，非法值不合法", () => {
		const base = {
			id: "m1",
			reasoning: false,
			imageInput: false,
			thinkingLevels: "",
			allowThinkingOff: true,
		};
		expect(rowsValid([{ ...base, contextWindow: "abc", maxTokens: "" }])).toBe(false);
		expect(rowsValid([{ ...base, contextWindow: "256k", maxTokens: "64k" }])).toBe(true);
	});

	it("转换时丢弃空行、留空字段不落盘", () => {
		const inputs = rowsToModelInputs([
			{
				id: " gpt-5.6-terra ",
				contextWindow: "256k",
				maxTokens: "",
				reasoning: true,
				imageInput: true,
				thinkingLevels: "",
				allowThinkingOff: true,
			},
			{
				id: "",
				contextWindow: "",
				maxTokens: "",
				reasoning: false,
				imageInput: false,
				thinkingLevels: "",
				allowThinkingOff: true,
			},
			{
				id: "gpt-5-mini",
				contextWindow: "",
				maxTokens: "16k",
				reasoning: false,
				imageInput: false,
				thinkingLevels: "",
				allowThinkingOff: true,
			},
		]);
		expect(inputs).toEqual([
			{ id: "gpt-5.6-terra", reasoning: true, contextWindow: 256000, maxTokens: undefined, imageInput: true },
			{
				id: "gpt-5-mini",
				reasoning: undefined,
				contextWindow: undefined,
				maxTokens: 16000,
				imageInput: undefined,
			},
		]);
	});
});

describe("modelsToRows", () => {
	it("从 ProviderInfo.models 预填，保留未设置状态", () => {
		expect(
			modelsToRows([
				{ id: "a", name: "a", reasoning: true, contextWindow: 256000 },
				{ id: "b", name: "b" },
			]),
		).toEqual([
			{
				id: "a",
				contextWindow: "256k",
				maxTokens: "",
				reasoning: true,
				imageInput: false,
				thinkingLevels: "",
				allowThinkingOff: true,
			},
			{
				id: "b",
				contextWindow: "",
				maxTokens: "",
				reasoning: false,
				imageInput: false,
				thinkingLevels: "",
				allowThinkingOff: true,
			},
		]);
	});

	it("空列表兜底一个空行", () => {
		expect(modelsToRows([])).toEqual([
			{
				id: "",
				contextWindow: "",
				maxTokens: "",
				reasoning: false,
				imageInput: false,
				thinkingLevels: "",
				allowThinkingOff: true,
			},
		]);
	});
});

describe("splitPastedModelIds", () => {
	it("逗号/换行拆分，普通文本返回 null", () => {
		expect(splitPastedModelIds("gpt-5, gpt-5-mini\ngpt-5-nano")).toEqual([
			"gpt-5",
			"gpt-5-mini",
			"gpt-5-nano",
		]);
		expect(splitPastedModelIds("gpt-5")).toBeNull();
		expect(splitPastedModelIds(",,\n")).toBeNull();
	});
});

describe("applyDiscoveredModel", () => {
	const base = {
		id: "manual-id",
		contextWindow: "200k",
		maxTokens: "8k",
		reasoning: true,
		imageInput: false,
		thinkingLevels: "",
		allowThinkingOff: true,
	};

	it("能确定的上限一并填入，文本与行内输入同款格式", () => {
		const { row, notice } = applyDiscoveredModel(base, {
			id: "relay-pro",
			contextWindow: 128000,
			maxTokens: 16384,
			warnings: [],
		});
		expect(row).toEqual({ ...base, id: "relay-pro", contextWindow: "128k", maxTokens: "16384" });
		expect(notice).toBeUndefined();
	});

	it("接口自相矛盾（输出大于总窗口）时不自动填，但把值交出来供一键采用", () => {
		const { row, notice } = applyDiscoveredModel(base, {
			id: "cn:kimi-k3-1",
			sources: {
				contextWindow: [{ key: "context_length", value: 1000000 }],
				maxTokens: [{ key: "max_output_tokens", value: 1048576 }],
			},
			warnings: ["contextWindow:inconsistent", "maxTokens:inconsistent"],
		});
		expect(row).toEqual({ ...base, id: "cn:kimi-k3-1" });
		expect(notice).toEqual({ contextWindow: 1000000, maxTokens: 1048576, ambiguousContext: false });
	});

	it("多个不同总窗口别名时只报歧义，不给一键采用的值", () => {
		const { row, notice } = applyDiscoveredModel(base, {
			id: "relay-x",
			sources: {
				contextWindow: [
					{ key: "context_window", value: 128000 },
					{ key: "max_context_length", value: 64000 },
				],
			},
			warnings: ["contextWindow:conflict"],
		});
		expect(row.id).toBe("relay-x");
		expect(notice).toEqual({ ambiguousContext: true });
	});

	it("采用接口值后写入该行，不触碰思考/图像等未发现字段", () => {
		const adopted = adoptDiscoveredLimits(base, {
			contextWindow: 1000000,
			maxTokens: 1048576,
			ambiguousContext: false,
		});
		expect(adopted).toEqual({ ...base, contextWindow: "1M", maxTokens: "1048576" });
		expect(adopted.reasoning).toBe(true);
		expect(adopted.imageInput).toBe(false);
	});
});

describe("filterDiscoveredModels", () => {
	const models = [
		{ id: "cn:deepseek-v4.1-flash", name: "DeepSeek V4.1", warnings: [] },
		{ id: "cn:glm-5.3-flash", name: "GLM 5.3", warnings: [] },
		{ id: "relay-pro", warnings: [] },
	];

	it("空查询返回全部：打开面板时不能被已填 ID 筛掉", () => {
		expect(filterDiscoveredModels(models, "")).toHaveLength(3);
		expect(filterDiscoveredModels(models, "   ")).toHaveLength(3);
	});

	it("按 id 子串过滤，忽略大小写", () => {
		expect(filterDiscoveredModels(models, "DEEPSEEK").map((m) => m.id)).toEqual(["cn:deepseek-v4.1-flash"]);
		expect(filterDiscoveredModels(models, "flash").map((m) => m.id)).toEqual([
			"cn:deepseek-v4.1-flash",
			"cn:glm-5.3-flash",
		]);
	});

	it("也匹配展示名，无命中返回空数组", () => {
		expect(filterDiscoveredModels(models, "glm 5.3").map((m) => m.id)).toEqual(["cn:glm-5.3-flash"]);
		expect(filterDiscoveredModels(models, "nope")).toEqual([]);
	});
});

describe("思考档位：发现带入与保存回写", () => {
	it("选中候选后档位变成可编辑文本，提交时生成映射并一并勾上思考", () => {
		const { row } = applyDiscoveredModel(
			{ ...EMPTY_MODEL_ROW, id: "" },
			{
				id: "cn:kimi-k3.1-pro",
				contextWindow: 1_000_000,
				maxTokens: 32000,
				warnings: [],
				thinking: { supported: ["low", "high", "max"], canDisable: false },
			},
		);
		expect(row.thinkingLevels).toBe("low, high, max");
		expect(row.allowThinkingOff).toBe(false);
		expect(row.reasoning).toBe(true);
		const [input] = rowsToModelInputs([row]);
		expect(input?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	it("编辑已存配置时读回档位文本，空文本不写映射", () => {
		const [row] = modelsToRows([
			{
				id: "relay-pro",
				reasoning: true,
				thinkingLevelMap: {
					off: "off",
					minimal: null,
					low: "low",
					medium: null,
					high: "high",
					xhigh: null,
					max: "max",
				},
			},
		]);
		expect(row?.thinkingLevels).toBe("low, high, max");
		expect(row?.allowThinkingOff).toBe(true);
		expect(rowsToModelInputs(row ? [row] : [])[0]?.thinkingLevelMap).toEqual({
			off: "off",
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});

		const [plain] = modelsToRows([{ id: "plain" }]);
		expect(plain?.thinkingLevels).toBe("");
		expect(rowsToModelInputs(plain ? [plain] : [])[0]?.thinkingLevelMap).toBeUndefined();
	});
});

describe("parseThinkingLevels 与档位校验", () => {
	it("逗号或空格分隔、去重、忽略大小写与 off", () => {
		expect(parseThinkingLevels("Low, high  max")).toEqual({ levels: ["low", "high", "max"], unknown: [] });
		expect(parseThinkingLevels("off, low")).toEqual({ levels: ["low"], unknown: [] });
		expect(parseThinkingLevels("")).toEqual({ levels: [], unknown: [] });
	});

	it("认不出的词单独报出，并阻止保存", () => {
		expect(parseThinkingLevels("low, hgih").unknown).toEqual(["hgih"]);
		expect(rowsValid([{ ...EMPTY_MODEL_ROW, id: "m", thinkingLevels: "low, hgih" }])).toBe(false);
		expect(rowsValid([{ ...EMPTY_MODEL_ROW, id: "m", thinkingLevels: "low, max" }])).toBe(true);
		expect(rowsValid([{ ...EMPTY_MODEL_ROW, id: "m", thinkingLevels: "" }])).toBe(true);
	});

	it("未勾思考时不写映射，即使填了档位", () => {
		const [input] = rowsToModelInputs([
			{ ...EMPTY_MODEL_ROW, id: "m", reasoning: false, thinkingLevels: "high, max" },
		]);
		expect(input?.thinkingLevelMap).toBeUndefined();
	});
});
