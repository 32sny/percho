import type { AgentSessionEvent, ControlSnapshot, SessionMessage } from "@percho/shared";
import {
	appendOptimisticUserMessage,
	controlSendErrorCardId,
	emptyTranscript,
	messagesToUIMessages,
	projectControlSendFailure,
	reduceEvent,
} from "@percho/shared";
import { describe, expect, it } from "vitest";

type Event = AgentSessionEvent;
const turnEnd = (stopReason: string, errorMessage?: string): Event =>
	({
		type: "turn_end",
		message: { role: "assistant", stopReason, errorMessage },
		toolResults: [],
	}) as unknown as Event;
const agentEnd = (willRetry: boolean): Event => ({ type: "agent_end", messages: [], willRetry });
const settled: Event = { type: "agent_settled", aborted: false };
const guard: Event = { type: "stream_guard_tripped", verdict: "trip_whitespace" } as unknown as Event;

const errorCards = (s: ReturnType<typeof emptyTranscript>) => s.messages.filter((m) => m.kind === "error");

describe("reducer — LLM 错误卡（决策 D1：agent_end 落卡）", () => {
	it("单次失败：turn_end(error) → agent_end(willRetry=false) 恰好一张卡", () => {
		let s = reduceEvent(emptyTranscript(), turnEnd("error", '401: {"message":"Invalid API key provided"}'));
		expect(errorCards(s)).toHaveLength(0); // pending 待判定
		s = reduceEvent(s, agentEnd(false));
		const cards = errorCards(s);
		expect(cards).toHaveLength(1);
		const card = cards[0];
		expect(card).toMatchObject({ kind: "error", text: "" });
		if (card?.kind !== "error") return;
		expect(card.error).toMatchObject({
			severity: "error",
			source: "llm",
			titleKey: "error.title.llmAuth",
			detail: '401: {"message":"Invalid API key provided"}',
		});
		expect(card.error.actions).toContain("retry");
		expect(card.error.actions).toContain("copyDetail");
	});

	it("重试成功：error → willRetry=true 丢弃 → 成功轮 → 无卡", () => {
		let s = reduceEvent(emptyTranscript(), turnEnd("error", "429: rate limit"));
		s = reduceEvent(s, agentEnd(true));
		expect(errorCards(s)).toHaveLength(0);
		s = reduceEvent(s, turnEnd("stop"));
		s = reduceEvent(s, agentEnd(false));
		expect(errorCards(s)).toHaveLength(0);
		expect(s.pendingLlmError).toBeNull();
	});

	it("重试耗尽：3 个 error 轮只落最后一张", () => {
		let s = reduceEvent(emptyTranscript(), turnEnd("error", "429: attempt 1"));
		s = reduceEvent(s, agentEnd(true));
		s = reduceEvent(s, turnEnd("error", "429: attempt 2"));
		s = reduceEvent(s, agentEnd(true));
		s = reduceEvent(s, turnEnd("error", "429: attempt 3"));
		s = reduceEvent(s, agentEnd(false));
		const cards = errorCards(s);
		expect(cards).toHaveLength(1);
		if (cards[0]?.kind === "error") {
			expect(cards[0].error.detail).toContain("attempt 3"); // 最后一条错误
		}
	});

	it("aborted 不产卡（用户主动中止）", () => {
		let s = reduceEvent(emptyTranscript(), turnEnd("aborted"));
		s = reduceEvent(s, agentEnd(false));
		expect(errorCards(s)).toHaveLength(0);
	});

	it("error + abort 文案不产卡（用户主动中止时 SDK 标成 error 的实测形态）", () => {
		// DOMException AbortError：中断工具执行后，agent loop 继续发起的 in-flight 请求被取消
		let s = reduceEvent(emptyTranscript(), turnEnd("error", "This operation was aborted"));
		s = reduceEvent(s, agentEnd(false));
		expect(errorCards(s)).toHaveLength(0);
		expect(s.pendingLlmError).toBeNull();
		// SDK 上层另一种中止形态
		s = reduceEvent(emptyTranscript(), turnEnd("error", "Request aborted"));
		s = reduceEvent(s, agentEnd(false));
		expect(errorCards(s)).toHaveLength(0);
	});

	it("含 abort 字样但非取消语义的错误仍产卡（判定只看文案，detail 不丢）", () => {
		let s = reduceEvent(emptyTranscript(), turnEnd("error", "provider aborted the request: 503"));
		s = reduceEvent(s, agentEnd(false));
		expect(errorCards(s)).toHaveLength(1);
	});

	it("errorMessage 为空串不产卡（防御）", () => {
		let s = reduceEvent(emptyTranscript(), turnEnd("error", ""));
		s = reduceEvent(s, agentEnd(false));
		expect(errorCards(s)).toHaveLength(0);
	});

	it("agent_settled 兜底：agent_end 缺失时 pending 仍落卡", () => {
		let s = reduceEvent(emptyTranscript(), turnEnd("error", "timeout"));
		s = reduceEvent(s, settled);
		expect(errorCards(s)).toHaveLength(1);
	});
});

