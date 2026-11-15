import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	ImageContent,
	Message,
	Model,
	SystemMessage,
	TextContent,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	CompactionPause,
	CompactionRequestPolicy,
	ExtensionFactory,
	LoadExtensionsResult,
	ModelRuntime,
	ResourceLoader,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	createEventBus,
	createExtensionRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import type { MessageControlHandle } from "../src/session/message-control";

/**
 * P1-5 测试准备共享设施：只提供真实 SDK 会话、内存模型流、门闩与清理。
 * 这里不实现、不代理、也不模拟消息控制器。
 */

export const MODEL = {
	id: "message-control-test",
	name: "message-control-test",
	provider: "test",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<"openai-completions">;

/**
 * 20k 上下文、完整 usage 的压缩 fixture 专用模型。
 *
 * `input` 含 `image`：托管控制器的 `image_unsupported` 校验读的是真实 `session.model.input`，
 * 图片载荷用例必须能走真实归一化/投递路径，不能靠放宽断言绕过。
 */
export const MODEL_20K = {
	...MODEL,
	id: "message-control-compaction-test",
	name: "message-control-compaction-test",
	input: ["text", "image"],
	contextWindow: 20_000,
} as Model<"openai-completions">;

export const BLOCKED_MISSING_API = "BLOCKED_MISSING_API";

/** 压缩摘要请求的系统提示标记（真实 SDK 的摘要助手提示词）。 */
export const SUMMARY_MARKER = "context summarization assistant";

const controls = new Set<MessageControlHandle>();

/**
 * 接口就绪性检查：只检查真实函数是否存在。
 * 缺失时抛出明确的 BLOCKED 诊断，绝不返回 mock handle，也不把缺失写进 expect/skip。
 */
export function requireControl(session: AgentSession): MessageControlHandle {
	const candidate = session as AgentSession & {
		enableMessageControl?: () => MessageControlHandle;
	};
	if (typeof candidate.enableMessageControl !== "function") {
		throw new Error(
			`${BLOCKED_MISSING_API}: AgentSession.enableMessageControl is not implemented by the installed SDK. ` +
				"P1-6 must restore the real message control before this contract can execute.",
		);
	}
	const handle = candidate.enableMessageControl();
	// 真实 handle 统一交给 cleanupSdkTest 有界等待并 dispose；测试无需各自收尾。
	controls.add(handle);
	return handle;
}

export interface Gate<T = void> {
	readonly promise: Promise<T>;
	readonly released: boolean;
	resolve(value: T): void;
}

const gates = new Set<Gate<unknown>>();

/** 门闩，用于在真实 await 点暂停；清理阶段统一释放，避免非合作工具永久等待。 */
export function gate<T = void>(): Gate<T> {
	let settle!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		settle = r;
	});
	const g: Gate<T> = {
		promise,
		released: false,
		resolve: (value: T) => {
			if (g.released) return;
			(g as { released: boolean }).released = true;
			settle(value);
		},
	};
	gates.add(g as Gate<unknown>);
	return g;
}

