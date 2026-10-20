import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ModelPrefsHooks, ModelPrefsService } from "../src/settings/model-prefs";

async function makeService(hooks?: ModelPrefsHooks) {
	const dir = await mkdtemp(join(tmpdir(), "percho-model-prefs-"));
	return {
		dir,
		path: join(dir, "model-prefs.json"),
		service: new ModelPrefsService(join(dir, "model-prefs.json"), hooks),
	};
}

describe("ModelPrefsService", () => {
	it("读写隐藏模型与子代理模型，删除配置后回到继承", async () => {
		const { service } = await makeService();
		expect(await service.getPrefs()).toEqual({ hiddenModels: {}, subagentModels: {} });
		await service.setModelHidden("deepseek", "v4-flash", true);
		await service.setSubagentModel("scout", "deepseek/v4-flash");
		expect(await service.getPrefs()).toEqual({
			hiddenModels: { deepseek: ["v4-flash"] },
			subagentModels: { scout: "deepseek/v4-flash" },
		});
		await service.setModelHidden("deepseek", "v4-flash", false);
		await service.setSubagentModel("scout", null);
		expect(await service.getPrefs()).toEqual({ hiddenModels: {}, subagentModels: {} });
	});

	it("原子写不遗留临时文件", async () => {
		const { dir, service } = await makeService();
		await service.setModelHidden("p", "m", true);
		expect((await readdir(dir)).sort()).toEqual(["model-prefs.json"]);
	});

	it("损坏文件安全回退为空配置", async () => {
		const { path, service } = await makeService();
		await writeFile(path, "{broken", "utf8");
		expect(await service.getPrefs()).toEqual({ hiddenModels: {}, subagentModels: {} });
	});

	describe("subagentThinking（#47）", () => {
		it("读写逐代理思考档位；null 删除键", async () => {
			const { service } = await makeService();
			expect(await service.getSubagentThinking("scout")).toBeUndefined();
			await service.setSubagentThinking("scout", "low");
			expect(await service.getSubagentThinking("scout")).toBe("low");
			expect(await service.getPrefs()).toEqual({
				hiddenModels: {},
				subagentModels: {},
				subagentThinking: { scout: "low" },
			});
			await service.setSubagentThinking("scout", null);
			expect(await service.getSubagentThinking("scout")).toBeUndefined();
			// 空 map 不写进 json（向后兼容旧文件形状）
			expect(await service.getPrefs()).toEqual({ hiddenModels: {}, subagentModels: {} });
		});

		it("非法档位拒写，脏 json 值读侧白名单丢弃", async () => {
			const { path, service } = await makeService();
			await expect(service.setSubagentThinking("scout", "ultra")).rejects.toThrow(/invalid thinking/);
			await writeFile(
				path,
				JSON.stringify({
					subagentThinking: { scout: "ultra", reviewer: "high", blank: "  " },
				}),
				"utf8",
			);
			const fresh = new ModelPrefsService(path);
			expect(await fresh.getPrefs()).toEqual({
				hiddenModels: {},
				subagentModels: {},
				subagentThinking: { reviewer: "high" },
			});
		});
	});

	describe("hooks（subagent-model-sync）", () => {
		it("setSubagentModel 成功后 hook 被调且参数正确；null（跟随 agent 定义）时仍被调", async () => {
			const calls: Array<[string, string | null]> = [];
			const { service } = await makeService({ onSubagentModelChanged: async (a, m) => {
				calls.push([a, m]);
			} });
			await service.setSubagentModel("fixer", "iiiiitoken/gpt-6.1-sol");
			await service.setSubagentModel("scout", null);
			expect(calls).toEqual([
				["fixer", "iiiiitoken/gpt-6.1-sol"],
				["scout", null],
			]);
			// hook 不影响 prefs 落盘语义
			expect(await service.getPrefs()).toEqual({
				hiddenModels: {},
				subagentModels: { fixer: "iiiiitoken/gpt-6.1-sol" },
			});
		});

		it("setSubagentThinking 成功后 hook 被调；非法档位拒写不触发", async () => {
			const calls: Array<[string, string | null]> = [];
			const { service } = await makeService({ onSubagentThinkingChanged: async (a, l) => {
				calls.push([a, l]);
			} });
			await service.setSubagentThinking("fixer", "high");
			await service.setSubagentThinking("fixer", null);
			expect(calls).toEqual([
				["fixer", "high"],
				["fixer", null],
			]);
			await expect(service.setSubagentThinking("fixer", "ultra")).rejects.toThrow(/invalid thinking/);
			expect(calls).toHaveLength(2); // 拒写在 mutate 之前，不触发 hook
		});

		it("hook 抛错被吞掉：set 正常返回且 prefs 已落盘", async () => {
			const { path, service } = await makeService({
				onSubagentModelChanged: () => Promise.reject(new Error("frontmatter io boom")),
			});
			await expect(service.setSubagentModel("fixer", "p/m")).resolves.toMatchObject({
				subagentModels: { fixer: "p/m" },
			});
			// 重启服务确认已落盘（hook 失败不影响持久化）
			expect(await new ModelPrefsService(path).getSubagentModel("fixer")).toBe("p/m");
		});

		it("hook 在串行域内执行：后续读操作排在 hook 之后", async () => {
			const order: string[] = [];
			const { service } = await makeService({
				onSubagentModelChanged: async () => {
					await new Promise((r) => setTimeout(r, 20));
					order.push("hook");
				},
			});
			const setPromise = service.setSubagentModel("fixer", "p/m").then(() => order.push("set-resolved"));
			const getPromise = service.getPrefs().then(() => order.push("get-resolved"));
			await Promise.all([setPromise, getPromise]);
			expect(order).toEqual(["hook", "set-resolved", "get-resolved"]);
		});
	});

	describe("subagentPreferBuiltin（#47）", () => {
		it("缺省 true，可写 false 再开关回 true", async () => {
			const { service } = await makeService();
			expect(await service.getSubagentPreferBuiltin()).toBe(true);
			await service.setSubagentPreferBuiltin(false);
			expect(await service.getSubagentPreferBuiltin()).toBe(false);
			expect(await service.getPrefs()).toMatchObject({ subagentPreferBuiltin: false });
			await service.setSubagentPreferBuiltin(true);
			expect(await service.getSubagentPreferBuiltin()).toBe(true);
		});

		it("旧 json 无新字段时行为同现状；脏值按 true 处理", async () => {
			const { path } = await makeService();
			await writeFile(
				path,
				JSON.stringify({ hiddenModels: {}, subagentModels: { scout: "p/m" }, subagentPreferBuiltin: "nope" }),
				"utf8",
			);
			const legacy = new ModelPrefsService(path);
			expect(await legacy.getSubagentPreferBuiltin()).toBe(true);
			expect(await legacy.getSubagentModel("scout")).toBe("p/m");
			expect(await legacy.getPrefs()).toEqual({
				hiddenModels: {},
				subagentModels: { scout: "p/m" },
			});
		});
	});
});
