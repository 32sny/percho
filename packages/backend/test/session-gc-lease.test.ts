import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	ExtensionFactory,
	LoadExtensionsResult,
	ModelRuntime,
	ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	createExtensionRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ControlSnapshot } from "@percho/shared";
import { afterEach, describe, expect, it } from "vitest";
import { PiBackend } from "../src/pi-backend";
import { createMessageControlAdapter, type MessageControlHandle } from "../src/session/message-control";
import type { RegisteredSession, SessionRegistry } from "../src/session/registry";
import {
	cleanupSdkTest,
	type Gate,
	gate,
	MODEL,
	requireControl,
	response,
	sdkFixture,
	textTurn,
	waitForCondition,
	withTimeout,
} from "./message-control-sdk-harness";

/**
 * GC（intent="gc"）宿主管会：SDK 1.5.1 的 `AgentSession.tryAcquireIdleLease()` 互锁。
 *
 * 风险（PLAN-sdk-1.5.1-upgrade §19.13.4）：`closeSession` 原有的 streaming/control/订阅预检与
 * `sessionDisposals` 合并都**不是同步**的——`emitSessionShutdown` 的 await 期间会话仍是空闲态，
 * 新的 `submitMessage` 可以进入并提交/启动一轮，随后被 dispose 掐断。上游 `87476fa` 的修法是在
 * **任何 await 之前**同步拿 SDK 空闲租约，`finally` 释放。
 *
 * 本文件分两层：
 * - 宿主 mock 单元：租约释放时序、dispose/emit 抛错时的事件顺序、delete/user 不受租约影响；
 * - 真实 PiBackend + 真实 AgentSession/MessageControl 集成：用真实扩展的 `session_shutdown`
 *   门闩把 GC 停在 await 上，再证明此后提交被拒、未提交 user、未发模型请求。
 *   另用真实 cache warming（公开配置 + 外部 stream 门闩）与真实异步准备验证 GC 不处置。
 */

const root = resolve("../../.local/tmp/session-gc-lease-tests");
mkdirSync(root, { recursive: true });

const localSessions = new Set<AgentSession>();
const localDirs = new Set<string>();
const backends = new Set<PiBackend>();

afterEach(async () => {
	// 先跑 harness 清理（释放门闩 + 恢复 timer + 收 harness 会话），再收本文件的局部 fixture：
	// 门闩必须先放，否则非合作流会让 waitForIdle/dispose 无界等待。
	await cleanupSdkTest();
	const errors: unknown[] = [];
	for (const backend of backends) {
		try {
			backend.dispose();
		} catch (error) {
			errors.push(error);
		}
	}
	backends.clear();
	for (const session of localSessions) {
		try {
			await withTimeout(session.waitForIdle(), 3000, "local session waitForIdle during cleanup");
		} catch (error) {
			errors.push(error);
		}
		try {
			session.dispose();
		} catch (error) {
			errors.push(error);
		}
	}
	localSessions.clear();
	for (const dir of localDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch (error) {
			errors.push(error);
		}
	}
	localDirs.clear();
	if (errors.length > 0) throw new AggregateError(errors, "session-gc-lease test cleanup failed");
});

function registryOf(backend: PiBackend): SessionRegistry {
	return (backend as unknown as { registry: SessionRegistry }).registry;
}

function stubSession(options: {
	order: string[];
	sessionId: string;
	lease?: () => { release(): void } | undefined;
	emit?: () => Promise<void>;
	dispose?: () => void;
	file?: string;
}): AgentSession {
	const { order, sessionId } = options;
	return {
		sessionId,
		isStreaming: false,
		sessionFile: options.file,
		sessionManager: {
			getSessionDir: () => root,
			getSessionFile: () => options.file,
		},
		extensionRunner: {
			emit: () => {
				order.push("emit");
				return options.emit ? options.emit() : Promise.resolve();
			},
		},
		dispose: () => {
			order.push("dispose");
			options.dispose?.();
		},
		// 生产路径直接调用（非可选）：GC 必须真的尝试取租约，不允许 `?.` 静默绕过。
		tryAcquireIdleLease: () => {
			order.push("lease:acquire");
			return options.lease?.();
		},
	} as unknown as AgentSession;
}

