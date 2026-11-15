import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cleanupSdkTest,
	gate,
	installHostPolicy,
	isSummaryRequest,
	MODEL_20K,
	messageText,
	requireControl,
	response,
	sdkFixture,
	textTurn,
	waitForCondition,
	withTimeout,
} from "./message-control-sdk-harness";

/**
 * G5 两个剩余 grant 风险的有界真实 SDK 复现。
 *
 * 仅使用真实 AgentSession / MessageControl / 宿主 setCompactionPolicy / 公开 session 事件
 * 与内存模型流；不覆写 grant、队列、pump 或运行入口。公网/真实模型不参与。
 */

afterEach(async () => {
	await cleanupSdkTest();
});

const SETTINGS = {
	compaction: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 2_000 },
	retry: { enabled: false },
	cacheWarming: "off" as const,
};

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function usage(totalTokens: number) {
	return { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: COST };
}

/** 约 19k token 的真实历史：压缩阈值会触发真实摘要；末尾 assistant 带完整 usage。 */
function compactionHistory(manager: SessionManager) {
	let timestamp = 1;
	for (let index = 0; index < 6; index++) {
		manager.appendMessage({
			role: "user",
			timestamp: timestamp++,
			content: [{ type: "text", text: `turn ${index} ${"x".repeat(4_000)}` }],
		});
		manager.appendMessage({
			role: "assistant",
			api: MODEL_20K.api,
			provider: MODEL_20K.provider,
			model: MODEL_20K.id,
			timestamp: timestamp++,
			stopReason: "stop",
			content: [{ type: "text", text: `answer ${index}` }],
			usage: usage(1_000),
		});
	}
	manager.appendMessage({
		role: "assistant",
		api: MODEL_20K.api,
		provider: MODEL_20K.provider,
		model: MODEL_20K.id,
		timestamp,
		stopReason: "stop",
		content: [{ type: "text", text: "recent" }],
		usage: usage(19_000),
	});
}

function identity(session: AgentSession, control: ReturnType<typeof requireControl>) {
	return { sessionId: session.sessionId, runtimeId: control.getSnapshot().runtimeId };
}

function countUserText(session: AgentSession, text: string): number {
	return session.messages
		.filter((message) => message.role === "user")
		.filter((message) => messageText(message.content).includes(text)).length;
}

function queuedTexts(session: AgentSession): string[] {
	return session.agent
		.getQueuedMessages()
		.filter((message) => message.role === "user")
		.map((message) => messageText(message.content));
}

interface PausedCase {
	fixture: Awaited<ReturnType<typeof sdkFixture>>;
	host: ReturnType<typeof installHostPolicy>;
	control: ReturnType<typeof requireControl>;
	ids: { initial: string; steer: string; queue: string };
	userStarts: string[];
}

/**
 * 初始用户输入触发宿主摘要失败并进入 held；额外 user steer/queue 已 prepared 并在真实 SDK 队列。
 * 这里的 pause 由真实 `installHostPolicy` 安装，不使用私有 pause 写入。
 */
