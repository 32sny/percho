import { buildSendUiError, type UiError, type UiErrorAction } from "../errors";
import type { ControlSnapshot } from "../message-control";
import type { SessionTranscriptState, UIMessage } from "./types";

/**
 * 控制投递失败反馈的**唯一纯投影**（§19.8）：`message_control_update` 的 failed receipt 与
 * `submitMessage` 的 `preflight_failed` 响应共用同一份判定与同一张卡。
 *
 * 为什么需要它：首笔自动压缩提前 ACK 后，submit 的 Promise 已经成功返回，后续准备失败只以
 * failed receipt + held 快照出现；只靠 Composer 内联条会漏反馈，而两条通路（事件/响应）先后
 * 不定，必须按稳定卡身份双向去重。
 *
 * 边界：
 * - 只处理**有效 runtime/revision**（旧实例/旧 revision 一律 stale，不改任何状态）；
 * - 只在快照里存在对应 `source=user` 且 `state=held` 实体时产卡（扩展来源不报成用户失败）；
 * - 精确摘除对应 `controlMessageId` 的未认领乐观气泡，不动其他用户消息；
 * - 不碰草稿、发送锁、pendingTx、容量与 active 状态（那些归 Composer 与 reducer 其它分支）。
 */

/** 卡片 id 前缀：稳定身份 = 控制投递三元组（避免分隔符碰撞，用 JSON 编码） */
export const CONTROL_SEND_ERROR_CARD_PREFIX = "control-send-error:";

/**
 * 投影结果：
 * - `handled`  已处理（可能产卡/更新卡/精确取消无卡），调用方不得再给内联重复提示；
 * - `stale`    旧 runtime 或旧 revision，已忽略（不得覆盖新状态，也不得内联重复）；
 * - `unmatched` 快照里没有可关联的 held 用户实体，调用方保留原有内联兜底。
 */
export type ControlSendFailureOutcome = "handled" | "stale" | "unmatched";

export interface ControlSendFailure {
	/** 失败时的控制快照（receipt 的 event.snapshot / 响应的 error.snapshot） */
	snapshot: ControlSnapshot;
	/** 控制实体 id（receipt.messageId；响应分支用 recovery.messageId ?? requestId） */
	messageId: string;
	/** 原请求 id（响应分支不得生成新身份） */
	requestId: string;
	/** 失败原文（receipt.error / error.message） */
	error?: string;
	/** 测试用固定时间 */
	now?: number;
}

/**
 * 精确的「非故障」文案：用户主动取消准备、或宿主等待用户下一条输入而主动持有。
 * 必须精确相等——宽泛匹配 cancelled/abort 会把真实 provider 故障也藏掉。
 */
const NON_FAILURE_MESSAGES: ReadonlySet<string> = new Set([
	"Message preparation was cancelled",
	"Host paused: awaiting-user",
]);

/** 泛化宿主暂停（可能是任何 pause reason）：只作为兜底卡，不得覆盖同 ID 的具体失败原因 */
function isGenericHostHold(message: string): boolean {
	return message.startsWith("Host paused:") && !NON_FAILURE_MESSAGES.has(message);
}

/** 稳定卡 id（receipt 与响应两通路必须得到同一个 id） */
export function controlSendErrorCardId(runtimeId: string, messageId: string, requestId: string): string {
	return `${CONTROL_SEND_ERROR_CARD_PREFIX}${JSON.stringify([runtimeId, messageId, requestId])}`;
}

/**
 * 控制投递失败卡的 action 收窄：复用原分类的标题/详情，只保留 copyDetail 与原分类已有的
 * openSettings；不提供 retryLastFailedTurn / compact（恢复载荷走 QueueBar，避免造第二个恢复入口）。
 */
function narrowFailureActions(actions: UiErrorAction[]): UiErrorAction[] {
	const kept = actions.filter((action) => action === "copyDetail" || action === "openSettings");
	return kept.includes("copyDetail") ? kept : [...kept, "copyDetail"];
}

function buildControlSendUiError(message: string, now: number): UiError {
	const base = buildSendUiError(message, now);
	return { ...base, actions: narrowFailureActions(base.actions) };
}

/** 失败卡（同一 id 的更新复用原消息位置与 id，只换 error 信封） */
function failureCard(id: string, error: UiError): UIMessage {
	return { kind: "error", id, text: "", timestamp: error.timestamp, error };
}

/**
 * 应用控制投递失败：校验 runtime/revision → 同步快照 → 精确摘气泡 → 按需产卡/更新卡。
 * 纯函数：不改入参 state，无副作用（时间可由 `now` 固定）。
 */
export function projectControlSendFailure(
	state: SessionTranscriptState,
	failure: ControlSendFailure,
): { state: SessionTranscriptState; outcome: ControlSendFailureOutcome } {
	const snap = failure.snapshot;
	// runtime 已钉住时旧实例快照一律拒收；同 runtime 的旧 revision 不覆盖新状态
	if (state.controlRuntimeId && snap.runtimeId !== state.controlRuntimeId) {
		return { state, outcome: "stale" };
	}
	if (state.control && state.control.runtimeId === snap.runtimeId && snap.revision < state.control.revision) {
		return { state, outcome: "stale" };
	}

	// 快照同步（含精确取消：即使不产卡也要让 held 实体可见）
	let next: SessionTranscriptState = { ...state, control: snap, controlRuntimeId: snap.runtimeId };

	// 精确摘除本次请求的乐观气泡：按 controlMessageId 定位，不按文本、不碰其他消息
	const messages = next.messages.filter(
		(message) =>
			!(
				message.kind === "user" &&
				message.pending === true &&
				message.controlMessageId === failure.messageId
			),
	);
	if (messages.length !== next.messages.length) next = { ...next, messages };

	// 关联判据：快照里同一实体仍是用户来源的 held 项（已 committed/consumed 的不产失败卡）
	const linked = snap.items.some(
		(item) => item.messageId === failure.messageId && item.source === "user" && item.state === "held",
	);
	if (!linked) return { state: next, outcome: "unmatched" };

	const message = failure.error?.trim() ?? "";
	if (!message || NON_FAILURE_MESSAGES.has(message)) return { state: next, outcome: "handled" };

	const now = failure.now ?? Date.now();
	const id = controlSendErrorCardId(snap.runtimeId, failure.messageId, failure.requestId);
	const index = next.messages.findIndex((entry) => entry.id === id);
	if (index < 0) {
		const card = failureCard(id, buildControlSendUiError(message, now));
		return { state: { ...next, messages: [...next.messages, card] }, outcome: "handled" };
	}

	const existing = next.messages[index];
	// 同 id 但非本投影产出的消息（理论上的 id 碰撞）：不覆盖
	if (existing?.kind !== "error") return { state: next, outcome: "handled" };
	const existingDetail = existing.error.detail ?? "";
	// 泛化 Host paused 不覆盖已有的具体原因；相同详情重复投递保持引用稳定
	if (isGenericHostHold(message) && !isGenericHostHold(existingDetail)) {
		return { state: next, outcome: "handled" };
	}
	if (existingDetail === message) return { state: next, outcome: "handled" };

	const updated: UIMessage = { ...existing, error: buildControlSendUiError(message, now) };
	return {
		state: { ...next, messages: next.messages.map((entry, i) => (i === index ? updated : entry)) },
		outcome: "handled",
	};
}
