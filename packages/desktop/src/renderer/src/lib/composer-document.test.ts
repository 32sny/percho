import {
	appendComposerDocument,
	composerDocumentFromText,
	composerDocumentHasReferences,
	composerDocumentModelText,
	composerDocumentText,
	EMPTY_COMPOSER_DOCUMENT,
	migrateLegacyComposerDraft,
	normalizeComposerDocument,
	parseComposerDocument,
	toLegacyComposerDraftParts,
} from "@percho/shared";
import { describe, expect, it } from "vitest";

describe("ComposerDocument v1", () => {
	it("normalizes adjacent text and removes empty text without changing reference order", () => {
		const document = normalizeComposerDocument({
			version: 1,
			parts: [
				{ type: "text", text: "先" },
				{ type: "text", text: "后" },
				{ type: "text", text: "" },
				{ type: "file", path: "C:/repo/a.ts", label: "a.ts" },
			],
		});
		expect(document).toEqual({
			version: 1,
			parts: [
				{ type: "text", text: "先后" },
				{ type: "file", path: "C:/repo/a.ts", label: "a.ts" },
			],
		});
	});

	it("keeps display text distinct from model text for bound file paths", () => {
		const document = {
			version: 1 as const,
			parts: [
				{ type: "text" as const, text: "检查 " },
				{ type: "file" as const, path: "C:/repo/src/a.ts", label: "src/a.ts" },
				{ type: "text" as const, text: " 以及 " },
				{ type: "skill" as const, id: "skill-1", label: "发布检查" },
			],
		};
		expect(composerDocumentText(document)).toBe("检查 @src/a.ts 以及 发布检查");
		expect(composerDocumentModelText(document)).toBe("检查 @C:/repo/src/a.ts 以及 发布检查");
	});

	it("creates an empty or text-only version 1 document", () => {
		expect(composerDocumentFromText("")).toEqual({ version: 1, parts: [] });
		expect(composerDocumentFromText("正文\n第二行")).toEqual({
			version: 1,
			parts: [{ type: "text", text: "正文\n第二行" }],
		});
	});

	it.each([null, {}, { version: 2, parts: [] }, { version: 1, parts: [{ type: "unknown" }] }])(
		"rejects invalid or unknown document schemas: %j",
		(value) => expect(() => parseComposerDocument(value)).toThrow(),
	);

	it("migrates a legacy draft without losing attachment order, body, or slash state", () => {
		const migrated = migrateLegacyComposerDraft(
			{
				text: "请检查",
				attachments: ["src/a.ts", "docs/b.md"],
				slashCommand: "skill:release-check",
			},
			(path) => `C:/workspace/${path}`,
		);
		expect(migrated).toEqual({
			document: {
				version: 1,
				parts: [
					{
						type: "file",
						path: "C:/workspace/src/a.ts",
						label: "a.ts",
						kind: "file",
					},
					{ type: "text", text: " " },
					{
						type: "file",
						path: "C:/workspace/docs/b.md",
						label: "b.md",
						kind: "file",
					},
					{ type: "text", text: "\n请检查" },
				],
			},
			slashCommand: "skill:release-check",
		});
	});

	it("does not invent a file path when legacy attachment resolution fails", () => {
		expect(() =>
			migrateLegacyComposerDraft(
				{ text: "保留正文", attachments: ["missing.ts"], slashCommand: null },
				() => null,
			),
		).toThrow(/attachment path/i);
	});

	it("projects only representable leading file references to the legacy shape", () => {
		const document = {
			version: 1 as const,
			parts: [
				{ type: "file" as const, path: "C:/repo/a.ts", label: "a.ts" },
				{ type: "text" as const, text: "检查" },
			],
		};
		expect(toLegacyComposerDraftParts(document)).toEqual({
			text: "检查",
			attachments: ["C:/repo/a.ts"],
		});
	});

	it("fails closed when legacy fields cannot preserve inline order or skill identity", () => {
		expect(() =>
			toLegacyComposerDraftParts({
				version: 1,
				parts: [
					{ type: "text", text: "先" },
					{ type: "file", path: "C:/repo/a.ts" },
				],
			}),
		).toThrow(/inline file/i);
		expect(() =>
			toLegacyComposerDraftParts({
				version: 1,
				parts: [{ type: "skill", id: "skill-1", label: "发布检查" }],
			}),
		).toThrow(/skill/i);
	});

	it("detects file and skill references and ignores unknown file kind", () => {
		expect(composerDocumentHasReferences(EMPTY_COMPOSER_DOCUMENT)).toBe(false);
		expect(composerDocumentHasReferences(composerDocumentFromText("纯文本"))).toBe(false);
		expect(
			composerDocumentHasReferences({
				version: 1,
				parts: [
					{
						type: "file",
						path: "C:/repo/docs",
						label: "docs",
						kind: "directory",
					},
				],
			}),
		).toBe(true);
		expect(
			composerDocumentHasReferences({
				version: 1,
				parts: [{ type: "skill", id: "skill:review", label: "review" }],
			}),
		).toBe(true);
		expect(
			parseComposerDocument({
				version: 1,
				parts: [
					{
						type: "file",
						path: "C:/repo/docs",
						label: "docs",
						kind: "symlink",
					},
				],
			}),
		).toEqual({
			version: 1,
			parts: [{ type: "file", path: "C:/repo/docs", label: "docs" }],
		});
	});

	it("appends text onto an existing structured document without dropping references", () => {
		const base = {
			version: 1 as const,
			parts: [
				{ type: "text" as const, text: "看 " },
				{ type: "file" as const, path: "C:/repo/a.ts", label: "a.ts" },
			],
		};
		expect(appendComposerDocument(base, composerDocumentFromText("补充说明"))).toEqual({
			version: 1,
			parts: [
				{ type: "text", text: "看 " },
				{ type: "file", path: "C:/repo/a.ts", label: "a.ts" },
				{ type: "text", text: "\n补充说明" },
			],
		});
	});
});
