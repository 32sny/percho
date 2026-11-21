import type { ImageInput } from "@percho/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import {
	type HistoryImageRef,
	type HistoryImageSource,
	historyImageRefKey,
	isHistoryImageRef,
	loadHistoryImage,
} from "./history-image/history-image-source";

export function imageSrc(image: ImageInput): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

/** 预览图来源：内联（Composer / 插件 / 已加载页）或引用（分页回放只给 id） */
export type PreviewImageSource = HistoryImageSource;

/**
 * 引用图解析队列：**只认最后一次请求**。
 *
 * 关图 / 切图 / 方向键都会 `cancel()` 掉上一次，迟到的结果连 `apply` 都不会调用，
 * 所以旧图不可能盖到新图上；同时预览只持有「当前这一张」的原图，切走即释放。
 */
export function createPreviewImageResolveQueue(
	load: (ref: HistoryImageRef) => Promise<ImageInput | null> = loadHistoryImage,
) {
	let token = 0;
	return {
		async run(ref: HistoryImageRef, apply: (src: string | null) => void): Promise<void> {
			const mine = ++token;
			let image: ImageInput | null = null;
			try {
				image = await load(ref);
			} catch {
				image = null;
			}
			if (mine !== token) return;
			apply(image ? imageSrc(image) : null);
		},
		cancel(): void {
			token += 1;
		},
	};
}

/** 已解析的引用图：`src === null` 表示这一张取不到（缺失/失败） */
type RemotePreview = { key: string; src: string | null } | null;

/**
 * 全屏图片预览遮罩：点击任意处关闭（用户消息图片与 show_image 图片消息共用）。
 * 多图支持 ←/→ 切换、Esc 关闭，右上角显示 n / total。
 *
 * 来源两种（分页回放只有引用）：内联图直接用 data URL；引用图**只为当前索引**取一次原图，
 * 切走即丢，不预取相邻图——这不是缩略图链路，不走缩略图预算。
 *
 * Portal 到 body：预览若挂在滚动容器（relative z-10，自成 stacking context）内，
 * fixed z-50 逃不出该 context，「回到底部」按钮（同级 z-10、DOM 靠后）会盖住预览图；
 * body 层 z-50 位于根 stacking context，遮罩永远全局顶层。
 */
export function ImagePreviewOverlay({
	image,
	images,
	initialIndex = 0,
	onClose,
}: {
	/** 单图调用（Composer / UI 插件）用 image；多图传 images */
	image?: PreviewImageSource;
	images?: PreviewImageSource[];
	initialIndex?: number;
	onClose: () => void;
}) {
	const list = images ?? (image ? [image] : []);
	const count = list.length;
	const [index, setIndex] = useState(() => Math.min(initialIndex, count - 1));
	// onClose 多为内联箭头（每次渲染新引用）：存 ref，keydown 监听不随父组件重渲染重挂
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const current = list[index];
	const remoteKey = current && isHistoryImageRef(current) ? historyImageRefKey(current) : null;
	const [remote, setRemote] = useState<RemotePreview>(null);
	const queueRef = useRef<ReturnType<typeof createPreviewImageResolveQueue> | null>(null);
	if (!queueRef.current) queueRef.current = createPreviewImageResolveQueue();

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			// 焦点可能仍在 Composer 输入框：拦下默认行为，避免 ←/→ 同时移动输入光标
			if (e.key === "Escape") {
				e.preventDefault();
				onCloseRef.current();
			} else if (e.key === "ArrowLeft") {
				e.preventDefault();
				setIndex((i) => Math.max(0, i - 1));
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				setIndex((i) => Math.min(count - 1, i + 1));
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [count]);

	// 只为当前这一张引用图取原图；换图先放掉上一张（清理函数还会作废在途结果）
	useEffect(() => {
		const resolver = queueRef.current;
		setRemote(null);
		if (!resolver || !current || !isHistoryImageRef(current)) return;
		const key = historyImageRefKey(current);
		void resolver.run(current, (src) => setRemote({ key, src }));
		return () => resolver.cancel();
	}, [current]);

	if (count === 0) return null;
	if (!current) return null;

	const remoteReady = remoteKey !== null && remote?.key === remoteKey ? remote : null;
	const src = isHistoryImageRef(current) ? (remoteReady ? remoteReady.src : null) : imageSrc(current);
	const failed = remoteReady !== null && remoteReady.src === null;

	return createPortal(
		<ImagePreviewSurface src={src} failed={failed} count={count} index={index} onClose={onClose} />,
		document.body,
	);
}

/** 纯展示层（无服务/无 IPC）：遮罩 + 原图 + 计数；引用图占位沿用计数器胶囊的样式 */
export function ImagePreviewSurface({
	src,
	failed,
	count,
	index,
	onClose,
}: {
	/** 已就绪的原图 data URL；null 表示还在取/取不到 */
	src: string | null;
	/** 取不到原图（缺失或失败）：与「还在加载」用不同 i18n 文案 */
	failed: boolean;
	count: number;
	index: number;
	onClose: () => void;
}) {
	const t = useT();
	return (
		<button
			type="button"
			data-image-preview="open"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
			onClick={onClose}
		>
			{src ? (
				<img
					src={src}
					alt={t("message.image")}
					className="max-h-full max-w-full rounded-lg object-contain"
					decoding="async"
				/>
			) : (
				// 占位不改变遮罩几何（fixed 铺满、内容居中），样式复用右上角计数器胶囊，不新增色值
				<span className="rounded-full bg-black/50 px-2.5 py-1 text-ui-11 text-white/80 select-none">
					{failed ? t("message.imageLoadError") : t("message.imagePending")}
				</span>
			)}
			{count > 1 && (
				<span className="absolute top-4 right-5 rounded-full bg-black/50 px-2.5 py-1 text-ui-11 text-white/80 select-none">
					{index + 1} / {count}
				</span>
			)}
		</button>
	);
}
