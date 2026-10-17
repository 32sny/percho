import { execFile } from "node:child_process";
import path from "node:path";
import type {
	GitBlameLine,
	GitBlameOptions,
	GitBlameResult,
	GitBranchItem,
	GitBranchOptions,
	GitBranchResult,
	GitCommitOptions,
	GitCommitRecord,
	GitDiffOptions,
	GitDiffResult,
	GitFileChange,
	GitLogOptions,
	GitLogResult,
	GitShowOptions,
	GitShowResult,
	GitStashItem,
	GitStashOptions,
	GitStashResult,
	GitStatusEntry,
	GitStatusResult,
} from "@percho/shared";

const GIT = "git";
const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ENTRIES = 1_000;
const MAX_PATCH_CHARS = 120_000;

/** One record per commit; fields are unit-separated (%x1f), records are group-separated (%x1e). */
const LOG_FORMAT = [
	"%H", "%h", "%an", "%ae", "%aI", "%cI", "%D", "%s", "%b",
].join("%x1f") + "%x1e";

function runGit(repoRoot: string, args: string[], options: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			GIT,
			["-C", repoRoot, ...args],
			{
				maxBuffer: options.maxBuffer || MAX_BUFFER,
				timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
				windowsHide: true,
				env: {
					...process.env,
					GIT_TERMINAL_PROMPT: "0",
					GIT_PAGER: "cat",
					GIT_OPTIONAL_LOCKS: "0",
				},
			},
			(error, stdout, stderr) => {
				if (error) {
					const message = String(stderr || "").trim() || error.message || "git failed";
					const gitError = new Error(message);
					(gitError as any).code = "GIT_FAILED";
					(gitError as any).stderr = String(stderr || "");
					reject(gitError);
					return;
				}
				resolve(stdout);
			},
		);
	});
}

export async function resolveRepoRoot(candidate: string): Promise<string | null> {
	try {
		const output = await runGit(candidate, ["rev-parse", "--show-toplevel"], { timeoutMs: 5000 });
		return output ? output.trim() || null : null;
	} catch (error: any) {
		if (/not a git repository/i.test(error?.message || "")) return null;
		return null;
	}
}

function isSafeRelativePath(rel: string): boolean {
	if (typeof rel !== "string" || rel.length === 0) return false;
	if (path.isAbsolute(rel)) return false;
	const normalized = path.normalize(rel);
	if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) return false;
	if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return false;
	return true;
}

function isSafeRef(ref: string): boolean {
	if (typeof ref !== "string" || ref.length === 0) return false;
	if (ref.startsWith("-")) return false;
	if (/\s/.test(ref)) return false;
	return /^[A-Za-z0-9._^~:@/\\-]+$/.test(ref);
}

function isSafeBranchName(name: string): boolean {
	if (typeof name !== "string" || name.length === 0) return false;
	if (name === "HEAD") return false;
	if (name.includes("..") || name.includes("@{")) return false;
	return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name);
}

function requireRepoPath(value?: string): string {
	const rel = String(value ?? "");
	if (!rel || !isSafeRelativePath(rel)) {
		throw new Error("path must be a safe repository-relative path (no absolute paths or '..' escapes)");
	}
	return rel;
}

function requireRef(value?: string, label = "ref"): string {
	const ref = String(value ?? "");
	if (!isSafeRef(ref)) {
		throw new Error(`${label} must be a safe ref expression (e.g. HEAD, sha, branch name); got "${ref}"`);
	}
	return ref;
}

