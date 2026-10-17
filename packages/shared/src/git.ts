/**
 * Git Lens & Git operations shared types.
 */

export interface GitStatusEntry {
	x: string;
	y: string;
	path: string;
	origPath: string | null;
}

export interface GitStatusResult {
	ok: boolean;
	repo: string;
	workspace: string;
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	gone: boolean;
	staged: GitStatusEntry[];
	unstaged: GitStatusEntry[];
	untracked: GitStatusEntry[];
	conflicts: GitStatusEntry[];
	truncated: boolean;
}

export interface GitCommitRecord {
	sha: string;
	shortSha: string;
	author: string;
	authorEmail: string;
	authorDate: string;
	committerDate: string;
	refs: string | null;
	subject: string;
	body: string;
}

export interface GitLogResult {
	ok: boolean;
	repo: string;
	count: number;
	requested: number;
	commits: GitCommitRecord[];
}

export interface GitFileChange {
	status: string;
	score: number | null;
	path: string;
	origPath: string | null;
	additions?: number | null;
	deletions?: number | null;
	binary?: boolean;
}

export interface GitShowResult {
	ok: boolean;
	repo: string;
	ref: string;
	commit: GitCommitRecord | null;
	files: GitFileChange[];
	patch: string | null;
}

export interface GitDiffResult {
	ok: boolean;
	repo: string;
	base: string;
	target: string | null;
	files: GitFileChange[];
	patch: string | null;
}

export interface GitBlameLine {
	sha: string;
	origLine: number;
	finalLine: number;
	author: string;
	authorMail: string;
	authorTime: number | null;
	authorTz: string;
	summary: string;
	content: string;
	filename?: string;
}

export interface GitBlameResult {
	ok: boolean;
	repo: string;
	path: string;
	startLine: number;
	endLine: number;
	lines: GitBlameLine[];
	totalLines: number;
	truncated: boolean;
}

export interface GitBranchItem {
	name: string;
	upstream: string | null;
	committerDate: string | null;
	subject: string;
}

export interface GitBranchResult {
	ok: boolean;
	repo: string;
	action: string;
	current: string | null;
	count: number;
	branches: GitBranchItem[];
	branch?: string;
	message?: string;
}

export interface GitStashItem {
	ref: string;
	message: string;
}

export interface GitStashResult {
	ok: boolean;
	repo: string;
	action: string;
	count: number;
	stashes: GitStashItem[];
	message?: string;
}

export interface GitLogOptions {
	cwd: string;
	count?: number;
	query?: string;
	author?: string;
	path?: string;
}

export interface GitShowOptions {
	cwd: string;
	ref?: string;
	patch?: boolean;
	stat?: boolean;
	path?: string;
}

export interface GitDiffOptions {
	cwd: string;
	base?: string;
	target?: string;
	patch?: boolean;
	stat?: boolean;
	path?: string;
}

export interface GitBlameOptions {
	cwd: string;
	path: string;
	startLine?: number;
	endLine?: number;
	limit?: number;
}

export interface GitBranchOptions {
	cwd: string;
	action?: "list" | "create" | "switch" | "delete";
	name?: string;
	startPoint?: string;
	force?: boolean;
}

export interface GitCommitOptions {
	cwd: string;
	message: string;
	amend?: boolean;
	stage?: "all" | "tracked" | string[];
}

export interface GitStashOptions {
	cwd: string;
	action?: "list" | "push" | "pop" | "apply" | "drop";
	index?: number;
	message?: string;
	includeUntracked?: boolean;
}
