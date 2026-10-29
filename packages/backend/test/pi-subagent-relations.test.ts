import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ dir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => env.dir,
}));

import {
	PiSubagentRelationLimitError,
	resolvePiSubagentRelations,
} from "../src/session/pi-subagent-relations";

let root = "";
const parentFile = () => join(env.dir, "sessions", "--project--", "parent.jsonl");
const childFile = (id: string, stamp = "2025-01-01T00-00-02-000Z") =>
	join(env.dir, "sessions", "--project--", `${stamp}_${id}.jsonl`);
const header = (
	id: string,
	parent = parentFile(),
	cwd = "/project",
	timestamp = "2025-01-01T00:00:01.500Z",
) => ({ type: "session", version: 3, id, cwd, timestamp, parentSession: parent });
const message = (id: string, role: string, extra: Record<string, unknown> = {}, time = 1000) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: new Date(1735689600000 + time).toISOString(),
	message: { role, timestamp: 1735689600000 + time, ...extra },
});
const assistantCall = (callId: string, args: Record<string, unknown>, time = 1000) =>
	message(
		`call-${callId}`,
		"assistant",
		{ content: [{ type: "toolCall", id: callId, name: "Agent", arguments: args }] },
		time,
	);
const receipt = (callId: string, id: string, extra: Record<string, unknown> = {}, time = 2000) =>
	message(
		`result-${callId}`,
		"toolResult",
		{
			toolCallId: callId,
			toolName: "Agent",
			details: {
				agentId: id,
				subagentType: "Explore",
				status: "background",
				description: "Inspect module\nprivate output",
				...extra,
			},
		},
		time,
	);
const args = (type = "Explore", extra: Record<string, unknown> = {}) => ({
	subagent_type: type,
	description: "Inspect module",
	task: "Inspect module deeply",
	...extra,
});
const childText = (
	id: string,
	options: {
		parent?: string;
		cwd?: string;
		name?: string;
		rename?: string;
		timestamp?: string;
		body?: unknown[];
	} = {},
) => {
	const entries: unknown[] = [header(id, options.parent, options.cwd, options.timestamp)];
	entries.push({ type: "model_change", id: "model", parentId: null, timestamp: "2025-01-01T00:00:00.500Z" });
	entries.push({
		type: "session_info",
		id: "name",
		parentId: null,
		timestamp: "2025-01-01T00:00:01.000Z",
		name: options.name ?? `Explore#${id.slice(0, 8)}`,
	});
	if (options.rename)
		entries.push({
			type: "session_info",
			id: "rename",
			parentId: null,
			timestamp: "2025-01-01T00:00:01.500Z",
			name: options.rename,
		});
	entries.push(message("first", "user", { content: "body" }, 1500));
	entries.push(...(options.body ?? []));
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
};
async function setup() {
	root = await mkdtemp(join(tmpdir(), "pi-relations-"));
	env.dir = root;
	await mkdir(join(root, "sessions", "--project--"), { recursive: true });
	await writeFile(parentFile(), "{}");
	return { cwd: "/project", sessionFile: parentFile() };
}
async function createChild(id: string, options: Parameters<typeof childText>[1] = {}) {
	const file = childFile(id);
	await writeFile(file, childText(id, options));
	return file;
}
const branch = (...entries: Record<string, unknown>[]) => entries;
afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = "";
});

