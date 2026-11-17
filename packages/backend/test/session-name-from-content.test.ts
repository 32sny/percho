import { describe, expect, it } from "vitest";
import { readSessionNameFromContent } from "../src/session/messages";

/**
 * 未打开会话的转录文件名取名（会话拖入输入栏）：磁盘上没有实例，只能解析会话文件里的
 * `session_info`。这里锁三件事：取最后一条非空名字、空名不覆盖旧名、坏文件不抛。
 */

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);

describe("readSessionNameFromContent", () => {
	it("取最后一条 session_info 的名字（改名后以新名为准）", () => {
		const content = [
			line({ type: "session", version: 1, id: "s1", cwd: "C:/work", timestamp: "2026-11-17T00:00:00.000Z" }),
			line({ type: "session_info", id: "e1", parentId: null, name: "旧名字" }),
			line({ type: "session_info", id: "e2", parentId: "e1", name: "会话悬停设计" }),
		].join("\n");
		expect(readSessionNameFromContent(content)).toBe("会话悬停设计");
	});

	it("空名字不覆盖已有名字", () => {
		const content = [
			line({ type: "session_info", id: "e1", parentId: null, name: "有效名" }),
			line({ type: "session_info", id: "e2", parentId: "e1", name: "   " }),
		].join("\n");
		expect(readSessionNameFromContent(content)).toBe("有效名");
	});

	it("没有 session_info 返回 undefined（调用方回退 sessionId），坏行不抛", () => {
		expect(readSessionNameFromContent("{not json")).toBeUndefined();
		const content = [line({ type: "session", version: 1, id: "s1", cwd: "C:/work" })].join("\n");
		expect(readSessionNameFromContent(content)).toBeUndefined();
	});
});
