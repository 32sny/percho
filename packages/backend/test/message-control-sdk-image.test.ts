import { deflateSync } from "node:zlib";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanupSdkTest,
	gate,
	MODEL_20K,
	requireControl,
	sdkFixture,
	withTimeout,
} from "./message-control-sdk-harness";

/**
 * G4 默认图片路径回归：不关 `images.autoResize`，让真实 SDK 的 `processImage` 走 Photon
 * 归一化/缩放；这里不 mock `_normalizePromptImages`，也不伪造 base64。
 *
 * 只覆盖受控消息控制下的图片准备、取消后恢复与重发；真实 UI 图片回显由主会话另行验收。
 */

afterEach(async () => {
	await cleanupSdkTest();
});

const SETTINGS = {
	compaction: { enabled: false },
	retry: { enabled: false },
	cacheWarming: "off" as const,
};

const WIDTH = 2400;
const HEIGHT = 1600;
const PNG_MIME = "image/png";

function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const name = Buffer.from(type, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
	return Buffer.concat([length, name, data, crc]);
}

/** 真实有效 PNG：RGB 渐变、无外部依赖；2400x1600 会触发 SDK 默认 2000px 缩放。 */
function makePng(width: number, height: number): Buffer {
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) {
		const row = y * (width * 3 + 1);
		raw[row] = 0;
		for (let x = 0; x < width; x++) {
			const pixel = row + 1 + x * 3;
			raw[pixel] = x % 256;
			raw[pixel + 1] = y % 256;
			raw[pixel + 2] = (x + y) % 256;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw, { level: 6 })),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

const BIG_PNG = makePng(WIDTH, HEIGHT);
const BIG_PNG_BASE64 = BIG_PNG.toString("base64");

interface Size {
	width: number;
	height: number;
	format: "png" | "jpeg";
}

function imageSize(data: string, mimeType: string): Size {
	const bytes = Buffer.from(data, "base64");
	if (mimeType === "image/png") {
		expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
		return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), format: "png" };
	}
	expect(mimeType).toBe("image/jpeg");
	expect(bytes.readUInt16BE(0)).toBe(0xffd8);
	let offset = 2;
	while (offset + 9 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset++;
			continue;
		}
		const marker = bytes[offset + 1];
		if (marker === undefined) break;
		if (marker === 0xd8 || marker === 0xd9) {
			offset += 2;
			continue;
		}
		const length = bytes.readUInt16BE(offset + 2);
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return {
				height: bytes.readUInt16BE(offset + 5),
				width: bytes.readUInt16BE(offset + 7),
				format: "jpeg",
			};
		}
		offset += 2 + length;
	}
	throw new Error("JPEG size marker not found");
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is TextContent =>
				typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text",
		)
		.map((part) => part.text)
		.join("");
}

function lastUserMessage(messages: readonly Message[]): Message {
	const user = [...messages].reverse().find((message) => message.role === "user");
	if (!user) throw new Error("model request did not include a user message");
	return user;
}

function imageBlocks(message: Message): ImageContent[] {
	expect(Array.isArray(message.content)).toBe(true);
	if (!Array.isArray(message.content)) return [];
	return message.content.filter((part): part is ImageContent => part.type === "image");
}

function identity(session: { sessionId: string }, runtimeId: string) {
	return { sessionId: session.sessionId, runtimeId };
}

