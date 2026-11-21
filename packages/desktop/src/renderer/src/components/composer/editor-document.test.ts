import { $getSelection, $isRangeSelection, createEditor } from "lexical";
import { describe, expect, it } from "vitest";
import {
	$insertComposerReferences,
	$readComposerState,
	$replaceComposerDocument,
	$replaceComposerRangeWithReference,
	$replaceComposerRangeWithText,
	$selectComposerOffset,
	composerDocumentCompletionText,
	readComposerSelection,
	readComposerText,
	replaceComposerText,
	setComposerSelection,
} from "./editor-document";
import { ReferenceNode } from "./ReferenceNode";

function makeEditor() {
	return createEditor({
		namespace: "composer-document-test",
		nodes: [ReferenceNode],
		onError: (error) => {
			throw error;
		},
	});
}

function read(editor: ReturnType<typeof makeEditor>) {
	let value = { text: "", start: 0, end: 0 };
	editor.getEditorState().read(() => {
		const selection = readComposerSelection();
		value = {
			text: readComposerText(),
			start: selection.start,
			end: selection.end,
		};
	});
	return value;
}

describe("Lexical composer document", () => {
	it("keeps plain text and newline boundaries", () => {
		const editor = makeEditor();
		editor.update(() => replaceComposerText("第一行\n第二行", { start: 8, end: 8 }), { discrete: true });
		expect(read(editor)).toEqual({ text: "第一行\n第二行", start: 7, end: 7 });
	});

	it("maps selection offsets using UTF-16 code units", () => {
		const editor = makeEditor();
		editor.update(() => replaceComposerText("A😀\nB", { start: 3, end: 3 }), {
			discrete: true,
		});
		expect(read(editor)).toEqual({ text: "A😀\nB", start: 3, end: 3 });
		editor.update(() => setComposerSelection(4, 5), { discrete: true });
		expect(read(editor)).toEqual({ text: "A😀\nB", start: 4, end: 5 });
	});

	it("replaces a range with an inline reference token and masks it in completionText", () => {
		const editor = makeEditor();
		editor.update(() => replaceComposerText("请看 @read", { start: 8, end: 8 }), { discrete: true });
		editor.update(
			() =>
				$replaceComposerRangeWithReference(3, 8, {
					type: "file",
					path: "C:/repo/README.md",
					label: "README.md",
				}),
			{ discrete: true },
		);
		let state = {
			text: "",
			completionText: "",
			parts: [] as unknown[],
			selectionStart: 0,
			selectionEnd: 0,
		};
		editor.getEditorState().read(() => {
			const current = $readComposerState();
			state = {
				text: current.text,
				completionText: current.completionText,
				parts: current.document.parts,
				selectionStart: current.selectionStart,
				selectionEnd: current.selectionEnd,
			};
		});
		expect(state.parts).toEqual([
			{ type: "text", text: "请看 " },
			{ type: "file", path: "C:/repo/README.md", label: "README.md" },
			{ type: "text", text: " " },
		]);
		expect(state.text).toBe("请看 @README.md ");
		expect(state.completionText).toBe(`请看 ${" ".repeat("@README.md".length)} `);
		expect(
			composerDocumentCompletionText({
				version: 1,
				parts: state.parts as never,
			}),
		).toBe(state.completionText);
		expect(state.selectionStart).toBe("请看 @README.md ".length);
		expect(state.selectionEnd).toBe("请看 @README.md ".length);
	});

	it("never places the caret inside a ReferenceNode token", () => {
		const editor = makeEditor();
		editor.update(
			() =>
				$replaceComposerDocument({
					version: 1,
					parts: [
						{ type: "text", text: "ab" },
						{ type: "skill", id: "skill:review", label: "review" },
						{ type: "text", text: "cd" },
					],
				}),
			{ discrete: true },
		);
		editor.update(() => $selectComposerOffset(4), { discrete: true });
		editor.getEditorState().read(() => {
			const selection = $getSelection();
			expect($isRangeSelection(selection)).toBe(true);
			if ($isRangeSelection(selection)) {
				expect(selection.anchor.getNode() instanceof ReferenceNode).toBe(false);
			}
			const current = $readComposerState();
			expect(current.selectionStart).toBe("abreview".length);
			expect(current.selectionEnd).toBe("abreview".length);
		});
	});

	it("preserves existing references when replacing a text range or inserting multiple files", () => {
		const editor = makeEditor();
		editor.update(
			() =>
				$replaceComposerDocument({
					version: 1,
					parts: [
						{ type: "file", path: "C:/repo/a.ts", label: "a.ts" },
						{ type: "text", text: " @src" },
					],
				}),
			{ discrete: true },
		);
		editor.update(() => $replaceComposerRangeWithText(6, 10, "@src/"), {
			discrete: true,
		});
		editor.update(
			() =>
				$insertComposerReferences(
					[
						{ type: "file", path: "C:/repo/b.ts", label: "b.ts" },
						{
							type: "file",
							path: "C:/repo/docs",
							label: "docs",
							kind: "directory",
						},
					],
					{ start: 11, end: 11 },
				),
			{ discrete: true },
		);
		let parts: unknown[] = [];
		editor.getEditorState().read(() => {
			parts = $readComposerState().document.parts;
		});
		expect(parts).toEqual([
			{ type: "file", path: "C:/repo/a.ts", label: "a.ts" },
			{ type: "text", text: " @src/" },
			{ type: "file", path: "C:/repo/b.ts", label: "b.ts" },
			{ type: "text", text: " " },
			{ type: "file", path: "C:/repo/docs", label: "docs", kind: "directory" },
			{ type: "text", text: " " },
		]);
	});
});
