import { open, opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	projectSessionHoverAgent,
	projectSessionHoverTask,
	type SessionHoverRelationChild,
	sameSessionPath,
} from "@percho/shared";
import { backendSessionPathKey, isSessionPathDescendant } from "./session-paths";
import { ordinarySessionsRoot } from "./subagent-paths";

const DEFAULT_MAX_FILES = 2048;
const DEFAULT_PREFIX = 128 * 1024;
const DEFAULT_TOTAL = 8 * 1024 * 1024;
const CHUNK = 4 * 1024;
type Entry = Record<string, unknown>;
type Claim = {
	entryId: string;
	agentId: string;
	type: string;
	task: string;
	start: number;
	end: number;
	status: SessionHoverRelationChild["status"];
};
export interface PiSubagentResolution {
	byEntryId: Map<string, SessionHoverRelationChild>;
	validatedFiles: Set<string>;
}
export class PiSubagentRelationLimitError extends Error {
	constructor() {
		super("Pi subagent relation scan limit exceeded");
		this.name = "PiSubagentRelationLimitError";
	}
}
function object(value: unknown): value is Entry {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function time(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function agentId(value: unknown): value is string {
	// 0.22.0 的 ID 是截短 UUID，与另行生成的 session header UUID 不是同一 ID。
	return typeof value === "string" && value.length <= 128 && /^[a-f\d]{8}(?:-[a-f\d]+)+$/i.test(value);
}
function terminalStatus(value: unknown): "done" | "error" | undefined {
	if (value === "completed" || value === "done" || value === "success") return "done";
	if (value === "error" || value === "failed" || value === "stopped" || value === "aborted") return "error";
	return undefined;
}

function extractClaims(branch: readonly Entry[]): Claim[] {
	const calls = new Map<string, { type: string; start: number }>();
	const claims = new Map<string, Claim>();
	const conflictingIds = new Set<string>();
	const records = new Map<string, { type: string; end: number; status: "done" | "error" }>();
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === "subagents:record" && object(entry.data)) {
			const d = entry.data;
			const end = time(d.completedAt);
			const status = terminalStatus(d.status);
			if (agentId(d.id) && typeof d.type === "string" && end !== undefined && status) {
				records.set(d.id, { type: d.type, end, status });
			}
		}
		if (entry.type !== "message" || !object(entry.message)) continue;
		const message = entry.message;
		const stamp = time(message.timestamp) ?? time(entry.timestamp);
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (
					!object(block) ||
					block.type !== "toolCall" ||
					block.name !== "Agent" ||
					typeof block.id !== "string"
				)
					continue;
				const args = block.arguments;
				if (!object(args) || (typeof args.resume === "string" && args.resume.trim())) continue;
				if (typeof args.subagent_type !== "string" || stamp === undefined) continue;
				calls.set(block.id, { type: args.subagent_type, start: stamp });
			}
		} else if (
			message.role === "toolResult" &&
			message.toolName === "Agent" &&
			typeof message.toolCallId === "string"
		) {
			const call = calls.get(message.toolCallId);
			const d = message.details;
			if (
				!call ||
				!object(d) ||
				!agentId(d.agentId) ||
				typeof entry.id !== "string" ||
				d.subagentType !== call.type ||
				typeof d.description !== "string" ||
				typeof d.status !== "string" ||
				stamp === undefined ||
				stamp < call.start
			)
				continue;
			const previous = claims.get(d.agentId);
			if (previous && previous.type !== call.type) conflictingIds.add(d.agentId);
			claims.set(d.agentId, {
				entryId: entry.id,
				agentId: d.agentId,
				type: call.type,
				task: d.description,
				start: Math.min(call.start, previous?.start ?? call.start),
				end: Math.max(stamp, previous?.end ?? stamp),
				status: terminalStatus(d.status) ?? "unknown",
			});
		}
	}
	const valid = [...claims.values()].filter((c) => !conflictingIds.has(c.agentId));
	const prefixes = new Map<string, number>();
	for (const claim of valid) {
		const name = `${claim.type}#${claim.agentId.slice(0, 8)}`;
		prefixes.set(name, (prefixes.get(name) ?? 0) + 1);
		const record = records.get(claim.agentId);
		if (record?.type === claim.type && record.end >= claim.start) {
			claim.end = Math.max(claim.end, record.end);
			claim.status = record.status;
		}
	}
	return valid.filter((c) => prefixes.get(`${c.type}#${c.agentId.slice(0, 8)}`) === 1);
}