function stubBackend(config: {
	sessionId: string;
	order: string[];
	lease?: () => { release(): void } | undefined;
	emit?: () => Promise<void>;
	dispose?: () => void;
	file?: string;
	snapshot?: ControlSnapshot;
	topics?: string[];
}): { backend: PiBackend; registry: SessionRegistry; entry: RegisteredSession } {
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	backends.add(backend);
	const registry = registryOf(backend);
	const entry: RegisteredSession = {
		session: stubSession(config),
		unsubscribe: () => {},
		cwd: root,
		messageControl: config.snapshot
			? ({ getSnapshot: () => config.snapshot, dispose: () => {} } as unknown as MessageControlHandle)
			: undefined,
		gate: { dispose: () => {} },
		dialogs: { dispose: () => {} },
		modeRef: { current: "default" },
	} as unknown as RegisteredSession;
	registry.add(entry);
	if (config.topics?.length) backend.reportChannelSubscriptions(config.sessionId, new Set(config.topics));
	return { backend, registry, entry };
}

function recordingLease(order: string[]): { release(): void } {
	return {
		release: () => {
			order.push("lease:release");
		},
	};
}

/** 真实 SDK 会话挂进真实 PiBackend 的 registry（不经 openSession 的资源/扩展装配）。 */
function attachRealSession(
	backend: PiBackend,
	session: AgentSession,
	control: MessageControlHandle | undefined,
	cwd: string,
): RegisteredSession {
	const entry: RegisteredSession = {
		session,
		unsubscribe: () => {},
		cwd,
		messageControl: control,
		messageControlAdapter: control ? createMessageControlAdapter(control) : undefined,
		gate: { dispose: () => {} },
		dialogs: { dispose: () => {} },
		modeRef: { current: "default" },
	} as unknown as RegisteredSession;
	registryOf(backend).add(entry);
	return entry;
}

function submitRequest(session: AgentSession, control: MessageControlHandle, requestId: string) {
	return {
		sessionId: session.sessionId,
		runtimeId: control.getSnapshot().runtimeId,
		requestId,
		mode: "queue" as const,
		payload: { text: requestId },
	};
}

// ---------------------------------------------------------------------------
// 宿主 mock 单元：租约取放时序与既有守卫的相对顺序
// ---------------------------------------------------------------------------

