import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { describe, expect, it } from "vitest";
import { readComposerSelection, readComposerText, setComposerSelection } from "./editor-document";

function editor() {
	return createEditor({
		namespace: "composer-multiblock-test",
		onError: (error) => {
			throw error;
		},
	});
}

describe("Lexical composer native blocks", () => {
	it("maps selections across paragraphs with newline offsets", () => {
		const instance = editor();
		instance.update(() => {
			const root = $getRoot();
			root.clear();
			root.append($createParagraphNode().append($createTextNode("first")));
			root.append($createParagraphNode().append($createTextNode("second")));
		});
		instance.update(() => setComposerSelection(6, 8), { discrete: true });
		let result = { text: "", start: 0, end: 0 };
		instance.getEditorState().read(() => {
			const selection = readComposerSelection();
			result = { text: readComposerText(), start: selection.start, end: selection.end };
		});
		expect(result).toEqual({ text: "first\nsecond", start: 6, end: 8 });
	});
});
