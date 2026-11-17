import { Fragment, useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { MessageAttachmentChip } from "./MessageAttachmentChip";
import { splitMessageReferences } from "./message-attachments";

/** 只裁剪正文的展示，不截断原文；自然高度独立于折叠状态，避免测量反馈循环。 */
export function UserMessageText({ text }: { text: string }) {
	const t = useT();
	const id = useId();
	const contentRef = useRef<HTMLDivElement>(null);
	const [overflowing, setOverflowing] = useState(false);
	const [expanded, setExpanded] = useState(false);

	useLayoutEffect(() => {
		const content = contentRef.current;
		if (!content) return;
		const measure = () => {
			const lineHeight = Number.parseFloat(getComputedStyle(content).lineHeight);
			const height = content.getBoundingClientRect().height;
			content.parentElement?.style.setProperty("--user-message-full-height", `${height}px`);
			setOverflowing(height > lineHeight * 6 + 1);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(content);
		return () => observer.disconnect();
	}, []);

	return (
		<>
			<div
				id={id}
				className="user-message-text"
				data-collapsed={overflowing && !expanded ? "true" : undefined}
			>
				<div ref={contentRef} className="whitespace-pre-wrap break-words">
					{splitMessageReferences(text).map((segment, index) =>
						segment.type === "text" ? (
							// biome-ignore lint/suspicious/noArrayIndexKey: 片段由同一段文本稳定派生，无独立 ID
							<Fragment key={index}>{segment.text}</Fragment>
						) : (
							// biome-ignore lint/suspicious/noArrayIndexKey: 同上；`@路径` 片段渲染为语义芯片
							<MessageAttachmentChip key={index} path={segment.path} />
						),
					)}
				</div>
			</div>
			{overflowing && (
				<button
					type="button"
					aria-expanded={expanded}
					aria-controls={id}
					onClick={() => setExpanded((value) => !value)}
					className="mt-1 px-1 py-0.5 text-ui-12 text-ink-faint hover:text-ink select-none"
				>
					{t(expanded ? "message.showLess" : "message.showMore")}
				</button>
			)}
		</>
	);
}