describe("reducer — auto_retry 瞬时状态（retrying）", () => {
	it("auto_retry_start → 状态行数据齐全；auto_retry_end 清除", () => {
		let s = reduceEvent(emptyTranscript(), {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 2,
			delayMs: 8000,
			errorMessage: "429: x",
		});
		expect(s.retrying).toEqual({ attempt: 1, maxAttempts: 2, delayMs: 8000 });
		s = reduceEvent(s, { type: "auto_retry_end", success: true, attempt: 1, finalError: undefined });
		expect(s.retrying).toBeNull();
	});

	it("retry 轮继续（turn_start/turn_end）不清除状态行（实测：auto_retry_start 后紧接重试轮）", () => {
		let s = reduceEvent(emptyTranscript(), {
			type: "auto_retry_start",
			attempt: 2,
			maxAttempts: 2,
			delayMs: 300,
			errorMessage: "429: x",
		});
		s = reduceEvent(s, { type: "turn_start" });
		expect(s.retrying).not.toBeNull();
	});

	it("agent_settled 兜底清除", () => {
		let s = reduceEvent(emptyTranscript(), {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 1,
			delayMs: 10,
			errorMessage: "x",
		});
		s = reduceEvent(s, settled);
		expect(s.retrying).toBeNull();
	});
});

describe("reducer — stream_guard_tripped", () => {
	it("产 warning 卡（verdict 进 detail），并在正文之后", () => {
		// 先有一轮正常正文流（turn_start + text delta + turn_end 固化）
		let s = reduceEvent(emptyTranscript(), { type: "agent_start" });
		s = reduceEvent(s, { type: "turn_start" });
		s = reduceEvent(s, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "部分正文", contentIndex: 0 },
		} as unknown as Event);
		s = reduceEvent(s, turnEnd("stop"));
		const before = s.messages.length;
		s = reduceEvent(s, guard);
		const cards = errorCards(s);
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({ kind: "error", text: "" });
		if (cards[0]?.kind !== "error") return;
		expect(cards[0].error).toMatchObject({ severity: "warning", titleKey: "error.title.streamGuard" });
		expect(cards[0].error.detail).toContain("trip_whitespace");
		expect(cards[0].error.actions).toEqual(["retry", "copyDetail"]);
		// 落在正文消息之后
		expect(s.messages[before]).toMatchObject({ kind: "error" });
	});

	it("清除同轮 pending LLM 错误（熔断卡是唯一解释）", () => {
		let s = reduceEvent(emptyTranscript(), turnEnd("error", "429: xxx"));
		s = reduceEvent(s, guard);
		expect(errorCards(s)).toHaveLength(1);
		expect(s.pendingLlmError).toBeNull();
		// 后续 agent_end(willRetry=false) 不再落 LLM 卡
		s = reduceEvent(s, agentEnd(false));
		expect(errorCards(s)).toHaveLength(1);
	});
});

