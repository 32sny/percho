import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionMeta } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import type { RegisteredSession, SessionRegistry } from "../src/session/registry";
import { ordinarySessionsRoot, subagentSessionsRoot } from "../src/session/subagent-paths";

/**
 * renderer reload 后的「未落盘首发失败会话」入口（本文件是回归红测）。
 *
 * 事故形态：新建会话的首条消息在 preflight 就被拒（无模型/无凭证），SDK 不落盘
 * （`SessionManager._persist` 的 `_hasConversation` 门控：首条 user 消息之前不写文件）。
 * 会话实例仍在 backend registry 里活着，但 renderer 一 reload：
 * 1. `listAllSessions` 只枚举磁盘 → 目录里没有这条会话 → 左栏/胶囊失去入口；
 * 2. `openSession(file)` 先过文件校验（文件不存在）→ 抛错，接不回原实例。
 *
 * 契约（本文件固定）：
 * - `listAllSessions` = 磁盘目录 ∪ 当前 registry 真实 meta（live 优先，按 sessionId/规范化路径去重，
 *   含未落盘的 empty/held 会话；readOnly 标记原样保留）；
 * - `openSession` 在文件校验之前，仅按**规范化 sessionFile 与当前 registry 实例精确匹配**返回
 *   `registry.toMeta`（不按 UUID/文件名猜身份，不绕陌生路径校验）；
 * - `listSessions`（普通 inactive 历史语义）不变；
 * - close 后内存目录项消失；未落盘/已删/非 jsonl/同 id 异路径继续拒绝；只读子代理会话不升权。
 *
 * 真实性：真 PiBackend（真 wireSession/registry/traces/消息控制）+ 真 SDK AgentSession/SessionManager
 * + 真磁盘。只有模型运行时被替换成内存 fixture（无凭证、无网络），模型流用真实
 * `AssistantMessageEventStream` 协议替代。
 * HOME/USERPROFILE/APPDATA/LOCALAPPDATA/PI_CODING_AGENT_DIR 全部重定向到临时目录（不动 TMP）。
 */

const ISOLATED_ENV_KEYS = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PI_CODING_AGENT_DIR"] as const;