describe("managed image payload: default SDK normalization and recovery", () => {
	it("[G4 image-default-resize] a real 2400x1600 PNG is normalized by the native SDK path and the model context carries the scaled image", async () => {
		const fixture = await sdkFixture({ model: MODEL_20K, settings: SETTINGS });
		const control = requireControl(fixture.session);
		// 默认值就是 true；用例不写 images.autoResize=false。
		expect(fixture.session.settingsManager.getImageAutoResize()).toBe(true);
		expect(MODEL_20K.input).toContain("image");

		const submitted = await control.submit({
			...identity(fixture.session, control.getSnapshot().runtimeId),
			requestId: "image-default",
			mode: "queue",
			payload: { text: "请查看大图", images: [{ data: BIG_PNG_BASE64, mimeType: PNG_MIME }] },
		});
		expect(submitted).toMatchObject({ ok: true, value: { disposition: "started" } });
		await control.waitForIdle();

		expect(fixture.requests).toHaveLength(1);
		const message = lastUserMessage(fixture.requests[0] as Message[]);
		const images = imageBlocks(message);
		expect(images).toHaveLength(1);

		const resized = images[0];
		if (!resized) throw new Error("normalized image missing");
		const size = imageSize(resized.data, resized.mimeType);
		// 原始 2400x1600 按 SDK 默认 max 2000 等比缩放；证据同时保留原始尺寸提示。
		expect(size).toMatchObject({ width: 2000, height: 1333 });
		expect(size.format === "png" || size.format === "jpeg").toBe(true);
		expect(resized.data).not.toBe(BIG_PNG_BASE64);
		expect(Buffer.from(resized.data, "base64").equals(BIG_PNG)).toBe(false);
		const text = textOf(message.content);
		expect(text).toContain(`[Image: original ${WIDTH}x${HEIGHT}, displayed at ${size.width}x${size.height}.`);
		// 真实 transcript 同样保存归一化后的图片，不是仅请求快照里临时存在。
		const storedUser = [...fixture.session.messages].reverse().find((item) => item.role === "user");
		if (!storedUser) throw new Error("stored user message missing");
		expect(imageBlocks(storedUser)).toHaveLength(1);
	});

	it("[G4 image-cancel-recover] cancelling before normalization keeps the original payload and message id recoverable, then resends the real image once", async () => {
		const prepareEntered = gate();
		const prepareRelease = gate();
		const arm = { on: true };
		const extension: ExtensionFactory = (pi) => {
			pi.on("before_agent_start", async () => {
				if (!arm.on) return;
				prepareEntered.resolve();
				await prepareRelease.promise;
			});
		};
		const fixture = await sdkFixture({ model: MODEL_20K, settings: SETTINGS, extensions: [extension] });
		const control = requireControl(fixture.session);
		const base = identity(fixture.session, control.getSnapshot().runtimeId);
		const payload = {
			text: "取消后恢复大图",
			images: [{ data: BIG_PNG_BASE64, mimeType: PNG_MIME }],
			draft: {
				text: "草稿",
				attachments: ["image.png"],
				quotes: [],
				slashCommand: null,
				imageNames: ["大图"],
			},
		};
		const pending = control.submit({ ...base, requestId: "image-cancel", mode: "queue", payload });
		await withTimeout(prepareEntered.promise, 5_000, "image preparation gate");
		control.stop({ ...base, requestId: "image-cancel-stop" });
		prepareRelease.resolve();
		await withTimeout(pending, 5_000, "cancelled image submit settles");
		await control.waitForIdle();
		expect(fixture.requests).toHaveLength(0);
		const held = control.getSnapshot().items.find((item) => item.messageId === "image-cancel");
		expect(held).toMatchObject({ state: "held", imageCount: 1 });

		const recovered = control.recover({
			...base,
			requestId: "image-cancel-recover",
			messageId: "image-cancel",
			expectedRevision: control.getSnapshot().revision,
		});
		if (!recovered.ok) throw new Error(`recover failed: ${recovered.error.message}`);
		// 原始 payload 与 ID 完整保留，恢复不替换成归一化后的临时图。
		expect(recovered.value.messageId).toBe("image-cancel");
		expect(recovered.value.payload).toEqual(payload);
		expect(recovered.value.payload.images?.[0]?.data).toBe(BIG_PNG_BASE64);

		arm.on = false;
		const resent = await control.submit({
			...base,
			requestId: "image-cancel-resend",
			mode: "queue",
			payload: recovered.value.payload,
			recovery: { messageId: "image-cancel", expectedRevision: control.getSnapshot().revision },
		});
		expect(resent).toMatchObject({ ok: true, value: { messageId: "image-cancel" } });
		await control.waitForIdle();
		expect(fixture.requests).toHaveLength(1);
		const message = lastUserMessage(fixture.requests[0] as Message[]);
		const images = imageBlocks(message);
		expect(images).toHaveLength(1);
		const size = imageSize(images[0]?.data ?? "", images[0]?.mimeType ?? "");
		expect(size).toMatchObject({ width: 2000, height: 1333 });
		expect(textOf(message.content)).toContain("取消后恢复大图");
		// 重发只产生一条用户消息；没有把取消前的旧输入再发一次。
		const userTexts = (fixture.requests[0] as Message[]).filter((item) => item.role === "user");
		expect(userTexts).toHaveLength(1);
		expect(control.getSnapshot()).toMatchObject({ items: [] });
	});
});
