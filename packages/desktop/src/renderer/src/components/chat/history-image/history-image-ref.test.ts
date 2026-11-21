import type { ImageInput } from "@percho/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TASK_TIMEOUT_MS } from "./constants";
import { createThumbnailService, type ThumbnailService } from "./history-image-service";
import {
	type HistoryImageRef,
	historyImageRefKey,
	isHistoryImageRef,
	loadHistoryImage,
	messageImageSources,
} from "./history-image-source";
import type { ThumbnailRequest, ThumbnailResponse } from "./thumbnail-protocol";

/**
 * 引用图（分页回放只给 id）在资源层的契约：
 * - **可见才取原图**：隐藏/离屏项不发起取图，也不占在途任务；
 * - 取图与内联图共用同一条单飞链路（一次一张、slot/队列/LRU/URL 生命周期不变）；
 * - 取到的 base64 只活到投递那一帧，失败/超时/重置/释放后的迟到结果一律丢弃；
 * - 去重键是 `sessionId + generation + imageId + mimeType`，不是对象引用、也不 hash base64。
 */

const ref = (imageId: string, overrides: Partial<HistoryImageRef> = {}): HistoryImageRef => ({
	sessionId: "session-1",
	generation: "gen-1",
	imageId,
	mimeType: "image/png",
	...overrides,
});

const inlineOf = (imageId: string): ImageInput => ({ mimeType: "image/png", data: `data-${imageId}` });

/** 排空微任务（服务用 microtask 收口同步失败与重入，测试里统一 flush 后再断言） */
async function flush(times = 24): Promise<void> {
	for (let index = 0; index < times; index += 1) await Promise.resolve();
}

class FakeWorker {
	posted: ThumbnailRequest[] = [];
	responded = new Set<number>();
	terminated = 0;
	private messageListeners: ((event: { data: ThumbnailResponse }) => void)[] = [];

	postMessage(request: ThumbnailRequest): void {
		this.posted.push(request);
	}

	addEventListener(type: string, listener: never): void {
		if (type === "message") this.messageListeners.push(listener);
	}

	terminate(): void {
		this.terminated += 1;
	}

	emit(response: ThumbnailResponse): void {
		this.responded.add(response.requestId);
		for (const listener of [...this.messageListeners]) listener({ data: response });
	}

	completeLast(): void {
		const request = this.lastRequest;
		if (!request) throw new Error("没有投递过任务");
		this.emit({
			requestId: request.requestId,
			ok: true,
			blob: new Blob([new Uint8Array(64)], { type: "image/png" }),
			width: 96,
			height: 96,
		});
	}

	failLast(): void {
		const request = this.lastRequest;
		if (!request) throw new Error("没有投递过任务");
		this.emit({ requestId: request.requestId, ok: false, error: "decode failed" });
	}

	get lastRequest(): ThumbnailRequest | undefined {
		return this.posted[this.posted.length - 1];
	}
}

