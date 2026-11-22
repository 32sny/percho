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

	it("首行是 @附件路径时，自动命名/预览取下一行正文（不再拿裸路径当标题）", () => {
		expect(safeUserFirstLine("@C:\\Users\\A\\Desktop\\00\n帮我看下这个会话的关键结论")).toEqual({
			status: "ok",
			text: "帮我看下这个会话的关键结论",
		});
		expect(
			safeUserFirstLine(
				"@C:\\Users\\A\\Temp\\percho-transcripts\\【实测】插件父子关系 · 适配验收-01a185e4.md\n帮我看下",
			),
		).toEqual({ status: "ok", text: "帮我看下" });
	});

	it("整条消息只有 @附件时提取短名，绝不返回绝对路径", () => {
		expect(safeUserFirstLine("@C:\\Users\\A\\Desktop\\00")).toEqual({ status: "ok", text: "00" });
		expect(
			safeUserFirstLine(
				"@C:\\Users\\A\\Temp\\percho-transcripts\\【实测】插件父子关系 · 适配验收-01a185e4.md",
			),
		).toEqual({ status: "ok", text: "【实测】插件父子关系 · 适配验收" });
		const projection = safeUserFirstLine("@C:\\Users\\A\\a.md @C:\\Users\\A\\b.txt");
		expect(projection).toEqual({ status: "ok", text: "a · b" });
	});

	it("只有完整 ID 会话转录附件时，标题仍只取语义名", () => {
		expect(
			safeUserFirstLine("@C:/tmp/percho-transcripts/设计讨论-01a18ad2-e4fa-72a4-802e-b634ac9ccc52.md"),
		).toEqual({ status: "ok", text: "设计讨论" });
	});

	it("@昵称不算附件行，不改变原首行行为", () => {
		expect(safeUserFirstLine("@zhangyi 你好")).toEqual({ status: "ok", text: "@zhangyi 你好" });
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

	it("normalizes queued and aborted subagent statuses for hover live runs", () => {
		const result = collectSessionHoverLiveRuns({
			messages: [
				{
					id: "m1",
					kind: "subagent",
					runs: [{ key: "k1", agent: "Explore", status: "aborted", sessionFile: "/safe/a.jsonl" }],
					timestamp: 1,
				},
			],
			streaming: {
				subagentRuns: [{ key: "k2", agent: "Explore", status: "queued", sessionFile: "/safe/b.jsonl" }],
			},
		});
		expect(result).toMatchObject([
			{ sessionFile: "/safe/a.jsonl", status: "error", source: "committed" },
			{ sessionFile: "/safe/b.jsonl", status: "running", source: "streaming" },
		]);
	});
});
