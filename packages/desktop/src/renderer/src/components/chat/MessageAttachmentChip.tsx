import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { errText } from "../../lib/error-text";
import { useToastsStore } from "../../stores/toasts";
import { attachmentPresentation } from "../composer/attachment-presentation";
import { FileCodeIcon, FileTextIcon, FolderIcon, MarkdownIcon, SessionChatIcon } from "../icons";
import { anchorOfElement, placeMenu } from "../ui/place-menu";

/**
 * 已发送气泡里的 `@路径` 芯片：展示 `@ + 类型 glyph + 语义名 + 类型尾缀`，不显示机器路径。
 * hover / focus 浮出操作卡（查看 / 复制路径 / 在文件夹中显示，会话另有「打开所在会话」）。
 * 浮层走 portal + placeMenu（夹进视口），避免被 `.edge-fade` 的 mask 裁切。
 */
export function MessageAttachmentChip({ path }: { path: string }) {
	const t = useT();
	const presentation = attachmentPresentation(path);
	const anchorRef = useRef<HTMLButtonElement>(null);
	const cardRef = useRef<HTMLDivElement>(null);
	const hideTimer = useRef<number | null>(null);
	/** 卡片首帧用估宽定位，挂载后按真实尺寸校正一次；用 ref 防止 setPos 自触发死循环 */
	const reflowed = useRef(false);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

	const Icon =
		presentation.kind === "session"
			? SessionChatIcon
			: presentation.kind === "folder"
				? FolderIcon
				: presentation.kind === "markdown"
					? MarkdownIcon
					: presentation.kind === "code"
						? FileCodeIcon
						: FileTextIcon;
	const badge = presentation.kind === "session" ? t("composer.attachmentSessionBadge") : presentation.suffix;

	const place = useCallback(() => {
		const el = anchorRef.current;
		if (!el) return;
		const card = cardRef.current;
		const size = card ? { width: card.offsetWidth, height: card.offsetHeight } : { width: 208, height: 132 };
		setPos(
			placeMenu(
				anchorOfElement(el),
				size,
				{ width: window.innerWidth, height: window.innerHeight },
				{ gap: 6 },
			),
		);
	}, []);

	const show = () => {
		if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
		hideTimer.current = null;
		place();
	};
	const hideSoon = () => {
		if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
		hideTimer.current = window.setTimeout(() => {
			reflowed.current = false;
			setPos(null);
		}, 120);
	};

	useEffect(
		() => () => {
			if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
		},
		[],
	);

	// 浮层渲染后再按真实尺寸夹一次位置（首帧用估宽，卡片宽度随标题变化）
	useEffect(() => {
		if (!pos || reflowed.current) return;
		reflowed.current = true;
		place();
	}, [pos, place]);

	const run = async (action: "open" | "reveal" | "copy" | "session") => {
		setPos(null);
		try {
			if (action === "copy") {
				const resolved = await getPi().resolvePath({ target: path, cwd: null });
				await navigator.clipboard.writeText(resolved);
				useToastsStore.getState().push("info", "toast.pathCopied", resolved);
				return;
			}
			if (action === "open") {
				await getPi().openPath({ target: path, cwd: null });
				return;
			}
			if (action === "reveal") {
				await getPi().revealPath({ target: path, cwd: null });
				return;
			}
			// 打开所在会话：转录文件名尾部的 8 位 id = 会话 sessionId 前缀
			const suffix = /-([0-9a-f]{8})\.md$/i.exec(path.replace(/^.*[/\\]/, ""))?.[1];
			const sessions = await getPi().listAllSessions();
			const session = suffix
				? sessions.find((item) => item.sessionId.toLowerCase().startsWith(suffix.toLowerCase()))
				: undefined;
			if (!session?.sessionFile) {
				useToastsStore.getState().push("error", "message.openSessionFailed");
				return;
			}
			await getPi().openSession({ filePath: session.sessionFile });
		} catch (error) {
			console.error("引用附件操作失败", { action, path, error });
			const key =
				action === "copy"
					? "toast.pathCopyFailed"
					: action === "reveal"
						? "toast.pathRevealFailed"
						: action === "session"
							? "message.openSessionFailed"
							: "toast.pathOpenFailed";
			useToastsStore.getState().push("error", key, errText(error));
		}
	};

	const actions: Array<{ key: "open" | "reveal" | "copy" | "session"; label: string }> = [
		{ key: "open", label: t("pathMenu.open") },
		...(presentation.kind === "session"
			? [{ key: "session" as const, label: t("message.openSession") }]
			: []),
		{ key: "copy", label: t("pathMenu.copyPath") },
		{ key: "reveal", label: t("pathMenu.reveal") },
	];

	return (
		<>
			<button
				ref={anchorRef}
				type="button"
				onMouseEnter={show}
				onMouseLeave={hideSoon}
				onFocus={show}
				onBlur={hideSoon}
				className="mx-0.5 inline-flex h-5.5 max-w-56 shrink-0 select-none items-center gap-1 rounded-md bg-hover px-1.5 align-middle text-ui-12 text-ink-2 transition-colors hover:text-ink"
			>
				<span className="text-ink-faint">@</span>
				<Icon size={12} className="shrink-0 text-ink-dim" />
				<span className="min-w-0 truncate">{presentation.name}</span>
				{badge && <span className="shrink-0 font-mono text-ui-105 text-ink-faint">{badge}</span>}
			</button>
			{pos &&
				createPortal(
					<div
						ref={cardRef}
						role="dialog"
						aria-label={presentation.name}
						onMouseEnter={show}
						onMouseLeave={hideSoon}
						style={{ left: pos.x, top: pos.y }}
						className="pop-in fixed z-50 w-52 rounded-xl bg-surface p-1 shadow-pop"
					>
						<div className="px-2 pt-1 pb-1.5">
							<div className="truncate text-ui-12 font-medium text-ink">{presentation.name}</div>
							<div className="mt-0.5 text-ui-11 text-ink-faint">
								{badge || t("composer.attachmentSessionBadge")}
							</div>
						</div>
						<div className="fade-rule mx-1.5 my-1" />
						{actions.map((action) => (
							<button
								key={action.key}
								type="button"
								onClick={() => void run(action.key)}
								className="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-ui-12 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
							>
								{action.label}
							</button>
						))}
					</div>,
					document.body,
				)}
		</>
	);
}
