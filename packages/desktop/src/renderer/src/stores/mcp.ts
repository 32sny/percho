import {
	isMcpReconnectable,
	type McpConfigListResult,
	type McpGlobalNotice,
	type McpRuntimeInventory,
	type McpServersChangedPayload,
	type McpUpsertInput,
	projectMcpRuntime,
} from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { useToastsStore } from "./toasts";

/** 单台 server 的动作标识：实例 + 服务器名（重连/登录都按它去重） */
export function mcpActionKey(instanceId: string, name: string): string {
	return JSON.stringify([instanceId, name]);
}

interface McpStore {
	/** 最近一次 mcpConfigList 结果（null = 未加载；已按选中实例投影运行态） */
	config: McpConfigListResult | null;
	loading: boolean;
	/** 当前选中实例的官方全局提示 */
	notice?: McpGlobalNotice;
	/** 配置已落盘但进程未重载（只重启后生效） */
	restartRequired: boolean;
	/** 选中的运行实例：undefined = 自动（唯一候选），null = 用户明确不选 */
	selectedInstanceId: string | null | undefined;
	/** 单台重连的在途/失败状态，键见 mcpActionKey */
	reconnectActions: Readonly<Record<string, { instanceId: string; pending: boolean; error?: string }>>;
	load: (cwd?: string, activeSessionId?: string) => Promise<void>;
	selectInstance: (id: string | null) => void;
	/** 对选中实例里的单台 server 发起 OAuth 登录（/mcp login <name>） */
	login: (name: string) => Promise<void>;
	/** 新增/编辑配置：只落盘，不热应用（重启后生效） */
	upsert: (input: McpUpsertInput) => Promise<void>;
	/** 批量导入 JSON 配置（后端原子校验并写入全局 mcp.json） */
	importServers: (json: string, cwd?: string) => Promise<void>;
	remove: (input: { scope: "user" | "project"; cwd?: string; name: string }) => Promise<void>;
	/** 对选中实例里的单台 server 发起原生重连（/mcp reconnect <name>） */
	reconnect: (name: string) => Promise<void>;
	/** 事件入口（main 转发 `mcp:serversChanged`） */
	applyServersChanged: (payload: McpServersChangedPayload) => void;
}

/**
 * MCP 面板 store（单 local backend：没有 environment 分发）。
 *
 * 三条不变量：
 * - **运行态只有一份真源**：完整快照 `{epoch, revision, instances}`，配置查询与订阅事件共用同一修订，
 *   旧修订/旧 epoch 的迟到结果一律丢弃（否则刚重连成功的状态会被旧查询打回去）。
 * - **投影只在内存里做**：配置与快照经 `projectMcpRuntime` 合流，`config` 永远是「当前选中实例」的视图。
 * - **写盘不热应用**：upsert/import/remove 只把新配置落盘并标 `restartRequired`，连接状态保持不变；
 *   重连/登录是独立的运行态动作，不写配置。
 */
