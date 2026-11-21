import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type HistoryImageRef, type ImageInput, messagesToUIMessages } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import {
	HistoryImageStore,
	measureEntryWithoutImageData,
	stripEntryImageData,
	stripHistoryImages,
} from "../src/session/history-images";
import { HISTORY_TARGET_BYTES, SessionHistoryPager } from "../src/session/history-pager";
import { toBranchSessionMessages } from "../src/session/messages";

/**
 * 分页历史图片懒加载：分页页只带引用不带 base64；预算按轻量 entry 惰性测量；
 * 取字节只认「当前实例 + 同代次 + 已签发 id」。
 */

const encoder = new TextEncoder();
const PNG = "image/png";
const JPEG = "image/jpeg";

function bigBase64(bytes: number): string {
	return "A".repeat(bytes);
}

function messageEntry(message: Record<string, unknown>, id: string, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(1_700_000_000_000).toISOString(),
		message,
	} as unknown as SessionEntry;
}

function userWithImageEntry(id: string, parentId: string | null, text: string, data: string): SessionEntry {
	return messageEntry(
		{
			role: "user",
			content: [
				{ type: "text", text },
				{ type: "image", data, mimeType: PNG },
			],
			timestamp: 1_700_000_000_000,
		},
		id,
		parentId,
	);
}

function showImageEntries(
	ids: { assistant: string; tool: string },
	parentId: string | null,
	details: Record<string, unknown>,
): { entries: SessionEntry[]; nextParent: string } {
	const assistant = messageEntry(
		{
			role: "assistant",
			content: [
				{ type: "text", text: "图在这里" },
				{ type: "toolCall", id: "tc-show", name: "show_image", arguments: { paths: ["a.png"] } },
			],
			timestamp: 1_700_000_000_001,
		},
		ids.assistant,
		parentId,
	);
	const tool = messageEntry(
		{
			role: "toolResult",
			toolCallId: "tc-show",
			toolName: "show_image",
			content: [{ type: "text", text: "Image displayed to the user" }],
			details,
			isError: false,
			timestamp: 1_700_000_000_002,
		},
		ids.tool,
		ids.assistant,
	);
	return { entries: [assistant, tool], nextParent: ids.tool };
}

function refFor(overrides: Partial<HistoryImageRef> = {}): HistoryImageRef {
	return {
		sessionId: "session-1",
		generation: "generation-1",
		imageId: "history:0:0",
		mimeType: PNG,
		...overrides,
	};
}

describe("HistoryImageStore 引用解析", () => {
	it("已签发引用按原字节返回", () => {
		const store = new HistoryImageStore({ sessionId: "session-1", generation: "generation-1" });
		const image: ImageInput = { data: "QUJD", mimeType: PNG };
		store.issue("history:0:0", image);
		expect(store.get(refFor())).toEqual(image);
	});

	it("跨会话 / 跨代次 / 任意 id / 错 mimeType 一律 null", () => {
		const store = new HistoryImageStore({ sessionId: "session-1", generation: "generation-1" });
		store.issue("history:0:0", { data: "QUJD", mimeType: PNG });

		expect(store.get(refFor({ sessionId: "session-2" }))).toBeNull();
		expect(store.get(refFor({ generation: "generation-2" }))).toBeNull();
		expect(store.get(refFor({ imageId: "history:9:9" }))).toBeNull();
		expect(store.get(refFor({ mimeType: JPEG }))).toBeNull();
	});

	it("同 id 重复签发是幂等覆盖，不增长", () => {
		const store = new HistoryImageStore({ sessionId: "session-1", generation: "generation-1" });
		store.issue("history:0:0", { data: "QUJD", mimeType: PNG });
		store.issue("history:0:0", { data: "QUJD", mimeType: PNG });
		expect(store.size).toBe(1);
	});
});

