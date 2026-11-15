import type { ControlSnapshot } from "@percho/shared";

/**
 * 压缩态发送策略（唯一真源）。
 *
 * 语义边界（后端 `submitMessage` 与 SDK 控制器的实测行为一致）：
 * - 手动压缩（`compactionKind: "manual"`）：SDK 对它的一切提交都回 `compacting`，前端必须提前拦住；
 * - 自动压缩（`compactionKind: "auto"`）：SDK 接受 queue/steer/interrupt 并排队到压缩结束后投递，
 *   只要控制通道完整可用就应放行——否则「运行中自动压缩」会把输入框变成只读，与真实能力不符；
 * - `kind` 未知 / 无快照 / 控制 API 不完整（legacy host）：无法证明可放行，一律保守拒绝，绝不猜 auto。
 *
 * 「可见压缩指示」与「是否禁发」是两件事：自动压缩放行时仍要显示压缩中（`compacting: true`），
 * 不能让状态行为了放行而撒谎。
 */
export interface CompactionSendPolicy {
	/** 是否处于压缩态（驱动占位符/状态行的可见指示） */
	compacting: boolean;
	/** 是否禁止发送（manual / kind 未知 / 无快照 / 控制通道不完整） */
	blocked: boolean;
	/** 是否允许 auto 压缩下的 queue/steer/interrupt */
	autoDispatch: boolean;
}

export interface CompactionSendInput {
	/** 发送时刻的会话事件态（`transcript.compacting`），不是渲染闭包里的旧值 */
	transcriptCompacting: boolean;
	/** 发送时刻的控制快照（无 = 未启用/未加载/legacy host） */
	control: Pick<ControlSnapshot, "phase" | "compactionKind"> | null;
	/** 控制 API 是否完整可用（submitMessage/getMessageControl/stop/change/recover 齐备） */
	controlReady: boolean;
}

const CLEAR: CompactionSendPolicy = { compacting: false, blocked: false, autoDispatch: false };

/** 解析当前压缩态是否拦发送（单规则，UI 指示与发送门禁共用） */
export function resolveCompactionSendPolicy(input: CompactionSendInput): CompactionSendPolicy {
	if (input.control?.phase === "compacting") {
		const allowed = input.controlReady && input.control.compactionKind === "auto";
		return { compacting: true, blocked: !allowed, autoDispatch: allowed };
	}
	// 快照不认为在压缩：没有 kind 可依据，只要事件态还说压缩中就保守拒绝。
	if (input.transcriptCompacting) return { compacting: true, blocked: true, autoDispatch: false };
	return CLEAR;
}
