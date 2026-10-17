import {
	DefaultPackageManager,
	DefaultResourceLoader,
	getAgentDir,
	SettingsManager,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { createLogger } from "./log";

const log = createLogger("antigravity-prewarm");
const ANTIGRAVITY_ENTRY = /[\\/]pi-antigravity[\\/]src[\\/]index\.ts$/;

type ProviderRegistration = {
	name: string;
	config: Parameters<ModelRuntime["registerProvider"]>[1];
};

type ExtensionRuntimeWithRegistrations = {
	pendingProviderRegistrations?: ProviderRegistration[];
};

export interface AntigravityPrewarmDeps {
	getRuntime: () => Promise<ModelRuntime>;
	getAgentDir?: () => string;
	createPackageManager?: (agentDir: string) => Pick<DefaultPackageManager, "resolve">;
	createResourceLoader?: (agentDir: string, paths: string[]) => Pick<DefaultResourceLoader, "reload" | "getExtensions">;
}

/**
 * 启动时预加载用户已启用的 pi-antigravity provider。
 *
 * 这是桌面版原先通过 app.asar 补丁实现的行为，现直接落在 fork 源码里：
 * 只读用户级扩展配置，不加载会话/项目资源；预热失败只记录警告，正常会话仍可按需加载。
 */
export async function prewarmAntigravityProvider(deps: AntigravityPrewarmDeps): Promise<void> {
	const agentDir = (deps.getAgentDir ?? getAgentDir)();
	const settingsManager = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
	const packageManager =
		deps.createPackageManager?.(agentDir) ??
		new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager });
	const resources = await packageManager.resolve();
	const paths = resources.extensions.flatMap((entry) =>
		entry.enabled && ANTIGRAVITY_ENTRY.test(entry.path) ? [entry.path] : [],
	);
	if (paths.length === 0) return;

	const loader =
		deps.createResourceLoader?.(agentDir, paths) ??
		new DefaultResourceLoader({
			cwd: agentDir,
			agentDir,
			settingsManager,
			additionalExtensionPaths: paths,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
	await loader.reload();
	const result = loader.getExtensions();
	if (result.errors.length > 0) throw new Error(`extension load failed: ${result.errors.length} error(s)`);

	const registrations =
		(result.runtime as ExtensionRuntimeWithRegistrations).pendingProviderRegistrations?.filter(
			(entry) => entry.name === "antigravity",
		) ?? [];
	if (registrations.length === 0) throw new Error("provider registration was not found");

	const runtime = await deps.getRuntime();
	for (const registration of registrations) runtime.registerProvider(registration.name, registration.config);
	await runtime.refresh({ allowNetwork: false, providers: ["antigravity"] });
	log.info("Antigravity startup provider ready", { models: runtime.getModels("antigravity").length });
}

export function antigravityExtensionPath(path: string): boolean {
	return ANTIGRAVITY_ENTRY.test(path);
}
