import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpRuntimeInventory } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpRuntimeStore } from "../src/mcp/runtime-store";
import type { SessionRegistry } from "../src/session/registry";

const { PiBackend } = await import("../src/pi-backend");

let root = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "percho-mcp-guard-"));
	mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function inventory(state: "connected" | "needs-auth"): McpRuntimeInventory {
	return {
		epoch: "epoch-1",
		revision: 1,
		instances: [
			{
				instanceId: "instance-1",
				sessionId: "session-1",
				cwd: root,
				available: true,
				errors: [],
				servers: [{ name: "demo", source: "global", state, tools: [] }],
			},
		],
	};
}

/** 只装配维护入口需要的字段：会话忙碌状态 + /mcp 命令 + 提示队列观测点。 */
function sessionStub(options: { idle: boolean; state?: "connected" | "needs-auth" }) {
	return {
		sessionId: "session-1",
		isIdle: options.idle,
		isStreaming: !options.idle,
		isCompacting: false,
		prompt: vi.fn().mockResolvedValue(undefined),
		// 清理静音：真实会话会发 session_shutdown 再 dispose，这里只避免 disposeAll 打警告
		dispose: () => {},
		extensionRunner: { getCommand: (name: string) => (name === "mcp" ? {} : undefined) },
		tryAcquireIdleLease: () => ({ release: () => {} }),
	};
}

function makeBackend(session: ReturnType<typeof sessionStub>, state: "connected" | "needs-auth") {
	const backend = new PiBackend({ projectTrust: false, permissionGates: false, openExternal: () => {} });
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	registry.add({
		session,
		unsubscribe: () => {},
		cwd: root,
		gate: { dispose: () => {} },
		dialogs: { dispose: () => {} },
		modeRef: {},
	} as never);
	// 运行态由 SDK observer 发布；这里直接给一份同形状快照，只测维护入口的前置判定。
	(backend as unknown as { mcpRuntime: McpRuntimeStore }).mcpRuntime = {
		snapshot: () => inventory(state),
		owner: () => undefined,
		ensurePresent: () => {},
	} as unknown as McpRuntimeStore;
	return backend;
}

describe("MCP 维护命令只在空闲会话上真正执行", () => {
	it("忙碌时重连被拒绝，且不会把命令排进用户消息队列", async () => {
		const session = sessionStub({ idle: false });
		const backend = makeBackend(session, "connected");
		try {
			await expect(backend.reconnectMcpServer({ instanceId: "instance-1", name: "demo" })).rejects.toThrow(
				"会话正在运行",
			);
			expect(session.prompt).not.toHaveBeenCalled();
		} finally {
			backend.dispose();
		}
	});

	it("忙碌时登录同样被拒绝，不产生队列消息", async () => {
		const session = sessionStub({ idle: false });
		const backend = makeBackend(session, "needs-auth");
		try {
			await expect(backend.mcpLogin({ instanceId: "instance-1", name: "demo" })).rejects.toThrow(
				"会话正在运行",
			);
			expect(session.prompt).not.toHaveBeenCalled();
		} finally {
			backend.dispose();
		}
	});

	it("空闲时照常执行重连与登录", async () => {
		const session = sessionStub({ idle: true });
		const backend = makeBackend(session, "connected");
		try {
			await backend.reconnectMcpServer({ instanceId: "instance-1", name: "demo" });
			expect(session.prompt).toHaveBeenCalledWith("/mcp reconnect demo");
		} finally {
			backend.dispose();
		}
	});

	it("空闲时登录发到选中实例", async () => {
		const session = sessionStub({ idle: true });
		const backend = makeBackend(session, "needs-auth");
		try {
			await backend.mcpLogin({ instanceId: "instance-1", name: "demo" });
			expect(session.prompt).toHaveBeenCalledWith("/mcp login demo");
		} finally {
			backend.dispose();
		}
	});
});
