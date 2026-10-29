import { open } from "node:fs/promises";
import { basename } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionHoverPreviewResult } from "@percho/shared";
import { backendSessionPathKey } from "./session-paths";

export const HISTORY_BYTES = 8 * 1024 * 1024;
export const FIRST_LINE_BYTES = 128 * 1024;
export type Reason = Extract<SessionHoverPreviewResult, { status: "unavailable" }>["reason"];
export type HoverSessionManager = Pick<SessionManager, "getHeader" | "getEntries" | "getLeafId"> &
	Partial<Pick<SessionManager, "getSessionFile">>;
export type GetLoadedHoverSession = (id: string) => { cwd: string; manager: HoverSessionManager } | undefined;
export interface HoverHistorySnapshot {
	sessionId: string;
	cwd: string;
	sessionFile?: string;
	header: Record<string, unknown>;
	branch: TreeEntry[];
}

const ENTRY_TYPES = new Set([
	"message",
	"thinking_level_change",
	"model_change",
	"usage",
	"compaction",
	"branch_summary",
	"custom",
	"label",
	"session_info",
	"custom_message",
	"context_edit",
]);

export class PreviewFailure extends Error {
	constructor(readonly reason: Reason) {
		super(reason);
	}
}

export function fail(reason: Reason): never {
	throw new PreviewFailure(reason);
}

export function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function checkMemoryBudget(values: readonly unknown[], jsonl = true): void {
	let remaining = HISTORY_BYTES;
	const ancestors = new Set<object>();
	function spend(bytes: number): void {
		remaining -= bytes;
		if (remaining < 0) fail("limit_exceeded");
	}
	function stringSize(text: string): void {
		spend(2);
		for (let i = 0; i < text.length; i++) {
			const code = text.charCodeAt(i);
			if (code === 34 || code === 92) spend(2);
			else if (code < 32)
				spend(code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6);
			else if (code < 128) spend(1);
			else if (code < 2048) spend(2);
			else if (
				code >= 0xd800 &&
				code <= 0xdbff &&
				text.charCodeAt(i + 1) >= 0xdc00 &&
				text.charCodeAt(i + 1) <= 0xdfff
			) {
				spend(4);
				i++;
			} else spend(code >= 0xd800 && code <= 0xdfff ? 6 : 3);
		}
	}
	function visit(value: unknown, depth: number): void {
		if (depth > 128) fail("limit_exceeded");
		if (typeof value === "string") {
			stringSize(value);
			return;
		}
		if (value === null || typeof value === "number" || typeof value === "boolean") {
			spend(JSON.stringify(value).length);
			return;
		}
		if (typeof value !== "object") fail("invalid_history");
		if (ancestors.has(value)) fail("invalid_history");
		ancestors.add(value);
		spend(2);
		if (Array.isArray(value)) {
			for (let i = 0; i < value.length; i++) {
				if (i) spend(1);
				visit(value[i] ?? null, depth + 1);
			}
		} else {
			let first = true;
			for (const key of Object.keys(value)) {
				const item = (value as Record<string, unknown>)[key];
				if (item === undefined) continue;
				if (!first) spend(1);
				first = false;
				stringSize(key);
				spend(1);
				visit(item, depth + 1);
			}
		}
		ancestors.delete(value);
	}
	for (const value of values) {
		visit(value, 0);
		if (jsonl) spend(1); // JSONL 换行；实时候选按独立 JSON 数组计量
	}
}

export interface TreeEntry extends Record<string, unknown> {
	id: string;
	parentId: string | null;
	type: string;
}

