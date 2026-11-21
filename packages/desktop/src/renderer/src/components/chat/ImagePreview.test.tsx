import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	vi.stubGlobal("navigator", { language: "zh-CN" });
	vi.stubGlobal("window", {
		matchMedia: () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		}),
		addEventListener: () => {},
		removeEventListener: () => {},
	});
	vi.stubGlobal("document", { body: {} });
});

// 预览层 portal 到 body：SSR 不支持 portal，这里把 createPortal 换成直接返回子树（只为断言标签属性）
vi.mock("react-dom", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-dom")>()),
	createPortal: (node: unknown) => node,
}));

import type { ImageInput } from "@percho/shared";
import * as React from "react";
import {
	type HistoryImageRef,
	historyImageRefKey,
	isHistoryImageRef,
} from "./history-image/history-image-source";
import {
	createPreviewImageResolveQueue,
	ImagePreviewOverlay,
	ImagePreviewSurface,
	imageSrc,
} from "./ImagePreview";

/**
 * 预览层两种来源（内联 / 引用）的契约：
 * - 内联图路径**完全不变**（Composer / 插件 / 已加载页）；
 * - 引用图只在挂载后为**当前索引**取原图（SSR 渲染期一次都不取），关图/切图/方向键的迟到结果丢弃；
 * - 占位不改遮罩几何、不新增色值，缺失与失败都走既有 message i18n。
 */

const inline = (seed: string): ImageInput => ({ mimeType: "image/png", data: `seed-${seed}` });

const ref = (imageId: string): HistoryImageRef => ({
	sessionId: "session-1",
	generation: "gen-1",
	imageId,
	mimeType: "image/png",
});

const imgTags = (html: string): string[] => html.match(/<img\b[^>]*>/g) ?? [];

function renderOverlay(props: Parameters<typeof ImagePreviewOverlay>[0]): string {
	return renderToStaticMarkup(createElement(ImagePreviewOverlay, props));
}

