import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { projectSessionHoverTask } from "@percho/shared";
import { fileMatchesId, HISTORY_BYTES, parseHistory, validatedBranch } from "./hover-history";
import { isSessionPathDescendant, backendSessionPathKey as pathKey } from "./session-paths";
import { validateOrdinarySessionFile, validateSubagentSessionFile } from "./subagent-paths";
import {
	findRelationAnchor,
	relationObject as object,
	parseRelationRecord,
	type RelationRecordV1,
	relationRecordKey,
	relationText,
	SUBAGENT_RELATION_CUSTOM_TYPE,
} from "./subagent-relation-records";

const MAX_TRACE_BYTES = 160 * 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_TRACES = 6;
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function decodeJson(raw: Buffer): Entry {
	try {
		const value: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(raw));
		if (!object(value)) throw new Error("expected an evidence object");
		return value;
	} catch {
		throw new Error("invalid JSON/UTF-8 evidence object");
	}
}
const samePath = (a: string, b: string) => pathKey(resolve(a)) === pathKey(resolve(b));
type Entry = Record<string, unknown>;
export interface RecoveryOptions {
	parentFiles: string[];
	agentDir: string;
}
export interface RecoveryCandidate {
	record: RelationRecordV1;
	traceFile: string;
	traceStartFile: string;
	traceStartLine: number;
	traceEndLine: number;
	childHash: string;
}
export interface ParentReport {
	parentFile: string;
	parentLeaf: string | null;
	parentHash: string;
	parentSessionId: string;
	traces: Array<{ file: string; hash?: string; bytes?: number; issue?: string }>;
	candidates: RecoveryCandidate[];
	rejected: Array<{ reason: string; evidence?: unknown }>;
	gaps: Array<{ traceFile: string; line: number }>;
	budget: string[];
	conflicts: unknown[];
	existing: number;
	append: number;
	originalMessageHash: string;
}
export interface RecoveryReport {
	version: 1;
	generatedAt: string;
	agentDir: string;
	parents: ParentReport[];
}
type TraceEvent = { event: Entry; file: string; line: number; signature: string };
type Pair = { start?: TraceEvent; end?: TraceEvent; conflict?: boolean };

async function boundedFile(file: string, limit: number): Promise<Buffer> {
	const handle = await open(file, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > limit) throw new Error("file exceeds byte budget or is not regular");
		const buffer = Buffer.alloc(info.size + 1);
		let used = 0;
		while (used < buffer.length) {
			const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
			if (!bytesRead) break;
			used += bytesRead;
		}
		if (used !== info.size) throw new Error("file changed while reading");
		return buffer.subarray(0, used);
	} finally {
		await handle.close();
	}
}
function parentSnapshot(raw: Buffer, file: string) {
	const entries = parseHistory(new TextDecoder("utf8", { fatal: true }).decode(raw));
	const header = entries[0];
	if (
		!object(header) ||
		header.type !== "session" ||
		typeof header.id !== "string" ||
		!fileMatchesId(file, header.id) ||
		typeof header.cwd !== "string" ||
		!isAbsolute(header.cwd)
	)
		throw new Error("invalid parent identity");
	const body = entries.slice(1),
		last = body.at(-1);
	const leaf = object(last) && typeof last.id === "string" ? last.id : null;
	const branch = validatedBranch(body, leaf);
	return { id: header.id, cwd: header.cwd, branch, body, leaf };
}

/** Retain only calls explicitly recorded by a current-branch outer result, never inspect source code. */
function delegatedCalls(branch: readonly Entry[]) {
	const calls = new Map<string, { anchor: string; root: string }>();
	const conflicts = new Set<string>();
	for (const entry of branch) {
		const message = entry.message;
		if (
			entry.type !== "message" ||
			!object(message) ||
			message.role !== "toolResult" ||
			message.toolName !== "codemode" ||
			typeof message.toolCallId !== "string"
		)
			continue;
		const anchor = findRelationAnchor(branch, message.toolCallId);
		if (!anchor) continue;
		const details = object(message.details) ? message.details : {};
		const nested = object(message.nestedCalls) ? message.nestedCalls : {};
		for (const raw of [
			...(Array.isArray(details.calls) ? details.calls : []),
			...(Array.isArray(nested.calls) ? nested.calls : []),
		]) {
			if (!object(raw) || raw.name !== "subagent" || !relationText(raw.id)) continue;
			const claim = { anchor, root: message.toolCallId };
			const previous = calls.get(raw.id);
			if (previous && (previous.root !== claim.root || previous.anchor !== claim.anchor))
				conflicts.add(raw.id);
			calls.set(raw.id, claim);
		}
	}
	for (const id of conflicts) calls.delete(id);
	return calls;
}

