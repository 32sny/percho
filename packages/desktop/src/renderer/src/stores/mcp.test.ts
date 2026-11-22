import type { McpConfigListResult, McpRuntimeInstance, McpRuntimeInventory } from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** window.pi 的 mock：store 经 getPi() 访问，测试环境无 preload 注入 */
const api = vi.hoisted(() => ({
	mcpConfigList: vi.fn(),
	mcpConfigUpsert: vi.fn(),
	mcpConfigImport: vi.fn(),
	mcpConfigRemove: vi.fn(),
	mcpReconnect: vi.fn(),
	mcpLogin: vi.fn(),
}));
vi.mock("../api", () => ({ getPi: () => api }));

import { createMcpStore, mcpActionKey } from "./mcp";

const server = {
	name: "my-server",
	source: "user" as const,
	transport: { kind: "unknown" as const },
	enabled: true,
	exposure: "deferred" as const,
	tools: [],
};

function inventory(
	revision: number,
	instances: McpRuntimeInventory["instances"] = [],
	epoch = "one",
): McpRuntimeInventory {
	return { epoch, revision, instances };
}

type LiveServer = McpRuntimeInstance["servers"][number];

function liveServer(state: LiveServer["state"], error?: string): LiveServer {
	return { name: "my-server", source: "/global", state, tools: [{ name: "tool" }], error };
}

function instance(id: string, cwd = "/a", state: "connected" | "failed" = "connected"): McpRuntimeInstance {
	return {
		instanceId: id,
		sessionId: `session-${id}`,
		cwd,
		available: true,
		errors: [] as string[],
		servers: [liveServer(state, state === "failed" ? "failure" : undefined)],
	};
}

function config(runtime: McpRuntimeInventory, cwd = "/a"): McpConfigListResult {
	return {
		global: [server],
		project: [],
		errors: [],
		projectTrusted: true,
		globalPath: "/global",
		contextCwd: cwd,
		runtime,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
});

