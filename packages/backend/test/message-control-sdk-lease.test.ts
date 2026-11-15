import type { Message } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageControlHandle } from "../src/session/message-control";
import {
	assistantTurn,
	cleanupSdkTest,
	type Gate,
	gate,
	messageText,
	requireControl,
	response,
	sdkFixture,
	withTimeout,
} from "./message-control-sdk-harness";

/**
 * SDK 1.5.1 闲时租约与消息控制的真实互锁回归：
 * - 租约持有期间 control.submit/recover 不得写消息或启动 run；
 * - 租约释放后相同的 submit/recover 立即可用；
 * - controller 仍在 preparing/tasks/pending 时 tryAcquireIdleLease 必须失败；
 * - held 不永久毒化 busy，人工 recover 仍可到达，但必须先释放租约。
 *
 * 只用真实 AgentSession、真实 Agent 事件与真实内存模型流；不联网、不替换控制器。
 */

afterEach(async () => {
	await cleanupSdkTest();
});

function identity(session: AgentSession, control: MessageControlHandle) {
	return {
		sessionId: session.sessionId,
		runtimeId: control.getSnapshot().runtimeId,
	};
}

function submitRequest(session: AgentSession, control: MessageControlHandle, id: string, text = id) {
	return {
		...identity(session, control),
		requestId: id,
		mode: "queue" as const,
		payload: { text },
	};
}

async function gatedTool(): Promise<{ tool: ToolDefinition; entered: Gate<void>; release: Gate<void> }> {
	const entered = gate(),
		release = gate();
	return {
		entered,
		release,
		tool: {
			name: "lease_gate",
			label: "lease gate",
			description: "memory-only gated test tool",
			parameters: Type.Object({}),
			execute: async () => {
				entered.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		},
	};
}

describe("AgentSession idle lease vs message control", () => {
	it("[§6.5 lease-holds] a held idle lease blocks submit without writing or starting, then releases cleanly", async () => {
		const { session, requests } = await sdkFixture();
		const control = requireControl(session);
		const lease = session.tryAcquireIdleLease();
		expect(lease).toBeDefined();

		const blocked = await control.submit(submitRequest(session, control, "lease-blocked", "must-not-start"));
		expect(blocked).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(requests).toHaveLength(0);
		expect(control.getSnapshot().items).toHaveLength(0);

		lease?.release();
		const accepted = await control.submit(submitRequest(session, control, "lease-released", "after-release"));
		expect(accepted).toMatchObject({ ok: true, value: { disposition: "started" } });
		await control.waitForIdle();
		expect(requests).toHaveLength(1);
		const users = (requests[0] as Message[]).filter((message) => message.role === "user");
		expect(messageText(users.at(-1)?.content ?? "")).toContain("after-release");
	});

	it("[§6.5 preparing-lease] tryAcquireIdleLease fails while the controller is preparing input", async () => {
		const entered = gate(),
			release = gate();
		const inputGate: ExtensionFactory = (pi) => {
			pi.on("input", async () => {
				entered.resolve();
				await release.promise;
				return { action: "continue" };
			});
		};
		const { session, requests } = await sdkFixture({ extensions: [inputGate] });
		const control = requireControl(session);

		const pending = control.submit(submitRequest(session, control, "preparing", "while-preparing"));
		await withTimeout(entered.promise, 5000, "input handler entered");
		expect(session.tryAcquireIdleLease()).toBeUndefined();

		release.resolve();
		expect(await pending).toMatchObject({ ok: true, value: { disposition: "started" } });
		await control.waitForIdle();
		expect(requests).toHaveLength(1);

		const lease = session.tryAcquireIdleLease();
		expect(lease).toBeDefined();
		lease?.release();
	});

	it("[§6.5 held-not-busy] a held item stays recoverable; an idle lease blocks only until released", async () => {
		const { tool, entered, release } = await gatedTool();
		const { session, requests } = await sdkFixture({ tools: [tool] });
		let calls = 0;
		session.agent.streamFunction = (_model, context) => {
			requests.push(structuredClone(context.messages));
			return response(
				calls++ === 0
					? assistantTurn(
							[{ type: "toolCall", id: "lease-gate-1", name: "lease_gate", arguments: {} }],
							"toolUse",
						)
					: assistantTurn([{ type: "text", text: "done" }]),
			);
		};
		const control = requireControl(session);
		await control.submit(submitRequest(session, control, "running-turn", "running-turn"));
		await withTimeout(entered.promise, 5000, "tool entered");
		// The second message is queued behind the running turn; stop holds it instead of committing it.
		expect(await control.submit(submitRequest(session, control, "held-target", "held-target"))).toMatchObject(
			{
				ok: true,
				value: { disposition: "queued" },
			},
		);

		control.stop({ ...identity(session, control), requestId: "held-stop" });
		release.resolve();
		await control.waitForIdle();

		const snapshot = control.getSnapshot();
		const item = snapshot.items.find((candidate) => candidate.messageId === "held-target");
		expect(item?.state).toBe("held");

		const lease = session.tryAcquireIdleLease();
		expect(lease).toBeDefined();
		const recover = {
			...identity(session, control),
			requestId: "held-recover",
			messageId: item?.messageId ?? "held-target",
			expectedRevision: control.getSnapshot().revision,
		};
		const blockedRecover = control.recover(recover);
		expect(blockedRecover.ok).toBe(false);
		expect(blockedRecover.ok ? undefined : blockedRecover.error.code).toBe("busy");

		lease?.release();
		expect(control.recover({ ...recover, expectedRevision: control.getSnapshot().revision })).toMatchObject({
			ok: true,
			value: { messageId: "held-target" },
		});
	});

	it("[§6.5 lease-enable] control cannot be enabled under a lease, and a disposed control refuses input", async () => {
		const first = await sdkFixture();
		const lease = first.session.tryAcquireIdleLease();
		expect(lease).toBeDefined();
		expect(() => first.session.enableMessageControl()).toThrow(/idle lease/i);
		lease?.release();

		const control = requireControl(first.session);
		control.dispose();
		const refused = await control.submit(
			submitRequest(first.session, control, "after-dispose", "after-dispose"),
		);
		expect(refused).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(first.requests).toHaveLength(0);
	});
});
