import { describe, expect, it } from "vitest";
import { parseSessionTranscriptReference } from "./session-transcript-reference";

const ID = "01a18ad2-e4fa-72a4-802e-b634ac9ccc52";

describe("转录引用格式兼容", () => {
	it.each(["C:/tmp/percho-transcripts/", "C:\\tmp\\percho-transcripts\\", "/tmp/percho-transcripts/"])(
		"跨平台路径识别完整身份：%s",
		(dir) => {
			expect(parseSessionTranscriptReference(`${dir}讨论 · 复核-${ID}.md`)).toEqual({
				name: "讨论 · 复核",
				sessionId: ID,
				legacy: false,
			});
		},
	);

	it("无名引用保留完整 ID，不能误认成旧短前缀", () => {
		expect(parseSessionTranscriptReference(`percho-transcripts/${ID}.md`)).toEqual({
			name: ID,
			sessionId: ID,
			legacy: false,
		});
	});

	it("旧引用显式标记为前缀匹配", () => {
		expect(parseSessionTranscriptReference("/tmp/percho-transcripts/设计-01a18ad2.md")).toEqual({
			name: "设计",
			sessionId: "01a18ad2",
			legacy: true,
		});
	});

	it("路径、扩展名和 UUID 大小写兼容", () => {
		expect(parseSessionTranscriptReference(`C:/Temp/PERCHO-TRANSCRIPTS/讨论-${ID.toUpperCase()}.MD`)).toEqual(
			{ name: "讨论", sessionId: ID.toUpperCase(), legacy: false },
		);
	});

	it.each([
		`/tmp/讨论-${ID}.md`,
		`/tmp/not-percho-transcripts/讨论-${ID}.md`,
		`/tmp/percho-transcripts/nested/讨论-${ID}.md`,
		`/tmp/percho-transcripts/讨论-${ID}.txt`,
		"/tmp/percho-transcripts/讨论.md",
		"",
	])("不把其他文件猜成会话引用：%s", (path) => {
		expect(parseSessionTranscriptReference(path)).toBeNull();
	});
});
