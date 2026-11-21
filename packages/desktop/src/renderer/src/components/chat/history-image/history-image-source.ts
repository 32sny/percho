/**
 * 历史图片的**来源契约**：内联 base64（live 与已加载的历史页）或引用（分页回放只给 id）。
 *
 * 为什么单独一个叶子模块：资源层（service）与组件层都要认这两种来源，而引用图取原图只能走
 * IPC（`getSessionHistoryImage`）。放进组件会把「资源」和「React」搅在一起，放进 service 又会
 * 让资源层依赖渲染层；所以这里只放类型、纯函数与**唯一**的取图入口。
 *
 * 硬纪律：
 * 1. 引用图**不得**在渲染期取图：只有资源层真正派发（且可见）时才调用 `loadHistoryImage`；
 * 2. 取图结果只活到 `postMessage` 那一帧（structured clone 已经复制），服务不长期持有 base64；
 * 3. 缺失 / 失败一律 `null`，由组件走既有 i18n 失败占位，绝不把异常抛给渲染层。
 */
import type { ImageInput, PiApi } from "@percho/shared";
import { getPi } from "../../../api";

/**
 * 历史消息里的图片引用（分页回放用；本地声明与 shared 导出同构）。
 *
 * `generation` 归属一次 backend 历史窗口快照：换窗口即换引用，旧引用取不到也不会串图。
 * shared 的 `HistoryImageRef` 落地后本类型可原地改成 re-export，调用方不用动。
 */
export interface HistoryImageRef {
	sessionId: string;
	generation: string;
	imageId: string;
	mimeType: string;
}

/** 列表 / 预览里一张图的来源：内联（有 data）或引用（有 imageId） */
export type HistoryImageSource = ImageInput | HistoryImageRef;

/** 稳定去重键：同一张图跨组件、跨多次 acquire 共享一次解码与一个 Blob URL */
export function historyImageRefKey(ref: HistoryImageRef): string {
	return `${ref.sessionId}\u0000${ref.generation}\u0000${ref.imageId}\u0000${ref.mimeType}`;
}

export function isHistoryImageRef(source: HistoryImageSource): source is HistoryImageRef {
	return typeof (source as HistoryImageRef).imageId === "string";
}

/**
 * 消息上的图片列表：内联优先，其次引用（分页回放时 `images` 为空、只有 `historyImageRefs`）。
 * 单个消息的图片要么全部内联、要么全部是引用，所以不做交错合并。
 */
export function messageImageSources(message: {
	images: ImageInput[];
	historyImageRefs?: HistoryImageRef[];
}): HistoryImageSource[] {
	return message.images.length > 0 ? message.images : (message.historyImageRefs ?? []);
}

/** `getSessionHistoryImage` 由 shared/preload 一侧提供；未接线时按缺失处理（fail-closed） */
type HistoryImageApi = {
	getSessionHistoryImage?: (ref: HistoryImageRef) => Promise<ImageInput | null>;
};

/** 取一张引用图的原图；缺失 / 失败一律 null（UI 走既有失败占位与重试） */
export async function loadHistoryImage(ref: HistoryImageRef): Promise<ImageInput | null> {
	try {
		const api = getPi() as PiApi & HistoryImageApi;
		if (typeof api.getSessionHistoryImage !== "function") return null;
		const image = await api.getSessionHistoryImage(ref);
		if (!image || typeof image.data !== "string" || typeof image.mimeType !== "string") return null;
		return image;
	} catch {
		return null;
	}
}
