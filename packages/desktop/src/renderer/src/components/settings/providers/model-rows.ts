import type { CustomProviderModelInput, DiscoveredModelSummary } from "@percho/shared";

/** 模型行编辑器的一行：数字字段保留原文（支持 k 后缀），提交时才解析 */
export interface ModelRow {
	id: string;
	contextWindow: string;
	maxTokens: string;
	reasoning: boolean;
	imageInput: boolean;
}

export const EMPTY_MODEL_ROW: ModelRow = {
	id: "",
	contextWindow: "",
	maxTokens: "",
	reasoning: false,
	imageInput: false,
};

/**
 * 解析 token 数：支持裸数字与 k/K 后缀（256k = 256000，与 SDK 128000 约定同基）。
 * 返回 null = 非法；空串由调用方先判（表示「未设置」）。
 */
export function parseTokenCount(raw: string): number | null {
	const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*([km])?$/i);
	const numPart = match?.[1];
	if (numPart === undefined) return null;
	const suffix = match?.[2]?.toLowerCase();
	const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1000 : 1;
	const value = Number.parseFloat(numPart) * multiplier;
	if (!Number.isInteger(value) || value <= 0) return null;
	return value;
}

/** 数字 → 行内显示：整千折叠为 k（256000 → "256k"），否则原样 */
export function formatTokenCount(value: number): string {
	// 百万级窗口（如 1M 上下文的国内模型）优先折 M，否则整千折 k，其余原样
	if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`;
	return value >= 1000 && value % 1000 === 0 ? `${value / 1000}k` : String(value);
}

/**
 * 模型定义（ProviderInfo.models 或 models.json 回填的 CustomProviderModelInput）→ 行：
 * 保留「未设置」状态（ctx/out 显示占位）。编辑表单预填一律用 customModels（已落盘定义）
 * 而非 runtime 全量，防保存时全量落盘。
 */
export function modelsToRows(
	models: readonly {
		id: string;
		name?: string;
		reasoning?: boolean;
		contextWindow?: number;
		maxTokens?: number;
		imageInput?: boolean;
	}[],
): ModelRow[] {
	const rows = models.map((m) => ({
		id: m.id,
		contextWindow: m.contextWindow !== undefined ? formatTokenCount(m.contextWindow) : "",
		maxTokens: m.maxTokens !== undefined ? formatTokenCount(m.maxTokens) : "",
		reasoning: m.reasoning === true,
		imageInput: m.imageInput === true,
	}));
	return rows.length > 0 ? rows : [{ ...EMPTY_MODEL_ROW }];
}

/** 表单行 → CustomProviderModelInput（空 id 行丢弃；数字字段在此处已保证合法，见 rowsValid） */
export function rowsToModelInputs(rows: ModelRow[]): CustomProviderModelInput[] {
	return rows
		.filter((row) => row.id.trim())
		.map((row) => ({
			id: row.id.trim(),
			reasoning: row.reasoning || undefined,
			contextWindow: (row.contextWindow.trim() && parseTokenCount(row.contextWindow)) || undefined,
			maxTokens: (row.maxTokens.trim() && parseTokenCount(row.maxTokens)) || undefined,
			imageInput: row.imageInput || undefined,
		}));
}

/**
 * 所有 ctx/out 输入要么留空要么合法。
 * 不要求至少一行有 id：全空 = 共享该 provider 的内置模型列表（仅覆写 baseUrl，pi 官方语义）。
 */
export function rowsValid(rows: ModelRow[]): boolean {
	return rows.every(
		(row) =>
			(!row.contextWindow.trim() || parseTokenCount(row.contextWindow) !== null) &&
			(!row.maxTokens.trim() || parseTokenCount(row.maxTokens) !== null),
	);
}

/**
 * 候选过滤（纯函数）：**空查询返回全部** —— 打开面板时必须先看到整份清单，
 * 不能被输入框里已填的 ID 筛掉（否则取回 18 条却只看到 1 条）。
 */
export function filterDiscoveredModels(
	models: DiscoveredModelSummary[],
	query: string,
): DiscoveredModelSummary[] {
	const q = query.trim().toLowerCase();
	if (!q) return models;
	return models.filter(
		(model) => model.id.toLowerCase().includes(q) || (model.name ?? "").toLowerCase().includes(q),
	);
}

/** 选中候选后未自动填入的上限（供行内提示 + 一键采用）；不替用户在多值冲突里拍板 */
export interface DiscoveredLimitNotice {
	/** 唯一值但未自动采用（如输出大于总窗口） */
	contextWindow?: number;
	maxTokens?: number;
	/** 存在多个不同的总窗口别名：无法一键采用 */
	ambiguousContext: boolean;
}

function uniqueSourceValue(list: { value: number }[] | undefined): number | undefined {
	const values = new Set((list ?? []).map((source) => source.value));
	return values.size === 1 ? [...values][0] : undefined;
}

/**
 * 选中某个发现候选 → 写入该行：id 必换（用户明确选择），能确定的上限一并填入；
 * 自相矛盾（如输出大于总窗口）或多值冲突的候不自动填，只回一个 notice 让用户决定。
 */
export function applyDiscoveredModel(
	row: ModelRow,
	model: DiscoveredModelSummary,
): { row: ModelRow; notice?: DiscoveredLimitNotice } {
	const next: ModelRow = { ...row, id: model.id };
	const notice: DiscoveredLimitNotice = { ambiguousContext: false };

	if (model.contextWindow !== undefined) {
		next.contextWindow = formatTokenCount(model.contextWindow);
	} else {
		const value = uniqueSourceValue(model.sources?.contextWindow);
		if (value !== undefined) notice.contextWindow = value;
		else if (new Set((model.sources?.contextWindow ?? []).map((s) => s.value)).size > 1) {
			notice.ambiguousContext = true;
		}
	}

	if (model.maxTokens !== undefined) {
		next.maxTokens = formatTokenCount(model.maxTokens);
	} else {
		const value = uniqueSourceValue(model.sources?.maxTokens);
		if (value !== undefined) notice.maxTokens = value;
	}

	const hasNotice =
		notice.contextWindow !== undefined || notice.maxTokens !== undefined || notice.ambiguousContext;
	return { row: next, notice: hasNotice ? notice : undefined };
}

/** 一键采用接口给的上限（仅限唯一值；行内提示里的动作） */
export function adoptDiscoveredLimits(row: ModelRow, notice: DiscoveredLimitNotice): ModelRow {
	return {
		...row,
		...(notice.contextWindow !== undefined ? { contextWindow: formatTokenCount(notice.contextWindow) } : {}),
		...(notice.maxTokens !== undefined ? { maxTokens: formatTokenCount(notice.maxTokens) } : {}),
	};
}

/** 粘贴文本含逗号/换行时拆成模型 ID 列表（中转站文档常是列表，直接粘贴成多行） */
export function splitPastedModelIds(text: string): [string, ...string[]] | null {
	if (!/[,\n]/.test(text)) return null;
	const ids = text
		.split(/[,\n]/)
		.map((s) => s.trim())
		.filter(Boolean);
	const [first, ...rest] = ids;
	return first === undefined ? null : [first, ...rest];
}
