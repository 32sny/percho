import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionHoverLiveRun } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ dir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => env.dir,
}));

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiBackend } from "../src/pi-backend";
import { previewLoadedSession, previewSessionFile } from "../src/session/title-preview";

const ID = "parent";
const header = () => ({
	type: "session",
	version: 3,
	id: ID,
	cwd: env.dir,
	timestamp: "2026-01-01T00:00:00Z",
});
const user = (content = "Question") => ({
	type: "message",
	id: "user",
	parentId: null,
	message: { role: "user", content },
});
function tool(id: string, parentId: string, results: unknown[], timestamp: unknown = 1) {
	return { type: "message", id, parentId, timestamp, message: { role: "toolResult", details: { results } } };
}
const run = (file: string, agent = "scout", extra = {}) => ({
	agent,
	task: "inspect\nnot in preview",
	exitCode: 0,
	artifactPaths: { jsonlPath: file },
	...extra,
});
const live = (file: string, source: SessionHoverLiveRun["source"] = "streaming"): SessionHoverLiveRun => ({
	sessionFile: file,
	agent: "scout",
	status: "running",
	source,
});
async function child(name: string) {
	const file = join(env.dir, "sessions-subagents", `${name}_12345678.jsonl`);
	await writeFile(file, "{}");
	return file;
}
function memory(entries: unknown[], liveRuns: SessionHoverLiveRun[] = [], leaf?: string | null) {
	return previewLoadedSession(
		ID,
		env.dir,
		env.dir,
		{
			getHeader: header,
			getSessionFile: () => join(env.dir, "sessions", "--project--", "parent.jsonl"),
			getEntries: () => entries,
			getLeafId: () => (leaf === undefined ? ((entries.at(-1) as { id: string })?.id ?? null) : leaf),
		} as Parameters<typeof previewLoadedSession>[3],
		liveRuns,
	);
}

