import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isOrdinarySessionPath,
	isSubagentSessionPath,
	ordinarySessionsRoot,
	subagentSessionsRoot,
	validateOrdinarySessionFile,
	validateSubagentSessionFile,
} from "../src/session/subagent-paths";

let dir: string | undefined;
afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
	dir = undefined;
});

describe("subagent transcript path validation", () => {
	it("requires a regular jsonl descendant and verifies canonical containment", async () => {
		dir = await mkdtemp(join(tmpdir(), "subagent-path-"));
		const root = subagentSessionsRoot(dir);
		const project = join(root, "project");
		await mkdir(project, { recursive: true });
		const file = join(project, "run_12345678.jsonl");
		await writeFile(file, "{}");
		expect(isSubagentSessionPath(root, dir)).toBe(false);
		expect(await validateSubagentSessionFile(file, dir)).toBe(resolve(file));
		expect(await validateSubagentSessionFile(project, dir)).toBeUndefined();
		expect(await validateSubagentSessionFile(file.replace(/jsonl$/, "txt"), dir)).toBeUndefined();
	});

	it("rejects a symlink whose real target escapes the root", async () => {
		dir = await mkdtemp(join(tmpdir(), "subagent-path-link-"));
		const root = subagentSessionsRoot(dir);
		const project = join(root, "project");
		await mkdir(project, { recursive: true });
		const outside = join(dir, "outside.jsonl");
		await writeFile(outside, "{}");
		const link = join(project, "linked_12345678.jsonl");
		await symlink(outside, link);
		expect(await validateSubagentSessionFile(link, dir)).toBeUndefined();
	});

	it("validates ordinary sessions under the default sessions root without relaxing the built-in root", async () => {
		dir = await mkdtemp(join(tmpdir(), "ordinary-session-path-"));
		const root = ordinarySessionsRoot(dir);
		const project = join(root, "--project--");
		await mkdir(project, { recursive: true });
		const file = join(project, "session.jsonl");
		await writeFile(file, "{}");
		expect(isOrdinarySessionPath(root, dir)).toBe(false);
		expect(isOrdinarySessionPath(file, dir)).toBe(true);
		expect(await validateOrdinarySessionFile(file, dir)).toBe(resolve(file));
		expect(await validateOrdinarySessionFile(join(dir, "outside.jsonl"), dir)).toBeUndefined();
		const external = join(dir, "external.jsonl");
		await writeFile(external, "{}");
		const link = join(project, "link.jsonl");
		await symlink(external, link);
		expect(await validateOrdinarySessionFile(link, dir)).toBeUndefined();
	});

	it("keeps Windows containment comparisons case-insensitive", () => {
		if (process.platform !== "win32") return;
		expect(isSubagentSessionPath("c:\\agent\\SESSIONS-SUBAGENTS\\project\\x.jsonl", "C:\\Agent")).toBe(true);
		expect(isOrdinarySessionPath("c:\\agent\\SESSIONS\\project\\x.jsonl", "C:\\Agent")).toBe(true);
	});
});
