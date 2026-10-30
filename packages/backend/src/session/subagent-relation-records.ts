import { isAbsolute } from "node:path";
import { backendSessionPathKey } from "./session-paths";

export const SUBAGENT_RELATION_CUSTOM_TYPE = "percho.subagent-relation.v1";
const FIELD_LIMIT = 4 * 1024;
const TOTAL_LIMIT = 64 * 1024;

export interface RelationRecordV1 {
	version: 1;
	origin: "runtime" | "trace-recovery";
	parentSessionId: string;
	parentSessionFile: string;
	anchorEntryId: string;
	rootToolCallId: string;
	toolCallId: string;
	parentToolCallId: string;
	toolName: "subagent" | "Agent";
	startedAt: number;
	finishedAt: number;
	runs?: Array<{ agent: string; taskFirstLine?: string; sessionFile: string; exitCode?: number }>;
	claim?: { agentId: string; subagentType: string; description: string; status: string };
}

type Entry = Record<string, unknown>;
export function relationObject(value: unknown): value is Entry {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function relationText(value: unknown, empty = false): value is string {
	return (
		typeof value === "string" &&
		(empty || value.length > 0) &&
		value.length <= FIELD_LIMIT &&
		Buffer.byteLength(value, "utf8") <= FIELD_LIMIT &&
		!value.includes("\0")
	);
}
function exactKeys(value: Entry, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}
const positiveTime = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;

/** Validate before serialization; never stringify an unbounded arbitrary tool result. */
export function parseRelationRecord(value: unknown): RelationRecordV1 | undefined {
	if (
		!relationObject(value) ||
		!exactKeys(value, [
			"version",
			"origin",
			"parentSessionId",
			"parentSessionFile",
			"anchorEntryId",
			"rootToolCallId",
			"toolCallId",
			"parentToolCallId",
			"toolName",
			"startedAt",
			"finishedAt",
			"runs",
			"claim",
		])
	)
		return undefined;
	if (
		value.version !== 1 ||
		(value.origin !== "runtime" && value.origin !== "trace-recovery") ||
		!relationText(value.parentSessionId) ||
		!relationText(value.parentSessionFile) ||
		!isAbsolute(value.parentSessionFile) ||
		!relationText(value.anchorEntryId) ||
		!relationText(value.rootToolCallId) ||
		!relationText(value.toolCallId) ||
		!relationText(value.parentToolCallId) ||
		(value.toolName !== "subagent" && value.toolName !== "Agent") ||
		!positiveTime(value.startedAt) ||
		!positiveTime(value.finishedAt) ||
		value.finishedAt < value.startedAt ||
		(value.parentToolCallId !== value.rootToolCallId &&
			!value.parentToolCallId.startsWith(`${value.rootToolCallId}/`)) ||
		!value.toolCallId.startsWith(`${value.parentToolCallId}/`)
	)
		return undefined;
	const record: RelationRecordV1 = {
		version: 1,
		origin: value.origin,
		parentSessionId: value.parentSessionId,
		parentSessionFile: value.parentSessionFile,
		anchorEntryId: value.anchorEntryId,
		rootToolCallId: value.rootToolCallId,
		toolCallId: value.toolCallId,
		parentToolCallId: value.parentToolCallId,
		toolName: value.toolName,
		startedAt: value.startedAt,
		finishedAt: value.finishedAt,
	};
	if (value.toolName === "subagent") {
		if (
			value.claim !== undefined ||
			!Array.isArray(value.runs) ||
			value.runs.length < 1 ||
			value.runs.length > 8
		)
			return undefined;
		record.runs = [];
		for (const raw of value.runs) {
			if (
				!relationObject(raw) ||
				!exactKeys(raw, ["agent", "taskFirstLine", "sessionFile", "exitCode"]) ||
				!relationText(raw.agent) ||
				!relationText(raw.sessionFile) ||
				!isAbsolute(raw.sessionFile) ||
				(raw.taskFirstLine !== undefined && !relationText(raw.taskFirstLine)) ||
				(raw.exitCode !== undefined && (typeof raw.exitCode !== "number" || !Number.isFinite(raw.exitCode)))
			)
				return undefined;
			record.runs.push({
				agent: raw.agent,
				sessionFile: raw.sessionFile,
				...(raw.taskFirstLine !== undefined ? { taskFirstLine: raw.taskFirstLine } : {}),
				...(raw.exitCode !== undefined ? { exitCode: raw.exitCode } : {}),
			});
		}
	} else {
		const claim = value.claim;
		if (
			value.runs !== undefined ||
			!relationObject(claim) ||
			!exactKeys(claim, ["agentId", "subagentType", "description", "status"]) ||
			!relationText(claim.agentId) ||
			!/^[a-f\d]{8}(?:-[a-f\d]+)+$/i.test(claim.agentId) ||
			claim.agentId.length > 128 ||
			!relationText(claim.subagentType) ||
			!relationText(claim.description, true) ||
			!relationText(claim.status)
		)
			return undefined;
		record.claim = {
			agentId: claim.agentId,
			subagentType: claim.subagentType,
			description: claim.description,
			status: claim.status,
		};
	}
	return Buffer.byteLength(JSON.stringify(record), "utf8") <= TOTAL_LIMIT ? record : undefined;
}

export function relationRecordKey(record: RelationRecordV1): string {
	return [record.parentSessionId, record.anchorEntryId, record.rootToolCallId, record.toolCallId].join("\0");
}

/** One root call must have exactly one assistant owner on the current branch. */
export function findRelationAnchor(branch: readonly Entry[], rootToolCallId: string): string | undefined {
	let anchor: string | undefined;
	for (const entry of branch) {
		if (
			entry.type !== "message" ||
			!relationObject(entry.message) ||
			entry.message.role !== "assistant" ||
			!Array.isArray(entry.message.content)
		)
			continue;
		for (const block of entry.message.content) {
			if (!relationObject(block) || block.type !== "toolCall" || block.id !== rootToolCallId) continue;
			if (anchor !== undefined || typeof entry.id !== "string") return undefined;
			anchor = entry.id;
		}
	}
	return anchor;
}

export function isRelationRecordAnchored(
	recordEntry: unknown,
	branch: readonly Entry[],
	parentSessionId: string,
	parentSessionFile: string,
): boolean {
	if (
		!relationObject(recordEntry) ||
		recordEntry.type !== "custom" ||
		recordEntry.customType !== SUBAGENT_RELATION_CUSTOM_TYPE
	)
		return false;
	const record = parseRelationRecord(recordEntry.data);
	if (
		!record ||
		record.parentSessionId !== parentSessionId ||
		backendSessionPathKey(record.parentSessionFile) !== backendSessionPathKey(parentSessionFile)
	)
		return false;
	const persisted = branch.find((entry) => entry.id === recordEntry.id);
	return (
		persisted?.type === "custom" &&
		persisted.customType === SUBAGENT_RELATION_CUSTOM_TYPE &&
		JSON.stringify(parseRelationRecord(persisted.data)) === JSON.stringify(record) &&
		findRelationAnchor(branch, record.rootToolCallId) === record.anchorEntryId
	);
}

export interface AnchoredRelationRecord {
	entryId: string;
	record: RelationRecordV1;
	anchorIndex: number;
}

/** Shared by forward and reverse queries: all duplicate conflicts fail closed, not last-writer-wins. */
export function collectRelationRecords(
	branch: readonly Entry[],
	sessionId: string,
	sessionFile?: string,
): AnchoredRelationRecord[] {
	if (!sessionFile) return [];
	const byKey = new Map<string, AnchoredRelationRecord>();
	const conflicts = new Set<string>();
	for (const entry of branch) {
		if (
			entry.type !== "custom" ||
			entry.customType !== SUBAGENT_RELATION_CUSTOM_TYPE ||
			typeof entry.id !== "string"
		)
			continue;
		const record = parseRelationRecord(entry.data);
		if (!record || !isRelationRecordAnchored(entry, branch, sessionId, sessionFile)) continue;
		const key = relationRecordKey(record);
		const previous = byKey.get(key);
		if (previous) {
			if (JSON.stringify(previous.record) !== JSON.stringify(record)) conflicts.add(key);
			continue;
		}
		const resultIndex = branch.findIndex(
			(candidate) =>
				candidate.type === "message" &&
				relationObject(candidate.message) &&
				candidate.message.role === "toolResult" &&
				candidate.message.toolCallId === record.rootToolCallId,
		);
		byKey.set(key, {
			entryId: entry.id,
			record,
			anchorIndex:
				resultIndex >= 0
					? resultIndex
					: branch.findIndex((candidate) => candidate.id === record.anchorEntryId),
		});
	}
	return [...byKey].filter(([key]) => !conflicts.has(key)).map(([, value]) => value);
}
