import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agent = vi.hoisted(() => ({ dir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agent.dir,
}));
const { importMcpServers, listMcpServers } = await import("../src/mcp/config-store");

let root = "";
let cwd = "";
let path = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "percho-mcp-import-"));
	agent.dir = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(agent.dir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	path = join(agent.dir, "mcp.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function readGlobal() {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("MCP 批量导入", () => {
	it("整批先校验，非法项不会造成部分落盘；成功时保留未知字段", async () => {
		writeFileSync(
			path,
			JSON.stringify({ autoEnableCodemode: true, extra: 1, mcpServers: { old: { command: "node" } } }),
		);
		const before = readFileSync(path, "utf8");
		await expect(
			importMcpServers(
				{ json: JSON.stringify({ mcpServers: { good: { command: "node" }, bad: 3 } }), cwd },
				{ projectTrusted: true },
			),
		).rejects.toThrow();
		expect(readFileSync(path, "utf8")).toBe(before);

		await importMcpServers(
			{
				json: JSON.stringify({
					mcpServers: {
						old: { command: "node", env: { TOKEN: "value" }, custom: 42 },
						remote: { url: "https://example.com/mcp", headers: { authorization: "Bearer value" } },
					},
				}),
				cwd,
			},
			{ projectTrusted: true },
		);
		expect(readGlobal()).toMatchObject({
			autoEnableCodemode: true,
			extra: 1,
			mcpServers: {
				old: { env: { TOKEN: "value" }, custom: 42, exposure: "deferred" },
				remote: { headers: { authorization: "Bearer value" }, exposure: "deferred" },
			},
		});
	});

	it("同名换传输时不留下旧传输字段（否则 url 继续赢过 command）", async () => {
		writeFileSync(
			path,
			JSON.stringify({
				mcpServers: { demo: { url: "https://old.example.invalid/mcp", type: "streamable-http" } },
			}),
		);

		await importMcpServers(
			{
				json: JSON.stringify({ mcpServers: { demo: { command: "node", args: ["server.mjs"] } } }),
				cwd,
			},
			{ projectTrusted: true },
		);

		const entry = (readGlobal().mcpServers as Record<string, Record<string, unknown>>).demo;
		expect(entry.command).toBe("node");
		expect(entry.url).toBeUndefined();
		expect(entry.type).toBeUndefined();
		// 面板与真实连接必须是同一种传输
		const listed = await listMcpServers({ projectTrusted: false });
		expect(listed.global[0]?.transport).toMatchObject({ kind: "stdio", command: "node" });
	});

	it("反向：command 条目导入同名 url 时清掉 command/args 与显式 stdio 类型", async () => {
		writeFileSync(
			path,
			JSON.stringify({ mcpServers: { demo: { type: "stdio", command: "node", args: ["x"] } } }),
		);

		await importMcpServers(
			{ json: JSON.stringify({ mcpServers: { demo: { url: "https://new.example/mcp" } } }), cwd },
			{ projectTrusted: true },
		);

		const entry = (readGlobal().mcpServers as Record<string, Record<string, unknown>>).demo;
		expect(entry.url).toBe("https://new.example/mcp");
		expect(entry.command).toBeUndefined();
		expect(entry.args).toBeUndefined();
		expect(entry.type).toBeUndefined();
	});

	it("允许合法的特殊属性名并保持 own property", async () => {
		const mcpServers = JSON.parse('{"__proto__":{"command":"node"},"constructor":{"command":"node"}}');
		await importMcpServers({ json: JSON.stringify({ mcpServers }) }, { projectTrusted: false });
		const entries = readGlobal().mcpServers as Record<string, unknown>;
		expect(Object.hasOwn(entries, "__proto__")).toBe(true);
		expect(Object.hasOwn(entries, "constructor")).toBe(true);
		expect((await listMcpServers({ projectTrusted: false })).global.map((server) => server.name)).toEqual([
			"__proto__",
			"constructor",
		]);
	});

	it("导入输入和空批次被拒绝", async () => {
		for (const json of ["null", "[]", "{}", JSON.stringify({ mcpServers: {} })]) {
			await expect(importMcpServers({ json }, { projectTrusted: false })).rejects.toThrow();
		}
		expect(() => readGlobal()).toThrow();
	});
});