/** Chunk-level bounds: an oversized line is discarded without ever buffering the complete line. */
async function scanTrace(
	file: string,
	limit: number,
	line: (value: unknown, number: number) => void,
	problem: (message: string) => void,
) {
	const handle = await open(file, "r"),
		digest = createHash("sha256");
	let pending = Buffer.alloc(0),
		dropping = false,
		lineNo = 0,
		total = 0;
	const consume = (fragment: Buffer, complete: boolean) => {
		if (!dropping) {
			if (pending.length + fragment.length > MAX_LINE_BYTES) {
				problem(`line ${lineNo + 1} exceeds 2 MiB`);
				pending = Buffer.alloc(0);
				dropping = true;
			} else pending = Buffer.concat([pending, fragment]);
		}
		if (!complete) return;
		lineNo++;
		if (!dropping && pending.length) {
			try {
				line(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(pending)), lineNo);
			} catch {
				problem(`invalid JSON/UTF-8 at line ${lineNo}`);
			}
		}
		pending = Buffer.alloc(0);
		dropping = false;
	};
	try {
		for (;;) {
			const buffer = Buffer.allocUnsafe(64 * 1024);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (!bytesRead) break;
			total += bytesRead;
			if (total > limit) throw new Error("trace byte budget exceeded or file grew");
			const chunk = buffer.subarray(0, bytesRead);
			digest.update(chunk);
			let start = 0;
			for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
				consume(chunk.subarray(start, end), true);
				start = end + 1;
			}
			consume(chunk.subarray(start), false);
		}
		if (pending.length || dropping) consume(Buffer.alloc(0), true);
		return { hash: digest.digest("hex"), bytes: total };
	} finally {
		await handle.close();
	}
}
async function tracePairs(report: ParentReport, calls: ReturnType<typeof delegatedCalls>) {
	const directory = join(dirname(report.parentFile), "traces"),
		pairs = new Map<string, Pair>();
	let captureBytes = 0,
		total = 0;
	const escaped = report.parentSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`^trace-${escaped}(?:\\.\\d{4}-\\d{2}-\\d{2}T[0-9-]+Z)?\\.jsonl$`);
	try {
		const realParentDir = await realpath(dirname(report.parentFile)),
			realDir = await realpath(directory);
		if (!isSessionPathDescendant(realParentDir, realDir)) throw new Error("unsafe trace directory");
		const names = (await readdir(directory)).filter((name) => pattern.test(name)).sort();
		if (names.length > MAX_TRACES) throw new Error("trace count exceeds 6");
		for (const name of names) {
			const file = join(directory, name),
				actual = await realpath(file),
				info = await stat(file);
			if (!info.isFile() || !isSessionPathDescendant(realDir, actual)) throw new Error("unsafe trace file");
			total += info.size;
			if (total > MAX_TRACE_BYTES) throw new Error("trace total exceeds 160 MiB");
			const issues: string[] = [];
			const result = await scanTrace(
				file,
				info.size,
				(raw, lineNo) => {
					if (!object(raw)) return;
					if (raw.type === "trace_gap" || raw._truncated === true) {
						if (report.gaps.length < 1024) report.gaps.push({ traceFile: file, line: lineNo });
						else if (!report.budget.includes("trace gaps exceed 1024"))
							report.budget.push("trace gaps exceed 1024");
					}
					if (
						(raw.type !== "tool_execution_start" && raw.type !== "tool_execution_end") ||
						raw.toolName !== "subagent" ||
						typeof raw.toolCallId !== "string" ||
						!calls.has(raw.toolCallId)
					)
						return;
					const claim = calls.get(raw.toolCallId)!;
					if (raw.parentToolCallId !== claim.root) return; // historical migration supports one codemode nesting level
					const event = {
						ts: raw.ts,
						type: raw.type,
						toolCallId: raw.toolCallId,
						parentToolCallId: raw.parentToolCallId,
						toolName: raw.toolName,
						...(raw.type === "tool_execution_start"
							? { args: raw.args }
							: { result: { details: object(raw.result) ? raw.result.details : undefined } }),
					};
					const signature = JSON.stringify(event),
						slot = raw.type === "tool_execution_start" ? "start" : "end";
					const pair = pairs.get(raw.toolCallId) ?? {};
					if (pair[slot]) {
						if (pair[slot]!.signature !== signature) pair.conflict = true;
					} else {
						captureBytes += Buffer.byteLength(signature);
						if (captureBytes > MAX_CAPTURE_BYTES) {
							if (!report.budget.includes("retained invocation evidence exceeds 8 MiB"))
								report.budget.push("retained invocation evidence exceeds 8 MiB");
							return;
						}
						pair[slot] = { event, file, line: lineNo, signature };
					}
					pairs.set(raw.toolCallId, pair);
				},
				(issue) => {
					if (issues.length < 32) issues.push(issue);
				},
			);
			if (result.bytes !== info.size) throw new Error("trace changed while reading");
			report.traces.push({ file, ...result, ...(issues.length ? { issue: issues.join("; ") } : {}) });
			if (issues.length)
				report.budget.push(`${name}: incomplete lines; no automatic recovery from this parent`);
		}
	} catch (error) {
		report.budget.push(String(error));
	}
	if (report.budget.length) pairs.clear();
	return pairs;
}

