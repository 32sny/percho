import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { safeUserFirstLine } from "@percho/shared";

/** pi 无自动命名逻辑：第一条用户消息到达即取首行作为会话标题（不等 agent_end，顶栏标题即时更新）。
 *  skill 命令此时已被 SDK 展开成 <skill …>canonical 正文——先还原成 /skill:name args 再取首行，
 *  与用户消息气泡/复制按钮的展示投影同一套（标题不再是无信息量的 XML 头）。 */
export function autoNameSession(session: AgentSession, event: AgentSessionEvent): void {
	if (event.type !== "message_start") return;
	if (session.sessionManager.getSessionName()) return;
	const message = event.message;
	if (message.role !== "user") return;
	const line = safeUserFirstLine(message.content);
	if (line.status === "ok") session.setSessionName(line.text);
}