export async function waitForCondition(predicate: () => boolean, ms: number, label: string): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > ms) throw new Error(`Timed out after ${ms}ms: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

export type HostPauseStatus = CompactionPause["reason"];
export type HostResultStatus = HostPauseStatus | "success" | "cancelled";

export interface HostResultRecord {
	status: HostResultStatus;
	errorMessage?: string;
	tokens?: number;
	contextWindow?: number;
	thresholdTokens?: number;
}

export interface HostPolicyOptions {
	enabled?: boolean;
	/** 与主会话宿主策略一致的默认线：80% 与 reserve 取较小值。 */
	thresholdPct?: number;
	/** success/cancelled 不暂停，其余结果默认 paused。 */
	pauseOn?: readonly HostPauseStatus[];
	onResult?: (result: HostResultRecord) => void;
}

export interface HostPolicyFixture {
	policy: CompactionRequestPolicy;
	calls: HostResultRecord[];
	setEnabled(value: boolean): void;
	setThresholdPct(value: number): void;
}

const DEFAULT_HOST_PAUSE: readonly HostPauseStatus[] = [
	"failed",
	"still-over-threshold",
	"nothing-to-compact",
	"context-changed",
];

/**
 * 真实宿主策略（主会话 request-policy 的同形 fixture）：经公开 `setCompactionPolicy` 安装，
 * 不替换 SDK 的阈值/压缩入口。成功后恢复、失败类结果暂停，由 SDK 在下一请求前触发。
 */
export function installHostPolicy(session: AgentSession, options: HostPolicyOptions = {}): HostPolicyFixture {
	let enabled = options.enabled ?? true;
	let thresholdPct = options.thresholdPct ?? 80;
	const pauseOn = new Set(options.pauseOn ?? DEFAULT_HOST_PAUSE);
	const calls: HostResultRecord[] = [];
	const policy: CompactionRequestPolicy = {
		enabled: () => enabled,
		evaluate: ({ tokens, contextWindow, settings }) => {
			if (!Number.isFinite(contextWindow) || contextWindow <= 0 || !Number.isFinite(tokens)) {
				return { trigger: false, thresholdTokens: 0 };
			}
			const thresholdTokens = Math.max(
				0,
				Math.min(Math.ceil((contextWindow * thresholdPct) / 100), contextWindow - settings.reserveTokens + 1),
			);
			return { trigger: tokens >= thresholdTokens, thresholdTokens };
		},
		onResult: (result) => {
			const record = { ...result } as HostResultRecord;
			calls.push(record);
			options.onResult?.(record);
			if (!pauseOn.has(record.status as HostPauseStatus)) return null;
			return { reason: record.status as HostPauseStatus, ...result };
		},
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
	};
	session.setCompactionPolicy(policy);
	return {
		policy,
		calls,
		setEnabled: (value) => {
			enabled = value;
		},
		setThresholdPct: (value) => {
			thresholdPct = value;
		},
	};
}

const sessions = new Set<AgentSession>();
const dirs = new Set<string>();
const extraCleanups: Array<() => void> = [];

export function registerCleanup(cleanup: () => void): void {
	extraCleanups.push(cleanup);
}

export function assistantTurn(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	model: Model<"openai-completions"> = MODEL,
): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		stopReason,
		content,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/** 文本助手回复；可指定 usage 总量与模型，用于真实压缩阈值/溢出。 */
export function textTurn(
	text: string,
	totalTokens = 2,
	model: Model<"openai-completions"> = MODEL,
): AssistantMessage {
	const turn = assistantTurn([{ type: "text", text }], "stop", model);
	if (totalTokens !== 2) {
		turn.usage = {
			...turn.usage,
			input: totalTokens,
			output: 0,
			totalTokens,
		};
	}
	return turn;
}

/**
 * 真实 `AssistantMessageEventStream` 契约：`start` → 终止事件 → `end`。
 * 正常结束使用带 `reason` 的 `done`（含 toolUse/length/deferred）；
 * error/aborted 按协议走 `error` 事件，`pending` 视为 fixture 缺陷直接抛出。
 */
export function response(message: AssistantMessage): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
	stream.push({ type: "start", partial });
	const reason = message.stopReason;
	if (reason === "error" || reason === "aborted") {
		stream.push({ type: "error", reason, error: message });
	} else if (reason === "pending") {
		throw new Error("response fixture ended without a stop reason");
	} else {
		stream.push({ type: "done", reason, message });
	}
	stream.end(message);
	return stream;
}

/** 用户/系统消息内容可能是纯字符串或内容块数组，统一取文本。 */
export function messageText(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

/**
 * SDK `normalizeContext()` 之后没有 `context.systemPrompt`：
 * 系统提示是 `context.messages` 里的首条 system 消息。压缩摘要请求只能这样识别。
 */
export function isSummaryRequest(context: { readonly messages: readonly Message[] }): boolean {
	const system = context.messages.find((message): message is SystemMessage => message.role === "system");
	return system ? messageText(system.content).includes(SUMMARY_MARKER) : false;
}

/** `getExtensions` 由 fixture 按需覆盖（内联扩展），其余资源保持空实现。 */
const BASE_RESOURCE_LOADER: Omit<ResourceLoader, "getExtensions"> = {
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => "Test assistant",
	getSystemPromptSource: () => undefined,
	getAppendSystemPrompt: () => [],
	getAppendSystemPromptSources: () => [],
	extendResources: () => {},
	reload: async () => {},
};

export interface SdkFixtureOptions {
	tools?: ToolDefinition[];
	model?: Model<"openai-completions">;
	/**
	 * 真实内联扩展工厂。经 SDK 自带 `loadExtensionFromFactory` 加载，用真实扩展命令/事件回调
	 * 作为门闩；不手工构造 Extension，也不替换 ExtensionRunner。
	 */
	extensions?: ExtensionFactory[];
	/** 在创建会话前写入真实 SessionManager 历史（含完整 usage）。 */
	history?: (manager: SessionManager) => void;
	settings?: Parameters<typeof SettingsManager.inMemory>[0];
	/** false 时 prompt() 会真正 await modelRuntime.checkAuth()。 */
	hasConfiguredAuth?: boolean;
	manager?: SessionManager;
	/** 为 true 时不安装默认内存流；由测试自行安装摘要/工具感知流。 */
	noDefaultStream?: boolean;
}

export interface SdkFixture {
	session: AgentSession;
	sessionManager: SessionManager;
	dir: string;
	model: Model<"openai-completions">;
	/** 每次模型请求的 context.messages 快照（默认流自动记录）。 */
	requests: unknown[][];
}

/** 真实 AgentSession + 真 SessionManager；模型传输由内存流替代，不联网、不用凭证。 */
export async function sdkFixture(options: SdkFixtureOptions = {}): Promise<SdkFixture> {
	const root = resolve("../../.local/tmp/message-control-sdk-tests");
	mkdirSync(root, { recursive: true });
	const dir = mkdtempSync(`${root}/case-`);
	dirs.add(dir);
	const model = options.model ?? MODEL;
	const sessionManager = options.manager ?? SessionManager.create(dir, dir);
	options.history?.(sessionManager);
	const requests: unknown[][] = [];
	const extensionsResult = options.extensions?.length
		? await loadInlineExtensions(options.extensions, dir)
		: ({ extensions: [], errors: [], runtime: createExtensionRuntime() } satisfies LoadExtensionsResult);
	const modelRuntime = {
		getModel: () => model,
		hasConfiguredAuth: () => options.hasConfiguredAuth ?? true,
		checkAuth: async () => ({ type: "api_key", key: "test-key" }),
		getAuth: async () => undefined,
		isUsingOAuth: () => false,
		getAvailableSnapshot: () => [model],
	} as unknown as ModelRuntime;
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model,
		modelRuntime,
		sessionManager,
		settingsManager: SettingsManager.inMemory(
			options.settings ?? {
				compaction: { enabled: false },
				retry: { enabled: false },
				cacheWarming: "off",
			},
		),
		resourceLoader: { ...BASE_RESOURCE_LOADER, getExtensions: () => extensionsResult },
		tools: (options.tools ?? []).map((tool) => tool.name),
		customTools: options.tools ?? [],
	});
	sessions.add(session);
	const tools = options.tools ?? [];
	if (tools.length) session.setActiveToolsByName(tools.map((tool) => tool.name));
	if (!options.noDefaultStream) {
		session.agent.streamFunction = (_model, context) => {
			requests.push(structuredClone(context.messages));
			return response(textTurn("done"));
		};
	}
	return { session, sessionManager, dir, model, requests };
}

/**
 * SDK 根导出没有暴露扩展 loader：这里用 SDK 自身的 loader 模块加载真实内联扩展。
 * 只注入扩展注册（命令/事件回调），不触碰运行入口、队列或控制器。
 */
async function loadInlineExtensions(
	factories: ExtensionFactory[],
	cwd: string,
): Promise<LoadExtensionsResult> {
	const loader = (await import(resolveExtensionLoaderUrl())) as unknown as {
		createExtensionRuntime: () => LoadExtensionsResult["runtime"];
		loadExtensionFromFactory: (
			factory: ExtensionFactory,
			cwd: string,
			eventBus: ReturnType<typeof createEventBus>,
			runtime: LoadExtensionsResult["runtime"],
			extensionPath?: string,
		) => Promise<LoadExtensionsResult["extensions"][number]>;
	};
	const runtime = loader.createExtensionRuntime();
	const eventBus = createEventBus();
	const extensions: LoadExtensionsResult["extensions"] = [];
	for (const [index, factory] of factories.entries()) {
		extensions.push(
			await loader.loadExtensionFromFactory(factory, cwd, eventBus, runtime, `<inline:test-${index + 1}>`),
		);
	}
	return { extensions, errors: [], runtime };
}

/** 从测试文件位置向上找已安装的 SDK loader 文件（兼容 hoist 与嵌套 node_modules）。 */
function resolveExtensionLoaderUrl(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 8; depth++) {
		const candidate = resolve(
			dir,
			"node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",
		);
		if (existsSync(candidate)) return pathToFileURL(candidate).href;
		dir = dirname(dir);
	}
	throw new Error(
		"BLOCKED_MISSING_API: cannot locate the installed pi-coding-agent extension loader for inline extensions.",
	);
}

/**
 * 统一 afterEach 清理：先恢复真实 timer / 释放门闩，再恢复 spy、等待有界空闲、
 * dispose 会话并删除临时目录。任一清理步骤失败都会以 AggregateError 暴露。
 */
export async function cleanupSdkTest(): Promise<void> {
	const errors: unknown[] = [];
	const attempt = (label: string, fn: () => unknown) => {
		try {
			fn();
		} catch (error) {
			errors.push(new Error(`${label}: ${describeError(error)}`, { cause: error }));
		}
	};
	if (vi.isFakeTimers()) attempt("restore real timers", () => vi.useRealTimers());
	for (const g of gates) {
		// 只释放门闩；清理不 await 业务续体。
		attempt("release gate", () => {
			void g.resolve(undefined);
		});
	}
	gates.clear();
	for (const cleanup of extraCleanups.splice(0).reverse()) attempt("extra cleanup", cleanup);
	attempt("restore mocks", () => vi.restoreAllMocks());
	for (const control of controls) {
		await (async () => {
			try {
				await withTimeout(control.waitForIdle(), 3000, "control.waitForIdle during cleanup");
			} catch (error) {
				errors.push(
					new Error(`control.waitForIdle during cleanup: ${describeError(error)}`, { cause: error }),
				);
			}
			try {
				control.dispose();
			} catch (error) {
				errors.push(new Error(`dispose control: ${describeError(error)}`, { cause: error }));
			}
		})();
	}
	controls.clear();
	for (const session of sessions) {
		await (async () => {
			try {
				await withTimeout(session.waitForIdle(), 3000, "session.waitForIdle during cleanup");
			} catch (error) {
				errors.push(new Error(`waitForIdle during cleanup: ${describeError(error)}`, { cause: error }));
			}
			try {
				session.dispose();
			} catch (error) {
				errors.push(new Error(`dispose session: ${describeError(error)}`, { cause: error }));
			}
		})();
	}
	sessions.clear();
	for (const dir of dirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch (error) {
			errors.push(new Error(`remove temp dir: ${describeError(error)}`, { cause: error }));
		}
	}
	dirs.clear();
	if (errors.length > 0) {
		throw new AggregateError(errors, "message-control SDK test cleanup failed");
	}
}

export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
