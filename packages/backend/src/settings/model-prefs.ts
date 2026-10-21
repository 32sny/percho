import {
	isModelVisible,
	isThinkingLevel,
	type ModelPrefs,
	normalizeModelVisibility,
	withModelHidden,
	withModelsHidden,
	withProviderModelsHidden,
} from "@percho/shared";
import { JsonStore } from "../json-store";
import { createLogger } from "../log";

const log = createLogger("model-prefs");

/**
 * prefs 落盘成功后触发的旁路钩子（同一 enqueue 串行域内 await）。
 * 异常在服务内吞掉（log.warn）降级为告警，绝不让设置保存失败；null 表示删除键（跟随 agent 定义）。
 */
export interface ModelPrefsHooks {
	onSubagentModelChanged?: (agent: string, modelRef: string | null) => Promise<void>;
	onSubagentThinkingChanged?: (agent: string, level: string | null) => Promise<void>;
}

function copyPrefs(prefs: ModelPrefs): ModelPrefs {
	const copy: ModelPrefs = {
		...normalizeModelVisibility(prefs),
		subagentModels: { ...prefs.subagentModels },
	};
	// 可缺省字段：无非空内容时不写进 json（向后兼容旧文件；读侧仍视作缺省）
	if (prefs.subagentThinking && Object.keys(prefs.subagentThinking).length > 0) {
		copy.subagentThinking = { ...prefs.subagentThinking };
	}
	if (prefs.subagentPreferBuiltin !== undefined) copy.subagentPreferBuiltin = prefs.subagentPreferBuiltin;
	return copy;
}

function normalizeStringMap(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, item]) => {
			const cleanKey = key.trim();
			const cleanValue = typeof item === "string" ? item.trim() : "";
			return cleanKey && cleanValue ? [[cleanKey, cleanValue]] : [];
		}),
	);
}

/** 思考深度覆盖：先按 string map 规整（trim/丢空），再白名单过滤非 7 档脏值。 */
function normalizeThinkingMap(value: unknown): Record<string, string> {
	return Object.fromEntries(
		Object.entries(normalizeStringMap(value)).filter(([, level]) => isThinkingLevel(level)),
	);
}

/** 用户级模型偏好：全源默认策略/单模型例外 + 子代理偏好；服务内全部读改写串行。 */
export class ModelPrefsService {
	private cache: ModelPrefs | null = null;
	private pending: Promise<void> = Promise.resolve();

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.pending.then(operation);
		this.pending = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	private mutate(
		change: (prefs: ModelPrefs) => ModelPrefs,
		after?: () => Promise<void>,
	): Promise<ModelPrefs> {
		return this.enqueue(async () => {
			const prefs = copyPrefs(change(copyPrefs(await this.read())));
			await this.store().write(prefs);
			// 写成功才发布；失败时 cache 保留最后一次权威状态，队列仍可继续。
			this.cache = prefs;
			// hook 在同一串行域内 await（与后续读写有序）；异常吞掉降级为告警，不影响 mutate 返回值
			if (after) {
				try {
					await after();
				} catch (err) {
					log.warn("model prefs hook failed", err);
				}
			}
			return copyPrefs(prefs);
		});
	}

	constructor(
		private readonly configPath: string,
		private readonly hooks?: ModelPrefsHooks,
	) {}

	private store(): JsonStore<Partial<ModelPrefs>> {
		return new JsonStore<Partial<ModelPrefs>>({
			path: this.configPath,
			defaultValue: () => ({}),
		});
	}

	private async read(): Promise<ModelPrefs> {
		if (this.cache) return this.cache;
		// 损坏/缺失回退空配置（JsonStore 保证）；字段级规整仍在服务层
		const raw = await this.store().read();
		const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
		const thinking = normalizeThinkingMap(data.subagentThinking);
		const prefs: ModelPrefs = {
			...normalizeModelVisibility(data),
			subagentModels: normalizeStringMap(data.subagentModels),
		};
		if (Object.keys(thinking).length > 0) prefs.subagentThinking = thinking;
		// 非 boolean 脏值按缺省处理（读取方一律 `!== false` → true）
		if (typeof data.subagentPreferBuiltin === "boolean") {
			prefs.subagentPreferBuiltin = data.subagentPreferBuiltin;
		}
		this.cache = prefs;
		return prefs;
	}

