import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	extractSubagentRuns,
	projectSessionHoverAgent,
	projectSessionHoverTask,
	type SessionHoverLiveRun,
	type SessionHoverPreviewResult,
	type SessionHoverRelationChild,
	type SessionHoverRelationParent,
	safeUserFirstLine,
} from "@percho/shared";
import { PiSubagentRelationLimitError, resolvePiSubagentRelations } from "./pi-subagent-relations";
import { validateOrdinarySessionFile, validateSubagentSessionFile } from "./subagent-paths";

export { safeUserFirstLine } from "@percho/shared";

const HISTORY_BYTES = 8 * 1024 * 1024;
const FIRST_LINE_BYTES = 128 * 1024;
const MAX_RELATIONS = 6;
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

/** 以 JSONL 的 UTF-8 体积衡量内存快照；在序列化/复制大字符串之前中止。 */
function checkMemoryBudget(values: readonly unknown[], jsonl = true): void {
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

/** 同路径保留最新派工，排序认分支出现顺序而不是不可靠的时间戳。 */
function pathKey(file: string): string {
	const normalized = resolve(file);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function liveStatus(
	run: SessionHoverLiveRun,
	previous?: SessionHoverRelationChild,
): SessionHoverRelationChild["status"] {
	if (run.status === "running") return "running";
	if (run.exitCode !== undefined) return run.exitCode === 0 ? "done" : "error";
	if (run.status === "error") return "error";
	return previous?.status ?? "unknown";
}

function mergeLiveRelations(
	history: SessionHoverRelationChild[],
	runs: SessionHoverLiveRun[],
): SessionHoverRelationChild[] {
	if (!Array.isArray(runs)) fail("limit_exceeded");
	// 先有界遍历，不能先 JSON.stringify 无界的 IPC 输入再量体积。
	try {
		checkMemoryBudget([runs], false);
	} catch {
		fail("limit_exceeded");
	}
	for (const run of runs) {
		if (
			!object(run) ||
			typeof run.sessionFile !== "string" ||
			typeof run.agent !== "string" ||
			(run.task !== undefined && typeof run.task !== "string") ||
			(run.exitCode !== undefined && (typeof run.exitCode !== "number" || !Number.isFinite(run.exitCode))) ||
			(run.status !== "running" && run.status !== "done" && run.status !== "error") ||
			(run.source !== "committed" && run.source !== "streaming")
		)
			fail("limit_exceeded");
	}
	const byPath = new Map<string, SessionHoverRelationChild>();
	for (const child of history) {
		const key = pathKey(child.sessionFile);
		byPath.delete(key);
		byPath.set(key, child);
	}
	// committed 只覆盖当前分支已有行；不能靠旧 transcript 复活撤回的派工。
	for (const run of runs) {
		if (run.source !== "committed" || !isAbsolute(run.sessionFile)) continue;
		const key = pathKey(run.sessionFile);
		const previous = byPath.get(key);
		if (previous) byPath.set(key, { ...previous, status: liveStatus(run, previous) });
	}
	const streaming = new Map<string, SessionHoverRelationChild>();
	for (const run of runs) {
		if (run.source !== "streaming" || !isAbsolute(run.sessionFile)) continue;
		const key = pathKey(run.sessionFile);
		const previous = streaming.get(key) ?? byPath.get(key);
		const taskFirstLine = projectSessionHoverTask(run.task, run.sessionFile);
		const idMatch = /_([0-9a-fA-F-]{8,})\.jsonl$/i.exec(run.sessionFile);
		byPath.delete(key);
		streaming.delete(key);
		streaming.set(key, {
			...previous,
			sessionFile: run.sessionFile,
			...(idMatch?.[1] ? { sessionId: idMatch[1] } : {}),
			agent: projectSessionHoverAgent(run.agent, run.sessionFile),
			taskFirstLine,
			status: liveStatus(run, previous),
		});
	}
	return [...streaming.values()].reverse().concat([...byPath.values()].reverse());
}

async function withRelations(
	result: SessionHoverPreviewResult,
	items: SessionHoverRelationChild[],
	verifiedPluginFiles: ReadonlySet<string>,
	offset: number,
	parent?: SessionHoverRelationParent,
): Promise<SessionHoverPreviewResult> {
	const valid: SessionHoverRelationChild[] = [];
	for (let i = 0; i < items.length; i += 16) {
		const batch = await Promise.all(
			items.slice(i, i + 16).map(async (item) => {
				const file = verifiedPluginFiles.has(pathKey(item.sessionFile))
					? await validateOrdinarySessionFile(item.sessionFile)
					: await validateSubagentSessionFile(item.sessionFile);
				return file ? { ...item, sessionFile: file } : undefined;
			}),
		);
		for (const item of batch) if (item) valid.push(item);
	}
	if (!valid.length && !parent) return result;
	const hash = createHash("sha256");
	for (const item of valid) {
		hash.update(
			JSON.stringify([
				item.sessionId ?? null,
				item.sessionFile,
				item.agent,
				item.taskFirstLine ?? null,
				item.status,
				item.createdAt ?? null,
			]),
		);
		hash.update("\n");
	}
	const revision = hash.digest("hex");
	const children = valid.slice(offset, offset + MAX_RELATIONS);
	return {
		...result,
		relations: {
			children,
			hidden: Math.max(0, valid.length - offset - children.length),
			offset,
			total: valid.length,
			revision,
			...(parent ? { parent } : {}),
		},
	};
}

/** 与 messages.ts 一样从 leaf 沿 parentId 回溯；拒绝坏树，不使用 SDK 无防环 getBranch。 */

function validatedBranch(entries: readonly unknown[], leaf: string | null): TreeEntry[] {
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

async function previewEntries(
	sessionId: string,
	branch: readonly TreeEntry[],
	liveRuns: SessionHoverLiveRun[] = [],
	scanParent?: { cwd: string; sessionFile?: string },
	offset = 0,
	relationParent?: SessionHoverRelationParent,
): Promise<SessionHoverPreviewResult> {
	let plugin: Awaited<ReturnType<typeof resolvePiSubagentRelations>> = {
		byEntryId: new Map(),
		validatedFiles: new Set(),
	};
	if (scanParent) {
		try {
			plugin = await resolvePiSubagentRelations(branch, scanParent);
		} catch (error) {
			fail(error instanceof PiSubagentRelationLimitError ? "limit_exceeded" : "read_failed");
		}
	}
	const children: SessionHoverRelationChild[] = [];
	for (const entry of branch) {
		if (entry.type !== "message" || !object(entry.message) || entry.message.role !== "toolResult") continue;
		const pluginChild = plugin.byEntryId.get(entry.id);
		if (pluginChild) {
			children.push(pluginChild);
			continue;
		}
		let runs: ReturnType<typeof extractSubagentRuns>;
		try {
			runs = extractSubagentRuns(entry.message.details);
		} catch {
			continue; // 第三方 details 局部损坏，不破坏其它条目和首条提问
		}
		for (const run of runs ?? []) {
			if (!run.sessionFile) continue;
			const idMatch = /_([0-9a-fA-F-]{8,})\.jsonl$/i.exec(run.sessionFile);
			const createdAt =
				typeof entry.timestamp === "number"
					? entry.timestamp
					: typeof entry.timestamp === "string"
						? Date.parse(entry.timestamp)
						: NaN;
			const taskFirstLine = projectSessionHoverTask(run.task, run.sessionFile);
			children.push({
				sessionFile: run.sessionFile,
				...(idMatch?.[1] ? { sessionId: idMatch[1] } : {}),
				agent: projectSessionHoverAgent(run.agent, run.sessionFile),
				...(taskFirstLine !== undefined ? { taskFirstLine } : {}),
				status:
					run.exitCode == null || !Number.isFinite(run.exitCode)
						? "unknown"
						: run.exitCode === 0
							? "done"
							: "error",
				...(Number.isFinite(createdAt) ? { createdAt } : {}),
			});
		}
	}
	let preview: SessionHoverPreviewResult = { status: "empty", sessionId };
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		if (!object(entry.message) || typeof entry.message.role !== "string") fail("invalid_history");
		if (entry.message.role !== "user") continue;
		const line = safeUserFirstLine(entry.message.content);
		if (line.status === "empty") continue;
		if (line.status !== "ok") {
			preview = { status: "unavailable", sessionId, reason: line.status };
			break;
		}
		if (Buffer.byteLength(line.text, "utf8") > FIRST_LINE_BYTES) {
			preview = { status: "unavailable", sessionId, reason: "limit_exceeded" };
			break;
		}
		preview = { status: "ok", sessionId, source: "current-branch-first-user-text", text: line.text };
		break;
	}
	return withRelations(
		preview,
		mergeLiveRelations(children, liveRuns),
		plugin.validatedFiles,
		offset,
		relationParent,
	);
}

function resultForFailure(sessionId: string, error: unknown, fallback: Reason): SessionHoverPreviewResult {
	return {
		status: "unavailable",
		sessionId,
		reason: error instanceof PreviewFailure ? error.reason : fallback,
	};
}

/** 内存路径读取 entries + 当前 leaf；不使用压缩上下文，不产生写入或模型/扩展调用。 */
export async function previewLoadedSession(
	sessionId: string,
	cwd: string,
	registeredCwd: string,
	manager: Pick<SessionManager, "getHeader" | "getEntries" | "getLeafId"> &
		Partial<Pick<SessionManager, "getSessionFile">>,
	liveRuns: SessionHoverLiveRun[] = [],
	offset = 0,
	getLoadedSession?: (
		id: string,
	) =>
		| {
				cwd: string;
				manager: Pick<SessionManager, "getHeader" | "getEntries" | "getLeafId"> &
					Partial<Pick<SessionManager, "getSessionFile">>;
		  }
		| undefined,
): Promise<SessionHoverPreviewResult> {
	try {
		if (!Number.isSafeInteger(offset) || offset < 0) fail("identity_mismatch");
		if (resolve(registeredCwd) !== resolve(cwd)) fail("identity_mismatch");
		const header = manager.getHeader();
		verifyIdentity(header, sessionId, cwd);
		const entries = manager.getEntries();
		checkMemoryBudget([header, ...entries]);
		const branch = validatedBranch(entries, manager.getLeafId());
		const sessionFile = manager.getSessionFile?.();
		const parent = await resolveParent(header, sessionId, cwd, sessionFile, getLoadedSession);
		return await previewEntries(
			sessionId,
			branch,
			liveRuns,
			{
				cwd,
				sessionFile,
			},
			offset,
			parent,
		);
	} catch (error) {
		return resultForFailure(sessionId, error, "invalid_history");
	}
}

/** 最多读取 8MiB + 一个判定超限字节；即使 stat 后文件增长也不会无界读取。 */
function fileMatchesId(file: string, id: string): boolean {
	const name = basename(file).replace(/\.jsonl$/i, "");
	const separator = name.lastIndexOf("_");
	return separator >= 0 && name.slice(separator + 1) === id;
}

function parseHistory(content: string): unknown[] {
	try {
		return content
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));
	} catch {
		return fail("invalid_history");
	}
}

