import type { SessionMessage, SessionToolCall } from "@percho/shared";

/**
 * 会话 → 可读 Markdown 转录（spec PLAN-session-move-project §〇）。
 * 会话拖入输入栏的胶囊挂的就是这份转录的临时文件路径：agent 按 @路径 惰性读取，
 * 干净、省 token、不含 base64 / 工具完整输出等 jsonl 噪音。
 *
 * 输入是中立的 SessionMessage[]（活跃会话走 registry、未打开走
 * readSessionMessagesFromContent，两态同型），本函数保持纯函数。
 */

/** 单条消息正文上限：超出截断并标注原长 */
const MAX_MESSAGE_CHARS = 2000;
/** 工具参数摘要上限 */
const MAX_TOOL_ARGS_CHARS = 120;

function truncate(text: string, max = MAX_MESSAGE_CHARS): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n…（截断，原长 ${text.length} 字）`;
}

/** 工具调用一行带过：名称 + 参数摘要 + 完成/失败；完整输出绝不进转录 */
function toolLine(tool: SessionToolCall): string {
	let argsSummary = tool.args;
	try {
		const parsed = JSON.parse(tool.args) as Record<string, unknown>;
		argsSummary = Object.entries(parsed)
			.map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
			.join(", ");
	} catch {
		// 非 JSON 参数原样截断
	}
	if (argsSummary.length > MAX_TOOL_ARGS_CHARS) argsSummary = `${argsSummary.slice(0, MAX_TOOL_ARGS_CHARS)}…`;
	return `- [工具] ${tool.name}(${argsSummary}) → ${tool.isError ? "失败" : "完成"}`;
}

export function buildSessionTranscript(messages: readonly SessionMessage[]): string {
	const parts: string[] = ["# 会话转录", ""];
	for (const message of messages) {
		switch (message.role) {
			case "user":
				parts.push("## 用户", truncate(message.text), "");
				break;
			case "assistant": {
				parts.push("## 助手", truncate(message.text));
				for (const tool of message.tools) parts.push(toolLine(tool));
				parts.push("");
				break;
			}
			case "image":
				parts.push(`[图片] ${message.paths.join("、")}`, "");
				break;
			case "subagent":
				parts.push(`[子代理] ${message.runs.length} 次运行`, "");
				break;
			case "compaction":
				parts.push(`---（上下文已压缩${message.summary ? `：${truncate(message.summary, 200)}` : ""}）---`, "");
				break;
		}
	}
	return `${parts.join("\n").trimEnd()}\n`;
}