function requireBranchName(value?: string): string {
	const name = String(value ?? "");
	if (!isSafeBranchName(name)) {
		throw new Error(`branch name must be a safe ref name; got "${name}"`);
	}
	return name;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const parsed = Number.parseInt(String(value), 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

function truncateText(text: string, limit = MAX_PATCH_CHARS): string {
	const value = String(text || "");
	if (value.length <= limit) return value;
	return `${value.slice(0, limit)}\n… [truncated ${value.length - limit} characters]`;
}

function parseStatusPorcelain(output: string) {
	const result = {
		branch: null as string | null,
		upstream: null as string | null,
		ahead: 0,
		behind: 0,
		gone: false,
		entries: [] as GitStatusEntry[],
		staged: [] as GitStatusEntry[],
		unstaged: [] as GitStatusEntry[],
		untracked: [] as GitStatusEntry[],
		conflicts: [] as GitStatusEntry[],
	};
	const lines = String(output || "").split("\n");
	for (const line of lines) {
		if (line.length === 0) continue;
		if (line.startsWith("## ")) {
			const header = line.slice(3);
			const bracket = header.indexOf(" [");
			const branchPart = bracket === -1 ? header : header.slice(0, bracket);
			const tail = bracket === -1 ? "" : header.slice(bracket + 2, header.length - 1);
			const [local, upstream] = branchPart.split("...");
			result.branch = local || null;
			result.upstream = upstream || null;
			if (/gone/i.test(tail)) result.gone = true;
			const aheadMatch = tail.match(/ahead (\d+)/);
			const behindMatch = tail.match(/behind (\d+)/);
			if (aheadMatch) result.ahead = Number(aheadMatch[1]);
			if (behindMatch) result.behind = Number(behindMatch[1]);
			continue;
		}
		if (line.length < 3) continue;
		const x = line[0];
		const y = line[1];
		let pathPart = line.slice(3);
		let origPath: string | null = null;
		const arrow = pathPart.indexOf(" -> ");
		if (arrow !== -1) {
			origPath = pathPart.slice(0, arrow);
			pathPart = pathPart.slice(arrow + 4);
		}
		const entry: GitStatusEntry = { x, y, path: pathPart, origPath };
		result.entries.push(entry);
		const code = x + y;
		const isConflict = /^(DD|AU|UD|UA|DU|AA|UU)$/.test(code) || x === "U" || y === "U";
		if (isConflict) result.conflicts.push(entry);
		else if (y === "?") result.untracked.push(entry);
		else if (x !== " " && x !== "?") result.staged.push(entry);
		else if (y !== " ") result.unstaged.push(entry);
	}
	return result;
}

function parseLogRecords(output: string): GitCommitRecord[] {
	const records: GitCommitRecord[] = [];
	const parts = String(output || "").split("\x1e");
	for (const part of parts) {
		if (!part) continue;
		const fields = part.replace(/^\r?\n/, "").split("\x1f");
		if (fields.length < 9) continue;
		records.push({
			sha: fields[0],
			shortSha: fields[1],
			author: fields[2],
			authorEmail: fields[3],
			authorDate: fields[4],
			committerDate: fields[5],
			refs: fields[6] || null,
			subject: fields[7],
			body: String(fields[8] || "").trim(),
		});
	}
	return records;
}

function parseNameStatus(output: string): GitFileChange[] {
	const files: GitFileChange[] = [];
	const lines = String(output || "").split("\n");
	for (const line of lines) {
		if (!line) continue;
		const fields = line.split("\t");
		if (fields.length < 2) continue;
		const statusField = fields[0];
		const status = statusField[0] || "?";
		const score = Number.parseInt(statusField.slice(1), 10);
		files.push({
			status,
			score: Number.isFinite(score) ? score : null,
			path: fields[fields.length - 1],
			origPath: fields.length > 2 ? fields[1] : null,
		});
	}
	return files;
}

function parseNumstat(output: string) {
	const files: Array<{ path: string; additions: number | null; deletions: number | null; binary: boolean }> = [];
	const lines = String(output || "").split("\n");
	for (const line of lines) {
		if (!line) continue;
		const [added, deleted, ...rest] = line.split("\t");
		const filePath = rest.join("\t");
		if (!filePath) continue;
		files.push({
			path: filePath,
			additions: added === "-" ? null : Number(added),
			deletions: deleted === "-" ? null : Number(deleted),
			binary: added === "-" || deleted === "-",
		});
	}
	return files;
}

function mergeCounts(nameStatus: GitFileChange[], numstat: ReturnType<typeof parseNumstat>): GitFileChange[] {
	const byPath = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
	for (const file of numstat) byPath.set(file.path, file);
	return nameStatus.map((file) => {
		const counts = byPath.get(file.path);
		return {
			...file,
			additions: counts ? counts.additions : null,
			deletions: counts ? counts.deletions : null,
			binary: counts ? counts.binary : false,
		};
	});
}

function parseBlameLinePorcelain(output: string): GitBlameLine[] {
	const lines = String(output || "").split("\n");
	const records: GitBlameLine[] = [];
	let current: GitBlameLine | null = null;
	for (const line of lines) {
		if (!line) continue;
		if (/^[0-9a-f]{40} \d+ \d+/.test(line)) {
			if (current) records.push(current);
			const parts = line.split(" ");
			current = {
				sha: parts[0],
				origLine: Number(parts[1]),
				finalLine: Number(parts[2]),
				author: "",
				authorMail: "",
				authorTime: null,
				authorTz: "",
				summary: "",
				content: "",
			};
			continue;
		}
		if (!current) continue;
		if (line.startsWith("\t")) {
			current.content = line.slice(1);
			continue;
		}
		const separator = line.indexOf(" ");
		if (separator === -1) continue;
		const key = line.slice(0, separator);
		const value = line.slice(separator + 1).trim();
		switch (key) {
			case "author":
				current.author = value;
				break;
			case "author-mail":
				current.authorMail = value.replace(/^<|>$/g, "");
				break;
			case "author-time": {
				const parsed = Number(value);
				current.authorTime = Number.isFinite(parsed) ? parsed : null;
				break;
			}
			case "author-tz":
				current.authorTz = value;
				break;
			case "summary":
				current.summary = value;
				break;
			case "filename":
				current.filename = value;
				break;
			default:
				break;
		}
	}
	if (current) records.push(current);
	return records;
}

function parseBranchList(output: string): GitBranchItem[] {
	const branches: GitBranchItem[] = [];
	const lines = String(output || "").split("\n");
	for (const line of lines) {
		if (!line) continue;
		const fields = line.split("\0");
		const name = String(fields[0] || "").trim();
		if (!name) continue;
		branches.push({
			name,
			upstream: fields[1] || null,
			committerDate: fields[2] || null,
			subject: fields[3] || "",
		});
	}
	return branches;
}

function parseStashList(output: string): GitStashItem[] {
	const stashes: GitStashItem[] = [];
	const parts = String(output || "").split("\x1e");
	for (const part of parts) {
		if (!part) continue;
		const fields = part.replace(/^\r?\n/, "").split("\x1f");
		const ref = String(fields[0] || "").trim();
		if (!ref) continue;
		stashes.push({ ref, message: fields[1] || "" });
	}
	return stashes;
}

async function getRepoRootOrThrow(cwd: string): Promise<string> {
	const root = await resolveRepoRoot(cwd);
	if (!root) {
		throw new Error(`Not a git repository: ${cwd}`);
	}
	return root;
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

export async function getGitStatus(cwd: string, options?: { path?: string }): Promise<GitStatusResult> {
	const root = await getRepoRootOrThrow(cwd);
	const gitArgs = ["status", "--porcelain=v1", "-b", "--untracked-files=all"];
	const rel = options?.path ? requireRepoPath(options.path) : null;
	if (rel) gitArgs.push("--", rel);
	const status = parseStatusPorcelain(await runGit(root, gitArgs));
	const totalChanges = status.staged.length + status.unstaged.length + status.untracked.length;
	return {
		ok: true,
		repo: root,
		workspace: cwd,
		branch: status.branch,
		upstream: status.upstream,
		ahead: status.ahead,
		behind: status.behind,
		gone: status.gone,
		staged: status.staged.slice(0, MAX_ENTRIES),
		unstaged: status.unstaged.slice(0, MAX_ENTRIES),
		untracked: status.untracked.slice(0, MAX_ENTRIES),
		conflicts: status.conflicts,
		truncated: totalChanges > MAX_ENTRIES,
	};
}

export async function getGitLog(options: GitLogOptions): Promise<GitLogResult> {
	const root = await getRepoRootOrThrow(options.cwd);
	const count = clampInt(options.count, 1, 100, 25);
	const gitArgs = ["log", "--no-color", "-n", String(count)];
	if (options.query) gitArgs.push("--grep", String(options.query), "-i");
	if (options.author) gitArgs.push("--author", String(options.author), "-i");
	gitArgs.push(`--format=${LOG_FORMAT}`);
	const rel = options.path ? requireRepoPath(options.path) : null;
	if (rel) gitArgs.push("--", rel);
	const records = parseLogRecords(await runGit(root, gitArgs));
	return { ok: true, repo: root, count: records.length, requested: count, commits: records };
}

export async function getGitShow(options: GitShowOptions): Promise<GitShowResult> {
	const root = await getRepoRootOrThrow(options.cwd);
	const ref = options.ref ? requireRef(options.ref, "ref") : "HEAD";
	const wantPatch = options.patch === true;
	const wantStat = options.stat !== false;
	const rel = options.path ? requireRepoPath(options.path) : null;

	const metaArgs = ["show", "--no-color", "--no-patch", `--format=${LOG_FORMAT}`, ref];
	const meta = parseLogRecords(await runGit(root, metaArgs))[0] || null;

	const nameArgs = ["show", "--no-color", "--format=", "--name-status", ref];
	if (rel) nameArgs.push("--", rel);
	const nameStatus = parseNameStatus(await runGit(root, nameArgs));

	let files = nameStatus;
	if (wantStat) {
		const numArgs = ["show", "--no-color", "--format=", "--numstat", ref];
		if (rel) numArgs.push("--", rel);
		files = mergeCounts(nameStatus, parseNumstat(await runGit(root, numArgs)));
	}

	let patch: string | null = null;
	if (wantPatch) {
		const patchArgs = ["show", "--no-color", "--format=", "--unified=3", ref];
		if (rel) patchArgs.push("--", rel);
		patch = truncateText(await runGit(root, patchArgs));
	}

	return { ok: true, repo: root, ref, commit: meta, files, patch };
}

export async function getGitDiff(options: GitDiffOptions): Promise<GitDiffResult> {
	const root = await getRepoRootOrThrow(options.cwd);
	const base = options.base ? requireRef(options.base, "base") : "HEAD";
	const target = options.target !== undefined && String(options.target) !== "" ? requireRef(options.target, "target") : null;
	const wantPatch = options.patch === true;
	const wantStat = options.stat !== false;
	const rel = options.path ? requireRepoPath(options.path) : null;
	const range = target ? [base, target] : [base];

	const nameArgs = ["diff", "--no-color", "--name-status", ...range];
	const numArgs = ["diff", "--no-color", "--numstat", ...range];
	if (rel) {
		nameArgs.push("--", rel);
		numArgs.push("--", rel);
	}
	const nameStatus = parseNameStatus(await runGit(root, nameArgs));
	const files = wantStat ? mergeCounts(nameStatus, parseNumstat(await runGit(root, numArgs))) : nameStatus;

	let patch: string | null = null;
	if (wantPatch) {
		const patchArgs = ["diff", "--no-color", "--unified=3", ...range];
		if (rel) patchArgs.push("--", rel);
		patch = truncateText(await runGit(root, patchArgs));
	}

	return { ok: true, repo: root, base, target, files, patch };
}

export async function getGitBlame(options: GitBlameOptions): Promise<GitBlameResult> {
	const root = await getRepoRootOrThrow(options.cwd);
	const rel = requireRepoPath(options.path);
	const startLine = clampInt(options.startLine, 1, 1_000_000_000, 0);
	const endLine = clampInt(options.endLine, 1, 1_000_000_000, 0);
	const limit = clampInt(options.limit, 1, 5000, 2000);

	const blameArgs = ["blame", "--line-porcelain"];
	if (startLine > 0) {
		blameArgs.push("-L", endLine > startLine ? `${startLine},${endLine}` : `${startLine},`);
	}
	blameArgs.push("--", rel);
	const records = parseBlameLinePorcelain(await runGit(root, blameArgs));
	const limited = records.slice(0, limit);
	return {
		ok: true,
		repo: root,
		path: rel,
		startLine: startLine > 0 ? startLine : 1,
		endLine: endLine > 0 ? endLine : records.length,
		lines: limited,
		totalLines: records.length,
		truncated: records.length > limit,
	};
}

export async function handleGitBranch(options: GitBranchOptions): Promise<GitBranchResult> {
	const root = await getRepoRootOrThrow(options.cwd);
	const action = String(options.action || "list");

	async function branchList() {
		const currentRaw = await runGit(root, ["symbolic-ref", "--short", "HEAD"]).catch(() => "");
		const list = parseBranchList(
			await runGit(root, [
				"for-each-ref",
				"refs/heads",
				"--format=%(refname:short)%00%(upstream:short)%00%(committerdate:iso8601)%00%(subject)",
			]),
		);
		return { branches: list, current: currentRaw.trim() || null };
	}

	switch (action) {
		case "list": {
			const { branches, current } = await branchList();
			return { ok: true, repo: root, action, current, count: branches.length, branches };
		}
		case "create": {
			const name = requireBranchName(options.name);
			const startPoint = options.startPoint ? requireRef(options.startPoint, "startPoint") : null;
			const gitArgs = ["branch"];
			if (options.force === true) gitArgs.push("--force");
			gitArgs.push(name);
			if (startPoint) gitArgs.push(startPoint);
			await runGit(root, gitArgs);
			const { branches } = await branchList();
			return { ok: true, repo: root, action, branch: name, message: `Created branch ${name}`, branches, current: null, count: branches.length };
		}
		case "switch": {
			const name = requireBranchName(options.name);
			await runGit(root, ["switch", name]);
			const { branches, current } = await branchList();
			return { ok: true, repo: root, action, branch: name, current, message: `Switched to branch ${name}`, branches, count: branches.length };
		}
		case "delete": {
			const name = requireBranchName(options.name);
			const gitArgs = ["branch", options.force === true ? "-D" : "-d", name];
			await runGit(root, gitArgs);
			const { branches, current } = await branchList();
			return { ok: true, repo: root, action, branch: name, current, message: `Deleted branch ${name}`, branches, count: branches.length };
		}
		default:
			throw new Error(`unknown git_branch action: ${action}`);
	}
}

export async function handleGitCommit(options: GitCommitOptions): Promise<{ ok: boolean; repo: string; sha: string; subject: string; message: string }> {
	const root = await getRepoRootOrThrow(options.cwd);
	const message = String(options.message ?? "").trim();
	if (!message) throw new Error("message is required for commit");
	if (message.length > 5000) throw new Error("message is too long (max 5000 characters)");
	const amend = options.amend === true;
	const stage = options.stage;

	if (stage === "all" || stage === undefined) {
		await runGit(root, ["add", "-A"]);
	} else if (stage === "tracked") {
		await runGit(root, ["add", "-u"]);
	} else if (Array.isArray(stage)) {
		if (stage.length === 0) throw new Error("stage array must not be empty");
		const paths = stage.map((item) => requireRepoPath(item));
		await runGit(root, ["add", "--", ...paths]);
	}

	const commitArgs = ["commit"];
	if (amend) commitArgs.push("--amend");
	commitArgs.push("-m", message);
	await runGit(root, commitArgs);

	const shortSha = String(await runGit(root, ["rev-parse", "--short", "HEAD"])).trim();
	const subject = String(await runGit(root, ["log", "-1", "--format=%s"])).trim();
	return {
		ok: true,
		repo: root,
		sha: shortSha,
		subject,
		message,
	};
}

export async function handleGitStash(options: GitStashOptions): Promise<GitStashResult> {
	const root = await getRepoRootOrThrow(options.cwd);
	const action = String(options.action || "list");
	const index = clampInt(options.index, 0, 10_000, 0);
	const stashRef = `stash@{${index}}`;

	async function stashListFor(): Promise<GitStashItem[]> {
		return parseStashList(await runGit(root, ["stash", "list", "--format=%gd%x1f%gs%x1e"]));
	}

	switch (action) {
		case "list": {
			const stashes = await stashListFor();
			return { ok: true, repo: root, action, count: stashes.length, stashes };
		}
		case "push": {
			const pushArgs = ["stash", "push"];
			if (options.includeUntracked === true) pushArgs.push("--include-untracked");
			const message = String(options.message ?? "").trim();
			if (message) pushArgs.push("-m", message);
			await runGit(root, pushArgs);
			const stashes = await stashListFor();
			return { ok: true, repo: root, action, count: stashes.length, stashes, message: "Stash created" };
		}
		case "pop": {
			await runGit(root, ["stash", "pop", stashRef]);
			const stashes = await stashListFor();
			return { ok: true, repo: root, action, count: stashes.length, stashes, message: `Applied and dropped ${stashRef}` };
		}
		case "apply": {
			await runGit(root, ["stash", "apply", stashRef]);
			const stashes = await stashListFor();
			return { ok: true, repo: root, action, count: stashes.length, stashes, message: `Applied ${stashRef}` };
		}
		case "drop": {
			await runGit(root, ["stash", "drop", stashRef]);
			const stashes = await stashListFor();
			return { ok: true, repo: root, action, count: stashes.length, stashes, message: `Dropped ${stashRef}` };
		}
		default:
			throw new Error(`unknown git_stash action: ${action}`);
	}
}

// ---------------------------------------------------------------------------
// Existing backward compatibility helpers
// ---------------------------------------------------------------------------

export function getGitBranch(cwd: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 3000 }, (error, stdout) => {
			if (error) resolve(null);
			else resolve(stdout.trim() || null);
		});
	});
}

export function listGitBranches(cwd: string): Promise<{ current: string | null; branches: string[] }> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
			{ cwd, timeout: 5000 },
			async (error, stdout) => {
				if (error) {
					resolve({ current: null, branches: [] });
					return;
				}
				const branches = stdout
					.split("\n")
					.map((b) => b.trim())
					.filter(Boolean);
				resolve({ current: await getGitBranch(cwd), branches });
			},
		);
	});
}

export function checkoutBranch(cwd: string, branch: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", ["checkout", branch], { cwd, timeout: 15000 }, async (error, _stdout, stderr) => {
			if (error) {
				reject(new Error(stderr?.trim() || error.message));
				return;
			}
			resolve((await getGitBranch(cwd)) ?? branch);
		});
	});
}
