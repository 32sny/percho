import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { errText } from "../../lib/error-text";
import { useProjectsStore } from "../../stores/projects";
import { useToastsStore } from "../../stores/toasts";
import { attachmentPresentation } from "../composer/attachment-presentation";
import { CopyIcon, FileCodeIcon, FileTextIcon, FolderIcon, MarkdownIcon, SessionChatIcon } from "../icons";
import { anchorOfElement, placeMenu } from "../ui/place-menu";

type Action = "session" | "open" | "copy" | "reveal";

/**
 * 已发送气泡里的 `@路径` 芯片：`@ + 类型 glyph + 语义名 + 类型尾缀`，不显示机器路径。
 *
 * **左键单击即执行主操作**：会话芯片 → 打开所在会话（走 `projects.openSession`，前端同步切激活态）；
 * 文件/目录芯片 → 系统默认应用打开。
 * **悬停/聚焦**才浮出次要操作卡（无标题头、无分隔线——芯片自己已经显示名字；只有名字被截断时
 * 补一行完整名）。菜单项规格与 `components/ui/ContextMenu.tsx` 同源：13px 图标 + 30px 行高 +
 * `gap-[10px] rounded-[7px] px-2 text-ui-13`，不允许裸文字列表。
 */
export function MessageAttachmentChip({ path }: { path: string }) {
	const t = useT();
	const presentation = attachmentPresentation(path);
	const isSession = presentation.kind === "session";
	const anchorRef = useRef<HTMLButtonElement>(null);
	const nameRef = useRef<HTMLSpanElement>(null);
	const cardRef = useRef<HTMLDivElement>(null);
	const hideTimer = useRef<number | null>(null);
	/** 卡片首帧用估宽定位，挂载后按真实尺寸校正一次；用 ref 防止 setPos 自触发死循环 */
	const reflowed = useRef(false);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
	const [truncated, setTruncated] = useState(false);

	useEffect(() => {
		const el = nameRef.current;
		if (!el) return;
		const check = () => setTruncated(el.scrollWidth > el.clientWidth);
		check();
		const observer = new ResizeObserver(check);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	const Icon = isSession
		? SessionChatIcon
		: presentation.kind === "folder"
			? FolderIcon
			: presentation.kind === "markdown"
				? MarkdownIcon
				: presentation.kind === "code"
					? FileCodeIcon
					: FileTextIcon;
	const badge = isSession ? t("composer.attachmentSessionBadge") : presentation.suffix;

	const place = useCallback(() => {
		const el = anchorRef.current;
		if (!el) return;
		const card = cardRef.current;
		const size = card ? { width: card.offsetWidth, height: card.offsetHeight } : { width: 176, height: 96 };
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

	// 浮层渲染后再按真实尺寸夹一次位置（首帧用估宽）
	useEffect(() => {
		if (!pos || reflowed.current) return;
		reflowed.current = true;
		place();
	}, [pos, place]);

	/** 打开所在会话：必须走前端 store，否则只唤了后端、界面不切换（旧实现只调 IPC，点击像没反应）。 */
	const openSessionOf = async () => {
		// 转录文件名尾部的 8 位 id = sessionId 前缀
		const suffix = /-([0-9a-f]{8})\.md$/i.exec(path.replace(/^.*[/\\]/, ""))?.[1];
		const sessions = await getPi().listAllSessions();
		const session = suffix
			? sessions.find((item) => item.sessionId.toLowerCase().startsWith(suffix.toLowerCase()))
			: undefined;
		if (!session) {
			useToastsStore.getState().push("error", "message.openSessionFailed");
			return;
		}
		await useProjectsStore.getState().openSession(session);
	};

	const run = async (action: Action) => {
		setPos(null);
		try {
			if (action === "session") {
				await openSessionOf();
				return;
			}
			if (action === "copy") {
				const resolved = await getPi().resolvePath({ target: path, cwd: null });
				await navigator.clipboard.writeText(resolved);
				useToastsStore.getState().push("info", "toast.pathCopied", resolved);
				return;
			}
			if (action === "reveal") {
				await getPi().revealPath({ target: path, cwd: null });
				return;
			}
			await getPi().openPath({ target: path, cwd: null });
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

	// 会话本质不是本地文件：不给「在访达中显示」（只会指向 Temp 目录），只留会话/转录/复制
	const actions: Array<{ key: Action; label: string; icon: React.ReactNode }> = isSession
		? [
				{ key: "session", label: t("message.openSession"), icon: <SessionChatIcon size={13} /> },
				{ key: "open", label: t("message.viewTranscript"), icon: <FileTextIcon size={13} /> },
				{ key: "copy", label: t("pathMenu.copyPath"), icon: <CopyIcon size={13} /> },
			]
		: [
				{ key: "reveal", label: t("pathMenu.reveal"), icon: <FolderIcon size={13} /> },
				{ key: "copy", label: t("pathMenu.copyPath"), icon: <CopyIcon size={13} /> },
			];

	return (
		<>
			<button
				ref={anchorRef}
				type="button"
				onClick={() => void run(isSession ? "session" : "open")}
				onMouseEnter={show}
				onMouseLeave={hideSoon}
				onFocus={show}
				onBlur={hideSoon}
				className="mx-0.5 inline-flex h-5.5 max-w-56 shrink-0 select-none items-center gap-1 rounded-md bg-hover px-1.5 align-middle text-ui-12 text-ink-2 transition-colors hover:text-ink"
			>
				<span className="text-ink-faint">@</span>
				<Icon size={12} className="shrink-0 text-ink-dim" />
				<span ref={nameRef} className="min-w-0 truncate">
					{presentation.name}
				</span>
				{badge && <span className="shrink-0 font-mono text-ui-105 text-ink-faint">{badge}</span>}
			</button>
			{pos &&
				createPortal(
					<div
						ref={cardRef}
						role="menu"
						aria-label={presentation.name}
						onMouseEnter={show}
						onMouseLeave={hideSoon}
						style={{ left: pos.x, top: pos.y }}
						className="pop-in no-drag fixed z-50 w-44 rounded-xl border border-border bg-surface p-1 shadow-pop"
					>
						{/* 名字没被截断就不重复展示；截断了才补一行完整名（不搞标题+副标题两行大头部） */}
						{truncated && (
							<div className="px-2 pt-1 pb-1.5 text-ui-11 break-words text-ink-faint">
								{presentation.name}
							</div>
						)}
						{actions.map((action) => (
							<button
								key={action.key}
								type="button"
								role="menuitem"
								onClick={() => void run(action.key)}
								className="group/item flex h-[30px] w-full items-center gap-[10px] rounded-[7px] px-2 text-left text-ui-13 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
							>
								<span className="flex shrink-0 text-ink-dim transition-colors group-hover/item:text-ink">
									{action.icon}
								</span>
								<span className="truncate">{action.label}</span>
							</button>
						))}
					</div>,
					document.body,
				)}
		</>
	);
}
