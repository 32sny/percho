import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 渲染端 vitest 默认跑在 node 环境（无 localStorage/navigator），ToolCallCard 经 i18n 读它们。
 * 先打桩再动态 import（静态 import 会被提升到打桩之前）。
 */
type Summarize = (args: string) => string;
let summarizeArgs: Summarize;

beforeAll(async () => {
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	vi.stubGlobal("navigator", { language: "zh-CN" });
	({ summarizeArgs } = (await import("./ToolCallCard")) as { summarizeArgs: Summarize });
});

describe("工具折叠摘要", () => {
	it("既有字段优先级不变", () => {
		expect(summarizeArgs(JSON.stringify({ command: "npm test", filePath: "/a" }))).toBe("npm test");
		expect(summarizeArgs(JSON.stringify({ filePath: "/a/b.ts" }))).toBe("/a/b.ts");
		expect(summarizeArgs(JSON.stringify({ url: "https://a.example" }))).toBe("https://a.example");
	});

	it("tool_search 的 query 直接显示", () => {
		expect(summarizeArgs(JSON.stringify({ query: "find mcp docs", limit: 5 }))).toBe("find mcp docs");
	});

	it("codemode 的 code 只取第一行，脚本正文不进折叠行", () => {
		const code = "const a = 1;\nconst b = 2;\nconsole.log(a + b);";
		expect(summarizeArgs(JSON.stringify({ code }))).toBe("const a = 1;");
	});

	it("流式中的不完整 JSON 也能解出 code 首行（含转义换行）", () => {
		expect(summarizeArgs('{"code":"const a = 1;\\nconst b = 2;')).toBe("const a = 1;");
	});

	it("单行超长时截断到约 120 字", () => {
		const line = "x".repeat(300);
		const summary = summarizeArgs(JSON.stringify({ code: line }));
		expect(summary.endsWith("…")).toBe(true);
		expect(summary.length).toBe(121);
	});

	it("没有已知字段时仍按 120 字截断", () => {
		const args = `{"unknown":"${"y".repeat(300)}"}`;
		expect(summarizeArgs(args).endsWith("…")).toBe(true);
		expect(summarizeArgs("{}")).toBe("");
	});
});