async function buildCandidate(
	callId: string,
	claim: { anchor: string; root: string },
	pair: Pair,
	report: ParentReport,
	cwd: string,
	agentDir: string,
) {
	if (pair.conflict) throw new Error("conflicting trace records for one invocation");
	if (!pair.start || !pair.end) throw new Error("missing trace start/end");
	const s = pair.start.event,
		e = pair.end.event,
		input = s.args;
	const details = object(e.result) ? e.result.details : undefined;
	if (!object(input) || !object(details) || !Array.isArray(details.results))
		throw new Error("incomplete start args/end details");
	const inputs = Array.isArray(input.tasks) && input.tasks.length ? input.tasks : [input];
	if (inputs.length > 8 || inputs.length !== details.results.length)
		throw new Error("input/result slot count mismatch");
	const start = s.ts,
		end = e.ts;
	if (
		typeof start !== "number" ||
		typeof end !== "number" ||
		!Number.isFinite(start) ||
		!Number.isFinite(end) ||
		start <= 0 ||
		end < start
	)
		throw new Error("invalid invocation timestamps");
	const runs: NonNullable<RelationRecordV1["runs"]> = [],
		children: Array<{ file: string; hash: string }> = [];
	for (const [index, result] of details.results.entries()) {
		const task = inputs[index];
		if (
			!object(task) ||
			!relationText(task.agent) ||
			typeof task.task !== "string" ||
			!object(result) ||
			typeof result.agent !== "string" ||
			task.agent.toLowerCase() !== result.agent.toLowerCase() ||
			task.task !== result.task
		)
			throw new Error("result agent/task mismatch");
		const file = object(result.artifactPaths) ? result.artifactPaths.jsonlPath : undefined;
		if (file === undefined) {
			report.rejected.push({ reason: "child has no persisted file", evidence: { callId, index } });
			continue;
		}
		if (!relationText(file)) throw new Error("invalid child path");
		const safe = await validateSubagentSessionFile(file, agentDir);
		if (!safe) throw new Error("unsafe child path");
		const raw = await boundedFile(safe, HISTORY_BYTES),
			newline = raw.indexOf(10);
		if (newline < 0 || newline > 128 * 1024) throw new Error("invalid child header size");
		const header = decodeJson(raw.subarray(0, newline));
		const expectedCwd = task.cwd ?? cwd;
		if (
			!object(header) ||
			header.type !== "session" ||
			typeof header.id !== "string" ||
			!fileMatchesId(safe, header.id) ||
			typeof header.cwd !== "string" ||
			!isAbsolute(header.cwd) ||
			typeof expectedCwd !== "string" ||
			!isAbsolute(expectedCwd) ||
			!samePath(header.cwd, expectedCwd)
		)
			throw new Error("child identity/cwd mismatch");
		const created = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
		if (!Number.isFinite(created) || created < start || created > end)
			throw new Error("child timestamp outside invocation");
		const first = task.task.split(/\r?\n/, 1)[0],
			taskFirstLine = relationText(first) ? projectSessionHoverTask(first, safe) : undefined;
		runs.push({
			agent: result.agent,
			sessionFile: safe,
			...(taskFirstLine ? { taskFirstLine } : {}),
			...(typeof result.exitCode === "number" && Number.isFinite(result.exitCode)
				? { exitCode: result.exitCode }
				: {}),
		});
		children.push({ file: safe, hash: hash(raw) });
	}
	const record = parseRelationRecord({
		version: 1,
		origin: "trace-recovery",
		parentSessionId: report.parentSessionId,
		parentSessionFile: report.parentFile,
		anchorEntryId: claim.anchor,
		rootToolCallId: claim.root,
		toolCallId: callId,
		parentToolCallId: claim.root,
		toolName: "subagent",
		startedAt: start,
		finishedAt: end,
		runs,
	});
	if (!record) throw new Error("no valid bounded child relation");
	return {
		record,
		childHash: hash(JSON.stringify(children)),
		traceFile: pair.end.file,
		traceStartFile: pair.start.file,
		traceStartLine: pair.start.line,
		traceEndLine: pair.end.line,
	} satisfies RecoveryCandidate;
}

