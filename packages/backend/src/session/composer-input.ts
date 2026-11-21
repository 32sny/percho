import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ExtensionFactory, PromptTemplate, ResourceLoader } from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	type ComposerDocument,
	type ControlResult,
	composerDocumentModelText,
	composerDocumentText,
	type MessageAck,
	type MessageSubmitRequest,
	parseComposerDocument,
	readComposerDocument,
} from "@percho/shared";

const secret = randomBytes(32);
const marker = `\n<!--percho-input-${randomBytes(8).toString("hex")}:`;
const bridgeByLoader = new WeakMap<ResourceLoader, ComposerInputBridge>();

interface Submission {
	document: ComposerDocument;
	definitions: string;
	sourceHash?: string;
}

export interface PreparedComposerInput {
	document: ComposerDocument;
	modelText: string;
	transportText: string;
	sourceHash?: string;
}

export interface StructuredSubmission {
	prepared: PreparedComposerInput;
	text: string;
	cleanText: string;
	expandPromptTemplates: boolean;
}

export function canonicalComposerJson(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value.replace(/\r\n?/g, "\n").normalize("NFC"));
	if (Array.isArray(value)) {
		return `[${value.map((item) => (item === undefined ? "null" : canonicalComposerJson(item))).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const entries = Object.keys(value as Record<string, unknown>)
			.sort()
			.flatMap((key) => {
				const entry = (value as Record<string, unknown>)[key];
				return entry === undefined
					? []
					: [`${JSON.stringify(key.normalize("NFC"))}:${canonicalComposerJson(entry)}`];
			});
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function signature(text: string, payload: string): string {
	return createHmac("sha256", secret).update(text).update("\0").update(payload).digest("hex");
}

function encode(text: string, submission: Submission): string {
	const modelText = submission.definitions
		? text
			? `${text}\n\n${submission.definitions}`
			: submission.definitions
		: text;
	const envelope = {
		version: 1 as const,
		document: submission.document,
		...(submission.sourceHash ? { sourceHash: submission.sourceHash } : {}),
	};
	const payload = Buffer.from(canonicalComposerJson(envelope)).toString("base64url");
	return `${modelText}${marker}${payload}:${signature(modelText, payload)}-->`;
}

export function decodeComposerTransport(
	text: string,
): { before: string; document: ComposerDocument; sourceHash?: string } | null {
	const start = text.lastIndexOf(marker);
	if (start < 0 || !text.endsWith("-->")) return null;
	const body = text.slice(start + marker.length, -3);
	const sep = body.indexOf(":");
	if (sep <= 0) return null;
	const payload = body.slice(0, sep);
	const digest = body.slice(sep + 1);
	const before = text.slice(0, start);
	const expected = signature(before, payload);
	if (digest.length !== expected.length) return null;
	if (!timingSafeEqual(Buffer.from(digest), Buffer.from(expected))) return null;
	try {
		const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const record = parsed as Record<string, unknown>;
		if ("document" in record) {
			if (record.version !== 1) return null;
			if (
				record.sourceHash !== undefined &&
				(typeof record.sourceHash !== "string" || !/^[0-9a-f]{64}$/.test(record.sourceHash))
			) {
				return null;
			}
			return {
				before,
				document: parseComposerDocument(record.document),
				...(record.sourceHash ? { sourceHash: record.sourceHash } : {}),
			};
		}
		return {
			before,
			document: parseComposerDocument(parsed),
		};
	} catch {
		return null;
	}
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;
	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			else current += char;
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	if (current) args.push(current);
	return args;
}

function substituteTemplateArgs(content: string, args: string[]): string {
	let result = content.replace(/\$(\d+)/g, (_, num) => {
		const index = Number.parseInt(num, 10) - 1;
		return args[index] ?? "";
	});
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
		let start = Number.parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;
		if (lengthStr) {
			const length = Number.parseInt(lengthStr, 10);
			return args.slice(start, start + length).join(" ");
		}
		return args.slice(start).join(" ");
	});
	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);
	return result;
}

function expandTemplateCommand(
	slashCommand: string,
	argsText: string,
	promptTemplates?: ReadonlyArray<PromptTemplate>,
): string {
	const template = promptTemplates?.find((item) => item.name === slashCommand);
	if (template) return substituteTemplateArgs(template.content, parseCommandArgs(argsText));
	return argsText ? `/${slashCommand} ${argsText}` : `/${slashCommand}`;
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				block?.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("");
}

type ContentBlock = { type?: string; text?: string; [key: string]: unknown };

function replaceTextContent(content: unknown, text: string): string | ContentBlock[] {
	if (typeof content === "string") return text;
	if (!Array.isArray(content)) return [{ type: "text", text }];
	const nonText = content.filter((block): block is ContentBlock => Boolean(block) && block?.type !== "text");
	return [{ type: "text", text }, ...nonText];
}

export function skillResourceId(filePath: string): string {
	return createHash("sha256").update(filePath).digest("hex").slice(0, 16);
}

export function attachComposerInputBridge(loader: ResourceLoader, bridge: ComposerInputBridge): void {
	bridgeByLoader.set(loader, bridge);
}

export function composerInputBridge(loader: ResourceLoader): ComposerInputBridge | undefined {
	return bridgeByLoader.get(loader);
}

export function composerQueueText(text: string): string {
	const decoded = decodeComposerTransport(text);
	return decoded ? composerDocumentText(decoded.document) : text;
}

export function composerQueueDocument(text: string): ComposerDocument | undefined {
	return decodeComposerTransport(text)?.document;
}

export function projectComposerMessage<T>(message: T): T {
	if (!message || typeof message !== "object") return message;
	const raw = message as { role?: unknown; content?: unknown; perchoInput?: unknown };
	if (raw.role !== "user") return message;
	const document = readComposerDocument(raw) ?? decodeComposerTransport(textContent(raw.content))?.document;
	if (!document) return message;
	return {
		...raw,
		content: replaceTextContent(raw.content, composerDocumentText(document)),
		perchoInput: document,
	} as T;
}

export class ComposerInputBridge {
	private readonly submissions = new Map<
		string,
		{ fingerprint: string; result: Promise<ControlResult<MessageAck>> }
	>();

	/** Snapshot the original request before resource IO, so ACK retries cannot change when a skill is edited. */
	submit(
		request: MessageSubmitRequest,
		invoke: () => Promise<ControlResult<MessageAck>>,
	): Promise<ControlResult<MessageAck>> {
		const key = JSON.stringify([request.runtimeId, request.requestId]);
		const fingerprint = canonicalComposerJson(request);
		const previous = this.submissions.get(key);
		if (previous) {
			return previous.fingerprint === fingerprint
				? previous.result
				: Promise.resolve({
						ok: false,
						error: { code: "request_id_conflict", message: "Request ID was reused with different input" },
					});
		}
		const result = Promise.resolve().then(invoke);
		const record = { fingerprint, result };
		this.submissions.set(key, record);
		void result.then(
			(value) => {
				if (!value.ok && this.submissions.get(key) === record) this.submissions.delete(key);
			},
			() => {
				if (this.submissions.get(key) === record) this.submissions.delete(key);
			},
		);
		return result;
	}

	async prepare(
		loader: ResourceLoader,
		rawDocument: ComposerDocument,
		options?: {
			slashCommand?: string | null;
			promptTemplates?: ReadonlyArray<PromptTemplate>;
			isRemote?: boolean;
			expectedSourceHash?: string;
		},
	): Promise<PreparedComposerInput> {
		const document = parseComposerDocument(rawDocument);
		const skills = loader.getSkills().skills;
		const byId = new Map(skills.map((skill) => [skillResourceId(skill.filePath), skill]));
		const byName = new Map(skills.map((skill) => [skill.name, skill]));
		const seen = new Set<string>();
		const blocks: string[] = [];
		const hashedSources: Array<{ id: string; body: string }> = [];

		const includeSkill = async (skill: (typeof skills)[number], id: string) => {
			if (seen.has(skill.filePath)) return;
			seen.add(skill.filePath);
			const body = stripFrontmatter(await readFile(skill.filePath, "utf8")).trim();
			hashedSources.push({ id, body });
			blocks.push(
				`<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.filePath)}">\n${body}\n</skill>`,
			);
		};

		for (const part of document.parts) {
			if (part.type === "file") {
				if (options?.isRemote) throw new Error("Remote sessions cannot reference local files");
				if (part.path.includes("\0") || !isAbsolute(part.path)) {
					throw new Error(`Invalid file reference path: ${part.path}`);
				}
				continue;
			}
			if (part.type !== "skill") continue;
			const skill = byId.get(part.id);
			if (!skill) throw new Error(`Skill is unavailable: ${part.label}`);
			await includeSkill(skill, part.id);
		}

		let slashCommand = options?.slashCommand ?? null;
		if (slashCommand?.startsWith("skill:")) {
			const skillName = slashCommand.slice("skill:".length);
			const skill = byName.get(skillName);
			if (!skill) throw new Error(`Skill is unavailable: ${skillName}`);
			await includeSkill(skill, skillResourceId(skill.filePath));
			slashCommand = null;
		}

		const sourceHash =
			hashedSources.length > 0
				? createHash("sha256")
						.update(
							hashedSources
								.sort((a, b) => a.id.localeCompare(b.id))
								.map((item) => `${item.id}\0${item.body}`)
								.join("\n"),
						)
						.digest("hex")
				: undefined;
		if (options?.expectedSourceHash && options.expectedSourceHash !== sourceHash) {
			throw new Error("Skill source hash mismatch");
		}

		const definitions =
			blocks.length > 0 ? `<referenced_skills>\n${blocks.join("\n")}\n</referenced_skills>` : "";
		const rawModelText = composerDocumentModelText(document);
		const modelText = slashCommand
			? expandTemplateCommand(slashCommand, rawModelText, options?.promptTemplates)
			: rawModelText;
		const transportText = encode(modelText, { document, definitions, sourceHash });
		return { document, modelText, transportText, ...(sourceHash ? { sourceHash } : {}) };
	}

	async prepareSubmission(
		loader: ResourceLoader,
		rawDocument: ComposerDocument,
		options?: {
			slashCommand?: string | null;
			promptTemplates?: ReadonlyArray<PromptTemplate>;
			isRemote?: boolean;
			expectedSourceHash?: string;
			isExtensionCommand?: (commandName: string) => boolean;
		},
	): Promise<StructuredSubmission> {
		const prepared = await this.prepare(loader, rawDocument, options);
		const rawModelText = composerDocumentModelText(prepared.document);
		const slashCommand = options?.slashCommand ?? null;
		const commandCandidate = slashCommand
			? rawModelText
				? `/${slashCommand} ${rawModelText}`
				: `/${slashCommand}`
			: rawModelText;
		const trimmed = commandCandidate.trimStart();
		let extensionCommand = false;
		if (trimmed.startsWith("/")) {
			const spaceIndex = trimmed.indexOf(" ");
			const commandName = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
			extensionCommand = Boolean(commandName && options?.isExtensionCommand?.(commandName));
		}
		return {
			prepared,
			text: extensionCommand ? commandCandidate : prepared.transportText,
			cleanText: composerDocumentText(prepared.document),
			expandPromptTemplates: extensionCommand,
		};
	}
}

export function composerInputExtension(): ExtensionFactory {
	return (pi) => {
		pi.on("message_end", (event) => {
			const message = event.message as { role?: unknown; content?: unknown; perchoInput?: unknown };
			if (message.role !== "user") return;
			const decoded = decodeComposerTransport(textContent(message.content));
			if (!decoded) return;
			message.content = replaceTextContent(message.content, decoded.before);
			message.perchoInput = decoded.document;
		});
	};
}