async function flush(times = 8): Promise<void> {
	for (let index = 0; index < times; index += 1) await Promise.resolve();
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("预览：内联图路径不变（Composer / 插件 / 已加载页）", () => {
	beforeEach(() => {
		vi.stubGlobal("navigator", { language: "zh-CN" });
		vi.stubGlobal("React", React);
		// 没有 preload 桥：内联图绝不能因为渲染而去取图
		vi.stubGlobal("window", {
			matchMedia: () => ({
				matches: false,
				addEventListener: () => {},
				removeEventListener: () => {},
				addListener: () => {},
				removeListener: () => {},
			}),
			addEventListener: () => {},
			removeEventListener: () => {},
		});
	});

	it("单图（Composer 用法）：直接渲染原图 data URL，无占位", () => {
		const html = renderOverlay({ image: inline("one"), onClose: () => {} });
		const tags = imgTags(html);
		expect(tags).toHaveLength(1);
		expect(tags[0]).toContain(`src="${imageSrc(inline("one"))}"`);
		expect(tags[0]).toContain('decoding="async"');
		expect(tags[0]).not.toContain("loading=");
		expect(html).not.toContain("图片待加载");
		// 单图不显示计数
		expect(html).not.toContain("1 / 1");
	});

	it("多图：只渲染当前索引那一张，计数沿用 n / total", () => {
		const images = Array.from({ length: 4 }, (_, index) => inline(String(index)));
		const html = renderOverlay({ images, initialIndex: 2, onClose: () => {} });
		const tags = imgTags(html);
		expect(tags).toHaveLength(1);
		expect(tags[0]).toContain(`src="${imageSrc(images[2] as ImageInput)}"`);
		expect(html).toContain("3 / 4");
	});

	it("空列表不渲染任何东西", () => {
		expect(renderOverlay({ images: [], onClose: () => {} })).toBe("");
	});
});

describe("预览：引用图只在挂载后为当前索引取图", () => {
	beforeEach(() => {
		vi.stubGlobal("navigator", { language: "zh-CN" });
		vi.stubGlobal("React", React);
	});

	it("SSR（无 effect）只给占位，不渲染 <img>、不去取图", () => {
		const html = renderToStaticMarkup(
			createElement(ImagePreviewOverlay, { images: [ref("a"), ref("b")], onClose: () => {} }),
		);
		expect(imgTags(html)).toHaveLength(0);
		expect(html).toContain("图片待加载");
		// 计数照常（切图与总数不依赖原图）
		expect(html).toContain("1 / 2");
	});

	it("就绪 / 失败 / 计数三态：失败用既有 i18n 文案，不改变遮罩结构", () => {
		const ready = renderToStaticMarkup(
			createElement(ImagePreviewSurface, {
				src: imageSrc(inline("ready")),
				failed: false,
				count: 3,
				index: 1,
				onClose: () => {},
			}),
		);
		expect(imgTags(ready)).toHaveLength(1);
		expect(ready).toContain("2 / 3");
		expect(ready).toContain("fixed inset-0 z-50");
		expect(ready).not.toContain("图片加载失败");

		const loading = renderToStaticMarkup(
			createElement(ImagePreviewSurface, { src: null, failed: false, count: 1, index: 0, onClose: () => {} }),
		);
		expect(imgTags(loading)).toHaveLength(0);
		expect(loading).toContain("图片待加载");
		// 占位不新增色值：复用右上角计数胶囊的 bg-black/50 + text-white/80
		expect(loading).toContain("bg-black/50");
		expect(loading).toContain("text-white/80");

		const failed = renderToStaticMarkup(
			createElement(ImagePreviewSurface, { src: null, failed: true, count: 1, index: 0, onClose: () => {} }),
		);
		expect(imgTags(failed)).toHaveLength(0);
		expect(failed).toContain("图片加载失败");
		expect(failed).not.toContain("图片待加载");
	});
});

describe("预览：引用图解析队列（只认当前这一张）", () => {
	it("关闭/切图后迟到结果不落到界面", async () => {
		const pending = deferred<ImageInput | null>();
		const queue = createPreviewImageResolveQueue(() => pending.promise);
		const applied: (string | null)[] = [];
		void queue.run(ref("a"), (src) => applied.push(src));
		queue.cancel();
		pending.resolve(inline("a"));
		await flush();
		expect(applied).toHaveLength(0);
	});

	it("连续切图：只有最后一次请求的结果生效（方向键连按不串图）", async () => {
		const first = deferred<ImageInput | null>();
		const second = deferred<ImageInput | null>();
		const loads: string[] = [];
		const queue = createPreviewImageResolveQueue((target) => {
			loads.push(target.imageId);
			return target.imageId === "a" ? first.promise : second.promise;
		});
		const applied: (string | null)[] = [];
		void queue.run(ref("a"), (src) => applied.push(src));
		void queue.run(ref("b"), (src) => applied.push(src));
		expect(loads).toEqual(["a", "b"]);
		// 先回来的旧图被丢弃
		first.resolve(inline("a"));
		await flush();
		expect(applied).toHaveLength(0);
		second.resolve(inline("b"));
		await flush();
		expect(applied).toEqual([imageSrc(inline("b"))]);
	});

	it("缺失 / 抛错都收敛成 null（UI 走失败文案），不把异常抛给渲染层", async () => {
		const missing = createPreviewImageResolveQueue(async () => null);
		const missingApplied: (string | null)[] = [];
		await missing.run(ref("missing"), (src) => missingApplied.push(src));
		expect(missingApplied).toEqual([null]);

		const throwing = createPreviewImageResolveQueue(async () => {
			throw new Error("ipc 失败");
		});
		const throwingApplied: (string | null)[] = [];
		await throwing.run(ref("throwing"), (src) => throwingApplied.push(src));
		expect(throwingApplied).toEqual([null]);
	});
});

describe("引用图身份：与列表侧共用一套 key / 判别", () => {
	it("预览与列表用同一个去重键，不会因为来源形态不同而错位", () => {
		expect(isHistoryImageRef(ref("a"))).toBe(true);
		expect(isHistoryImageRef(inline("a"))).toBe(false);
		expect(historyImageRefKey(ref("a"))).toBe(historyImageRefKey(ref("a")));
	});
});