export async function createRecoveryReport(options: RecoveryOptions): Promise<RecoveryReport> {
	if (!isAbsolute(options.agentDir) || options.parentFiles.length > 100)
		throw new Error("explicit absolute agent directory and at most 100 parent files required");
	const reports: ParentReport[] = [];
	const establishedOwners = new Map<string, Set<string>>();
	for (const file of [...new Set(options.parentFiles.map(resolvePath))]) {
		const report: ParentReport = {
			parentFile: file,
			parentLeaf: null,
			parentHash: "",
			parentSessionId: "",
			traces: [],
			candidates: [],
			rejected: [],
			gaps: [],
			budget: [],
			conflicts: [],
			existing: 0,
			append: 0,
			originalMessageHash: "",
		};
		reports.push(report);
		try {
			if (!(await validateOrdinarySessionFile(file, options.agentDir)))
				throw new Error("parent outside authorized sessions directory");
			const raw = await boundedFile(file, HISTORY_BYTES),
				snapshot = parentSnapshot(raw, file);
			Object.assign(report, {
				parentHash: hash(raw),
				parentLeaf: snapshot.leaf,
				parentSessionId: snapshot.id,
				originalMessageHash: hash(
					JSON.stringify(snapshot.body.filter((e) => object(e) && e.type === "message")),
				),
			});
			const calls = delegatedCalls(snapshot.branch),
				pairs = await tracePairs(report, calls);
			const existing = new Map<string, string>();
			for (const entry of snapshot.branch) {
				if (entry.type !== "custom" || entry.customType !== SUBAGENT_RELATION_CUSTOM_TYPE) continue;
				const record = parseRelationRecord(entry.data);
				if (record) {
					existing.set(relationRecordKey(record), JSON.stringify(record));
					if (
						record.parentSessionId === snapshot.id &&
						samePath(record.parentSessionFile, file) &&
						findRelationAnchor(snapshot.branch, record.rootToolCallId) === record.anchorEntryId
					) {
						for (const run of record.runs ?? []) {
							const key = pathKey(run.sessionFile),
								owners = establishedOwners.get(key) ?? new Set<string>();
							owners.add(relationRecordKey(record));
							establishedOwners.set(key, owners);
						}
					}
				}
			}
			for (const [id, claim] of calls) {
				try {
					const candidate = await buildCandidate(
						id,
						claim,
						pairs.get(id) ?? {},
						report,
						snapshot.cwd,
						options.agentDir,
					);
					const previous = existing.get(relationRecordKey(candidate.record));
					if (previous) {
						if (previous !== JSON.stringify(candidate.record))
							throw new Error("existing relation conflicts with evidence");
						report.existing++;
					} else report.candidates.push(candidate);
				} catch (error) {
					report.rejected.push({
						reason: String(error),
						evidence: { callId: id, rootToolCallId: claim.root },
					});
				}
			}
			if (hash(await boundedFile(file, HISTORY_BYTES)) !== report.parentHash)
				throw new Error("parent changed during scan");
		} catch (error) {
			report.rejected.push({ reason: String(error) });
			report.candidates = [];
		}
	}
	// Conflict rejection must remove ALL owners, not just whichever was scanned second.
	const owners = new Map<string, Array<{ report: ParentReport; candidate: RecoveryCandidate }>>();
	for (const report of reports)
		for (const candidate of report.candidates)
			for (const run of candidate.record.runs ?? []) {
				const key = pathKey(run.sessionFile),
					list = owners.get(key) ?? [];
				list.push({ report, candidate });
				owners.set(key, list);
			}
	for (const [file, list] of owners) {
		const identities = new Set(establishedOwners.get(file) ?? []);
		for (const { candidate } of list) identities.add(relationRecordKey(candidate.record));
		if (identities.size > 1 || list.length > 1)
			for (const { report, candidate } of list) {
				report.conflicts.push({ childFile: file, toolCallId: candidate.record.toolCallId });
				report.candidates = report.candidates.filter((c) => c !== candidate);
			}
	}
	for (const report of reports) report.append = report.candidates.length;
	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		agentDir: resolve(options.agentDir),
		parents: reports,
	};
}
function resolvePath(file: string) {
	return resolve(file);
}

