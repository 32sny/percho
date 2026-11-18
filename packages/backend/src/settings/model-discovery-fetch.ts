/**
 * 模型清单发现的 HTTP 适配器：把 fetch 包成 `DiscoveryRequest`。
 *
 * 只做三件事——注入凭证、按字节上限有界读取响应体、禁止跨源重定向；
 * 端点选择、重试判定与字段解析都在 model-discovery.ts 里。凭证不进请求路径、
 * 不进错误文案，也不出现在任何返回值里；调用方不应记录本模块的参数。
 */
import {
	DEFAULT_DISCOVERY_LIMITS,
	type DiscoveryLimits,
	type DiscoveryRequest,
	type DiscoveryResponse,
	type DiscoveryResult,
	discoverModelList,
} from "./model-discovery";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface DiscoveryRequestConfig {
	/** 明文 key 只在内存里拼 Authorization 头；不得写日志、不得随结果返回 */
	apiKey?: string | null;
	/** 读取阶段的字节上限；应与 discoverModelList 的 limits.maxBytes 一致 */
	maxBytes?: number;
	fetchImpl?: FetchLike;
}

async function readBounded(
	response: Response,
	maxBytes: number,
): Promise<{ body: string; tooLarge: boolean }> {
	const stream = response.body;
	if (!stream) {
		const text = await response.text();
		return { body: text, tooLarge: Buffer.byteLength(text, "utf8") > maxBytes };
	}
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				return { body: "", tooLarge: true };
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return { body: Buffer.concat(chunks).toString("utf8"), tooLarge: false };
}

/** 构造可注入给 `discoverModelList` 的请求函数 */
export function makeDiscoveryRequest(config: DiscoveryRequestConfig = {}): DiscoveryRequest {
	const fetchImpl = config.fetchImpl ?? ((input, init) => fetch(input, init));
	const maxBytes = config.maxBytes ?? DEFAULT_DISCOVERY_LIMITS.maxBytes;
	const apiKey = config.apiKey?.trim();

	return async (url, { signal }): Promise<DiscoveryResponse> => {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		const response = await fetchImpl(url, {
			method: "GET",
			headers,
			signal,
			// 不跟随 3xx：既避免带着凭证跳到别的源，也让「重定向」如实上报
			redirect: "manual",
		});
		const { body, tooLarge } = await readBounded(response, maxBytes);
		return {
			status: response.status,
			contentType: response.headers.get("content-type"),
			body,
			...(tooLarge ? { bodyTooLarge: true } : {}),
		};
	};
}

export interface DiscoverProviderModelsOptions {
	limits?: DiscoveryLimits;
	signal?: AbortSignal;
	fetchImpl?: FetchLike;
}

/**
 * 对一个自定义 provider 执行一次模型清单发现。
 *
 * 纯读取：不写配置、不改 provider、失败时也不改动任何既有模型定义。
 */
export async function discoverProviderModels(
	provider: { baseUrl: string; api: string; apiKey?: string | null },
	options: DiscoverProviderModelsOptions = {},
): Promise<DiscoveryResult> {
	const limits = options.limits ?? DEFAULT_DISCOVERY_LIMITS;
	const request = makeDiscoveryRequest({
		apiKey: provider.apiKey,
		maxBytes: limits.maxBytes,
		fetchImpl: options.fetchImpl,
	});
	return discoverModelList(provider.baseUrl, provider.api, request, { limits, signal: options.signal });
}
