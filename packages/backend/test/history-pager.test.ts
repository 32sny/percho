import { Buffer } from "node:buffer";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { HISTORY_MAX_BYTES, HISTORY_TARGET_BYTES, SessionHistoryPager } from "../src/session/history-pager";

/**
 * 历史分页内核：固定分支快照上的 tail()/older(cursor)。fixture 只用最小可辨识的
 * SessionEntry 形状（消息体是轻量对象），大页测试才塞入足量文本。
 */

const encoder = new TextEncoder();
const LARGE_TURN = 100 * 1024;

function userEntry(id: string, parentId: string | null, text: string, timestamp: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content: text, timestamp },
	} as unknown as SessionEntry;
}

function assistantEntry(id: string, parentId: string, text: string, timestamp: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			timestamp,
		},
	} as unknown as SessionEntry;
}

/** 一个完整 turn：user 起头 + assistant 收尾；parentId 接在上一条 entry 之后。 */
function turn(index: number, textBytes: number, parentId: string | null): SessionEntry[] {
	const userId = `u${index}`;
	const assistantId = `a${index}`;
	return [
		userEntry(userId, parentId, `问题 ${index}`, index * 10_000),
		assistantEntry(assistantId, userId, `回答 ${index} ${"x".repeat(textBytes)}`, index * 10_000 + 1),
	];
}

function branch(turns: number, textBytes: number): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let parentId: string | null = null;
	for (let i = 0; i < turns; i++) {
		const pair = turn(i, textBytes, parentId);
		entries.push(...pair);
		parentId = pair[pair.length - 1]?.id ?? null;
	}
	return entries;
}

function pagerFor(
	entries: readonly SessionEntry[],
	overrides: Partial<{
		sessionId: string;
		instanceId: string;
		version: number | string;
		generation: string;
	}> = {},
) {
	return new SessionHistoryPager({
		sessionId: "session-1",
		instanceId: "instance-1",
		version: 3,
		entries,
		...overrides,
	});
}

function encodeCursor(payload: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
}

function pageBytes(entries: readonly SessionEntry[]): number {
	return encoder.encode(JSON.stringify(entries)).length;
}

