import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AssistantMessage, AssistantMessageEventStream, Message, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	ExtensionFactory,
	LoadExtensionsResult,
	ModelRuntime,
	PromptTemplate,
	ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	createEventBus,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sanitizeSessionEvent, sanitizeSessionMessage } from "../src/lan/sanitize";
import { PermissionGate } from "../src/permissions/gate";
import { PiBackend } from "../src/pi-backend";
import {
	attachComposerInputBridge,
	ComposerInputBridge,
	canonicalComposerJson,
	composerInputExtension,
	composerQueueDocument,
	composerQueueText,
	decodeComposerTransport,
	projectComposerMessage,
	skillResourceId,
} from "../src/session/composer-input";
import { ExtensionDialogHost } from "../src/session/extension-dialog-host";
import { createMessageControlAdapter } from "../src/session/message-control";
import { readSessionMessagesFromContent } from "../src/session/messages";
import type { SessionRegistry } from "../src/session/registry";
import { previewSessionFile } from "../src/session/title-preview";

const root = mkdtempSync(join(tmpdir(), "composer-input-contract-"));
const skillPath = join(root, "review.md");
const skill = { name: "review", filePath: skillPath };
const loader = {
	getSkills: () => ({ skills: [skill] }),
} as unknown as ResourceLoader;

const TEST_MODEL: Model<"openai-completions"> = {
	id: "composer-input-test",
	name: "composer-input-test",
	provider: "test",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function textTurn(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "test",
		model: TEST_MODEL.id,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function streamResponse(message: AssistantMessage): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

function resolveExtensionLoaderUrl(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 8; depth++) {
		const candidate = resolve(
			dir,
			"node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",
		);
		if (existsSync(candidate)) return pathToFileURL(candidate).href;
		dir = dirname(dir);
	}
	throw new Error("Cannot locate pi-coding-agent extension loader");
}

async function loadInlineExtensions(
	factories: ExtensionFactory[],
	cwd: string,
): Promise<LoadExtensionsResult> {
	const extLoader = (await import(resolveExtensionLoaderUrl())) as unknown as {
		createExtensionRuntime: () => LoadExtensionsResult["runtime"];
		loadExtensionFromFactory: (
			factory: ExtensionFactory,
			cwd: string,
			eventBus: ReturnType<typeof createEventBus>,
			runtime: LoadExtensionsResult["runtime"],
			extensionPath?: string,
		) => Promise<LoadExtensionsResult["extensions"][number]>;
	};
	const runtime = extLoader.createExtensionRuntime();
	const eventBus = createEventBus();
	const extensions: LoadExtensionsResult["extensions"] = [];
	for (const [index, factory] of factories.entries()) {
		extensions.push(
			await extLoader.loadExtensionFromFactory(factory, cwd, eventBus, runtime, `<inline:test-${index + 1}>`),
		);
	}
	return { extensions, errors: [], runtime };
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) {
		await fn();
	}
});

