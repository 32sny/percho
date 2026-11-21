import type { McpServerView } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { filterServers, serverState, sortServers, toolsSummary, transportSummary } from "./pure";

/** 面板的状态判定 / 排序 / 过滤 / 粘贴解析 —— 全是纯函数，这里把矩阵钉住 */
function server(overrides: Partial<McpServerView> = {}): McpServerView {
	return {
		name: "demo",
		source: "user" as const,
		transport: { kind: "stdio" as const, command: "/opt/homebrew/bin/node", args: ["server.mjs"] },
		enabled: true,
		exposure: "deferred" as const,
		tools: [],
		...overrides,
	};
}

describe("serverState（设计稿 §3 状态矩阵）", () => {
	it("显式状态独立于工具数量，不再从工具数推断连接", () => {
		expect(serverState(server({ state: "connected", tools: [] }))).toBe("connected");
		expect(serverState(server({ tools: [{ name: "mcp__demo__echo" }] }))).toBe("idle");
		expect(serverState(server({ state: "disconnected", tools: [{ name: "x" }] }))).toBe("disconnected");
		expect(serverState(server({ state: "overridden" }))).toBe("overridden");
	});

	it("旧夹具缺 state 时兼容：停用 > 需授权 > 失败 > idle", () => {
		expect(serverState(server({ error: "spawn npx ENOENT" }))).toBe("error");
		expect(serverState(server({ needsAuth: true }))).toBe("needs-auth");
		expect(serverState(server({ needsAuth: true, error: "x" }))).toBe("needs-auth");
		expect(serverState(server({ enabled: false, needsAuth: true }))).toBe("disabled");
	});
});

describe("工具摘要 / 传输摘要", () => {
	it("工具摘要带只读计数；空工具给 null（交给状态词）", () => {
		expect(toolsSummary([])).toBeNull();
		expect(
			toolsSummary([{ name: "a", readOnly: true }, { name: "b" }, { name: "c", readOnly: true }]),
		).toEqual({
			count: 3,
			readOnly: 2,
		});
	});

	it("stdio 拼 command+args，远程给 url，不完整给空", () => {
		expect(transportSummary(server())).toBe("/opt/homebrew/bin/node server.mjs");
		expect(transportSummary(server({ transport: { kind: "url", url: "https://a.example/mcp" } }))).toBe(
			"https://a.example/mcp",
		);
		expect(transportSummary(server({ transport: { kind: "unknown" } }))).toBe("");
	});
});

describe("排序与过滤", () => {
	it("停用垫底，其余按名称", () => {
		const list = [
			server({ name: "zulu" }),
			server({ name: "alpha", enabled: false }),
			server({ name: "bravo" }),
		];
		expect(sortServers(list).map((s) => s.name)).toEqual(["bravo", "zulu", "alpha"]);
	});

	it("搜索匹配名称 / 描述 / 命令；空查询原样返回", () => {
		const list = [
			server({ name: "docs" }),
			server({ name: "db", transport: { kind: "stdio", command: "/usr/local/bin/pg-mcp" } }),
		];
		expect(filterServers(list, "").length).toBe(2);
		expect(filterServers(list, "DOCS").map((s) => s.name)).toEqual(["docs"]);
		expect(filterServers(list, "pg-mcp").map((s) => s.name)).toEqual(["db"]);
		expect(filterServers(list, "nope")).toEqual([]);
	});
});
