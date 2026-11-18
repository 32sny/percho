import { describe, expect, it } from "vitest";
import { buildThinkingLevelMap, readThinkingDeclaration } from "./thinking";

describe("readThinkingDeclaration", () => {
	it("按清单条目读出支持的 effort 与能否关闭", () => {
		const declaration = readThinkingDeclaration({
			supports_reasoning: true,
			reasoning_supported_efforts: ["low", "high", "max"],
			can_disable_thinking: true,
		});
		expect(declaration).toEqual({ supported: ["low", "high", "max"], canDisable: true });
	});

	it("only_reasoning 也算支持思考；未写 can_disable_thinking 即视为不能关", () => {
		expect(
			readThinkingDeclaration({ only_reasoning: true, reasoning_supported_efforts: ["medium"] }),
		).toEqual({
			supported: ["medium"],
			canDisable: false,
		});
	});

	it("未声明支持思考时返回 undefined（不写映射，保持 SDK 默认）", () => {
		expect(readThinkingDeclaration({ reasoning_supported_efforts: ["high"] })).toBeUndefined();
		expect(readThinkingDeclaration({ supports_reasoning: "true" })).toBeUndefined();
		expect(readThinkingDeclaration({ supports_reasoning: true })).toEqual({
			supported: [],
			canDisable: false,
		});
	});

	it("忽略 pi 不认识的档位名，去重并按原样小写", () => {
		expect(
			readThinkingDeclaration({
				supports_reasoning: true,
				reasoning_supported_efforts: ["High", "high", "ultra", 42, " xhigh "],
			}),
		).toEqual({ supported: ["high", "xhigh"], canDisable: false });
	});
});

describe("buildThinkingLevelMap", () => {
	it("只声明接口写明的档位，其余显式 null", () => {
		const map = buildThinkingLevelMap({ supported: ["low", "high", "max"], canDisable: true });
		expect(map).toEqual({
			off: "off",
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	it("不能关思考时 off 也置 null（只推理模型）", () => {
		const map = buildThinkingLevelMap({ supported: ["medium"], canDisable: false });
		expect(map?.off).toBeNull();
		expect(map?.medium).toBe("medium");
		expect(map?.low).toBeNull();
	});

	it("一个档位都没声明时不写映射（避免把所有档位都判死）", () => {
		expect(buildThinkingLevelMap({ supported: [], canDisable: true })).toBeUndefined();
	});
});
