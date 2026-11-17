import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { CloseIcon, FileCodeIcon, FileTextIcon, FolderIcon, MarkdownIcon, SessionChatIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";
import { attachmentPresentation } from "./attachment-presentation";

/**
 * 紧凑柔灰芯片（设计稿 variant-b-compact）：高 22px（`h-5.5`）、内边距 `px-1.5`、`gap-1`、
 * 单颗最大 148px（`max-w-37`，37 × 4px，避免 Tailwind 任意值写法）。
 *
 * 删除按钮**不进流**：绝对定位成 16px 渐变遮罩压在尾缀位置上，常态 opacity-0 且不接收指针，
 * 所以未 hover 的芯片右侧不会留出占位造成的虚胖；hover / focus 时原位浮现替换尾缀。
 * 原始 path 只作草稿数据，展示与 Tooltip 都走语义名称，不暴露机器路径。
 */
export function AttachmentChip({
	path,
	readOnly = false,
	onRemove,
}: {
	path: string;
	readOnly?: boolean;
	onRemove: () => void;
}) {
	const t = useT();
	const nameRef = useRef<HTMLSpanElement>(null);
	const [truncated, setTruncated] = useState(false);
	const presentation = attachmentPresentation(path);

	useEffect(() => {
		const el = nameRef.current;
		if (!el) return;
		const check = () => setTruncated(el.scrollWidth > el.clientWidth);
		check();
		const observer = new ResizeObserver(check);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	const suffix = presentation.kind === "session" ? t("composer.attachmentSessionBadge") : presentation.suffix;
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
	const chip = (
		<span
			data-measure-chip
			className="group relative flex h-5.5 max-w-37 shrink-0 select-none items-center gap-1 rounded-lg bg-hover px-1.5 text-ui-12 text-ink-2"
		>
			<Icon size={12} className="shrink-0 text-ink-dim" />
			<span ref={nameRef} className="min-w-0 truncate">
				{presentation.name}
			</span>
			{suffix && (
				<span className="shrink-0 font-mono text-ui-105 text-ink-faint transition-opacity group-focus-within:opacity-0 group-hover:opacity-0">
					{suffix}
				</span>
			)}
			<ChipRemoveButton readOnly={readOnly} label={t("composer.removeAttachment")} onRemove={onRemove} />
		</span>
	);
	return truncated ? <Tooltip label={presentation.name}>{chip}</Tooltip> : chip;
}

/** 芯片删除钮：渐变遮罩压在尾缀上，常态零占位、hover/focus 浮现（图片芯片同款）。 */
export function ChipRemoveButton({
	readOnly,
	label,
	onRemove,
}: {
	readOnly: boolean;
	label: string;
	onRemove: () => void;
}) {
	return (
		<span className="pointer-events-none absolute inset-y-0 right-0 flex w-5 items-center justify-end rounded-r-lg bg-gradient-to-l from-hover to-transparent pr-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
			<Tooltip label={label} align="end">
				<button
					type="button"
					aria-label={label}
					disabled={readOnly}
					onClick={onRemove}
					className="flex size-4 items-center justify-center rounded text-ink-dim transition-colors hover:text-ink disabled:hover:text-ink-dim"
				>
					<CloseIcon size={9} />
				</button>
			</Tooltip>
		</span>
	);
}