describe("reducer — 控制投递失败投影（receipt / preflight_failed 共用）", () => {
	const heldSnapshot = (over: Record<string, unknown> = {}): ControlSnapshot =>
		({
			runtimeId: "rt1",
			revision: 5,
			phase: "running",
			autoDispatchPaused: true,
			items: [
				{
					messageId: "m-1",
					source: "user",
					mode: "queue",
					state: "held",
					preview: "hi",
					imageCount: 0,
				},
			],
			...over,
		}) as ControlSnapshot;

	const failedReceipt = (
		snapshot: ControlSnapshot,
		error: string,
		messageId = "m-1",
		requestId = "req-1",
	): Event =>
		({
			type: "message_control_update",
			snapshot,
			receipt: { messageId, requestId, status: "failed", error },
		}) as unknown as Event;

	const withPendingBubble = (controlMessageId = "m-1") =>
		appendOptimisticUserMessage(emptyTranscript(), {
			text: "hi",
			images: [],
			controlMessageId,
		}).state;

	const pendingUsers = (s: ReturnType<typeof emptyTranscript>) =>
		s.messages.filter((m) => m.kind === "user" && m.pending === true);

	it("响应投影：held 用户实体 + 具体错误 → 一张卡（稳定 ID，无 retry/compact）", () => {
		const proj = projectControlSendFailure(withPendingBubble(), {
			snapshot: heldSnapshot(),
			messageId: "m-1",
			requestId: "req-1",
			error: "401: Invalid API key",
			now: 1234,
		});
		expect(proj.outcome).toBe("handled");
		expect(pendingUsers(proj.state)).toHaveLength(0);
		const cards = errorCards(proj.state);
		expect(cards).toHaveLength(1);
		const card = cards[0];
		if (card?.kind !== "error") return;
		expect(card.id).toBe(controlSendErrorCardId("rt1", "m-1", "req-1"));
		expect(card.error).toMatchObject({
			severity: "error",
			source: "llm",
			titleKey: "error.title.llmAuth",
			detail: "401: Invalid API key",
			timestamp: 1234,
		});
		// 复用原分类的 openSettings，但绝不带 retry/compact（恢复走 QueueBar）
		expect(card.error.actions).toEqual(["openSettings", "copyDetail"]);
		expect(card.error.retryTarget).toBeUndefined();
		// 快照同步（held 实体保留，不改成 consumed/committed）
		expect(proj.state.control).toEqual(heldSnapshot());
		expect(proj.state.controlRuntimeId).toBe("rt1");
	});

	it("只移除对应 controlMessageId 的未认领气泡，其他 pending/已认领消息不动", () => {
		let s = appendOptimisticUserMessage(emptyTranscript(), {
			text: "other",
			images: [],
			controlMessageId: "other",
		}).state;
		s = appendOptimisticUserMessage(s, {
			text: "claimed",
			images: [],
			controlMessageId: "m-1",
		}).state;
		s = {
			...s,
			messages: s.messages.map((m) =>
				m.kind === "user" && m.controlMessageId === "m-1" ? { ...m, pending: false } : m,
			),
		};
		s = appendOptimisticUserMessage(s, {
			text: "hi",
			images: [],
			controlMessageId: "m-1",
		}).state;
		const proj = projectControlSendFailure(s, {
			snapshot: heldSnapshot(),
			messageId: "m-1",
			requestId: "req-1",
			error: "401: Invalid API key",
		});
		expect(proj.outcome).toBe("handled");
		const texts = proj.state.messages.filter((m) => m.kind === "user").map((m) => m.text);
		expect(texts).toEqual(["other", "claimed"]);
		expect(pendingUsers(proj.state)).toHaveLength(1);
	});

	it("回执先到：响应后到（更旧 revision）为 stale，不追加卡也不改状态", () => {
		let s = reduceEvent(withPendingBubble(), failedReceipt(heldSnapshot(), "401: Invalid API key"));
		expect(errorCards(s)).toHaveLength(1);
		const proj = projectControlSendFailure(s, {
			snapshot: heldSnapshot({ revision: 4 }),
			messageId: "m-1",
			requestId: "req-1",
			error: "401: Invalid API key",
		});
		expect(proj.outcome).toBe("stale");
		expect(proj.state).toBe(s);
		// 同回执重复（revision 前进）不追加第二张
		s = reduceEvent(s, failedReceipt(heldSnapshot({ revision: 6 }), "401: Invalid API key"));
		expect(errorCards(s)).toHaveLength(1);
		expect(s.control?.revision).toBe(6);
	});

	it("响应先到产卡，随后 receipt 同 ID 不追加（双向去重）", () => {
		const proj = projectControlSendFailure(withPendingBubble(), {
			snapshot: heldSnapshot(),
			messageId: "m-1",
			requestId: "req-1",
			error: "429: rate limit",
		});
		expect(proj.outcome).toBe("handled");
		const s = reduceEvent(proj.state, failedReceipt(heldSnapshot({ revision: 6 }), "429: rate limit"));
		const cards = errorCards(s);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.id).toBe(controlSendErrorCardId("rt1", "m-1", "req-1"));
	});

	it("同 ID 后续具体错误更新原卡；泛化 Host paused 不覆盖具体原因", () => {
		let s = reduceEvent(withPendingBubble(), failedReceipt(heldSnapshot(), "401: Invalid API key"));
		s = reduceEvent(s, failedReceipt(heldSnapshot({ revision: 6 }), "Host paused: threshold"));
		let cards = errorCards(s);
		expect(cards).toHaveLength(1);
		if (cards[0]?.kind !== "error") return;
		expect(cards[0].error.detail).toBe("401: Invalid API key");
		expect(cards[0].error.titleKey).toBe("error.title.llmAuth");
		// 后续具体错误可以更新（detail 与分类都换新）
		s = reduceEvent(s, failedReceipt(heldSnapshot({ revision: 7 }), "ETIMEDOUT while preparing"));
		cards = errorCards(s);
		expect(cards).toHaveLength(1);
		if (cards[0]?.kind !== "error") return;
		expect(cards[0].error.detail).toBe("ETIMEDOUT while preparing");
		expect(cards[0].error.titleKey).toBe("error.title.llmNetwork");
		expect(cards[0].id).toBe(controlSendErrorCardId("rt1", "m-1", "req-1"));
	});

	it("兜底 Host paused 先落卡，后续具体错误覆盖兜底", () => {
		let s = reduceEvent(withPendingBubble(), failedReceipt(heldSnapshot(), "Host paused: threshold"));
		let cards = errorCards(s);
		expect(cards).toHaveLength(1);
		if (cards[0]?.kind !== "error") return;
		expect(cards[0].error.titleKey).toBe("error.title.sendFailed");
		s = reduceEvent(s, failedReceipt(heldSnapshot({ revision: 6 }), "401: Invalid API key"));
		cards = errorCards(s);
		expect(cards).toHaveLength(1);
		if (cards[0]?.kind !== "error") return;
		expect(cards[0].error.detail).toBe("401: Invalid API key");
		expect(cards[0].error.titleKey).toBe("error.title.llmAuth");
	});

	it.each(["Message preparation was cancelled", "Host paused: awaiting-user"])(
		"精确文案 %s 不产卡，但仍同步快照并移除乐观气泡",
		(error) => {
			const s = reduceEvent(withPendingBubble(), failedReceipt(heldSnapshot({ revision: 8 }), error));
			expect(errorCards(s)).toHaveLength(0);
			expect(pendingUsers(s)).toHaveLength(0);
			expect(s.control?.revision).toBe(8);
			expect(s.controlRuntimeId).toBe("rt1");
		},
	);

	it("含 cancelled 字样但非精确取消文案仍产卡（不宽匹配）", () => {
		const message = "Message preparation was cancelled: provider returned 500";
		const s = reduceEvent(withPendingBubble(), failedReceipt(heldSnapshot(), message));
		const cards = errorCards(s);
		expect(cards).toHaveLength(1);
		if (cards[0]?.kind !== "error") return;
		expect(cards[0].error.detail).toBe(message);
	});

	it("扩展来源的实体不产卡（unmatched），不把扩展失败报成用户发送失败", () => {
		const proj = projectControlSendFailure(withPendingBubble("ext-1"), {
			snapshot: heldSnapshot({
				items: [
					{
						messageId: "ext-1",
						source: "extension",
						mode: "queue",
						state: "held",
						preview: "ext",
						imageCount: 0,
					},
				],
			}),
			messageId: "ext-1",
			requestId: "req-1",
			error: "401: Invalid API key",
		});
		expect(proj.outcome).toBe("unmatched");
		expect(errorCards(proj.state)).toHaveLength(0);
		expect(proj.state.control?.revision).toBe(5);
	});

	it("快照无对应 held 用户实体 → unmatched，无卡但同步快照并摘精确气泡", () => {
		const proj = projectControlSendFailure(withPendingBubble(), {
			snapshot: heldSnapshot({ revision: 9, items: [] }),
			messageId: "m-1",
			requestId: "req-1",
			error: "401: Invalid API key",
		});
		expect(proj.outcome).toBe("unmatched");
		expect(errorCards(proj.state)).toHaveLength(0);
		expect(pendingUsers(proj.state)).toHaveLength(0);
		expect(proj.state.control?.revision).toBe(9);
	});

	it("旧 runtime 快照 → stale：不覆盖已钉 runtime、不动消息", () => {
		const pinned = {
			...withPendingBubble(),
			control: heldSnapshot({ runtimeId: "rt2", revision: 1 }),
			controlRuntimeId: "rt2",
		};
		const proj = projectControlSendFailure(pinned, {
			snapshot: heldSnapshot({ runtimeId: "rt1", revision: 9 }),
			messageId: "m-1",
			requestId: "req-1",
			error: "401: Invalid API key",
		});
		expect(proj.outcome).toBe("stale");
		expect(proj.state).toBe(pinned);
	});
});

