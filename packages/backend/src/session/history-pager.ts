import { randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionNavigationEntry } from "@percho/shared";
import { buildSessionNavigation } from "./messages";

/**
 * 历史分页内核：对「固定不动的当前分支 SessionEntry[] 快照」做 tail()/older(cursor)
 * 分页，不依赖 PiBackend / IPC / renderer。
 *
 * 缺省预算按原始 entry 的 JSON UTF-8 字节数如实计算（TextEncoder）——图片与工具
 * 结果都是 entry JSON 的一部分。调用方可传 `measureEntry` 给出**懒加载后的轻量**
 * 尺寸（例如剥掉 base64 的引用形态）；measureEntry 只在候选 turn 上惰性调用，不在
 * 构造期序列化整条分支。
 */

/** 目标页预算：原始 entry 数组 JSON 的 UTF-8 字节数。 */
export const HISTORY_TARGET_BYTES = 248 * 1024;
/** 单页硬上限：完整 turn 也不可越过的原始 entry JSON 字节数。 */
export const HISTORY_MAX_BYTES = 1024 * 1024;

/** cursor 自身（base64url 字符串）的长度上限，先于解码拦截损坏/恶意输入。 */
const MAX_CURSOR_LENGTH = 4096;
/** cursor 里各种 id / 版本 token 的单项长度上限。 */
const MAX_CURSOR_FIELD_LENGTH = 512;
const CURSOR_VERSION = 1;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

/** 快照版本（会话内容代次/文件版本等），变化即令旧 cursor 失效。 */
export type HistoryVersion = number | string;

export interface HistoryPagerOptions {
	/** 会话 id；跨会话 cursor 一律拒绝。 */
	sessionId: string;
	/** 快照实例 id（打开/重载会话时由调用方生成）；新实例使旧 cursor 失效。 */
	instanceId: string;
	/** 快照版本；变化即使旧 cursor 失效。 */
	version: HistoryVersion;
	/** 当前分支的固定快照。构造时浅拷贝数组，之后调用方追加不会影响本 pager。 */
	entries: readonly SessionEntry[];
	/** 快照代次；缺省新生成。多进程/重连场景可由调用方显式指定以复用旧 cursor。 */
	generation?: string;
	/**
	 * 单条 entry 的预算字节数；缺省 JSON.stringify(entry) 的 UTF-8 长度。
	 * 逐条惰性调用并缓存，只会测量候选 turn 内的 entry。
	 */
	measureEntry?: (entry: SessionEntry) => number;
}

export interface HistoryPage {
	/** 本页 entries（按分支原顺序，最早 → 最新）。 */
	entries: SessionEntry[];
	/** 更早的历史是否还有下一页。 */
	hasOlder: boolean;
	/** 下一页 cursor；hasOlder 为 false 时不存在。 */
	cursor?: string;
	/** Page start index in the pinned SessionEntry branch. */
	startIndex: number;
	generation: string;
	sessionId: string;
}

/** cursor 结构：v 是 cursor 格式版本，version/sessionId/instanceId/generation 锁定快照。 */
interface CursorPayload {
	v: typeof CURSOR_VERSION;
	version: HistoryVersion;
	sessionId: string;
	instanceId: string;
	generation: string;
	/** 本页最后一条 entry 的 id 与其下标（双重校验，防页面边界被替换）。 */
	anchor: string;
	anchorAt: number;
	/** 下一页的起始下标及该位置 entry 的 id（下一页必须从这条 user entry 开始）。 */
	before: number;
	beforeId: string;
}

export class HistoryCursorError extends Error {
	readonly code = "HISTORY_CURSOR_INVALID";

	constructor(detail: string) {
		super(`HISTORY_CURSOR_INVALID: ${detail}`);
		this.name = "HistoryCursorError";
	}
}

export class HistoryPageTooLargeError extends Error {
	readonly code = "HISTORY_PAGE_TOO_LARGE";

	constructor(detail: string) {
		super(`HISTORY_PAGE_TOO_LARGE: ${detail}`);
		this.name = "HistoryPageTooLargeError";
	}
}