async function pausedCase(
	prefix: string,
	options: {
		hasConfiguredAuth?: boolean;
		pauseOn?: readonly ("failed" | "context-changed" | "still-over-threshold" | "nothing-to-compact")[];
	} = {},
): Promise<PausedCase> {
	const fixture = await sdkFixture({
		model: MODEL_20K,
		settings: SETTINGS,
		noDefaultStream: true,
		history: compactionHistory,
		hasConfiguredAuth: options.hasConfiguredAuth ?? true,
	});
	const host = installHostPolicy(fixture.session, {
		pauseOn: options.pauseOn ?? ["failed", "context-changed"],
	});
	const control = requireControl(fixture.session);
	const summaryEntered = gate();
	const summaryFailed = gate();
	let summaryCalls = 0;
	const userStarts: string[] = [];
	fixture.session.subscribe((event) => {
		if (event.type === "message_start" && event.message.role === "user") {
			userStarts.push(messageText(event.message.content));
		}
	});
	fixture.session.agent.streamFunction = async (_model, context) => {
		fixture.requests.push(structuredClone(context.messages));
		if (isSummaryRequest(context)) {
			summaryCalls++;
			if (summaryCalls === 1) {
				summaryEntered.resolve();
				await summaryFailed.promise;
				throw new Error("summary boom");
			}
			return response(textTurn("## Summary\n- resumed", 100, MODEL_20K));
		}
		return response(textTurn("done", 100, MODEL_20K));
	};
	const ids = { initial: `${prefix}-initial`, steer: `${prefix}-steer`, queue: `${prefix}-queue` };
	const base = identity(fixture.session, control);
	await control.submit({ ...base, requestId: ids.initial, mode: "queue", payload: { text: ids.initial } });
	await withTimeout(summaryEntered.promise, 5_000, `${prefix} summary gate`);
	await control.submit({ ...base, requestId: ids.steer, mode: "steer", payload: { text: ids.steer } });
	await control.submit({ ...base, requestId: ids.queue, mode: "queue", payload: { text: ids.queue } });
	await waitForCondition(() => queuedTexts(fixture.session).length === 2, 5_000, `${prefix} queued`);
	summaryFailed.resolve();
	await waitForCondition(
		() => fixture.session.compactionPause?.reason === "failed",
		5_000,
		`${prefix} pause`,
	);
	await control.waitForIdle();
	expect(host.calls.map((call) => call.status)).toEqual(["failed"]);
	expect(queuedTexts(fixture.session)).toEqual([ids.steer, ids.queue]);
	for (const text of [ids.initial, ids.steer, ids.queue])
		expect(countUserText(fixture.session, text)).toBe(0);
	return { fixture, host, control, ids, userStarts };
}

