import { join } from "node:path";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { JsonStore } from "../json-store";

function configStore(agentDir: string) {
	return new JsonStore<{ enabled?: boolean; only?: boolean }>({
		path: join(agentDir, "codemode.json"),
		defaultValue: () => ({}),
		parse: (raw) => {
			const value = JSON.parse(raw);
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new Error("Code Mode 配置必须是对象");
			return value;
		},
	});
}

export function readCodemodeConfig(agentDir: string): { enabled: boolean; only: boolean } {
	const config = configStore(agentDir).readSync();
	return { enabled: config.enabled !== false, only: config.only === true };
}

export function readCodemodeEnabled(agentDir: string): boolean {
	return readCodemodeConfig(agentDir).enabled;
}

export async function writeCodemodeOnly(agentDir: string, only: boolean): Promise<void> {
	await configStore(agentDir).update((draft) => {
		draft.only = only;
	});
}

export async function writeCodemodeEnabled(agentDir: string, enabled: boolean): Promise<void> {
	await configStore(agentDir).update((draft) => {
		draft.enabled = enabled;
	});
}

/** 无用户工具配置时补充只读辅助工具；保留显式选择，另应用 Code Mode 开关。 */
export function codemodeSessionOptions(settings: SettingsManager, agentDir: string) {
	const enabled = readCodemodeEnabled(agentDir);
	const defaults = settings.getDefaultTools();
	const codemodeModifier = enabled ? "+codemode" : "-codemode";
	settings.applyOverrides({
		defaultTools: defaults
			? [...defaults.filter((name) => name !== "codemode"), ...(enabled ? ["codemode"] : [])]
			: ["+grep", "+find", "+ls", codemodeModifier],
	});
	return { excludeTools: enabled ? undefined : ["codemode"] };
}

/**
 * 重开会话后按当前开关校正 codemode 激活。
 *
 * 两个 SDK 事实让 `defaultTools` 不够用：
 * 1. 有转录记录的会话以**转录里的工具集**为准，`defaultTools` 只影响内置工具；
 * 2. codemode 以 `defaultActive: false` 注册，不随注册自动激活。
 * 结果：旧会话重开后完全拿不到 codemode，而独占模式靠 codemode 的 `prepareLoadout` 隐藏其他
 * 工具声明，也跟着失效。开关关闭时不必处理：`codemodeSessionOptions` 已用 `excludeTools` 阻止注册。
 *
 * @returns 是否真的改了激活集合（供测试断言）
 */
export function ensureCodemodeActive(
	session: {
		getActiveToolNames(): string[];
		getAllTools(): { name: string }[];
		setActiveToolsByName(names: string[]): void;
	},
	agentDir: string,
): boolean {
	if (!readCodemodeEnabled(agentDir)) return false;
	const active = session.getActiveToolNames();
	if (active.includes("codemode")) return false;
	if (!session.getAllTools().some((tool) => tool.name === "codemode")) return false;
	session.setActiveToolsByName([...active, "codemode"]);
	return true;
}
