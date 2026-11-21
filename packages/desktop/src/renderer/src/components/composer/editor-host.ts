import { LexicalBuilder } from "@lexical/extension";
import { HistoryExtension } from "@lexical/history";
import { ReactExtension } from "@lexical/react/ReactExtension";
import { ReactProviderExtension } from "@lexical/react/ReactProviderExtension";
import { RichTextExtension } from "@lexical/rich-text";
import type { ComposerDocument } from "@percho/shared";
import {
	CLEAR_HISTORY_COMMAND,
	configExtension,
	defineExtension,
	HISTORY_PUSH_TAG,
	type LexicalEditorWithDispose,
	TextNode,
} from "lexical";
import { COMPOSER_EDITOR_RELEASE_EVENT } from "../../stores/drafts.js";
import { $replaceComposerDocument } from "./editor-document";

import { ReferenceNode } from "./ReferenceNode";

const composerExtension = defineExtension({
	name: "percho/composer-stage2",
	namespace: "percho-composer-stage2",
	dependencies: [RichTextExtension, HistoryExtension],
	nodes: [ReferenceNode],
});

export interface ComposerEditorEntry {
	editor: LexicalEditorWithDispose;
	document: ComposerDocument;
}

const editors = new Map<string, ComposerEditorEntry>();

export function getComposerEditor(key: string, document: ComposerDocument): ComposerEditorEntry {
	const existing = editors.get(key);
	if (existing) return existing;
	const editor = LexicalBuilder.fromExtensions([
		ReactProviderExtension,
		configExtension(ReactExtension, { contentEditable: null }),
		composerExtension,
	]).buildEditor();
	editor.registerNodeTransform(TextNode, (node) => {
		if (node.getFormat() !== 0) node.setFormat(0);
		if (node.getStyle()) node.setStyle("");
	});
	editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
	editor.update(() => $replaceComposerDocument(document), { discrete: true });
	const entry = { editor, document };
	editors.set(key, entry);
	return entry;
}

export function syncComposerDocument(entry: ComposerEditorEntry, document: ComposerDocument): void {
	if (entry.document === document || JSON.stringify(entry.document) === JSON.stringify(document)) return;
	if (document.parts.length === 0) entry.editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
	entry.editor.update(() => $replaceComposerDocument(document), {
		tag: HISTORY_PUSH_TAG,
		discrete: true,
	});
	entry.document = document;
}

export function releaseComposerEditor(key: string): void {
	const entry = editors.get(key);
	if (!entry) return;
	entry.editor.dispose();
	editors.delete(key);
}

if (typeof window !== "undefined") {
	window.addEventListener(COMPOSER_EDITOR_RELEASE_EVENT, (event) => {
		const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
		if (sessionId) releaseComposerEditor(sessionId);
	});
}
