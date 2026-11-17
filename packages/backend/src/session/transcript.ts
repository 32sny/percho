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
				parts.push(
					`---（上下文已压缩${message.summary ? `：${truncate(message.summary, 200)}` : ""}）---`,
					"",
				);
				break;
		}
	}
	return `${parts.join("\n").trimEnd()}\n`;
}

/**
 * 转录临时文件名：`<会话名>-<完整 sessionId>.md`；没有名字才回退裸 sessionId。
 *
 * 名字来源：左栏拖拽载荷的显示名 > 活跃会话名 > 未打开会话文件里的 `session_info`。
 * 早期实现只给活跃会话取名，未打开会话直接落 `sessionId.md`，胶囊显示 UUID 乱码，
 * 拖入历史会话时必现。
 *
 * 白名单过滤（字母/数字/空格/-/_/点/中文等非 ASCII）而非黑名单正则，避开 no-control-regex。
 */
export function transcriptFileName(sessionId: string, sessionName?: string): string {
	const suffix = `-${sessionId}`;
	const safeName = sanitizeTranscriptName(sessionName?.trim() ?? "");
	if (!safeName) return `${sessionId}.md`;
	// UUIDv7 的前八位是时间前缀；保留完整 ID，避免同名会话互盖及导航歧义。
	const maxNameChars = Math.max(0, 80 - suffix.length);
	const name = [...safeName].slice(0, maxNameChars).join("").trimEnd();
	return name ? `${name}${suffix}.md` : `${sessionId}.md`;
}

/** 文件名白名单：字母/数字/空格/-/_/点 + 中文等非 ASCII；路径分隔符与保留字符直接丢弃。 */
function sanitizeTranscriptName(value: string): string {
	return [...value]
		.filter((ch) => /[\w\-. ]/.test(ch) || ch.charCodeAt(0) > 127)
		.join("")
		.trim();
}