async function resolveParent(
	childHeader: unknown,
	childId: string,
	childCwd: string,
	childFile: string | undefined,
	getLoadedSession?: (
		id: string,
	) =>
		| {
				cwd: string;
				manager: Pick<SessionManager, "getHeader" | "getEntries" | "getLeafId"> &
					Partial<Pick<SessionManager, "getSessionFile">>;
		  }
		| undefined,
): Promise<SessionHoverRelationParent | undefined> {
	if (!object(childHeader) || typeof childHeader.parentSession !== "string" || !childFile) return undefined;
	try {
		if (!(await validateOrdinarySessionFile(childFile)) || !fileMatchesId(childFile, childId))
			return undefined;
		const parentFile = childHeader.parentSession;
		if (!(await validateOrdinarySessionFile(parentFile)) || pathKey(parentFile) === pathKey(childFile))
			return undefined;
		const parentId = basename(parentFile)
			.replace(/\.jsonl$/i, "")
			.split("_")
			.at(-1);
		if (!parentId || !/^[0-9a-f-]{8,}$/i.test(parentId) || parentId === childId) return undefined;
		const loaded = getLoadedSession?.(parentId);
		let header: unknown;
		let entries: readonly unknown[];
		let leaf: string | null;
		if (loaded) {
			const loadedHeader = loaded.manager.getHeader();
			if (
				resolve(loaded.cwd) !== resolve(childCwd) ||
				!fileMatchesId(loaded.manager.getSessionFile?.() ?? "", parentId) ||
				pathKey(loaded.manager.getSessionFile?.() ?? "") !== pathKey(parentFile)
			)
				return undefined;
			header = loadedHeader;
			entries = loaded.manager.getEntries();
			leaf = loaded.manager.getLeafId();
			checkMemoryBudget([header, ...entries]);
		} else {
			const parsed = parseHistory(await readBounded(parentFile));
			header = parsed[0];
			entries = parsed.slice(1);
			const last = entries.at(-1);
			leaf = object(last) && typeof last.id === "string" ? last.id : null;
		}
		verifyIdentity(header, parentId, childCwd);
		const branch = validatedBranch(entries, leaf);
		const relations = await resolvePiSubagentRelations(branch, { cwd: childCwd, sessionFile: parentFile });
		if (relations.validatedFiles.size > 2048) return undefined;
		const childPath = pathKey(childFile);
		const relation = [...relations.byEntryId.values()].find(
			(item) => item.sessionId === childId && pathKey(item.sessionFile) === childPath,
		);
		if (!relation) return undefined;
		let latestName: unknown;
		for (const entry of branch) {
			if (entry.type === "session_info") latestName = entry.name;
		}
		const name = projectSessionHoverTask(latestName, parentFile);
		return { sessionId: parentId, sessionFile: parentFile, cwd: childCwd, ...(name ? { name } : {}) };
	} catch {
		return undefined;
	}
}

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
	offset = 0,
	getLoadedSession?: (
		id: string,
	) =>
		| {
				cwd: string;
				manager: Pick<SessionManager, "getHeader" | "getEntries" | "getLeafId"> &
					Partial<Pick<SessionManager, "getSessionFile">>;
		  }
		| undefined,
): Promise<SessionHoverPreviewResult> {
	try {
		if (!Number.isSafeInteger(offset) || offset < 0) fail("identity_mismatch");
		const content = await readBounded(file);
		const entries = parseHistory(content);
		verifyIdentity(entries[0], sessionId, cwd);
		const body = entries.slice(1);
		const last = body.at(-1);
		const leaf = object(last) && typeof last.id === "string" ? last.id : null;
		const branch = validatedBranch(body, leaf);
		const parent = await resolveParent(entries[0], sessionId, cwd, file, getLoadedSession);
		return await previewEntries(sessionId, branch, [], { cwd, sessionFile: file }, offset, parent);
	} catch (error) {
		return resultForFailure(sessionId, error, "read_failed");
	}
}
