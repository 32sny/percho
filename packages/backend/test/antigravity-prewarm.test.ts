import { describe, expect, it, vi } from "vitest";
import { antigravityExtensionPath, prewarmAntigravityProvider } from "../src/antigravity-prewarm";

function runtime() {
	return {
		registerProvider: vi.fn(),
		refresh: vi.fn(async () => undefined),
		getModels: vi.fn(() => [{ id: "gemini-3.1-pro" }]),
	} as never;
}

describe("Antigravity startup prewarm", () => {
	it("recognizes only the pi-antigravity extension entry", () => {
		expect(antigravityExtensionPath("C:/agent/pi-antigravity/src/index.ts")).toBe(true);
		expect(antigravityExtensionPath("C:/agent/pi-antigravity/src/other.ts")).toBe(false);
		expect(antigravityExtensionPath("C:/agent/other-extension/src/index.ts")).toBe(false);
	});

	it("loads enabled Antigravity registrations into the shared runtime", async () => {
		const sharedRuntime = runtime();
		const reload = vi.fn(async () => undefined);
		const getExtensions = vi.fn(() => ({
			extensions: [],
			errors: [],
			runtime: {
				pendingProviderRegistrations: [
					{ name: "antigravity", config: { api: "custom" } },
					{ name: "other", config: {} },
				],
			},
		}));
		const createResourceLoader = vi.fn(() => ({ reload, getExtensions }));
		const createPackageManager = vi.fn(() => ({
			resolve: async () => ({
				extensions: [
					{ enabled: true, path: "C:/agent/pi-antigravity/src/index.ts" },
					{ enabled: false, path: "C:/agent/pi-antigravity/src/index.ts" },
					{ enabled: true, path: "C:/agent/other/src/index.ts" },
				],
				skills: [],
				prompts: [],
				themes: [],
			}),
		}));

		await prewarmAntigravityProvider({
			getAgentDir: () => "C:/agent",
			getRuntime: async () => sharedRuntime,
			createPackageManager: createPackageManager as never,
			createResourceLoader: createResourceLoader as never,
		});

		expect(createResourceLoader).toHaveBeenCalledWith("C:/agent", ["C:/agent/pi-antigravity/src/index.ts"]);
		expect(reload).toHaveBeenCalledOnce();
		expect(sharedRuntime.registerProvider).toHaveBeenCalledWith("antigravity", { api: "custom" });
		expect(sharedRuntime.refresh).toHaveBeenCalledWith({ allowNetwork: false, providers: ["antigravity"] });
	});

	it("quietly skips when no enabled Antigravity extension is configured", async () => {
		const getRuntime = vi.fn();
		const createResourceLoader = vi.fn();
		await prewarmAntigravityProvider({
			getAgentDir: () => "C:/agent",
			getRuntime,
			createPackageManager: (() => ({
				resolve: async () => ({ extensions: [], skills: [], prompts: [], themes: [] }),
			})) as never,
			createResourceLoader: createResourceLoader as never,
		});
		expect(createResourceLoader).not.toHaveBeenCalled();
		expect(getRuntime).not.toHaveBeenCalled();
	});
});
