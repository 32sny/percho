import type { PiBackend } from "@percho/backend";
import { CHANNEL_TABLE, IpcChannels, type PiApi, type SessionHoverPreviewResult } from "@percho/shared";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle: state.handle } }));
import { registerSessionsIpc } from "./sessions";

const preloadCode = buildSync({
	entryPoints: [resolve(__dirname, "../../preload/index.ts")],
	bundle: true, platform: "node", format: "cjs", write: false, external: ["electron"],
}).outputFiles[0]?.text;

describe("session:hoverPreview IPC 和真实 preload 桥接", () => {
	it.each<SessionHoverPreviewResult>([
		{ status: "ok", sessionId: "target", source: "current-branch-first-user-text", text: "安全首行" },
		{ status: "empty", sessionId: "target" },
		{ status: "unavailable", sessionId: "target", reason: "limit_exceeded" },
	])("单对象请求无损映射后端两个参数，透传 $status union", async (result) => {
		state.handle.mockClear();
		const getSessionHoverPreview = vi.fn().mockResolvedValue(result);
		registerSessionsIpc({ getSessionHoverPreview } as unknown as PiBackend);
		expect(CHANNEL_TABLE.getSessionHoverPreview.channel).toBe("session:hoverPreview");
		expect(IpcChannels.getSessionHoverPreview).toBe("session:hoverPreview");
		const registration = state.handle.mock.calls.filter(([channel]) => channel === "session:hoverPreview");
		expect(registration).toHaveLength(1);
		const handler = registration[0]?.[1];
		const invoke = vi.fn((channel: string, args: unknown) => {
			expect(channel).toBe("session:hoverPreview");
			return handler({}, args);
		});
		let api: PiApi | undefined;
		if (!preloadCode) throw new Error("preload 未构建");
		runInNewContext(preloadCode, {
			module: { exports: {} }, exports: {}, process: { platform: "win32" },
			require: (name: string) => {
				if (name !== "electron") throw new Error(`意外模块: ${name}`);
				return { ipcRenderer: { invoke }, contextBridge: { exposeInMainWorld: (_name: string, value: PiApi) => { api = value; } } };
			},
		});
		if (!api) throw new Error("preload 未暴露 API");
		const request = { sessionId: "target", cwd: "/project" };
		expect(await api.getSessionHoverPreview(request)).toBe(result);
		expect(invoke).toHaveBeenCalledWith("session:hoverPreview", request);
		expect(getSessionHoverPreview).toHaveBeenCalledExactlyOnceWith("target", "/project");
	});
});
