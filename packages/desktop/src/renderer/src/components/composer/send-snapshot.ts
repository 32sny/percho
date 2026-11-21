import {
	type ComposerDocument,
	composerDocumentHasReferences,
	type MessageMode,
	normalizeComposerDocument,
} from "@percho/shared";
import type { DraftEntry, DraftImage } from "../../stores/drafts";
import { buildQuoteBlock } from "./quote";

export interface ComposerSendSnapshot {
	draftKey: string;
	draftVersion: number;
	content: string;
	document?: ComposerDocument;
	draftDocument?: ComposerDocument;
	text: string;
	images: DraftImage[];
	attachments: string[];
	quotes: string[];
	imageNames: string[];
	wasActive: boolean;
	mode: MessageMode;
	slashCommand: string | null;
}

export function buildComposerSendContent(draft: DraftEntry): string {
	const quoteBlock = buildQuoteBlock(draft.quotes);
	const atText = draft.attachments.map((path) => `@${path}`).join(" ");
	const body = [atText, draft.text.trim()].filter(Boolean).join("\n");
	return [quoteBlock, draft.slashCommand ? `/${draft.slashCommand}${body ? ` ${body}` : ""}` : body]
		.filter(Boolean)
		.join("\n\n");
}

export function buildComposerSendDocument(draft: DraftEntry): ComposerDocument | undefined {
	if (!draft.document || !composerDocumentHasReferences(draft.document)) return undefined;
	const quoteBlock = buildQuoteBlock(draft.quotes);
	const atText = draft.attachments.map((path) => `@${path}`).join(" ");
	const prefix = [quoteBlock, atText].filter(Boolean).join("\n\n");
	if (!prefix) return normalizeComposerDocument(draft.document);
	return normalizeComposerDocument({
		version: 1,
		parts: [{ type: "text", text: `${prefix}\n\n` }, ...draft.document.parts],
	});
}

export function buildComposerSendSnapshot(
	draftKey: string,
	draft: DraftEntry,
	mode: MessageMode,
	wasActive: boolean,
	content = buildComposerSendContent(draft),
	draftVersion = 0,
): ComposerSendSnapshot {
	const { document, text, images, attachments, quotes, slashCommand } = draft;
	const sendDocument = buildComposerSendDocument(draft);
	const draftDocument = document && composerDocumentHasReferences(document) ? document : undefined;

	return {
		draftKey,
		draftVersion,
		content,
		...(sendDocument ? { document: sendDocument } : {}),
		...(draftDocument ? { draftDocument } : {}),
		text,
		images: images.map((image) => ({ ...image })),
		attachments: [...attachments],
		quotes: [...quotes],
		imageNames: images.map((image) => image.name ?? ""),
		wasActive,
		mode,
		slashCommand,
	};
}