describe("MCP 运行态快照", () => {
	it("事件先于旧基线时保留新版，并完整清除工具与错误", async () => {
		const store = createMcpStore();
		const pending = deferred<McpConfigListResult>();
		api.mcpConfigList.mockReturnValueOnce(pending.promise);
		const loading = store.getState().load("/a");
		const current = instance("1", "/a", "failed");
		store.getState().applyServersChanged(
			inventory(2, [
				{
					...current,
					servers: [{ ...liveServer("connected"), tools: [] }],
				},
			]),
		);
		pending.resolve(config(inventory(1, [current])));
		await loading;
		expect(store.getState().config?.global[0]).toMatchObject({
			state: "connected",
			tools: [],
			error: undefined,
		});
	});

	it("按项目自动选当前会话；实例结束后保留选择身份但不重新指向别的实例", async () => {
		const store = createMcpStore();
		api.mcpConfigList.mockResolvedValueOnce(
			config(inventory(1, [instance("1"), instance("2"), instance("3", "/b")])),
		);
		await store.getState().load("/a", "session-2");
		expect(store.getState().config?.selectedInstanceId).toBe("2");

		store.getState().applyServersChanged(inventory(2, [instance("1"), instance("3", "/b")]));
		expect(store.getState().selectedInstanceId).toBe("2");
		expect(store.getState().config?.selectedInstanceId).toBeUndefined();
		expect(store.getState().config?.global[0]?.state).toBe("unknown");

		store.getState().selectInstance("1");
		expect(store.getState().config?.selectedInstanceId).toBe("1");
	});

	it("活动会话无 owner 时不借用同目录实例；只允许显式选择，自己的实例迟到仍可自动归属", async () => {
		const store = createMcpStore();
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1, [instance("1")])));
		await store.getState().load("/a", "session-readonly");
		expect(store.getState().config?.selectedInstanceId).toBeUndefined();
		expect(store.getState().config?.global[0]?.state).toBe("unknown");
		await expect(store.getState().reconnect("my-server")).rejects.toThrow();
		await expect(store.getState().login("my-server")).rejects.toThrow();
		expect(api.mcpReconnect).not.toHaveBeenCalled();
		expect(api.mcpLogin).not.toHaveBeenCalled();

		store.getState().applyServersChanged(inventory(2, [instance("1"), instance("readonly")]));
		expect(store.getState().config?.selectedInstanceId).toBe("readonly");

		api.mcpConfigList.mockResolvedValueOnce(config(inventory(2, [instance("1"), instance("readonly")])));
		await store.getState().load("/a", "session-other-readonly");
		expect(store.getState().config?.selectedInstanceId).toBeUndefined();
		store.getState().selectInstance("1");
		api.mcpReconnect.mockResolvedValueOnce(undefined);
		await store.getState().reconnect("my-server");
		expect(api.mcpReconnect).toHaveBeenCalledWith({ instanceId: "1", name: "my-server" });
	});

	it("同项目换会话只重选实例，不清空已加载配置（避免卸载编辑中的表单）", async () => {
		const store = createMcpStore();
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1, [instance("1")])));
		await store.getState().load("/a", "session-1");
		expect(store.getState().config).not.toBeNull();

		const pending = deferred<McpConfigListResult>();
		api.mcpConfigList.mockReturnValueOnce(pending.promise);
		const loading = store.getState().load("/a", "session-9");
		// 同一项目的配置与表单可以继续展示；只把实例选择交回给新会话
		expect(store.getState().config).not.toBeNull();
		expect(store.getState().selectedInstanceId).toBeUndefined();
		expect(store.getState().loading).toBe(true);
		pending.resolve(config(inventory(1, [instance("1")])));
		await loading;
		expect(store.getState().config).not.toBeNull();

		// 换项目才清空：旧项目的内容不能出现在新项目下
		api.mcpConfigList.mockReturnValueOnce(deferred<McpConfigListResult>().promise);
		void store.getState().load("/b", "session-1");
		expect(store.getState().config).toBeNull();
	});

	it("旧项目请求不能覆盖新上下文；已替换的旧 epoch 不能复活", async () => {
		const store = createMcpStore();
		const old = deferred<McpConfigListResult>();
		api.mcpConfigList
			.mockReturnValueOnce(old.promise)
			.mockResolvedValueOnce(config(inventory(1, [instance("1"), instance("2")])));
		const first = store.getState().load("/b");
		await store.getState().load("/a", "session-2");
		expect(store.getState().config?.selectedInstanceId).toBe("2");
		old.resolve(config(inventory(1), "/b"));
		await first;
		expect(store.getState().config?.contextCwd).toBe("/a");

		store.getState().applyServersChanged(inventory(2, [instance("new")], "next"));
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(99, [instance("stale")])));
		await store.getState().load("/a");
		store.getState().applyServersChanged(inventory(100, [instance("stale")]));
		expect(store.getState().config?.runtime?.epoch).toBe("next");
	});

	it("实时启用值消失后回到配置值，状态不靠工具数量推断", async () => {
		const store = createMcpStore();
		const base = config(inventory(1, []));
		base.global = [{ ...server, enabled: true }];
		api.mcpConfigList.mockResolvedValueOnce(base);
		await store.getState().load("/a");

		store
			.getState()
			.applyServersChanged(inventory(2, [{ ...instance("1"), servers: [liveServer("disabled")] }]));
		expect(store.getState().config?.global[0]?.enabled).toBe(false);

		store.getState().applyServersChanged(inventory(3, []));
		expect(store.getState().config?.global[0]?.enabled).toBe(true);
		expect(store.getState().config?.global[0]?.state).toBe("not-started");
	});
});