describe("PiBackend.closeSession · GC 空闲租约（宿主单元）", () => {
	it("取不到租约 → closed=false、不 dispose、会话仍在 registry（生产路径直接调用，不做可选绕过）", async () => {
		const order: string[] = [];
		const { backend, registry } = stubBackend({ sessionId: "gc-busy", order, lease: () => undefined });

		await expect(backend.closeSession("gc-busy", "gc")).resolves.toEqual({ closed: false });

		expect(order).toEqual(["lease:acquire"]);
		expect(registry.has("gc-busy")).toBe(true);
	});

	it("取到租约 → 处置完成后才释放，且只释放一次", async () => {
		const order: string[] = [];
		const { backend, registry } = stubBackend({
			sessionId: "gc-ok",
			order,
			lease: () => recordingLease(order),
			emit: async () => {
				order.push("emit:resolved");
			},
		});

		await expect(backend.closeSession("gc-ok", "gc")).resolves.toEqual({ closed: true });

		expect(order).toEqual(["lease:acquire", "emit", "emit:resolved", "dispose", "lease:release"]);
		expect(registry.has("gc-ok")).toBe(false);
	});

	it("dispose 抛错 → 错误照旧上抛，租约仍在 finally 释放（不留永久占用）", async () => {
		const order: string[] = [];
		const failure = new Error("dispose exploded");
		const { backend, registry } = stubBackend({
			sessionId: "gc-dispose-throw",
			order,
			lease: () => recordingLease(order),
			dispose: () => {
				throw failure;
			},
		});

		await expect(backend.closeSession("gc-dispose-throw", "gc")).rejects.toBe(failure);
		expect(order.at(-1)).toBe("lease:release");
		expect(order.filter((step) => step === "lease:release")).toHaveLength(1);
		expect(registry.has("gc-dispose-throw")).toBe(false);
	});

	it("session_shutdown 派发失败不阻断清理，租约照样释放", async () => {
		const order: string[] = [];
		const { backend, registry } = stubBackend({
			sessionId: "gc-emit-throw",
			order,
			lease: () => recordingLease(order),
			emit: async () => {
				throw new Error("extension blew up");
			},
		});

		await expect(backend.closeSession("gc-emit-throw", "gc")).resolves.toEqual({ closed: true });
		expect(order).toEqual(["lease:acquire", "emit", "dispose", "lease:release"]);
		expect(registry.has("gc-emit-throw")).toBe(false);
	});

	it("并发第二次 GC：第一次仍持租约 → 第二次 closed=false（不排队等同一 disposal）", async () => {
		const order: string[] = [];
		const shutdown = gate();
		// 租约模型与真实 SDK 一致：已被持有期间再次 tryAcquire 返回 undefined
		let leased = false;
		const { backend, registry } = stubBackend({
			sessionId: "gc-race",
			order,
			lease: () => {
				if (leased) return undefined;
				leased = true;
				const lease = recordingLease(order);
				return {
					release: () => {
						leased = false;
						lease.release();
					},
				};
			},
			emit: async () => {
				await shutdown.promise;
			},
		});

		const first = backend.closeSession("gc-race", "gc");
		await waitForCondition(() => order.includes("emit"), 2000, "shutdown emit started");
		// 没租约互锁时第二个 close 会挂在同一个 disposal 上（超时即行为违约）
		await expect(
			withTimeout(backend.closeSession("gc-race", "gc"), 2000, "second gc close"),
		).resolves.toEqual({ closed: false });

		shutdown.resolve();
		await expect(first).resolves.toEqual({ closed: true });
		expect(registry.has("gc-race")).toBe(false);
	});

	it("频道订阅预检仍在租约之前：有订阅时 GC 直接拒绝，不取租约", async () => {
		const order: string[] = [];
		const { backend, registry } = stubBackend({
			sessionId: "gc-subs",
			order,
			topics: ["alpha"],
			lease: () => recordingLease(order),
		});

		await expect(backend.closeSession("gc-subs", "gc")).resolves.toEqual({ closed: false });
		expect(order).toEqual([]);
		expect(registry.has("gc-subs")).toBe(true);
	});

	it("message-control 预检（held user item）仍在租约之前：GC 直接拒绝，不取租约", async () => {
		const order: string[] = [];
		const { backend } = stubBackend({
			sessionId: "gc-held",
			order,
			lease: () => recordingLease(order),
			snapshot: {
				runtimeId: "runtime-held",
				revision: 3,
				phase: "idle",
				autoDispatchPaused: false,
				items: [
					{
						messageId: "m1",
						source: "user",
						mode: "queue",
						state: "held",
						preview: "held",
						imageCount: 0,
					},
				],
			},
		});

		await expect(backend.closeSession("gc-held", "gc")).resolves.toEqual({ closed: false });
		expect(order).toEqual([]);
	});

	it("用户主动关（intent=user / 缺省）不取租约：租约不可用也照样关", async () => {
		const order: string[] = [];
		const asUser = stubBackend({ sessionId: "user-close", order, lease: () => undefined });
		await expect(asUser.backend.closeSession("user-close", "user")).resolves.toEqual({ closed: true });
		expect(asUser.registry.has("user-close")).toBe(false);

		const asDefault = stubBackend({ sessionId: "default-close", order, lease: () => undefined });
		await expect(asDefault.backend.closeSession("default-close")).resolves.toEqual({ closed: true });
		expect(asDefault.registry.has("default-close")).toBe(false);
		// 两条路径都不应触碰租约
		expect(order).toEqual(["emit", "dispose", "emit", "dispose"]);
	});

	it("deleteSession 行为保持：租约不可用也照旧强拆（显式用户意图优先）", async () => {
		const order: string[] = [];
		const file = resolve(root, "delete-lease.jsonl");
		const { backend, registry } = stubBackend({
			sessionId: "delete-lease",
			order,
			file,
			lease: () => undefined,
		});

		await expect(backend.deleteSession("delete-lease", file)).resolves.toBeUndefined();

		expect(registry.has("delete-lease")).toBe(false);
		expect(order).toEqual(["emit", "dispose"]);
	});
});