function fakeService(overrides: { loadRef?: (ref: HistoryImageRef) => Promise<ImageInput | null> } = {}) {
	const workers: FakeWorker[] = [];
	const createdUrls: string[] = [];
	const revokedUrls: string[] = [];
	const loads: HistoryImageRef[] = [];
	const loadRef =
		overrides.loadRef ??
		(async (target: HistoryImageRef) => {
			loads.push(target);
			return inlineOf(target.imageId);
		});
	const service: ThumbnailService = createThumbnailService({
		createWorker: () => {
			const worker = new FakeWorker();
			workers.push(worker);
			return worker as unknown as Worker;
		},
		createObjectUrl: () => {
			const url = `blob:ref-${createdUrls.length + 1}`;
			createdUrls.push(url);
			return url;
		},
		revokeObjectUrl: (url) => {
			revokedUrls.push(url);
		},
		loadRef: (target) => {
			// 默认实现自己记录调用；注入实现时也照样记录，便于断言「调用了几次」
			if (overrides.loadRef) loads.push(target);
			return loadRef(target);
		},
	});
	const worker = () => {
		const last = workers[workers.length - 1];
		if (!last) throw new Error("还没有创建 worker");
		return last;
	};
	return { service, workers, worker, createdUrls, revokedUrls, loads };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("引用图：只在可见时取原图，且不长期持有 base64", () => {
	it("hidden/off-screen 的引用图不取原图、不占在途；可见后才取一次", async () => {
		const fake = fakeService();
		const handle = fake.service.acquire(ref("a"), { visible: false });
		await flush();
		expect(fake.loads).toHaveLength(0);
		expect(fake.service.stats()).toMatchObject({ inFlight: false, outstandingRequests: 0 });
		expect(fake.workers).toHaveLength(0);
		expect(handle.getSnapshot()).toMatchObject({ status: "idle", url: null });

		handle.setVisible(true);
		await flush();
		expect(fake.loads).toHaveLength(1);
		expect(fake.service.stats().outstandingRequests).toBe(1);
		expect(fake.worker().lastRequest?.image.data).toBe("data-a");

		fake.worker().completeLast();
		expect(handle.getSnapshot().status).toBe("ready");
		expect(handle.getSnapshot().url).toBe("blob:ref-1");
	});

	it("取图期间显示 loading（占位与内联图一致），成功后进 ready", async () => {
		const pending = deferred<ImageInput | null>();
		const fake = fakeService({ loadRef: () => pending.promise });
		const handle = fake.service.acquire(ref("b"));
		expect(handle.getSnapshot().status).toBe("loading");
		expect(fake.service.stats()).toMatchObject({ inFlight: true, outstandingRequests: 0 });

		pending.resolve(inlineOf("b"));
		await flush();
		expect(fake.service.stats().outstandingRequests).toBe(1);
		fake.worker().completeLast();
		expect(handle.getSnapshot().status).toBe("ready");
	});

	it("同一张引用图（对象不同）只取一次、只解码一次、共享一个 Blob URL", async () => {
		const fake = fakeService();
		const first = fake.service.acquire(ref("shared"));
		const second = fake.service.acquire(ref("shared"));
		await flush();
		expect(fake.loads).toHaveLength(1);
		expect(fake.worker().posted).toHaveLength(1);
		fake.worker().completeLast();
		expect(first.getSnapshot().url).toBe(second.getSnapshot().url);
		expect(fake.createdUrls).toHaveLength(1);
	});

	it("取到原图后不在 record 上留 base64：失败重试会重新取图", async () => {
		const fake = fakeService();
		const handle = fake.service.acquire(ref("retry"));
		await flush();
		expect(fake.worker().posted).toHaveLength(1);
		fake.worker().failLast();
		expect(handle.getSnapshot().status).toBe("error");

		handle.retry();
		await flush();
		expect(fake.loads).toHaveLength(2);
		expect(fake.worker().posted).toHaveLength(2);
		fake.worker().completeLast();
		expect(handle.getSnapshot().status).toBe("ready");
	});

	it("取不到图（null / 抛错）统一进错误占位，可重试，不把异常抛给调用方", async () => {
		let attempt = 0;
		const fake = fakeService({
			loadRef: async (target) => {
				attempt += 1;
				if (attempt === 1) return null;
				if (attempt === 2) throw new Error("ipc 失败");
				return inlineOf(target.imageId);
			},
		});
		const handle = fake.service.acquire(ref("missing"));
		await flush();
		expect(handle.getSnapshot().status).toBe("error");
		expect(fake.workers).toHaveLength(0);

		handle.retry();
		await flush();
		expect(handle.getSnapshot().status).toBe("error");

		handle.retry();
		await flush();
		expect(fake.loads).toHaveLength(3);
		expect(fake.worker().posted).toHaveLength(1);
		fake.worker().completeLast();
		expect(handle.getSnapshot().status).toBe("ready");
	});

	it("单飞：取图期间别的引用图只排队，不会并发取两张", async () => {
		const first = deferred<ImageInput | null>();
		let call = 0;
		const fake = fakeService({
			loadRef: async (target) => {
				call += 1;
				if (call === 1) return first.promise;
				return inlineOf(target.imageId);
			},
		});
		const a = fake.service.acquire(ref("a"));
		const b = fake.service.acquire(ref("b"));
		await flush();
		expect(fake.loads).toHaveLength(1);
		expect(fake.loads[0]?.imageId).toBe("a");

		first.resolve(inlineOf("a"));
		await flush();
		expect(fake.worker().posted).toHaveLength(1);
		expect(fake.loads).toHaveLength(1);

		fake.worker().completeLast();
		await flush();
		expect(fake.loads).toHaveLength(2);
		expect(fake.loads[1]?.imageId).toBe("b");
		expect(a.getSnapshot().status).toBe("ready");
		expect(b.getSnapshot().status).toBe("loading");
	});

	it("取图期间被释放：迟到结果不投递、不进缓存、不留下在途任务", async () => {
		const pending = deferred<ImageInput | null>();
		const fake = fakeService({ loadRef: () => pending.promise });
		const handle = fake.service.acquire(ref("released"));
		expect(handle.getSnapshot().status).toBe("loading");
		handle.release();
		pending.resolve(inlineOf("released"));
		await flush();

		expect(fake.workers).toHaveLength(0);
		expect(fake.service.stats()).toMatchObject({
			keys: 0,
			cacheEntries: 0,
			inFlight: false,
			outstandingRequests: 0,
			urls: 0,
		});
		expect(handle.getSnapshot()).toMatchObject({ status: "idle", url: null });
	});

	it("取图期间 reset（切会话）：迟到结果不投递；新代重新取图", async () => {
		const pending = deferred<ImageInput | null>();
		const fake = fakeService({ loadRef: () => pending.promise });
		const stale = fake.service.acquire(ref("gen"));
		fake.service.reset();
		expect(stale.getSnapshot()).toMatchObject({ status: "idle", url: null });

		pending.resolve(inlineOf("gen"));
		await flush();
		expect(fake.workers).toHaveLength(0);
		expect(fake.service.stats()).toMatchObject({ keys: 0, inFlight: false, cacheEntries: 0 });
	});

	it("取图超时：进错误态（可重试），迟到结果不再投递", async () => {
		vi.useFakeTimers();
		try {
			const pending = deferred<ImageInput | null>();
			const fake = fakeService({ loadRef: () => pending.promise });
			const handle = fake.service.acquire(ref("slow"));
			vi.advanceTimersByTime(TASK_TIMEOUT_MS + 1);
			expect(handle.getSnapshot().status).toBe("error");
			expect(fake.service.stats()).toMatchObject({ inFlight: false, timeouts: 1 });

			pending.resolve(inlineOf("slow"));
			await flush();
			expect(fake.workers).toHaveLength(0);
			expect(fake.service.stats().outstandingRequests).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("跨代同一 imageId 是两个身份：generation 参与去重键，不会串图", async () => {
		const fake = fakeService();
		fake.service.acquire(ref("same-id", { generation: "gen-1" }));
		await flush();
		fake.worker().completeLast();
		fake.service.acquire(ref("same-id", { generation: "gen-2" }));
		await flush();
		expect(fake.loads).toHaveLength(2);
		expect(fake.worker().posted).toHaveLength(2);
	});

	it("引用图与内联图共用预算：可见优先与 48 slots 的语义不变", async () => {
		const fake = fakeService();
		const refHandle = fake.service.acquire(ref("budget-ref"));
		await flush();
		fake.worker().completeLast();
		const inlineHandle = fake.service.acquire(inlineOf("budget-inline"));
		expect(fake.service.stats().active).toBe(2);
		expect(refHandle.getSnapshot().status).toBe("ready");
		expect(inlineHandle.getSnapshot().status).toBe("loading");
		fake.worker().completeLast();
		expect(inlineHandle.getSnapshot().status).toBe("ready");
	});

	it("队列里的隐藏引用图不挡住后面的可见内联图", async () => {
		const fake = fakeService();
		fake.service.acquire(ref("hidden-ref"), { visible: false });
		const inline = fake.service.acquire(inlineOf("visible-inline"));
		await flush();
		// 隐藏引用图没取图；可见内联图照常进 worker
		expect(fake.loads).toHaveLength(0);
		expect(fake.worker().lastRequest?.image.data).toBe("data-visible-inline");
		expect(inline.getSnapshot().status).toBe("loading");
	});
});

describe("引用图的来源契约（纯函数 + 取图入口）", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("去重键覆盖 session/generation/imageId/mimeType", () => {
		expect(historyImageRefKey(ref("a"))).toBe(historyImageRefKey(ref("a")));
		expect(historyImageRefKey(ref("a"))).not.toBe(historyImageRefKey(ref("b")));
		expect(historyImageRefKey(ref("a"))).not.toBe(historyImageRefKey(ref("a", { generation: "gen-2" })));
		expect(historyImageRefKey(ref("a"))).not.toBe(historyImageRefKey(ref("a", { sessionId: "session-2" })));
		expect(historyImageRefKey(ref("a"))).not.toBe(historyImageRefKey(ref("a", { mimeType: "image/jpeg" })));
	});

	it("内联 / 引用用「有没有 data」区分，不会把内联图误判成引用", () => {
		expect(isHistoryImageRef(inlineOf("x"))).toBe(false);
		expect(isHistoryImageRef(ref("x"))).toBe(true);
	});

	it("消息来源：内联优先，分页回放（images 为空）才用引用列表", () => {
		const inline = inlineOf("inline");
		expect(messageImageSources({ images: [inline] })).toEqual([inline]);
		expect(messageImageSources({ images: [] })).toEqual([]);
		const refs = [ref("a"), ref("b")];
		expect(messageImageSources({ images: [], historyImageRefs: refs })).toBe(refs);
		expect(messageImageSources({ images: [inline], historyImageRefs: refs })).toEqual([inline]);
	});

	it("取图入口：正常返回原图；缺失 API、缺失图、抛错一律 null（不抛给渲染层）", async () => {
		const image = inlineOf("api");
		vi.stubGlobal("window", { pi: { getSessionHistoryImage: async () => image } });
		await expect(loadHistoryImage(ref("api"))).resolves.toBe(image);

		vi.stubGlobal("window", { pi: { getSessionHistoryImage: async () => null } });
		await expect(loadHistoryImage(ref("missing"))).resolves.toBeNull();

		vi.stubGlobal("window", {
			pi: {
				getSessionHistoryImage: async () => {
					throw new Error("ipc 失败");
				},
			},
		});
		await expect(loadHistoryImage(ref("throwing"))).resolves.toBeNull();

		// 老版本 preload 没有这个方法：按缺失处理，绝不崩渲染层
		vi.stubGlobal("window", { pi: {} });
		await expect(loadHistoryImage(ref("no-api"))).resolves.toBeNull();

		vi.stubGlobal("window", undefined);
		await expect(loadHistoryImage(ref("no-bridge"))).resolves.toBeNull();
	});
});