describe("PiBackend.getSessionHistoryImage 实例门禁", () => {
	function backendWithSnapshot(instanceReplaced = false) {
		const backend = Object.create(PiBackend.prototype) as PiBackend;
		const owner = { session: { sessionId: "session-1" } };
		const registeredOwner = instanceReplaced ? { session: { sessionId: "session-1" } } : owner;
		const store = new HistoryImageStore({ sessionId: "session-1", generation: "generation-1" });
		store.issue("history:0:0", { data: "QUJD", mimeType: PNG });
		const internals = backend as unknown as {
			historyPagers: Map<string, unknown>;
			registry: Map<string, unknown>;
			getSessionHistoryImage: (ref: HistoryImageRef) => ImageInput | null;
		};
		internals.historyPagers = new Map([
			[
				"session-1",
				{
					owner,
					pager: { generation: "generation-1" },
					images: store,
				},
			],
		]);
		internals.registry = new Map([["session-1", registeredOwner]]);
		return internals;
	}

	it("精确实例 + 同代次 + 已签发 id 通过", () => {
		const backend = backendWithSnapshot();
		expect(backend.getSessionHistoryImage(refFor())).toEqual({ data: "QUJD", mimeType: PNG });
	});

	it("会话实例已替换时旧引用失效", () => {
		const backend = backendWithSnapshot(true);
		expect(backend.getSessionHistoryImage(refFor())).toBeNull();
	});

	it("任意 / 跨代 / 跨会话引用返回 null", () => {
		const backend = backendWithSnapshot();
		expect(backend.getSessionHistoryImage(refFor({ imageId: "guess" }))).toBeNull();
		expect(backend.getSessionHistoryImage(refFor({ generation: "stale" }))).toBeNull();
		expect(backend.getSessionHistoryImage(refFor({ sessionId: "other" }))).toBeNull();
		expect(backend.getSessionHistoryImage(null as unknown as HistoryImageRef)).toBeNull();
	});
});

describe("分页投影：图片只留引用", () => {
	const data = bigBase64(4096);

	function project() {
		const { entries, nextParent } = showImageEntries({ assistant: "a1", tool: "t1" }, null, {
			paths: ["a.png"],
			images: [{ data, mimeType: PNG }],
		});
		const branch = [userWithImageEntry("u1", null, "看看这张图", data), ...entries];
		const store = new HistoryImageStore({ sessionId: "session-1", generation: "generation-1" });
		const messages = stripHistoryImages(toBranchSessionMessages(branch), {
			startIndex: 0,
			store,
		});
		return { branch, messages, store, nextParent };
	}

	it("user 与 show_image 图片都转成引用，正文 / 路径 / 工具输出保留", () => {
		const { messages, store } = project();

		const user = messages.find((message) => message.role === "user");
		expect(user?.role === "user" && user.text).toBe("看看这张图");
		expect(user?.role === "user" && user.images).toEqual([]);
		const userRefs = user?.role === "user" ? user.historyImageRefs : undefined;
		expect(userRefs).toHaveLength(1);
		expect(userRefs?.[0]?.mimeType).toBe(PNG);
		expect(store.get(userRefs?.[0] as HistoryImageRef)).toEqual({ data, mimeType: PNG });

		const image = messages.find((message) => message.role === "image");
		expect(image?.role === "image" && image.images).toEqual([]);
		expect(image?.role === "image" && image.paths).toEqual(["a.png"]);
		const imageRefs = image?.role === "image" ? image.historyImageRefs : undefined;
		expect(imageRefs).toHaveLength(1);
		// 工具文本没有丢
		const assistant = messages.find((message) => message.role === "assistant");
		expect(assistant?.role === "assistant" && assistant.text).toBe("图在这里");
		const toolMessage = messages.find((message) => message.role === "assistant" && message.tools.length > 0);
		expect(toolMessage?.role === "assistant" && toolMessage.tools[0]?.name).toBe("show_image");
	});

	it("同一页重复投影得到同一组 id，存储不增长", () => {
		const { branch, store } = project();
		const first = stripHistoryImages(toBranchSessionMessages(branch), { startIndex: 0, store });
		const firstRefs = first.flatMap((message) =>
			"historyImageRefs" in message ? (message.historyImageRefs ?? []) : [],
		);
		const sizeAfterFirst = store.size;

		const second = stripHistoryImages(toBranchSessionMessages(branch), { startIndex: 0, store });
		const secondRefs = second.flatMap((message) =>
			"historyImageRefs" in message ? (message.historyImageRefs ?? []) : [],
		);
		expect(secondRefs.map((ref) => ref.imageId)).toEqual(firstRefs.map((ref) => ref.imageId));
		expect(store.size).toBe(sizeAfterFirst);
	});

	it("messagesToUIMessages 传播引用，纯图片 user 消息不被丢弃", () => {
		const refs = [refFor()];
		const ui = messagesToUIMessages([
			{
				role: "user",
				text: "",
				thinking: "",
				tools: [],
				images: [],
				timestamp: 1,
				historyImageRefs: refs,
			},
			{
				role: "image",
				images: [],
				paths: ["a.png"],
				timestamp: 2,
				historyImageRefs: refs,
			},
		]);
		expect(ui).toHaveLength(2);
		expect(ui[0]).toMatchObject({ kind: "user", images: [], historyImageRefs: refs });
		expect(ui[1]).toMatchObject({ kind: "image", paths: ["a.png"], historyImageRefs: refs });
	});

	it("旧 show_image details 形状 { path, image } 同样只留引用", () => {
		const { entries } = showImageEntries({ assistant: "a1", tool: "t1" }, null, {
			path: "old.png",
			image: { data, mimeType: JPEG },
		});
		const store = new HistoryImageStore({ sessionId: "session-1", generation: "generation-1" });
		const messages = stripHistoryImages(toBranchSessionMessages(entries), { startIndex: 0, store });
		const image = messages.find((message) => message.role === "image");
		expect(image?.role === "image" && image.images).toEqual([]);
		const refs = image?.role === "image" ? image.historyImageRefs : undefined;
		expect(refs).toHaveLength(1);
		expect(store.get(refs?.[0] as HistoryImageRef)).toEqual({ data, mimeType: JPEG });
	});
});

