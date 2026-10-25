import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { autoNameSession } from "../src/session/naming";

function makeSession(existingName: string | null = null) {
	const calls: string[] = [];
	const session = {
		sessionManager: { getSessionName: () => existingName },
		setSessionName: (name: string) => {
			calls.push(name);
		},
	} as unknown as AgentSession;
	return { session, calls };
}

function userMsg(text: string): AgentSessionEvent {
	return {
		type: "message_start",
		message: { role: "user", content: [{ type: "text", text }] },
	} as unknown as AgentSessionEvent;
}

describe("autoNameSession", () => {
	it("第一条用户消息到达即命名（取首行）", () => {
		const { session, calls } = makeSession();
		autoNameSession(session, userMsg("帮我修复登录 bug\n具体看 auth.ts"));
		expect(calls).toEqual(["帮我修复登录 bug"]);
	});

	it("长首行完整保存，包含 Emoji 且不受预览 128KiB 限制", () => {
		const { session, calls } = makeSession();
		const title = `这是完整标题😀${"长".repeat(50_000)}`;
		autoNameSession(session, userMsg(`${title}\n第二行不进入标题`));
		expect(calls).toEqual([title]);
	});

	it("已有会话名时不再命名", () => {
		const { session, calls } = makeSession("已有标题");
		autoNameSession(session, userMsg("新消息"));
		expect(calls).toEqual([]);
	});

	it("agent_end 不再触发命名（标题在任务开始时已有）", () => {
		const { session, calls } = makeSession();
		autoNameSession(session, { type: "agent_end" } as unknown as AgentSessionEvent);
		expect(calls).toEqual([]);
	});

	it("非用户角色消息不命名", () => {
		const { session, calls } = makeSession();
		autoNameSession(session, {
			type: "message_start",
			message: { role: "assistant", content: [{ type: "text", text: "你好" }] },
		} as unknown as AgentSessionEvent);
		expect(calls).toEqual([]);
	});

	it("SDK 展开的 skill 命令还原为 /skill:name args 再取首行（不拿 XML 头当标题）", () => {
		const { session, calls } = makeSession();
		autoNameSession(
			session,
			userMsg(
				'<skill name="mindmap" location="/tmp/skills/mindmap/SKILL.md">\nReferences are relative to /tmp/skills/mindmap.\n\n# Mind map\n\nBody\n</skill>\n\n帮我画架构图\n细节补充',
			),
		);
		expect(calls).toEqual(["/skill:mindmap 帮我画架构图"]);
	});

	it("skill 无参数时标题为 /skill:name", () => {
		const { session, calls } = makeSession();
		autoNameSession(
			session,
			userMsg(
				'<skill name="mindmap" location="/tmp/skills/mindmap/SKILL.md">\nReferences are relative to /tmp/skills/mindmap.\n\n# Mind map\n\nBody\n</skill>',
			),
		);
		expect(calls).toEqual(["/skill:mindmap"]);
	});

	it("疑似残缺 Skill 不用内联正文命名", () => {
		const { session, calls } = makeSession();
		autoNameSession(session, userMsg('  <skill name="private" location="/secret">\n机密正文'));
		expect(calls).toEqual([]);
	});

	it("纯图片消息不命名，后续文本消息仍可命名", () => {
		const { session, calls } = makeSession();
		autoNameSession(session, {
			type: "message_start",
			message: { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
		} as unknown as AgentSessionEvent);
		expect(calls).toEqual([]);
		autoNameSession(session, userMsg("这张图里是什么"));
		expect(calls).toEqual(["这张图里是什么"]);
	});
});
