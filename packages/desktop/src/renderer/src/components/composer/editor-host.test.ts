import { composerDocumentFromText, composerDocumentText } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { $readComposerState, readComposerText } from "./editor-document";
import { getComposerEditor, releaseComposerEditor, syncComposerDocument } from "./editor-host";

describe("composer editor host", () => {
	it("reuses an editor per draft key and synchronizes external draft text", () => {
		const first = getComposerEditor("session-a", composerDocumentFromText("initial"));
		expect(getComposerEditor("session-a", composerDocumentFromText("ignored"))).toBe(first);
		let text = "";
		first.editor.getEditorState().read(() => {
			text = readComposerText();
		});
		expect(text).toBe("initial");
		syncComposerDocument(first, composerDocumentFromText("restored draft"));
		first.editor.getEditorState().read(() => {
			text = readComposerText();
		});
		expect(text).toBe("restored draft");
		releaseComposerEditor("session-a");
	});

	it("keeps inline references in the structured editor document", () => {
		const document = {
			version: 1 as const,
			parts: [
				{ type: "text" as const, text: "Review " },
				{
					type: "file" as const,
					path: "C:/work/README.md",
					label: "README.md",
				},
				{ type: "text" as const, text: " using " },
				{ type: "skill" as const, id: "review", label: "Review" },
			],
		};
		const entry = getComposerEditor("session-refs", document);
		let actual = "";
		entry.editor.getEditorState().read(() => {
			actual = composerDocumentText($readComposerState().document);
		});
		expect(actual).toBe("Review @README.md using Review");
		releaseComposerEditor("session-refs");
	});

	it("creates a fresh editor after releasing a draft key", () => {
		const first = getComposerEditor("session-b", composerDocumentFromText("one"));
		releaseComposerEditor("session-b");
		const second = getComposerEditor("session-b", composerDocumentFromText("two"));
		expect(second).not.toBe(first);
		releaseComposerEditor("session-b");
	});

	it("skips rebuilding the Lexical tree when entry.document already matches", () => {
		const doc = composerDocumentFromText("keep-nodes");
		const entry = getComposerEditor("session-noop", doc);
		const beforeState = entry.editor.getEditorState();
		syncComposerDocument(entry, doc);
		expect(entry.editor.getEditorState()).toBe(beforeState);
		releaseComposerEditor("session-noop");
	});
});
