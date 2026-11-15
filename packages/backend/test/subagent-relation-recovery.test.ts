import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFileHoverHistory } from "../src/session/hover-history";
import { SUBAGENT_RELATION_CUSTOM_TYPE } from "../src/session/subagent-relation-records";
import {
	applyRecoveryReport,
	createRecoveryReport,
	recoveryHash,
	rollbackRecovery,
} from "../src/session/subagent-relation-recovery";

const roots: string[] = [];
const start = 1_760_000_000_000;
const encode = (entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
async function fixture(callCount = 1, slots = 1) {
	const root = await mkdtemp(join(tmpdir(), "recovery-fixture-"));
	roots.push(root);
	const agentDir = join(root, "agent"),
		sessions = join(agentDir, "sessions", "project"),
		children = join(agentDir, "sessions-subagents", "project");
	await mkdir(sessions, { recursive: true });
	await mkdir(children, { recursive: true });
	await mkdir(join(sessions, "traces"));
	const parentId = randomUUID(),
		parentFile = join(sessions, `parent_${parentId}.jsonl`),
		cwd = root;
	const childFiles: string[] = [],
		events: Array<Record<string, unknown>> = [],
		calls = [];
	for (let i = 0; i < callCount; i++) {
		const inputs = [],
			results = [];
		for (let j = 0; j < slots; j++) {
			const id = randomUUID(),
				file = join(children, `child_${id}.jsonl`),
				task = `task ${i}/${j}`;
			await writeFile(
				file,
				encode([{ type: "session", version: 3, id, cwd, timestamp: new Date(start + 10).toISOString() }]),
			);
			childFiles.push(file);
			inputs.push({ agent: "scout", task, cwd: cwd.replaceAll("\\", "/") });
			results.push({ agent: "scout", task, exitCode: 0, artifactPaths: { jsonlPath: file } });
		}
		const toolCallId = `outer/${i + 1}`;
		calls.push({ id: toolCallId, name: "subagent", args: "truncated arguments...", status: "ok" });
		events.push({
			type: "tool_execution_start",
			toolCallId,
			parentToolCallId: "outer",
			toolName: "subagent",
			ts: start,
			args: slots === 1 ? inputs[0] : { tasks: inputs },
		});
		events.push({
			type: "tool_execution_end",
			toolCallId,
			parentToolCallId: "outer",
			toolName: "subagent",
			ts: start + 20,
			result: { details: { results } },
		});
	}
	const entries = [
		{ type: "session", version: 3, id: parentId, cwd, timestamp: new Date(start - 100).toISOString() },
		{ type: "message", id: "user", parentId: null, message: { role: "user", content: "question" } },
		{
			type: "message",
			id: "anchor",
			parentId: "user",
			message: { role: "assistant", content: [{ type: "toolCall", id: "outer", name: "codemode" }] },
		},
		{
			type: "message",
			id: "result",
			parentId: "anchor",
			message: { role: "toolResult", toolName: "codemode", toolCallId: "outer", details: { calls } },
		},
	];
	const original = encode(entries);
	await writeFile(parentFile, original);
	const trace = join(sessions, "traces", `trace-${parentId}.jsonl`);
	await writeFile(trace, encode(events));
	return {
		root,
		parentId,
		parentFile,
		agentDir,
		original,
		trace,
		events,
		entries,
		childFiles,
		cwd,
		options: { parentFiles: [parentFile], agentDir },
	};
}
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("historical nested relation recovery", () => {
	it("dry-run is read-only and compares full Windows cwd paths semantically", async () => {
		const f = await fixture(),
			before = await readFile(f.parentFile);
		const report = await createRecoveryReport(f.options);
		expect(report.parents[0]?.rejected).toEqual([]);
		expect(report.parents[0]?.candidates).toHaveLength(1);
		expect(report.parents[0]?.candidates[0]?.record.runs?.[0]?.sessionFile).toBe(f.childFiles[0]);
		expect(await readFile(f.parentFile)).toEqual(before);
	});
	it("keeps parallel results in one record and chains multiple appended records on the active branch", async () => {
		const f = await fixture(2, 3),
			report = await createRecoveryReport(f.options);
		expect(report.parents[0]?.candidates).toHaveLength(2);
		expect(report.parents[0]?.candidates[0]?.record.runs).toHaveLength(3);
		const [result] = await applyRecoveryReport(report, f.options, true);
		expect(result?.status, result?.error).toBe("applied");
		const after = await readFile(f.parentFile),
			backup = await readFile(result!.backup!);
		expect(backup.toString()).toBe(f.original);
		expect(after.subarray(0, backup.length)).toEqual(backup);
		const history = await readFileHoverHistory(f.parentId, f.cwd, f.parentFile);
		expect(history.branch.filter((entry) => entry.customType === SUBAGENT_RELATION_CUSTOM_TYPE)).toHaveLength(
			2,
		);
		const again = await createRecoveryReport(f.options);
		expect(again.parents[0]?.existing).toBe(2);
		expect(again.parents[0]?.candidates).toHaveLength(0);
		expect((await applyRecoveryReport(again, f.options, true))[0]?.status).toBe("unchanged");
		await rollbackRecovery(f.parentFile, result!.backup!, result!.appliedHash!, {
			agentDir: f.agentDir,
			confirmed: true,
		});
		expect((await readFile(f.parentFile)).toString()).toBe(f.original);
	});
	it("requires explicit confirmation and refuses stale application/rollback", async () => {
		const f = await fixture(),
			report = await createRecoveryReport(f.options);
		await expect(applyRecoveryReport(report, f.options, false)).rejects.toThrow(/confirmation/);
		const [result] = await applyRecoveryReport(report, f.options, true);
		expect(result?.status).toBe("applied");
		expect((await applyRecoveryReport(report, f.options, true))[0]?.status).toBe("rejected");
		await expect(
			rollbackRecovery(f.parentFile, result!.backup!, result!.appliedHash!, {
				agentDir: f.agentDir,
				confirmed: false,
			}),
		).rejects.toThrow(/confirmation/);
		await writeFile(f.parentFile, (await readFile(f.parentFile)).toString() + "\n");
		await expect(
			rollbackRecovery(f.parentFile, result!.backup!, result!.appliedHash!, {
				agentDir: f.agentDir,
				confirmed: true,
			}),
		).rejects.toThrow(/changed/);
	});
	it.each(["parent", "trace", "child"])("refuses reviewed evidence when %s changes", async (kind) => {
		const f = await fixture(),
			report = await createRecoveryReport(f.options);
		const file = kind === "parent" ? f.parentFile : kind === "trace" ? f.trace : f.childFiles[0]!;
		await writeFile(file, (await readFile(file)).toString() + "\n");
		const before = await readFile(f.parentFile);
		expect((await applyRecoveryReport(report, f.options, true))[0]?.status).toBe("rejected");
		expect(await readFile(f.parentFile)).toEqual(before);
	});
	it("retains exact events around trace gaps and requires both start and end", async () => {
		const f = await fixture();
		await writeFile(f.trace, encode([{ type: "trace_gap" }, ...f.events]));
		const report = await createRecoveryReport(f.options);
		expect(report.parents[0]?.gaps).toHaveLength(1);
		expect(report.parents[0]?.candidates).toHaveLength(1);
		await writeFile(f.trace, encode([f.events[1]]));
		expect((await createRecoveryReport(f.options)).parents[0]?.candidates).toHaveLength(0);
	});
	it("rejects conflicting duplicate trace events and repeated child ownership", async () => {
		const f = await fixture(2);
		await writeFile(f.trace, encode([...f.events, { ...f.events[1], ts: start + 99 }]));
		const conflict = await createRecoveryReport(f.options);
		expect(conflict.parents[0]?.candidates).toHaveLength(1);
		expect(JSON.stringify(conflict.parents[0]?.rejected)).toContain("conflicting trace");
		const end = f.events[3] as {
			result: { details: { results: Array<{ artifactPaths: { jsonlPath: string } }> } };
		};
		end.result.details.results[0]!.artifactPaths.jsonlPath = f.childFiles[0]!;
		await writeFile(f.trace, encode(f.events));
		const owners = await createRecoveryReport(f.options);
		expect(owners.parents[0]?.candidates).toHaveLength(0);
		expect(owners.parents[0]?.conflicts).toHaveLength(2);
	});
	it("does not resurrect a recalled branch and requires current result call IDs", async () => {
		const f = await fixture();
		await writeFile(
			f.parentFile,
			encode([
				...f.entries,
				{ type: "custom", id: "recall", parentId: "user", customType: "message-recalled", data: {} },
			]),
		);
		expect((await createRecoveryReport(f.options)).parents[0]?.candidates).toHaveLength(0);
		await writeFile(f.parentFile, encode(f.entries.slice(0, -1)));
		expect((await createRecoveryReport(f.options)).parents[0]?.candidates).toHaveLength(0);
	});
	it.each(["outside", "id", "cwd", "timestamp", "task"])(
		"rejects unsafe or mismatched child evidence: %s",
		async (kind) => {
			const f = await fixture();
			const raw = JSON.parse((await readFile(f.childFiles[0]!, "utf8")).trim());
			if (kind === "id") raw.id = randomUUID();
			if (kind === "cwd") raw.cwd = join(f.root, "other");
			if (kind === "timestamp") raw.timestamp = new Date(start - 1).toISOString();
			await writeFile(f.childFiles[0]!, encode([raw]));
			const end = f.events[1] as {
				result: { details: { results: Array<{ task: string; artifactPaths: { jsonlPath: string } }> } };
			};
			if (kind === "outside") end.result.details.results[0]!.artifactPaths.jsonlPath = f.parentFile;
			if (kind === "task") end.result.details.results[0]!.task = "not input";
			await writeFile(f.trace, encode(f.events));
			expect((await createRecoveryReport(f.options)).parents[0]?.candidates).toHaveLength(0);
		},
	);
	it("rejects oversized lines without unbounded accumulation, and detects invalid JSON", async () => {
		const f = await fixture();
		await writeFile(f.trace, "x".repeat(2 * 1024 * 1024 + 1) + "\n" + encode(f.events));
		const large = await createRecoveryReport(f.options);
		expect(large.parents[0]?.candidates).toHaveLength(0);
		expect(large.parents[0]?.budget.length).toBeGreaterThan(0);
		await writeFile(f.trace, "not-json\n" + encode(f.events));
		expect((await createRecoveryReport(f.options)).parents[0]?.candidates).toHaveLength(0);
	});
	it("checks the backup hash rather than trusting a valid replacement JSONL", async () => {
		const f = await fixture(),
			report = await createRecoveryReport(f.options);
		const [result] = await applyRecoveryReport(report, f.options, true);
		await writeFile(result!.backup!, f.original + "\n");
		await expect(
			rollbackRecovery(f.parentFile, result!.backup!, result!.appliedHash!, {
				agentDir: f.agentDir,
				confirmed: true,
			}),
		).rejects.toThrow(/integrity/);
		expect(recoveryHash(await readFile(f.parentFile))).toBe(result!.appliedHash);
	});
});
