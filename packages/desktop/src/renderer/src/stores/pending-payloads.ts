import type { ChangePendingMessageResult, ControlResult, ControlSnapshot } from "@percho/shared";
import { getPi } from "../api";
import { useTranscriptStore } from "./transcript";

/**
 * 关闭/删除会话前的待发载荷守卫（方案 §1.2 / §3.6）：
 * - 未发送消息不进对话历史，销毁前必须**逐 messageId + 最新 revision 显式 discard**；
 * - 只丢弃「目标快照原有 items」：复核时发现中途新加入的项 → `changed`，调用方须再次确认或停止（不暗丢新项）；
 * - GC 卸载不走这里（由后端拒绝）；只隐藏窗口/切 tab 不触发任何清理。
 */

let requestSeq = 0;
function newRequestId(): string {
	const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
	if (c?.randomUUID) return c.randomUUID();
	requestSeq += 1;
	return `req-${Date.now()}-${requestSeq}`;
}

interface ControlApi {
	getMessageControl: (req: { sessionId: string }) => Promise<ControlResult<ControlSnapshot>>;
	changePendingMessage: (req: unknown) => Promise<ControlResult<ChangePendingMessageResult>>;
}

function controlApi(): ControlApi | null {
	const pi = getPi() as unknown as Partial<ControlApi>;
	if (typeof pi.getMessageControl !== "function" || typeof pi.changePendingMessage !== "function")
		return null;
	return pi as ControlApi;
}

/** 会话当前待发项（控制快照投影；无快照/未启用控制 = 空） */
export function pendingPayloadItems(sessionId: string) {
	return useTranscriptStore.getState().bySession[sessionId]?.control?.items ?? [];
}

export type DiscardPendingResult =
	| "empty" // 无待发项（或控制未启用，无实体可丢）
	| "ok" // 原有项已全部显式 discard，复核无残留
	| "changed" // 复核发现中途新加入的项：只丢了原有项，调用方须再次确认/停止
	| "cancelled" // 用户取消专项确认
	| "unavailable"; // 快照/IPC 失败：什么都没丢，调用方应中止销毁

type ConfirmPendingPayloads = (count: number) => boolean | Promise<boolean>;
let confirmPendingPayloads: ConfirmPendingPayloads = async (count) => {
	const { translate, useI18nStore } = await import("../i18n");
	return window.confirm(translate(useI18nStore.getState().language, "pendingPayloadConfirm", { count }));
};

/** 测试或宿主可替换专项确认行为。 */
export function setPendingPayloadConfirmation(confirm: ConfirmPendingPayloads): () => void {
	const previous = confirmPendingPayloads;
	confirmPendingPayloads = confirm;
	return () => {
		confirmPendingPayloads = previous;
	};
}

/**
 * 显式丢弃会话全部待发载荷。流程：拉最新快照 → 对其原有 items 逐条 discard（每条带当时最新 revision）
 * → 复核快照：仍有 items（中途新加入）→ changed，绝不顺手丢弃新项。
 */
export async function discardPendingPayloads(sessionId: string): Promise<DiscardPendingResult> {
	const api = controlApi();
	if (!api) return "empty";
	let first: ControlSnapshot;
	try {
		const res = await api.getMessageControl({ sessionId });
		if (!res.ok) return res.error.code === "not_found" ? "empty" : "unavailable";
		first = res.value;
		useTranscriptStore.getState().setControlSnapshot(sessionId, first);
	} catch {
		return "unavailable";
	}
	const originalIds = first.items.map((item) => item.messageId);
	if (originalIds.length === 0) return "empty";
	try {
		if (!(await confirmPendingPayloads(originalIds.length))) return "cancelled";
	} catch {
		return "cancelled";
	}
	let confirmed: ControlSnapshot;
	try {
		const res = await api.getMessageControl({ sessionId });
		if (!res.ok) return res.error.code === "not_found" ? "empty" : "unavailable";
		confirmed = res.value;
		useTranscriptStore.getState().setControlSnapshot(sessionId, confirmed);
	} catch {
		return "unavailable";
	}
	if (
		confirmed.runtimeId !== first.runtimeId ||
		!sameIds(
			originalIds,
			confirmed.items.map((item) => item.messageId),
		)
	)
		return "changed";
	let revision = confirmed.revision;
	for (const messageId of originalIds) {
		try {
			const res = await api.changePendingMessage({
				sessionId,
				runtimeId: first.runtimeId,
				requestId: newRequestId(),
				messageId,
				expectedRevision: revision,
				action: "discard",
			});
			if (!res.ok) {
				if (res.error.snapshot) {
					useTranscriptStore.getState().setControlSnapshot(sessionId, res.error.snapshot);
					if (
						res.error.snapshot.runtimeId !== first.runtimeId ||
						!containsOnly(
							res.error.snapshot.items.map((item) => item.messageId),
							originalIds,
						)
					)
						return "changed";
					revision = res.error.snapshot.revision;
					continue;
				}
				return "unavailable";
			}
			useTranscriptStore.getState().setControlSnapshot(sessionId, res.value.snapshot);
			if (
				res.value.snapshot.runtimeId !== first.runtimeId ||
				!containsOnly(
					res.value.snapshot.items.map((item) => item.messageId),
					originalIds,
				)
			)
				return "changed";
			revision = res.value.snapshot.revision;
		} catch {
			return "unavailable";
		}
	}
	// 复核：中途新加入的项不在本次丢弃范围，绝不暗丢
	try {
		const res = await api.getMessageControl({ sessionId });
		if (!res.ok) return res.error.code === "not_found" ? "empty" : "unavailable";
		useTranscriptStore.getState().setControlSnapshot(sessionId, res.value);
		return res.value.runtimeId === first.runtimeId && res.value.items.length === 0 ? "ok" : "changed";
	} catch {
		return "unavailable";
	}
}

function sameIds(expected: readonly string[], actual: readonly string[]): boolean {
	return expected.length === actual.length && expected.every((id) => actual.includes(id));
}

function containsOnly(actual: readonly string[], allowed: readonly string[]): boolean {
	return actual.every((id) => allowed.includes(id));
}
