import type { ImageInput } from "@percho/shared";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { imageSrc } from "../chat/ImagePreview";
import { CloseIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";

type ComposerImage = ImageInput & { name?: string };

function imagePresentation(image: ComposerImage, index: number): { name: string; suffix: string } {
	const fileName = image.name || `image-${index + 1}`;
	const dotIndex = fileName.lastIndexOf(".");
	if (dotIndex > 0) {
		return { name: fileName.slice(0, dotIndex), suffix: fileName.slice(dotIndex + 1).toUpperCase() };
	}
	const mimeType = image.mimeType.split("/")[1] ?? "";
	return { name: fileName, suffix: mimeType === "jpeg" ? "JPG" : mimeType.toUpperCase() };
}

/** 单枚图片芯片：缩略图可点预览，删除按钮 hover/focus 才浮现；名称被截断时才挂 Tooltip。 */
function ImageChip({
	image,
	index,
	readOnly,
	onPreview,
	onRemove,
}: {
	image: ComposerImage;
	index: number;
	readOnly: boolean;
	onPreview: (image: ImageInput) => void;
	onRemove: (index: number) => void;
}) {
	const t = useT();
	const nameRef = useRef<HTMLSpanElement>(null);
	const [truncated, setTruncated] = useState(false);
	const presentation = imagePresentation(image, index);
	const fullName = image.name || presentation.name;

	useEffect(() => {
		const el = nameRef.current;
		if (!el) return;
		const check = () => setTruncated(el.scrollWidth > el.clientWidth);
		check();
		const observer = new ResizeObserver(check);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	const chip = (
		<span className="group flex h-5.5 max-w-48 select-none items-center gap-1.5 rounded-lg bg-hover px-2 text-ui-12 text-ink-2">
			<button
				type="button"
				className="flex min-w-0 items-center gap-1.5 overflow-hidden text-left"
				aria-label={t("composer.previewImage")}
				onClick={() => onPreview(image)}
			>
				<img src={imageSrc(image)} alt="" className="size-4 shrink-0 rounded object-cover" />
				<span ref={nameRef} className="min-w-0 truncate">
					{presentation.name}
				</span>
				{presentation.suffix && (
					<span className="shrink-0 font-mono text-ui-105 text-ink-faint">{presentation.suffix}</span>
				)}
			</button>
			<Tooltip label={t("composer.removeImage")}>
				<button
					type="button"
					className="pointer-events-none flex size-4 shrink-0 items-center justify-center rounded text-ink-dim opacity-0 transition-opacity hover:text-ink focus-visible:outline-2 focus-visible:outline-ink-faint group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 disabled:hover:text-ink-dim"
					aria-label={t("composer.removeImage")}
					disabled={readOnly}
					onClick={() => onRemove(index)}
				>
					<CloseIcon size={9} />
				</button>
			</Tooltip>
		</span>
	);

	return truncated ? <Tooltip label={fullName}>{chip}</Tooltip> : chip;
}

/** 图片芯片由统一附件托盘排版；仅渲染传入子集，原图数据与预览行为不变。 */
export function ImageTray({
	images,
	readOnly = false,
	onPreview,
	onRemove,
}: {
	images: ComposerImage[];
	readOnly?: boolean;
	onPreview: (image: ImageInput) => void;
	onRemove: (index: number) => void;
}) {
	return images.map((image, index) => (
		<ImageChip
			// biome-ignore lint/suspicious/noArrayIndexKey: 图片列表无稳定 ID，删除时整列表替换
			key={index}
			image={image}
			index={index}
			readOnly={readOnly}
			onPreview={onPreview}
			onRemove={onRemove}
		/>
	));
}