describe("轻量预算测量", () => {
	it("只剥图片 base64，不碰正文 / 工具输出 / caption", () => {
		const data = bigBase64(100_000);
		const entry = userWithImageEntry("u1", null, "caption 文本", data);
		const stripped = stripEntryImageData(entry) as unknown as {
			message: { content: Array<{ type: string; text?: string; data?: string }> };
		};
		expect(stripped.message.content[0]?.text).toBe("caption 文本");
		expect(stripped.message.content[1]?.data).toBe("");

		const rawBytes = encoder.encode(JSON.stringify(entry)).length;
		const lightBytes = measureEntryWithoutImageData(entry);
		expect(rawBytes).toBeGreaterThan(99_000);
		expect(lightBytes).toBeLessThan(2_000);
	});

	it("show_image 新旧 details 形状剥掉 base64，路径与工具文本保留", () => {
		const data = bigBase64(4096);
		for (const details of [
			{ paths: ["a.png"], images: [{ data, mimeType: PNG }] },
			{ path: "a.png", image: { data, mimeType: PNG } },
		]) {
			const { entries } = showImageEntries({ assistant: "a1", tool: "t1" }, null, details);
			const tool = entries[1] as unknown as {
				message: { content: Array<{ text?: string }>; details: { paths?: string[]; path?: string } };
			};
			const stripped = stripEntryImageData(entries[1] as SessionEntry) as unknown as typeof tool;
			expect(JSON.stringify(stripped)).not.toContain(data);
			expect(stripped.message.content[0]?.text).toBe("Image displayed to the user");
			expect(stripped.message.details.paths ?? [stripped.message.details.path]).toEqual(["a.png"]);
		}
	});

	it("超大附件 turn 仍可完整成页（默认预算也不会误报超限）", () => {
		const data = bigBase64(2 * 1024 * 1024);
		const branch = [userWithImageEntry("u1", null, "大图", data)];
		const pager = new SessionHistoryPager({
			sessionId: "session-1",
			instanceId: "instance-1",
			version: 1,
			entries: branch,
			measureEntry: measureEntryWithoutImageData,
		});
		const page = pager.tail();
		expect(page.entries).toEqual(branch);
		expect(page.hasOlder).toBe(false);
	});

	it("预算只在候选 turn 上惰性测量，不预先序列化整条分支", () => {
		const branch: SessionEntry[] = [];
		let parentId: string | null = null;
		for (let i = 0; i < 20; i++) {
			const user = messageEntry(
				{ role: "user", content: `问题 ${i} ` + "x".repeat(90 * 1024), timestamp: i * 10 },
				`u${i}`,
				parentId,
			);
			const assistant = messageEntry(
				{ role: "assistant", content: [{ type: "text", text: "答" }], timestamp: i * 10 + 1 },
				`a${i}`,
				`u${i}`,
			);
			branch.push(user, assistant);
			parentId = `a${i}`;
		}
		const measure = vi.fn(measureEntryWithoutImageData);
		const pager = new SessionHistoryPager({
			sessionId: "session-1",
			instanceId: "instance-1",
			version: 1,
			entries: branch,
			measureEntry: measure,
		});
		expect(measure).not.toHaveBeenCalled();

		const page = pager.tail();
		expect(page.entries.length).toBeGreaterThan(0);
		expect(page.entries.length).toBeLessThan(branch.length);
		// 只测到「候选 turn 停止」的位置，远少于整条分支的 entry 数。
		expect(measure.mock.calls.length).toBeLessThan(branch.length);
		const pageBytes = encoder.encode(JSON.stringify(page.entries)).length;
		expect(pageBytes).toBeLessThanOrEqual(HISTORY_TARGET_BYTES);
	});
});
