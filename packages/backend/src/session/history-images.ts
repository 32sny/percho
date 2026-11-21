import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { HistoryImageRef, ImageInput, SessionMessage } from "@percho/shared";
import type { ContentBlock, RawMessage } from "./messages";

/**
 * 分页历史的图片懒加载内核：把已知 SDK 图片内容（user content 的 image 块、show_image
 * 的 details 新旧形状）从页面里剥离成引用，字节只留在 backend 内存；同时给分页器提供
 * 「剥掉 base64 后」的惰性预算测量。
 *
 * 只碰明确的图片载荷字段（`image` 块的 data、show_image details 里带 mimeType 的
 * data），不碰正文、caption、工具输出或路径。
 */

const encoder = new TextEncoder();

export interface HistoryImageStoreOptions {
	sessionId: string;
	generation: string;
}

/**
 * 一代快照内已签发图片引用的持有者。同 imageId 重复登记是幂等覆盖，因此同一页重复
 * 读取不会让内存增长。跨会话 / 跨代次 / 未签发的引用一律拒绝。
 */
export class HistoryImageStore {
	readonly sessionId: string;
	readonly generation: string;
	private readonly images = new Map<string, ImageInput>();

	constructor(options: HistoryImageStoreOptions) {
		this.sessionId = options.sessionId;
		this.generation = options.generation;
	}

	/** 已签发引用数（同 id 覆盖不增长；供测试与诊断）。 */
	get size(): number {
		return this.images.size;
	}

	issue(imageId: string, image: ImageInput): void {
		this.images.set(imageId, image);
	}

	get(ref: HistoryImageRef): ImageInput | null {
		if (ref.sessionId !== this.sessionId) return null;
		if (ref.generation !== this.generation) return null;
		const image = this.images.get(ref.imageId);
		if (!image || image.mimeType !== ref.mimeType) return null;
		return image;
	}
}

export interface HistoryImageProjectionOptions {
	/** 本页首条 entry 在快照分支中的绝对下标，用来生成确定性的图片 id。 */
	startIndex: number;
	store: HistoryImageStore;
}

/**
 * 原地把 user / image 消息的 `images` 换成 `historyImageRefs`（`images` 清空）。
 * imageId 由「页起点绝对下标 + 页内图片序号」生成，同一页重复投影得到同一组 id。
 */
export function stripHistoryImages(
	messages: SessionMessage[],
	options: HistoryImageProjectionOptions,
): SessionMessage[] {
	let ordinal = 0;
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "image") continue;
		if (message.images.length === 0) continue;
		const refs = message.images.map((image): HistoryImageRef => {
			const imageId = `history:${options.startIndex}:${ordinal++}`;
			const ref: HistoryImageRef = {
				sessionId: options.store.sessionId,
				generation: options.store.generation,
				imageId,
				mimeType: image.mimeType,
			};
			options.store.issue(imageId, image);
			return ref;
		});
		message.images = [];
		message.historyImageRefs = refs;
	}
	return messages;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImagePayload(value: unknown): value is { data: string; mimeType: string } {
	return (
		isRecord(value) &&
		typeof value.data === "string" &&
		value.data.length > 0 &&
		typeof value.mimeType === "string"
	);
}

function stripContentBlock(block: ContentBlock): { block: ContentBlock; changed: boolean } {
	if (block.type !== "image" || typeof block.data !== "string" || block.data.length === 0) {
		return { block, changed: false };
	}
	return { block: { ...block, data: "" }, changed: true };
}

/** show_image details：新形状 `{ paths, images: [{data,mimeType}] }`，旧形状 `{ path, image }`。 */
function stripDetailsImageData(details: unknown): { details: unknown; changed: boolean } {
	if (!isRecord(details)) return { details, changed: false };
	let changed = false;
	const next: Record<string, unknown> = { ...details };
	if (Array.isArray(details.images)) {
		const images = details.images.map((image) => {
			if (!isImagePayload(image)) return image;
			changed = true;
			return { ...image, data: "" };
		});
		if (changed) next.images = images;
	}
	if (isImagePayload(details.image)) {
		changed = true;
		next.image = { ...(details.image as Record<string, unknown>), data: "" };
	}
	return { details: changed ? next : details, changed };
}

function stripMessageImageData(message: RawMessage): { message: RawMessage; changed: boolean } {
	let next = message;
	let changed = false;
	if (Array.isArray(message.content)) {
		const content = message.content.map((block) => stripContentBlock(block));
		if (content.some((item) => item.changed)) {
			next = { ...next, content: content.map((item) => item.block) };
			changed = true;
		}
	}
	if (message.role === "toolResult" && message.toolName === "show_image") {
		const stripped = stripDetailsImageData(message.details);
		if (stripped.changed) {
			next = { ...next, details: stripped.details };
			changed = true;
		}
	}
	return { message: next, changed };
}

/** 返回剥掉已知图片 base64 的 entry 副本（只用于尺寸测量，不进入回放结果）。 */
export function stripEntryImageData(entry: SessionEntry): SessionEntry {
	if (entry.type !== "message") return entry;
	const message = entry.message as RawMessage;
	if (!isRecord(message)) return entry;
	const stripped = stripMessageImageData(message);
	return stripped.changed ? ({ ...entry, message: stripped.message } as SessionEntry) : entry;
}

/** 分页器用：按剥掉图片 base64 后的轻量 entry 计预算。 */
export function measureEntryWithoutImageData(entry: SessionEntry): number {
	return encoder.encode(JSON.stringify(stripEntryImageData(entry))).length;
}
