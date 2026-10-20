import { describe, expect, it } from "vitest";
import type { SessionMessage } from "@percho/shared";
import { buildSessionTranscript } from "../src/session/transcript";

/**
 * 阶段 0 红测（spec PLAN-session-move-project §〇）：会话拖入输入栏的可读转录契约。
 *
 * buildSessionTranscript 把 SessionMessage[]（活跃走 registry / 未打开走
 * readSessionMessagesFromContent，两态同型）转成给 agent 读的干净 Markdown：
 * 用户/助手分节、工具调用一行带过、超长截断加注 —— 惰性 @路径 引用不撑上下文。
 */

const T0 = Date.parse("2026-09-22T00:00:00.000Z");

function user(text: string, extra: Partial<Extract<SessionMessage, { role: "user" }>> = {}): SessionMessage {
	return { role: "user", text, thinking: "", tools: [], images: [], timestamp: T0, ...extra };
}

function assistant(
	text: string,
	tools: Extract<SessionMessage, { role: "assistant" }>["tools"] = [],
): SessionMessage {
	return { role: "assistant", text, thinking: "", tools, images: [], timestamp: T0 };
}

describe("buildSessionTranscript · 分节格式", () => {
	it("用户/助手消息按序分节，正文原样", () => {
		const md = buildSessionTranscript([user("帮我查一下构建为什么失败"), assistant("看了日志，是 TypeScript 报错。")]);

		expect(md).toContain("## 用户");
		expect(md).toContain("帮我查一下构建为什么失败");
		expect(md).toContain("## 助手");
		expect(md).toContain("看了日志，是 TypeScript 报错。");
		// 用户节在助手节之前
		expect(md.indexOf("## 用户")).toBeLessThan(md.indexOf("## 助手"));
	});

	it("工具调用一行带过：工具名 + 完成/失败，不展开完整输出", () => {
		const md = buildSessionTranscript([
			assistant("", [
				{
					id: "t1",
					name: "read",
					args: '{"path":"src/app.ts"}',
					output: "very long output".repeat(500),
					isError: false,
				},
				{
					id: "t2",
					name: "edit",
					args: '{"path":"src/app.ts"}',
					output: "boom",
					isError: true,
				},
			]),
		]);

		expect(md).toContain("read");
		expect(md).toContain("edit");
		expect(md).toContain("失败");
		// 工具完整输出绝不进转录（脏且巨大）
		expect(md).not.toContain("very long output".repeat(20));
	});

	it("图片 / 子代理 / 压缩标记各成一行摘要", () => {
		const md = buildSessionTranscript([
			{ role: "image", images: [], paths: ["a.png"], timestamp: T0 },
			{ role: "subagent", runs: [], timestamp: T0 },
			{ role: "compaction", timestamp: T0, summary: "早期讨论" },
		]);

		expect(md).toContain("a.png");
		expect(md).toContain("子代理");
		expect(md).toContain("压缩");
	});

	it("单条消息超 2000 字截断并标注原长", () => {
		const long = "字".repeat(3000);
		const md = buildSessionTranscript([user(long)]);

		expect(md).toContain("字".repeat(100));
		expect(md).toContain("3000");
		expect(md).not.toContain("字".repeat(2500));
	});

	it("空消息列表 → 返回带标题的最小转录，不抛错", () => {
		const md = buildSessionTranscript([]);
		expect(md.trim().length).toBeGreaterThan(0);
	});
});
