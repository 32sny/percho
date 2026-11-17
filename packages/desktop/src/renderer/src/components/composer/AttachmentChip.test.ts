import { describe, expect, it } from "vitest";
import { attachmentPresentation } from "./attachment-presentation";

describe("attachmentPresentation", () => {
	it("从会话转录路径提取语义标题，不保留末尾八位 hex id", () => {
		expect(attachmentPresentation("C:/tmp/percho-transcripts/设计讨论-a1b2c3d4.md")).toEqual({
			kind: "session",
			name: "设计讨论",
			suffix: "",
		});
	});

	it("完整 UUID 转录只显示语义名，无名转录保留完整 ID", () => {
		const id = "01a18ad2-e4fa-72a4-802e-b634ac9ccc52";
		expect(attachmentPresentation(`C:/tmp/percho-transcripts/设计讨论-${id}.md`)).toEqual({
			kind: "session",
			name: "设计讨论",
			suffix: "",
		});
		expect(attachmentPresentation(`C:/tmp/percho-transcripts/${id}.md`)).toEqual({
			kind: "session",
			name: id,
			suffix: "",
		});
	});

	it("区分尾斜线及无扩展目录", () => {
		expect(attachmentPresentation("D:/project/功能/")).toEqual({ kind: "folder", name: "功能", suffix: "/" });
		expect(attachmentPresentation("D:/project/功能")).toEqual({ kind: "folder", name: "功能", suffix: "/" });
	});

	it("区分 Markdown、代码配置和普通文件，并拆分主名与后缀", () => {
		expect(attachmentPresentation("docs/spec.mdx")).toEqual({
			kind: "markdown",
			name: "spec",
			suffix: ".mdx",
		});
		expect(attachmentPresentation("src/Composer.tsx")).toEqual({
			kind: "code",
			name: "Composer",
			suffix: ".tsx",
		});
		expect(attachmentPresentation("notes/提示词.txt")).toEqual({
			kind: "file",
			name: "提示词",
			suffix: ".txt",
		});
	});
});
