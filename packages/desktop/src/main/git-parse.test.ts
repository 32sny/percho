import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { GitBlameLine, GitCommitRecord, GitFileChange, GitStatusEntry } from "@percho/shared";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Execute the actual private function bodies, not copies or a new production export.
// These four parsers are pure: extracting declarations avoids launching Git/Electron.
const names = ["parseStatusPorcelain", "parseLogRecords", "parseNameStatus", "parseBlameLinePorcelain"];
const source = ts.createSourceFile(
	"git.ts",
	readFileSync(new URL("./git.ts", import.meta.url), "utf8"),
	ts.ScriptTarget.Latest,
	true,
);
const declarations = source.statements.filter(
	(node): node is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""),
);
expect(declarations.map((node) => node.name?.text).sort()).toEqual([...names].sort());
const emitted = ts.transpileModule(declarations.map((node) => node.getText(source)).join("\n"), {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const parsers = runInNewContext(`${emitted}\n({ ${names.join(", ")} });`) as {
	parseStatusPorcelain(output: string): {
		branch: string | null;
		upstream: string | null;
		ahead: number;
		behind: number;
		gone: boolean;
		entries: GitStatusEntry[];
		staged: GitStatusEntry[];
		unstaged: GitStatusEntry[];
		untracked: GitStatusEntry[];
		conflicts: GitStatusEntry[];
	};
	parseLogRecords(output: string): GitCommitRecord[];
	parseNameStatus(output: string): GitFileChange[];
	parseBlameLinePorcelain(output: string): GitBlameLine[];
};

const hash = "a".repeat(40);
const logFields = [
	hash,
	"aaaaaaa",
	"作者",
	"author@example.invalid",
	"2026-10-21T12:00:00+08:00",
	"2026-10-21T12:01:00+08:00",
	"HEAD -> main",
	"提交标题",
	" body\nnext line \n",
];

describe("porcelain status parser", () => {
	it("empty and short input retain defaults without manufacturing entries", () => {
		expect(parsers.parseStatusPorcelain("\nM\n??\n")).toEqual({
			branch: null,
			upstream: null,
			ahead: 0,
			behind: 0,
			gone: false,
			entries: [],
			staged: [],
			unstaged: [],
			untracked: [],
			conflicts: [],
		});
	});

	it("reads branch, upstream and independent ahead/behind counters", () => {
		expect(parsers.parseStatusPorcelain("## main...origin/main [ahead 2, behind 3]\n")).toMatchObject({
			branch: "main",
			upstream: "origin/main",
			ahead: 2,
			behind: 3,
			gone: false,
		});
		expect(parsers.parseStatusPorcelain("## feature\n")).toMatchObject({ branch: "feature", upstream: null });
		expect(parsers.parseStatusPorcelain("## feature...origin/feature [gone]\n")).toMatchObject({
			gone: true,
		});
	});

	it("classifies staged, unstaged, untracked and renamed paths with existing precedence", () => {
		const result = parsers.parseStatusPorcelain(
			"M  staged.ts\n M unstaged.ts\n?? 新 文件.ts\nR  old.ts -> new.ts\nMM both.ts\n",
		);
		expect(result.staged.map((entry) => entry.path)).toEqual(["staged.ts", "new.ts", "both.ts"]);
		expect(result.unstaged.map((entry) => entry.path)).toEqual(["unstaged.ts"]);
		expect(result.untracked).toEqual([{ x: "?", y: "?", path: "新 文件.ts", origPath: null }]);
		expect(result.entries).toContainEqual({ x: "R", y: " ", path: "new.ts", origPath: "old.ts" });
		expect(result.entries).toHaveLength(5);
	});

	it.each(["DD", "AU", "UD", "UA", "DU", "AA", "UU"])(
		"routes conflict %s exclusively to conflicts",
		(code) => {
			const result = parsers.parseStatusPorcelain(`${code} conflicted.ts`);
			expect(result.conflicts).toEqual(result.entries);
			expect(result.conflicts).toHaveLength(1);
			expect(result.staged).toEqual([]);
			expect(result.unstaged).toEqual([]);
			expect(result.untracked).toEqual([]);
		},
	);

	it("accepts the exact three-character boundary without changing empty-path behavior", () => {
		expect(parsers.parseStatusPorcelain(" M ").unstaged).toEqual([
			{ x: " ", y: "M", path: "", origPath: null },
		]);
	});
});

describe("log records parser", () => {
	it("rejects empty records and fewer than nine fields", () => {
		expect(parsers.parseLogRecords(`\x1e\nshort\x1e${logFields.slice(0, 8).join("\x1f")}`)).toEqual([]);
	});

	it("maps all nine fields, preserves Unicode and trims body only", () => {
		expect(parsers.parseLogRecords(`${logFields.join("\x1f")}\x1e`)).toEqual([
			{
				sha: hash,
				shortSha: "aaaaaaa",
				author: "作者",
				authorEmail: "author@example.invalid",
				authorDate: logFields[4],
				committerDate: logFields[5],
				refs: "HEAD -> main",
				subject: "提交标题",
				body: "body\nnext line",
			},
		]);
	});

	it("handles record separators, CRLF prefix and empty optional fields", () => {
		const empty = [hash, "a", "", "", "", "", "", "", ""].join("\x1f");
		const records = parsers.parseLogRecords(`${logFields.join("\x1f")}\x1e\r\n${empty}\x1e`);
		expect(records).toHaveLength(2);
		expect(records[1]).toMatchObject({ sha: hash, author: "", refs: null, subject: "", body: "" });
	});
});

describe("name-status parser", () => {
	it("ignores empty and missing-path lines", () => {
		expect(parsers.parseNameStatus("\nM\ninvalid\n")).toEqual([]);
	});

	it("distinguishes ordinary status from rename/copy scores and original paths", () => {
		expect(parsers.parseNameStatus("M\tfile.ts\nR100\told.ts\tnew.ts\nC75\t源.ts\t目标.ts\n")).toEqual([
			{ status: "M", score: null, path: "file.ts", origPath: null },
			{ status: "R", score: 100, path: "new.ts", origPath: "old.ts" },
			{ status: "C", score: 75, path: "目标.ts", origPath: "源.ts" },
		]);
	});

	it("keeps exact two-field and empty status/path behavior", () => {
		expect(parsers.parseNameStatus("\t\nRinvalid\tname with spaces.ts")).toEqual([
			{ status: "?", score: null, path: "", origPath: null },
			{ status: "R", score: null, path: "name with spaces.ts", origPath: null },
		]);
	});
});

describe("blame line-porcelain parser", () => {
	it("ignores metadata without a valid header", () => {
		expect(parsers.parseBlameLinePorcelain("author ignored\ninvalid 1 2\n\tignored\n")).toEqual([]);
	});

	it("maps header, author, timestamp, timezone, summary, filename and literal content", () => {
		const result = parsers.parseBlameLinePorcelain(
			`${hash} 4 7 1\nauthor 作者\nauthor-mail <a@example.invalid>\nauthor-time 123\nauthor-tz +0800\nsummary  a summary  \nfilename src/有 空格.ts\n\t\tconst x = 1;\n`,
		);
		expect(result).toEqual([
			{
				sha: hash,
				origLine: 4,
				finalLine: 7,
				author: "作者",
				authorMail: "a@example.invalid",
				authorTime: 123,
				authorTz: "+0800",
				summary: "a summary",
				filename: "src/有 空格.ts",
				content: "\tconst x = 1;",
			},
		]);
	});

	it("flushes consecutive records and the final record, preserving defaults", () => {
		const records = parsers.parseBlameLinePorcelain(
			`${hash} 1 2\nauthor-time invalid\nunknown ignored\nboundary\n\t\n${"b".repeat(40)} 3 4\n\tlast line`,
		);
		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({
			origLine: 1,
			finalLine: 2,
			authorTime: null,
			author: "",
			content: "",
		});
		expect(records[1]).toMatchObject({
			sha: "b".repeat(40),
			origLine: 3,
			finalLine: 4,
			content: "last line",
		});
	});
});
