import { describe, expect, it } from "vitest";
import { transcriptFileName } from "../src/session/transcript";

/**
 * 会话拖入输入栏的转录文件名（回归：未打开会话曾落 `sessionId.md`，胶囊显示 UUID 乱码）。
 * 契约：<会话名>-<sessionId 前 8 位>.md；名字缺失才回退 sessionId；非法字符被白名单过滤。
 */

const ID = "01a18ad2-e4fa-72a4-802e-b634ac9ccc52";

describe("transcriptFileName", () => {
	it("有名字时用 <会话名>-<8位id>.md，不再是裸 UUID", () => {
		expect(transcriptFileName(ID, "会话悬停设计")).toBe("会话悬停设计-01a18ad2.md");
	});

	it("过滤路径分隔符与保留字符，保留中文与空格", () => {
		expect(transcriptFileName(ID, "/Orchestrator on")).toBe("Orchestrator on-01a18ad2.md");
		expect(transcriptFileName(ID, "a/b\\c:d*e?f")).toBe("abcdef-01a18ad2.md");
	});

	it("名字缺失或纯空白回退 sessionId", () => {
		expect(transcriptFileName(ID)).toBe(`${ID}.md`);
		expect(transcriptFileName(ID, "   ")).toBe(`${ID}.md`);
	});

	it("超长名字只截名字部分，id 后缀与扩展名保留", () => {
		const name = "长".repeat(200);
		const fileName = transcriptFileName(ID, name);
		expect(fileName.length).toBeLessThanOrEqual(84);
		expect(fileName.endsWith("-01a18ad2.md")).toBe(true);
	});
});