describe("pi-subagents persisted relation resolver", () => {
	it("resolves the real Agent receipt protocol, honors earliest name, ignores rename and stops at first message", async () => {
		const parent = await setup();
		const id = "38e86c9b-9625-4c4";
		const sessionId = "01a185ae-90f3-7273-8ab0-c49d3e766e14";
		const file = await createChild(sessionId, {
			name: `Explore#${id.slice(0, 8)}`,
			rename: "Renamed later",
			body: ["x".repeat(50000)],
		});
		const result = await resolvePiSubagentRelations(
			branch(assistantCall("tool-1", args()), receipt("tool-1", id)),
			parent,
		);
		expect(result.byEntryId.get("result-tool-1")).toMatchObject({
			sessionFile: file,
			sessionId,
			agent: "Explore",
			taskFirstLine: "Inspect module",
			status: "unknown",
		});
		expect(result.validatedFiles.has(process.platform === "win32" ? file.toLowerCase() : file)).toBe(true);
	});

	it("does not read an oversized first message once the original identity has been read", async () => {
		const parent = await setup();
		const id = "01234567-abcd-4321";
		const text = childText(id).replace(
			'"content":"body"',
			`"content":${JSON.stringify("x".repeat(256 * 1024))}`,
		);
		await writeFile(childFile(id), text);
		const result = await resolvePiSubagentRelations(
			branch(assistantCall("x", args()), receipt("x", id)),
			parent,
			{ maxPrefixBytes: 2048 },
		);
		expect(result.byEntryId.size).toBe(1);
	});

	it("accepts model changes before the earliest session_info and rejects wrong initial name, parent, and cwd", async () => {
		const parent = await setup();
		const id = "aaaaaaaa-1111-2222";
		const file = await createChild(id);
		const entries = branch(assistantCall("x", args()), receipt("x", id));
		expect((await resolvePiSubagentRelations(entries, parent)).byEntryId.size).toBe(1);
		for (const options of [{ name: "Other" }, { parent: join(root, "wrong.jsonl") }, { cwd: "/elsewhere" }]) {
			await writeFile(file, childText(id, options));
			expect((await resolvePiSubagentRelations(entries, parent)).byEntryId.size).toBe(0);
		}
	});

	it("requires a branch Agent call/result pair and a parent file; explicit resume is excluded", async () => {
		const parent = await setup();
		const id = "bbbbbbbb-1111-2222";
		await createChild(id);
		expect(
			(await resolvePiSubagentRelations(branch(assistantCall("x", args())), parent)).byEntryId.size,
		).toBe(0);
		expect(
			(
				await resolvePiSubagentRelations(
					branch(assistantCall("x", args("Explore", { resume: "old" })), receipt("x", id)),
					parent,
				)
			).byEntryId.size,
		).toBe(0);
		expect(
			(await resolvePiSubagentRelations(branch(assistantCall("x", args()), receipt("y", id)), parent))
				.byEntryId.size,
		).toBe(0);
		expect(
			(
				await resolvePiSubagentRelations(branch(assistantCall("x", args()), receipt("x", id)), {
					cwd: parent.cwd,
				})
			).byEntryId.size,
		).toBe(0);
	});

	it("keeps same-role agents and collapses duplicate full IDs to newest entry/task", async () => {
		const parent = await setup();
		const a = "cccccccc-1111-2222",
			b = "dddddddd-1111-2222";
		const fa = await createChild(a),
			fb = await createChild(b, { timestamp: "2025-01-01T00:00:03.500Z" });
		const entries = branch(
			assistantCall("a1", args(), 1000),
			receipt("a1", a, {}, 2000),
			assistantCall("b1", args(), 3000),
			receipt("b1", b, {}, 4000),
			assistantCall("a2", args(), 5000),
			receipt("a2", a, { description: "Latest task" }, 6000),
		);
		const result = await resolvePiSubagentRelations(entries, parent);
		expect([...result.byEntryId.keys()]).toEqual(["result-a2", "result-b1"]);
		expect(result.byEntryId.get("result-a2")).toMatchObject({
			sessionFile: fa,
			taskFirstLine: "Latest task",
			createdAt: 1735689601000,
		});
		expect(result.byEntryId.get("result-b1")?.sessionFile).toBe(fb);
	});

	it("rejects prefix collisions, multiple matching files, ordinary clones, and time misses", async () => {
		const parent = await setup();
		const a = "eeeeeeee-1111-2222",
			b = "eeeeeeee-3333-4444";
		await createChild(a);
		const ca = branch(assistantCall("a", args()), receipt("a", a));
		expect(
			(
				await resolvePiSubagentRelations(
					branch(...ca, assistantCall("b", args(), 3000), receipt("b", b, {}, 4000)),
					parent,
				)
			).byEntryId.size,
		).toBe(0);
		const duplicate = childFile(a, "2025-01-01T00-00-03-000Z");
		await writeFile(duplicate, childText(a));
		expect((await resolvePiSubagentRelations(ca, parent)).byEntryId.size).toBe(0);
		await rm(duplicate);
		const clone = childFile(a, "2025-01-01T00-00-04-000Z");
		await writeFile(clone, childText(a, { parent: join(root, "sessions", "--project--", "source.jsonl") }));
		expect((await resolvePiSubagentRelations(ca, parent)).byEntryId.size).toBe(1);
		await writeFile(clone, childText(a));
		expect((await resolvePiSubagentRelations(ca, parent)).byEntryId.size).toBe(0);
		await rm(clone);
		await writeFile(childFile(a), childText(a, { timestamp: "2025-01-01T00:00:09.000Z" }));
		expect((await resolvePiSubagentRelations(ca, parent)).byEntryId.size).toBe(0);
	});

	it("marks explicit terminal results and completion records, otherwise unknown; limits throw atomically", async () => {
		const parent = await setup();
		const id = "ffffffff-1111-2222";
		await createChild(id);
		const base = [assistantCall("x", args()), receipt("x", id)];
		expect(
			(await resolvePiSubagentRelations(branch(...base), parent)).byEntryId.get("result-x")?.status,
		).toBe("unknown");
		expect(
			(
				await resolvePiSubagentRelations(
					branch(assistantCall("x", args()), receipt("x", id, { status: "done" })),
					parent,
				)
			).byEntryId.get("result-x")?.status,
		).toBe("done");
		const record = {
			type: "custom",
			id: "record",
			parentId: null,
			timestamp: "2025-01-01T00:00:03Z",
			customType: "subagents:record",
			data: {
				id,
				type: "Explore",
				status: "completed",
				startedAt: 1735689601100,
				completedAt: 1735689602500,
			},
		};
		expect(
			(await resolvePiSubagentRelations(branch(...base, record), parent)).byEntryId.get("result-x")?.status,
		).toBe("done");
		await expect(resolvePiSubagentRelations(branch(...base), parent, { maxFiles: 0 })).rejects.toBeInstanceOf(
			PiSubagentRelationLimitError,
		);
		await expect(
			resolvePiSubagentRelations(branch(...base), parent, { maxTotalBytes: 1 }),
		).rejects.toBeInstanceOf(PiSubagentRelationLimitError);
		await expect(
			resolvePiSubagentRelations(branch(...base), parent, { maxPrefixBytes: 32 }),
		).rejects.toBeInstanceOf(PiSubagentRelationLimitError);
	});

	it("ignores missing, malformed, and external symlink candidates", async () => {
		const parent = await setup();
		const id = "11111111-2222-3333";
		const link = childFile(id);
		const outside = join(root, "outside.jsonl");
		await writeFile(outside, childText(id));
		await symlink(outside, link);
		const missing = "22222222-3333-4444";
		const result = await resolvePiSubagentRelations(
			branch(assistantCall("a", args()), receipt("a", id), assistantCall("b", args()), receipt("b", missing)),
			parent,
		);
		expect(result.byEntryId.size).toBe(0);
	});
});