describe("G5 grant ownership under public MessageControl", () => {
	/**
	 * [G5 grant-interleave] public API condition:
	 * `MessageControl.launch` owns `active` for the whole `_promptUncontrolled` promise, and
	 * `settledPause()` refuses a prepared recovery while `active` exists. A normal prompt in its
	 * auth/prepare window therefore cannot be interleaved with a prepared explicit recovery: the
	 * latter is only queued, and after the prompt settles it runs as a separate explicit recovery.
	 * This test pins that reachable ordering and verifies the old prompt finally does not consume
	 * or clear the later recovery grant and that the batch is sent exactly once.
	 */
	it("[G5 grant-interleave] a normal prompt grant and a prepared explicit recovery are serialized by the public controller, then the recovery sends once", async () => {
		const { fixture, host, control, ids } = await pausedCase("interleave", { hasConfiguredAuth: false });
		const base = identity(fixture.session, control);
		const authEntered = gate();
		const authRelease = gate();
		let armAuth = true;
		const runtime = fixture.session.modelRuntime as unknown as {
			checkAuth: (provider: string) => Promise<unknown>;
		};
		vi.spyOn(runtime, "checkAuth").mockImplementation(async () => {
			if (!armAuth) return { type: "api_key", key: "test-key" };
			armAuth = false;
			authEntered.resolve();
			await authRelease.promise;
			return undefined;
		});

		// 普通 prompt：mode=interrupt 只借用空槽触发 _beginPromptHostResume，不改变已 prepared 的批次。
		const normal = control.submit({
			...base,
			requestId: "interleave-normal",
			mode: "interrupt",
			payload: { text: "interleave-normal" },
		});
		await withTimeout(authEntered.promise, 5_000, "normal prompt auth gate");
		expect(control.getSnapshot()).toMatchObject({
			items: expect.arrayContaining([
				expect.objectContaining({ messageId: ids.initial, state: "held" }),
				expect.objectContaining({ messageId: ids.steer, state: "queued" }),
				expect.objectContaining({ messageId: ids.queue, state: "queued" }),
			]),
		});
		const before = control.getSnapshot().revision;
		const interleaved = await control.changePending({
			...base,
			requestId: "interleave-change",
			messageId: ids.steer,
			expectedRevision: before,
			action: "resend",
		});
		// 未进入 explicit recovery 启动：public API 只把目标放回 queued，不越过 active 的 prompt。
		expect(interleaved).toMatchObject({ ok: true });
		expect(host.calls.map((call) => call.status)).toEqual(["failed"]);
		expect(countUserText(fixture.session, ids.steer)).toBe(0);
		expect(countUserText(fixture.session, ids.queue)).toBe(0);

		// prompt 的认证失败，使其 finally 释放自己的 grant；prepared 目标仍未被发送。
		authRelease.resolve();
		expect(await normal).toMatchObject({ ok: false, error: { code: "preflight_failed" } });
		await control.waitForIdle();
		expect(countUserText(fixture.session, "interleave-normal")).toBe(0);
		expect(countUserText(fixture.session, ids.steer)).toBe(0);
		expect(countUserText(fixture.session, ids.queue)).toBe(0);

		// 旧 prompt settle 之后，prepared 显式 recovery 才领取自己的 grant；批次各一次，无重复。
		const recovered = await control.changePending({
			...base,
			requestId: "interleave-recover",
			messageId: ids.steer,
			expectedRevision: control.getSnapshot().revision,
			action: "resend",
		});
		expect(recovered).toMatchObject({ ok: true });
		await control.waitForIdle();
		expect(host.calls.map((call) => call.status)).toEqual(["failed", "success"]);
		expect(fixture.session.compactionPause).toBeNull();
		expect(countUserText(fixture.session, ids.steer)).toBe(1);
		expect(countUserText(fixture.session, ids.queue)).toBe(1);
		expect(countUserText(fixture.session, ids.initial)).toBe(0);
		expect(countUserText(fixture.session, "interleave-normal")).toBe(0);
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: false,
			items: expect.arrayContaining([expect.objectContaining({ messageId: ids.initial, state: "held" })]),
		});
	});

	/**
	 * [G5 grant-context-changed] 授权在 prepared 运行中已消费后，通过公开 session 事件把
	 * 当前 model 改成另一合法对象，使宿主快照失效；宿主策略只对 failed 暂停，对
	 * context-changed 明确不 pause。运行结束后 `_hostResumeBatch` 必须已被 run 作用域清理，
	 * 不能留给后续普通 prepared run 解除暂停/补发。
	 */
	it("[G5 grant-context-changed] a consumed prepared grant leaves no resume bit after a context-changed result that does not pause", async () => {
		const { fixture, host, control, ids } = await pausedCase("ctx", { pauseOn: ["failed"] });
		const base = identity(fixture.session, control);
		let mutated = false;
		const unsubscribe = fixture.session.subscribe((event) => {
			if (mutated || event.type !== "message_start" || event.message.role !== "user") return;
			if (!messageText(event.message.content).includes(ids.queue)) return;
			mutated = true;
			// 真实 model gate：切换成另一个合法模型，使 _hostPendingContextIsCurrent 判定快照失效。
			fixture.session.agent.state.model = { ...MODEL_20K, id: "g5-context-changed" };
		});
		const changed = await control.changePending({
			...base,
			requestId: "ctx-change",
			messageId: ids.queue,
			expectedRevision: control.getSnapshot().revision,
			action: "resend",
		});
		expect(changed).toMatchObject({ ok: true });
		await control.waitForIdle();
		unsubscribe();
		expect(mutated).toBe(true);
		expect(host.calls.map((call) => call.status)).toEqual(["failed", "success", "context-changed"]);
		// 失败路径没有暂停；grant 由本次 run 的 finally 清理，不能留给后续普通 prepared run。
		expect(fixture.session.compactionPause).toBeNull();
		const grant = fixture.session as unknown as { _hostResumeBatch?: boolean; _promptHostResume?: unknown };
		expect(grant._hostResumeBatch).toBe(false);
		expect(grant._promptHostResume).toBeUndefined();
	});
});