	getPrefs(): Promise<ModelPrefs> {
		return this.enqueue(async () => copyPrefs(await this.read()));
	}

	async isModelHidden(provider: string, modelId: string): Promise<boolean> {
		return !isModelVisible(await this.getPrefs(), provider, modelId);
	}

	setModelHidden(provider: string, modelId: string, hidden: boolean): Promise<ModelPrefs> {
		return this.mutate((prefs) => withModelHidden(prefs, provider, modelId, hidden));
	}

	async setModelsHidden(provider: string, modelIds: string[], hidden: boolean): Promise<ModelPrefs> {
		const cleanProvider = provider.trim();
		if (!cleanProvider) throw new Error("provider is required");
		const ids = modelIds.map((id) => id.trim()).filter(Boolean);
		// 保留旧空批量零写盘语义，同时读取也排在先前修改之后。
		if (!ids.length) return this.getPrefs();
		return this.mutate((prefs) => withModelsHidden(prefs, cleanProvider, ids, hidden));
	}

	setProviderModelsHidden(provider: string, hidden: boolean): Promise<ModelPrefs> {
		return this.mutate((prefs) => withProviderModelsHidden(prefs, provider, hidden));
	}

	async setSubagentModel(agent: string, modelRef: string | null): Promise<ModelPrefs> {
		const cleanAgent = agent.trim();
		if (!cleanAgent) throw new Error("agent is required");
		const cleanModelRef = modelRef?.trim() ?? "";
		return this.mutate(
			(prefs) => {
				if (cleanModelRef) prefs.subagentModels[cleanAgent] = cleanModelRef;
				else delete prefs.subagentModels[cleanAgent];
				return prefs;
			},
			async () => {
				const hook = this.hooks?.onSubagentModelChanged;
				if (hook) await hook(cleanAgent, cleanModelRef || null);
			},
		);
	}

	async getSubagentModel(agent: string): Promise<string | undefined> {
		return (await this.getPrefs()).subagentModels[agent];
	}

	/** 设置页的思考深度覆盖；无键 = 跟随 agent 定义（undefined）。 */
	async getSubagentThinking(agent: string): Promise<string | undefined> {
		return (await this.getPrefs()).subagentThinking?.[agent];
	}

	async setSubagentThinking(agent: string, level: string | null): Promise<ModelPrefs> {
		const cleanAgent = agent.trim();
		if (!cleanAgent) throw new Error("agent is required");
		const cleanLevel = level?.trim() ?? "";
		if (cleanLevel && !isThinkingLevel(cleanLevel)) throw new Error(`invalid thinking level: ${cleanLevel}`);
		return this.mutate(
			(prefs) => {
				const thinking = { ...(prefs.subagentThinking ?? {}) };
				if (cleanLevel) thinking[cleanAgent] = cleanLevel;
				else delete thinking[cleanAgent];
				if (Object.keys(thinking).length > 0) prefs.subagentThinking = thinking;
				else delete prefs.subagentThinking;
				return prefs;
			},
			async () => {
				const hook = this.hooks?.onSubagentThinkingChanged;
				if (hook) await hook(cleanAgent, cleanLevel || null);
			},
		);
	}

	/** 内置 subagent 执行器优先；缺省/脏值一律 true（保持现状语义）。 */
	async getSubagentPreferBuiltin(): Promise<boolean> {
		return (await this.getPrefs()).subagentPreferBuiltin !== false;
	}

	async setSubagentPreferBuiltin(enabled: boolean): Promise<ModelPrefs> {
		return this.mutate((prefs) => {
			prefs.subagentPreferBuiltin = enabled;
			return prefs;
		});
	}
}