beforeAll(async () => {
	await mkdir(root, { recursive: true });
	await writeFile(skillPath, "---\ndescription: review\n---\nUse the review checklist.", "utf8");
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

async function createBackendFixture(options?: {
	extensions?: ExtensionFactory[];
	promptTemplates?: PromptTemplate[];
	streamGate?: () => Promise<void>;
}) {
	const dir = mkdtempSync(join(tmpdir(), "composer-input-sdk-"));
	const localSkillPath = join(dir, "review.md");
	writeFileSync(localSkillPath, "---\ndescription: review\n---\nUse the review checklist.", "utf8");
	const localSkill = {
		name: "review",
		description: "review",
		filePath: localSkillPath,
		baseDir: dir,
		sourceInfo: {
			path: localSkillPath,
			source: "project",
			scope: "project" as const,
			origin: "top-level" as const,
			baseDir: dir,
		},
		disableModelInvocation: false,
	};
	const bridge = new ComposerInputBridge();
	const extensionsResult = await loadInlineExtensions(
		[composerInputExtension(), ...(options?.extensions ?? [])],
		dir,
	);
	const resourceLoader: ResourceLoader = {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [localSkill], diagnostics: [] }),
		getPrompts: () => ({ prompts: [...(options?.promptTemplates ?? [])], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "Test assistant",
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
	attachComposerInputBridge(resourceLoader, bridge);

	const sessionManager = SessionManager.create(dir, dir);
	const modelRuntime = {
		getModel: () => TEST_MODEL,
		hasConfiguredAuth: () => true,
		checkAuth: async () => ({ type: "api_key", key: "test-key" }),
		getAuth: async () => undefined,
		isUsingOAuth: () => false,
		getAvailableSnapshot: () => [TEST_MODEL],
	} as unknown as ModelRuntime;

	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: TEST_MODEL,
		modelRuntime,
		sessionManager,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		}),
		resourceLoader,
		tools: [],
		customTools: [],
	});

	const requests: Message[][] = [];
	session.agent.streamFunction = (_model, context) => {
		requests.push(structuredClone(context.messages));
		if (!options?.streamGate) return streamResponse(textTurn("done"));
		const stream = createAssistantMessageEventStream();
		void options.streamGate().then(() => {
			const msg = textTurn("done");
			stream.push({ type: "start", partial: msg });
			stream.push({ type: "done", reason: "stop", message: msg });
		});
		return stream;
	};

	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	const messageControl = (
		session as AgentSession & { enableMessageControl: () => NonNullable<unknown> }
	).enableMessageControl() as NonNullable<Parameters<SessionRegistry["add"]>[0]["messageControl"]>;
	const messageControlAdapter = createMessageControlAdapter(messageControl);
	const gate = new PermissionGate(() => {});
	const dialogs = new ExtensionDialogHost({
		onRequest: () => {},
		onResolved: () => {},
	});
	dialogs.bind(session.sessionId);
	registry.add({
		session,
		unsubscribe: () => {},
		cwd: dir,
		messageControl,
		messageControlAdapter,
		gate,
		dialogs,
		modeRef: { current: "default" },
	});

	cleanups.push(async () => {
		try {
			await messageControl.waitForIdle();
		} catch {}
		try {
			messageControl.dispose();
		} catch {}
		try {
			await session.waitForIdle();
		} catch {}
		try {
			session.dispose();
		} catch {}
		rmSync(dir, { recursive: true, force: true });
	});

	return {
		backend,
		session,
		sessionManager,
		messageControl,
		dir,
		localSkillPath,
		localSkillId: skillResourceId(localSkillPath),
		requests,
	};
}

