import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	formatSkillCommand,
	parseExpandedSkillInvocation,
	type SessionHoverPreviewResult,
} from "@percho/shared";

const HISTORY_BYTES = 8 * 1024 * 1024;
const FIRST_LINE_BYTES = 128 * 1024;
type Reason = Extract<SessionHoverPreviewResult, { status: "unavailable" }>["reason"];
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

class PreviewFailure extends Error {
	constructor(readonly reason: Reason) {
		super(reason);
	}
}

function fail(reason: Reason): never {
	throw new PreviewFailure(reason);
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 命名和预览共用的安全投影；不限制普通命名长度，也不返回原始 Skill 正文。 */
export function safeUserFirstLine(
	content: unknown,
): { status: "ok"; text: string } | { status: "empty" | "unsafe_projection" | "invalid_history" } {
	let text: string;
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		const texts: string[] = [];
		for (const part of content) {
			if (!object(part) || typeof part.type !== "string") return { status: "invalid_history" };
			if (part.type !== "text") continue;
			if (typeof part.text !== "string") return { status: "invalid_history" };
			texts.push(part.text);
		}
		text = texts.join(" ");
	} else return { status: "invalid_history" };
	const invocation = parseExpandedSkillInvocation(text);
	// 不把不完整、带前导空白或嵌套的 Skill 包装退化成普通正文。
	const skillMarker = /<\/?skill\b/i;
	if (
		(!invocation && (skillMarker.test(text) || /^\s*References are relative to /i.test(text))) ||
		(invocation && (skillMarker.test(invocation.name) || skillMarker.test(invocation.args ?? "")))
	) {
		return { status: "unsafe_projection" };
	}
	const projected = invocation ? formatSkillCommand(invocation) : text;
	const firstLine = (projected.trim().split("\n", 1)[0] ?? "").trim();
	return firstLine ? { status: "ok", text: firstLine } : { status: "empty" };
}

/** 以 JSONL 的 UTF-8 体积衡量内存快照；在序列化/复制大字符串之前中止。 */
function checkMemoryBudget(values: readonly unknown[]): void {
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
		spend(1); // JSONL 换行
	}
}

function verifyIdentity(header: unknown, sessionId: string, cwd: string): void {
	if (!object(header) || header.type !== "session") fail("invalid_history");
	if (header.id !== sessionId || typeof header.cwd !== "string" || resolve(header.cwd) !== resolve(cwd)) {
		fail("identity_mismatch");
	}
}

interface TreeEntry extends Record<string, unknown> {
	id: string;
	parentId: string | null;
	type: string;
}

/** 与 messages.ts 一样从 leaf 沿 parentId 回溯；额外拒绝歧义/坏树，不使用 SDK 无防环 getBranch。 */
function previewEntries(
	sessionId: string,
	entries: readonly unknown[],
	leaf: string | null,
): SessionHoverPreviewResult {
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
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message") continue;
		if (!object(entry.message) || typeof entry.message.role !== "string") fail("invalid_history");
		if (entry.message.role !== "user") continue;
		const line = safeUserFirstLine(entry.message.content);
		if (line.status === "empty") continue;
		if (line.status !== "ok") fail(line.status);
		if (Buffer.byteLength(line.text, "utf8") > FIRST_LINE_BYTES) fail("limit_exceeded");
		return { status: "ok", sessionId, source: "current-branch-first-user-text", text: line.text };
	}
	return { status: "empty", sessionId };
}

function resultForFailure(sessionId: string, error: unknown, fallback: Reason): SessionHoverPreviewResult {
	return {
		status: "unavailable",
		sessionId,
		reason: error instanceof PreviewFailure ? error.reason : fallback,
	};
}

/** 内存路径读取 entries + 当前 leaf；不使用压缩上下文，不产生写入或模型/扩展调用。 */
export function previewLoadedSession(
	sessionId: string,
	cwd: string,
	registeredCwd: string,
	manager: Pick<SessionManager, "getHeader" | "getEntries" | "getLeafId">,
): SessionHoverPreviewResult {
	try {
		if (resolve(registeredCwd) !== resolve(cwd)) fail("identity_mismatch");
		const header = manager.getHeader();
		verifyIdentity(header, sessionId, cwd);
		const entries = manager.getEntries();
		checkMemoryBudget([header, ...entries]);
		return previewEntries(sessionId, entries, manager.getLeafId());
	} catch (error) {
		return resultForFailure(sessionId, error, "invalid_history");
	}
}

/** 最多读取 8MiB + 一个判定超限字节；即使 stat 后文件增长也不会无界读取。 */
async function readBounded(file: string): Promise<string> {
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

export async function previewSessionFile(
	sessionId: string,
	cwd: string,
	file: string,
): Promise<SessionHoverPreviewResult> {
	try {
		const content = await readBounded(file);
		let entries: unknown[];
		try {
			// SDK parseSessionEntries 仅 JSON.parse 并忽略坏行；此入口必须拒绝坏行，且不迁移。
			entries = content
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line));
		} catch {
			return fail("invalid_history");
		}
		verifyIdentity(entries[0], sessionId, cwd);
		const body = entries.slice(1);
		const last = body.at(-1);
		const leaf = object(last) && typeof last.id === "string" ? last.id : null;
		return previewEntries(sessionId, body, leaf);
	} catch (error) {
		return resultForFailure(sessionId, error, "read_failed");
	}
}
