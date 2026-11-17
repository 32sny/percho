import type { ImageInput } from "@percho/shared";
import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { AttachmentChip } from "./AttachmentChip";
import { ImageTray } from "./ImageTray";

export const MAX_VISIBLE_CHIPS = 5;

type ComposerImage = ImageInput & { name?: string };

/** 图片与文件共用上置托盘；折叠仅裁剪渲染，不改写草稿及发送数组。 */
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
	const [expanded, setExpanded] = useState(false);
	const total = images.length + attachments.length;
	const collapsed = total > MAX_VISIBLE_CHIPS && !expanded;
	const visibleImages = collapsed ? images.slice(0, MAX_VISIBLE_CHIPS) : images;
	const visibleAttachmentCount = collapsed
		? Math.max(0, MAX_VISIBLE_CHIPS - visibleImages.length)
		: attachments.length;
	const visibleAttachments = attachments.slice(0, visibleAttachmentCount);

	// biome-ignore lint/correctness/useExhaustiveDependencies: draftKey 是重置信号，切换草稿即使附件数量相同也收起
	useEffect(() => {
		setExpanded(false);
	}, [draftKey]);

	useEffect(() => {
		if (total <= MAX_VISIBLE_CHIPS) setExpanded(false);
	}, [total]);

	if (total === 0) return null;
	return (
		<div className="flex max-w-full flex-wrap items-center gap-1.5 px-3 pt-2">
			<ImageTray images={visibleImages} readOnly={readOnly} onPreview={onPreview} onRemove={onRemoveImage} />
			{visibleAttachments.map((path, index) => (
				<AttachmentChip
					key={path}
					path={path}
					readOnly={readOnly}
					onRemove={() => onRemoveAttachment(index)}
				/>
			))}
			{total > MAX_VISIBLE_CHIPS && (
				<button
					type="button"
					aria-expanded={expanded}
					onClick={() => setExpanded((value) => !value)}
					className="h-5.5 shrink-0 rounded-lg bg-hover px-2 text-ui-12 text-ink-2 transition-colors hover:text-ink"
				>
					{expanded
						? t("composer.attachmentsCollapse")
						: t("composer.attachmentsExpandMore", { count: total - MAX_VISIBLE_CHIPS })}
				</button>
			)}
		</div>
	);
}