describe("composer input transport", () => {
	it("expands a hashed skill reference, computes sourceHash, and signs canonical JSON", async () => {
		const document = {
			version: 1 as const,
			parts: [
				{ type: "text" as const, text: "Review " },
				{ type: "skill" as const, id: skillResourceId(skillPath), label: "review" },
			],
		};
		const prepared = await new ComposerInputBridge().prepare(loader, document);
		const decoded = decodeComposerTransport(prepared.transportText);

		expect(prepared.modelText).toBe("Review review");
		expect(prepared.sourceHash).toMatch(/^[0-9a-f]{64}$/);
		expect(prepared.transportText).toContain("<referenced_skills>");
		expect(prepared.transportText).toContain("Use the review checklist.");
		expect(decoded?.document).toEqual(document);
		expect(decoded?.sourceHash).toBe(prepared.sourceHash);
		expect(composerQueueText(prepared.transportText)).toBe("Review review");
		expect(composerQueueDocument(prepared.transportText)).toEqual(document);

		expect(canonicalComposerJson({ b: "a\r\nb", a: { y: 1, x: "e\u0301" } })).toBe(
			canonicalComposerJson({ a: { x: "\u00e9", y: 1 }, b: "a\nb" }),
		);
	});

	it("rejects tampering, sourceHash mismatch, unavailable skills, and unsafe file paths", async () => {
		const bridge = new ComposerInputBridge();
		const document = {
			version: 1 as const,
			parts: [{ type: "skill" as const, id: skillResourceId(skillPath), label: "review" }],
		};
		const prepared = await bridge.prepare(loader, document);
		expect(decodeComposerTransport(`${prepared.transportText} changed`)).toBeNull();
		expect(decodeComposerTransport(prepared.transportText.slice(0, -10))).toBeNull();

		await expect(bridge.prepare(loader, document, { expectedSourceHash: "0".repeat(64) })).rejects.toThrow(
			"Skill source hash mismatch",
		);

		await expect(
			bridge.prepare(loader, {
				version: 1,
				parts: [{ type: "skill", id: "missing-skill", label: "missing" }],
			}),
		).rejects.toThrow("Skill is unavailable");

		await expect(
			bridge.prepare(loader, {
				version: 1,
				parts: [{ type: "file", path: "../secret.txt", label: "secret.txt" }],
			}),
		).rejects.toThrow("Invalid file reference path");

		await expect(
			bridge.prepare(loader, {
				version: 1,
				parts: [{ type: "file", path: "C:/repo/a\0b.txt", label: "a.txt" }],
			}),
		).rejects.toThrow("Invalid file reference path");

		await expect(
			bridge.prepare(
				loader,
				{
					version: 1,
					parts: [{ type: "file", path: "C:/repo/README.md", label: "README.md" }],
				},
				{ isRemote: true },
			),
		).rejects.toThrow("Remote sessions cannot reference local files");
	});

	it("projects decoded input into transcript-safe text and perchoInput", async () => {
		const document = {
			version: 1 as const,
			parts: [
				{ type: "file" as const, path: "C:/project/README.md", label: "README.md", kind: "file" as const },
			],
		};
		const prepared = await new ComposerInputBridge().prepare(loader, document);
		const projected = projectComposerMessage({ role: "user", content: prepared.transportText }) as {
			role: string;
			content: string;
			perchoInput?: unknown;
		};
		expect(projected.content).toBe("@README.md");
		expect(projected.perchoInput).toEqual({
			version: 1,
			parts: [{ type: "file", path: "C:/project/README.md", label: "README.md" }],
		});
	});
});

