import type { AssistantMessage, SystemMessage, TranscriptContext } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	ExtensionAPI,
	ExtensionFactory,
	SessionManager,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { MessagePayload } from "@percho/shared";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageControlHandle } from "../src/session/message-control";
import {
	assistantTurn,
	cleanupSdkTest,
	type Gate,
	gate,
	installHostPolicy,
	isSummaryRequest,
	MODEL_20K,
	messageText,
	requireControl,
	response,
	SUMMARY_MARKER,
	sdkFixture,
	textTurn,
	waitForCondition,
	withTimeout,
} from "./message-control-sdk-harness";

/**
 * 真实压缩入口（session.compact / 阈值 / 溢出）、托管模式，以及宿主请求策略的双暂停协调。
 *
 * 覆盖方式：宿主侧一律用真实 `setCompactionPolicy`（见 harness `installHostPolicy`），控制器一律用真实
 * `enableMessageControl`，不 mock 图片归一化、不写私有队列或 host 标志。
 *
 * 仍未覆盖（需在 S4 单独判定，不写假测试）：
 * - 宿主交互式 resume 的合批语义完全由 SDK `_prepareHostPending` 拥有；本文件只验证“实测到的”批次次序，
 *   不自行规定先后（如 queue/steer 两个用户槽都被占用时，裸新用户 queue 消息只会得到 `queue_full`，
 *   见 `host-pause-user-slot`）。
 * - `changePending({action:"resend"})` 只对「已持有用户实体的显式无损恢复」直接启动目标，
 *   见 `host-pause-resend-initial` / `host-pause-resend-prepared` 与 §11.6 的恢复用例。
 */

afterEach(async () => {
	await cleanupSdkTest();
});

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const COMPACTION_SETTINGS = {
	compaction: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 2_000 },
	retry: { enabled: false },
	cacheWarming: "off" as const,
};

/**
 * 图片夹具用同一份压缩设置，但显式关掉自动缩放：这些用例只验证 1x1 payload 的原文
 * 透传、恢复身份与压缩批次，不验证缩放器；默认 autoResize 的真实缩放路径由
 * `message-control-sdk-image.test.ts` 覆盖。关缩放后仍是真实 `_normalizePromptImages`
 * 路径（不 mock），合法 PNG 原样投递。
 */
const IMAGE_SETTINGS = { ...COMPACTION_SETTINGS, images: { autoResize: false } };

/** 真实 1x1 PNG（与 compaction-image 夹具同一份合法编码），不用 AQIDBA 这类假字节。 */
const PNG_1X1 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lP3xWQAAAABJRU5ErkJggg==";

function usage(totalTokens: number): AssistantMessage["usage"] {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: COST,
	};
}

function assistantHistory(
	manager: SessionManager,
	timestamp: number,
	options: {
		totalTokens?: number;
		text?: string;
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
	} = {},
) {
	manager.appendMessage({
		role: "assistant",
		api: MODEL_20K.api,
		provider: MODEL_20K.provider,
		model: MODEL_20K.id,
		timestamp,
		stopReason: options.stopReason ?? "stop",
		...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
		content: [{ type: "text", text: options.text ?? "ack" }],
		usage: usage(options.totalTokens ?? 1_000),
	});
}

/** 真实 SessionManager 历史：每轮约 1000 token，末尾 assistant 带完整 usage。 */
function compactionHistory(manager: SessionManager, options: { overflow?: boolean } = {}) {
	let timestamp = 1;
	for (let index = 0; index < 6; index++) {
		manager.appendMessage({
			role: "user",
			timestamp: timestamp++,
			content: [{ type: "text", text: `turn ${index} ${"x".repeat(4_000)}` }],
		});
		assistantHistory(manager, timestamp++, { totalTokens: 1_000, text: `answer ${index}` });
	}
	if (options.overflow) {
		assistantHistory(manager, timestamp, {
			totalTokens: 19_000,
			text: "partial",
			stopReason: "error",
			errorMessage: "prompt is too long: 25000 tokens > 20000 maximum",
		});
	} else {
		assistantHistory(manager, timestamp, { totalTokens: 19_000, text: "recent" });
	}
}

/** 只用于工具边界 gate；不等于控制器，也不改队列/仲裁。 */
const controlledGate: ToolDefinition = {
	name: "controlled_gate",
	label: "gate",
	description: "memory-only compaction test tool",
	parameters: Type.Object({}),
	execute: async (_id, _args, signal) => {
		signal?.addEventListener("abort", () => undefined, { once: true });
		return { content: [{ type: "text", text: "ok" }], details: {} };
	},
};

function identity(session: AgentSession, control: MessageControlHandle) {
	return {
		sessionId: session.sessionId,
		runtimeId: control.getSnapshot().runtimeId,
	};
}

function countUserText(session: AgentSession, text: string): number {
	return session.messages
		.filter((message) => message.role === "user")
		.filter((message) => messageText(message.content).includes(text)).length;
}

/** 真实 transcript 里带指定图片数据的用户消息数（content 先窄化成块数组，不走 any）。 */
function countUserImages(session: AgentSession, data: string): number {
	return session.messages
		.filter((message) => message.role === "user")
		.filter(
			(message) =>
				Array.isArray(message.content) &&
				message.content.some((item) => item.type === "image" && item.data === data),
		).length;
}

/**
 * `agent.getQueuedMessages()` 里的真实用户文本（SDK 队列租约，不是控制器快照）。
 * 宿主路径会在队列里保留一条 system 前缀消息，这里只取 user 角色。
 */
function queuedTexts(session: AgentSession, kind?: "steer" | "followUp"): string[] {
	return session.agent
		.getQueuedMessages(kind)
		.filter((message) => message.role === "user")
		.map((message) => messageText(message.content));
}

/** 默认文本载荷；需要验证载荷透传时显式传入图片/草稿。 */
function submit(
	session: AgentSession,
	control: MessageControlHandle,
	id: string,
	mode: "queue" | "steer" | "interrupt" = "queue",
	payload: MessagePayload = { text: id },
) {
	return control.submit({
		...identity(session, control),
		requestId: id,
		mode,
		payload,
	});
}

async function recoverAndResubmit(
	session: AgentSession,
	control: MessageControlHandle,
	messageId: string,
	text: string,
	requestId: string,
) {
	const recovered = control.recover({
		...identity(session, control),
		requestId: `${requestId}-recover`,
		messageId,
		expectedRevision: control.getSnapshot().revision,
	});
	if (!recovered.ok) throw new Error(`recover ${messageId} failed: ${recovered.error.message}`);
	expect(recovered.value).toMatchObject({ messageId, payload: { text } });
	const result = await control.submit({
		...identity(session, control),
		requestId,
		mode: "queue",
		payload: recovered.value.payload,
		recovery: { messageId, expectedRevision: control.getSnapshot().revision },
	});
	expect(result).toMatchObject({ ok: true });
}

interface SummaryStreamOptions {
	summary?: string;
	onModelCall?: (call: number) => AssistantMessage;
}

/** 工具调用历史：让 prepareCompaction 有可摘要内容，末端 usage 很低，先不触发压缩。 */
function toolHistory(manager: SessionManager) {
	let timestamp = 1;
	for (let index = 0; index < 3; index++) {
		manager.appendMessage({
			role: "user",
			timestamp: timestamp++,
			content: [{ type: "text", text: `history ${index} ${"y".repeat(4_000)}` }],
		});
		assistantHistory(manager, timestamp++, { totalTokens: 1_000, text: `history answer ${index}` });
	}
}

/** 摘要请求通过首条 system 消息区分（见 harness 导出）；命中时在真实摘要请求前停下。 */
function installSummaryStream(
	session: AgentSession,
	requests: unknown[][],
	summaryGate: { entered: Gate; release: Gate },
	options: SummaryStreamOptions = {},
) {
	let modelCalls = 0;
	session.agent.streamFunction = async (_model, context) => {
		requests.push(structuredClone(context.messages));
		if (isSummaryRequest(context)) {
			summaryGate.entered.resolve();
			await summaryGate.release.promise;
			return response(textTurn(options.summary ?? "## Summary\n- checkpoint"));
		}
		return response((options.onModelCall ?? (() => textTurn("done")))(++modelCalls));
	};
}

/**
 * 运行内触发：第一次请求返回工具调用，放行后第二次请求带越过阈值的 usage，
 * 由真实 `_handlePostAgentRun` 进入自动压缩。托管 auto fixture 复用同一形状。
 */
function installPostRunAutoStream(
	session: AgentSession,
	requests: unknown[][],
	summaryGate: { entered: Gate; release: Gate },
	log?: string[],
) {
	let modelCalls = 0;
	session.agent.streamFunction = async (_model, context) => {
		requests.push(structuredClone(context.messages));
		if (isSummaryRequest(context)) {
			summaryGate.entered.resolve();
			await summaryGate.release.promise;
			return response(textTurn("## Summary\n- auto"));
		}
		modelCalls++;
		log?.push(`model:${modelCalls}`);
		return response(
			modelCalls === 1
				? assistantTurn(
						[
							{
								type: "toolCall",
								id: "gate-1",
								name: "controlled_gate",
								arguments: {},
							},
						],
						"toolUse",
						MODEL_20K,
					)
				: textTurn("done", 19_000, MODEL_20K),
		);
	};
}

describe("real compaction entries (unmanaged calibration)", () => {
	it("[§6.5 compact-unmanaged-manual] real manual compaction reaches the summary gate and completes", async () => {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: (manager) => compactionHistory(manager),
			settings: COMPACTION_SETTINGS,
			noDefaultStream: true,
		});
		const entered = gate(),
			release = gate();
		installSummaryStream(fixture.session, fixture.requests, { entered, release });
		const ends: Array<{ reason?: string; aborted?: boolean }> = [];
		fixture.session.subscribe((event) => {
			if (event.type === "compaction_end") ends.push(event);
		});

		const compaction = fixture.session.compact("manual focus");
		await withTimeout(entered.promise, 5_000, "manual compaction summary gate");
		expect(fixture.session.isCompacting).toBe(true);
		expect(fixture.requests).toHaveLength(1);
		release.resolve();
		const result = await withTimeout(compaction, 5_000, "manual compaction completes");
		expect(result.summary).toContain("Summary");
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({ reason: "manual", aborted: false });
		expect(fixture.session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(
			true,
		);
	});

	it("[§6.5 compact-unmanaged-threshold] real threshold compaction reaches the summary gate and settles", async () => {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: (manager) => compactionHistory(manager),
			settings: COMPACTION_SETTINGS,
			noDefaultStream: true,
		});
		const entered = gate(),
			release = gate();
		installSummaryStream(fixture.session, fixture.requests, { entered, release });
		const ends: Array<{ reason?: string; aborted?: boolean }> = [];
		fixture.session.subscribe((event) => {
			if (event.type === "compaction_end") ends.push(event);
		});

		const prompting = fixture.session.prompt("after threshold");
		await withTimeout(entered.promise, 5_000, "threshold compaction summary gate");
		release.resolve();
		await withTimeout(prompting, 5_000, "prompt after threshold");
		await withTimeout(fixture.session.waitForIdle(), 5_000, "idle after threshold");
		expect(ends).toContainEqual(expect.objectContaining({ reason: "threshold", aborted: false }));
		expect(fixture.requests).toHaveLength(2);
		expect(JSON.stringify(fixture.requests.at(-1))).toContain("after threshold");
	});

	it("[§6.5 compact-unmanaged-overflow] real overflow compaction reaches the summary gate and settles", async () => {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: (manager) => compactionHistory(manager, { overflow: true }),
			settings: COMPACTION_SETTINGS,
			noDefaultStream: true,
		});
		const entered = gate(),
			release = gate();
		installSummaryStream(fixture.session, fixture.requests, { entered, release });
		const ends: Array<{ reason?: string; aborted?: boolean }> = [];
		fixture.session.subscribe((event) => {
			if (event.type === "compaction_end") ends.push(event);
		});

		const prompting = fixture.session.prompt("after overflow");
		await withTimeout(entered.promise, 5_000, "overflow compaction summary gate");
		release.resolve();
		await withTimeout(prompting, 5_000, "prompt after overflow");
		await withTimeout(fixture.session.waitForIdle(), 5_000, "idle after overflow");
		expect(ends).toContainEqual(expect.objectContaining({ reason: "overflow", aborted: false }));
		expect(JSON.stringify(fixture.requests.at(-1))).toContain("after overflow");
	});

	it("[§6.5 compact-unmanaged-post-run] post-run tool turn crossing the threshold compacts through the summary gate", async () => {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			tools: [controlledGate],
			history: toolHistory,
			settings: COMPACTION_SETTINGS,
			noDefaultStream: true,
		});
		const entered = gate(),
			release = gate();
		const log: string[] = [];
		installPostRunAutoStream(fixture.session, fixture.requests, { entered, release }, log);
		const ends: Array<{ reason?: string; aborted?: boolean }> = [];
		fixture.session.subscribe((event) => {
			if (event.type === "compaction_end") ends.push(event);
		});

		const prompting = fixture.session.prompt("post-run tool turn");
		await withTimeout(entered.promise, 5_000, "post-run threshold summary gate");
		expect(fixture.session.isCompacting).toBe(true);
		release.resolve();
		await withTimeout(prompting, 5_000, "prompt after post-run compaction");
		await withTimeout(fixture.session.waitForIdle(), 5_000, "idle after post-run compaction");
		expect(log).toEqual(["model:1", "model:2"]);
		expect(ends).toContainEqual(expect.objectContaining({ reason: "threshold", aborted: false }));
	});

	it("[§6.5 summary-detection-calibration] the shared summary detector matches real normalized contexts", async () => {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: (manager) => compactionHistory(manager),
			settings: COMPACTION_SETTINGS,
			noDefaultStream: true,
		});
		const contexts: TranscriptContext[] = [];
		const detections: boolean[] = [];
		const entered = gate(),
			release = gate();
		fixture.session.agent.streamFunction = async (_model, context) => {
			contexts.push(context);
			detections.push(isSummaryRequest(context));
			fixture.requests.push(structuredClone(context.messages));
			if (isSummaryRequest(context)) {
				entered.resolve();
				await release.promise;
				return response(textTurn("## Summary\n- calibration"));
			}
			return response(textTurn("calibrated", 19_000, MODEL_20K));
		};

		const prompting = fixture.session.prompt("calibration turn");
		await withTimeout(entered.promise, 5_000, "calibration summary gate");
		release.resolve();
		await withTimeout(prompting, 5_000, "prompt after calibration compaction");
		await withTimeout(fixture.session.waitForIdle(), 5_000, "idle after calibration");

		// 真实 fixture 的 normalized context 没有顶层 systemPrompt，系统提示只在 messages 里。
		const summaryIndex = contexts.findIndex((context) => isSummaryRequest(context));
		expect(summaryIndex).toBeGreaterThanOrEqual(0);
		const summaryContext = contexts[summaryIndex];
		if (!summaryContext) throw new Error("missing summary context in calibration fixture");
		expect(Object.hasOwn(summaryContext, "systemPrompt")).toBe(false);
		const summarySystem = summaryContext.messages.find(
			(message): message is SystemMessage => message.role === "system",
		);
		expect(messageText(summarySystem?.content ?? "")).toContain(SUMMARY_MARKER);
		expect(detections[summaryIndex]).toBe(true);
		for (const [index, context] of contexts.entries()) {
			if (index === summaryIndex) continue;
			expect(detections[index]).toBe(false);
			for (const system of context.messages.filter(
				(message): message is SystemMessage => message.role === "system",
			)) {
				expect(messageText(system.content)).not.toContain(SUMMARY_MARKER);
			}
		}
		expect(detections.filter(Boolean)).toHaveLength(1);
	});
});

