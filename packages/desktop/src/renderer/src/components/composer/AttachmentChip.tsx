import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { CloseIcon, FileCodeIcon, FileTextIcon, FolderIcon, MarkdownIcon, SessionChatIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";
import { attachmentPresentation } from "./attachment-presentation";

/** 原始 path 只作为草稿数据传入；展示与 Tooltip 均使用语义名称，不暴露机器路径。 */
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
		<span className="group flex h-5.5 max-w-48 select-none items-center gap-1.5 rounded-lg bg-hover px-2 text-ui-12 text-ink-2">
			<Icon size={13} className="shrink-0 text-ink-dim" />
			<span ref={nameRef} className="min-w-0 truncate">
				{presentation.name}
			</span>
			{suffix && <span className="shrink-0 font-mono text-ui-105 text-ink-faint">{suffix}</span>}
			<Tooltip label={t("composer.removeAttachment")}>
				<button
					type="button"
					aria-label={t("composer.removeAttachment")}
					disabled={readOnly}
					onClick={onRemove}
					className="pointer-events-none flex size-4 shrink-0 items-center justify-center rounded text-ink-dim opacity-0 transition-opacity hover:text-ink focus-visible:outline-2 focus-visible:outline-ink-faint group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 disabled:hover:text-ink-dim"
				>
					<CloseIcon size={9} />
				</button>
			</Tooltip>
		</span>
	);
	return truncated ? <Tooltip label={presentation.name}>{chip}</Tooltip> : chip;
}
