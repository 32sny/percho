/** pi 支持的思考深度（顺序即显示顺序，也是档位高低顺序） */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * 白名单校验（backend 解析 agent frontmatter / model-prefs 脏值过滤用）。
 * 只做「是否合法档位」判定，不做收敛——档位与模型能力的收敛全权交 SDK `clampThinkingLevel`。
 */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** 中转站清单里声明的思考能力（只读声明，不猜） */
export interface ModelThinkingDeclaration {
	/** 接口声明支持的 effort 名（已小写、去重、只留 pi 认得的档位）；不含 off */
	supported: string[];
	/** 接口明确写了可以关闭思考（`can_disable_thinking === true`） */
	canDisable: boolean;
}

/**
 * 从清单条目读思考能力声明。
 * 条目未声明支持思考（`supports_reasoning` / `only_reasoning` 都不为 true）时返回 undefined，
 * 即「不写映射、保持 SDK 默认」，不把没有声明的模型当成非推理模型。
 */
export function readThinkingDeclaration(
	entry: Record<string, unknown>,
): ModelThinkingDeclaration | undefined {
	const reasoning = entry.supports_reasoning === true || entry.only_reasoning === true;
	if (!reasoning) return undefined;
	const raw = entry.reasoning_supported_efforts;
	const declared = Array.isArray(raw) ? raw : [];
	const supported = [
		...new Set(
			declared
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.trim().toLowerCase())
				.filter((value) => isThinkingLevel(value) && value !== "off"),
		),
	];
	return { supported, canDisable: entry.can_disable_thinking === true };
}

/**
 * 生成 SDK 的 `thinkingLevelMap`：只声明接口写明的档位，其余显式 `null`——
 * 不给用户摆出会被接口拒绝的档位（如站点只支持 low/high/max，就不该出现 minimal/medium）。
 *
 * - 未声明任何非 off 档位时返回 undefined：不写映射，保持 SDK 默认阶梯（off..high）。
 * - `off` 只在接口明确 `can_disable_thinking` 时开放，否则置 null（只推理模型关不掉思考）。
 */
export function buildThinkingLevelMap(
	declaration: ModelThinkingDeclaration,
): Record<string, string | null> | undefined {
	if (declaration.supported.length === 0) return undefined;
	const map: Record<string, string | null> = {};
	for (const level of THINKING_LEVELS) {
		if (level === "off") {
			map[level] = declaration.canDisable ? "off" : null;
			continue;
		}
		map[level] = declaration.supported.includes(level) ? level : null;
	}
	return map;
}
