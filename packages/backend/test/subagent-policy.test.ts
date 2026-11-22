import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	forbiddenGitCommand,
	subagentBoundaryViolation,
	subagentPermissionMode,
} from "../src/tools/subagent/policy";
import { reportGuidePrompt, subagentCorePrompt } from "../src/tools/subagent/prompt";
import { summarizeSubagentRun } from "../src/tools/subagent/summary";

describe("subagent policy", () => {
	it("clamps permissionMode to parent default", () => {
		expect(subagentPermissionMode("default", "fullAccess")).toBe("default");
		expect(subagentPermissionMode("fullAccess", "default")).toBe("default");
		expect(subagentPermissionMode("fullAccess", undefined)).toBe("fullAccess");
	});

	it("allows read-only git subcommands and blocks mutating or option-injected git", () => {
		expect(forbiddenGitCommand("git status && git diff --stat")).toBeUndefined();
		expect(forbiddenGitCommand("git log -n 5")).toBeUndefined();
		expect(forbiddenGitCommand("git commit -m x")).toBe("git commit -m x");
		expect(forbiddenGitCommand("git -c core.pager=cat status")).toBe("git -c core.pager=cat status");
		expect(forbiddenGitCommand("git.exe push origin main")).toBe("git.exe push origin main");
	});

	it("protects Percho agentDir across slash styles and edit/write paths", () => {
		const agentDir = join("C:", "Users", "Tester", ".pi", "agent");
		const policy = { agentDir, deny: ["bash: curl *"] };
		expect(subagentBoundaryViolation(policy, "bash", "curl https://example.com", "/repo")).toContain("deny:");
		expect(
			subagentBoundaryViolation(policy, "bash", `cat ${agentDir.replace(/\\/g, "/")}/auth.json`, "/repo"),
		).toContain("Percho state is read-only");
		expect(subagentBoundaryViolation(policy, "write", join(agentDir, "permissions.json"), "/repo")).toBe(
			"Percho state is read-only",
		);
		expect(subagentBoundaryViolation(policy, "edit", "src/app.ts", "/repo")).toBeUndefined();
	});
});

describe("subagent prompt adaptation", () => {
	it("uses read-only guidance when agent has no mutating tools", () => {
		expect(subagentCorePrompt(["read", "grep", "find", "ls"])).toContain("read-only subagent");
		expect(reportGuidePrompt(["read", "grep"])).toContain("Findings:");
		expect(subagentCorePrompt(["read", "edit", "bash"])).toContain("Prefer edit");
		expect(reportGuidePrompt(["read", "edit", "bash"])).toContain("Verified:");
	});
});

describe("summarizeSubagentRun", () => {
	it("derives changedFiles, commands, failedCommands, and durationMs from branch", () => {
		const branch = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-11-22T00:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "fix" }], timestamp: 1 },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2026-11-22T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "src/a.ts" } },
						{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "npm test" } },
					],
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "tr1",
				parentId: "a1",
				timestamp: "2026-11-22T00:00:02.000Z",
				message: {
					role: "toolResult",
					toolCallId: "t1",
					toolName: "edit",
					content: [{ type: "text", text: "ok" }],
					details: { patch: "@@ -1,1 +1,2 @@\n-old\n+new1\n+new2" },
					isError: false,
					timestamp: 3,
				},
			},
			{
				type: "message",
				id: "tr2",
				parentId: "tr1",
				timestamp: "2026-11-22T00:00:03.000Z",
				message: {
					role: "toolResult",
					toolCallId: "t2",
					toolName: "bash",
					content: [{ type: "text", text: "fail" }],
					isError: true,
					timestamp: 4,
				},
			},
		];
		const summary = summarizeSubagentRun({ getBranch: () => branch as never }, 1500);
		expect(summary).toEqual({
			changedFiles: [{ path: "src/a.ts", added: 2, removed: 1 }],
			commands: [{ command: "npm test", isError: true }],
			failedCommands: 1,
			durationMs: 1500,
		});
	});
});
