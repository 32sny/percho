/**
 * 自定义 Provider 模型清单发现（A1：清单端点 + 上限字段）。
 *
 * 本模块只做纯逻辑：解析基址、生成候选请求序列、按响应判定结果、从模型条目解析上限候选。
 * 真正的 HTTP 请求由调用方注入 `DiscoveryRequest`，因此这里没有网络、没有凭证、没有落盘，
 * 也不会把 API key 放进请求路径或错误文案。规则真源见 docs/PLAN-provider-model-discovery.md 第四节。
 *
 * 边界：本模块只产出候选，不写配置；用户已编辑值应始终优先于这里的结果（A2 职责）。
 */

/** 允许在失败后补试版本路径的协议；其他协议只试一次 */
const RETRYABLE_PROTOCOLS = new Set(["openai-completions", "openai-responses"]);

export type DiscoveryFailure =
	| "invalid-url"
	| "not-found"
	| "auth"
	| "rate-limited"
	| "http"
	| "server"
	| "redirect"
	| "html"
	| "shape"
	| "too-large"
	| "timeout"
	| "aborted"
	| "network";

export type DiscoveryUrlProblem = "not-http" | "has-credentials" | "has-query" | "has-fragment";

export type ModelListPlan =
	| { ok: true; first: string; retry: string | null }
	| { ok: false; reason: "invalid-url"; detail: DiscoveryUrlProblem };

export interface TriedRequest {
	/** 请求路径（不含 origin，不含凭证/查询串） */
	path: string;
	reason: DiscoveryFailure;
}

export interface RawModelEntry {
	id: string;
	name?: string;
	/** 模型条目顶层原文，供上限等字段解析使用 */
	raw: Record<string, unknown>;
}

export interface DiscoveryLimits {
	/** 两次请求共用的总时限 */
	timeoutMs: number;
	/** 单次响应体积上限（UTF-8 字节） */
	maxBytes: number;
	/** 条目数上限；超出即标记截断 */
	maxItems: number;
}

export const DEFAULT_DISCOVERY_LIMITS: DiscoveryLimits = {
	timeoutMs: 8_000,
	maxBytes: 1_000_000,
	maxItems: 2_000,
};

export interface DiscoveryResponse {
	status: number;
	contentType?: string | null;
	body: string;
	/** 适配器在读取阶段就超字节上限，body 为空；由发现层如实报 too-large */
	bodyTooLarge?: boolean;
}

export interface DiscoveryRequestInit {
	signal: AbortSignal;
}

export type DiscoveryRequest = (url: string, init: DiscoveryRequestInit) => Promise<DiscoveryResponse>;

export type DiscoveryResult =
	| {
			ok: true;
			/** 实际命中清单的路径（不含 origin），供 UI 说明「从哪取到」 */
			path: string;
			models: RawModelEntry[];
			/** 是否有条目被条目数上限截断；为真时不能称完整模型目录 */
			truncated: boolean;
			/** 被丢弃的重复 id 数量 */
			duplicates: number;
			tried: TriedRequest[];
	  }
	| { ok: false; reason: DiscoveryFailure; tried: TriedRequest[] };

/**
 * 解析基址并生成候选请求地址。
 *
 * | 基址路径 | 第一个请求 | 允许的第二个请求 |
 * | --- | --- | --- |
 * | `/` | `/models` | `/v1/models` |
 * | 恰好 `/api` | `/api/models` | `/api/v1/models`（不退回根 `/v1/models`） |
 * | 其他路径 | 原前缀后接 `/models` | 无 |
 *
 * 内嵌凭证、查询串、片段一律拒绝，且不回显其内容；只为发现生成地址，不改推理用 baseUrl。
 */
