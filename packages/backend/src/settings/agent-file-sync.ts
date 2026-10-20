import { readFile, writeFile } from "node:fs/promises";
import { discoverAgents } from "../tools/subagent/agents";

/** 可同步的 frontmatter 字段（本期仅 model / thinking，函数保持通用）。 */
export type FrontmatterField = "model" | "thinking";

/**
 * 解析 frontmatter 标量值：去行内注释、trim、去引号。
 * 与 tools/subagent/agents.ts 的解析侧（stripInlineComment + parseScalar）语义对齐，
 * 保证「值相同」判定与读取方一致；不导出解析侧以免扩散 agents.ts 的公共面。
 */
function parseFrontmatterScalar(raw: string): string {
	let quote: string | undefined;
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const char = raw[i] ?? "";
		if ((char === '"' || char === "'") && raw[i - 1] !== "\\") {
			quote = quote === char ? undefined : (quote ?? char);
			continue;
		}
		if (char === "#" && !quote && (i === 0 || /\s/.test(raw[i - 1] ?? ""))) break;
		out += char;
	}
	let clean = out.trim();
	if (
		(clean.startsWith('"') && clean.endsWith('"') && clean.length >= 2) ||
		(clean.startsWith("'") && clean.endsWith("'") && clean.length >= 2)
	) {
		clean = clean.slice(1, -1).trim();
	}
	return clean;
}

/**
 * 纯函数：改写 markdown frontmatter 中的顶层 `field:` 行。
 *
 * 规则（spec 契约）：
 * - 首行不是 `---` 或无闭合 `---` → 返回 null（非合法 agent 文件，调用方跳过）；
 * - 顶层命中且值不同 → 整行替换为 `field: <value>`（旧行含行内注释时整体丢弃）；
 * - 顶层命中且值相同 → 返回 null（幂等，避免无谓写盘）；
 * - 未命中且 value 非 null → 在闭合 `---` 之前插入 `field: <value>`；
 * - value = null → 删除该行（无行则返回 null）；
 * - 只动目标行，其余内容逐字保留；按原文件主导换行符重组（CRLF 文件保持 CRLF）。
 *
 * @returns 改写后的完整文件内容；无需改动时返回 null。
 */
export function applyFrontmatterField(
	content: string,
	field: FrontmatterField,
	value: string | null,
): string | null {
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return null;
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end < 0) return null;

	const fieldPattern = new RegExp(`^${field}\\s*:(.*)$`);
	const lineIndex = lines.slice(1, end).findIndex((line) => fieldPattern.test(line));
	const target = lineIndex < 0 ? undefined : lineIndex + 1;

	if (value === null) {
		if (target === undefined) return null;
		lines.splice(target, 1);
		return lines.join(eol);
	}

	const formatted = `${field}: ${value}`;
	if (target === undefined) {
		lines.splice(end, 0, formatted);
		return lines.join(eol);
	}
	const match = lines[target]?.match(fieldPattern);
	if (match && parseFrontmatterScalar(match[1] ?? "") === value) return null;
	lines[target] = formatted;
	return lines.join(eol);
}

export interface SyncAgentFileResult {
	/** true = 文件已处于目标状态（含本次写入与本来就一致两种情况） */
	synced: boolean;
	/** synced=false 时的原因；synced=true 且未写盘时为 "unchanged" */
	reason?: "no-user-file" | "unchanged";
}

/**
 * 把对应用户级 agent `.md` 的 frontmatter 字段同步为指定值。
 *
 * - 仅 `source === "user"` 且有 `path` 的 agent 会写盘；builtin/project 一律返回
 *   `{ synced: false, reason: "no-user-file" }`（防 trusted 项目文件被反向污染）；
 * - 读原文 → 纯函数改写 → 非 null 才整体写回（幂等值不写盘，避免 mtime 抖动）；
 * - IO 异常向上抛，由调用方（pi-backend hook）捕获降级为日志告警。
 */
export async function syncAgentFileField(
	agentDir: string,
	agentName: string,
	field: FrontmatterField,
	value: string | null,
): Promise<SyncAgentFileResult> {
	// discoverAgents 首参 cwd 仅用于 project agents；projectTrusted=false 时无副作用
	const agents = await discoverAgents(agentDir, { projectTrusted: false, agentDir });
	const agent = agents.find((candidate) => candidate.name === agentName);
	if (agent?.source !== "user" || !agent.path) {
		return { synced: false, reason: "no-user-file" };
	}
	const content = await readFile(agent.path, "utf8");
	const updated = applyFrontmatterField(content, field, value);
	if (updated === null) return { synced: true, reason: "unchanged" };
	await writeFile(agent.path, updated, "utf8");
	return { synced: true };
}
