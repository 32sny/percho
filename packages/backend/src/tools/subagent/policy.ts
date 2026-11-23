import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PermissionMode } from "@percho/shared";
import { collectBashCandidates, splitShellSegments } from "../../permissions/bash-chain";
import { patternMatchesToolCall } from "../../permissions/pattern";

export const READ_ONLY_GIT_COMMANDS = [
	"status",
	"diff",
	"log",
	"show",
	"blame",
	"rev-parse",
	"ls-files",
	"shortlog",
	"grep",
] as const;

export interface SubagentPolicy {
	agentDir: string;
	deny: readonly string[];
	permissionMode?: PermissionMode;
}

// 与权限模式键相同：工具名，或「工具名: 通配文本」。通配只支持 * / ?，其余为字面。
export function isDenyPattern(value: unknown): value is string {
	return typeof value === "string" && /^[\w-]+(?:: [^\r\n]+)?$/.test(value);
}

export function subagentPermissionMode(parent: PermissionMode, declared?: PermissionMode): PermissionMode {
	return parent === "default" ? "default" : (declared ?? "fullAccess");
}

function normalizeForPlatform(value: string): string {
	const slashNormalized = value.replace(/\\/g, "/");
	return process.platform === "win32" ? slashNormalized.toLowerCase() : slashNormalized;
}

/** 只透传后续命令的前缀程序：`env git push` / `command git push` 必须按 git 判定。 */
const COMMAND_PREFIXES = new Set(["env", "command", "nohup", "nice", "time", "exec", "stdbuf", "timeout"]);

/**
 * 只读子命令自带的写文件 / 执行外部程序出口：--output 写任意文件，grep -O / --open-files-in-pager
 * 启动任意程序，--ext-diff / --textconv 执行配置里的外部命令。--no-ext-diff 等反向开关不在此列。
 */
const GIT_ESCAPE_OPTION = /^(?:--output(?:=|$)|-O|--open-files-in-pager(?:=|$)|--ext-diff$|--textconv$)/;

/** 候选已包含命令链、shell -c 载荷和命令替换；这里只解析程序与紧随的子命令。 */
export function forbiddenGitCommand(command: string): string | undefined {
	for (const candidate of collectBashCandidates(command).flatMap(splitShellSegments)) {
		const tokens =
			candidate
				.match(/(?:[^\s"'\\]|\\.|"[^"]*"|'[^']*')+/g)
				?.map((token) => token.replace(/\\(.)/g, "$1").replace(/["']/g, "")) ?? [];
		// 剥环境赋值与透传前缀（连同前缀自身的选项，如 env -i / timeout 10）；
		// GIT_* 环境可换外部 diff / pager / 配置，等同全局 -c 注入。
		let gitEnv = false;
		for (;;) {
			const head = tokens[0] ?? "";
			if (/^\w+=/u.test(head)) {
				if (/^GIT_/iu.test(head)) gitEnv = true;
				tokens.shift();
			} else if (COMMAND_PREFIXES.has(basename(head).toLowerCase())) {
				tokens.shift();
				while (/^-|^\d/.test(tokens[0] ?? "")) tokens.shift();
			} else break;
		}
		const prog = basename(tokens[0] ?? "").toLowerCase();
		if (prog !== "git" && prog !== "git.exe") continue;
		if (gitEnv) return candidate;
		// 全局选项只出现在子命令之前（-C / -c / --git-dir 等一律拒）；子命令之后的 -C / -c
		// 是 grep / log 的上下文、计数参数，不是注入。
		const subIndex = tokens.findIndex((token, i) => i > 0 && !token.startsWith("-"));
		if (subIndex !== 1) return candidate;
		const subcommand = tokens[1];
		if (!READ_ONLY_GIT_COMMANDS.some((name) => name === subcommand)) return candidate;
		if (tokens.slice(2).some((token) => GIT_ESCAPE_OPTION.test(token))) return candidate;
	}
	return undefined;
}

/**
 * bash 文本是否指向 agentDir：绝对路径（正反斜杠 / 大小写归一）与 `~`、`$HOME`、`%USERPROFILE%` 写法。
 * 不再单凭文件名（auth.json 等）判定——那会误伤项目里同名的普通文件。
 */
function mentionsAgentDir(agentDir: string, text: string): boolean {
	const normText = normalizeForPlatform(text).toLowerCase();
	const root = normalizeForPlatform(resolve(agentDir)).toLowerCase();
	const home = normalizeForPlatform(homedir()).toLowerCase();
	const forms = [root];
	if (root.startsWith(`${home}/`)) {
		const rel = root.slice(home.length);
		forms.push(`~${rel}`, `$home${rel}`, `\${home}${rel}`, `%userprofile%${rel}`);
	}
	return forms.some((form) => normText.includes(form));
}

/** 工具调用边界；SDK 自身持久化不经过这里。bash 的目录保护刻意只做文本匹配（Windows 归一化斜杠与大小写）。 */
export function subagentBoundaryViolation(
	policy: SubagentPolicy,
	tool: string,
	text: string | null,
	cwd: string,
): string | undefined {
	const deny = policy.deny.find((pattern) => patternMatchesToolCall(pattern, tool, text));
	if (deny) return `deny: ${deny}`;
	if (tool === "bash" && text) {
		const git = forbiddenGitCommand(text);
		if (git) return `git: ${git}`;
		if (mentionsAgentDir(policy.agentDir, text)) return "Percho state is read-only (bash text match)";
	}
	// read 同样拦：agentDir 内有凭证（auth.json）与其他会话转录，子代理没有读取它们的正当理由
	if ((tool === "edit" || tool === "write" || tool === "read") && text) {
		// SDK 工具支持 @、~、file URL 与 Unicode 空格；在同样的字面路径上判定，避免前缀被包装绕过。
		let normalized = text.replace(/^@/, "").replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
		if (normalized === "~") normalized = homedir();
		else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\")))
			normalized = join(homedir(), normalized.slice(2));
		if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
		const path = resolve(cwd, normalized);
		const root = resolve(policy.agentDir);
		const cmpPath = process.platform === "win32" ? path.toLowerCase() : path;
		const cmpRoot = process.platform === "win32" ? root.toLowerCase() : root;
		const cmpSep = sep;
		if (cmpPath === cmpRoot || cmpPath.startsWith(cmpRoot + cmpSep)) return "Percho state is read-only";
	}
	return undefined;
}
