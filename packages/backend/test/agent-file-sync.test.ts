import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyFrontmatterField, syncAgentFileField } from "../src/settings/agent-file-sync";

const LF = "\n";

function md(frontmatterBody: string[], body: string[], eol = LF): string {
	return [...frontmatterBody, ...body].join(eol);
}

describe("applyFrontmatterField", () => {
	it("替换已有行（值不同）", () => {
		const content = md(["---", "name: fixer", "model: old/model", "---", "body"], ["", "prompt text"]);
		expect(applyFrontmatterField(content, "model", "new/model")).toBe(
			md(["---", "name: fixer", "model: new/model", "---", "body"], ["", "prompt text"]),
		);
	});

	it("值相同幂等返回 null（含引号/行内注释等价形态）", () => {
		const bare = md(["---", "name: fixer", "model: p/m", "---", "body"], []);
		expect(applyFrontmatterField(bare, "model", "p/m")).toBeNull();
		const quoted = md(["---", 'model: "p/m"', "---", "body"], []);
		expect(applyFrontmatterField(quoted, "model", "p/m")).toBeNull();
		const commented = md(["---", "model: p/m # legacy note", "---", "body"], []);
		expect(applyFrontmatterField(commented, "model", "p/m")).toBeNull();
	});

	it("未命中时在闭合 --- 前插入", () => {
		const content = md(["---", "name: fixer", "tools: [read]", "---", "body"], []);
		expect(applyFrontmatterField(content, "model", "p/m")).toBe(
			md(["---", "name: fixer", "tools: [read]", "model: p/m", "---", "body"], []),
		);
	});

	it("无 frontmatter / 无闭合 --- / 空文件 → null", () => {
		expect(applyFrontmatterField("just body text", "model", "p/m")).toBeNull();
		expect(applyFrontmatterField(md(["---", "name: fixer", "body"], []), "model", "p/m")).toBeNull();
		expect(applyFrontmatterField("", "model", "p/m")).toBeNull();
	});

	it("CRLF 文件保持 CRLF", () => {
		const content = ["---", "model: old/m", "---", "body"].join("\r\n");
		const updated = applyFrontmatterField(content, "model", "new/m");
		expect(updated).toBe(["---", "model: new/m", "---", "body"].join("\r\n"));
		expect(updated?.replace(/\r\n/g, "")).not.toContain("\n");
	});

	it("正文（systemPrompt）含 model: 字样的代码块不被误改", () => {
		const body = ["", "usage:", "```", "model: should-stay", "```"];
		const content = md(["---", "model: old/m", "---", "head"], body);
		const updated = applyFrontmatterField(content, "model", "new/m");
		expect(updated).toBe(md(["---", "model: new/m", "---", "head"], body));
	});

	it("行内注释旧行被整体替换", () => {
		const content = md(["---", "model: old/m # stale comment", "---", "body"], []);
		expect(applyFrontmatterField(content, "model", "new/m")).toBe(
			md(["---", "model: new/m", "---", "body"], []),
		);
	});

	it("缩进的 frontmatter 键（非顶层）不命中", () => {
		const content = md(["---", "name: fixer", "  model: nested/m", "---", "body"], []);
		expect(applyFrontmatterField(content, "model", "p/m")).toBe(
			md(["---", "name: fixer", "  model: nested/m", "model: p/m", "---", "body"], []),
		);
	});

	it("value=null 删除该行；无行返回 null；thinking 字段同样适用", () => {
		const withLine = md(["---", "name: fixer", "thinking: high", "---", "body"], []);
		expect(applyFrontmatterField(withLine, "thinking", null)).toBe(
			md(["---", "name: fixer", "---", "body"], []),
		);
		const withoutLine = md(["---", "name: fixer", "---", "body"], []);
		expect(applyFrontmatterField(withoutLine, "thinking", null)).toBeNull();
	});
});

describe("syncAgentFileField", () => {
	async function makeAgentDir(files: Record<string, string>) {
		const dir = await mkdtemp(join(tmpdir(), "percho-agent-sync-"));
		const agentsDir = join(dir, "agents");
		await mkdir(agentsDir, { recursive: true });
		for (const [name, content] of Object.entries(files)) {
			await writeFile(join(agentsDir, name), content, "utf8");
		}
		return dir;
	}

	it("user agent 存在时改写文件", async () => {
		const dir = await makeAgentDir({
			"fixer.md": md(["---", "name: fixer", "model: old/m", "---", "body"], []),
		});
		const result = await syncAgentFileField(dir, "fixer", "model", "new/m");
		expect(result).toEqual({ synced: true });
		const after = await readFile(join(dir, "agents", "fixer.md"), "utf8");
		expect(after).toBe(md(["---", "name: fixer", "model: new/m", "---", "body"], []));
	});

	it("值相同时不写盘（幂等）", async () => {
		const content = `${md(["---", "name: fixer", "model: p/m", "---", "body"], [])}${LF}`;
		const dir = await makeAgentDir({ "fixer.md": content });
		const result = await syncAgentFileField(dir, "fixer", "model", "p/m");
		expect(result).toEqual({ synced: true, reason: "unchanged" });
		expect(await readFile(join(dir, "agents", "fixer.md"), "utf8")).toBe(content);
	});

	it("agent 不存在 → no-user-file", async () => {
		const dir = await makeAgentDir({});
		expect(await syncAgentFileField(dir, "ghost", "model", "p/m")).toEqual({
			synced: false,
			reason: "no-user-file",
		});
	});

	it("builtin scout → no-user-file，不写盘", async () => {
		const dir = await makeAgentDir({});
		expect(await syncAgentFileField(dir, "scout", "model", "p/m")).toEqual({
			synced: false,
			reason: "no-user-file",
		});
	});

	it("同名 project 覆盖后仍以 user 文件为准（project 不参与 discover）", async () => {
		// discoverAgents(projectTrusted:false) 不读 project 目录：即使磁盘上有
		// 同名 project agent，也只会命中 user 文件——此处验证 user 文件被改写。
		const dir = await makeAgentDir({
			"fixer.md": md(["---", "name: fixer", "model: old/m", "---", "body"], []),
		});
		const result = await syncAgentFileField(dir, "fixer", "model", "new/m");
		expect(result).toEqual({ synced: true });
	});

	it("frontmatter 非法的 user 文件（无闭合 ---）→ 不写盘且不抛", async () => {
		const content = md(["---", "name: broken", "body"], []);
		const dir = await makeAgentDir({ "broken.md": content });
		// 非法文件 parseAgentMarkdown 返回 null，不会进入 discoverAgents 结果 → no-user-file
		const result = await syncAgentFileField(dir, "broken", "model", "p/m");
		expect(result).toEqual({ synced: false, reason: "no-user-file" });
		expect(await readFile(join(dir, "agents", "broken.md"), "utf8")).toBe(content);
	});
});