describe("managed compaction modes", () => {
	it("[§6.5 compact-manual] real manual compaction rejects queue/steer/interrupt and preserves the payload", async () => {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: (manager) => compactionHistory(manager),
			settings: COMPACTION_SETTINGS,
			noDefaultStream: true,
		});
		const control = requireControl(fixture.session);
		const entered = gate(),
			release = gate();
		installSummaryStream(fixture.session, fixture.requests, { entered, release });

		const compaction = fixture.session.compact("managed manual");
		await withTimeout(entered.promise, 5_000, "managed manual compaction summary gate");
		const payload = {
			text: "during manual compaction",
			draft: {
				text: "draft",
				attachments: ["a.ts"],
				quotes: ["quote"],
				slashCommand: null,
			},
		};
		for (const mode of ["queue", "steer", "interrupt"] as const) {
			expect(
				await control.submit({
					...identity(fixture.session, control),
					requestId: `manual-${mode}`,
					mode,
					payload,
				}),
			).toMatchObject({ ok: false, error: { code: "compacting" } });
		}
		release.resolve();
		await withTimeout(compaction, 5_000, "managed manual compaction completes");

		const accepted = await control.submit({
			...identity(fixture.session, control),
			requestId: "manual-after",
			mode: "queue",
			payload,
		});
		expect(accepted).toMatchObject({ ok: true, value: { disposition: "started" } });
		await control.waitForIdle();
		expect(JSON.stringify(fixture.requests.at(-1))).toContain("during manual compaction");
	});

	async function autoCompactionFixture() {
		const toolEntered = gate(),
			releaseTool = gate();
		const tool: ToolDefinition = {
			...controlledGate,
			execute: async () => {
				toolEntered.resolve();
				await releaseTool.promise;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const fixture = await sdkFixture({
			model: MODEL_20K,
			tools: [tool],
			settings: COMPACTION_SETTINGS,
			noDefaultStream: true,
			history: toolHistory,
		});
		const entered = gate(),
			release = gate();
		const log: string[] = [];
		installPostRunAutoStream(fixture.session, fixture.requests, { entered, release }, log);
		fixture.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user")
				log.push(`user:${messageText(event.message.content)}`);
		});
		const control = requireControl(fixture.session);
		await control.submit({
			...identity(fixture.session, control),
			requestId: "auto-run",
			mode: "queue",
			payload: { text: "auto-run" },
		});
		await withTimeout(toolEntered.promise, 5_000, "auto compaction tool entered");
		releaseTool.resolve();
		await withTimeout(entered.promise, 5_000, "auto compaction summary gate");
		expect(fixture.session.isCompacting).toBe(true);
		return { fixture, control, log, entered, release };
	}

	it.each(["queue", "steer"] as const)(
		"[§6.5 compact-auto-%s] auto compaction accepts the mode and delivers it exactly once afterwards",
		async (mode) => {
			const { fixture, control, log, release } = await autoCompactionFixture();
			const ack = await control.submit({
				...identity(fixture.session, control),
				requestId: `auto-${mode}`,
				mode,
				payload: { text: `auto-${mode}` },
			});
			expect(ack).toMatchObject({ ok: true, value: { disposition: "queued" } });
			release.resolve();
			await control.waitForIdle();
			expect(log.filter((entry) => entry === `user:auto-${mode}`)).toHaveLength(1);
			expect(control.getSnapshot().items).toEqual([]);
		},
	);

	it("[§6.5 compact-auto-interrupt] auto compaction interrupt stops the summary, holds the old queue and delivers once", async () => {
		const { fixture, control, log, release } = await autoCompactionFixture();
		const ends: Array<{ reason?: string; aborted?: boolean }> = [];
		fixture.session.subscribe((event) => {
			if (event.type === "compaction_end") ends.push(event);
		});
		const ack = await control.submit({
			...identity(fixture.session, control),
			requestId: "auto-interrupt",
			mode: "interrupt",
			payload: { text: "auto-interrupt" },
		});
		expect(ack).toMatchObject({ ok: true, value: { disposition: "interrupting" } });
		release.resolve();
		await control.waitForIdle();
		expect(log.filter((entry) => entry === "user:auto-interrupt")).toHaveLength(1);
		expect(ends).toContainEqual(expect.objectContaining({ aborted: true }));
		expect(control.getSnapshot().items).toEqual([]);
	});
});

/**
 * P1-6-S3：真实宿主请求策略（`setCompactionPolicy`）与本地 MessageControl 的双暂停协调。
 *
 * 宿主的 threshold/overflow 检查位于下一请求前；本地控制器仍独占用户消息的 held/recovering
 * 与调度。压缩成功由请求继续释放；失败类结果必须由控制器持有并等待显式 recover，
 * 不得在 SDK 保留队列或控制器 kick 中产生第二份自动重试。
 */
