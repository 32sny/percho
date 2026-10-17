import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { CloseIcon, FileTextIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";

function fileNameOf(path: string): string {
	return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || path;
}

/**
 * 文件附件胶囊：只展示文件图标和文件名，完整原始路径保留在 title/Tooltip 中。
 * 发送时仍由父级使用原始 path 组装 @ 引用，不改变协议；删除也不再把长路径写回输入框。
 */
export function AttachmentChip({ path, onRemove }: { path: string; onRemove: () => void }) {
	const t = useT();
	const nameRef = useRef<HTMLSpanElement>(null);
	const [truncated, setTruncated] = useState(false);
	const name = fileNameOf(path);

	useEffect(() => {
		const el = nameRef.current;
		if (!el) return;
		const check = () => setTruncated(el.scrollWidth > el.clientWidth);
		check();
		const ro = new ResizeObserver(check);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const chip = (
		<span
			className="mt-0.5 flex max-w-[190px] select-none items-center gap-1.5 rounded-md bg-surface px-2 py-0.5 text-ui-12 leading-5 text-ink-2 shadow-pop"
			title={path}
		>
			<FileTextIcon size={13} className="shrink-0 text-ink-dim" />
			<span ref={nameRef} className="min-w-0 truncate">
				{name}
			</span>
			<button
				type="button"
				aria-label={t("composer.removeAttachment")}
				onClick={onRemove}
				className="shrink-0 text-ink-dim transition-colors hover:text-ink"
			>
				<CloseIcon size={9} />
			</button>
		</span>
	);
	return truncated ? <Tooltip label={path}>{chip}</Tooltip> : chip;
}
