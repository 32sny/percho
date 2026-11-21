export type ComposerPart =
	| { type: "text"; text: string }
	| { type: "skill"; id: string; label: string }
	| { type: "file"; path: string; label?: string; kind?: "file" | "directory" };

export interface ComposerDocument {
	version: 1;
	parts: ComposerPart[];
}

export interface LegacyComposerDraft {
	text: string;
	attachments: string[];
	slashCommand: string | null;
}

export interface MigratedLegacyComposerDraft {
	document: ComposerDocument;
	slashCommand: string | null;
}

export interface LegacyComposerDraftParts {
	text: string;
	attachments: string[];
}

export const EMPTY_COMPOSER_DOCUMENT: ComposerDocument = {
	version: 1,
	parts: [],
};

export function composerDocumentFromText(text: string): ComposerDocument {
	return text ? { version: 1, parts: [{ type: "text", text }] } : EMPTY_COMPOSER_DOCUMENT;
}

export function composerPartText(part: ComposerPart): string {
	return part.type === "text"
		? part.text
		: part.type === "skill"
			? part.label
			: `@${part.label ?? part.path}`;
}

export function composerDocumentModelText(document: ComposerDocument): string {
	return document.parts
		.map((part) => (part.type === "file" ? `@${part.path}` : composerPartText(part)))
		.join("");
}

export function composerDocumentHasReferences(document: ComposerDocument): boolean {
	return document.parts.some((part) => part.type === "file" || part.type === "skill");
}

export function appendComposerDocument(base: ComposerDocument, extra: ComposerDocument): ComposerDocument {
	if (base.parts.length === 0) return normalizeComposerDocument(extra);
	if (extra.parts.length === 0) return normalizeComposerDocument(base);
	return normalizeComposerDocument({
		version: 1,
		parts: [...base.parts, { type: "text", text: "\n" }, ...extra.parts],
	});
}

export function composerDocumentText(document: ComposerDocument): string {
	return document.parts.map(composerPartText).join("");
}

export function readComposerDocument(raw: unknown): ComposerDocument | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const input = (raw as { perchoInput?: unknown }).perchoInput;
	if (input === undefined) return undefined;
	try {
		if (input && typeof input === "object" && "document" in input) {
			const envelope = input as { version?: unknown; document?: unknown };
			if (envelope.version !== 1) return undefined;
			return parseComposerDocument(envelope.document);
		}
		return parseComposerDocument(input);
	} catch {
		return undefined;
	}
}

export function normalizeComposerDocument(document: ComposerDocument): ComposerDocument {
	const parts: ComposerPart[] = [];
	for (const part of document.parts) {
		if (part.type === "text") {
			if (!part.text) continue;
			const previous = parts.at(-1);
			if (previous?.type === "text") previous.text += part.text;
			else parts.push({ ...part });
		} else {
			parts.push({ ...part });
		}
	}
	return parts.length ? { version: 1, parts } : EMPTY_COMPOSER_DOCUMENT;
}

export function parseComposerDocument(value: unknown): ComposerDocument {
	if (!value || typeof value !== "object") throw new Error("Invalid composer document");
	const document = value as Record<string, unknown>;
	if (document.version !== 1 || !Array.isArray(document.parts)) throw new Error("Invalid composer document");
	const parts = document.parts.map((item: unknown): ComposerPart => {
		if (!item || typeof item !== "object") throw new Error("Invalid composer part");
		const part = item as Record<string, unknown>;
		if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
		if (part.type === "skill" && typeof part.id === "string" && part.id && typeof part.label === "string") {
			return { type: "skill", id: part.id, label: part.label };
		}
		if (part.type === "file" && typeof part.path === "string" && part.path) {
			if (part.label !== undefined && typeof part.label !== "string") throw new Error("Invalid file label");
			return {
				type: "file",
				path: part.path,
				...(part.label === undefined ? {} : { label: part.label as string }),
				...(part.kind === "directory" ? { kind: "directory" as const } : {}),
			};
		}
		throw new Error("Invalid composer part");
	});
	return normalizeComposerDocument({ version: 1, parts });
}

function displayName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	return (trimmed || path).split(/[\\/]/).at(-1) || path;
}

export function migrateLegacyComposerDraft(
	draft: LegacyComposerDraft,
	resolveAttachmentPath: (path: string) => string | null,
): MigratedLegacyComposerDraft {
	const parts: ComposerPart[] = [];
	for (const [index, attachment] of draft.attachments.entries()) {
		const path = resolveAttachmentPath(attachment);
		if (!path) throw new Error(`Attachment path unavailable: ${attachment}`);
		if (index > 0) parts.push({ type: "text", text: " " });
		parts.push({
			type: "file",
			path,
			label: displayName(attachment),
			kind: "file",
		});
	}
	if (draft.text) {
		if (parts.length) parts.push({ type: "text", text: "\n" });
		parts.push({ type: "text", text: draft.text });
	}
	return {
		document: normalizeComposerDocument({ version: 1, parts }),
		slashCommand: draft.slashCommand,
	};
}

export function toLegacyComposerDraftParts(document: ComposerDocument): LegacyComposerDraftParts {
	const attachments: string[] = [];
	let index = 0;
	while (index < document.parts.length && document.parts[index]?.type === "file") {
		const part = document.parts[index];
		if (part?.type !== "file") break;
		attachments.push(part.path);
		index += 1;
		const separator = document.parts[index];
		if (separator?.type === "text" && separator.text === " ") index += 1;
	}
	if (document.parts.some((part) => part.type === "skill"))
		throw new Error("Skill token is not legacy representable");
	if (document.parts.slice(index).some((part) => part.type === "file"))
		throw new Error("Inline file token is not legacy representable");
	const rest = document.parts.slice(index);
	let text = rest.map(composerPartText).join("");
	if (attachments.length && text.startsWith("\n")) text = text.slice(1);
	return { text, attachments };
}