describe("composer input SDK & PiBackend integration", () => {
	it("keeps same-requestId submitMessage idempotent even if skill file changes between retries", async () => {
		const fx = await createBackendFixture();
		const snapshot = await fx.backend.getMessageControl(fx.session.sessionId);
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) return;

		const doc = {
			version: 1 as const,
			parts: [
				{ type: "text" as const, text: "Check " },
				{ type: "skill" as const, id: fx.localSkillId, label: "review" },
			],
		};
		const req = {
			sessionId: fx.session.sessionId,
			runtimeId: snapshot.value.runtimeId,
			requestId: "req-retry-1",
			mode: "queue" as const,
			payload: {
				text: "Check review",
				document: doc,
				draft: {
					text: "Check review",
					document: doc,
					attachments: [],
					quotes: [],
					slashCommand: null,
				},
			},
		};

		const first = await fx.backend.submitMessage(req);
		expect(first.ok).toBe(true);
		await writeFile(fx.localSkillPath, "---\ndescription: review\n---\nUpdated checklist v2.", "utf8");
		const second = await fx.backend.submitMessage(req);
		expect(second).toEqual(first);
		await fx.messageControl.waitForIdle();
	});

	it("never leaks transport markers or skill bodies in queue previews and preserves draft on recover", async () => {
		let releaseStream: (() => void) | undefined;
		let markEntered!: () => void;
		const streamEntered = new Promise<void>((resolveEntered) => {
			markEntered = resolveEntered;
		});
		let gateCount = 0;
		const fx = await createBackendFixture({
			streamGate: () => {
				gateCount += 1;
				if (gateCount === 1) {
					markEntered();
					return new Promise<void>((resolveGate) => {
						releaseStream = resolveGate;
					});
				}
				return Promise.resolve();
			},
		});

		try {
			const snap0 = await fx.backend.getMessageControl(fx.session.sessionId);
			expect(snap0.ok).toBe(true);
			if (!snap0.ok) return;

			// Start first run so subsequent submissions queue
			const firstAck = await fx.backend.submitMessage({
				sessionId: fx.session.sessionId,
				runtimeId: snap0.value.runtimeId,
				requestId: "req-run-1",
				mode: "queue",
				payload: { text: "first run" },
			});
			expect(firstAck.ok).toBe(true);
			await streamEntered;

			const longPrefix = "A".repeat(260);
			const draftDoc = {
				version: 1 as const,
				parts: [
					{ type: "text" as const, text: `${longPrefix} ` },
					{ type: "skill" as const, id: fx.localSkillId, label: "review" },
					{ type: "text" as const, text: " on " },
					{ type: "file" as const, path: join(fx.dir, "README.md"), label: "README.md" },
				],
			};
			const sendDoc = {
				version: 1 as const,
				parts: [{ type: "text" as const, text: "> quoted line\n\n@a.ts\n\n" }, ...draftDoc.parts],
			};

			const snap1 = await fx.backend.getMessageControl(fx.session.sessionId);
			expect(snap1.ok).toBe(true);
			if (!snap1.ok) return;

			const queuedAck = await fx.backend.submitMessage({
				sessionId: fx.session.sessionId,
				runtimeId: snap1.value.runtimeId,
				requestId: "req-queue-2",
				mode: "queue",
				payload: {
					text: `> quoted line\n\n@a.ts\n\n${longPrefix} review on @README.md`,
					document: sendDoc,
					draft: {
						text: `${longPrefix} review on @README.md`,
						document: draftDoc,
						attachments: ["a.ts"],
						quotes: ["quoted line"],
						slashCommand: null,
					},
				},
			});
			expect(queuedAck.ok).toBe(true);
			if (!queuedAck.ok) return;

			await new Promise((resolveTick) => setTimeout(resolveTick, 10));
			const snapQueued = await fx.backend.getMessageControl(fx.session.sessionId);
			expect(snapQueued.ok).toBe(true);
			if (!snapQueued.ok) return;
			expect(snapQueued.value.items).toHaveLength(1);
			expect(snapQueued.value.items[0]?.preview).not.toContain("<referenced_skills>");
			expect(snapQueued.value.items[0]?.preview).not.toContain("<!--percho-input-");
			expect(snapQueued.value.items[0]?.preview).not.toContain("Use the review checklist.");

			// Recover the controlled queued item and verify quotes/attachments are NOT duplicated into draft.document
			const recovered = await fx.backend.recoverPendingMessage({
				sessionId: fx.session.sessionId,
				runtimeId: snapQueued.value.runtimeId,
				requestId: "req-recover-2",
				messageId: queuedAck.value.messageId,
				expectedRevision: snapQueued.value.revision,
			});
			expect(recovered).toEqual({ ok: true, value: expect.anything() });
			if (recovered.ok) {
				expect(recovered.value.payload.draft?.attachments).toEqual(["a.ts"]);
				expect(recovered.value.payload.draft?.quotes).toEqual(["quoted line"]);
				expect(recovered.value.payload.draft?.document).toEqual(draftDoc);
				expect(recovered.value.payload.draft?.text).toBe(`${longPrefix} review on @README.md`);
			}

			const snapAfterRecover = await fx.backend.getMessageControl(fx.session.sessionId);
			expect(snapAfterRecover.ok).toBe(true);
			if (!snapAfterRecover.ok) return;
			const discarded = await fx.backend.changePendingMessage({
				sessionId: fx.session.sessionId,
				runtimeId: snapAfterRecover.value.runtimeId,
				requestId: "req-discard-2",
				messageId: queuedAck.value.messageId,
				expectedRevision: snapAfterRecover.value.revision,
				action: "discard",
			});
			expect(discarded.ok).toBe(true);

			// Now queue via legacy prompt() while running (must not leak transport in snapshot preview or followUp)
			const legacyAck = await fx.backend.prompt(
				fx.session.sessionId,
				`${longPrefix} review`,
				undefined,
				draftDoc,
			);
			expect(legacyAck.disposition).toBe("queued");

			const snapLegacy = await fx.backend.getMessageControl(fx.session.sessionId);
			expect(snapLegacy.ok).toBe(true);
			if (!snapLegacy.ok) return;
			expect(snapLegacy.value.items).toHaveLength(1);
			expect(snapLegacy.value.items[0]?.preview).not.toContain("<referenced_skills>");
			expect(snapLegacy.value.items[0]?.preview).not.toContain("<!--percho-input-");
			expect(snapLegacy.value.items[0]?.preview).not.toContain("Use the review checklist.");

			const followUps = await fx.backend.getFollowUpMessages(fx.session.sessionId);
			for (const text of followUps) {
				expect(text).not.toContain("<referenced_skills>");
				expect(text).not.toContain("<!--percho-input-");
			}
		} finally {
			releaseStream?.();
			await fx.messageControl.waitForIdle();
		}
	});

	it("executes extension commands with clean args and expands prompt templates with inline references", async () => {
		const receivedArgs: string[] = [];
		const ext: ExtensionFactory = (pi) => {
			pi.registerCommand("echo-args", {
				description: "Echo args",
				handler: async (args) => {
					receivedArgs.push(args);
				},
			});
		};
		const tplPath = join(root, "tpl.md");
		const tpl: PromptTemplate = {
			name: "tpl",
			description: "Template",
			content: "Template body: $@",
			sourceInfo: {
				path: tplPath,
				source: "project",
				scope: "project",
				origin: "top-level",
				baseDir: root,
			},
			filePath: tplPath,
		};
		const fx = await createBackendFixture({ extensions: [ext], promptTemplates: [tpl] });
		const snap = await fx.backend.getMessageControl(fx.session.sessionId);
		expect(snap.ok).toBe(true);
		if (!snap.ok) return;

		const filePath = join(fx.dir, "README.md");
		const fileDoc = {
			version: 1 as const,
			parts: [{ type: "file" as const, path: filePath, label: "README.md" }],
		};

		const extAck = await fx.backend.submitMessage({
			sessionId: fx.session.sessionId,
			runtimeId: snap.value.runtimeId,
			requestId: "req-ext-1",
			mode: "queue",
			payload: {
				text: "/echo-args @README.md",
				document: fileDoc,
				draft: {
					text: "@README.md",
					document: fileDoc,
					attachments: [],
					quotes: [],
					slashCommand: "echo-args",
				},
			},
		});
		expect(extAck.ok).toBe(true);
		if (extAck.ok) expect(extAck.value.disposition).toBe("handled");
		expect(receivedArgs).toEqual([`@${filePath}`]);

		const tplAck = await fx.backend.submitMessage({
			sessionId: fx.session.sessionId,
			runtimeId: snap.value.runtimeId,
			requestId: "req-tpl-1",
			mode: "queue",
			payload: {
				text: "/tpl @README.md",
				document: fileDoc,
				draft: {
					text: "@README.md",
					document: fileDoc,
					attachments: [],
					quotes: [],
					slashCommand: "tpl",
				},
			},
		});
		expect(tplAck.ok).toBe(true);
		await fx.messageControl.waitForIdle();

		const lastUser = fx.requests.at(-1)?.find((m) => m.role === "user");
		expect(lastUser).toBeDefined();
		const userText =
			typeof lastUser?.content === "string"
				? lastUser.content
				: Array.isArray(lastUser?.content)
					? lastUser.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("")
					: "";
		expect(userText).toContain(`Template body: @${filePath}`);
		expect(userText).not.toContain("<!--percho-input-");
	});

	it("persists perchoInput cleanly to JSONL, reloads across restarts, projects hover preview, sanitizes LAN, and recalls cleanly", async () => {
		const fx = await createBackendFixture();
		const snap = await fx.backend.getMessageControl(fx.session.sessionId);
		expect(snap.ok).toBe(true);
		if (!snap.ok) return;

		const filePath = join(fx.dir, "src", "app.ts");
		const doc = {
			version: 1 as const,
			parts: [
				{ type: "text" as const, text: "Inspect " },
				{ type: "skill" as const, id: fx.localSkillId, label: "review" },
				{ type: "text" as const, text: " in " },
				{ type: "file" as const, path: filePath, label: "app.ts" },
			],
		};

		const ack = await fx.backend.submitMessage({
			sessionId: fx.session.sessionId,
			runtimeId: snap.value.runtimeId,
			requestId: "req-persist-1",
			mode: "queue",
			payload: {
				text: "Inspect review in @app.ts",
				document: doc,
				draft: {
					text: "Inspect review in @app.ts",
					document: doc,
					attachments: [],
					quotes: [],
					slashCommand: null,
				},
			},
		});
		expect(ack.ok).toBe(true);
		await fx.messageControl.waitForIdle();

		// 1. Model saw expanded skill + absolute file path, without transport marker
		const sentUser = fx.requests[0]?.find((m) => m.role === "user");
		const sentText = Array.isArray(sentUser?.content)
			? sentUser.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("")
			: "";
		expect(sentText).toContain(`Inspect review in @${filePath}`);
		expect(sentText).toContain("Use the review checklist.");
		expect(sentText).not.toContain("<!--percho-input-");

		// 2. Disk JSONL persisted perchoInput and stripped transport marker
		const sessionFile = fx.sessionManager.getSessionFile();
		expect(sessionFile).toBeTruthy();
		if (!sessionFile) return;
		const rawJsonl = await readFile(sessionFile, "utf8");
		expect(rawJsonl).not.toContain("<!--percho-input-");
		expect(rawJsonl).toContain('"perchoInput"');

		// 3. Cross-restart reload (no in-memory HMAC secret needed) restores document & clean text
		const reloaded = readSessionMessagesFromContent(rawJsonl);
		const userMsg = reloaded.find((m) => m.role === "user");
		expect(userMsg?.role).toBe("user");
		if (userMsg?.role === "user") {
			expect(userMsg.document).toEqual(doc);
			expect(userMsg.text).toBe("Inspect review in @app.ts");
		}

		// 4. Legacy message without perchoInput keeps plain @path as text (no file token fabrication)
		const legacyJsonl = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "legacy-1",
				timestamp: new Date().toISOString(),
				cwd: fx.dir,
			}),
			JSON.stringify({
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "user",
					content: [{ type: "text", text: "Check @C:/repo/a.ts" }],
					timestamp: Date.now(),
				},
			}),
		].join("\n");
		const legacyMsgs = readSessionMessagesFromContent(legacyJsonl);
		const legacyUser = legacyMsgs[0];
		expect(legacyUser?.role).toBe("user");
		if (legacyUser?.role === "user") {
			expect(legacyUser.document).toBeUndefined();
			expect(legacyUser.text).toBe("Check @C:/repo/a.ts");
		}

		// 5. Hover preview projects perchoInput safely (no unsafe_projection from <referenced_skills>, no raw path leak)
		const hover = await previewSessionFile(fx.session.sessionId, fx.dir, sessionFile);
		expect(hover.status).toBe("ok");
		if (hover.status === "ok") {
			expect(hover.text).toBe("Inspect review in @app.ts");
		}

		// 6. LAN sanitization strips perchoInput and projects clean text
		const sanitizedEvent = sanitizeSessionEvent({
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "text", text: sentText }],
				perchoInput: doc,
				timestamp: Date.now(),
			} as never,
		});
		expect(sanitizedEvent?.type).toBe("message_start");
		if (sanitizedEvent?.type === "message_start") {
			const msg = sanitizedEvent.message as unknown as {
				content: Array<{ type: string; text?: string }>;
				perchoInput?: unknown;
			};
			expect(msg.perchoInput).toBeUndefined();
			expect(msg.content[0]?.text).toBe("Inspect review in @app.ts");
		}
		if (userMsg?.role === "user") {
			const sanitizedHistory = sanitizeSessionMessage(userMsg);
			expect(sanitizedHistory.role).toBe("user");
			if (sanitizedHistory.role === "user") {
				expect(sanitizedHistory.document).toBeUndefined();
				expect(sanitizedHistory.text).toBe("Inspect review in @app.ts");
			}
		}

		// 7. Recall returns clean text and structured document
		const recalled = await fx.backend.recallMessage(fx.session.sessionId, {
			entryId: userMsg?.entryId,
		});
		expect(recalled.text).toBe("Inspect review in @app.ts");
		expect(recalled.document).toEqual(doc);
	});
});