interface ApplyResult {
	parentFile: string;
	status: "applied" | "unchanged" | "rejected" | "failed";
	backup?: string;
	appliedHash?: string;
	error?: string;
}
export async function applyRecoveryReport(
	reviewed: RecoveryReport,
	options: RecoveryOptions,
	confirmation: boolean,
): Promise<ApplyResult[]> {
	if (!confirmation) throw new Error("apply requires explicit host-closed confirmation");
	if (
		reviewed.version !== 1 ||
		!samePath(reviewed.agentDir, options.agentDir) ||
		JSON.stringify(reviewed.parents.map((p) => resolve(p.parentFile)).sort()) !==
			JSON.stringify([...new Set(options.parentFiles.map(resolvePath))].sort())
	)
		throw new Error("reviewed report scope differs from explicit authorization");
	const fresh = await createRecoveryReport(options),
		results: ApplyResult[] = [];
	for (const expected of reviewed.parents) {
		const actual = fresh.parents.find((parent) => parent.parentFile === expected.parentFile);
		if (
			!actual ||
			actual.parentHash !== expected.parentHash ||
			actual.parentLeaf !== expected.parentLeaf ||
			JSON.stringify(actual.traces) !== JSON.stringify(expected.traces) ||
			JSON.stringify(actual.candidates) !== JSON.stringify(expected.candidates) ||
			JSON.stringify(actual.conflicts) !== JSON.stringify(expected.conflicts)
		) {
			results.push({
				parentFile: expected.parentFile,
				status: "rejected",
				error: "parent/leaf/trace/child/candidate changed; regenerate report",
			});
			continue;
		}
		if (!actual.candidates.length) {
			results.push({ parentFile: actual.parentFile, status: "unchanged" });
			continue;
		}
		const lock = `${actual.parentFile}.recovery-lock`,
			temp = `${actual.parentFile}.recovery-${randomUUID()}.tmp`;
		let locked = false,
			backup: string | undefined;
		try {
			const handle = await open(lock, "wx");
			locked = true;
			await handle.close();
			const original = await boundedFile(actual.parentFile, HISTORY_BYTES);
			if (hash(original) !== actual.parentHash) throw new Error("parent changed before apply");
			const snapshot = parentSnapshot(original, actual.parentFile);
			let leaf = snapshot.leaf;
			const additions = actual.candidates.map(({ record }) => {
				const id = randomUUID(),
					entry = {
						id,
						parentId: leaf,
						type: "custom",
						timestamp: new Date().toISOString(),
						customType: SUBAGENT_RELATION_CUSTOM_TYPE,
						data: record,
					};
				leaf = id;
				return entry;
			});
			const next = Buffer.concat([
				original,
				Buffer.from(
					`${original.length && original.at(-1) !== 10 ? "\n" : ""}${additions.map((e) => JSON.stringify(e)).join("\n")}\n`,
				),
			]);
			if (next.length > HISTORY_BYTES) throw new Error("recovery would exceed hover history budget");
			const checked = parentSnapshot(next, actual.parentFile);
			if (
				hash(JSON.stringify(checked.body.filter((e) => object(e) && e.type === "message"))) !==
					actual.originalMessageHash ||
				!additions.every((e) => checked.branch.some((b) => b.id === e.id))
			)
				throw new Error("append validation failed");
			backup = `${actual.parentFile}.recovery-backup-${randomUUID()}`;
			await writeFile(backup, original, { flag: "wx" });
			const manifest = {
				version: 1,
				parentFile: actual.parentFile,
				originalHash: hash(original),
				appliedHash: hash(next),
				agentDir: resolve(options.agentDir),
			};
			await writeFile(`${backup}.json`, JSON.stringify(manifest, null, 2), { flag: "wx" });
			await writeFile(temp, next, { flag: "wx" });
			// Revalidate all reviewed evidence immediately before replacing each parent (hosts must be closed).
			const last = await createRecoveryReport(options),
				verified = last.parents.find((p) => p.parentFile === actual.parentFile);
			if (
				!verified ||
				verified.parentHash !== actual.parentHash ||
				JSON.stringify(verified.traces) !== JSON.stringify(actual.traces) ||
				JSON.stringify(verified.candidates) !== JSON.stringify(actual.candidates)
			)
				throw new Error("evidence changed before atomic replacement");
			await rename(temp, actual.parentFile);
			results.push({
				parentFile: actual.parentFile,
				status: "applied",
				backup,
				appliedHash: manifest.appliedHash,
			});
		} catch (error) {
			results.push({ parentFile: actual.parentFile, status: "failed", backup, error: String(error) });
		} finally {
			await unlink(temp).catch(() => {});
			if (locked) await unlink(lock).catch(() => {});
		}
	}
	return results;
}

