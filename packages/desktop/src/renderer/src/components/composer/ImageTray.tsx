import type { ImageInput } from "@percho/shared";
import { useT } from "../../i18n";
import { CloseIcon, ImageIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";

type ComposerImage = ImageInput & { name?: string };

function imageNameOf(image: ComposerImage, index: number): string {
	return image.name || `image-${index + 1}`;
}

/**
 * 待发送图片附件条：使用与文件胶囊一致的紧凑标签，点击缩略图打开预览。
 * 预览仍保留在输入栏上方，标签显示文件名而不是 base64 或完整路径。
 */
export function ImageTray({
	images,
	onPreview,
	onRemove,
}: {
	images: ComposerImage[];
	onPreview: (image: ImageInput) => void;
	onRemove: (index: number) => void;
}) {
	const t = useT();
	if (images.length === 0) return null;
	return (
		<div className="flex max-w-full flex-wrap items-center gap-1.5 px-3 pt-2">
			{images.map((image, index) => {
				const name = imageNameOf(image, index);
				return (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: 图片列表无稳定 ID，删除时整列表替换
						key={index}
						className="flex max-w-[190px] items-center gap-1.5 rounded-md bg-surface px-2 py-0.5 text-ui-12 leading-5 text-ink-2 shadow-pop"
					>
						<button
							type="button"
							className="flex min-w-0 items-center gap-1.5 truncate text-left"
							title={name}
							onClick={() => onPreview(image)}
						>
							<ImageIcon size={13} className="shrink-0 text-ink-dim" />
							<span className="truncate">{name}</span>
						</button>
						<Tooltip label={t("composer.removeImage")}>
							<button
								type="button"
								className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-dim transition-colors hover:bg-hover hover:text-ink"
								aria-label={t("composer.removeImage")}
								onClick={() => onRemove(index)}
							>
								<CloseIcon size={9} />
							</button>
						</Tooltip>
					</div>
				);
			})}
		</div>
	);
}