describe("host request policy and message control (P1-6-S3)", () => {
	it("[§6.5 host-policy-off] a disabled host policy keeps native post-run auto compaction without host results", async () => {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			tools: [controlledGate],
			history: toolHistory,
			settings: COMPACTION_SETTINGS,
			noDefaultStream: true,
		});
		const host = installHostPolicy(fixture.session, { enabled: false });
		const entered = gate(),
			release = gate();
		installPostRunAutoStream(fixture.session, fixture.requests, { entered, release });
		const control = requireControl(fixture.session);

		expect(await submit(fixture.session, control, "host-off-run")).toMatchObject({ ok: true });
		await withTimeout(entered.promise, 5_000, "host-off post-run summary gate");
		expect(fixture.session.isCompacting).toBe(true);
		expect(fixture.session.compactionPause).toBeNull();
		expect(host.calls).toEqual([]);

		release.resolve();
		await control.waitForIdle();
		expect(host.calls).toEqual([]);
		expect(fixture.session.compactionPause).toBeNull();
		expect(countUserText(fixture.session, "host-off-run")).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ phase: "idle", autoDispatchPaused: false, items: [] });
	});

	it("[§6.5 host-threshold-order] host compaction runs before the request, then releases the controller with success", async () => {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: compactionHistory,
			settings: COMPACTION_SETTINGS,
			noDefaultStream: true,
		});
		const order: string[] = [];
		const host = installHostPolicy(fixture.session, {
			onResult: (result) => order.push(`policy:${result.status}`),
		});
		const entered = gate(),
			release = gate();
		installSummaryStream(
			fixture.session,
			fixture.requests,
			{ entered, release },
			{
				onModelCall: () => textTurn("done", 100, MODEL_20K),
			},
		);
		const control = requireControl(fixture.session);
		let atStart: { pause: string | null; paused: boolean } | undefined;
		fixture.session.subscribe((event) => {
			if (event.type === "compaction_end") order.push(`compaction_end:${event.reason}:${event.aborted}`);
			if (event.type === "message_start" && event.message.role === "user") {
				order.push(`message_start:${messageText(event.message.content)}`);
				atStart = {
					pause: fixture.session.compactionPause?.reason ?? null,
					paused: control.getSnapshot().autoDispatchPaused,
				};
			}
		});

		expect(await submit(fixture.session, control, "host-order")).toMatchObject({ ok: true });
		await withTimeout(entered.promise, 5_000, "host threshold summary gate");
		expect(fixture.session.isCompacting).toBe(true);
		expect(fixture.session.compactionPause).toBeNull();
		expect(control.getSnapshot()).toMatchObject({ phase: "compacting", autoDispatchPaused: false });
		expect(JSON.stringify(fixture.requests[0])).toContain(SUMMARY_MARKER);
		expect(countUserText(fixture.session, "host-order")).toBe(0);

		release.resolve();
		await control.waitForIdle();

		expect(host.calls.map((call) => call.status)).toEqual(["success"]);
		expect(fixture.session.compactionPause).toBeNull();
		expect(countUserText(fixture.session, "host-order")).toBe(1);
		expect(JSON.stringify(fixture.requests.at(-1))).toContain("host-order");
		expect(control.getSnapshot()).toMatchObject({ phase: "idle", autoDispatchPaused: false, items: [] });
		const endIndex = order.findIndex((entry) => entry.startsWith("compaction_end"));
		const successIndex = order.indexOf("policy:success");
		const startIndex = order.findIndex((entry) => entry.startsWith("message_start"));
		expect(endIndex).toBeGreaterThanOrEqual(0);
		expect(successIndex).toBeGreaterThan(endIndex);
		expect(startIndex).toBeGreaterThan(successIndex);
		expect(atStart).toEqual({ pause: null, paused: false });
	});

	it("[§6.5 host-manual-policy] manual compaction ignores the host request policy and still rejects all modes", async () => {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: compactionHistory,
			settings: COMPACTION_SETTINGS,
			noDefaultStream: true,
		});
		const host = installHostPolicy(fixture.session);
		const entered = gate(),
			release = gate();
		installSummaryStream(fixture.session, fixture.requests, { entered, release });
		const control = requireControl(fixture.session);

		const compaction = fixture.session.compact("manual focus");
		await withTimeout(entered.promise, 5_000, "host manual summary gate");
		expect(control.getSnapshot().compactionKind).toBe("manual");
		for (const mode of ["queue", "steer", "interrupt"] as const) {
			expect(await submit(fixture.session, control, `host-manual-${mode}`, mode)).toMatchObject({
				ok: false,
				error: { code: "compacting" },
			});
		}
		expect(host.calls).toEqual([]);

		release.resolve();
		await withTimeout(compaction, 5_000, "host manual compaction completes");
		expect(host.calls).toEqual([]);
		expect(fixture.session.compactionPause).toBeNull();

		expect(await submit(fixture.session, control, "host-manual-after")).toMatchObject({ ok: true });
		await control.waitForIdle();
		expect(countUserText(fixture.session, "host-manual-after")).toBe(1);
	});

	it.each(["queue", "steer"] as const)(
		"[§6.5 host-auto-%s] the mode is accepted during the host summary gate and delivered once",
		async (mode) => {
			const fixture = await sdkFixture({
				model: MODEL_20K,
				history: compactionHistory,
				settings: COMPACTION_SETTINGS,
				noDefaultStream: true,
			});
			const host = installHostPolicy(fixture.session);
			const entered = gate(),
				release = gate();
			installSummaryStream(
				fixture.session,
				fixture.requests,
				{ entered, release },
				{
					onModelCall: () => textTurn("done", 100, MODEL_20K),
				},
			);
			const control = requireControl(fixture.session);

			await submit(fixture.session, control, "host-gate-run");
			await withTimeout(entered.promise, 5_000, `host ${mode} summary gate`);
			const ack = await submit(fixture.session, control, `host-${mode}`, mode);
			expect(ack).toMatchObject({ ok: true, value: { disposition: "queued" } });

			release.resolve();
			await control.waitForIdle();
			expect(host.calls.map((call) => call.status)).toEqual(["success"]);
			expect(countUserText(fixture.session, `host-${mode}`)).toBe(1);
			expect(control.getSnapshot().items).toEqual([]);
		},
	);

	it("[§6.5 host-auto-interrupt] interrupt cancels the host summary, keeps the old item held, and only explicit recover sends it", async () => {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: compactionHistory,
			settings: IMAGE_SETTINGS,
			noDefaultStream: true,
		});
		const host = installHostPolicy(fixture.session);
		const entered = gate(),
			release = gate();
		installSummaryStream(
			fixture.session,
			fixture.requests,
			{ entered, release },
			{
				onModelCall: () => textTurn("done", 100, MODEL_20K),
			},
		);
		const control = requireControl(fixture.session);
		const ends: Array<{ reason?: string; aborted?: boolean }> = [];
		fixture.session.subscribe((event) => {
			if (event.type === "compaction_end") ends.push(event);
		});

		const payload: MessagePayload = {
			text: "host-old完整草稿 text",
			images: [{ data: PNG_1X1, mimeType: "image/png" }],
			draft: {
				text: "host-old完整草稿 text",
				attachments: ["file:report.pdf"],
				quotes: ["quote:42"],
				slashCommand: null,
				imageNames: ["scan.png"],
			},
		};
		const original = await submit(fixture.session, control, "host-old", "queue", payload);
		expect(original).toMatchObject({ ok: true, value: { disposition: "started" } });
		await withTimeout(entered.promise, 5_000, "host interrupt summary gate");
		const ack = await submit(fixture.session, control, "host-interrupt", "interrupt");
		expect(ack).toMatchObject({ ok: true, value: { disposition: "interrupting" } });
		release.resolve();
		await control.waitForIdle();
		expect(ends).toContainEqual(expect.objectContaining({ aborted: true }));
		expect(host.calls.some((call) => call.status === "cancelled")).toBe(true);
		expect(countUserText(fixture.session, "host-interrupt")).toBe(1);
		expect(countUserText(fixture.session, "host-old完整草稿 text")).toBe(0);
		expect(countUserImages(fixture.session, PNG_1X1)).toBe(0);
		expect(control.getSnapshot().items).toEqual([
			expect.objectContaining({ messageId: "host-old", state: "held", imageCount: 1 }),
		]);

		const recovered = control.recover({
			...identity(fixture.session, control),
			requestId: "host-old-resend-recover",
			messageId: "host-old",
			expectedRevision: control.getSnapshot().revision,
		});
		if (!recovered.ok) throw new Error(`recover host-old failed: ${recovered.error.message}`);
		// 完整载荷（含图片与草稿）必须原样回来，而不是回退成 {text: ""}。
		expect(recovered.value.messageId).toBe("host-old");
		expect(recovered.value.payload).toEqual(payload);
		release.resolve();
		const result = await control.submit({
			...identity(fixture.session, control),
			requestId: "host-old-resend",
			mode: "queue",
			payload: recovered.value.payload,
			recovery: { messageId: "host-old", expectedRevision: control.getSnapshot().revision },
		});
		if (!result.ok) throw new Error(`resend host-old failed: ${result.error.message}`);
		expect(result.value).toMatchObject({ messageId: "host-old" });
		await control.waitForIdle();
		expect(countUserText(fixture.session, "host-old完整草稿 text")).toBe(1);
		// 图片同样走真实归一化并只投递一次（IMAGE_SETTINGS 关缩放，合法 PNG 原样保留）。
		expect(countUserImages(fixture.session, PNG_1X1)).toBe(1);
		expect(countUserText(fixture.session, "host-interrupt")).toBe(1);
		expect(control.getSnapshot().items).toEqual([]);
	});

	it("[§6.5 host-failed-payload] a failed host compaction holds the full payload once and the explicit recover resends it exactly once", async () => {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: compactionHistory,
			settings: IMAGE_SETTINGS,
			noDefaultStream: true,
		});
		const host = installHostPolicy(fixture.session);
		const control = requireControl(fixture.session);
		const entered = gate(),
			release = gate();
		let summaryCalls = 0;
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			if (isSummaryRequest(context)) {
				summaryCalls++;
				if (summaryCalls === 1) throw new Error("summary boom");
				entered.resolve();
				await release.promise;
				return response(textTurn("## Summary\n- payload", 100, MODEL_20K));
			}
			return response(textTurn("done", 100, MODEL_20K));
		};
		const payload: MessagePayload = {
			text: "host-failed 草稿 text",
			images: [{ data: PNG_1X1, mimeType: "image/png" }],
			draft: {
				text: "host-failed 草稿 text",
				attachments: ["file:spec.md"],
				quotes: ["quote:7"],
				slashCommand: null,
				imageNames: ["spec.png"],
			},
		};

		const ack = await submit(fixture.session, control, "host-failed-payload", "queue", payload);
		expect(ack).toMatchObject({ ok: true, value: { disposition: "started" } });
		await waitForCondition(
			() => host.calls.some((call) => call.status === "failed"),
			5_000,
			"host failed payload result",
		);
		await waitForCondition(
			() => control.getSnapshot().autoDispatchPaused,
			5_000,
			"host failed payload pause",
		);
		expect(summaryCalls).toBe(1);
		expect(host.calls.map((call) => call.status)).toEqual(["failed"]);
		expect(fixture.session.compactionPause?.reason).toBe("failed");
		expect(control.getSnapshot().items).toEqual([
			expect.objectContaining({
				messageId: "host-failed-payload",
				state: "held",
				imageCount: 1,
				preview: payload.text,
			}),
		]);
		expect(countUserText(fixture.session, payload.text)).toBe(0);
		expect(countUserImages(fixture.session, PNG_1X1)).toBe(0);

		const recovered = control.recover({
			...identity(fixture.session, control),
			requestId: "host-failed-payload-recover",
			messageId: "host-failed-payload",
			expectedRevision: control.getSnapshot().revision,
		});
		if (!recovered.ok) throw new Error(`recover failed: ${recovered.error.message}`);
		expect(recovered.value.payload).toEqual(payload);

		const resend = await control.submit({
			...identity(fixture.session, control),
			requestId: "host-failed-payload-resend",
			mode: "queue",
			payload: recovered.value.payload,
			recovery: { messageId: "host-failed-payload", expectedRevision: control.getSnapshot().revision },
		});
		if (!resend.ok) throw new Error(`resend failed: ${resend.error.message}`);
		await withTimeout(entered.promise, 5_000, "host failed payload recover summary gate");
		release.resolve();
		await control.waitForIdle();

		expect(summaryCalls).toBe(2);
		expect(host.calls.map((call) => call.status)).toEqual(["failed", "success"]);
		expect(fixture.session.compactionPause).toBeNull();
		expect(countUserText(fixture.session, payload.text)).toBe(1);
		expect(countUserImages(fixture.session, PNG_1X1)).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ autoDispatchPaused: false, items: [] });
	});

	it("[§6.5 host-failed] a failed host compaction holds the input once, survives policy reset, and resumes only on recover", async () => {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: compactionHistory,
			settings: COMPACTION_SETTINGS,
			noDefaultStream: true,
		});
		const host = installHostPolicy(fixture.session);
		const control = requireControl(fixture.session);
		const entered = gate(),
			release = gate();
		let summaryCalls = 0;
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			if (isSummaryRequest(context)) {
				summaryCalls++;
				if (summaryCalls === 1) throw new Error("summary boom");
				entered.resolve();
				await release.promise;
				return response(textTurn("## Summary\n- recovered", 100, MODEL_20K));
			}
			return response(textTurn("done", 100, MODEL_20K));
		};

		const ack = await submit(fixture.session, control, "host-fail");
		expect(ack).toMatchObject({ ok: true, value: { disposition: "started" } });
		await waitForCondition(
			() => host.calls.some((call) => call.status === "failed"),
			5_000,
			"host failed result",
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(summaryCalls).toBe(1);
		expect(host.calls.map((call) => call.status)).toEqual(["failed"]);
		expect(fixture.session.compactionPause?.reason).toBe("failed");
		expect(control.getSnapshot()).toMatchObject({
			phase: "idle",
			autoDispatchPaused: true,
			items: [expect.objectContaining({ messageId: "host-fail", state: "held" })],
		});
		expect(JSON.stringify(fixture.session.agent.getQueuedMessages())).not.toContain("host-fail");

		// 重新安装策略只递增 host generation，不会替控制器清除 paused/held。
		fixture.session.setCompactionPolicy(host.policy);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(summaryCalls).toBe(1);
		expect(fixture.session.compactionPause?.reason).toBe("failed");
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: true,
			items: [expect.objectContaining({ messageId: "host-fail", state: "held" })],
		});

		await recoverAndResubmit(fixture.session, control, "host-fail", "host-fail", "host-fail-resend");
		await withTimeout(entered.promise, 5_000, "host failed recover summary gate");
		release.resolve();
		await control.waitForIdle();
		expect(host.calls.map((call) => call.status)).toEqual(["failed", "success"]);
		expect(fixture.session.compactionPause).toBeNull();
		expect(countUserText(fixture.session, "host-fail")).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ autoDispatchPaused: false, items: [] });
	});

	it("[§6.5 host-nothing-to-compact] an empty compaction holds locally and resumes after an explicit recover", async () => {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: compactionHistory,
			settings: COMPACTION_SETTINGS,
			noDefaultStream: true,
		});
		const host = installHostPolicy(fixture.session);
		const entered = gate(),
			release = gate();
		let summaryCalls = 0;
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			if (isSummaryRequest(context)) {
				summaryCalls++;
				entered.resolve();
				await release.promise;
				return response(textTurn("## Summary\n- first", 100, MODEL_20K));
			}
			return response(textTurn("done", 100, MODEL_20K));
		};
		const control = requireControl(fixture.session);

		await submit(fixture.session, control, "host-first");
		await withTimeout(entered.promise, 5_000, "host first compaction summary");
		release.resolve();
		await control.waitForIdle();
		expect(host.calls.map((call) => call.status)).toEqual(["success"]);
		expect(summaryCalls).toBe(1);

		// 历史末端已是 compaction：策略仍要求压缩时只能得到 nothing-to-compact。
		host.setThresholdPct(0);
		await submit(fixture.session, control, "host-nothing");
		await waitForCondition(
			() => fixture.session.compactionPause?.reason === "nothing-to-compact",
			5_000,
			"host nothing-to-compact pause",
		);
		expect(summaryCalls).toBe(1);
		expect(host.calls.map((call) => call.status)).toEqual(["success", "nothing-to-compact"]);
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: true,
			items: [expect.objectContaining({ messageId: "host-nothing", state: "held" })],
		});
		expect(countUserText(fixture.session, "host-nothing")).toBe(0);

		host.setThresholdPct(80);
		await recoverAndResubmit(fixture.session, control, "host-nothing", "host-nothing", "host-nothing-resend");
		await control.waitForIdle();
		expect(summaryCalls).toBe(1);
		expect(fixture.session.compactionPause).toBeNull();
		expect(countUserText(fixture.session, "host-nothing")).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ autoDispatchPaused: false, items: [] });
	});

	it("[§6.5 host-context-changed] a model change during the summary holds the input and never commits the stale summary", async () => {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: compactionHistory,
			settings: COMPACTION_SETTINGS,
			noDefaultStream: true,
		});
		const host = installHostPolicy(fixture.session);
		const control = requireControl(fixture.session);
		const entered = gate(),
			release = gate();
		installSummaryStream(
			fixture.session,
			fixture.requests,
			{ entered, release },
			{
				onModelCall: () => textTurn("done", 100, MODEL_20K),
			},
		);
		const changed = { ...MODEL_20K, id: "message-control-compaction-test-alt" };

		await submit(fixture.session, control, "host-ctx");
		await withTimeout(entered.promise, 5_000, "host context change summary gate");
		await fixture.session.setModel(changed);
		release.resolve();
		await waitForCondition(
			() => fixture.session.compactionPause?.reason === "context-changed",
			5_000,
			"host context-changed pause",
		);
		expect(fixture.session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(
			false,
		);
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: true,
			items: [expect.objectContaining({ messageId: "host-ctx", state: "held" })],
		});
		expect(host.calls.map((call) => call.status)).toContain("context-changed");

		await fixture.session.setModel(MODEL_20K);
		await recoverAndResubmit(fixture.session, control, "host-ctx", "host-ctx", "host-ctx-resend");
		await control.waitForIdle();
		expect(fixture.session.compactionPause).toBeNull();
		expect(countUserText(fixture.session, "host-ctx")).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ autoDispatchPaused: false, items: [] });
	});

	it("[§6.5 host-pause-lease] host pause blocks the idle lease; after recover the lease writes a real custom entry and releases", async () => {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: compactionHistory,
			settings: COMPACTION_SETTINGS,
			noDefaultStream: true,
		});
		const host = installHostPolicy(fixture.session);
		const control = requireControl(fixture.session);
		const entered = gate(),
			release = gate();
		let summaryCalls = 0;
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			if (isSummaryRequest(context)) {
				summaryCalls++;
				if (summaryCalls === 1) throw new Error("summary boom");
				entered.resolve();
				await release.promise;
				return response(textTurn("## Summary\n- lease", 100, MODEL_20K));
			}
			return response(textTurn("done", 100, MODEL_20K));
		};

		await submit(fixture.session, control, "host-lease");
		await waitForCondition(
			() => host.calls.some((call) => call.status === "failed"),
			5_000,
			"host lease failure pause",
		);
		// 暂停时 SDK 的 idle lease 必须拒绝，避免维护写入与待恢复输入交错。
		expect(fixture.session.tryAcquireIdleLease()).toBeUndefined();

		await recoverAndResubmit(fixture.session, control, "host-lease", "host-lease", "host-lease-resend");
		await withTimeout(entered.promise, 5_000, "host lease recover summary gate");
		release.resolve();
		await control.waitForIdle();
		expect(fixture.session.compactionPause).toBeNull();

		const lease = fixture.session.tryAcquireIdleLease();
		expect(lease).toBeDefined();
		const entryId = lease?.appendCustomEntry("s3-host-lease", { reason: "after-recover" });
		expect(entryId).toBeTruthy();
		expect(JSON.stringify(fixture.session.sessionManager.getEntry(entryId ?? ""))).toContain("s3-host-lease");
		lease?.release();

		expect(await submit(fixture.session, control, "lease-after-hold")).toMatchObject({ ok: true });
		await control.waitForIdle();
		expect(countUserText(fixture.session, "lease-after-hold")).toBe(1);
		expect(countUserText(fixture.session, "host-lease")).toBe(1);
	});

	/**
	 * 组合补验 A：宿主摘要 gate 期间的 queue/steer 租约 + failed pause 保留 + resume 批次投递契约。
	 *
	 * 读源码后的实测结论（`_prepareHostPending` / `MessageControl.capacity`）：
	 * - gate 期间控制器的 queue/steer 记录经 `putPrepared` 进入 SDK 真实队列（`agent.getQueuedMessages`）；
	 * - 摘要失败时 `_prepareHostPending` 返回 `action:"end"`，初始输入被 retain 后被控制器 detach 成 held；
	 * - held 项继续占用同 source+mode 的用户槽，裸的新用户 queue 消息只会得到 `queue_full`；
	 * - 真正的 resume 入口是「槽位空闲的真实用户提交」（或带 `recovery` 的提交）：`_preparePrompt` 见到
	 *   `_hostPause` 会置 `_hostResumeBatch`，随后 `_prepareHostPending` 用 `orderPendingMessages` 把
	 *   队列租约与本次输入合成同一批投递（steer 先于 followUp，因为租约按入队次序排序）。
	 */
	it("[§6.5 host-queue-steer-resume] a failed host summary keeps the held input unsent while queue/steer leases resume once each", async () => {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: compactionHistory,
			settings: COMPACTION_SETTINGS,
			noDefaultStream: true,
		});
		const host = installHostPolicy(fixture.session);
		const control = requireControl(fixture.session);
		const summaryEntered = gate(),
			summaryFailed = gate(),
			resumeEntered = gate(),
			resumeRelease = gate();
		let summaryCalls = 0;
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			if (isSummaryRequest(context)) {
				summaryCalls++;
				if (summaryCalls === 1) {
					summaryEntered.resolve();
					await summaryFailed.promise;
					throw new Error("summary boom");
				}
				resumeEntered.resolve();
				await resumeRelease.promise;
				return response(textTurn("## Summary\n- resumed", 100, MODEL_20K));
			}
			return response(textTurn("done", 100, MODEL_20K));
		};
		const userStarts: string[] = [];
		const ends: Array<{ reason?: string; aborted?: boolean }> = [];
		fixture.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user")
				userStarts.push(messageText(event.message.content));
			if (event.type === "compaction_end") ends.push(event);
		});

		const original = await submit(fixture.session, control, "combo-initial");
		expect(original).toMatchObject({ ok: true, value: { disposition: "started" } });
		await withTimeout(summaryEntered.promise, 5_000, "combo initial summary gate");
		expect(control.getSnapshot()).toMatchObject({ phase: "compacting", compactionKind: "auto" });
		expect(countUserText(fixture.session, "combo-initial")).toBe(0);

		// 额外消息用 extension 来源：真实入队，但不占用 `capacity` 只管 source==="user" 的用户槽，
		// 这样后面才能用「真实新用户提交」触发 resume。
		for (const [id, mode] of [
			["combo-steer", "steer"],
			["combo-queue", "queue"],
		] as const) {
			expect(
				await control.submit(
					{ ...identity(fixture.session, control), requestId: id, mode, payload: { text: id } },
					"extension",
				),
			).toMatchObject({ ok: true, value: { disposition: "queued" } });
		}
		await waitForCondition(
			() => queuedTexts(fixture.session).length === 2,
			5_000,
			"combo extras leased into the real SDK queue",
		);
		expect(queuedTexts(fixture.session)).toEqual(["combo-steer", "combo-queue"]);
		expect(queuedTexts(fixture.session, "steer")).toEqual(["combo-steer"]);
		expect(queuedTexts(fixture.session, "followUp")).toEqual(["combo-queue"]);

		summaryFailed.resolve();
		await waitForCondition(
			() => fixture.session.compactionPause?.reason === "failed",
			5_000,
			"combo failed pause",
		);
		await control.waitForIdle();
		expect(host.calls.map((call) => call.status)).toEqual(["failed"]);
		expect(ends).toContainEqual(expect.objectContaining({ aborted: false }));
		// 失败的摘要不得写分支：初始输入既没提交，也没被摘要顶掉。
		expect(fixture.session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(
			false,
		);
		expect(userStarts).toEqual([]);
		expect(countUserText(fixture.session, "combo-initial")).toBe(0);
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: true,
			items: [
				expect.objectContaining({ messageId: "combo-initial", source: "user", state: "held" }),
				expect.objectContaining({ messageId: "combo-steer", state: "queued" }),
				expect.objectContaining({ messageId: "combo-queue", state: "queued" }),
			],
		});
		// 额外队列在 pause 后仍真实可见，初始 held 不在其中。
		expect(queuedTexts(fixture.session)).toEqual(["combo-steer", "combo-queue"]);

		// 裸的新用户 queue 消息会被 held 项占用的槽位拒绝：这是真实协议，不改成迎合的断言。
		expect(await submit(fixture.session, control, "combo-bare")).toMatchObject({
			ok: false,
			error: { code: "queue_full" },
		});
		expect(countUserText(fixture.session, "combo-initial")).toBe(0);

		// 空闲槽位的真实新用户 steer 提交触发 resume（`_hostPause` → `_hostResumeBatch`）。
		expect(await submit(fixture.session, control, "combo-new", "steer")).toMatchObject({
			ok: true,
			value: { disposition: "started" },
		});
		await withTimeout(resumeEntered.promise, 5_000, "combo resumed summary gate");
		expect(summaryCalls).toBe(2);
		expect(fixture.session.compactionPause).toBeNull();
		expect(queuedTexts(fixture.session)).toEqual(["combo-steer", "combo-queue"]);
		resumeRelease.resolve();
		await control.waitForIdle();

		expect(host.calls.map((call) => call.status)).toEqual(["failed", "success"]);
		// 批次次序 = 租约次序：queue/steer 先入队（steer 先于 followUp），新消息最后。
		expect(userStarts).toEqual(["combo-steer", "combo-queue", "combo-new"]);
		for (const text of ["combo-steer", "combo-queue", "combo-new"]) {
			expect(countUserText(fixture.session, text)).toBe(1);
		}
		// 初始 held 在 resume 之后仍未发送，仍由控制器持有。
		expect(countUserText(fixture.session, "combo-initial")).toBe(0);
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: false,
			items: [expect.objectContaining({ messageId: "combo-initial", state: "held" })],
		});
		expect(queuedTexts(fixture.session)).toEqual([]);
		// 模型上下文里三条用户消息同样按此序出现，且不含未发送的 held 文本。
		const resumedContext = JSON.stringify(fixture.requests.at(-1));
		expect(resumedContext.indexOf("combo-steer")).toBeLessThan(resumedContext.indexOf("combo-queue"));
		expect(resumedContext.indexOf("combo-queue")).toBeLessThan(resumedContext.indexOf("combo-new"));
		expect(resumedContext).not.toContain("combo-initial");

		// 显式 recover 旧 held 再发一次：全部队列清空，每条仍恰好一次。
		await recoverAndResubmit(
			fixture.session,
			control,
			"combo-initial",
			"combo-initial",
			"combo-initial-resend",
		);
		await control.waitForIdle();
		expect(userStarts).toEqual(["combo-steer", "combo-queue", "combo-new", "combo-initial"]);
		for (const text of ["combo-steer", "combo-queue", "combo-new", "combo-initial"]) {
			expect(countUserText(fixture.session, text)).toBe(1);
		}
		expect(queuedTexts(fixture.session)).toEqual([]);
		expect(control.getSnapshot()).toMatchObject({ autoDispatchPaused: false, items: [] });
	});

	/**
	 * §11.3 窄例外：同一场景下两条额外消息来自用户（source 默认 "user"）。
	 *
	 * `capacity` 对 source==="user" 的未提交记录一律视为占用，所以裸的新用户消息仍得到 `queue_full`；
	 * 但已持有的初始实体走显式 recovery 时只复用自己原来的槽位（§11.3 唯一例外），不 discard 占槽项，
	 * 也不会增加同 mode 用户实体数。目标 + 同批次 queued 传输项各 commit 恰好一次。
	 */
	it("[§6.5 host-pause-user-slot] user-sourced queue/steer items block new user submits while the held entity resumes without discarding the occupying slot", async () => {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: compactionHistory,
			settings: COMPACTION_SETTINGS,
			noDefaultStream: true,
		});
		const host = installHostPolicy(fixture.session);
		const control = requireControl(fixture.session);
		const summaryEntered = gate(),
			summaryFailed = gate();
		let summaryCalls = 0;
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			if (isSummaryRequest(context)) {
				summaryCalls++;
				if (summaryCalls === 1) {
					summaryEntered.resolve();
					await summaryFailed.promise;
					throw new Error("summary boom");
				}
				return response(textTurn("## Summary\n- user slot", 100, MODEL_20K));
			}
			return response(textTurn("done", 100, MODEL_20K));
		};

		await submit(fixture.session, control, "slot-initial");
		await withTimeout(summaryEntered.promise, 5_000, "slot initial summary gate");
		expect(await submit(fixture.session, control, "slot-steer", "steer")).toMatchObject({
			ok: true,
			value: { disposition: "queued" },
		});
		expect(await submit(fixture.session, control, "slot-queue", "queue")).toMatchObject({
			ok: true,
			value: { disposition: "queued" },
		});
		await waitForCondition(
			() => queuedTexts(fixture.session).length === 2,
			5_000,
			"slot extras leased into the real SDK queue",
		);
		expect(queuedTexts(fixture.session, "steer")).toEqual(["slot-steer"]);
		expect(queuedTexts(fixture.session, "followUp")).toEqual(["slot-queue"]);

		summaryFailed.resolve();
		await waitForCondition(
			() => fixture.session.compactionPause?.reason === "failed",
			5_000,
			"slot failed pause",
		);
		await control.waitForIdle();
		expect(host.calls.map((call) => call.status)).toEqual(["failed"]);
		expect(countUserText(fixture.session, "slot-initial")).toBe(0);
		expect(control.getSnapshot().items).toEqual([
			expect.objectContaining({ messageId: "slot-initial", state: "held" }),
			expect.objectContaining({ messageId: "slot-steer", state: "queued" }),
			expect.objectContaining({ messageId: "slot-queue", state: "queued" }),
		]);
		expect(queuedTexts(fixture.session)).toEqual(["slot-steer", "slot-queue"]);

		// 裸的新用户 queue 消息：仍被 held 的 queue 槽拒绝（新输入容量规则不变）。
		expect(await submit(fixture.session, control, "slot-bare")).toMatchObject({
			ok: false,
			error: { code: "queue_full" },
		});
		// 同 mode 的显式 recovery：复用原槽位直接执行，不需要 discard 占槽项。
		const recovered = control.recover({
			...identity(fixture.session, control),
			requestId: "slot-initial-recover",
			messageId: "slot-initial",
			expectedRevision: control.getSnapshot().revision,
		});
		if (!recovered.ok) throw new Error(`recover slot-initial failed: ${recovered.error.message}`);
		expect(queuedTexts(fixture.session)).toEqual(["slot-steer", "slot-queue"]);
		const resumed = await control.submit({
			...identity(fixture.session, control),
			requestId: "slot-initial-resend",
			mode: "queue",
			payload: recovered.value.payload,
			recovery: { messageId: "slot-initial", expectedRevision: control.getSnapshot().revision },
		});
		expect(resumed).toMatchObject({
			ok: true,
			value: { messageId: "slot-initial", disposition: "started" },
		});
		await control.waitForIdle();
		expect(summaryCalls).toBe(2);
		expect(host.calls.map((call) => call.status)).toEqual(["failed", "success"]);
		expect(fixture.session.compactionPause).toBeNull();
		// 三条用户实体各恰好一次：占槽的 steer/queue 仍在同一个 resume 批次里按既有顺序消费。
		expect(countUserText(fixture.session, "slot-steer")).toBe(1);
		expect(countUserText(fixture.session, "slot-initial")).toBe(1);
		expect(countUserText(fixture.session, "slot-queue")).toBe(1);
		expect(queuedTexts(fixture.session)).toEqual([]);
		expect(control.getSnapshot()).toMatchObject({ autoDispatchPaused: false, items: [] });
	});

	/**
	 * 组合补验（resend）：复用 `host-pause-user-slot` 的真实设施——初始用户输入触发宿主摘要，
	 * 摘要失败后 held；额外 user steer/queue 两条已 prepared 并仍在真实 SDK 传输队列中。
	 * 只把 resend 目标作为变量，其余观察点一致：host result、compactionPause、每条 commit、held 身份。
	 * 不 discard、不放宽 capacity、不另起 submit 绕路。
	 */
	async function pausedUserSlotCase(
		prefix: string,
		options: { payload?: MessagePayload; extensions?: ExtensionFactory[]; failSummaries?: number } = {},
	) {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: compactionHistory,
			settings: options.payload ? IMAGE_SETTINGS : COMPACTION_SETTINGS,
			noDefaultStream: true,
			...(options.extensions ? { extensions: options.extensions } : {}),
		});
		const host = installHostPolicy(fixture.session);
		const control = requireControl(fixture.session);
		const summaryEntered = gate(),
			summaryFailed = gate();
		const failSummaries = options.failSummaries ?? 1;
		let summaryCalls = 0;
		const userStarts: string[] = [];
		fixture.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user")
				userStarts.push(messageText(event.message.content));
		});
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			if (isSummaryRequest(context)) {
				summaryCalls++;
				if (summaryCalls <= failSummaries) {
					if (summaryCalls === 1) {
						summaryEntered.resolve();
						await summaryFailed.promise;
					}
					throw new Error(`summary boom ${summaryCalls}`);
				}
				return response(textTurn("## Summary\n- user slot", 100, MODEL_20K));
			}
			return response(textTurn("done", 100, MODEL_20K));
		};
		const ids = {
			initial: `${prefix}-initial`,
			steer: `${prefix}-steer`,
			queue: `${prefix}-queue`,
		};
		await submit(fixture.session, control, ids.initial, "queue", options.payload ?? { text: ids.initial });
		await withTimeout(summaryEntered.promise, 5_000, `${prefix} initial summary gate`);
		expect(await submit(fixture.session, control, ids.steer, "steer")).toMatchObject({
			ok: true,
			value: { disposition: "queued" },
		});
		expect(await submit(fixture.session, control, ids.queue, "queue")).toMatchObject({
			ok: true,
			value: { disposition: "queued" },
		});
		await waitForCondition(
			() => queuedTexts(fixture.session).length === 2,
			5_000,
			`${prefix} extras leased into the real SDK queue`,
		);
		summaryFailed.resolve();
		await waitForCondition(
			() => fixture.session.compactionPause?.reason === "failed",
			5_000,
			`${prefix} failed pause`,
		);
		await control.waitForIdle();
		// 冻结现场：初始 held 未 commit，额外两项已 prepared 且在真实 transport 中。
		expect(host.calls.map((call) => call.status)).toEqual(["failed"]);
		expect(control.getSnapshot().items).toEqual([
			expect.objectContaining({ messageId: ids.initial, state: "held" }),
			expect.objectContaining({ messageId: ids.steer, state: "queued" }),
			expect.objectContaining({ messageId: ids.queue, state: "queued" }),
		]);
		expect(queuedTexts(fixture.session)).toEqual([ids.steer, ids.queue]);
		for (const id of [ids.initial, ids.steer, ids.queue]) {
			expect(countUserText(fixture.session, id)).toBe(0);
		}
		return { fixture, host, control, ids, userStarts, summaryCalls: () => summaryCalls };
	}

	it("[§6.5 host-pause-resend-initial] resend of the held unprepared initial recovers every sendable item exactly once", async () => {
		const { fixture, host, control, ids, userStarts } = await pausedUserSlotCase("resend-a");
		const resend = await control.changePending({
			...identity(fixture.session, control),
			requestId: "resend-a-change",
			messageId: ids.initial,
			expectedRevision: control.getSnapshot().revision,
			action: "resend",
		});
		expect(resend.ok, resend.ok ? "resend accepted" : `resend rejected: ${resend.error.code}`).toBe(true);
		await control.waitForIdle();
		// 期望闭环（A 未 prepared：launch 走 `_promptUncontrolled` → `_hostResumeBatch`）：
		// 第二次摘要成功、pause 清空、初始与两条额外各 commit 恰好一次、items 清空。
		expect(host.calls.map((call) => call.status)).toEqual(["failed", "success"]);
		expect(fixture.session.compactionPause).toBeNull();
		expect([...userStarts].sort()).toEqual([ids.initial, ids.steer, ids.queue].sort());
		for (const id of [ids.initial, ids.steer, ids.queue]) {
			expect(countUserText(fixture.session, id)).toBe(1);
		}
		expect(queuedTexts(fixture.session)).toEqual([]);
		expect(control.getSnapshot()).toMatchObject({ autoDispatchPaused: false, items: [] });
	});

	it("[§6.5 host-pause-resend-prepared] resend of the prepared queue target resumes only that transport batch and keeps the other held entity", async () => {
		const { fixture, host, control, ids, userStarts } = await pausedUserSlotCase("resend-b");
		const resend = await control.changePending({
			...identity(fixture.session, control),
			requestId: "resend-b-change",
			messageId: ids.queue,
			expectedRevision: control.getSnapshot().revision,
			action: "resend",
		});
		expect(resend.ok, resend.ok ? "resend accepted" : `resend rejected: ${resend.error.code}`).toBe(true);
		await control.waitForIdle();
		// 期望闭环（B 已 prepared：launch 走 `_startRunPrepared` + 控制器级显式恢复授权）：
		// 第二次摘要成功、pause 清空；目标与同批次 queued 传输项各 commit 恰好一次；
		// 另一个 held（未 prepared 的初始项）不被自动解冻，仍由控制器持有（§11.4.6）。
		expect(host.calls.map((call) => call.status)).toEqual(["failed", "success"]);
		expect(fixture.session.compactionPause).toBeNull();
		expect([...userStarts].sort()).toEqual([ids.steer, ids.queue].sort());
		expect(countUserText(fixture.session, ids.steer)).toBe(1);
		expect(countUserText(fixture.session, ids.queue)).toBe(1);
		expect(countUserText(fixture.session, ids.initial)).toBe(0);
		expect(queuedTexts(fixture.session)).toEqual([]);
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: false,
			items: [expect.objectContaining({ messageId: ids.initial, state: "held" })],
		});

		// 队列最终可收束：剩下的 held 需要一次新的显式 recover，且此时已无占槽项。
		await recoverAndResubmit(fixture.session, control, ids.initial, ids.initial, "resend-b-initial-after");
		await control.waitForIdle();
		expect([...userStarts].sort()).toEqual([ids.initial, ids.steer, ids.queue].sort());
		for (const id of [ids.initial, ids.steer, ids.queue]) {
			expect(countUserText(fixture.session, id)).toBe(1);
		}
		expect(control.getSnapshot()).toMatchObject({ autoDispatchPaused: false, items: [] });
	});

	/**
	 * §11.6 显式无损恢复（S3）行为矩阵。
	 * 均复用真实宿主策略 + 真实 AgentSession + 内存模型流，不 mock 控制器/运行/队列。
	 */

	it("[§11.6 resume-slot-payload] a same-mode recovery of the held initial keeps text/image/draft and delivers once without discarding the occupying slot", async () => {
		const payload: MessagePayload = {
			text: "resume-slot 草稿 text",
			images: [{ data: PNG_1X1, mimeType: "image/png" }],
			draft: {
				text: "resume-slot 草稿 text",
				attachments: ["file:resume.md"],
				quotes: ["quote:11"],
				slashCommand: null,
				imageNames: ["resume.png"],
			},
		};
		const { fixture, host, control, ids } = await pausedUserSlotCase("resume-slot", { payload });
		const recovered = control.recover({
			...identity(fixture.session, control),
			requestId: "resume-slot-recover",
			messageId: ids.initial,
			expectedRevision: control.getSnapshot().revision,
		});
		if (!recovered.ok) throw new Error(`recover failed: ${recovered.error.message}`);
		// 原实体 ID 与完整载荷原样回来（图片 + 草稿，不是回退成 {text:""}）。
		expect(recovered.value.messageId).toBe(ids.initial);
		expect(recovered.value.payload).toEqual(payload);
		const resend = await control.submit({
			...identity(fixture.session, control),
			requestId: "resume-slot-resend",
			mode: "queue",
			payload: recovered.value.payload,
			recovery: { messageId: ids.initial, expectedRevision: control.getSnapshot().revision },
		});
		expect(resend).toMatchObject({
			ok: true,
			value: { messageId: ids.initial, disposition: "started" },
		});
		await control.waitForIdle();
		expect(host.calls.map((call) => call.status)).toEqual(["failed", "success"]);
		expect(fixture.session.compactionPause).toBeNull();
		// 恢复目标 + 同批次两条传输项各一次；ID 仍为原实体。
		expect(countUserText(fixture.session, payload.text)).toBe(1);
		expect(countUserImages(fixture.session, PNG_1X1)).toBe(1);
		expect(countUserText(fixture.session, ids.steer)).toBe(1);
		expect(countUserText(fixture.session, ids.queue)).toBe(1);
		expect(queuedTexts(fixture.session)).toEqual([]);
		expect(control.getSnapshot()).toMatchObject({ autoDispatchPaused: false, items: [] });
		// 草稿/附件名不进入模型内容。
		const context = JSON.stringify(fixture.requests.at(-1));
		expect(context).not.toContain("file:resume.md");
		expect(context).not.toContain("quote:11");
	});

	/**
	 * §11.6 跨模式恢复只走普通 capacity 的最小现场：只有一条 held 的 queue 实体，目标 mode 槽位为空。
	 * 不再使用「cross 一律 queue_full」的硬拒绝；空槽按原规则运行，占槽仍由 capacity 拒绝。
	 */
	async function pausedSingleHeldCase(prefix: string) {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: compactionHistory,
			settings: COMPACTION_SETTINGS,
			noDefaultStream: true,
		});
		const host = installHostPolicy(fixture.session);
		const control = requireControl(fixture.session);
		const summaryEntered = gate(),
			summaryFailed = gate();
		let summaryCalls = 0;
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			if (isSummaryRequest(context)) {
				summaryCalls++;
				if (summaryCalls === 1) {
					summaryEntered.resolve();
					await summaryFailed.promise;
					throw new Error("summary boom");
				}
				return response(textTurn("## Summary\n- single held", 100, MODEL_20K));
			}
			return response(textTurn("done", 100, MODEL_20K));
		};
		const id = `${prefix}-initial`;
		await submit(fixture.session, control, id, "queue");
		await withTimeout(summaryEntered.promise, 5_000, `${prefix} initial summary gate`);
		summaryFailed.resolve();
		await waitForCondition(
			() => fixture.session.compactionPause?.reason === "failed",
			5_000,
			`${prefix} failed pause`,
		);
		await control.waitForIdle();
		expect(host.calls.map((call) => call.status)).toEqual(["failed"]);
		expect(control.getSnapshot().items).toEqual([
			expect.objectContaining({ messageId: id, source: "user", mode: "queue", state: "held" }),
		]);
		expect(countUserText(fixture.session, id)).toBe(0);
		return { fixture, host, control, id };
	}

	it("[§11.6 resume-cross-empty-steer] a cross-mode recovery into an empty steer slot runs once under the ordinary capacity rule", async () => {
		const { fixture, host, control, id } = await pausedSingleHeldCase("resume-cross-steer");
		const identity0 = identity(fixture.session, control);
		const recovered = control.recover({
			...identity0,
			requestId: "resume-cross-steer-recover",
			messageId: id,
			expectedRevision: control.getSnapshot().revision,
		});
		if (!recovered.ok) throw new Error(`recover failed: ${recovered.error.message}`);
		const cross = await control.submit({
			...identity0,
			requestId: "resume-cross-steer-move",
			mode: "steer",
			payload: recovered.value.payload,
			recovery: { messageId: id, expectedRevision: control.getSnapshot().revision },
		});
		expect(cross, cross.ok ? "cross-mode started" : `cross-mode rejected: ${cross.error.code}`).toMatchObject(
			{
				ok: true,
				value: { messageId: id, disposition: "started" },
			},
		);
		await control.waitForIdle();
		expect(host.calls.map((call) => call.status)).toEqual(["failed", "success"]);
		expect(fixture.session.compactionPause).toBeNull();
		expect(countUserText(fixture.session, id)).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ autoDispatchPaused: false, items: [] });
	});

	it("[§11.6 resume-cross-empty-interrupt] a cross-mode recovery into an empty interrupt slot also runs once", async () => {
		const { fixture, host, control, id } = await pausedSingleHeldCase("resume-cross-interrupt");
		const identity0 = identity(fixture.session, control);
		const recovered = control.recover({
			...identity0,
			requestId: "resume-cross-interrupt-recover",
			messageId: id,
			expectedRevision: control.getSnapshot().revision,
		});
		if (!recovered.ok) throw new Error(`recover failed: ${recovered.error.message}`);
		const cross = await control.submit({
			...identity0,
			requestId: "resume-cross-interrupt-move",
			mode: "interrupt",
			payload: recovered.value.payload,
			recovery: { messageId: id, expectedRevision: control.getSnapshot().revision },
		});
		expect(cross, cross.ok ? "cross-mode started" : `cross-mode rejected: ${cross.error.code}`).toMatchObject(
			{
				ok: true,
				value: { messageId: id, disposition: "started" },
			},
		);
		await control.waitForIdle();
		expect(host.calls.map((call) => call.status)).toEqual(["failed", "success"]);
		expect(fixture.session.compactionPause).toBeNull();
		expect(countUserText(fixture.session, id)).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ autoDispatchPaused: false, items: [] });
	});

	it("[§11.6 resume-cross-mode] a cross-mode recovery with an occupied target slot stays queue_full and leaves the held entity untouched", async () => {
		const { fixture, control, ids } = await pausedUserSlotCase("resume-cross");
		const identity0 = identity(fixture.session, control);
		const revision0 = control.getSnapshot().revision;
		const blocked = await control.submit({
			...identity0,
			requestId: "resume-cross-move",
			mode: "steer",
			payload: { text: ids.initial },
			recovery: { messageId: ids.initial, expectedRevision: revision0 },
		});
		expect(blocked).toMatchObject({ ok: false, error: { code: "queue_full" } });
		// 原实体模式/状态/来源/排队项与 revision 都不变。
		expect(control.getSnapshot().revision).toBe(revision0);
		expect(control.getSnapshot().items).toEqual([
			expect.objectContaining({ messageId: ids.initial, source: "user", mode: "queue", state: "held" }),
			expect.objectContaining({ messageId: ids.steer, source: "user", mode: "steer", state: "queued" }),
			expect.objectContaining({ messageId: ids.queue, mode: "queue", state: "queued" }),
		]);
		expect(queuedTexts(fixture.session)).toEqual([ids.steer, ids.queue]);
		expect(countUserText(fixture.session, ids.initial)).toBe(0);

		// 同模式新的 recovery 不被上一次跨模式拒绝拖住，且占槽项仍按既有顺序消费。
		const same = await control.submit({
			...identity0,
			requestId: "resume-cross-same",
			mode: "queue",
			payload: { text: ids.initial },
			recovery: { messageId: ids.initial, expectedRevision: control.getSnapshot().revision },
		});
		expect(same).toMatchObject({ ok: true, value: { messageId: ids.initial } });
		await control.waitForIdle();
		for (const id of [ids.initial, ids.steer, ids.queue]) expect(countUserText(fixture.session, id)).toBe(1);
	});

	it("[§11.6 resume-new-input] an ordinary new user submit stays busy during the reservation and works once the target commits", async () => {
		const prepareEntered = gate();
		const prepareRelease = gate();
		// 只拦住测试亲自触发的恢复准备；fixture 自身的首次运行不受影响。
		const arm = { on: false };
		const extension: ExtensionFactory = (pi) => {
			pi.on("before_agent_start", async () => {
				if (!arm.on) return;
				prepareEntered.resolve();
				await prepareRelease.promise;
			});
		};
		const { fixture, control, ids } = await pausedUserSlotCase("resume-new", { extensions: [extension] });
		const identity0 = identity(fixture.session, control);
		arm.on = true;
		const resend = control.changePending({
			...identity0,
			requestId: "resume-new-change",
			messageId: ids.initial,
			expectedRevision: control.getSnapshot().revision,
			action: "resend",
		});
		await withTimeout(prepareEntered.promise, 5_000, "reservation preparation gate");
		// 目标预留期间：新用户请求不获得额外孔位。
		expect(await submit(fixture.session, control, "resume-new-bare")).toMatchObject({
			ok: false,
			error: { code: "busy" },
		});
		// 预留期间其他实体的模式操作同样被拒，占槽项状态不被改动。
		expect(
			await control.changePending({
				...identity0,
				requestId: "resume-new-other-change",
				messageId: ids.queue,
				expectedRevision: control.getSnapshot().revision,
				action: "steer",
			}),
		).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(
			await control.recover({
				...identity0,
				requestId: "resume-new-other-recover",
				messageId: ids.queue,
				expectedRevision: control.getSnapshot().revision,
			}),
		).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await resend).toMatchObject({ ok: true });
		prepareRelease.resolve();
		await control.waitForIdle();
		expect(countUserText(fixture.session, "resume-new-bare")).toBe(0);
		for (const id of [ids.initial, ids.steer, ids.queue]) expect(countUserText(fixture.session, id)).toBe(1);
		// 成功后新的普通输入可以正常执行。
		expect(await submit(fixture.session, control, "resume-new-after")).toMatchObject({
			ok: true,
			value: { disposition: "started" },
		});
		await control.waitForIdle();
		expect(countUserText(fixture.session, "resume-new-after")).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ autoDispatchPaused: false, items: [] });
	});

	it("[§11.6 resume-source-spoof] a recovery from another source is rejected without rewriting the held entity", async () => {
		const { fixture, control, ids } = await pausedUserSlotCase("resume-spoof");
		const identity0 = identity(fixture.session, control);
		const before = control.getSnapshot();
		const spoof = await control.submit(
			{
				...identity0,
				requestId: "resume-spoof-resend",
				mode: "queue",
				payload: { text: ids.initial },
				recovery: { messageId: ids.initial, expectedRevision: before.revision },
			},
			"extension",
		);
		// 来源不同的 recovery 不是「零新增」例外：直接拒绝，避免 records 替换释放原 user 槽位。
		expect(spoof).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
		const after = control.getSnapshot();
		expect(after.revision).toBe(before.revision);
		expect(after.items).toEqual(before.items);
		expect(after.items[0]).toMatchObject({
			messageId: ids.initial,
			source: "user",
			mode: "queue",
			state: "held",
		});
		await control.waitForIdle();
		expect(countUserText(fixture.session, ids.initial)).toBe(0);
		expect(queuedTexts(fixture.session)).toEqual([ids.steer, ids.queue]);

		// 同来源的合法 recovery 不受影响：拒绝没有动载荷、记录或 transport。
		const recovered = control.recover({
			...identity0,
			requestId: "resume-spoof-recover",
			messageId: ids.initial,
			expectedRevision: control.getSnapshot().revision,
		});
		if (!recovered.ok) throw new Error(`recover failed: ${recovered.error.message}`);
		const resend = await control.submit({
			...identity0,
			requestId: "resume-spoof-user-resend",
			mode: "queue",
			payload: recovered.value.payload,
			recovery: { messageId: ids.initial, expectedRevision: control.getSnapshot().revision },
		});
		expect(resend).toMatchObject({ ok: true, value: { messageId: ids.initial } });
		await control.waitForIdle();
		expect(countUserText(fixture.session, ids.initial)).toBe(1);
		expect(countUserText(fixture.session, ids.steer)).toBe(1);
		expect(countUserText(fixture.session, ids.queue)).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ autoDispatchPaused: false, items: [] });
	});

	/**
	 * §11.6 来源边界（extension → user 编辑交互）：
	 *
	 * 宿主暂停期间由真实扩展入口（`pi.sendUserMessage` → 控制器 `submit(source="extension")`）投递的实体被
	 * 控制器扣住（本地调度暂停，未进 transport）；UI 的 recover + 后端 `submit(source="user")` 不得被
	 * `invalid_payload` 卡在 recovering。
	 * 恢复永久保留原 `source="extension"`：不占用/释放任何 user 槽，不获 §11.3 的同模式容量例外，
	 * 也不产生新身份；宿主恢复只由这一次显式编辑交互走普通交互入口触发一次。
	 */
	it("[§11.6 resume-source-extension-edit] a user edit recovery of a host-paused extension item keeps source extension and resumes once without releasing a user slot", async () => {
		let extApi: ExtensionAPI | undefined;
		const extension: ExtensionFactory = (pi) => {
			extApi = pi;
		};
		const { fixture, host, control, ids } = await pausedUserSlotCase("resume-ext", {
			extensions: [extension],
		});
		if (!extApi) throw new Error("inline extension API was not bound");
		const identity0 = identity(fixture.session, control);
		// 真实扩展入口：暂停期间发送一条 user 文本，控制器按 extension 来源持有（未 prepared、未进 transport）。
		const extText = "resume-ext 扩展原始正文";
		extApi.sendUserMessage(extText);
		await waitForCondition(
			() => control.getSnapshot().items.some((item) => item.source === "extension"),
			5_000,
			"extension item registered in the controller",
		);
		const extItem = control.getSnapshot().items.find((item) => item.source === "extension");
		if (!extItem) throw new Error("extension item missing from the snapshot");
		const extId = extItem.messageId;
		expect(extItem).toMatchObject({ source: "extension", mode: "queue" });
		expect(queuedTexts(fixture.session)).toEqual([ids.steer, ids.queue]);
		expect(countUserText(fixture.session, extText)).toBe(0);

		// 记录恢复期间的每一条来源：目标不得被改写成 user，也不得出现第二个身份。
		const seenSources: string[] = [];
		const unsubscribe = control.subscribe((update) => {
			for (const item of update.snapshot.items) if (item.messageId === extId) seenSources.push(item.source);
		});
		const recovered = control.recover({
			...identity0,
			requestId: "resume-ext-recover",
			messageId: extId,
			expectedRevision: control.getSnapshot().revision,
		});
		if (!recovered.ok) throw new Error(`recover failed: ${recovered.error.message}`);
		expect(recovered.value).toMatchObject({ messageId: extId, payload: { text: extText } });
		// 后端适配器的真实入口：source 默认 user（编辑交互），不是 extension 自报。
		const edited = "resume-ext 编辑后的正文";
		const resumed = await control.submit({
			...identity0,
			requestId: "resume-ext-resend",
			mode: "queue",
			payload: { text: edited },
			recovery: { messageId: extId, expectedRevision: control.getSnapshot().revision },
		});
		expect(
			resumed,
			resumed.ok ? "recovery accepted" : `recovery rejected: ${resumed.error.code}`,
		).toMatchObject({
			ok: true,
			value: { messageId: extId, disposition: "started" },
		});
		await control.waitForIdle();
		unsubscribe();

		// 宿主恢复只发生一次：第二次摘要成功、pause 清空。
		expect(host.calls.map((call) => call.status)).toEqual(["failed", "success"]);
		expect(fixture.session.compactionPause).toBeNull();
		// 来源仍是 extension：快照里从未出现同 ID 的 user 实体，编辑后的正文恰好投递一次。
		expect(seenSources.length).toBeGreaterThan(0);
		expect([...new Set(seenSources)]).toEqual(["extension"]);
		expect(countUserText(fixture.session, edited)).toBe(1);
		expect(countUserText(fixture.session, extText)).toBe(0);
		// 其他 user 槽不因这次扩展编辑恢复而释放：初始 held 仍未发送，两条 queued 照常各一次。
		expect(countUserText(fixture.session, ids.initial)).toBe(0);
		expect(countUserText(fixture.session, ids.steer)).toBe(1);
		expect(countUserText(fixture.session, ids.queue)).toBe(1);
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: false,
			items: [expect.objectContaining({ messageId: ids.initial, source: "user", state: "held" })],
		});

		// 反方向仍是伪造：原 user 实体的恢复不接受其他来源，也不释放它的槽位。
		const heldBefore = control.getSnapshot();
		const userRecover = control.recover({
			...identity0,
			requestId: "resume-ext-user-recover",
			messageId: ids.initial,
			expectedRevision: heldBefore.revision,
		});
		if (!userRecover.ok) throw new Error(`recover failed: ${userRecover.error.message}`);
		const before = control.getSnapshot();
		const spoof = await control.submit(
			{
				...identity0,
				requestId: "resume-ext-user-spoof",
				mode: "queue",
				payload: userRecover.value.payload,
				recovery: { messageId: ids.initial, expectedRevision: before.revision },
			},
			"extension",
		);
		expect(spoof).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
		const after = control.getSnapshot();
		expect(after.revision).toBe(before.revision);
		expect(after.items).toEqual(before.items);
		expect(after.items).toEqual([
			expect.objectContaining({ messageId: ids.initial, source: "user", state: "recovering" }),
		]);
		await control.waitForIdle();
		expect(countUserText(fixture.session, ids.initial)).toBe(0);
	});

	it("[§11.6 resume-reentrancy] publish re-entry, a second request id and id reuse never start or rewrite the target twice", async () => {
		const { fixture, control, ids, userStarts } = await pausedUserSlotCase("resume-re");
		const identity0 = identity(fixture.session, control);
		let armed = false;
		let reentrantSubmit: Promise<unknown> | undefined;
		let reentrantChange: Promise<unknown> | undefined;
		const unsubscribe = control.subscribe(() => {
			if (!armed) return;
			armed = false;
			reentrantSubmit = control.submit({
				...identity0,
				requestId: "resume-re-bare",
				mode: "queue",
				payload: { text: "resume-re-bare" },
			});
			reentrantChange = control.changePending({
				...identity0,
				requestId: "resume-re-reentry",
				messageId: ids.initial,
				expectedRevision: control.getSnapshot().revision,
				action: "resend",
			});
		});
		const request = {
			...identity0,
			requestId: "resume-re-change",
			messageId: ids.initial,
			expectedRevision: control.getSnapshot().revision,
			action: "resend" as const,
		};
		armed = true;
		const resend = control.changePending(request);
		// 第二个不同 requestId 在目标准备期间只能得到 busy。
		// 旧 revision 先被拒（revision 先验），拿到新 revision 的双击只能得到 busy。
		expect(await control.changePending({ ...request, requestId: "resume-re-change-stale" })).toMatchObject({
			ok: false,
			error: { code: "stale_revision" },
		});
		expect(
			await control.changePending({
				...request,
				requestId: "resume-re-change-2",
				expectedRevision: control.getSnapshot().revision,
			}),
		).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await resend).toMatchObject({
			ok: true,
			value: { ack: { messageId: ids.initial, disposition: "started" } },
		});
		await waitForCondition(
			() => reentrantSubmit !== undefined && reentrantChange !== undefined,
			5_000,
			"re-entrant listener ran",
		);
		expect(await reentrantSubmit).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await reentrantChange).toMatchObject({ ok: false, error: { code: "busy" } });
		// 同 requestId 重放：返回第一次记住的稳定结果，不再启动。
		const replay = await control.changePending(request);
		expect(replay).toEqual(await resend);
		// 同 requestId 改动作/改 revision = 冲突，不得当成新恢复放行。
		expect(await control.changePending({ ...request, action: "steer" })).toMatchObject({
			ok: false,
			error: { code: "request_id_conflict" },
		});
		expect(
			await control.changePending({ ...request, expectedRevision: request.expectedRevision - 1 }),
		).toMatchObject({ ok: false, error: { code: "request_id_conflict" } });
		// 旧 revision / 别的 runtime 不进入恢复。
		expect(
			await control.changePending({
				...identity0,
				requestId: "resume-re-stale",
				messageId: ids.initial,
				expectedRevision: request.expectedRevision - 1,
				action: "resend",
			}),
		).toMatchObject({ ok: false, error: { code: "stale_revision" } });
		expect(
			await control.changePending({
				sessionId: fixture.session.sessionId,
				runtimeId: "resume-re-other-runtime",
				requestId: "resume-re-runtime",
				messageId: ids.initial,
				expectedRevision: control.getSnapshot().revision,
				action: "resend",
			}),
		).toMatchObject({ ok: false, error: { code: "stale_runtime" } });
		unsubscribe();
		await control.waitForIdle();
		expect(userStarts.filter((entry) => entry === ids.initial)).toHaveLength(1);
		expect(userStarts.filter((entry) => entry === "resume-re-bare")).toHaveLength(0);
		for (const id of [ids.initial, ids.steer, ids.queue]) expect(countUserText(fixture.session, id)).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ autoDispatchPaused: false, items: [] });
	});

	it("[§11.6 resume-prepare-stop] a stop during recovery preparation revokes the intention and keeps the entity held", async () => {
		const prepareEntered = gate();
		const prepareRelease = gate();
		// 只拦住测试亲自触发的恢复准备；fixture 自身的首次运行不受影响。
		const arm = { on: false };
		const extension: ExtensionFactory = (pi) => {
			pi.on("before_agent_start", async () => {
				if (!arm.on) return;
				prepareEntered.resolve();
				await prepareRelease.promise;
			});
		};
		const { fixture, host, control, ids } = await pausedUserSlotCase("resume-stop", {
			extensions: [extension],
		});
		const identity0 = identity(fixture.session, control);
		arm.on = true;
		const resend = control.changePending({
			...identity0,
			requestId: "resume-stop-change",
			messageId: ids.initial,
			expectedRevision: control.getSnapshot().revision,
			action: "resend",
		});
		await withTimeout(prepareEntered.promise, 5_000, "recovery preparation gate");
		expect(control.stop({ ...identity0, requestId: "resume-stop-stop" })).toMatchObject({ ok: true });
		prepareRelease.resolve();
		expect(await resend).toMatchObject({ ok: true });
		await control.waitForIdle();
		// 没有 commit、没有第二次摘要。stop 的既有语义会把所有用户实体收成 held 并离开 transport，
		// 这里断言的是「载荷不丢、意图不复活、不自动发送」。
		expect(countUserText(fixture.session, ids.initial)).toBe(0);
		expect(host.calls.map((call) => call.status)).toEqual(["failed"]);
		expect(fixture.session.compactionPause?.reason).toBe("failed");
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: true,
			items: [
				expect.objectContaining({ messageId: ids.initial, state: "held" }),
				expect.objectContaining({ messageId: ids.steer, state: "held" }),
				expect.objectContaining({ messageId: ids.queue, state: "held" }),
			],
		});
		expect(queuedTexts(fixture.session)).toEqual([]);
		// 迟到事件不复活意图：静止后仍未发送任何东西。
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(countUserText(fixture.session, ids.initial)).toBe(0);
		// 新的显式恢复才能继续；其余 held 保持不动。
		await recoverAndResubmit(fixture.session, control, ids.initial, ids.initial, "resume-stop-resend");
		await control.waitForIdle();
		expect(host.calls.map((call) => call.status)).toEqual(["failed", "success"]);
		expect(countUserText(fixture.session, ids.initial)).toBe(1);
		expect(countUserText(fixture.session, ids.steer)).toBe(0);
		expect(countUserText(fixture.session, ids.queue)).toBe(0);
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: false,
			items: [
				expect.objectContaining({ messageId: ids.steer, state: "held" }),
				expect.objectContaining({ messageId: ids.queue, state: "held" }),
			],
		});
		// 队列最终可收束：两项各自显式恢复（保持原 mode）后各投递一次。
		for (const [messageId, mode] of [
			[ids.queue, "queue"],
			[ids.steer, "steer"],
		] as const) {
			const recovered = control.recover({
				...identity0,
				requestId: `${messageId}-recover`,
				messageId,
				expectedRevision: control.getSnapshot().revision,
			});
			if (!recovered.ok) throw new Error(`recover ${messageId} failed: ${recovered.error.message}`);
			expect(
				await control.submit({
					...identity0,
					requestId: `${messageId}-resend`,
					mode,
					payload: recovered.value.payload,
					recovery: { messageId, expectedRevision: control.getSnapshot().revision },
				}),
			).toMatchObject({ ok: true, value: { messageId } });
			await control.waitForIdle();
		}
		for (const id of [ids.initial, ids.steer, ids.queue]) expect(countUserText(fixture.session, id)).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ autoDispatchPaused: false, items: [] });
	});

	it("[§11.6 resume-host-failed-again] a second host failure holds the target again without an automatic retry loop", async () => {
		const { fixture, host, control, ids, summaryCalls } = await pausedUserSlotCase("resume-fail2", {
			failSummaries: 2,
		});
		const resend = await control.changePending({
			...identity(fixture.session, control),
			requestId: "resume-fail2-change",
			messageId: ids.initial,
			expectedRevision: control.getSnapshot().revision,
			action: "resend",
		});
		expect(resend).toMatchObject({ ok: true });
		await control.waitForIdle();
		// 不自动循环：没有第三次摘要，也没有其它 held 被发出去。
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(summaryCalls()).toBe(2);
		expect(host.calls.map((call) => call.status)).toEqual(["failed", "failed"]);
		expect(fixture.session.compactionPause?.reason).toBe("failed");
		expect(countUserText(fixture.session, ids.initial)).toBe(0);
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: true,
			items: [
				expect.objectContaining({ messageId: ids.initial, state: "held" }),
				expect.objectContaining({ messageId: ids.steer, state: "queued" }),
				expect.objectContaining({ messageId: ids.queue, state: "queued" }),
			],
		});
		expect(queuedTexts(fixture.session)).toEqual([ids.steer, ids.queue]);
		// 载荷与身份保留；新的显式恢复才继续。
		await recoverAndResubmit(fixture.session, control, ids.initial, ids.initial, "resume-fail2-resend");
		await control.waitForIdle();
		expect(host.calls.map((call) => call.status)).toEqual(["failed", "failed", "success"]);
		for (const id of [ids.initial, ids.steer, ids.queue]) expect(countUserText(fixture.session, id)).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ autoDispatchPaused: false, items: [] });
	});

	it("[§11.6 resume-target-handled] a handled recovery target is consumed without committing or releasing the pause", async () => {
		const extension: ExtensionFactory = (pi) => {
			pi.registerCommand("resume-handled-cmd", {
				description: "test handled command",
				handler: async () => undefined,
			});
		};
		const { fixture, host, control, ids } = await pausedUserSlotCase("resume-handled", {
			extensions: [extension],
		});
		const identity0 = identity(fixture.session, control);
		const recovered = control.recover({
			...identity0,
			requestId: "resume-handled-recover",
			messageId: ids.initial,
			expectedRevision: control.getSnapshot().revision,
		});
		if (!recovered.ok) throw new Error(`recover failed: ${recovered.error.message}`);
		const handled = await control.submit({
			...identity0,
			requestId: "resume-handled-resend",
			mode: "queue",
			payload: { text: "/resume-handled-cmd" },
			recovery: { messageId: ids.initial, expectedRevision: control.getSnapshot().revision },
		});
		expect(handled).toMatchObject({
			ok: true,
			value: { messageId: ids.initial, disposition: "handled" },
		});
		await control.waitForIdle();
		expect(countUserText(fixture.session, "/resume-handled-cmd")).toBe(0);
		expect(host.calls.map((call) => call.status)).toEqual(["failed"]);
		expect(fixture.session.compactionPause?.reason).toBe("failed");
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: true,
			items: [
				expect.objectContaining({ messageId: ids.steer, state: "queued" }),
				expect.objectContaining({ messageId: ids.queue, state: "queued" }),
			],
		});
		expect(queuedTexts(fixture.session)).toEqual([ids.steer, ids.queue]);
	});

	/**
	 * §11.6 授权作用域：`consumeHostResume()` 只授权一次请求准备。若宿主设置在恢复前被取消，
	 * 这次准备根本不会经过 `_prepareHostPending`，授权就没人消费。此时不得把残留授权留给后续
	 * 普通 prepared run（非用户显式恢复）去解 pause。
	 *
	 * 全程只用真实 API：`setCompactionPolicy`（取消/重装）、真实控制器 recover/resend/stop、
	 * 真实 AgentSession 运行与内存模型流；不 mock host 内部或控制器。
	 */
	it("[§11.6 resume-grant-scope] a recovery grant is not left behind for a later ordinary prepared run when the host setting is canceled first", async () => {
		const { fixture, control, ids } = await pausedUserSlotCase("resume-scope");
		const identity0 = identity(fixture.session, control);
		// 取消宿主设置：本次恢复的请求准备不再安装 `preparePendingRequest`，授权无人消费。
		fixture.session.setCompactionPolicy(undefined);
		const runEntered = gate(),
			runRelease = gate();
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			if (isSummaryRequest(context)) return response(textTurn("## Summary\n- scope", 100, MODEL_20K));
			runEntered.resolve();
			await runRelease.promise;
			return response(textTurn("done", 100, MODEL_20K));
		};
		// 已 prepared 目标的真实显式恢复：授权在 `_startRunPrepared` 里被领取，宿主准备不参与。
		const resend = await control.changePending({
			...identity0,
			requestId: "resume-scope-change",
			messageId: ids.queue,
			expectedRevision: control.getSnapshot().revision,
			action: "resend",
		});
		expect(resend).toMatchObject({ ok: true });
		await withTimeout(runEntered.promise, 5_000, "scope recovery run entered");
		await waitForCondition(
			() => countUserText(fixture.session, ids.queue) === 1,
			5_000,
			"scope recovery target committed",
		);
		// 运行中投递扩展项：真实 prepared，随后由控制器的宿主暂停收尾逻辑留在 held（不进 transport）。
		const extText = "resume-scope-ext";
		expect(
			await control.submit(
				{ ...identity0, requestId: extText, mode: "queue", payload: { text: extText } },
				"extension",
			),
		).toMatchObject({ ok: true, value: { disposition: "queued" } });
		await waitForCondition(
			() => control.getSnapshot().items.some((item) => item.source === "extension" && item.state === "held"),
			5_000,
			"scope extension item held after preparation",
		);
		expect(queuedTexts(fixture.session)).toEqual([]);
		runRelease.resolve();
		await control.waitForIdle();
		expect(countUserText(fixture.session, extText)).toBe(0);
		const extRecord = control.getSnapshot().items.find((item) => item.source === "extension");
		if (!extRecord) throw new Error("extension item missing after the recovery run");

		// 重装宿主策略：第一次失败留下的 pause 仍在，未被任何一次授权清掉。
		installHostPolicy(fixture.session);
		expect(fixture.session.compactionPause?.reason).toBe("failed");

		// 普通 prepared run（扩展来源的 resend，不是用户显式恢复）：不得解 pause、不得投递。
		const ordinary = await control.changePending({
			...identity0,
			requestId: "resume-scope-ordinary",
			messageId: extRecord.messageId,
			expectedRevision: control.getSnapshot().revision,
			action: "resend",
		});
		expect(ordinary).toMatchObject({ ok: true });
		await control.waitForIdle();
		expect(fixture.session.compactionPause?.reason).toBe("failed");
		expect(countUserText(fixture.session, extText)).toBe(0);
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: true,
			items: expect.arrayContaining([
				expect.objectContaining({ messageId: extRecord.messageId, source: "extension", state: "held" }),
				expect.objectContaining({ messageId: ids.initial, source: "user", state: "held" }),
			]),
		});
	});

	it("[§11.6 resume-prepare-once] a prepared resume skips input handlers while an edited recovery prepares exactly once", async () => {
		const inputCalls: string[] = [];
		const extension: ExtensionFactory = (pi) => {
			pi.on("input", async (event) => {
				inputCalls.push(event.text);
				return { action: "continue" };
			});
		};
		const { fixture, control, ids } = await pausedUserSlotCase("resume-prep", { extensions: [extension] });
		const identity0 = identity(fixture.session, control);
		expect(inputCalls).toEqual([ids.initial, ids.steer, ids.queue]);
		// prepared 目标：直接复用已准备的执行载荷，不重复模板/input handler。
		const resend = await control.changePending({
			...identity0,
			requestId: "resume-prep-change",
			messageId: ids.queue,
			expectedRevision: control.getSnapshot().revision,
			action: "resend",
		});
		expect(resend).toMatchObject({ ok: true });
		await control.waitForIdle();
		expect(inputCalls).toEqual([ids.initial, ids.steer, ids.queue]);
		expect(countUserText(fixture.session, ids.queue)).toBe(1);
		// 编辑后 recovery：旧载荷不用，新载荷按正常准备路径恰好跑一次 input handler。
		const recovered = control.recover({
			...identity0,
			requestId: "resume-prep-initial-recover",
			messageId: ids.initial,
			expectedRevision: control.getSnapshot().revision,
		});
		if (!recovered.ok) throw new Error(`recover failed: ${recovered.error.message}`);
		const edited = "resume-prep 编辑后的恢复正文";
		const editedResult = await control.submit({
			...identity0,
			requestId: "resume-prep-initial-resend",
			mode: "queue",
			payload: { text: edited },
			recovery: { messageId: ids.initial, expectedRevision: control.getSnapshot().revision },
		});
		expect(editedResult).toMatchObject({ ok: true, value: { messageId: ids.initial } });
		await control.waitForIdle();
		expect(inputCalls.filter((text) => text === edited)).toHaveLength(1);
		expect(inputCalls).toEqual([ids.initial, ids.steer, ids.queue, edited]);
		// 旧 *未 prepared* 载荷没有被发送，新载荷恰好一次。
		expect(countUserText(fixture.session, ids.initial)).toBe(0);
		expect(countUserText(fixture.session, edited)).toBe(1);
		expect(control.getSnapshot().items).toEqual([]);
	});
});

