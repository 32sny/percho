import { describe, expect, it } from "vitest";
import { collectSessionHoverLiveRuns, safeUserFirstLine } from "./session-hover";
import { reduceEvent } from "./transcript/reducer";
import { emptyTranscript } from "./transcript/types";

describe("session hover live projection", () => {
	it("projects committed then streaming runs without leaking large or unsafe fields", () => {
		const result = collectSessionHoverLiveRuns({
			messages: [
				{
					kind: "subagent",
					id: "s",
					timestamp: 1,
					runs: [
						{
							key: "c",
							agent: "reviewer",
							task: "first\nsecret",
							status: "done",
							exitCode: 0,
							sessionFile: "/safe/a.jsonl",
							model: "private",
						},
						{ key: "skip", agent: "reviewer", status: "running" },
						{
							key: "bad",
							agent: "/safe/b.jsonl",
							task: "x".repeat(128 * 1024 + 1),
							status: "error",
							sessionFile: "/safe/b.jsonl",
						},
					],
				},
			],
			streaming: {
				subagentRuns: [
					{ key: "live", agent: "reviewer", task: "now", status: "running", sessionFile: "/safe/live.jsonl" },
				],
			},
		} as never);
		expect(result).toEqual([
			{
				sessionFile: "/safe/a.jsonl",
				agent: "reviewer",
				task: "first",
				status: "done",
				exitCode: 0,
				source: "committed",
			},
			{ sessionFile: "/safe/b.jsonl", agent: "subagent", status: "error", source: "committed" },
			{
				sessionFile: "/safe/live.jsonl",
				agent: "reviewer",
				task: "now",
				status: "running",
				source: "streaming",
			},
		]);
		expect(JSON.stringify(result)).not.toContain("private");
	});

	it("keeps the legacy safe first-line behavior", () => {
		expect(safeUserFirstLine("one\ntwo")).toEqual({ status: "ok", text: "one" });
	});

	it("projects reducer early streaming path before turn_end", () => {
		let state = emptyTranscript();
		state = reduceEvent(state, { type: "agent_start" } as never);
		state = reduceEvent(state, {
			type: "tool_execution_start",
			toolName: "subagent",
			toolCallId: "t",
			args: { agent: "scout", task: "inspect" },
		} as never);
		state = reduceEvent(state, {
			type: "tool_execution_update",
			toolName: "subagent",
			toolCallId: "t",
			partialResult: {
				details: {
					results: [{ agent: "scout", task: "inspect", artifactPaths: { jsonlPath: "/safe/child.jsonl" } }],
				},
			},
		} as never);
		expect(collectSessionHoverLiveRuns(state)).toMatchObject([
			{ sessionFile: "/safe/child.jsonl", source: "streaming", status: "running" },
		]);
	});
});
