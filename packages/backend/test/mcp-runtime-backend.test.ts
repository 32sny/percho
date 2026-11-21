import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpRuntimeSnapshot } from "@earendil-works/pi-coding-agent";

const agentDir = vi.hoisted(() => ({ value: "" }));
const observers = vi.hoisted(() => ({ callbacks: [] as Array<(snapshot: McpRuntimeSnapshot) => void> }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
	const sdk = await original<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...sdk,
		getAgentDir: () => agentDir.value,
		createMcpExtension: (options: Parameters<typeof sdk.createMcpExtension>[0]) => {
			if (options?.onStatus) observers.callbacks.push(options.onStatus);
			return sdk.createMcpExtension(options);
		},
	};
});
const { PiBackend } = await import("../src/pi-backend");

let root = "";
let previousAgentDir: string | undefined;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "percho-mcp-runtime-backend-"));
	agentDir.value = join(root, "agent");
	mkdirSync(agentDir.value, { recursive: true });
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir.value;
	observers.callbacks.length = 0;
});
afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

describe("MCP backend 运行态归属", () => {
	it("连接状态与工具由 SDK 快照投影，并在会话关闭后撤回；旧观察回调不能复活实例", async () => {
		const server = join(root, "server.mjs");
		const connections = join(root, "connections.log");
		writeFileSync(
			server,
			`import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', line => {
 const message=JSON.parse(line); if(message.id===undefined)return;
 if(message.method==='initialize') appendFileSync(process.argv[2], 'initialize\\n');
 const result=message.method==='initialize'
  ? {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
  : {tools:[{name:'echo',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
});`,
		);
		writeFileSync(
			join(agentDir.value, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					demo: { command: process.execPath, args: [server, connections], exposure: "direct" },
				},
			}),
		);
		const backend = new PiBackend({ projectTrust: false, permissionGates: false });
		try {
			const session = await backend.createSession({ cwd: root });
			await vi.waitFor(
				async () => {
					const view = await backend.getMcpConfig({ cwd: root });
					expect(view.global[0]).toMatchObject({
						state: "connected",
						tools: [{ name: expect.stringContaining("echo"), readOnly: true }],
					});
					return view;
				},
				{ timeout: 10000 },
			);
			const connected = await backend.getMcpConfig({ cwd: root });
			const instance = connected.runtime?.instances.find((item) => item.sessionId === session.sessionId);
			expect(instance?.available).toBe(true);
			expect(instance?.instanceId).toBeTruthy();
			const registry = (backend as unknown as {
				registry: {
					get(id: string): {
						session: {
							prompt: (...args: unknown[]) => unknown;
							messages: unknown[];
							isStreaming: boolean;
						};
					} | undefined;
				};
			}).registry;
			const activeSession = registry.get(session.sessionId)?.session;
			expect(activeSession).toBeDefined();
			if (!activeSession || !instance?.instanceId) throw new Error("MCP session fixture was not registered");
			const prompt = vi.spyOn(activeSession, "prompt");
			const messageCount = activeSession.messages.length;
			await expect(
				backend.reconnectMcpServer({ instanceId: "stale-instance", name: "demo" }),
			).rejects.toThrow("MCP 实例已失效");
			await backend.reconnectMcpServer({ instanceId: instance.instanceId, name: "demo" });
			await vi.waitFor(() => {
				expect(readFileSync(connections, "utf8").trim().split(/\r?\n/)).toHaveLength(2);
			}, { timeout: 10000 });
			expect(prompt).toHaveBeenCalledWith("/mcp reconnect demo");
			expect(activeSession.messages).toHaveLength(messageCount);
			expect(activeSession.isStreaming ?? false).toBe(false);
			const oldObserver = observers.callbacks.at(-1);
			expect(oldObserver).toBeDefined();
			await backend.closeSession(session.sessionId);
			const afterClose = await backend.getMcpConfig({ cwd: root });
			expect(afterClose.runtime?.instances).toEqual([]);
			expect(afterClose.global[0]?.state).toBe("not-started");
			oldObserver?.({
				phase: "running",
				servers: [
					{
						name: "demo",
						source: join(agentDir.value, "mcp.json"),
						scope: "global",
						state: "connected",
						tools: [{ name: "mcp__demo__echo", readOnly: true }],
					},
				],
				errors: [],
			});
			expect((await backend.getMcpConfig({ cwd: root })).runtime?.instances).toEqual([]);
		} finally {
			backend.dispose();
		}
	}, 20000);
});
