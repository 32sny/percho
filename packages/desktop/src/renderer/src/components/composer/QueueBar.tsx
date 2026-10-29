import type { ControlledItem } from "@percho/shared";
import { type MessageKey, useT } from "../../i18n";
import { UndoIcon } from "../icons";

/** 队列项操作（changePendingMessage 的 action 与 recover 取回） */
export type QueueItemAction = "steer" | "interrupt" | "resend" | "discard" | "recover";

/**
 * 队列项可用操作（纯逻辑，便于单测）：
 * - queued：可改派（steer/interrupt）、取回编辑、明确放弃；已是 steer 的不重复给插话
 * - held（停止/打断后被冻结）：只能明确重发 / 取回 / 放弃，绝不自动继续、不再 steer
 * - recovering：允许再次取回（渲染器重载后本地草稿可能已丢失）；已有草稿由 recoverPending 拒绝覆盖
 */
export function queueItemActions(item: ControlledItem): QueueItemAction[] {
	if (item.state === "recovering") return ["recover"];
	if (item.state === "held") return ["resend", "recover", "discard"];
	return [...(item.mode === "steer" ? [] : (["steer"] as const)), "interrupt", "recover", "discard"];
}

const ACTION_LABEL: Record<QueueItemAction, MessageKey> = {
	steer: "composer.queueActionSteer",
	interrupt: "composer.queueActionInterrupt",
	resend: "composer.queueActionResend",
	recover: "composer.queueActionRecover",
	discard: "composer.queueActionDiscard",
};

const STATE_LABEL: Record<ControlledItem["state"], MessageKey> = {
	queued: "composer.queueStateQueued",
	held: "composer.queueStateHeld",
	recovering: "composer.queueStateRecovering",
};

interface QueueBarProps {
	/** 托管控制项（新路径）；与 legacyText 二选一 */
	items?: ControlledItem[];
	onAction?: (item: ControlledItem, action: QueueItemAction) => void;
	/** legacy 模式：首条 followUp 文本 + 取回（backend 控制未就绪时） */
	legacyText?: string;
	onRestore?: () => void;
}

/** 待发消息条：queued/held/recovering 三态展示与操作；legacy 单文本形态保持原行为 */
export function QueueBar({ items, onAction, legacyText, onRestore }: QueueBarProps) {
	const t = useT();
	if (items && items.length > 0) {
		return (
			<div className="mb-1.5 flex flex-col gap-1">
				{items.map((item) => (
					<div
						key={item.messageId}
						className="group/queue relative flex items-center gap-2 overflow-hidden rounded-xl bg-surface px-3 py-1.5 shadow-soft"
					>
						<span
							className={`shrink-0 text-ui-12 ${item.state === "held" ? "text-amber-500" : "text-ink-faint"}`}
						>
							{t(STATE_LABEL[item.state])}
						</span>
						<span className="min-w-0 flex-1 truncate text-ui-13 text-ink-2">{item.preview}</span>
						{item.imageCount > 0 && (
							<span className="shrink-0 text-ui-11 text-ink-faint">
								{t("composer.queueImages", { count: item.imageCount })}
							</span>
						)}
						{/* 操作层：hover 行才显示；渐变模糊压住下方文字（防误点） */}
						<div className="pointer-events-none absolute inset-y-0 right-0 flex items-center justify-end gap-2.5 pr-2.5 opacity-0 transition-opacity group-hover/queue:opacity-100">
							<span
								className="absolute inset-0 bg-gradient-to-l from-surface/60 to-transparent backdrop-blur-[3px] [mask-image:linear-gradient(to_left,black_45%,transparent)]"
								aria-hidden="true"
							/>
							{queueItemActions(item).map((action) => (
								<button
									key={action}
									type="button"
									className={`pointer-events-auto relative text-ui-12 transition-colors ${
										action === "discard"
											? "text-ink-faint hover:text-red-600"
											: "text-ink-faint hover:text-ink-2"
									}`}
									onClick={() => onAction?.(item, action)}
								>
									{t(ACTION_LABEL[action])}
								</button>
							))}
						</div>
					</div>
				))}
			</div>
		);
	}
	if (legacyText == null) return null;
	// legacy 形态：显示首条排队文本，hover 出现「取回」按钮（点掉后内容放回输入框继续编辑）
	return (
		<div className="group/queue relative mb-1.5 flex items-center gap-2 overflow-hidden rounded-xl bg-surface px-3 py-1.5 shadow-soft">
			<span className="shrink-0 text-ui-12 text-ink-faint">{t("composer.queueTitle")}</span>
			<span className="min-w-0 flex-1 truncate text-ui-13 text-ink-2">{legacyText}</span>
			<div className="pointer-events-none absolute inset-y-0 right-0 flex w-14 items-center justify-end pr-2.5 opacity-0 transition-opacity group-hover/queue:opacity-100">
				<span
					className="absolute inset-0 bg-gradient-to-l from-surface/60 to-transparent backdrop-blur-[3px] [mask-image:linear-gradient(to_left,black_45%,transparent)]"
					aria-hidden="true"
				/>
				<button
					type="button"
					className="pointer-events-auto relative flex items-center justify-center text-ink-faint transition-colors hover:text-ink-2"
					aria-label={t("composer.queueRestore")}
					onClick={onRestore}
				>
					<UndoIcon size={14} />
				</button>
			</div>
		</div>
	);
}