export function resolveModelListPlan(baseUrl: string, api: string): ModelListPlan {
	let url: URL;
	try {
		url = new URL(baseUrl.trim());
	} catch {
		return { ok: false, reason: "invalid-url", detail: "not-http" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { ok: false, reason: "invalid-url", detail: "not-http" };
	}
	if (url.username || url.password) return { ok: false, reason: "invalid-url", detail: "has-credentials" };
	if (url.search) return { ok: false, reason: "invalid-url", detail: "has-query" };
	if (url.hash) return { ok: false, reason: "invalid-url", detail: "has-fragment" };

	const prefix = url.pathname.replace(/\/+$/, "");
	const origin = url.origin;
	if (prefix === "") {
		const first = `${origin}/models`;
		return { ok: true, first, retry: canRetry(api) ? `${origin}/v1/models` : null };
	}
	if (prefix === "/api") {
		const first = `${origin}/api/models`;
		return { ok: true, first, retry: canRetry(api) ? `${origin}/api/v1/models` : null };
	}
	return { ok: true, first: `${origin}${prefix}/models`, retry: null };
}

function canRetry(api: string): boolean {
	return RETRYABLE_PROTOCOLS.has(api.trim());
}

function pathOf(url: string): string {
	const parsed = new URL(url);
	return `${parsed.pathname}${parsed.search}`;
}

type StepDecision =
	/** 本次失败但还允许下一地址 */
	| { kind: "retry"; reason: DiscoveryFailure }
	/** 立即停止，不再补试 */
	| { kind: "fail"; reason: DiscoveryFailure }
	| { kind: "success"; models: RawModelEntry[]; truncated: boolean; duplicates: number };

/** 单次响应判定：路径错误（404/405、200 HTML）可补试，其余失败立即停止 */
function evaluateResponse(
	response: DiscoveryResponse,
	limits: DiscoveryLimits,
	hasAlternative: boolean,
): StepDecision {
	const { status } = response;
	const missOrFail = (reason: DiscoveryFailure): StepDecision =>
		hasAlternative ? { kind: "retry", reason } : { kind: "fail", reason };

	if (status >= 300 && status < 400) return { kind: "fail", reason: "redirect" };
	if (status === 404 || status === 405) return missOrFail("not-found");
	if (status === 401 || status === 403) return { kind: "fail", reason: "auth" };
	if (status === 429) return { kind: "fail", reason: "rate-limited" };
	if (status >= 500) return { kind: "fail", reason: "server" };
	if (status < 200 || status >= 300) return { kind: "fail", reason: "http" };
	if (response.bodyTooLarge) return { kind: "fail", reason: "too-large" };
	if (Buffer.byteLength(response.body, "utf8") > limits.maxBytes)
		return { kind: "fail", reason: "too-large" };

	let parsed: unknown;
	let parseFailed = false;
	try {
		parsed = JSON.parse(response.body);
	} catch {
		parseFailed = true;
	}
	const items = parseFailed ? null : extractListItems(parsed);
	if (!items) {
		return isHtml(response.contentType, response.body)
			? missOrFail("html")
			: { kind: "fail", reason: "shape" };
	}

	const models: RawModelEntry[] = [];
	const seen = new Set<string>();
	let duplicates = 0;
	let truncated = false;
	for (const item of items) {
		const entry = toEntry(item);
		if (!entry) continue;
		if (seen.has(entry.id)) {
			duplicates += 1;
			continue;
		}
		if (models.length >= limits.maxItems) {
			truncated = true;
			break;
		}
		seen.add(entry.id);
		models.push(entry);
	}
	return { kind: "success", models, truncated, duplicates };
}

function isHtml(contentType: string | null | undefined, body: string): boolean {
	if (contentType?.toLowerCase().includes("text/html")) return true;
	return body.trimStart().startsWith("<");
}

/** 清单 JSON 形状：顶层数组，或 OpenAI 风格的 `data` 数组 */
function extractListItems(parsed: unknown): unknown[] | null {
	if (Array.isArray(parsed)) return parsed;
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		const data = (parsed as Record<string, unknown>).data;
		if (Array.isArray(data)) return data;
	}
	return null;
}

function toEntry(item: unknown): RawModelEntry | null {
	if (!item || typeof item !== "object" || Array.isArray(item)) return null;
	const raw = item as Record<string, unknown>;
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!id) return null;
	return { id, ...(typeof raw.name === "string" && raw.name.trim() ? { name: raw.name.trim() } : {}), raw };
}

export interface DiscoveryOptions {
	limits?: DiscoveryLimits;
	/** 外部取消（用户关面板/切 provider）；与总时限区分，分别报 aborted / timeout */
	signal?: AbortSignal;
}

/**
 * 按顺序执行候选请求并产出清单。
 *
 * 合法空清单也算成功；401/403、429、5xx、200 非清单 JSON、3xx、超时、取消与网络错误立即停止并报告，
 * 不当成路径错误去补试。404/405 与 200 HTML 只有在存在合法第二地址时才继续。
 */
export async function discoverModelList(
	baseUrl: string,
	api: string,
	request: DiscoveryRequest,
	options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
	const limits = options.limits ?? DEFAULT_DISCOVERY_LIMITS;
	const plan = resolveModelListPlan(baseUrl, api);
	if (!plan.ok) return { ok: false, reason: plan.reason, tried: [] };

	if (options.signal?.aborted) return { ok: false, reason: "aborted", tried: [] };

	const urls = plan.retry ? [plan.first, plan.retry] : [plan.first];
	const tried: TriedRequest[] = [];
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, limits.timeoutMs);
	const onCancel = () => controller.abort();
	options.signal?.addEventListener("abort", onCancel, { once: true });

	const stop = (path: string, reason: DiscoveryFailure): DiscoveryResult => {
		tried.push({ path, reason });
		return { ok: false, reason, tried };
	};

	try {
		for (let index = 0; index < urls.length; index++) {
			const url = urls[index];
			if (!url) break;
			const path = pathOf(url);
			let response: DiscoveryResponse;
			try {
				response = await request(url, { signal: controller.signal });
			} catch {
				return stop(path, timedOut ? "timeout" : controller.signal.aborted ? "aborted" : "network");
			}

			const hasAlternative = index + 1 < urls.length;
			const decision = evaluateResponse(response, limits, hasAlternative);
			if (decision.kind === "success") {
				const { models, truncated, duplicates } = decision;
				return { ok: true, path, models, truncated, duplicates, tried };
			}
			// 路径错误：记一笔继续试下一个地址；其余失败立即停
			if (decision.kind === "fail") return stop(path, decision.reason);
			tried.push({ path, reason: decision.reason });
		}
		return { ok: false, reason: "not-found", tried };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onCancel);
	}
}

