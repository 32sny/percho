import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PermissionGate } from "../src/permissions/gate";
import { PiBackend } from "../src/pi-backend";
import { ExtensionDialogHost } from "../src/session/extension-dialog-host";
import type { SessionRegistry } from "../src/session/registry";

interface PromptOptions {
	preflightResult?: (disposition: "handled" | "queued" | "started") => void;
}
type PromptFn = (text: string, options?: PromptOptions) => Promise<void>;

/** 注入 stub session 到私有 registry（prompt 路径不触网/不依赖 SDK） */
function makeBackend(sessionId: string, prompt: PromptFn): PiBackend {
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	registry.add({
		session: { sessionId, prompt } as unknown as AgentSession,
		unsubscribe: () => {},
		cwd: "/tmp",
		gate: new PermissionGate(() => {}),
		dialogs: new ExtensionDialogHost({ onRequest: () => {}, onResolved: () => {} }),
		modeRef: { current: "default" },
	});
	return backend;
}

describe("PiBackend.prompt 受理回执", () => {
	it.each(["handled", "queued", "started"] as const)(
		"preflight(%s) 后立即返回，不等 run 结束",
		async (disposition) => {
			let releaseRun!: () => void;
			const runGate = new Promise<void>((r) => {
				releaseRun = r;
			});
			const backend = makeBackend("s1", (_text, options) => {
				options?.preflightResult?.(disposition);
				return runGate; // run 永不结束也不影响返回
			});

			await expect(backend.prompt("s1", "hi")).resolves.toEqual({ disposition });
			releaseRun();
		},
	);

	it("无 preflight 正常返回时标记 unknown", async () => {
		const backend = makeBackend("s1", async () => {});
		await expect(backend.prompt("s1", "hi")).resolves.toEqual({ disposition: "unknown" });
	});

	it("preflight 前抛错：reject 传真实错误（1.0.4 被拒不再回调 preflight）", async () => {
		const backend = makeBackend("s1", async () => {
			throw new Error("Authentication failed for provider");
		});

		await expect(backend.prompt("s1", "hi")).rejects.toThrow("Authentication failed for provider");
	});

	it("ack 之后 run 期失败不回传、无 unhandled rejection", async () => {
		const backend = makeBackend("s1", (_text, options) => {
			options?.preflightResult?.("started");
			return Promise.reject(new Error("run failed"));
		});

		await expect(backend.prompt("s1", "hi")).resolves.toEqual({ disposition: "started" });
	});

	it("无会话直接抛错", async () => {
		const backend = makeBackend("s1", async () => {});
		await expect(backend.prompt("missing", "hi")).rejects.toThrow();
	});
});
