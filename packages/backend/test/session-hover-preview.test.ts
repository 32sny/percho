import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import type { RegisteredSession, SessionRegistry } from "../src/session/registry";

// ESM 内建模块的原始导出不可 spy；只为读取增长测试提供可替换的薄代理。
vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const ID = "hover-session";
const CWD = "/tmp/hover-project";
const MAX_HISTORY = 8 * 1024 * 1024;
const MAX_LINE = 128 * 1024;
const header = (id = ID, cwd = CWD) => ({
	type: "session",
	version: 3,
	id,
	cwd,
	timestamp: "2026-01-01T00:00:00Z",
});
const user = (id: string, parentId: string | null, content: unknown) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-01-01T00:00:00Z",
	message: { role: "user", content, timestamp: 1 },
});
const ok = (text: string) => ({
	status: "ok",
	sessionId: ID,
	source: "current-branch-first-user-text",
	text,
});
const unavailable = (reason: string) => ({ status: "unavailable", sessionId: ID, reason });
let dir: string;
let backend: PiBackend;
let find: ReturnType<typeof vi.spyOn>;

function history(entries: unknown[], sessionHeader = header()) {
	const file = join(dir, "history.jsonl");
	writeFileSync(file, [sessionHeader, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
	find.mockReturnValue(file);
	return file;
}

function loaded(
	entries: unknown[],
	leaf: string | null = (entries.at(-1) as { id?: string })?.id ?? null,
	sessionHeader = header(),
) {
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	const getBranch = vi.fn(() => {
		throw new Error("不得调用无循环保护的 getBranch");
	});
	const session = {
		sessionId: ID,
		messages: [{ role: "user", content: "压缩后的错误上下文" }],
		sessionManager: {
			getHeader: () => sessionHeader,
			getEntries: () => entries,
			getLeafId: () => leaf,
			getBranch,
		},
	} as unknown as AgentSession;
	const existing = registry.get(ID);
	if (existing) existing.session = session;
	else registry.add({ session, cwd: CWD } as RegisteredSession);
	return { registry, session, getBranch };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hover-preview-"));
	backend = new PiBackend({ projectTrust: false, permissionGates: false });
	find = vi.spyOn(SessionManager, "findById").mockReturnValue(undefined);
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

describe("PiBackend.getSessionHoverPreview 只读窄预览", () => {
	it("未注册会话忽略实时候选，liveRuns 独立超 8MiB 明确限额", async () => {
		const file = join(dir, "candidate_12345678.jsonl");
		writeFileSync(file, "{}");
		find.mockReturnValue(undefined);
		expect(
			await backend.getSessionHoverPreview(ID, CWD, [
				{ sessionFile: file, agent: "a", status: "running", source: "streaming" },
			]),
		).toEqual(unavailable("not_found"));
		loaded([user("u", null, "safe")], "u");
		expect(
			await backend.getSessionHoverPreview(ID, CWD, [
				{
					sessionFile: file,
					agent: "a",
					task: "x".repeat(MAX_HISTORY + 1),
					status: "running",
					source: "streaming",
				},
			]),
		).toEqual(unavailable("limit_exceeded"));
	});

	it("旧名称不改，文件内容和 mtime 不变，不 open/create/prompt/全量查找", async () => {
		const file = history([
			user("u", null, "旧名称之外的完整首条提问\n第二行"),
			{ type: "session_info", id: "name", parentId: "u", name: "旧截短名…" },
		]);
		const before = readFileSync(file);
		const mtime = statSync(file).mtimeMs;
		const spies = [
			vi.spyOn(SessionManager, "open"),
			vi.spyOn(SessionManager, "create"),
			vi.spyOn(backend, "openSession"),
			vi.spyOn(backend, "createSession"),
			vi.spyOn(backend, "prompt"),
			vi.spyOn(backend, "listAllSessions"),
			vi.spyOn(backend, "peekSessionMessages"),
		];
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(ok("旧名称之外的完整首条提问"));
		expect(find).toHaveBeenCalledWith(CWD, ID);
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		expect(readFileSync(file)).toEqual(before);
		expect(statSync(file).mtimeMs).toBe(mtime);
	});

	it("取当前分支而非最早物理消息，跳过图片/空白文本", async () => {
		history([
			user("old", null, "其他分支"),
			user("image", null, [{ type: "image", data: "AAAA" }]),
			user("blank", "image", " \n "),
			user("now", "blank", [{ type: "text", text: "当前分支\n后续" }]),
		]);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(ok("当前分支"));
	});

	it("Skill 只返回安全命令，不返回正文/路径/sourceText", async () => {
		history([
			user(
				"u",
				null,
				'<skill name="mindmap" location="/secret/SKILL.md">\nReferences are relative to /secret.\n\n机密正文\n</skill>\n\n画架构图\n后续',
			),
		]);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(ok("/skill:mindmap 画架构图"));
	});

	it.each([
		'<skill name="private" location="/secret">\n机密正文',
		'  <skill name="private" location="/secret">\n机密正文\n</skill>',
		"正文\n</skill>",
		"References are relative to /secret.\n\n疑似丢失头部的 Skill 正文",
	])("疑似残缺 Skill 失败关闭，不回退到后续用户消息", async (text) => {
		history([user("u", null, text), user("later", "u", "后续提问")]);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("unsafe_projection"));
	});

	it("没有有效用户文本返回 empty", async () => {
		history([user("u", null, [{ type: "image", data: "AAAA" }])]);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual({ status: "empty", sessionId: ID });
	});

	it("精确查找失败无全量兜底", async () => {
		const all = vi.spyOn(backend, "listAllSessions");
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("not_found"));
		expect(all).not.toHaveBeenCalled();
	});

	it.each([header("other"), header(ID, "/other")])("校验文件头 id 和 cwd", async (h) => {
		history([user("u", null, "不能泄漏")], h);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("identity_mismatch"));
	});

	it("定位后文件消失返回 read_failed", async () => {
		find.mockReturnValue(join(dir, "missing.jsonl"));
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("read_failed"));
	});

	it.each([
		{ entries: [user("a", "a", "循环")] },
		{ entries: [user("a", "b", "循环"), user("b", "a", "循环")] },
		{ entries: [user("a", "missing", "孤儿")] },
		{ entries: [user("a", null, "冲突一"), user("a", null, "冲突二")] },
		{ entries: [user("a", null, 42)] },
		{ entries: [user("a", null, "有效首行"), user("b", "a", 42)] },
		{ entries: [{ type: "unknown", id: "a", parentId: null }] },
	])("损坏/循环/重复冲突分支不返回猜测内容 %#", async ({ entries }) => {
		history(entries);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("invalid_history"));
	});

	it("不忽略损坏 JSON 行或额外 session 头", async () => {
		const file = history([user("u", null, "不能猜测")]);
		writeFileSync(file, readFileSync(file, "utf8") + "{损坏\n");
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("invalid_history"));
		history([header(), user("u", null, "不能猜测")]);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("invalid_history"));
	});

	it("磁盘 8MiB 超限和 UTF-8 首行 128KiB 超限都明确降级", async () => {
		history([user("u", null, "x".repeat(MAX_HISTORY))]);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("limit_exceeded"));
		history([user("u", null, "中".repeat(Math.floor(MAX_LINE / 3) + 1))]);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("limit_exceeded"));
		history([user("u", null, "x".repeat(MAX_LINE))]);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(ok("x".repeat(MAX_LINE)));
	});

	it("读取中持续增长也有硬上限，关闭只读句柄", async () => {
		find.mockReturnValue(join(dir, "growing.jsonl"));
		let bytes = 0;
		const close = vi.fn().mockResolvedValue(undefined);
		const read = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
			bytes += length;
			buffer.fill(32, offset, offset + length);
			return { bytesRead: length, buffer };
		});
		const open = vi.spyOn(fs, "open").mockResolvedValue({
			stat: async () => ({ size: 1 }),
			read,
			close,
		} as unknown as Awaited<ReturnType<typeof fs.open>>);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("limit_exceeded"));
		expect(open).toHaveBeenCalledWith(join(dir, "growing.jsonl"), "r");
		expect(bytes).toBeLessThanOrEqual(MAX_HISTORY + 1);
		expect(close).toHaveBeenCalledOnce();
	});

	it("已加载使用完整当前分支 leaf，忽略模型上下文与另一分支", async () => {
		const { registry, session, getBranch } = loaded(
			[user("a", null, "当前完整历史"), user("b", null, "其他分支")],
			"a",
		);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(ok("当前完整历史"));
		expect(find).not.toHaveBeenCalled();
		expect(getBranch).not.toHaveBeenCalled();
		expect(registry.get(ID)?.session).toBe(session);
	});

	it("SDK 内存会话的实际 branch/compaction/Skill 只读投影", async () => {
		const manager = SessionManager.inMemory(CWD);
		const skill =
			'<skill name="safe" location="/secret/SKILL.md">\nReferences are relative to /secret.\n\n机密\n</skill>\n\n参数';
		const root = manager.appendMessage({ role: "user", content: skill, timestamp: 1 });
		manager.appendCompaction("摘要不应替代历史", root, 100);
		manager.appendMessage({ role: "user", content: "其他分支", timestamp: 2 });
		manager.branch(root);
		const { session } = loaded([]);
		Object.defineProperty(session, "sessionManager", { value: manager });
		const actualId = manager.getHeader()?.id;
		if (!actualId) throw new Error("SDK 未生成会话头");
		const registry = (backend as unknown as { registry: SessionRegistry }).registry;
		// registry key 是测试 ID；只替换只读 header 的 ID，不改真实 SDK 分支。
		vi.spyOn(manager, "getHeader").mockReturnValue({ ...header(), id: ID });
		const before = manager.getEntries();
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(ok("/skill:safe 参数"));
		expect(manager.getEntries()).toEqual(before);
		expect(manager.getLeafId()).toBe(root);
		expect(registry.get(ID)?.session).toBe(session);
	});

	it("已加载空 leaf 不回退最后物理消息", async () => {
		loaded([user("a", null, "已撤回")], null);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual({ status: "empty", sessionId: ID });
	});

	it("内存校验身份且不绕过历史或首行预算", async () => {
		loaded([user("a", null, "内容")], "a", header(ID, "/other"));
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("identity_mismatch"));
		loaded([user("a", null, "x".repeat(MAX_HISTORY))]);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("limit_exceeded"));
		loaded([user("a", null, "x".repeat(MAX_LINE + 1))]);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("limit_exceeded"));
	});

	it("内存预算包含非当前分支和工具正文，坏对象循环失败关闭", async () => {
		loaded(
			[
				user("a", null, "可用首行"),
				{
					type: "message",
					id: "tool",
					parentId: null,
					message: { role: "toolResult", content: "x".repeat(MAX_HISTORY) },
				},
			],
			"a",
		);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("limit_exceeded"));
		const entry = user("cycle", null, "正文") as Record<string, unknown>;
		entry.self = entry;
		loaded([entry]);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("invalid_history"));
	});

	it("无效请求拒绝查找，已加载注册目录也必须匹配", async () => {
		expect(await backend.getSessionHoverPreview(ID, "")).toEqual(unavailable("identity_mismatch"));
		expect(find).not.toHaveBeenCalled();
		const { registry } = loaded([user("a", null, "正文")]);
		const entry = registry.get(ID);
		if (!entry) throw new Error("测试会话未注册");
		entry.cwd = "/other";
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("identity_mismatch"));
	});

	it("文件总字节恰好 8MiB 可读，超出一字节拒绝", async () => {
		const file = history([user("u", null, "边界首行")]);
		const base = readFileSync(file, "utf8");
		writeFileSync(file, base + " ".repeat(MAX_HISTORY - Buffer.byteLength(base)));
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(ok("边界首行"));
		writeFileSync(file, readFileSync(file, "utf8") + " ");
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("limit_exceeded"));
	});

	it("读取失败仍关闭句柄，非法 UTF-8 不替换后展示", async () => {
		const file = history([user("u", null, "正文")]);
		const bytes = readFileSync(file);
		writeFileSync(file, Buffer.concat([bytes, Buffer.from([0xff])]));
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("invalid_history"));
		const close = vi.fn().mockResolvedValue(undefined);
		vi.spyOn(fs, "open").mockResolvedValue({
			stat: async () => ({ size: 1 }),
			close,
			read: async () => {
				throw new Error("读取失败");
			},
		} as unknown as Awaited<ReturnType<typeof fs.open>>);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("read_failed"));
		expect(close).toHaveBeenCalledOnce();
	});

	it("内存循环/未知 leaf 不调用 getBranch 因而不挂死", async () => {
		loaded([user("a", "a", "循环")]);
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("invalid_history"));
		loaded([user("a", null, "正文")], "missing");
		expect(await backend.getSessionHoverPreview(ID, CWD)).toEqual(unavailable("invalid_history"));
	});
});