// ---------------------------------------------------------------------------
// 上限字段（A1）
// ---------------------------------------------------------------------------

export type LimitWarningKind = "invalid" | "conflict" | "inconsistent";

export interface LimitWarning {
	/** invalid 记响应原始键；conflict / inconsistent 记候选名 */
	key: string;
	kind: LimitWarningKind;
}

/** 一个被接受的数值及其响应原始键（来源跟踪用）；不因冲突或一致性失败而丢弃 */
export interface LimitCandidate {
	key: string;
	value: number;
}

export interface ModelLimitParse {
	candidates: {
		/** 总上下文窗口 */
		contextWindow?: number;
		/** 仅输入上限：参考信息，不写入 SDK 模型配置、不代填总窗口 */
		inputLimit?: number;
		/** 最大输出 */
		maxTokens?: number;
	};
	sources: { contextWindow: LimitCandidate[]; inputLimit: LimitCandidate[]; maxTokens: LimitCandidate[] };
	warnings: LimitWarning[];
}

const WINDOW_KEYS = ["context_window", "context_length", "max_context_length"] as const;
const INPUT_KEY = "max_input_tokens";
const OUTPUT_KEY = "max_output_tokens";

/** 正安全整数，或去空白后全为十进制数字且落在安全整数范围内的字符串；其余一律无效 */
function coerceLimit(value: unknown): number | null {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value > 0 ? value : null;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!/^\d+$/.test(trimmed)) return null;
		const parsed = Number(trimmed);
		return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
	}
	return null;
}

/**
 * 从模型条目顶层字段解析上限候选。
 *
 * - 总窗口按同义键合并；有效值不同即冲突，不选较大/较小/第一个，留给用户确认。
 * - `max_input_tokens` 只作参考，不与输出上限相加，也不代填总窗口。
 * - 输入或输出单项大于总窗口时，两者都保留来源但不自动导入，不牵连未冲突字段。
 * - 缺键即没有可自动采用的值，不代填 SDK 缺省。
 */
export function parseModelLimits(entry: Record<string, unknown>): ModelLimitParse {
	const warnings: LimitWarning[] = [];
	const sources: ModelLimitParse["sources"] = { contextWindow: [], inputLimit: [], maxTokens: [] };
	const candidates: ModelLimitParse["candidates"] = {};

	for (const key of WINDOW_KEYS) {
		if (!(key in entry)) continue;
		const value = coerceLimit(entry[key]);
		if (value === null) {
			warnings.push({ key, kind: "invalid" });
			continue;
		}
		sources.contextWindow.push({ key, value });
	}
	const distinctWindows = new Set(sources.contextWindow.map((source) => source.value));
	if (distinctWindows.size > 1) {
		warnings.push({ key: "contextWindow", kind: "conflict" });
	} else if (distinctWindows.size === 1) {
		candidates.contextWindow = sources.contextWindow[0]?.value;
	}

	const input = parseSingle(entry, INPUT_KEY, "inputLimit", sources, warnings);
	const output = parseSingle(entry, OUTPUT_KEY, "maxTokens", sources, warnings);
	if (input !== undefined) candidates.inputLimit = input;
	if (output !== undefined) candidates.maxTokens = output;

	const window = candidates.contextWindow;
	if (window !== undefined) {
		const inputOverflows = input !== undefined && input > window;
		const outputOverflows = output !== undefined && output > window;
		if (inputOverflows || outputOverflows) {
			warnings.push({ key: "contextWindow", kind: "inconsistent" });
			delete candidates.contextWindow;
			if (inputOverflows) {
				warnings.push({ key: "inputLimit", kind: "inconsistent" });
				delete candidates.inputLimit;
			}
			if (outputOverflows) {
				warnings.push({ key: "maxTokens", kind: "inconsistent" });
				delete candidates.maxTokens;
			}
		}
	}

	return { candidates, sources, warnings };
}

function parseSingle(
	entry: Record<string, unknown>,
	rawKey: string,
	candidateKey: "inputLimit" | "maxTokens",
	sources: ModelLimitParse["sources"],
	warnings: LimitWarning[],
): number | undefined {
	if (!(rawKey in entry)) return undefined;
	const value = coerceLimit(entry[rawKey]);
	if (value === null) {
		warnings.push({ key: rawKey, kind: "invalid" });
		return undefined;
	}
	sources[candidateKey].push({ key: rawKey, value });
	return value;
}

/** 告警的可读形式：`<key>:<kind>`，用于日志与测试断言 */
export function formatLimitWarning(warning: LimitWarning): string {
	return `${warning.key}:${warning.kind}`;
}
