import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewSessionFile } from "../src/session/title-preview";

const env = vi.hoisted(() => ({ dir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => env.dir,
}));

const cwd = "/project";
const parentId = "11111111-1111-4111-8111-111111111111";
const childIds = Array.from(
	{ length: 9 },
	(_, i) => `22222222-2222-4222-8222-${String(i + 1).padStart(12, "0")}`,
);
let parentFile: string;
let childFile: string;
let entries: Record<string, unknown>[];

function sessionHeader(id: string, parentSession?: string) {
	return {
		type: "session",
		version: 3,
		id,
		cwd,
		timestamp: "2026-01-01T00:00:00.000Z",
		...(parentSession ? { parentSession } : {}),
	};
}
function message(id: string, parentId: string | null, value: Record<string, unknown>) {
	return { type: "message", id, parentId, ...value };
}
function relationEntries() {
	const start = Date.parse("2026-01-01T00:00:00.000Z");
	const rows: Record<string, unknown>[] = [
		{ type: "session_info", id: "parent-name", parentId: null, name: "Parent title" },
		{
			type: "message",
			id: "u",
			parentId: "parent-name",
			message: { role: "user", content: "parent prompt" },
		},
	];
	for (let i = 0; i < childIds.length; i++) {
		const agentId = `${(0xabcdef10 + i).toString(16)}-1234-5678`;
		const callId = `call-${i}`;
		rows.push(
			message(`invoke-${i}`, rows.at(-1)?.id as string, {
				message: {
					role: "assistant",
					timestamp: start + i * 1000,
					content: [{ type: "toolCall", id: callId, name: "Agent", arguments: { subagent_type: "Explore" } }],
				},
			}),
		);
		rows.push(
			message(`receipt-${i}`, `invoke-${i}`, {
				message: {
					role: "toolResult",
					toolName: "Agent",
					toolCallId: callId,
					timestamp: start + i * 1000 + 500,
					details: { agentId, subagentType: "Explore", description: `task ${i}`, status: "completed" },
				},
			}),
		);
	}
	return rows;
}
async function writeParent(nextEntries = entries) {
	await writeFile(
		parentFile,
		[sessionHeader(parentId), ...nextEntries].map((row) => JSON.stringify(row)).join("\n") + "\n",
	);
}
async function writeChild(index: number) {
	const id = childIds[index]!;
	childFile = join(env.dir, "sessions", "project", `2026-01-01T00-00-08-000Z_${id}.jsonl`);
	const created = new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1000 + 100).toISOString();
	await writeFile(
		childFile,
		[
			{ ...sessionHeader(id, parentFile), timestamp: created },
			{ type: "session_info", id: "n", parentId: null, name: `Explore#${(0xabcdef10 + index).toString(16)}` },
			{ type: "message", id: "u", parentId: "n", message: { role: "user", content: "child prompt" } },
		]
			.map((row) => JSON.stringify(row))
			.join("\n") + "\n",
	);
}

beforeEach(async () => {
	env.dir = await mkdtemp(join(tmpdir(), "hover-parent-"));
	const directory = join(env.dir, "sessions", "project");
	await mkdir(directory, { recursive: true });
	parentFile = join(directory, `2026-01-01T00-00-00-000Z_${parentId}.jsonl`);
	entries = relationEntries();
	await writeParent();
	for (let i = 0; i < childIds.length; i++) await writeChild(i);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(env.dir, { recursive: true, force: true });
});

describe("重启后恢复悬停父关系与分页", () => {
	it("普通历史子文件可从完整父分支恢复父 DTO，包含父首屏之外的第九个 child", async () => {
		const result = await previewSessionFile(childIds[8]!, cwd, childFile);
		expect(result.status).toBe("ok");
		expect(result.relations?.parent).toEqual({
			sessionId: parentId,
			sessionFile: parentFile,
			cwd,
			name: "Parent title",
		});
	});

	it("按 0/6/越界 offset 分页并提供完整集合稳定 revision", async () => {
		const first = await previewSessionFile(parentId, cwd, parentFile, 0);
		const second = await previewSessionFile(parentId, cwd, parentFile, 6);
		const beyond = await previewSessionFile(parentId, cwd, parentFile, 90);
		expect(first.relations).toMatchObject({ offset: 0, total: 9, hidden: 3 });
		expect(first.relations?.children).toHaveLength(6);
		expect(second.relations).toMatchObject({
			offset: 6,
			total: 9,
			hidden: 0,
			revision: first.relations?.revision,
		});
		expect(second.relations?.children).toHaveLength(3);
		expect(beyond.relations).toMatchObject({
			offset: 90,
			total: 9,
			hidden: 0,
			revision: first.relations?.revision,
			children: [],
		});
		const stable = await previewSessionFile(parentId, cwd, parentFile, 0);
		expect(stable.relations?.revision).toBe(first.relations?.revision);
		const changedEntries = entries.map((entry) => {
			if (entry.id !== "receipt-0") return entry;
			const message = entry.message as Record<string, unknown>;
			const details = message.details as Record<string, unknown>;
			return { ...entry, message: { ...message, details: { ...details, description: "changed task" } } };
		});
		await writeParent(changedEntries);
		const changed = await previewSessionFile(parentId, cwd, parentFile, 0);
		expect(changed.relations?.revision).not.toBe(first.relations?.revision);
	});

	it("已加载父分支撤回时不回退到仍含旧派工的磁盘文件", async () => {
		const diskEntries = entries;
		const loadedEntries = [
			{ type: "session_info", id: "n", parentId: null, name: "Loaded parent" },
			{ type: "message", id: "u", parentId: "n", message: { role: "user", content: "loaded" } },
		];
		const loadedManager = {
			getHeader: () => sessionHeader(parentId),
			getEntries: () => loadedEntries,
			getLeafId: () => "u",
			getSessionFile: () => parentFile,
		};
		const result = await previewSessionFile(childIds[8]!, cwd, childFile, 0, (id) =>
			id === parentId ? { cwd, manager: loadedManager as never } : undefined,
		);
		expect(result.relations?.parent).toBeUndefined();
		await writeParent(diskEntries);
	});

	it("普通 Fork 仅带 parentSession 且身份不在真实 Agent 分支时不恢复假父关系", async () => {
		const forkId = "33333333-3333-4333-8333-333333333333";
		const forkFile = join(env.dir, "sessions", "project", `2026-01-01T00-00-09-000Z_${forkId}.jsonl`);
		await writeFile(
			forkFile,
			[
				{ ...sessionHeader(forkId, parentFile), timestamp: "2026-01-01T00:00:09.000Z" },
				{ type: "session_info", id: "n", parentId: null, name: "普通复制会话" },
				{ type: "message", id: "u", parentId: "n", message: { role: "user", content: "fork" } },
			]
				.map((row) => JSON.stringify(row))
				.join("\n") + "\n",
		);
		const result = await previewSessionFile(forkId, cwd, forkFile);
		expect(result.status).toBe("ok");
		expect(result.relations?.parent).toBeUndefined();
	});

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])("非法 offset %s 在读取前失败关闭", async (offset) => {
		const result = await previewSessionFile(parentId, cwd, parentFile, offset);
		expect(result).toMatchObject({ status: "unavailable", reason: "identity_mismatch" });
	});
});
