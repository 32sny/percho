import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredSession, SessionRegistry } from "../src/session/registry";

const agentDir = vi.hoisted(() => ({ value: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agentDir.value,
}));
const { PiBackend } = await import("../src/pi-backend");

let root = "";
let project = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "percho-mcp-save-only-"));
	project = join(root, "project");
	mkdirSync(project, { recursive: true });
	agentDir.value = join(root, "agent");
	mkdirSync(agentDir.value, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function stubSession(sessionId: string, cwd = project) {
	return {
		session: {
			sessionId,
			isStreaming: false,
			isCompacting: false,
			reload: vi.fn(),
			abort: vi.fn(),
			getAllTools: () => [],
		},
		cwd,
	};
}

function addSessions(backend: InstanceType<typeof PiBackend>, entries: ReturnType<typeof stubSession>[]) {
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	for (const { session, cwd } of entries) {
		const entry = {
			session: {
				...session,
				dispose: vi.fn(),
				extensionRunner: { emit: vi.fn().mockResolvedValue([]) },
			},
			unsubscribe: vi.fn(),
			cwd,
			gate: { dispose: vi.fn() },
			dialogs: { dispose: vi.fn() },
			modeRef: {},
		};
		registry.add(entry as unknown as RegisteredSession);
	}
}

describe("MCP 配置写入不扰动运行会话", () => {
	it("增删改与导入只写盘，不 reload/abort；成功后标记重启生效", async () => {
		const sessions = [
			stubSession("idle"),
			stubSession("streaming"),
			stubSession("other", join(root, "other")),
		];
		sessions[1].session.isStreaming = true;
		mkdirSync(sessions[2].cwd, { recursive: true });
		const backend = new PiBackend({ projectTrust: false, permissionGates: false });
		addSessions(backend, sessions);
		try {
			expect((await backend.getMcpConfig()).restartRequired).toBe(false);
			await backend.upsertMcpServer({ scope: "user", cwd: project, name: "demo", command: "node" });
			expect((await backend.getMcpConfig({ cwd: project })).restartRequired).toBe(true);
			await backend.importMcpServers({
				cwd: project,
				json: JSON.stringify({ mcpServers: { imported: { command: "node" } } }),
			});
			await backend.removeMcpServer({ scope: "user", name: "demo", cwd: project });
			const stored = JSON.parse(readFileSync(join(agentDir.value, "mcp.json"), "utf8"));
			expect(Object.keys(stored.mcpServers)).toEqual(["imported"]);
			for (const { session } of sessions) {
				expect(session.reload).not.toHaveBeenCalled();
				expect(session.abort).not.toHaveBeenCalled();
			}
		} finally {
			backend.dispose();
		}
	});

	it("失败的原子导入不改文件，也不设置重启标记", async () => {
		const backend = new PiBackend({ projectTrust: false, permissionGates: false });
		try {
			writeFileSync(
				join(agentDir.value, "mcp.json"),
				JSON.stringify({ mcpServers: { kept: { command: "node" } } }),
			);
			const before = readFileSync(join(agentDir.value, "mcp.json"), "utf8");
			await expect(
				backend.importMcpServers({
					json: JSON.stringify({ mcpServers: { good: { command: "node" }, bad: 3 } }),
				}),
			).rejects.toThrow();
			expect(readFileSync(join(agentDir.value, "mcp.json"), "utf8")).toBe(before);
			expect((await backend.getMcpConfig()).restartRequired).toBe(false);
		} finally {
			backend.dispose();
		}
	});

	it("项目配置要求显式 cwd 和受信目录；MCP 请求不继承 defaultCwd", async () => {
		const backend = new PiBackend({ defaultCwd: project, projectTrust: false, permissionGates: false });
		try {
			const result = await backend.getMcpConfig();
			expect(result.contextCwd).toBeUndefined();
			expect(result.project).toEqual([]);
			await expect(
				backend.upsertMcpServer({ scope: "project", name: "project", command: "node" }),
			).rejects.toThrow(/cwd|目录/);
			await expect(
				backend.upsertMcpServer({ scope: "project", cwd: project, name: "project", command: "node" }),
			).rejects.toThrow("项目未受信");
		} finally {
			backend.dispose();
		}
	});
});
