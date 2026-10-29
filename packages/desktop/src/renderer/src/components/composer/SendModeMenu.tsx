import type { MessageMode } from "@percho/shared";
import { useEffect, useRef } from "react";
import { type MessageKey, useT } from "../../i18n";

export type SendModePick = Exclude<MessageMode, "queue">;

/**
 * 发送模式菜单（一次性选择）：运行中对非空草稿提供「优先插话 / 打断并发送」。
 * - 不改变 Enter 默认行为（恒为 queue），不记任何默认偏好；
 * - Esc / 点外部只关菜单，不绑定取消；
 * - readOnly / 手动压缩 / slash 命令时整体禁用并给出可解释原因（由调用方计算传入）。
 */
export function SendModeMenu({
	disabledReason,
	onPick,
	onClose,
}: {
	/** i18n key；非 null 时菜单项禁用并展示原因 */
	disabledReason: MessageKey | null;
	onPick: (mode: SendModePick) => void;
	onClose: () => void;
}) {
	const t = useT();
	const ref = useRef<HTMLDivElement>(null);

	// Esc / 点外部只关闭菜单（绝不触发取消/停止，Esc 不绑定取消语义）
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			}
		};
		const onPointerDown = (e: PointerEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) onClose();
		};
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("pointerdown", onPointerDown, true);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("pointerdown", onPointerDown, true);
		};
	}, [onClose]);

	const modes: { mode: SendModePick; label: string; desc: string }[] = [
		{ mode: "steer", label: t("composer.modeSteer"), desc: t("composer.modeSteerDesc") },
		{ mode: "interrupt", label: t("composer.modeInterrupt"), desc: t("composer.modeInterruptDesc") },
	];

	return (
		<div
			ref={ref}
			role="menu"
			aria-label={t("composer.modeMenuTitle")}
			className="absolute right-0 bottom-full mb-2 w-64 rounded-2xl border-[0.5px] border-border bg-surface p-1.5 shadow-dialog"
		>
			{modes.map(({ mode, label, desc }) => (
				<button
					key={mode}
					type="button"
					role="menuitem"
					aria-disabled={disabledReason != null}
					disabled={disabledReason != null}
					className="flex w-full flex-col gap-0.5 rounded-xl px-3 py-2 text-left transition-colors hover:bg-hover disabled:opacity-45 disabled:hover:bg-transparent"
					onClick={() => {
						if (disabledReason != null) return;
						onPick(mode);
						onClose();
					}}
				>
					<span className="text-ui-13 text-ink">{label}</span>
					<span className="text-ui-11 leading-relaxed text-ink-faint">{desc}</span>
				</button>
			))}
			{disabledReason && (
				<p className="px-3 pt-1 pb-1.5 text-ui-11 leading-relaxed text-amber-500">{t(disabledReason)}</p>
			)}
		</div>
	);
}
