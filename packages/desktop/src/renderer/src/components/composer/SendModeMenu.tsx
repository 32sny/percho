import type { MessageMode } from "@percho/shared";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type MessageKey, useT } from "../../i18n";
import { anchorOfElement, placeMenu } from "../ui/place-menu";

export type SendModePick = Exclude<MessageMode, "queue">;

/** 一次性发送模式，不记偏好；Esc / 点外部只关菜单，不取消任务。 */
export function SendModeMenu({
	anchorRef,
	disabledReason,
	onPick,
	onClose,
}: {
	/** 发送组合整体为锚点（浮层上方右对齐），触发按钮用于键盘焦点归还。 */
	anchorRef?: RefObject<HTMLDivElement | null>;
	disabledReason: MessageKey | null;
	onPick: (mode: SendModePick) => void;
	onClose: () => void;
}) {
	const t = useT();
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

	useLayoutEffect(() => {
		const el = ref.current;
		const anchor = anchorRef?.current;
		if (!el || !anchor) return;
		const { width, height } = el.getBoundingClientRect();
		const rect = anchorOfElement(anchor);
		// placeMenu 从一个上移的锚点向下排布，即得到上方右对齐且视口夹紧的位置。
		setPos(
			placeMenu(
				{ left: rect.left + rect.width - width, top: rect.top - height - 8, width, height: 0 },
				{ width, height },
				{ width: window.innerWidth, height: window.innerHeight },
				{ gap: 0 },
			),
		);
	}, [anchorRef]);

	useLayoutEffect(() => {
		// 定位后 visibility 才变为 visible；隐藏阶段 focus 会被浏览器忽略。
		if (!pos) return;
		const el = ref.current;
		el?.focus({ preventScroll: true });
		if (!disabledReason) {
			el?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
		}
	}, [pos, disabledReason]);

	useEffect(() => {
		const restoreFocus = () =>
			anchorRef?.current
				?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
				?.focus({ preventScroll: true });
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				restoreFocus();
				onClose();
				return;
			}
			const items = Array.from(
				ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
			);
			if (e.key === "Tab") {
				restoreFocus();
				onClose();
				return;
			}
			if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
			e.preventDefault();
			e.stopPropagation();
			if (!items.length) return;
			const current = items.indexOf(document.activeElement as HTMLButtonElement);
			const index =
				e.key === "Home"
					? 0
					: e.key === "End"
						? items.length - 1
						: e.key === "ArrowDown"
							? (current + 1) % items.length
							: (current - 1 + items.length) % items.length;
			items[index]?.focus({ preventScroll: true });
		};
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (ref.current?.contains(target)) return;
			// 点击触发按钮让它自身切换开关，避免捕获阶段关闭后 click 又打开。
			const trigger = anchorRef?.current?.querySelector('[aria-haspopup="menu"]');
			if (!trigger?.contains(target)) onClose();
		};
		const onScroll = (e: Event) => {
			if (!ref.current?.contains(e.target as Node)) onClose();
		};
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("resize", onClose);
		window.addEventListener("scroll", onScroll, true);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("resize", onClose);
			window.removeEventListener("scroll", onScroll, true);
		};
	}, [anchorRef, onClose]);

	const modes: { mode: SendModePick; label: string; desc: string }[] = [
		{ mode: "steer", label: t("composer.modeSteer"), desc: t("composer.modeSteerDesc") },
		{ mode: "interrupt", label: t("composer.modeInterrupt"), desc: t("composer.modeInterruptDesc") },
	];
	const menu = (
		<div
			ref={ref}
			role="menu"
			tabIndex={-1}
			aria-label={t("composer.modeMenuTitle")}
			className="fixed z-50 max-h-[calc(100vh-12px)] w-64 max-w-[calc(100vw-12px)] overflow-y-auto rounded-xl bg-surface p-1 shadow-pop"
			style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: anchorRef && !pos ? "hidden" : "visible" }}
		>
			{modes.map(({ mode, label, desc }) => (
				<button
					key={mode}
					type="button"
					role="menuitem"
					aria-disabled={disabledReason != null}
					disabled={disabledReason != null}
					className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-faint disabled:opacity-45 disabled:hover:bg-transparent"
					onClick={() => {
						if (disabledReason != null) return;
						anchorRef?.current
							?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
							?.focus({ preventScroll: true });
						onClose();
						onPick(mode);
					}}
				>
					<span className="text-ui-13 text-ink">{label}</span>
					<span className="text-ui-11 leading-relaxed text-ink-faint">{desc}</span>
				</button>
			))}
			{disabledReason && (
				<p className="px-3 pt-1 pb-1.5 text-ui-11 leading-relaxed text-warn">{t(disabledReason)}</p>
			)}
		</div>
	);
	return anchorRef ? createPortal(menu, document.body) : menu;
}
