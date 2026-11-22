import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../stores/sessions", () => ({
	useSessionsStore: (selector: (s: unknown) => unknown) =>
		selector({ openSubagentSession: vi.fn(async () => {}) }),
}));

import { SubagentRunCard } from "./SubagentRunCard";

beforeEach(() => {
	vi.stubGlobal("React", React);
});

afterEach(() => vi.unstubAllGlobals());

describe("SubagentRunCard（折中版：真实 Agent 名 + 元信息 + 跳动三点胶囊）", () => {
	it("保留真实 Agent 名、序号、思考档位、模型与 token，并渲染对应状态胶囊", () => {
		const html = renderToStaticMarkup(
			<SubagentRunCard
				runs={[
					{
						key: "tc:0",
						agent: "explore",
						index: 1,
						status: "running",
						thinkingLevel: "high",
						model: "glm-5",
						tokens: 13200,
						sessionFile: "/tmp/sub-1.jsonl",
					},
					{
						key: "tc:1",
						agent: "oracle",
						index: 2,
						status: "queued",
					},
					{
						key: "tc:2",
						agent: "fixer",
						index: 3,
						status: "aborted",
						sessionFile: "/tmp/sub-3.jsonl",
					},
				]}
			/>,
		);
		expect(html).toContain("Explore #1");
		expect(html).toContain("thinkingLevels.high");
		expect(html).toContain("glm-5");
		expect(html).toContain("13.2k token");
		expect(html).toContain('data-state="running"');
		expect(html).toContain("Oracle #2");
		expect(html).toContain('data-state="queued"');
		expect(html).toContain("Fixer #3");
		expect(html).toContain('data-state="aborted"');
		expect(html).toContain("subagent-dots");
	});
});