export async function rollbackRecovery(
	parentFile: string,
	backupFile: string,
	expectedAppliedHash: string,
	options: { agentDir: string; confirmed: boolean },
): Promise<void> {
	if (!options?.confirmed) throw new Error("rollback requires explicit host-closed confirmation");
	if (
		!(await validateOrdinarySessionFile(parentFile, options.agentDir)) ||
		!samePath(dirname(parentFile), dirname(backupFile)) ||
		!basename(backupFile).startsWith(`${basename(parentFile)}.recovery-backup-`) ||
		(await lstat(backupFile)).isSymbolicLink() ||
		(await lstat(`${backupFile}.json`)).isSymbolicLink() ||
		!samePath(dirname(await realpath(parentFile)), dirname(await realpath(backupFile)))
	)
		throw new Error("unsafe rollback target");
	const manifest = decodeJson(await boundedFile(`${backupFile}.json`, 16 * 1024));
	if (
		!object(manifest) ||
		manifest.version !== 1 ||
		typeof manifest.parentFile !== "string" ||
		!samePath(manifest.parentFile, parentFile) ||
		manifest.appliedHash !== expectedAppliedHash ||
		typeof manifest.agentDir !== "string" ||
		!samePath(manifest.agentDir, options.agentDir)
	)
		throw new Error("invalid backup manifest");
	const current = await boundedFile(parentFile, HISTORY_BYTES);
	if (hash(current) !== expectedAppliedHash) throw new Error("rollback refused: parent changed after apply");
	const backup = await boundedFile(backupFile, HISTORY_BYTES);
	if (hash(backup) !== manifest.originalHash) throw new Error("backup integrity check failed");
	parentSnapshot(backup, parentFile);
	const lock = `${parentFile}.recovery-lock`,
		temp = `${parentFile}.rollback-${randomUUID()}.tmp`;
	const handle = await open(lock, "wx");
	await handle.close();
	try {
		await writeFile(temp, backup, { flag: "wx" });
		if (hash(await boundedFile(parentFile, HISTORY_BYTES)) !== expectedAppliedHash)
			throw new Error("parent changed before rollback");
		await rename(temp, parentFile);
	} finally {
		await unlink(temp).catch(() => {});
		await unlink(lock).catch(() => {});
	}
}
export function recoveryHash(value: Buffer | string): string {
	return hash(value);
}