// ---------------------------------------------------------------------------
// 真实 SDK 集成：GC 停在 session_shutdown 的 await 上，提交必须被租约挡住
// ---------------------------------------------------------------------------

async function gatedShutdownFixture(): Promise<{
	backend: PiBackend;
	session: AgentSession;
	control: MessageControlHandle;
	requests: unknown[][];
	entered: Gate<void>;
	release: Gate<void>;
}> {
	const entered = gate();
	const release = gate();
	const shutdownGate: ExtensionFactory = (pi) => {
		pi.on("session_shutdown", async () => {
			entered.resolve();
			await release.promise;
		});
	};
	const { session, dir, requests } = await sdkFixture({ extensions: [shutdownGate] });
	const control = requireControl(session);
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	backends.add(backend);
	attachRealSession(backend, session, control, dir);
	return { backend, session, control, requests, entered, release };
}

describe("真实 SDK · GC 租约与消息控制互锁", () => {
	it("[RED 主用例] GC 停在 shutdown await 后：真实 submit 被拒、user 未提交、无模型请求", async () => {
		const { backend, session, control, requests, entered, release } = await gatedShutdownFixture();

		const close = backend.closeSession(session.sessionId, "gc");
		await withTimeout(entered.promise, 5000, "session_shutdown handler entered");

		// 此处会话在 SDK 眼里仍“空闲”，修复前 submit 会被接受并真正启动一轮（随后被 dispose 掐断）
		const submitted = await backend.submitMessage(submitRequest(session, control, "gc-race-submit"));
		// soft 断言：修复前这里同时违约（submit 被接受 + 控制器登记了这条 user 输入），
		// 把竞争的完整证据留在 RED 日志里，而不是只停在第一条。
		expect.soft(submitted).toMatchObject({ ok: false, error: { code: "busy" } });
		expect.soft(control.getSnapshot().items).toHaveLength(0);

		release.resolve();
		await expect(close).resolves.toEqual({ closed: true });
		// 关闭完成后回看：这一轮到底有没有真的发出去 / 有没有把 user 写进会话。
		// 修复前实测：submit 被接受、user 已写进会话（随后被 dispose 掐断，模型请求还没发出）——
		// 这正是要消灭的竞争；修复后两条都必须是 0/无。
		expect.soft(requests).toHaveLength(0);
		expect.soft(session.messages.some((message) => message.role === "user")).toBe(false);
		// 关闭完成后提交是 not_found（会话已不在），不存在“提交成功后被悄悄丢掉”的中间态。
		const afterClose = await backend.submitMessage(submitRequest(session, control, "gc-race-after"));
		expect(afterClose).toMatchObject({ ok: false });
		expect((afterClose as { error: { code: string } }).error.code).toBe("not_found");
	});

	it("并发第二次 GC：第一次仍在处置 → 第二次 closed=false；第一次照常完成", async () => {
		const { backend, session, entered, release } = await gatedShutdownFixture();

		const first = backend.closeSession(session.sessionId, "gc");
		await withTimeout(entered.promise, 5000, "session_shutdown handler entered");

		await expect(
			withTimeout(backend.closeSession(session.sessionId, "gc"), 3000, "second gc close"),
		).resolves.toEqual({ closed: false });

		release.resolve();
		await expect(first).resolves.toEqual({ closed: true });
		expect(registryOf(backend).has(session.sessionId)).toBe(false);
	});

	it("真实异步准备（input 扩展门闩）pending：GC 拒绝处置，settle 后可正常卸载", async () => {
		const entered = gate();
		const release = gate();
		const inputGate: ExtensionFactory = (pi) => {
			pi.on("input", async () => {
				entered.resolve();
				await release.promise;
				return { action: "continue" };
			});
		};
		const { session, dir, requests } = await sdkFixture({ extensions: [inputGate] });
		const control = requireControl(session);
		const backend = new PiBackend({ projectTrust: false, permissionGates: false });
		backends.add(backend);
		attachRealSession(backend, session, control, dir);

		const pending = backend.submitMessage(submitRequest(session, control, "preparing"));
		await withTimeout(entered.promise, 5000, "input handler entered");

		await expect(backend.closeSession(session.sessionId, "gc")).resolves.toEqual({ closed: false });
		expect(registryOf(backend).has(session.sessionId)).toBe(true);
		expect(session.messages.some((message) => message.role === "user")).toBe(false);

		release.resolve();
		expect(await pending).toMatchObject({ ok: true });
		await control.waitForIdle();
		expect(requests).toHaveLength(1);

		await expect(backend.closeSession(session.sessionId, "gc")).resolves.toEqual({ closed: true });
		expect(registryOf(backend).has(session.sessionId)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 真实 SDK 缓存预热：公开配置 + 真实 CacheWarmer + 外部 stream 门闩（不造私有字段）
// ---------------------------------------------------------------------------

/**
 * 低于 10s 的 TTL 不会排预热；12s 会排出 2s 的刷新窗口（`min(0.9*ttl, ttl-10s)`），
 * 刷新截止还有 5s 余量，足够测试在真实定时器上等到 pending。
 */
const WARM_MODEL = {
	...MODEL,
	id: "session-gc-lease-warming",
	name: "session-gc-lease-warming",
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	promptCache: { short: 12 },
} as Model<"openai-completions">;

/** 预热门闩流：`getCacheWarmingRequestOptions` 把预热请求压到 maxTokens=1，据此分流。 */
function gatedWarmStream(
	entered: Gate<void>,
	release: Gate<void>,
	message: AssistantMessage,
): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
	stream.push({ type: "start", partial });
	void (async () => {
		entered.resolve();
		await release.promise;
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	})();
	return stream;
}

const EMPTY_RESOURCE_LOADER: Omit<ResourceLoader, "getExtensions"> = {
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

/**
 * 局部真实 fixture（不改共享 harness）：真实 `createAgentSession` + 真实 `CacheWarmer`
 * （由 SDK sdk.js 在会话请求里 `start`）。与 harness 的唯一差别是**不覆盖**
 * `agent.streamFunction`，改成在真实 `modelRuntime.streamSimple` 上接内存流——
 * 预热请求正是从这条公开路径发出的。
 */
async function warmingFixture(): Promise<{
	session: AgentSession;
	dir: string;
	warmEntered: Gate<void>;
	warmRelease: Gate<void>;
}> {
	const dir = mkdtempSync(`${root}/warming-`);
	localDirs.add(dir);
	const sessionManager = SessionManager.create(dir, dir);
	const warmEntered = gate();
	const warmRelease = gate();
	const extensions: LoadExtensionsResult = {
		extensions: [],
		errors: [],
		runtime: createExtensionRuntime(),
	};
	const modelRuntime = {
		getModel: () => WARM_MODEL,
		hasConfiguredAuth: () => true,
		checkAuth: async () => ({ type: "api_key", key: "test-key" }),
		getAuth: async () => undefined,
		isUsingOAuth: () => false,
		getAvailableSnapshot: () => [WARM_MODEL],
		streamSimple: (
			_model: Model<"openai-completions">,
			_context: unknown,
			options: { maxTokens?: number },
		) =>
			options?.maxTokens === 1
				? gatedWarmStream(warmEntered, warmRelease, textTurn("warm", 1_000_000, WARM_MODEL))
				: response(textTurn("done", 1_000_000, WARM_MODEL)),
	} as unknown as ModelRuntime;
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: WARM_MODEL,
		modelRuntime,
		sessionManager,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "idle",
		}),
		resourceLoader: { ...EMPTY_RESOURCE_LOADER, getExtensions: () => extensions },
		tools: [],
		customTools: [],
	});
	localSessions.add(session);
	return { session, dir, warmEntered, warmRelease };
}

describe("真实 SDK · 缓存预热 pending 时 GC 不处置", () => {
	it("预热已排程/在飞（公开状态）→ GC 拒绝；关掉预热后 GC 可正常卸载", async () => {
		const { session, dir, warmEntered, warmRelease } = await warmingFixture();
		await session.prompt("keep the prompt cache warm");

		// 公开状态：真实 CacheWarmer 已为这次请求排了刷新
		await waitForCondition(
			() => session.cacheWarmingStatus?.state === "scheduled",
			8000,
			"cache warming scheduled",
		);
		expect(session.cacheWarmingStatus?.state).toBe("scheduled");

		const backend = new PiBackend({ projectTrust: false, permissionGates: false });
		backends.add(backend);
		attachRealSession(backend, session, undefined, dir);

		// 排程中的预热也算 pending work：租约必须取不到，GC 不得处置
		expect(session.tryAcquireIdleLease()).toBeUndefined();
		await expect(backend.closeSession(session.sessionId, "gc")).resolves.toEqual({ closed: false });
		expect(registryOf(backend).has(session.sessionId)).toBe(true);

		// 等真实预热请求真正在飞（外部 stream 门闩让它停住）
		await withTimeout(warmEntered.promise, 12_000, "cache warming refresh stream entered");
		expect(session.cacheWarmingStatus?.state).toBe("refreshing");
		expect(session.tryAcquireIdleLease()).toBeUndefined();
		await expect(backend.closeSession(session.sessionId, "gc")).resolves.toEqual({ closed: false });
		expect(registryOf(backend).has(session.sessionId)).toBe(true);
		expect(session.cacheWarmingStatus?.state).toBe("refreshing");

		// 放行预热 → 关掉预热（公开设置入口）→ 租约可取 → GC 正常卸载
		warmRelease.resolve();
		await waitForCondition(
			() => {
				const status = session.cacheWarmingStatus;
				return status?.state === "scheduled" || status?.state === "inactive";
			},
			8000,
			"cache warming refresh settled",
		);
		session.setCacheWarmingMode("off");
		await waitForCondition(
			() => {
				// 探针必须随手释放，否则探针自己会挡住后面的 GC 取租约
				const lease = session.tryAcquireIdleLease();
				if (!lease) return false;
				lease.release();
				return true;
			},
			8000,
			"idle lease available after warming off",
		);

		await expect(backend.closeSession(session.sessionId, "gc")).resolves.toEqual({ closed: true });
		expect(registryOf(backend).has(session.sessionId)).toBe(false);
	});

	it("用户主动关不受租约约束：预热 pending 时 intent=user 照样关（行为保持）", async () => {
		const { session, dir } = await warmingFixture();
		await session.prompt("keep the prompt cache warm");
		await waitForCondition(
			() => session.cacheWarmingStatus?.state === "scheduled",
			8000,
			"cache warming scheduled",
		);

		const backend = new PiBackend({ projectTrust: false, permissionGates: false });
		backends.add(backend);
		attachRealSession(backend, session, undefined, dir);

		expect(session.tryAcquireIdleLease()).toBeUndefined();
		await expect(backend.closeSession(session.sessionId, "user")).resolves.toEqual({ closed: true });
		expect(registryOf(backend).has(session.sessionId)).toBe(false);
	});
});

describe("PiBackend 实例清理", () => {
	it("backend.dispose() 后无残留 registry（fixture 收尾自检）", () => {
		const order: string[] = [];
		const { backend, registry } = stubBackend({
			sessionId: "dispose-check",
			order,
			lease: () => recordingLease(order),
		});
		expect(registry.list()).toHaveLength(1);
		backend.dispose();
		backends.delete(backend);
		expect(registry.list()).toHaveLength(0);
	});
});