describe("mapping — 历史回放产卡（连续 error 合并）", () => {
	const asst = (stopReason: string, errorMessage?: string, text = ""): SessionMessage =>
		({
			role: "assistant",
			text,
			thinking: "",
			tools: [],
			images: [],
			timestamp: 1,
			...(stopReason ? { stopReason } : {}),
			...(errorMessage ? { errorMessage } : {}),
		}) as SessionMessage;

	it("1 user + 3 连续 error assistant → 一张卡（重试轮合并）", () => {
		const ui = messagesToUIMessages([
			{ role: "user", text: "hi", thinking: "", tools: [], images: [], timestamp: 0 },
			asst("error", "429: attempt 1"),
			asst("error", "429: attempt 2"),
			asst("error", "429: attempt 3"),
		]);
		const cards = ui.filter((m) => m.kind === "error");
		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({ kind: "error", text: "" });
		if (cards[0]?.kind === "error") expect(cards[0].error.detail).toContain("attempt 3");
	});

	it("partial 正文 + error：正文消息在前，错误卡在后", () => {
		const ui = messagesToUIMessages([asst("error", "429: rate limit", "我正准备…")]);
		expect(ui).toHaveLength(2);
		expect(ui[0]).toMatchObject({ kind: "assistant", text: "我正准备…" });
		expect(ui[1]).toMatchObject({ kind: "error" });
	});

	it("error 与正常回复交错：各自落卡（不误合并）", () => {
		const ui = messagesToUIMessages([
			asst("error", "401: auth"),
			asst("stop", undefined, "正常回复"),
			asst("error", "429: again"),
		]);
		const cards = ui.filter((m) => m.kind === "error");
		expect(cards).toHaveLength(2);
	});

	it("aborted / 正常完成不产卡；无 errorMessage 的错误不产卡", () => {
		expect(messagesToUIMessages([asst("aborted", undefined, "被中止")])).toHaveLength(1);
		const noMsg = messagesToUIMessages([asst("error")]); // backend 不会产出此类消息（无内容且无错误信息），防御不产卡
		expect(noMsg.filter((m) => m.kind === "error")).toHaveLength(0);
		expect(messagesToUIMessages([asst("stop", undefined, "ok")])).toHaveLength(1);
	});

	it("error + abort 文案不产卡（回放与 live 同判定）", () => {
		// DOMException / SDK 中止文案：已落盘的空 assistant 消息回放时不冒错误卡
		expect(
			messagesToUIMessages([asst("error", "This operation was aborted")]).filter((m) => m.kind === "error"),
		).toHaveLength(0);
		expect(
			messagesToUIMessages([asst("error", "Request aborted")]).filter((m) => m.kind === "error"),
		).toHaveLength(0);
	});

	it("分类：401 → llmAuth / context overflow → llmOverflow（回放与 live 同判定）", () => {
		const ui401 = messagesToUIMessages([asst("error", "401: unauthorized")]);
		const uiOverflow = messagesToUIMessages([asst("error", "context_length_exceeded")]);
		if (ui401[0]?.kind === "error") expect(ui401[0].error.titleKey).toBe("error.title.llmAuth");
		if (uiOverflow[0]?.kind === "error") expect(uiOverflow[0].error.titleKey).toBe("error.title.llmOverflow");
	});
});