type Prefix = { header: Entry; name: string };
/** 读到最早 session_info 就结束；不等待巨大 system/user message 整行读完。 */
async function readPrefix(
	file: string,
	maxBytes: number,
	budget: { used: number; max: number },
	acceptHeader: (header: Entry) => boolean,
): Promise<Prefix | undefined> {
	const handle = await open(file, "r");
	let bytes = 0;
	let pending = Buffer.alloc(0);
	let header: Entry | undefined;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	try {
		while (bytes < maxBytes) {
			const length = Math.min(CHUNK, maxBytes - bytes, budget.max - budget.used);
			if (length <= 0) throw new PiSubagentRelationLimitError();
			const chunk = Buffer.allocUnsafe(length);
			const { bytesRead } = await handle.read(chunk, 0, length, null);
			if (!bytesRead) return undefined;
			bytes += bytesRead;
			budget.used += bytesRead;
			pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
			let start = 0;
			for (;;) {
				const end = pending.indexOf(10, start);
				if (end < 0) break;
				const entry: unknown = JSON.parse(decoder.decode(pending.subarray(start, end)));
				if (!object(entry)) return undefined;
				if (!header) {
					if (entry.type !== "session" || !acceptHeader(entry)) return undefined;
					header = entry;
				} else if (entry.type === "message") return undefined;
				else if (entry.type === "session_info") {
					return typeof entry.name === "string" ? { header, name: entry.name } : undefined;
				}
				start = end + 1;
			}
			pending = pending.subarray(start);
			// SDK 将 type 放在最前；尚未有身份元数据就已到 message，不读它的正文。
			if (header && /^\s*\{\s*"type"\s*:\s*"message"\s*[,}]/.test(pending.toString("utf8"))) return undefined;
		}
		throw new PiSubagentRelationLimitError();
	} finally {
		await handle.close();
	}
}

export async function resolvePiSubagentRelations(
	branch: readonly Record<string, unknown>[],
	parent: { sessionFile?: string; cwd: string },
	limits: { maxFiles?: number; maxPrefixBytes?: number; maxTotalBytes?: number } = {},
): Promise<PiSubagentResolution> {
	const result: PiSubagentResolution = { byEntryId: new Map(), validatedFiles: new Set() };
	const claims = extractClaims(branch);
	if (!claims.length || !parent.sessionFile || !isAbsolute(parent.sessionFile) || !isAbsolute(parent.cwd))
		return result;
	const root = resolve(ordinarySessionsRoot());
	const parentFile = resolve(parent.sessionFile);
	if (!isSessionPathDescendant(root, parentFile)) return result;
	const directory = dirname(parentFile);
	let realDirectory: string;
	try {
		const [realRoot, realDir, realParent, info] = await Promise.all([
			realpath(root),
			realpath(directory),
			realpath(parentFile),
			stat(parentFile),
		]);
		if (
			!info.isFile() ||
			(!isSessionPathDescendant(realRoot, realDir) &&
				backendSessionPathKey(realRoot) !== backendSessionPathKey(realDir)) ||
			!isSessionPathDescendant(realDir, realParent)
		)
			return result;
		realDirectory = realDir;
	} catch {
		return result;
	}
	const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
	const maxPrefix = limits.maxPrefixBytes ?? DEFAULT_PREFIX;
	const budget = { used: 0, max: limits.maxTotalBytes ?? DEFAULT_TOTAL };
	const byName = new Map(claims.map((c) => [`${c.type}#${c.agentId.slice(0, 8)}`, c]));
	const matches = new Map<string, { file: string; header: Entry; claim: Claim }[]>();
	let count = 0;
	const dir = await opendir(directory);
	for await (const item of dir) {
		if (extname(item.name).toLowerCase() !== ".jsonl") continue;
		if (++count > maxFiles) throw new PiSubagentRelationLimitError();
		if (!item.isFile() && !item.isSymbolicLink()) continue;
		const file = resolve(directory, item.name);
		if (backendSessionPathKey(file) === backendSessionPathKey(parentFile)) continue;
		let prefix: Prefix | undefined;
		try {
			const [realFile, info] = await Promise.all([realpath(file), stat(file)]);
			if (!info.isFile() || !isSessionPathDescendant(realDirectory, realFile)) continue;
			prefix = await readPrefix(
				file,
				maxPrefix,
				budget,
				(header) =>
					typeof header.cwd === "string" &&
					isAbsolute(header.cwd) &&
					sameSessionPath(resolve(header.cwd), resolve(parent.cwd), process.platform === "win32") &&
					typeof header.parentSession === "string" &&
					isAbsolute(header.parentSession) &&
					sameSessionPath(resolve(header.parentSession), resolve(parentFile), process.platform === "win32"),
			);
		} catch (error) {
			if (error instanceof PiSubagentRelationLimitError) throw error;
			continue;
		}
		if (!prefix) continue;
		const { header, name } = prefix;
		const claim = byName.get(name);
		const created = time(header.timestamp);
		const fileId = basename(file).slice(basename(file).lastIndexOf("_") + 1, -6);
		// sessionId 校验文件身份；agentId 校验派工身份，绝不能混成同一 UUID。
		if (
			!claim ||
			typeof header.id !== "string" ||
			!/^[a-f\d-]{8,}$/i.test(header.id) ||
			fileId !== header.id ||
			created === undefined ||
			created < claim.start ||
			created > claim.end
		)
			continue;
		const found = matches.get(claim.agentId) ?? [];
		found.push({ file, header, claim });
		matches.set(claim.agentId, found);
	}
	for (const found of matches.values()) {
		if (found.length !== 1) continue;
		const { file, header, claim } = found[0]!;
		const taskFirstLine = projectSessionHoverTask(claim.task, file);
		result.byEntryId.set(claim.entryId, {
			sessionId: String(header.id),
			sessionFile: file,
			agent: projectSessionHoverAgent(claim.type, file),
			...(taskFirstLine !== undefined ? { taskFirstLine } : {}),
			status: claim.status,
			createdAt: claim.start,
		});
		result.validatedFiles.add(backendSessionPathKey(file));
	}
	return result;
}
