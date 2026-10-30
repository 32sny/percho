import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type RelationRecordV1,
	SUBAGENT_RELATION_CUSTOM_TYPE,
} from "../src/session/subagent-relation-records";
import { previewLoadedSession, previewSessionFile } from "../src/session/title-preview";
import { makeSubagentRelationsExtension } from "../src/tools/subagent-relations";

const roots: string[] = [];
const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const model = {
	id: "local",
	name: "local",
	api: "openai-completions" as const,
	provider: "fake",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1024,
};
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (content: unknown[], stopReason = "stop") => ({
	role: "assistant",
	content,
	stopReason,
	timestamp: Date.now(),
	api: model.api,
	provider: "fake",
	model: "local",
	usage,
});
function streamOnce(calls: Array<{ name: string; arguments: unknown; id: string }>) {
	let used = false;
	return async () => ({
		async *[Symbol.asyncIterator]() {},
		result: async () => {
			if (used) return assistant([{ type: "text", text: "finished" }]);
			used = true;
			return assistant(
				calls.map((call) => ({ type: "toolCall", ...call })),
				"toolUse",
			);
		},
	});
}

async function setup() {
	const root = mkdtempSync(join(tmpdir(), "subagent-relation-sdk-"));
	roots.push(root);
	const agentDir = join(root, "agent"),
		cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "test" } }));
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					baseUrl: "https://example.invalid",
					api: model.api,
					apiKey: "test",
					models: [{ id: "local", contextWindow: 200_000, maxTokens: 1024 }],
				},
			},
		}),
	);
	const settings = SettingsManager.inMemory({ defaultTools: ["codemode"], compaction: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		extensionFactories: [
			makeSubagentRelationsExtension(),
			{ name: "codemode", factory: createCodemodeExtension({ models: false }) },
		],
	});
	await loader.reload();
	const manager = SessionManager.create(cwd, join(agentDir, "sessions", "project"));
	const createChild = (agent: string, task: string) => {
		const child = SessionManager.create(cwd, join(agentDir, "sessions-subagents", "project"));
		child.appendSessionInfo(`${agent}: ${task}`);
		child.appendMessage({ role: "user", content: task, timestamp: Date.now() });
		child.appendMessage(assistant([{ type: "text", text: "test output" }]) as never);
		return {
			agent,
			task,
			exitCode: task === "failed" ? 1 : 0,
			artifactPaths: { jsonlPath: child.getSessionFile() },
		};
	};
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		sessionManager: manager,
		settingsManager: settings,
		resourceLoader: loader,
		initialActiveToolNames: ["codemode"],
		customTools: [
			{
				name: "subagent",
				label: "subagent",
				description: "test deterministic child",
				parameters: Type.Object({
					agent: Type.Optional(Type.String()),
					task: Type.Optional(Type.String()),
					tasks: Type.Optional(Type.Array(Type.Object({ agent: Type.String(), task: Type.String() }))),
				}),
				execute: async (_id, args) => ({
					content: [{ type: "text", text: "done" }],
					details: {
						results: (args.tasks ?? [{ agent: args.agent!, task: args.task! }]).map(({ agent, task }) =>
							createChild(agent, task),
						),
					},
				}),
			},
			{
				name: "wrapper",
				label: "wrapper",
				description: "nested wrapper",
				parameters: Type.Object({ task: Type.String() }),
				execute: async (_id, args, signal, _update, ctx) =>
					(await ctx.executeTool("subagent", { agent: "scout", task: args.task }, { signal })).result,
			},
			{
				name: "Agent",
				label: "Agent",
				description: "test plugin protocol",
				parameters: Type.Object({
					subagent_type: Type.String(),
					description: Type.String(),
					resume: Type.Optional(Type.String()),
				}),
				execute: async (_id, args) => {
					const agentId = randomUUID(),
						childId = randomUUID();
					const file = join(dirname(manager.getSessionFile()!), `child_${childId}.jsonl`);
					writeFileSync(
						file,
						[
							{
								type: "session",
								version: 3,
								id: childId,
								cwd,
								timestamp: new Date().toISOString(),
								parentSession: manager.getSessionFile(),
							},
							{
								type: "session_info",
								id: "name",
								parentId: null,
								name: `${args.subagent_type}#${agentId.slice(0, 8)}`,
							},
							{
								type: "message",
								id: "user",
								parentId: "name",
								message: { role: "user", content: args.description },
							},
						]
							.map((entry) => JSON.stringify(entry))
							.join("\n") + "\n",
					);
					return {
						content: [{ type: "text", text: "done" }],
						details: {
							agentId,
							subagentType: args.subagent_type,
							description: args.description,
							status: "completed",
						},
					};
				},
			},
		],
	});
	sessions.push(session);
	return { session, cwd, manager };
}
function relations(manager: SessionManager): RelationRecordV1[] {
	return manager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === SUBAGENT_RELATION_CUSTOM_TYPE
				? [entry.data as RelationRecordV1]
				: [],
		);
}
async function run(code: string, extra: Array<{ name: string; arguments: unknown; id: string }> = []) {
	const state = await setup();
	state.session.agent.streamFunction = streamOnce([
		{ name: "codemode", id: "outer-call", arguments: { code } },
		...extra,
	]) as never;
	await state.session.prompt("run the nested tool");
	return state;
}
async function preview(state: Awaited<ReturnType<typeof setup>>) {
	return previewSessionFile(state.manager.getSessionId(), state.cwd, state.manager.getSessionFile()!);
}

