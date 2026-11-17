import type { ImageInput } from "@percho/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { AttachmentChip } from "./AttachmentChip";
import { ImageTray } from "./ImageTray";

/** 折叠态单行塞不下时的兜底上限（测量不可用的首帧/CSS 未就绪时用它先渲染）。 */
export const MAX_VISIBLE_CHIPS = 5;

type ComposerImage = ImageInput & { name?: string };

/**
 * 图片与文件共用上置托盘；折叠只裁剪渲染，不改写草稿及发送数组。
 *
 * 折叠规则（review 后修正）：
 * 1. **折叠态永远单行**——不再固定 5 枚，而是按容器实宽算出这一行能放下几枚，剩下的折成 `+N 项`。
 * 2. 全部能放下时（哪怕只有 1 枚被隐藏且塞得下）就直接平铺，不出折叠钮。
 * 3. 宽度靠一条不可见的测量行拿真实芯片宽度（渲染全部芯片、`shrink-0`、`nowrap`），
 *    测量行始终渲染全量，所以不会与"裁掉几枚"的渲染结果互相反馈震荡。
 */
export function AttachmentTray({
	draftKey,
	images,
	attachments,
	readOnly,
	onPreview,
	onRemoveImage,
	onRemoveAttachment,
}: {
	draftKey: string;
	images: ComposerImage[];
	attachments: string[];
	readOnly: boolean;
	onPreview: (image: ImageInput) => void;
	onRemoveImage: (index: number) => void;
	onRemoveAttachment: (index: number) => void;
}) {
	const t = useT();
	const measureRef = useRef<HTMLDivElement>(null);
	const [expanded, setExpanded] = useState(false);
	/** 折叠态这一行能放下的芯片数；null = 还没测量（按 MAX_VISIBLE_CHIPS 兜底） */
	const [fitCount, setFitCount] = useState<number | null>(null);
	const total = images.length + attachments.length;
	const collapsed = total > 0 && !expanded && fitCount !== null && fitCount < total;
	const visibleImages = collapsed ? images.slice(0, fitCount) : images;
	const rawVisibleAttachments = collapsed
		? Math.max(0, (fitCount ?? 0) - visibleImages.length)
		: attachments.length;
	const visibleAttachments = collapsed ? attachments.slice(0, rawVisibleAttachments) : attachments;

	// biome-ignore lint/correctness/useExhaustiveDependencies: draftKey 是重置信号，切换草稿即使附件数量相同也收起
	useEffect(() => {
		setExpanded(false);
	}, [draftKey]);

	useEffect(() => {
		if (total <= MAX_VISIBLE_CHIPS) setExpanded(false);
	}, [total]);

	// 测量：读全量芯片的自然宽度，算出折叠态这一行最多放几枚（含 `+N 项` 钮的宽度与间距）。
	// biome-ignore lint/correctness/useExhaustiveDependencies: images/attachments 变化才需要重新量宽
	useLayoutEffect(() => {
		const row = measureRef.current;
		if (!row) return;
		const compute = () => {
			const available = row.clientWidth;
			if (available <= 0) return;
			const widths = [...row.querySelectorAll<HTMLElement>("[data-measure-chip]")].map(
				(el) => el.offsetWidth,
			);
			if (widths.length === 0) return;
			const buttonWidth = row.querySelector<HTMLElement>("[data-measure-overflow]")?.offsetWidth ?? 0;
			const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
			const used = (count: number) =>
				widths.slice(0, count).reduce((sum, width) => sum + width, 0) + Math.max(0, count - 1) * gap;
			if (used(widths.length) <= available) {
				setFitCount(widths.length);
				return;
			}
			let count = widths.length - 1;
			while (count > 1 && used(count) + gap + buttonWidth > available) count -= 1;
			setFitCount(Math.max(1, count));
		};
		compute();
		const observer = new ResizeObserver(compute);
		observer.observe(row);
		return () => observer.disconnect();
	}, [images, attachments]);

	if (total === 0) return null;

	// 未测量完成（首帧）时按兜底上限先渲染，布局稳定后再收紧到实际宽度。
	const fallbackVisible = fitCount === null && total > MAX_VISIBLE_CHIPS && !expanded;
	const renderImages = fallbackVisible ? images.slice(0, MAX_VISIBLE_CHIPS) : visibleImages;
	const renderAttachments = fallbackVisible
		? attachments.slice(0, Math.max(0, MAX_VISIBLE_CHIPS - renderImages.length))
		: visibleAttachments;
	const hiddenCount = total - renderImages.length - renderAttachments.length;

	const chips = (all: boolean) => (
		<>
			<ImageTray
				images={all ? images : renderImages}
				readOnly={readOnly}
				onPreview={onPreview}
				onRemove={onRemoveImage}
			/>
			{(all ? attachments : renderAttachments).map((path, index) => (
				<AttachmentChip
					key={path}
					path={path}
					readOnly={readOnly}
					onRemove={() => onRemoveAttachment(index)}
				/>
			))}
		</>
	);

	return (
		<div className="relative pt-2">
			{/* 测量行：绝对定位 + 不可见 + 高度 0 + 裁剪，既不占位也不产生横向溢出；inert 隔离无障碍与焦点 */}
			<div
				ref={measureRef}
				aria-hidden
				inert
				className="pointer-events-none invisible absolute inset-x-3.5 top-2 flex h-0 items-center gap-1.5 overflow-hidden"
			>
				{chips(true)}
				<span data-measure-overflow className="h-5.5 shrink-0 rounded-lg px-1.5 text-ui-12">
					{t("composer.attachmentsExpandMore", { count: total })}
				</span>
			</div>
			<div
				className={`flex items-center gap-1.5 px-3.5 ${expanded ? "flex-wrap" : "flex-nowrap overflow-hidden"}`}
			>
				{chips(false)}
				{hiddenCount > 0 && (
					<button
						type="button"
						aria-expanded={false}
						onClick={() => setExpanded(true)}
						className="h-5.5 shrink-0 rounded-lg bg-hover px-1.5 text-ui-12 text-ink-2 transition-colors hover:text-ink"
					>
						{t("composer.attachmentsExpandMore", { count: hiddenCount })}
					</button>
				)}
				{expanded && total > 0 && (
					<button
						type="button"
						aria-expanded
						onClick={() => setExpanded(false)}
						className="h-5.5 shrink-0 rounded-lg bg-hover px-1.5 text-ui-12 text-ink-2 transition-colors hover:text-ink"
					>
						{t("composer.attachmentsCollapse")}
					</button>
				)}
			</div>
		</div>
	);
}