/**
 * §19.8：请求前自动压缩（`_prepareRun` → `_checkCompaction` → `_runAutoCompaction`）的受理 ACK。
 *
 * 这里只验证真实阈值/溢出 start（不手改 compacting 标志、不 mock 控制器）：当摘要 gate 尚未释放时，
 * 首笔用户输入必须已经拿到 queued ACK；随后 queue/steer/interrupt 仍按既有容量与调度，最终每条用户
 * marker 只 commit 一次。受理后停掉运行或摘要迟到，都不得复活旧输入。
 */
describe("pre-prompt auto compaction acknowledgement (§19.8)", () => {
	async function prePromptCase(options: {
		overflow?: boolean;
		extensions?: ExtensionFactory[];
		settings?: typeof COMPACTION_SETTINGS;
	}) {
		const fixture = await sdkFixture({
			model: MODEL_20K,
			history: (manager) => compactionHistory(manager, { overflow: options.overflow }),
			settings: options.settings ?? COMPACTION_SETTINGS,
			noDefaultStream: true,
			...(options.extensions ? { extensions: options.extensions } : {}),
		});
		const entered = gate(),
			release = gate();
		let summaryCalls = 0;
		const userStarts: string[] = [];
		const ends: Array<{ reason?: string; aborted?: boolean }> = [];
		fixture.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user")
				userStarts.push(messageText(event.message.content));
			if (event.type === "compaction_end") ends.push(event);
		});
		fixture.session.agent.streamFunction = async (_model, context) => {
			fixture.requests.push(structuredClone(context.messages));
			if (isSummaryRequest(context)) {
				summaryCalls++;
				entered.resolve();
				await release.promise;
				return response(textTurn("## Summary\n- preprompt", 100, MODEL_20K));
			}
			return response(textTurn("done", 100, MODEL_20K));
		};
		// SDK 1.5.1 的扩展 runner 默认把 `before_agent_start` handler 抛错交给宿主 error sink 后继续运行。
		// 这里安装真实的 `bindExtensions({onError})` sink 并向上抛出，让 hook 错误真正进入 `_prepareRun`；
		// 不伪造 transport/摘要失败，也不改 SDK 的压缩入口。
		if (options.extensions?.length) {
			await fixture.session.bindExtensions({
				onError: (error) => {
					throw new Error(error.error);
				},
			});
		}
		const control = requireControl(fixture.session);
		const receipts: Array<{ messageId: string; requestId: string; status: string; error?: string }> = [];
		control.subscribe((update) => {
			if (update.receipt) receipts.push(update.receipt);
		});
		return {
			fixture,
			control,
			entered,
			release,
			userStarts,
			ends,
			receipts,
			summaryCalls: () => summaryCalls,
		};
	}

	it("[§19.8 ack-threshold-gate] threshold compaction ACKs the first input before the summary gate and commits each item once", async () => {
		const { fixture, control, entered, release, userStarts, ends, receipts, summaryCalls } =
			await prePromptCase({});
		const first = submit(fixture.session, control, "ack-first");
		await withTimeout(entered.promise, 5_000, "pre-prompt threshold summary gate");
		expect(fixture.session.isCompacting).toBe(true);

		// RED 契约：摘要 gate 未释放时首笔已被受理，而不是继续占着发送锁。
		const ack = await withTimeout(first, 2_000, "first queued ACK while the summary gate is held");
		expect(ack).toMatchObject({
			ok: true,
			value: { requestId: "ack-first", messageId: "ack-first", disposition: "queued" },
		});
		expect(countUserText(fixture.session, "ack-first")).toBe(0);
		expect(control.getSnapshot()).toMatchObject({
			phase: "compacting",
			items: [expect.objectContaining({ messageId: "ack-first", state: "queued" })],
		});

		// 同 requestId 重放复用稳定结果；冲突载荷仍拒绝；都不新增摘要。
		expect(
			await control.submit({
				...identity(fixture.session, control),
				requestId: "ack-first",
				mode: "queue",
				payload: { text: "ack-first" },
			}),
		).toEqual(ack);
		expect(
			await control.submit({
				...identity(fixture.session, control),
				requestId: "ack-first",
				mode: "queue",
				payload: { text: "ack-conflict" },
			}),
		).toMatchObject({ ok: false, error: { code: "request_id_conflict" } });
		expect(summaryCalls()).toBe(1);

		// 首笔仍占用自己的 queue 槽；steer/queue 遵循既有容量与调度边界。
		expect(await submit(fixture.session, control, "ack-steer", "steer")).toMatchObject({
			ok: true,
			value: { disposition: "queued" },
		});
		expect(await submit(fixture.session, control, "ack-queue", "queue")).toMatchObject({
			ok: true,
			value: { disposition: "queued" },
		});
		expect(countUserText(fixture.session, "ack-first")).toBe(0);

		release.resolve();
		await control.waitForIdle();
		expect(ends).toContainEqual(expect.objectContaining({ reason: "threshold", aborted: false }));
		expect(userStarts).toEqual(["ack-first", "ack-steer", "ack-queue"]);
		for (const id of ["ack-first", "ack-steer", "ack-queue"]) {
			expect(countUserText(fixture.session, id)).toBe(1);
			expect(
				receipts.filter((receipt) => receipt.messageId === id && receipt.status === "committed"),
			).toHaveLength(1);
		}
		expect(summaryCalls()).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ phase: "idle", autoDispatchPaused: false, items: [] });
		// 既有的模型请求边界（实测）：gate 期间已 prepared 的 steer 与首笔同处启动请求；
		// queue 在后续请求交付。不人为拆成三次请求。
		const requestTexts = fixture.requests.map((messages) => JSON.stringify(messages));
		expect(requestTexts.findIndex((text) => text.includes(SUMMARY_MARKER))).toBe(0);
		const firstIndex = requestTexts.findIndex((text) => text.includes("ack-first"));
		const steerIndex = requestTexts.findIndex((text) => text.includes("ack-steer"));
		const queueIndex = requestTexts.findIndex((text) => text.includes("ack-queue"));
		expect(firstIndex).toBe(1);
		expect(steerIndex).toBe(firstIndex);
		expect(queueIndex).toBe(firstIndex + 1);
		expect(requestTexts[1]).not.toContain("ack-queue");
	});

	it("[§19.8 ack-overflow-gate] overflow compaction also ACKs the first input before the gate and commits it once", async () => {
		const { fixture, control, entered, release, userStarts, ends } = await prePromptCase({
			overflow: true,
		});
		const first = submit(fixture.session, control, "ack-overflow");
		await withTimeout(entered.promise, 5_000, "pre-prompt overflow summary gate");
		expect(fixture.session.isCompacting).toBe(true);
		const ack = await withTimeout(first, 2_000, "overflow queued ACK while the summary gate is held");
		expect(ack).toMatchObject({ ok: true, value: { messageId: "ack-overflow", disposition: "queued" } });
		expect(countUserText(fixture.session, "ack-overflow")).toBe(0);
		release.resolve();
		await control.waitForIdle();
		expect(ends).toContainEqual(expect.objectContaining({ reason: "overflow", aborted: false }));
		expect(userStarts.filter((text) => text.includes("ack-overflow"))).toHaveLength(1);
		expect(countUserText(fixture.session, "ack-overflow")).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ phase: "idle", items: [] });
	});

	it("[§19.8 ack-interrupt-gate] interrupt cancels the gated summary, keeps the first accepted input held and delivers the new input once", async () => {
		const { fixture, control, entered, release, userStarts, ends } = await prePromptCase({});
		const first = submit(fixture.session, control, "ack-old");
		await withTimeout(entered.promise, 5_000, "pre-prompt interrupt summary gate");
		const ack = await withTimeout(first, 2_000, "old input queued ACK before interrupt");
		expect(ack).toMatchObject({ ok: true, value: { messageId: "ack-old", disposition: "queued" } });
		const interrupted = await submit(fixture.session, control, "ack-interrupt", "interrupt");
		expect(interrupted).toMatchObject({ ok: true, value: { disposition: "interrupting" } });
		release.resolve();
		await control.waitForIdle();
		expect(ends).toContainEqual(expect.objectContaining({ aborted: true }));
		expect(countUserText(fixture.session, "ack-old")).toBe(0);
		expect(countUserText(fixture.session, "ack-interrupt")).toBe(1);
		expect(userStarts.filter((text) => text.includes("ack-interrupt"))).toHaveLength(1);
		// interrupt 目标自己提交后释放的是它自己的 operation pause；旧输入仍由 held 持有。
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: false,
			items: [expect.objectContaining({ messageId: "ack-old", state: "held" })],
		});
		// 迟到摘要结果不复活旧输入。
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(countUserText(fixture.session, "ack-old")).toBe(0);
		// 旧载荷只能显式恢复，且只提交一次。
		await recoverAndResubmit(fixture.session, control, "ack-old", "ack-old", "ack-old-resend");
		await control.waitForIdle();
		expect(countUserText(fixture.session, "ack-old")).toBe(1);
		expect(countUserText(fixture.session, "ack-interrupt")).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ phase: "idle", items: [] });
	});

	it("[§19.8 ack-sync-stop] a synchronous stop during the compaction publication never returns a queued ACK", async () => {
		const { fixture, control, release } = await prePromptCase({});
		const identity0 = identity(fixture.session, control);
		let armed = true;
		let stopResult: unknown;
		control.subscribe((update) => {
			if (!armed || update.snapshot.phase !== "compacting") return;
			armed = false;
			stopResult = control.stop({ ...identity0, requestId: "ack-sync-stop-op" });
		});
		const first = submit(fixture.session, control, "ack-sync-stop");
		const ack = await withTimeout(first, 5_000, "stop during the compaction publication settles");
		expect(stopResult).toMatchObject({ ok: true });
		expect(ack).toMatchObject({ ok: false, error: { code: "preflight_failed" } });
		expect(countUserText(fixture.session, "ack-sync-stop")).toBe(0);
		release.resolve();
		await control.waitForIdle();
		expect(control.getSnapshot()).toMatchObject({
			phase: "idle",
			autoDispatchPaused: true,
			items: [expect.objectContaining({ messageId: "ack-sync-stop", state: "held" })],
		});
	});

	it("[§19.8 ack-sync-dispose] a synchronous dispose during the compaction publication never returns a queued ACK", async () => {
		const { fixture, control, release } = await prePromptCase({});
		let armed = true;
		control.subscribe((update) => {
			if (!armed || update.snapshot.phase !== "compacting") return;
			armed = false;
			control.dispose();
		});
		const first = submit(fixture.session, control, "ack-sync-dispose");
		const ack = await withTimeout(first, 5_000, "dispose during the compaction publication settles");
		expect(ack).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(armed).toBe(false);
		expect(countUserText(fixture.session, "ack-sync-dispose")).toBe(0);
		release.resolve();
		await withTimeout(control.waitForIdle(), 5_000, "session settles after the dispose publication");
		expect(control.getSnapshot()).toMatchObject({ items: [] });
	});

	it("[§19.8 ack-after-stop] a stop after the queued ACK holds the input and a late summary never revives it", async () => {
		const { fixture, control, entered, release } = await prePromptCase({});
		const first = submit(fixture.session, control, "ack-late");
		await withTimeout(entered.promise, 5_000, "late-stop summary gate");
		const ack = await withTimeout(first, 2_000, "queued ACK before stop");
		expect(ack).toMatchObject({ ok: true, value: { messageId: "ack-late", disposition: "queued" } });
		expect(
			control.stop({ ...identity(fixture.session, control), requestId: "ack-late-stop-op" }),
		).toMatchObject({ ok: true });
		release.resolve();
		await control.waitForIdle();
		expect(countUserText(fixture.session, "ack-late")).toBe(0);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(countUserText(fixture.session, "ack-late")).toBe(0);
		expect(control.getSnapshot()).toMatchObject({
			autoDispatchPaused: true,
			items: [expect.objectContaining({ messageId: "ack-late", state: "held" })],
		});
		await recoverAndResubmit(fixture.session, control, "ack-late", "ack-late", "ack-late-resend");
		await control.waitForIdle();
		expect(countUserText(fixture.session, "ack-late")).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ phase: "idle", items: [] });
	});

	it("[§19.8 ack-prepare-failure] a real before_agent_start failure after compaction keeps the queued ACK, holds once and recovers the full payload", async () => {
		let failOnce = true;
		const extension: ExtensionFactory = (pi) => {
			pi.on("before_agent_start", async () => {
				if (!failOnce) return;
				failOnce = false;
				throw new Error("prepare boom after compaction");
			});
		};
		const payload: MessagePayload = {
			text: "ack-fail 完整草稿",
			images: [{ data: PNG_1X1, mimeType: "image/png" }],
			draft: {
				text: "ack-fail 完整草稿",
				attachments: ["file:ack-19.8.md"],
				quotes: ["quote:19.8"],
				slashCommand: null,
				imageNames: ["ack-19.8.png"],
			},
		};
		const { fixture, control, entered, release, receipts } = await prePromptCase({
			extensions: [extension],
			settings: IMAGE_SETTINGS,
		});
		const first = submit(fixture.session, control, "ack-fail", "queue", payload);
		await withTimeout(entered.promise, 5_000, "prepare-failure summary gate");
		const ack = await withTimeout(first, 2_000, "queued ACK before the preparation failure");
		expect(ack).toMatchObject({ ok: true, value: { messageId: "ack-fail", disposition: "queued" } });
		release.resolve();
		await waitForCondition(
			() =>
				control.getSnapshot().items.some((item) => item.messageId === "ack-fail" && item.state === "held"),
			5_000,
			"failed preparation holds the input",
		);
		await withTimeout(control.waitForIdle(), 5_000, "failed preparation settles");
		expect(countUserText(fixture.session, payload.text)).toBe(0);
		expect(countUserImages(fixture.session, PNG_1X1)).toBe(0);
		expect(receipts).toContainEqual(
			expect.objectContaining({
				messageId: "ack-fail",
				requestId: "ack-fail",
				status: "failed",
				error: "prepare boom after compaction",
			}),
		);
		const recovered = control.recover({
			...identity(fixture.session, control),
			requestId: "ack-fail-recover",
			messageId: "ack-fail",
			expectedRevision: control.getSnapshot().revision,
		});
		if (!recovered.ok) throw new Error(`recover ack-fail failed: ${recovered.error.message}`);
		expect(recovered.value).toMatchObject({ messageId: "ack-fail", payload });
		const resend = await control.submit({
			...identity(fixture.session, control),
			requestId: "ack-fail-resend",
			mode: "queue",
			payload: recovered.value.payload,
			recovery: { messageId: "ack-fail", expectedRevision: control.getSnapshot().revision },
		});
		expect(resend).toMatchObject({ ok: true, value: { messageId: "ack-fail" } });
		await control.waitForIdle();
		expect(countUserText(fixture.session, payload.text)).toBe(1);
		expect(countUserImages(fixture.session, PNG_1X1)).toBe(1);
		expect(control.getSnapshot()).toMatchObject({ phase: "idle", items: [] });
	});
});