export function createMcpStore() {
	return create<McpStore>((set, get) => {
		let loadSeq = 0;
		let contextSeq = 0;
		let operationSeq = 0;
		/** 上一次失败的写盘动作可复用的重读（并发完成时以更新的那个为准） */
		let reconcileFailedOperation: (() => Promise<void>) | undefined;
		const reconcileAfterWrite = () => reconcileFailedOperation?.();
		const reconcileCurrentContext = () => reconcileAfterWrite() ?? get().load(contextCwd, activeSession);
		const retiredEpochs = new Set<string>();
		const reconnectPromises = new Map<string, Promise<void>>();
		let contextCwd: string | undefined;
		let runtime: McpRuntimeInventory | undefined;
		let eventSeq = 0;
		let activeSession: string | undefined;

		/** 实例消失/宿主重启后清掉该实例的所有动作状态（否则行上会留着永远不散的重连失败） */
		const pruneActions = (incoming: McpRuntimeInventory) => {
			const epochChanged = runtime && runtime.epoch !== incoming.epoch;
			const actions = { ...get().reconnectActions };
			let changed = false;
			for (const [key, action] of Object.entries(actions)) {
				if (
					epochChanged ||
					!incoming.instances.some(
						(instance) => instance.instanceId === action.instanceId && instance.available,
					)
				) {
					delete actions[key];
					reconnectPromises.delete(key);
					changed = true;
				}
			}
			if (changed) set({ reconnectActions: actions });
		};

		const project = (config: McpConfigListResult) => {
			if (!runtime) return config;
			let selected = get().selectedInstanceId;
			// 活动会话尚无 owner（只读会话/启动中）时禁止唯一候选回退，
			// 仍保留自动选择意图，以便该会话自己的实例稍后到达。
			const target =
				selected === undefined && activeSession
					? (runtime.instances.find(
							(instance) => instance.cwd === config.contextCwd && instance.sessionId === activeSession,
						)?.instanceId ?? null)
					: selected;
			const result = projectMcpRuntime(config, runtime, target);
			// 一旦选定就保留这个身份，即使该实例随后消失（否则会莫名跳回别的会话）。
			if (selected === undefined && result.selectedInstanceId) selected = result.selectedInstanceId;
			set({ selectedInstanceId: selected });
			return result;
		};

		/** 接收基线快照：同 epoch 只接受不旧于当前的 revision；跨 epoch 只接受由本代事件驱动的切换 */
		const acceptBase = (incoming: McpRuntimeInventory | undefined, startedAt: number) => {
			if (!incoming) return;
			if (retiredEpochs.has(incoming.epoch)) return;
			if (
				runtime &&
				((runtime.epoch === incoming.epoch && runtime.revision > incoming.revision) ||
					(runtime.epoch !== incoming.epoch && eventSeq !== startedAt))
			)
				return;
			if (runtime && runtime.epoch !== incoming.epoch) retiredEpochs.add(runtime.epoch);
			pruneActions(incoming);
			runtime = incoming;
		};

		const commit = (config: McpConfigListResult) => {
			const projected = project(config);
			set({
				config: projected,
				notice: projected.notice,
				restartRequired: projected.restartRequired === true,
			});
		};

		/** 所有写盘动作共用的顺序保护：后发起的操作赢，迟到的结果不覆盖新配置。 */
		const mutate = async (request: () => Promise<{ config: McpConfigListResult }>) => {
			const seq = contextSeq;
			const operation = ++operationSeq;
			reconcileFailedOperation = undefined;
			const startedAt = eventSeq;
			const cwd = contextCwd;
			const current = () => seq === contextSeq && operation === operationSeq;
			const recover = async () => {
				if (!current()) return;
				const read = ++loadSeq;
				try {
					const recoveryStartedAt = eventSeq;
					const config = await getPi().mcpConfigList({ cwd });
					if (current() && read === loadSeq) {
						acceptBase(config.runtime, recoveryStartedAt);
						commit(config);
						set({ loading: false });
					}
				} catch {
					// 读取失败也要结束自己这一代，否则被作废的那次 load 会一直挂着 loading。
					if (current() && read === loadSeq) set({ loading: false });
					// 保留写盘原始失败；另一次在途写入会再触发对账。
				}
			};
			let result: { config: McpConfigListResult };
			try {
				result = await request();
			} catch (error) {
				if (current()) reconcileFailedOperation = recover;
				await reconcileCurrentContext();
				throw error;
			}
			if (!current()) {
				// 更晚的预检可能在这次写入落地前就失败；等它结束后重读，不能丢掉「配置已变」的事实。
				await reconcileCurrentContext();
				return;
			}
			// 已确认的写盘优先于所有在它完成前发出的读取。
			loadSeq++;
			acceptBase(result.config.runtime, startedAt);
			commit(result.config);
			set({ loading: false });
		};

		return {
			config: null,
			loading: false,
			restartRequired: false,
			selectedInstanceId: undefined,
			reconnectActions: {},

			load: async (cwd, sessionId) => {
				const seq = ++loadSeq;
				const operation = operationSeq;
				if (contextSeq === 0 || contextCwd !== cwd || activeSession !== sessionId) {
					contextSeq++;
					reconcileFailedOperation = undefined;
					contextCwd = cwd;
					activeSession = sessionId;
					set({ config: null, notice: undefined, selectedInstanceId: undefined });
				}
				const startedAt = eventSeq;
				set({ loading: true });
				try {
					const config = await getPi().mcpConfigList({ cwd });
					if (seq !== loadSeq) return;
					if (operation !== operationSeq) {
						set({ loading: false });
						return;
					}
					acceptBase(config.runtime, startedAt);
					commit(config);
					set({ loading: false });
				} catch (error) {
					if (seq !== loadSeq) return;
					set({ loading: false });
					useToastsStore.getState().push("error", "toast.mcpLoadFailed");
					console.error("MCP 配置读取失败", error);
				}
			},

			selectInstance: (id) => {
				set({ selectedInstanceId: id });
				const config = get().config;
				if (config) commit(config);
			},

			login: async (name) => {
				const instanceId = get().selectedInstanceId;
				if (!instanceId) throw new Error("MCP instance is not selected");
				await getPi().mcpLogin({ instanceId, name });
			},

			upsert: (input) => mutate(() => getPi().mcpConfigUpsert(input)),

			importServers: (json, cwd) => mutate(() => getPi().mcpConfigImport({ json, cwd })),

			remove: (input) => mutate(() => getPi().mcpConfigRemove(input)),

			reconnect: (name) => {
				const instanceId = get().selectedInstanceId;
				const instance = runtime?.instances.find(
					(item) => item.instanceId === instanceId && item.cwd === get().config?.contextCwd,
				);
				if (!instanceId || !instance?.available)
					return Promise.reject(new Error("MCP instance or server is not available"));
				const key = mcpActionKey(instanceId, name);
				const existing = reconnectPromises.get(key);
				// 已受理的重连会短暂显示 connecting；调用方仍然 join 同一个结果。
				if (existing) return existing;
				if (!instance.servers.some((server) => server.name === name && isMcpReconnectable(server.state)))
					return Promise.reject(new Error("MCP instance or server is not available"));
				const promise = Promise.resolve()
					.then(() => getPi().mcpReconnect({ instanceId, name }))
					.then(
						() => {
							if (reconnectPromises.get(key) !== promise) return;
							const actions = { ...get().reconnectActions };
							delete actions[key];
							set({ reconnectActions: actions });
						},
						(error: unknown) => {
							if (reconnectPromises.get(key) === promise) {
								set({
									reconnectActions: {
										...get().reconnectActions,
										[key]: {
											instanceId,
											pending: false,
											error: error instanceof Error ? error.message : String(error),
										},
									},
								});
							}
							throw error;
						},
					)
					.finally(() => {
						if (reconnectPromises.get(key) === promise) reconnectPromises.delete(key);
					});
				reconnectPromises.set(key, promise);
				set({ reconnectActions: { ...get().reconnectActions, [key]: { instanceId, pending: true } } });
				return promise;
			},

			applyServersChanged: (payload) => {
				if (
					retiredEpochs.has(payload.epoch) ||
					(runtime?.epoch === payload.epoch && runtime.revision >= payload.revision)
				)
					return;
				if (runtime && runtime.epoch !== payload.epoch) retiredEpochs.add(runtime.epoch);
				pruneActions(payload);
				eventSeq++;
				runtime = payload;
				const config = get().config;
				if (config) commit(config);
			},
		};
	});
}

export const useMcpStore = createMcpStore();