describe("SessionHistoryPager 固定快照分页", () => {
	it("tail() 从最新页开始，连续 older() 拼接后与原分支序列完全一致", () => {
		const entries = branch(6, LARGE_TURN);
		const pager = pagerFor(entries);

		const pages: SessionEntry[][] = [];
		let page = pager.tail();
		pages.push(page.entries);
		expect(page.hasOlder).toBe(true);
		expect(page.cursor).toBeTypeOf("string");
		expect(page.sessionId).toBe("session-1");
		expect(page.generation).toBe(pager.generation);

		let guard = 0;
		while (page.hasOlder) {
			const cursor = page.cursor;
			expect(cursor).toBeTypeOf("string");
			page = pager.older(cursor as string);
			pages.push(page.entries);
			if (++guard > 20) throw new Error("pagination did not converge");
		}

		expect(pages.length).toBeGreaterThan(1);
		// 从最旧页到最新页拼起来必须与原序列逐项相同（不重、不漏、不乱序）。
		expect(pages.reverse().flat()).toEqual(entries);
		// 最新页在尾部，最早页在头部。
		expect(pages[0]?.at(0)).toEqual(entries[0]);
		expect(pages.at(-1)?.at(-1)).toEqual(entries.at(-1));
	});

	it("目标预算按完整 turn 边界缩页，单页不超过 248KiB 且不切开 turn", () => {
		const entries = branch(6, LARGE_TURN);
		const pager = pagerFor(entries);
		const pages: SessionEntry[][] = [];
		let page = pager.tail();
		pages.push(page.entries);
		while (page.hasOlder) {
			page = pager.older(page.cursor as string);
			pages.push(page.entries);
		}

		expect(pages.length).toBe(3);
		for (const entriesInPage of pages) {
			expect(pageBytes(entriesInPage)).toBeLessThanOrEqual(HISTORY_TARGET_BYTES);
			expect(pageBytes(entriesInPage)).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
			// 每页都从 user 起点开始（即完整 turn 边界）。
			const first = entriesInPage[0];
			expect(first?.type === "message" && first.message.role === "user").toBe(true);
		}
	});

	it("尾页 hasOlder=false 且不返回 cursor；空快照返回空页", () => {
		const small = branch(2, 16);
		const page = pagerFor(small).tail();
		expect(page.entries).toEqual(small);
		expect(page.hasOlder).toBe(false);
		expect(page.cursor).toBeUndefined();

		const empty = pagerFor([]).tail();
		expect(empty.entries).toEqual([]);
		expect(empty.hasOlder).toBe(false);
		expect(empty.cursor).toBeUndefined();
		expect(empty.sessionId).toBe("session-1");
	});

	it("同会话返回的 cursor 可以继续翻页", () => {
		const entries = branch(4, LARGE_TURN);
		const pager = pagerFor(entries);
		const first = pager.tail();
		const second = pager.older(first.cursor as string);

		expect(second.hasOlder).toBe(false);
		expect(second.entries).toEqual(entries.slice(0, 4));
		expect([...second.entries, ...first.entries]).toEqual(entries);
	});

	it("跨会话 / 版本 / 实例 / 代次变化的 cursor 一律拒绝", () => {
		const entries = branch(4, LARGE_TURN);
		const cursor = pagerFor(entries).tail().cursor as string;

		expect(() => pagerFor(entries, { sessionId: "session-2" }).older(cursor)).toThrow(
			/HISTORY_CURSOR_INVALID/,
		);
		expect(() => pagerFor(entries, { version: 4 }).older(cursor)).toThrow(/HISTORY_CURSOR_INVALID/);
		expect(() => pagerFor(entries, { instanceId: "instance-2" }).older(cursor)).toThrow(
			/HISTORY_CURSOR_INVALID/,
		);
		expect(() => pagerFor(entries, { generation: "other-generation" }).older(cursor)).toThrow(
			/HISTORY_CURSOR_INVALID/,
		);
	});

	it("畸形 / 超长 / 被篡改的 cursor 拒绝", () => {
		const entries = branch(4, LARGE_TURN);
		const pager = pagerFor(entries);
		const cursor = pager.tail().cursor as string;
		const payload = decodeCursor(cursor);

		const invalid = [
			"",
			"!not-base64url!",
			"a".repeat(5000),
			encodeCursor({}),
			encodeCursor([]),
			Buffer.from("not json", "utf8").toString("base64url"),
			`${cursor}=`,
		];
		for (const value of invalid) {
			expect(() => pager.older(value)).toThrow(/HISTORY_CURSOR_INVALID/);
		}

		const tampered = [
			{ ...payload, anchor: "unknown-entry" },
			{ ...payload, beforeId: "unknown-entry" },
			{ ...payload, before: 1 },
			{ ...payload, before: entries.length },
			{ ...payload, anchorAt: -1 },
			{ ...payload, v: 99 },
		];
		for (const value of tampered) {
			expect(() => pager.older(encodeCursor(value))).toThrow(/HISTORY_CURSOR_INVALID/);
		}
	});

	it("单个 turn 超过硬限时明确抛错，不截断", () => {
		const oversized = branch(1, 1.2 * 1024 * 1024);
		expect(() => pagerFor(oversized).tail()).toThrow(/HISTORY_PAGE_TOO_LARGE/);

		// 超限 turn 在更早位置：最新页正常返回，翻到它时明确失败。
		const entries = [...turn(0, 1.2 * 1024 * 1024, null), ...turn(1, 32, "a0")];
		const pager = pagerFor(entries);
		const tail = pager.tail();
		expect(tail.hasOlder).toBe(true);
		expect(() => pager.older(tail.cursor as string)).toThrow(/HISTORY_PAGE_TOO_LARGE/);
	});

	it("构造后调用方继续追加 entry 不会改变快照或令旧 cursor 失效", () => {
		const entries = branch(4, LARGE_TURN);
		const pager = pagerFor(entries);
		const originalEntries = structuredClone(entries);
		const first = pager.tail();
		const cursor = first.cursor as string;

		entries.push(...turn(4, LARGE_TURN, "a3"));
		entries.push(...turn(5, LARGE_TURN, "a4"));

		const older = pager.older(cursor);
		expect(older.entries).toEqual(originalEntries.slice(0, 4));
		expect([...older.entries, ...first.entries]).toEqual(originalEntries.slice(0, 8));
		// 快照本身也保持不变：tail 仍返回追加前的最后两轮。
		expect(pager.tail().entries).toEqual(first.entries);
		expect(pager.tail().hasOlder).toBe(true);
	});
});
