import {
	type ComposerDocument,
	type ComposerPart,
	composerDocumentFromText,
	normalizeComposerDocument,
} from "@percho/shared";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	$isTextNode,
	type LexicalNode,
} from "lexical";
import { $createReferenceNode, ReferenceNode } from "./ReferenceNode";

export interface ComposerSelection {
	start: number;
	end: number;
}

export interface ComposerEditorHandle {
	readonly value: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
	focus(position?: "start" | "end"): void;
	getText(): string;
	getDocument(): ComposerDocument;
	getCompletionText(): string;
	getSelection(): ComposerSelection;
	selectionRange(): ComposerSelection;
	setSelectionRange(start: number, end: number): void;
	replaceRange(start: number, end: number, replacement: string): void;
	replaceRangeWithReference(
		start: number,
		end: number,
		reference: Exclude<ComposerPart, { type: "text" }>,
	): void;
	insertReferences(references: Exclude<ComposerPart, { type: "text" }>[], range?: ComposerSelection): void;
}

export interface ComposerEditorState {
	document: ComposerDocument;
	text: string;
	completionText: string;
	cursor: number;
	selectionStart: number;
	selectionEnd: number;
}

function composerPointOffset(
	point: { key: string; offset: number; type: "text" | "element" },
	positions: Map<string, { start: number; end: number; children?: number[] }>,
): number {
	const position = positions.get(point.key);
	if (!position) return 0;
	return point.type === "text"
		? position.start + point.offset
		: (position.children?.[point.offset] ?? position.end);
}

export function composerDocumentCompletionText(document: ComposerDocument): string {
	return document.parts
		.map((part) =>
			part.type === "text"
				? part.text
				: " ".repeat(part.type === "skill" ? part.label.length : `@${part.label ?? part.path}`.length),
		)
		.join("");
}

/** Must run inside a Lexical editor transaction. */
export function $readComposerState(): ComposerEditorState {
	let text = "";
	const parts: ComposerPart[] = [];
	const positions = new Map<string, { start: number; end: number; children?: number[] }>();
	const visit = (node: LexicalNode) => {
		const start = text.length;
		if ($isElementNode(node)) {
			const children = [start];
			for (const child of node.getChildren()) {
				visit(child);
				children.push(text.length);
			}
			positions.set(node.getKey(), { start, end: text.length, children });
			return;
		}
		const nodeText = node.getTextContent();
		text += nodeText;
		parts.push(node instanceof ReferenceNode ? node.getReference() : { type: "text", text: nodeText });
		positions.set(node.getKey(), { start, end: text.length });
	};

	const boundaries = [0];
	for (const [index, node] of $getRoot().getChildren().entries()) {
		if (index > 0) {
			text += "\n";
			parts.push({ type: "text", text: "\n" });
		}
		visit(node);
		boundaries.push(text.length);
	}
	positions.set($getRoot().getKey(), {
		start: 0,
		end: text.length,
		children: boundaries,
	});

	const selection = $getSelection();
	const anchor = $isRangeSelection(selection) ? selection.anchor : null;
	const focus = $isRangeSelection(selection) ? selection.focus : null;
	const cursor = anchor ? composerPointOffset(anchor, positions) : text.length;
	const selectionStart = anchor ? composerPointOffset(anchor, positions) : cursor;
	const selectionEnd = focus ? composerPointOffset(focus, positions) : cursor;
	const document = normalizeComposerDocument({ version: 1, parts });
	const completionText = composerDocumentCompletionText(document);
	return {
		document,
		text,
		completionText,
		cursor,
		selectionStart,
		selectionEnd,
	};
}

export function $replaceComposerDocument(document: ComposerDocument): void {
	const root = $getRoot();
	root.clear();
	let paragraph = $createParagraphNode();
	root.append(paragraph);
	for (const part of document.parts) {
		if (part.type !== "text") {
			paragraph.append($createReferenceNode(part));
			continue;
		}
		for (const [index, line] of part.text.split("\n").entries()) {
			if (index > 0) {
				paragraph = $createParagraphNode();
				root.append(paragraph);
			}
			if (line) paragraph.append($createTextNode(line));
		}
	}
	if (root.getChildrenSize() === 0) root.append($createParagraphNode());
}

export function $selectComposerOffset(offset: number): void {
	let remaining = offset;
	for (const [index, paragraph] of $getRoot().getChildren().entries()) {
		if (index > 0) remaining--;
		if (!$isElementNode(paragraph)) continue;
		if (remaining <= 0) {
			paragraph.selectStart();
			return;
		}
		for (const node of paragraph.getChildren()) {
			if (remaining <= node.getTextContentSize()) {
				if ($isTextNode(node) && !(node instanceof ReferenceNode)) node.select(remaining, remaining);
				else {
					const boundary = node.getIndexWithinParent() + (remaining > 0 ? 1 : 0);
					paragraph.select(boundary, boundary);
				}
				return;
			}
			remaining -= node.getTextContentSize();
		}
	}
	$getRoot().selectEnd();
}

export function $selectComposerRange(start: number, end: number): void {
	if (start === end) {
		$selectComposerOffset(start);
		return;
	}
	$selectComposerOffset(end);
	const last = $getSelection();
	if (!$isRangeSelection(last)) return;
	const point = {
		key: last.anchor.key,
		offset: last.anchor.offset,
		type: last.anchor.type,
	};
	$selectComposerOffset(start);
	const selection = $getSelection();
	if ($isRangeSelection(selection)) selection.focus.set(point.key, point.offset, point.type);
}

export function $replaceComposerRangeWithText(start: number, end: number, replacement: string): void {
	$selectComposerRange(start, end);
	const selection = $getSelection();
	if (!$isRangeSelection(selection)) return;
	if (replacement) selection.insertText(replacement);
	else selection.removeText();
}

export function $replaceComposerRangeWithReference(
	start: number,
	end: number,
	reference: Exclude<ComposerPart, { type: "text" }>,
): void {
	$selectComposerRange(start, end);
	const selection = $getSelection();
	if ($isRangeSelection(selection))
		selection.insertNodes([$createReferenceNode(reference), $createTextNode(" ")]);
}

export function $insertComposerReferences(
	references: Exclude<ComposerPart, { type: "text" }>[],
	range?: ComposerSelection,
): void {
	if (references.length === 0) return;
	if (range) $selectComposerRange(range.start, range.end);
	else if (!$isRangeSelection($getSelection())) $getRoot().selectEnd();
	const selection = $getSelection();
	if ($isRangeSelection(selection)) {
		selection.insertNodes(
			references.flatMap((reference) => [$createReferenceNode(reference), $createTextNode(" ")]),
		);
	}
}

export function readComposerText(): string {
	return $readComposerState().text;
}

export function readComposerSelection(): ComposerSelection {
	const state = $readComposerState();
	return { start: state.selectionStart, end: state.selectionEnd };
}

export function replaceComposerText(text: string, selection?: ComposerSelection): void {
	$replaceComposerDocument(composerDocumentFromText(text));
	if (selection) $selectComposerRange(selection.start, selection.end);
}

export function setComposerSelection(start: number, end: number): void {
	$selectComposerRange(start, end);
}