describe("MCP 写盘只落盘", () => {
	it("upsert 标记 restartRequired 且不触发重连", async () => {
		const store = createMcpStore();
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1, [instance("1")])));
		await store.getState().load("/a", "session-1");
		const saved = { ...config(inventory(1, [instance("1")])), restartRequired: true };
		api.mcpConfigUpsert.mockResolvedValueOnce({ config: saved });
		await store.getState().upsert({ scope: "user", name: "my-server", exposure: "deferred" });
		expect(api.mcpConfigUpsert).toHaveBeenCalledWith({
			scope: "user",
			name: "my-server",
			exposure: "deferred",
		});
		expect(store.getState().restartRequired).toBe(true);
		expect(api.mcpReconnect).not.toHaveBeenCalled();
	});

	it("批量导入原样提交 JSON 并传播错误", async () => {
		const store = createMcpStore();
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1)));
		await store.getState().load("/a");
		api.mcpConfigImport.mockRejectedValueOnce(new Error("invalid row"));
		await expect(store.getState().importServers('{"bad":3}', "/a")).rejects.toThrow("invalid row");
		expect(store.getState().restartRequired).toBe(false);
		expect(api.mcpConfigImport).toHaveBeenCalledWith({ json: '{"bad":3}', cwd: "/a" });
	});

	it("较早写操作迟到不能覆盖较新配置", async () => {
		const store = createMcpStore();
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1)));
		await store.getState().load("/a");
		const old = deferred<{ config: McpConfigListResult }>();
		api.mcpConfigUpsert
			.mockReturnValueOnce(old.promise)
			.mockResolvedValueOnce({ config: { ...config(inventory(3)), globalPath: "/new" } });
		const first = store.getState().upsert({ scope: "user", name: "one" });
		await store.getState().upsert({ scope: "user", name: "two" });
		api.mcpConfigList.mockResolvedValueOnce({ ...config(inventory(3)), globalPath: "/new" });
		old.resolve({ config: { ...config(inventory(2)), globalPath: "/old" } });
		await first;
		expect(store.getState().config?.globalPath).toBe("/new");
	});
});

describe("单台重连 / 登录", () => {
	it("同目标单飞；撤销实例后的迟到失败不复活动作状态", async () => {
		const store = createMcpStore();
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1, [instance("1"), instance("2")])));
		await store.getState().load("/a", "session-1");
		const pending = deferred<void>();
		api.mcpReconnect.mockReturnValueOnce(pending.promise);
		const first = store.getState().reconnect("my-server");
		store.getState().applyServersChanged(
			inventory(2, [
				{
					...instance("1"),
					servers: instance("1").servers.map((item) => ({ ...item, state: "connecting" as const })),
				},
				instance("2"),
			]),
		);
		const second = store.getState().reconnect("my-server");
		expect(first).toBe(second);
		await Promise.resolve();
		expect(api.mcpReconnect).toHaveBeenCalledTimes(1);
		expect(store.getState().reconnectActions[mcpActionKey("1", "my-server")]?.pending).toBe(true);

		store.getState().applyServersChanged(inventory(3, [instance("2")]));
		const rejected = expect(first).rejects.toThrow("late");
		pending.reject(new Error("late"));
		await rejected;
		expect(store.getState().reconnectActions).toEqual({});
	});

	it("同步异常可见；不可重连状态与无实例选择被拒绝", async () => {
		const store = createMcpStore();
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1, [instance("1")])));
		await store.getState().load("/a");
		api.mcpReconnect.mockImplementationOnce(() => {
			throw new Error("sync failure");
		});
		await expect(store.getState().reconnect("my-server")).rejects.toThrow("sync failure");
		expect(store.getState().reconnectActions[mcpActionKey("1", "my-server")]?.error).toBe("sync failure");

		api.mcpReconnect.mockResolvedValueOnce(undefined);
		await store.getState().reconnect("my-server");
		expect(store.getState().reconnectActions).toEqual({});

		store.getState().applyServersChanged(
			inventory(2, [
				{
					...instance("1"),
					servers: [liveServer("connecting")],
				},
			]),
		);
		await expect(store.getState().reconnect("my-server")).rejects.toThrow();
		expect(api.mcpReconnect).toHaveBeenCalledTimes(2);
	});

	it("登录发到当前选中实例", async () => {
		const store = createMcpStore();
		api.mcpConfigList.mockResolvedValueOnce(config(inventory(1, [instance("1")])));
		await store.getState().load("/a");
		api.mcpLogin.mockResolvedValueOnce(undefined);
		await store.getState().login("my-server");
		expect(api.mcpLogin).toHaveBeenCalledWith({ instanceId: "1", name: "my-server" });
	});
});