describe("real SDK codemode persistence and hover integration (no network model)", () => {
	it("writes a bounded record before nested/outer notification, and survives cold reload", async () => {
		const state = await setup();
		const order: string[] = [];
		state.session.subscribe((event) => {
			if (
				event.type === "entry_appended" &&
				event.entry.type === "custom" &&
				event.entry.customType === SUBAGENT_RELATION_CUSTOM_TYPE
			)
				order.push("record");
			if (event.type === "tool_execution_end") order.push(event.toolName);
		});
		state.session.agent.streamFunction = streamOnce([
			{
				name: "codemode",
				id: "outer-call",
				arguments: { code: 'return await tools.subagent({agent:"scout",task:"nested"})' },
			},
		]) as never;
		await state.session.prompt("run");
		const [relation] = relations(state.manager);
		expect(relation?.runs).toHaveLength(1);
		const outer = state.manager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "codemode",
			);
		expect(
			JSON.stringify(
				outer && "message" in outer && outer.message.role === "toolResult" && outer.message.details,
			),
		).not.toContain(relation!.runs![0]!.sessionFile);
		expect(order).toEqual(["record", "subagent", "codemode"]);
		expect((await preview(state)).relations).toMatchObject({
			total: 1,
			children: [{ agent: "scout", taskFirstLine: "nested", status: "done" }],
		});
		const reopened = SessionManager.open(state.manager.getSessionFile()!);
		expect(
			(await previewLoadedSession(reopened.getSessionId(), state.cwd, state.cwd, reopened)).relations?.total,
		).toBe(1);
	});

	it("retains completed children when the outer script later throws", async () => {
		const state = await run(
			'await tools.subagent({agent:"scout",task:"nested"}); throw new Error("outer fails")',
		);
		expect((await preview(state)).relations?.total).toBe(1);
	});
	it("retains completed children when the outer script is cancelled", async () => {
		const state = await setup();
		state.session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolName === "subagent") void state.session.abort();
		});
		state.session.agent.streamFunction = streamOnce([
			{
				name: "codemode",
				id: "outer-call",
				arguments: { code: 'await tools.subagent({agent:"scout",task:"nested"}); return "after"' },
			},
		]) as never;
		await state.session.prompt("run");
		expect((await preview(state)).relations?.total).toBe(1);
	});
	it("keeps two parallel root calls and parallel children correctly owned", async () => {
		const state = await run(
			'await Promise.all([tools.subagent({agent:"scout",task:"one"}),tools.subagent({agent:"scout",task:"two"})])',
			[
				{
					name: "codemode",
					id: "other-call",
					arguments: { code: 'await tools.subagent({agent:"scout",task:"three"})' },
				},
			],
		);
		expect(
			relations(state.manager)
				.map((record) => record.rootToolCallId)
				.sort(),
		).toEqual(["other-call", "outer-call", "outer-call"]);
		expect((await preview(state)).relations?.total).toBe(3);
	});
	it("resolves multiple SDK nesting layers without treating the wrapper result as another agent", async () => {
		const state = await run('await tools.wrapper({task:"through wrapper"})');
		expect(relations(state.manager)).toMatchObject([
			{ rootToolCallId: "outer-call", parentToolCallId: "outer-call/1", toolCallId: "outer-call/1/1" },
		]);
		expect((await preview(state)).relations?.total).toBe(1);
	});
	it("keeps failed children with real files and paginates fanout", async () => {
		const state = await run(
			'await tools.subagent({tasks:Array.from({length:8},(_,i)=>({agent:"scout",task:i===0?"failed":"task "+i}))}); await tools.subagent({agent:"scout",task:"ninth"})',
		);
		const result = await preview(state);
		expect(result.relations).toMatchObject({ total: 9, hidden: 3 });
		const last = await previewSessionFile(
			state.manager.getSessionId(),
			state.cwd,
			state.manager.getSessionFile()!,
			6,
		);
		expect(last.relations?.children.some((child) => child.status === "error")).toBe(true);
	});
	it("records nested Agent identity, opens its verified child and restores plugin parent", async () => {
		const state = await run('await tools.Agent({subagent_type:"Explore",description:"inspect plugin"})');
		const [record] = relations(state.manager);
		expect(record?.claim?.subagentType).toBe("Explore");
		const result = await preview(state);
		expect(result.relations?.total).toBe(1);
		const child = result.relations!.children[0]!;
		expect(
			(await previewSessionFile(child.sessionId!, state.cwd, child.sessionFile)).relations?.parent?.sessionId,
		).toBe(state.manager.getSessionId());
	});
	it("does not create new relationships for Agent resume or duplicate direct subagent results", async () => {
		const state = await run(
			'await tools.Agent({subagent_type:"Explore",description:"resume",resume:"prior"})',
			[{ name: "subagent", id: "direct", arguments: { agent: "scout", task: "direct" } }],
		);
		expect(relations(state.manager)).toEqual([]);
		expect((await preview(state)).relations?.total).toBe(1);
	});
	it("drops an abandoned branch after recall, including a later copied recovery entry", async () => {
		const state = await run('await tools.subagent({agent:"scout",task:"nested"})');
		const [record] = relations(state.manager);
		const firstUser = state.manager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user")!;
		state.manager.branch(firstUser.id);
		state.manager.appendCustomEntry("message-recalled", {});
		state.manager.appendCustomEntry(SUBAGENT_RELATION_CUSTOM_TYPE, { ...record, origin: "trace-recovery" });
		expect((await preview(state)).relations).toBeUndefined();
	});
});
