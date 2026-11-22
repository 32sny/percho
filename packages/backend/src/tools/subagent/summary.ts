import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { deriveTurnChanges, messagesToUIMessages, type SubagentRunSummary } from "@percho/shared";
import { toBranchSessionMessages } from "../../session/messages";

function parseCommandArg(rawArgs: string): string | undefined {
	try {
		const parsed = JSON.parse(rawArgs) as { command?: unknown };
		return typeof parsed.command === "string" ? parsed.command : undefined;
	} catch {
		return undefined;
	}
}

export function summarizeSubagentRun(
	manager: Pick<SessionManager, "getBranch">,
	durationMs: number,
): SubagentRunSummary {
	const summary: SubagentRunSummary = { changedFiles: [], commands: [], failedCommands: 0, durationMs };
	try {
		const messages = messagesToUIMessages(toBranchSessionMessages(manager.getBranch()));
		const files = new Map<string, SubagentRunSummary["changedFiles"][number]>();
		for (const turn of deriveTurnChanges(messages)) {
			for (const file of turn.files) {
				const previous = files.get(file.path);
				files.set(file.path, {
					path: file.path,
					added: (previous?.added ?? 0) + file.added,
					removed: (previous?.removed ?? 0) + file.removed,
				});
			}
		}
		const commands: SubagentRunSummary["commands"] = [];
		for (const message of messages) {
			if (message.kind !== "assistant") continue;
			for (const tool of message.tools) {
				if (tool.name !== "bash") continue;
				const command = parseCommandArg(tool.args);
				if (command !== undefined) {
					commands.push({ command, isError: tool.state === "error" });
				}
			}
		}
		return {
			changedFiles: [...files.values()],
			commands,
			failedCommands: commands.filter((c) => c.isError).length,
			durationMs,
		};
	} catch {
		// 事实派生不得改变任务状态；损坏或无法解析的分支回落空事实。
		return summary;
	}
}
