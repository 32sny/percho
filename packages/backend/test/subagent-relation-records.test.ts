import { describe, expect, it } from "vitest";
import {
	collectRelationRecords,
	isRelationRecordAnchored,
	parseRelationRecord,
	relationRecordKey,
	SUBAGENT_RELATION_CUSTOM_TYPE,
} from "../src/session/subagent-relation-records";

const base = {
	version: 1,
	origin: "runtime",
	parentSessionId: "session-id",
	parentSessionFile: "/sessions/parent.jsonl",
	anchorEntryId: "assistant-entry",
	rootToolCallId: "outer-call",
	toolCallId: "outer-call/1",
	parentToolCallId: "outer-call",
	toolName: "subagent",
	startedAt: 100,
	finishedAt: 200,
	runs: [
		{ agent: "Explore", taskFirstLine: "inspect", sessionFile: "/sessions-subagents/x.jsonl", exitCode: 0 },
	],
} as const;

describe("subagent relation custom protocol", () => {
	it("parses the versioned bounded shape and exports stable identity", () => {
		expect(SUBAGENT_RELATION_CUSTOM_TYPE).toBe("percho.subagent-relation.v1");
		const record = parseRelationRecord(base);
		expect(record).toEqual(base);
		expect(relationRecordKey(record!)).toBe(
			"session-id\u0000assistant-entry\u0000outer-call\u0000outer-call/1",
		);
	});

	it("rejects unknown fields, cross-tool payloads, and oversized records", () => {
		expect(parseRelationRecord({ ...base, unknown: true })).toBeUndefined();
		expect(parseRelationRecord({ ...base, claim: { agentId: "abc" } })).toBeUndefined();
		expect(parseRelationRecord({ ...base, toolCallId: "x".repeat(4097) })).toBeUndefined();
		expect(
			parseRelationRecord({ ...base, runs: Array.from({ length: 9 }, () => base.runs[0]) }),
		).toBeUndefined();
		expect(
			parseRelationRecord({ ...base, runs: [{ ...base.runs[0], agent: "x".repeat(4097) }] }),
		).toBeUndefined();
	});

	it.each([
		{ version: 2 },
		{ startedAt: 0 },
		{ finishedAt: -1 },
		{ finishedAt: Number.NaN },
		{ parentSessionId: "bad\0id" },
		{ parentSessionFile: "relative.jsonl" },
		{ parentToolCallId: "unrelated" },
		{ toolCallId: "other/1" },
		{ runs: [{ ...base.runs[0], sessionFile: "relative.jsonl" }] },
		{ runs: [{ ...base.runs[0], agent: "汉".repeat(1400) }] },
	])("rejects malformed protocol inputs %j", (patch) => {
		expect(parseRelationRecord({ ...base, ...patch })).toBeUndefined();
	});

	it("rejects payloads over the total budget before admitting a relation", () => {
		const value = "x".repeat(4000);
		expect(
			parseRelationRecord({
				...base,
				runs: Array.from({ length: 8 }, () => ({
					agent: value,
					taskFirstLine: value,
					sessionFile: `/${value}`,
				})),
			}),
		).toBeUndefined();
	});

	it("canonicalizes key order, removes duplicates, and rejects conflicting copies", () => {
		const anchor = {
			id: base.anchorEntryId,
			type: "message",
			message: { role: "assistant", content: [{ type: "toolCall", id: base.rootToolCallId }] },
		};
		const result = {
			id: "result-entry-not-tool-id",
			type: "message",
			message: { role: "toolResult", toolCallId: base.rootToolCallId },
		};
		const a = { id: "a", type: "custom", customType: SUBAGENT_RELATION_CUSTOM_TYPE, data: base };
		const b = { ...a, id: "b", data: Object.fromEntries(Object.entries(base).reverse()) };
		const collected = collectRelationRecords(
			[anchor, result, a, b],
			base.parentSessionId,
			base.parentSessionFile,
		);
		expect(collected).toHaveLength(1);
		expect(collected[0]?.anchorIndex).toBe(1);
		const conflict = { ...b, data: { ...base, runs: [{ ...base.runs[0], sessionFile: "/other.jsonl" }] } };
		expect(
			collectRelationRecords([anchor, result, a, conflict], base.parentSessionId, base.parentSessionFile),
		).toEqual([]);
		expect(
			collectRelationRecords(
				[anchor, { ...anchor, id: "duplicate-call-owner" }, a],
				base.parentSessionId,
				base.parentSessionFile,
			),
		).toEqual([]);
	});

	it("requires both the custom record and its root anchor in the current branch", () => {
		const recordEntry = {
			id: "relation",
			type: "custom",
			customType: SUBAGENT_RELATION_CUSTOM_TYPE,
			data: base,
		};
		const anchor = {
			id: "assistant-entry",
			type: "message",
			message: { role: "assistant", content: [{ type: "toolCall", id: "outer-call", name: "codemode" }] },
		};
		expect(
			isRelationRecordAnchored(recordEntry, [anchor, recordEntry], "session-id", "/sessions/parent.jsonl"),
		).toBe(true);
		expect(isRelationRecordAnchored(recordEntry, [anchor], "session-id", "/sessions/parent.jsonl")).toBe(
			false,
		);
		expect(isRelationRecordAnchored(recordEntry, [recordEntry], "session-id", "/sessions/parent.jsonl")).toBe(
			false,
		);
		expect(
			isRelationRecordAnchored(recordEntry, [anchor, recordEntry], "other", "/sessions/parent.jsonl"),
		).toBe(false);
	});
});