const TEST_MODEL = {
	id: "live-catalog-test",
	name: "live-catalog-test",
	provider: "test",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<"openai-completions">;

let root: string;
let agentDir: string;
let projectA: string;
let projectB: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "percho-live-catalog-"));
	agentDir = join(root, "agent");
	projectA = join(root, "project-a");
	projectB = join(root, "project-b");
	for (const dir of [join(root, "home"), agentDir, projectA, projectB]) {
		mkdirSync(dir, { recursive: true });
	}
	savedEnv = Object.fromEntries(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
	process.env.HOME = join(root, "home");
	process.env.USERPROFILE = join(root, "home");
	process.env.APPDATA = join(root, "home", "AppData", "Roaming");
	process.env.LOCALAPPDATA = join(root, "home", "AppData", "Local");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(process.env.APPDATA, { recursive: true });
	mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

/**
 * 模型运行时 fixture：只提供会话运行需要的纯函数面，不触网、不读真实凭证。
 * 默认「有模型可选、没有可用凭证」——这正是事故里的首发失败形态：
 * preflight 在 auth 校验处拒绝（SDK 不会追加 user 消息，会话因此不落盘）。
 */
interface RuntimeFixture {
	runtime: ModelRuntime;
	setAuthed(value: boolean): void;
}

function modelRuntimeFixture(): RuntimeFixture {
	let authed = false;
	const runtime = {
		getModel: (provider: string, modelId: string) =>
			provider === TEST_MODEL.provider && modelId === TEST_MODEL.id ? TEST_MODEL : undefined,
		hasConfiguredAuth: () => authed,
		checkAuth: async () => (authed ? { type: "api_key", key: "test-key" } : undefined),
		getAuth: async () => undefined,
		isUsingOAuth: () => false,
		getAvailableSnapshot: () => [TEST_MODEL],
	} as unknown as ModelRuntime;
	return { runtime, setAuthed: (value) => (authed = value) };
}

function newBackend(): { backend: PiBackend; runtime: RuntimeFixture } {
	const backend = new PiBackend({
		defaultCwd: projectA,
		projectTrust: false,
		permissionGates: false,
		subagentPreferBuiltin: false,
		webFetch: false,
	});
	const runtime = modelRuntimeFixture();
	vi.spyOn(
		backend as unknown as { getModelRuntime: () => Promise<ModelRuntime> },
		"getModelRuntime",
	).mockResolvedValue(runtime.runtime);
	return { backend, runtime };
}

/** SessionMeta.sessionFile 是可选的（inMemory manager 为空）；本文件所有会话都有计划路径。 */
function fileOf(meta: SessionMeta): string {
	if (!meta.sessionFile) throw new Error(`会话 meta 缺少 sessionFile：${meta.sessionId}`);
	return meta.sessionFile;
}

function registryOf(backend: PiBackend): SessionRegistry {
	return (backend as unknown as { registry: SessionRegistry }).registry;
}

function entryOf(backend: PiBackend, sessionId: string): RegisteredSession {
	const entry = registryOf(backend).get(sessionId);
	if (!entry) throw new Error(`registry 里没有会话：${sessionId}`);
	return entry;
}

/** 真实 `AssistantMessageEventStream` 协议：start → done → end。 */
function response(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

function textTurn(text: string): AssistantMessage {
	return {
		role: "assistant",
		api: TEST_MODEL.api,
		provider: TEST_MODEL.provider,
		model: TEST_MODEL.id,
		timestamp: Date.now(),
		stopReason: "stop",
		content: [{ type: "text", text }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/** 真实 SDK 会话上的内存模型流（不联网）。 */
function installInMemoryStream(backend: PiBackend, sessionId: string, reply: string): void {
	const session = entryOf(backend, sessionId).session as AgentSession & {
		agent: { streamFunction?: unknown };
	};
	session.agent.streamFunction = () => response(textTurn(reply));
}

/** 恢复出首轮：补上凭证（fixture）+ 真实 setModel + 内存模型流。 */
async function recoverFirstTurn(
	backend: PiBackend,
	runtime: RuntimeFixture,
	sessionId: string,
	reply: string,
): Promise<void> {
	runtime.setAuthed(true);
	await backend.setModel(sessionId, TEST_MODEL.provider, TEST_MODEL.id);
	installInMemoryStream(backend, sessionId, reply);
}

/** 真实落盘一轮：补凭证 + 真实 setModel + 内存流，等文件出现且首轮结束。 */
async function createPersistedSession(
	backend: PiBackend,
	runtime: RuntimeFixture,
	cwd: string,
	reply = "落盘回复",
): Promise<SessionMeta> {
	const created = await backend.createSession({ cwd });
	await recoverFirstTurn(backend, runtime, created.sessionId, reply);
	await backend.prompt(created.sessionId, "会落盘的一轮");
	await waitFor(() => existsSync(fileOf(created)), "会话文件落盘");
	await waitFor(() => !entryOf(backend, created.sessionId).session.isStreaming, "首轮结束");
	return created;
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
	const started = Date.now();
	while (!condition()) {
		if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** 子代理产物会话文件（真实 jsonl 结构；只用于只读检视边界）。 */
function writeSubagentSessionFile(sessionId: string, cwd: string): string {
	const dir = join(subagentSessionsRoot(), "encoded-cwd");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${sessionId}.jsonl`);
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: "2020-01-01T00:00:00.000Z",
			cwd,
		}),
		JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2021-03-04T05:06:07.000Z",
			message: { role: "user", content: "子代理输出", timestamp: Date.parse("2021-03-04T05:06:07.000Z") },
		}),
	];
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

describe("未落盘 held 会话的目录与重开入口", () => {
	it("listAll 含真实 meta；open 精确 file 接回同实例（runtime/control 不变）；listSessions 语义不变", async () => {
		const { backend } = newBackend();
		try {
			const created = await backend.createSession({ cwd: projectA });
			// 前提：首条消息之前 SDK 不落盘（本用例的事故形态）
			expect(existsSync(fileOf(created))).toBe(false);

			// 首发失败（真实 SDK 的 preflight 拒绝：没有可用凭证；user 消息不会追加，因此不落盘）
			await expect(backend.prompt(created.sessionId, "首发失败")).rejects.toThrow(/API key/i);

			// 目录：内存里的 held 会话必须可见，且与磁盘目录不重复
			const catalog = await backend.listAllSessions();
			const listed = catalog.filter((meta) => meta.sessionId === created.sessionId);
			expect(listed).toHaveLength(1);
			expect(listed[0]).toMatchObject({
				sessionId: created.sessionId,
				sessionFile: fileOf(created),
				cwd: projectA,
				active: true,
				messageCount: 0,
			});

			// 普通 inactive 历史枚举语义不变：held 会话不是「历史会话」
			const history = await backend.listSessions(projectA);
			expect(history.some((meta) => meta.sessionId === created.sessionId)).toBe(false);

			const entry = entryOf(backend, created.sessionId);
			const controlBefore = await backend.getMessageControl(created.sessionId);
			expect(controlBefore.ok).toBe(true);

			// 精确路径重开：同一实例、同一 runtime，不构造第二个会话
			const reopened = await backend.openSession(fileOf(created));
			expect(registryOf(backend).get(created.sessionId)).toBe(entry);
			expect(registryOf(backend).list()).toHaveLength(1);
			expect(reopened).toEqual(registryOf(backend).toMeta(entry));
			expect(await backend.getMessageControl(created.sessionId)).toEqual(controlBefore);

			// 词法别名（冗余 ./ 段）同样按规范化路径命中，不会开第二条
			const fileDir = dirname(fileOf(created));
			const alias = `${fileDir}${sep}.${sep}${fileOf(created).slice(fileDir.length + 1)}`;
			expect(alias).not.toBe(fileOf(created));
			expect(await backend.openSession(alias)).toEqual(registryOf(backend).toMeta(entry));
			expect(registryOf(backend).list()).toHaveLength(1);
			// Windows 盘符大小写别名：规范化键不分大小写，不得开第二条
			const caseAlias = fileOf(created).replace(/^[a-z]:/i, (drive) => drive.toUpperCase());
			if (caseAlias !== fileOf(created)) {
				expect(await backend.openSession(caseAlias)).toEqual(registryOf(backend).toMeta(entry));
				expect(registryOf(backend).list()).toHaveLength(1);
			}
			expect((await backend.listAllSessions()).filter((m) => m.sessionId === created.sessionId)).toHaveLength(
				1,
			);
		} finally {
			backend.dispose();
		}
	});

	it("recover 后同 runtime 重新 open 取回原文；磁盘+registry 不重复", async () => {
		const { backend, runtime } = newBackend();
		try {
			const created = await backend.createSession({ cwd: projectA });
			await expect(backend.prompt(created.sessionId, "首发失败")).rejects.toThrow(/API key/i);
			expect(existsSync(fileOf(created))).toBe(false);

			// 失败的输入被消息控制保留为 held（renderer reload 后也从快照看得到它）
			const control = await backend.getMessageControl(created.sessionId);
			if (!control.ok) throw new Error("消息控制不可用");
			const held = control.value.items.find((item) => item.source === "user" && item.state === "held");
			if (!held) throw new Error("失败的首发消息没有被保留为 held");

			// recover：补凭证 + 内存流，按真实 pending 恢复入口取回那条 held 消息，再带 recovery 重投
			runtime.setAuthed(true);
			installInMemoryStream(backend, created.sessionId, "恢复后的回复");
			const recovered = await backend.recoverPendingMessage({
				sessionId: created.sessionId,
				runtimeId: control.value.runtimeId,
				requestId: `recover-${created.sessionId}`,
				messageId: held.messageId,
				expectedRevision: control.value.revision,
			});
			if (!recovered.ok) throw new Error(`recover 失败：${recovered.error.message}`);
			expect(recovered.value.payload.text).toBe("首发失败");
			const resubmitted = await backend.submitMessage({
				sessionId: created.sessionId,
				runtimeId: control.value.runtimeId,
				requestId: `recover-submit-${created.sessionId}`,
				mode: "queue",
				payload: { text: recovered.value.payload.text },
				recovery: {
					messageId: recovered.value.messageId,
					expectedRevision: recovered.value.snapshot.revision,
				},
			});
			if (!resubmitted.ok) throw new Error(`重投失败：${resubmitted.error.message}`);

			await waitFor(() => existsSync(fileOf(created)), "会话文件落盘");
			await waitFor(() => !entryOf(backend, created.sessionId).session.isStreaming, "首轮结束");

			// 同 runtime 重新 open：仍是同一实例，取回原文（held 的 user 文本 + assistant 回复）
			const entry = entryOf(backend, created.sessionId);
			const reopened = await backend.openSession(fileOf(created));
			expect(registryOf(backend).get(created.sessionId)).toBe(entry);
			expect(reopened.sessionId).toBe(created.sessionId);
			const texts = (await backend.getSessionMessages(created.sessionId))
				.filter((message) => message.role === "user" || message.role === "assistant")
				.map((message) => (message.role === "user" || message.role === "assistant" ? message.text : ""));
			expect(texts).toEqual(["首发失败", "恢复后的回复"]);

			// 磁盘与 registry 只出现一条（live 优先，不重复）
			const catalog = await backend.listAllSessions();
			expect(catalog.filter((meta) => meta.sessionId === created.sessionId)).toHaveLength(1);
		} finally {
			backend.dispose();
		}
	});

	it("close 后不再有内存目录项；未知/已删/外部路径继续拒绝", async () => {
		const { backend, runtime } = newBackend();
		try {
			const held = await backend.createSession({ cwd: projectA });
			await expect(backend.prompt(held.sessionId, "首发失败")).rejects.toThrow(/API key/i);
			expect((await backend.listAllSessions()).some((m) => m.sessionId === held.sessionId)).toBe(true);

			// held 的失败输入占着用户槽位：先丢弃（真实 UI 的「丢弃」动作），再关会话
			const control = await backend.getMessageControl(held.sessionId);
			if (!control.ok) throw new Error("消息控制不可用");
			const heldItem = control.value.items.find((item) => item.source === "user" && item.state === "held");
			if (!heldItem) throw new Error("失败的首发消息没有被保留为 held");
			const discarded = await backend.changePendingMessage({
				sessionId: held.sessionId,
				runtimeId: control.value.runtimeId,
				requestId: `discard-${held.sessionId}`,
				messageId: heldItem.messageId,
				expectedRevision: control.value.revision,
				action: "discard",
			});
			if (!discarded.ok) throw new Error(`丢弃失败：${discarded.error.message}`);

			await expect(backend.closeSession(held.sessionId)).resolves.toEqual({ closed: true });
			expect((await backend.listAllSessions()).some((m) => m.sessionId === held.sessionId)).toBe(false);
			// 已关（未落盘）：文件不存在 → 照旧拒绝，不会凭 sessionId 复活
			await expect(backend.openSession(fileOf(held))).rejects.toThrow(/Invalid stored session path/);

			// 未知路径（校验根下不存在）：拒绝
			const live = await backend.createSession({ cwd: projectA });
			const missingAlias = join(dirname(fileOf(live)), `${live.sessionId}.jsonl`);
			if (missingAlias !== fileOf(live)) {
				// 文件名/header 就是活会话 id，但路径不是那个实例的文件：不得按 UUID/文件名命中
				expect(existsSync(missingAlias)).toBe(false);
				await expect(backend.openSession(missingAlias)).rejects.toThrow(/Invalid stored session path/);
			}
			// 非 jsonl（校验根下）：拒绝
			const notJsonl = join(ordinarySessionsRoot(), "notes.txt");
			mkdirSync(dirname(notJsonl), { recursive: true });
			writeFileSync(notJsonl, "x");
			await expect(backend.openSession(notJsonl)).rejects.toThrow(/Invalid stored session path/);

			// 已删：落盘后关闭并删文件 → 拒绝
			const persisted = await backend.createSession({ cwd: projectA });
			await recoverFirstTurn(backend, runtime, persisted.sessionId, "落盘");
			await backend.prompt(persisted.sessionId, "会落盘的一轮");
			await waitFor(() => existsSync(fileOf(persisted)), "会话文件落盘");
			await waitFor(() => !entryOf(backend, persisted.sessionId).session.isStreaming, "首轮结束");
			await backend.closeSession(persisted.sessionId);
			await backend.deleteSession(persisted.sessionId, fileOf(persisted));
			expect(existsSync(fileOf(persisted))).toBe(false);
			await expect(backend.openSession(fileOf(persisted))).rejects.toThrow(/Invalid stored session path/);
		} finally {
			backend.dispose();
		}
	});

	it("subagent 只读会话：listAll/open 都保持 readOnly，不升权", async () => {
		const { backend } = newBackend();
		try {
			const file = writeSubagentSessionFile("sub-1", projectA);
			const opened = await backend.openSession(file);
			expect(opened).toMatchObject({ sessionId: "sub-1", readOnly: true, active: true });

			const catalog = await backend.listAllSessions();
			const listed = catalog.filter((meta) => meta.sessionId === "sub-1");
			expect(listed).toHaveLength(1);
			expect(listed[0]?.readOnly).toBe(true);
			expect(backend.checkSessionWritable("sub-1")).toBe("read_only");
			await expect(backend.prompt("sub-1", "想写")).rejects.toThrow(/read-only/);

			// 精确路径重开仍是只读，不被「live 优先」洗成可写
			expect(await backend.openSession(file)).toMatchObject({ sessionId: "sub-1", readOnly: true });
		} finally {
			backend.dispose();
		}
	});

	it("多目录 held 会话不混淆：各自 meta 与重开命中各自实例", async () => {
		const { backend } = newBackend();
		try {
			const heldA = await backend.createSession({ cwd: projectA });
			const heldB = await backend.createSession({ cwd: projectB });
			await expect(backend.prompt(heldA.sessionId, "A 首发失败")).rejects.toThrow(/API key/i);
			await expect(backend.prompt(heldB.sessionId, "B 首发失败")).rejects.toThrow(/API key/i);

			const catalog = await backend.listAllSessions();
			const metaA = catalog.find((meta) => meta.sessionId === heldA.sessionId);
			const metaB = catalog.find((meta) => meta.sessionId === heldB.sessionId);
			expect(metaA).toMatchObject({ cwd: projectA, sessionFile: fileOf(heldA), active: true });
			expect(metaB).toMatchObject({ cwd: projectB, sessionFile: fileOf(heldB), active: true });

			expect((await backend.openSession(fileOf(heldA))).sessionId).toBe(heldA.sessionId);
			expect((await backend.openSession(fileOf(heldB))).sessionId).toBe(heldB.sessionId);
			expect(registryOf(backend).list()).toHaveLength(2);
		} finally {
			backend.dispose();
		}
	});
});

describe("live 路径可信性（注册匹配不等于磁盘路径可信）", () => {
	it("已落盘的 live 路径被根外 symlink 替换：仍走 realpath 校验并拒绝接回", async (ctx) => {
		const { backend, runtime } = newBackend();
		try {
			const persisted = await createPersistedSession(backend, runtime, projectA);
			const file = fileOf(persisted);
			const outsideDir = join(root, "outside");
			mkdirSync(outsideDir, { recursive: true });
			const outsideFile = join(outsideDir, "victim.jsonl");
			writeFileSync(outsideFile, readFileSync(file));
			const before = readFileSync(outsideFile);

			rmSync(file);
			try {
				symlinkSync(outsideFile, file);
			} catch {
				// Windows 无 symlink 权限：本用例无法真实复现，明确跳过
				ctx.skip();
				return;
			}

			// 文件存在（经 symlink），词法路径仍是受控根：必须按真实路径拒绝，不得返回 registry meta
			await expect(backend.openSession(file)).rejects.toThrow(/Invalid stored session path/);
			expect(registryOf(backend).list()).toHaveLength(1);
			// 没有把真实 SDK 的追加写到根外目标
			expect(readFileSync(outsideFile).equals(before)).toBe(true);
		} finally {
			backend.dispose();
		}
	});

	it("未落盘计划路径的父目录被根外 symlink 替换：父目录 realpath 逃逸则拒绝接回", async (ctx) => {
		const { backend } = newBackend();
		try {
			const held = await backend.createSession({ cwd: projectA });
			await expect(backend.prompt(held.sessionId, "首发失败")).rejects.toThrow(/API key/i);
			const file = fileOf(held);
			const parent = dirname(file);
			expect(existsSync(file)).toBe(false);

			const outsideDir = join(root, "outside-sessions");
			mkdirSync(outsideDir, { recursive: true });
			const parked = `${parent}-parked`;
			renameSync(parent, parked);
			try {
				symlinkSync(outsideDir, parent, process.platform === "win32" ? "junction" : "dir");
			} catch {
				renameSync(parked, parent);
				ctx.skip();
				return;
			}
			try {
				await expect(backend.openSession(file)).rejects.toThrow(/Invalid stored session path/);
				expect(registryOf(backend).list()).toHaveLength(1);
			} finally {
				rmSync(parent, { force: true });
				renameSync(parked, parent);
			}
		} finally {
			backend.dispose();
		}
	});

	it("已落盘后被删的 live 会话不得当首次未落盘接回", async () => {
		const { backend, runtime } = newBackend();
		try {
			const persisted = await createPersistedSession(backend, runtime, projectA);
			const file = fileOf(persisted);
			rmSync(file);
			expect(existsSync(file)).toBe(false);
			await expect(backend.openSession(file)).rejects.toThrow(/Invalid stored session path/);
			expect(registryOf(backend).list()).toHaveLength(1);
		} finally {
			backend.dispose();
		}
	});
});

describe("目录合并原位语义（live 替换不挪位）", () => {
	it("磁盘 [new, old] 且 new 仍 live：new 原位替换为 live meta，不重复", async () => {
		const { backend, runtime } = newBackend();
		try {
			const old = await createPersistedSession(backend, runtime, projectA, "旧会话回复");
			await backend.closeSession(old.sessionId);
			// 明确拉开 modified 时间，保证磁盘枚举顺序稳定为 [new, old]
			await new Promise((done) => setTimeout(done, 20));
			const fresh = await createPersistedSession(backend, runtime, projectA, "新会话回复");

			const catalog = await backend.listAllSessions();
			expect(catalog.map((meta) => meta.sessionId)).toEqual([fresh.sessionId, old.sessionId]);
			expect(catalog[0]).toMatchObject({
				sessionId: fresh.sessionId,
				active: true,
				sessionFile: fileOf(fresh),
			});
			expect(catalog[1]).toMatchObject({ sessionId: old.sessionId, active: false });
			expect(catalog.filter((meta) => meta.sessionId === fresh.sessionId)).toHaveLength(1);
		} finally {
			backend.dispose();
		}
	});
});