export function validatedBranch(entries: readonly unknown[], leaf: string | null): TreeEntry[] {
	const byId = new Map<string, TreeEntry>();
	for (const raw of entries) {
		if (
			!object(raw) ||
			typeof raw.id !== "string" ||
			!raw.id ||
			typeof raw.type !== "string" ||
			!ENTRY_TYPES.has(raw.type) ||
			!(raw.parentId === null || (typeof raw.parentId === "string" && raw.parentId))
		) {
			fail("invalid_history");
		}
		if (byId.has(raw.id)) fail("invalid_history");
		if (raw.type === "message") {
			if (!object(raw.message) || typeof raw.message.role !== "string") fail("invalid_history");
			if (raw.message.role === "user") {
				const content = raw.message.content;
				if (typeof content !== "string") {
					if (!Array.isArray(content)) fail("invalid_history");
					for (const part of content) {
						if (
							!object(part) ||
							typeof part.type !== "string" ||
							(part.type === "text" && typeof part.text !== "string")
						)
							fail("invalid_history");
					}
				}
			}
		}
		byId.set(raw.id, raw as TreeEntry);
	}
	// 线性验证整张树，既不让坏的旁支绕过校验，也不反复遍历共同祖先。
	const checked = new Set<string>();
	for (const id of byId.keys()) {
		let cursor: string | null = id;
		const path = new Set<string>();
		while (cursor !== null && !checked.has(cursor)) {
			if (path.has(cursor)) fail("invalid_history");
			path.add(cursor);
			const entry = byId.get(cursor);
			if (!entry) fail("invalid_history");
			cursor = entry.parentId;
		}
		for (const item of path) checked.add(item);
	}
	const branch: TreeEntry[] = [];
	let cursor = leaf;
	while (cursor !== null) {
		const entry = byId.get(cursor);
		if (!entry) fail("invalid_history");
		branch.push(entry);
		cursor = entry.parentId;
	}
	return branch.reverse();
}

export function fileMatchesId(file: string, id: string): boolean {
	const name = basename(file).replace(/\.jsonl$/i, "");
	const separator = name.lastIndexOf("_");
	return separator >= 0 && name.slice(separator + 1) === id;
}

export function parseHistory(content: string): unknown[] {
	try {
		return content
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));
	} catch {
		return fail("invalid_history");
	}
}

export async function readBounded(file: string): Promise<string> {
	const handle = await open(file, "r");
	try {
		if ((await handle.stat()).size > HISTORY_BYTES) fail("limit_exceeded");
		const chunks: Buffer[] = [];
		let total = 0;
		while (total <= HISTORY_BYTES) {
			const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, HISTORY_BYTES + 1 - total));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > HISTORY_BYTES) fail("limit_exceeded");
			chunks.push(buffer.subarray(0, bytesRead));
		}
		// 非法 UTF-8 不以替换字符冒充原文。
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
		} catch {
			return fail("invalid_history");
		}
	} finally {
		await handle.close();
	}
}

export function verifyIdentity(
	header: unknown,
	sessionId: string,
	cwd: string,
): asserts header is Record<string, unknown> & { id: string; cwd: string } {
	if (!object(header) || header.type !== "session") fail("invalid_history");
	if (
		header.id !== sessionId ||
		typeof header.cwd !== "string" ||
		backendSessionPathKey(header.cwd) !== backendSessionPathKey(cwd)
	)
		fail("identity_mismatch");
}

/** 只读完整内存树；不构造会话、不依赖模型上下文。 */
export function readLoadedHoverHistory(
	sessionId: string,
	cwd: string,
	registeredCwd: string,
	manager: HoverSessionManager,
): HoverHistorySnapshot {
	if (backendSessionPathKey(registeredCwd) !== backendSessionPathKey(cwd)) fail("identity_mismatch");
	const header = manager.getHeader();
	verifyIdentity(header, sessionId, cwd);
	const entries = manager.getEntries();
	checkMemoryBudget([header, ...entries]);
	const branch = validatedBranch(entries, manager.getLeafId());
	return { sessionId, cwd: header.cwd, sessionFile: manager.getSessionFile?.(), header, branch };
}

export async function readFileHoverHistory(
	sessionId: string,
	cwd: string,
	file: string,
): Promise<HoverHistorySnapshot> {
	const entries = parseHistory(await readBounded(file));
	const header = entries[0];
	verifyIdentity(header, sessionId, cwd);
	const body = entries.slice(1);
	const last = body.at(-1);
	const leaf = object(last) && typeof last.id === "string" ? last.id : null;
	return { sessionId, cwd: header.cwd, sessionFile: file, header, branch: validatedBranch(body, leaf) };
}
