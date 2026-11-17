import { describe, expect, it } from "vitest";
import { splitMessageReferences } from "./message-attachments";

/**
 * 气泡里 `@路径` 芯片化的切分契约：只切真路径，不动普通文字与 @昵称。
 * 发送时多条附件会连成同一行（`@a @b @c`），文件名可能自带空格与 `·`。
 */
describe("splitMessageReferences", () => {
	it("把 percho-transcripts 会话转录切成语义引用段（文件名可含空格与 ·）", () => {
		const text =
			"@C:\\Users\\Administrator\\AppData\\Local\\Temp\\percho-transcripts\\【真实验收】codemode 嵌套子代理关系 · 1030-01a18ad2.md";
		expect(splitMessageReferences(text)).toEqual([
			{
				type: "reference",
				path: "C:\\Users\\Administrator\\AppData\\Local\\Temp\\percho-transcripts\\【真实验收】codemode 嵌套子代理关系 · 1030-01a18ad2.md",
			},
		]);
	});

	it("同一行多个 @ 附件各切一段，不跨过相邻 @ 吞成长路径", () => {
		const text =
			"@C:\\Users\\A\\Desktop\\空白.md @C:\\Users\\A\\Temp\\percho-transcripts\\【实测】插件父子关系 · 适配验收-01a185e4.md @C:\\Users\\A\\笔记.txt";
		const paths = splitMessageReferences(text)
			.filter((segment) => segment.type === "reference")
			.map((segment) => (segment as { path: string }).path);
		expect(paths).toEqual([
			"C:\\Users\\A\\Desktop\\空白.md",
			"C:\\Users\\A\\Temp\\percho-transcripts\\【实测】插件父子关系 · 适配验收-01a185e4.md",
			"C:\\Users\\A\\笔记.txt",
		]);
	});

	it("文件名带空格的普通文件也整段切（以扩展名收尾）", () => {
		const text = "@C:\\Users\\A\\Desktop\\Claude opus 4.7 破甲.txt 看下";
		expect(splitMessageReferences(text)).toEqual([
			{ type: "reference", path: "C:\\Users\\A\\Desktop\\Claude opus 4.7 破甲.txt" },
			{ type: "text", text: " 看下" },
		]);
	});

	it("无扩展名的目录段只取到第一个空白，尾部正文保留", () => {
		const text = "@C:\\Users\\A\\Desktop\\00 帮我看下";
		expect(splitMessageReferences(text)).toEqual([
			{ type: "reference", path: "C:\\Users\\A\\Desktop\\00" },
			{ type: "text", text: " 帮我看下" },
		]);
	});

	it("普通相对路径也切成引用，保留前后文本", () => {
		expect(splitMessageReferences("看 @src/components/Composer.tsx 这个文件")).toEqual([
			{ type: "text", text: "看 " },
			{ type: "reference", path: "src/components/Composer.tsx" },
			{ type: "text", text: " 这个文件" },
		]);
	});

	it("不误切 @昵称、邮箱与无分隔符的词", () => {
		const samples = ["@zhangyi 你好", "mail a@b.com", "@note 不是路径", "price@100"];
		for (const text of samples) {
			expect(splitMessageReferences(text)).toEqual([{ type: "text", text }]);
		}
	});

	it("纯文本原样返回单段（渲染层据此走快路径）", () => {
		expect(splitMessageReferences("普通的一句话")).toEqual([{ type: "text", text: "普通的一句话" }]);
	});
});