function fail(detail: string): never {
	throw new HistoryCursorError(detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeIndex(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUserEntry(entry: SessionEntry | undefined): boolean {
	return entry?.type === "message" && entry.message.role === "user";
}

function isShortString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_CURSOR_FIELD_LENGTH;
}

function isVersion(value: unknown): value is HistoryVersion {
	if (typeof value === "number") return Number.isFinite(value);
	return isShortString(value);
}

/**
 * 固定快照上的分页器。所有页面都从快照读取，之后的追加/写入不会改变已构造的快照。
 */
export class SessionHistoryPager {
	readonly sessionId: string;
	readonly instanceId: string;
	readonly version: HistoryVersion;
	readonly generation: string;
	private readonly entries: readonly SessionEntry[];
	private readonly measureEntry: (entry: SessionEntry) => number;
	private readonly entryBytes: (number | undefined)[];
	private navigationIndex?: SessionNavigationEntry[];

	constructor(options: HistoryPagerOptions) {
		if (!isShortString(options.sessionId)) throw new Error("History pager requires a non-empty sessionId");
		if (!isShortString(options.instanceId)) throw new Error("History pager requires a non-empty instanceId");
		if (!isVersion(options.version)) throw new Error("History pager requires a valid version");
		if (!Array.isArray(options.entries)) throw new Error("History pager requires an entries array");
		const generation = options.generation ?? randomUUID();
		if (!isShortString(generation)) throw new Error("History pager requires a valid generation");

		this.sessionId = options.sessionId;
		this.instanceId = options.instanceId;
		this.version = options.version;
		this.generation = generation;
		// SessionManager.getBranch() supplies a point-in-time branch array. Copying its references
		// isolates later append/branch-array changes without serializing every historical message.
		this.entries = Object.freeze(options.entries.slice());
		this.measureEntry = options.measureEntry ?? defaultMeasureEntry;
		// 惰性缓存：只有被分页选中的候选 turn 才会测量，大型 base64 附件不在构造期序列化。
		this.entryBytes = new Array<number | undefined>(this.entries.length);
	}

	navigation(): SessionNavigationEntry[] {
		this.navigationIndex ??= buildSessionNavigation(this.entries);
		return this.navigationIndex;
	}

	/** 最新一页（分支尾部）。 */
	tail(): HistoryPage {
		return this.select(this.entries.length);
	}

	/** 继续向更早翻页；cursor 必须是本 pager 针对同一快照发出的。 */
	older(cursor: string): HistoryPage {
		const payload = this.decode(cursor);
		return this.select(payload.before);
	}

	private decode(value: string): CursorPayload {
		if (typeof value !== "string" || value.length === 0) fail("cursor is empty");
		if (value.length > MAX_CURSOR_LENGTH) fail("cursor exceeds its size bound");
		if (!CURSOR_PATTERN.test(value)) fail("cursor is not base64url");
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
		} catch {
			fail("malformed cursor");
		}
		if (!isRecord(parsed)) fail("malformed cursor");

		if (parsed.v !== CURSOR_VERSION) fail("unsupported cursor version");
		if (!isVersion(parsed.version)) fail("cursor version is invalid");
		if (parsed.version !== this.version) fail("cursor version changed");
		if (!isShortString(parsed.sessionId)) fail("cursor sessionId is invalid");
		if (parsed.sessionId !== this.sessionId) fail("cursor belongs to another session");
		if (!isShortString(parsed.instanceId)) fail("cursor instanceId is invalid");
		if (parsed.instanceId !== this.instanceId) fail("cursor belongs to another snapshot instance");
		if (!isShortString(parsed.generation)) fail("cursor generation is invalid");
		if (parsed.generation !== this.generation) fail("cursor generation changed");
		if (!isShortString(parsed.anchor)) fail("cursor anchor is invalid");
		if (!isShortString(parsed.beforeId)) fail("cursor beforeId is invalid");
		if (!isSafeIndex(parsed.anchorAt)) fail("cursor anchorAt is invalid");
		if (!isSafeIndex(parsed.before)) fail("cursor before index is invalid");

		const { anchor, anchorAt, before, beforeId } = parsed;
		if (before < 1 || before >= this.entries.length) fail("cursor before index is out of range");
		if (anchorAt < before || anchorAt >= this.entries.length) fail("cursor anchor index is out of range");

		const beforeEntry = this.entries[before];
		if (!beforeEntry || beforeEntry.id !== beforeId) fail("cursor before entry changed");
		// 只接受 turn 边界：故意不生成指向 turn 中间的 cursor，解码时也不放行。
		if (!isUserEntry(beforeEntry)) fail("cursor before entry is not a user turn boundary");
		const anchorEntry = this.entries[anchorAt];
		if (!anchorEntry || anchorEntry.id !== anchor) fail("cursor anchor entry changed");

		return {
			v: CURSOR_VERSION,
			version: parsed.version,
			sessionId: parsed.sessionId,
			instanceId: parsed.instanceId,
			generation: parsed.generation,
			anchor,
			anchorAt,
			before,
			beforeId,
		};
	}

	/**
	 * 选出 [start, end) 的一页。候选起点只包括 0 与 user entry 下标，因此任何页都
	 * 从完整 turn 的边界开始；从尾部向前逐 turn 扩张，直到目标预算或快照开头。
	 */
	private select(end: number): HistoryPage {
		const start = end === 0 ? 0 : this.chooseStart(end);
		const entries = this.entries.slice(start, end);
		const hasOlder = start > 0;
		let cursor: string | undefined;
		if (hasOlder) {
			const anchor = this.entries[end - 1];
			const before = this.entries[start];
			// chooseStart 只返回 < end 的起点，两处取到的 entry 必然存在。
			if (!anchor || !before) throw new Error("History page boundary is inconsistent");
			const payload: CursorPayload = {
				v: CURSOR_VERSION,
				version: this.version,
				sessionId: this.sessionId,
				instanceId: this.instanceId,
				generation: this.generation,
				anchor: anchor.id,
				anchorAt: end - 1,
				before: start,
				beforeId: before.id,
			};
			cursor = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
		}
		return {
			entries,
			hasOlder,
			startIndex: start,
			...(cursor ? { cursor } : {}),
			generation: this.generation,
			sessionId: this.sessionId,
		};
	}

	private chooseStart(end: number): number {
		let chosen = end;
		let bytes = 2; // JSON array brackets
		for (let i = end - 1; i >= 0; i--) {
			bytes += this.bytesOf(i) + (i < end - 1 ? 1 : 0);
			if (chosen < end && bytes > HISTORY_TARGET_BYTES) break;
			if (i !== 0 && !isUserEntry(this.entries[i])) continue;
			if (bytes > HISTORY_MAX_BYTES) {
				throw new HistoryPageTooLargeError(
					`a complete turn (entries[${i}..${end})) is ${bytes} bytes, above the ${HISTORY_MAX_BYTES}-byte hard limit`,
				);
			}
			chosen = i;
		}
		return chosen;
	}

	private bytesOf(index: number): number {
		const cached = this.entryBytes[index];
		if (cached !== undefined) return cached;
		const entry = this.entries[index];
		const bytes = entry ? this.measureEntry(entry) : 0;
		this.entryBytes[index] = bytes;
		return bytes;
	}
}

function defaultMeasureEntry(entry: SessionEntry): number {
	return encoder.encode(JSON.stringify(entry)).length;
}