beforeEach(async () => {
	env.dir = await mkdtemp(join(tmpdir(), "hover-relations-"));
	await mkdir(join(env.dir, "sessions-subagents"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(env.dir, { force: true, recursive: true });
});

describe("悬停关系的当前分支、安全投影与统一计数", () => {
	it("最新派工顺序不依赖相同或倒退时间戳；重复引用移动到最新位置", async () => {
		const a = await child("a"),
			b = await child("b");
		const result = await memory([
			user(),
			tool("a", "user", [run(a)], 100),
			tool("b", "a", [run(b)], 1),
			tool("again", "b", [run(a, "latest")], 0),
		]);
		expect(result.relations?.children.map((c) => c.agent)).toEqual(["latest", "scout"]);
		const sameTimes = await memory([user(), tool("a", "user", [run(a)], 1), tool("b", "a", [run(b)], 1)]);
		expect(sameTimes.relations?.children.map((c) => c.sessionFile)).toEqual([b, a]);
	});

	it("隐藏集合与实时项重叠不加计数，真正新增才加一，streaming最新在前", async () => {
		const files = await Promise.all(Array.from({ length: 10 }, (_, i) => child(String(i))));
		const entries = [
			user(),
			...files.slice(0, 9).map((file, i) => tool(`t${i}`, i ? `t${i - 1}` : "user", [run(file)], i)),
		];
		const overlap = await memory(entries, [live(files[0]!)]);
		expect(overlap.relations?.children).toHaveLength(6);
		expect(overlap.relations?.hidden).toBe(3);
		expect(overlap.relations?.children[0]?.sessionFile).toBe(files[0]);
		const added = await memory(entries, [live(files[0]!), live(files[9]!)]);
		expect(added.relations?.hidden).toBe(4);
		expect(added.relations?.children.slice(0, 2).map((c) => c.sessionFile)).toEqual([files[9], files[0]]);
	});

	it("committed不能添加非当前分支关系，失效streaming路径也不能复活", async () => {
		const file = await child("removed");
		const entries = [user(), tool("old", "user", [run(file)])];
		expect((await memory(entries, [live(file, "committed")], "user")).relations).toBeUndefined();
		await rm(file);
		expect((await memory(entries, [live(file)])).relations).toBeUndefined();
	});

	it("畸形details不影响其他条目或首条提问", async () => {
		const file = await child("good");
		const result = await memory([user(), tool("bad", "user", [null]), tool("good", "bad", [run(file)])]);
		expect(result).toMatchObject({
			status: "ok",
			text: "Question",
			relations: { children: [{ agent: "scout" }], hidden: 0 },
		});
	});

	it("名称路径回退和嵌入导航路径的任务不能进入可展示字段", async () => {
		const file = await child("secret");
		const result = await memory([user(), tool("t", "user", [{ sessionFile: file, task: `检查：${file}` }])]);
		expect(result.relations?.children[0]).toMatchObject({ agent: "subagent", status: "unknown" });
		expect(result.relations?.children[0]?.taskFirstLine).toBeUndefined();
		const running = await memory(
			[user()],
			[{ ...live(file), task: `检查：${file}`, agent: `file://${file}` }],
		);
		expect(running.relations?.children[0]?.agent).toBe("subagent");
		expect(running.relations?.children[0]?.taskFirstLine).toBeUndefined();
	});

	it("任务首行UTF8边界明确，正常代码路径不被一刀切隐藏", async () => {
		const file = await child("task");
		for (const [task, expected] of [
			["中".repeat(43691), undefined],
			["x".repeat(131072), "x".repeat(131072)],
			["检查 /src/index.ts", "检查 /src/index.ts"],
		] as const) {
			const result = await memory([user(), tool("t", "user", [run(file, "scout", { task })])]);
			expect(result.relations?.children[0]?.taskFirstLine).toBe(expected);
		}
	});

	it("Skill首提问不可投影时仍有关系，任务Skill只保留安全命令", async () => {
		const file = await child("skill");
		const task =
			'<skill name="inspect" location="/secret/SKILL.md">\nReferences are relative to /secret.\n\n秘密正文\n</skill>\n\n参数';
		const result = await memory([user("<skill broken"), tool("t", "user", [run(file, "scout", { task })])]);
		expect(result).toMatchObject({
			status: "unavailable",
			reason: "unsafe_projection",
			relations: { children: [{ taskFirstLine: "/skill:inspect 参数" }] },
		});
	});

	it("缺退出码为unknown，实时不以无证据done覆盖既有结局", async () => {
		const file = await child("state");
		const unknown = await memory([user(), tool("t", "user", [run(file, "scout", { exitCode: undefined })])]);
		expect(unknown.relations?.children[0]?.status).toBe("unknown");
		const error = await memory(
			[user(), tool("t", "user", [run(file, "scout", { exitCode: 1 })])],
			[{ ...live(file, "committed"), status: "done" }],
		);
		expect(error.relations?.children[0]?.status).toBe("error");
	});

	it("completions和Agent形态可识别；普通外部文件与目录不展示", async () => {
		const file = await child("formats");
		const entry = {
			...tool("t", "user", []),
			message: {
				role: "toolResult",
				details: {
					completions: [
						{ results: [{ agent: "worker", success: false, artifactPaths: { outputPath: file } }] },
					],
				},
			},
		};
		expect((await memory([user(), entry])).relations?.children[0]).toMatchObject({
			agent: "worker",
			status: "error",
		});
		const flat = {
			...entry,
			message: { role: "toolResult", details: { subagentType: "agent", status: "error", sessionFile: file } },
		};
		expect((await memory([user(), flat])).relations?.children[0]?.agent).toBe("agent");
		const outside = join(env.dir, "outside.jsonl");
		await writeFile(outside, "{}");
		expect(
			(await memory([user()], [live(outside), live(join(env.dir, "sessions-subagents"))])).relations,
		).toBeUndefined();
	});

	it("真实内存读取与真实文件读取结果一致，不混淆两次文件读取", async () => {
		const file = await child("same");
		const entries = [user(), tool("t", "user", [run(file)])];
		const parentFile = join(env.dir, "parent.jsonl");
		await writeFile(parentFile, [header(), ...entries].map((e) => JSON.stringify(e)).join("\n"));
		expect(await previewSessionFile(ID, env.dir, parentFile)).toEqual(await memory(entries));
	});

	it("错误/超预算实时候选不返回部分关系，父历史超限不返回关系", async () => {
		const file = await child("budget");
		for (const candidates of [null, [null], [{ ...live(file), task: "x".repeat(8 * 1024 * 1024) }]]) {
			expect(await memory([user()], candidates as SessionHoverLiveRun[])).toEqual({
				status: "unavailable",
				sessionId: ID,
				reason: "limit_exceeded",
			});
		}
		expect(await memory([user("x".repeat(8 * 1024 * 1024))], [live(file)])).toEqual({
			status: "unavailable",
			sessionId: ID,
			reason: "limit_exceeded",
		});
	});

	it("插件与内置合并后统一排序计数，磁盘和内存均能还原不同ID的真实插件协议", async () => {
		const directory = join(env.dir, "sessions", "--project--");
		await mkdir(directory, { recursive: true });
		const parentFile = join(directory, "parent.jsonl");
		const agentId = "38e86c9b-9625-4c4";
		const childId = "01a185ae-90f3-7273-8ab0-c49d3e766e14";
		const childFile = join(directory, `2026-01-01T00-00-01-000Z_${childId}.jsonl`);
		const start = Date.parse("2026-01-01T00:00:00Z");
		await writeFile(
			childFile,
			[
				{
					...header(),
					id: childId,
					timestamp: new Date(start + 1000).toISOString(),
					parentSession: parentFile,
				},
				{ type: "session_info", id: "n", parentId: null, name: "Explore#38e86c9b" },
				{ type: "message", id: "u", parentId: "n", message: { role: "user", content: "原始插件任务" } },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n") + "\n",
		);
		const files = await Promise.all(Array.from({ length: 7 }, (_, i) => child(`builtin-${i}`)));
		const entries = [
			user(),
			...files.map((f, i) => tool(`b${i}`, i ? `b${i - 1}` : "user", [run(f)])),
			{
				type: "message",
				id: "call",
				parentId: "b6",
				message: {
					role: "assistant",
					timestamp: start,
					content: [
						{ type: "toolCall", id: "agent-call", name: "Agent", arguments: { subagent_type: "Explore" } },
					],
				},
			},
			{
				type: "message",
				id: "receipt",
				parentId: "call",
				message: {
					role: "toolResult",
					toolName: "Agent",
					toolCallId: "agent-call",
					timestamp: start + 2000,
					details: { agentId, subagentType: "Explore", description: "插件任务摘要", status: "completed" },
				},
			},
		];
		await writeFile(
			parentFile,
			[header(), ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
		);
		const disk = await previewSessionFile(ID, env.dir, parentFile);
		expect(disk).toEqual(await memory(entries));
		expect(disk.relations?.children).toHaveLength(6);
		expect(disk.relations?.hidden).toBe(2);
		expect(disk.relations?.children[0]).toMatchObject({
			sessionId: childId,
			sessionFile: childFile,
			agent: "Explore",
			status: "done",
			taskFirstLine: "插件任务摘要",
		});
		expect(disk.relations?.children[1]?.sessionFile).toBe(files[6]);
		const recalled = await memory(entries, [], "b6");
		expect(recalled.relations?.hidden).toBe(1);
		expect(recalled.relations?.children.some((c) => c.sessionFile === childFile)).toBe(false);
		await rm(childFile);
		expect((await memory(entries)).relations?.children.some((c) => c.sessionFile === childFile)).toBe(false);
	});

	it("普通sessions路径的外部链接在SDK打开前被拒绝，不放宽内置白名单", async () => {
		const { symlink } = await import("node:fs/promises");
		const directory = join(env.dir, "sessions", "--project--");
		await mkdir(directory, { recursive: true });
		const outside = join(env.dir, "outside.jsonl");
		await writeFile(outside, [header(), user()].map((entry) => JSON.stringify(entry)).join("\n"));
		const link = join(directory, "linked.jsonl");
		await symlink(outside, link);
		const backend = new PiBackend({ projectTrust: false, permissionGates: false });
		const open = vi.spyOn(SessionManager, "open");
		await expect(backend.openSession(link)).rejects.toThrow("Invalid stored session path");
		expect(open).not.toHaveBeenCalled();
		expect((await memory([user(), tool("fake", "user", [run(link)])])).relations).toBeUndefined();
	});

	it("未注册父忽略候选，子路径在SDK打开前二次检查", async () => {
		const file = await child("live");
		const parentFile = join(env.dir, "parent.jsonl");
		await writeFile(parentFile, [header(), user()].map((e) => JSON.stringify(e)).join("\n"));
		vi.spyOn(SessionManager, "findById").mockReturnValue(parentFile);
		const backend = new PiBackend({ projectTrust: false, permissionGates: false });
		expect((await backend.getSessionHoverPreview(ID, env.dir, [live(file)])).relations).toBeUndefined();
		await rm(file);
		const open = vi.spyOn(SessionManager, "open");
		await expect(backend.openSession(file)).rejects.toThrow();
		expect(open).not.toHaveBeenCalled();
	});
});
