import { describe, expect, it } from "vitest";
import { sameSessionPath, sessionPathKey } from "./session-path";

describe("跨端会话路径身份", () => {
	it("Windows 盘符、大小写、分隔符、点段与尾分隔符等价", () => {
		expect(sameSessionPath("C:/Project/./src/../", "c:\\project")).toBe(true);
		expect(sessionPathKey("C:/")).toBe("c:/");
		expect(sameSessionPath("C:/project", "D:/project")).toBe(false);
	});
	it("UNC 不越过共享根，并支持正反斜杠表示", () => {
		expect(sameSessionPath("\\\\HOST\\Share\\a\\..\\", "//host/share/")).toBe(true);
		expect(sameSessionPath("\\\\host\\one\\file", "\\\\host\\two\\file")).toBe(false);
	});
	it("POSIX 保留大小写与字面反斜杠", () => {
		expect(sameSessionPath("/Project/./a/../", "/Project")).toBe(true);
		expect(sameSessionPath("/Project", "/project")).toBe(false);
		expect(sameSessionPath("/project/a\\b", "/project/a/b")).toBe(false);
		expect(sessionPathKey("//Project/a", false)).toBe("/Project/a");
	});
	it("不把不知道工作目录的相对路径猜成绝对路径", () => {
		expect(sameSessionPath("project", "/project")).toBe(false);
		expect(sessionPathKey("../project")).toBe("../project");
	});
});
