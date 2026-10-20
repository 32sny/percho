import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * 会话跨项目移动的文件层核心（spec PLAN-session-move-project §三）：
 * 「文件搬家 + 头部 cwd 改写」。PiBackend.moveSession 只在其上叠加活跃会话
 * dispose 与 meta 返回；本模块保持纯函数语义 —— fail-closed，任一步失败
 * 源文件原封不动，绝不产生半搬状态。
 */

/**
 * cwd → 会话编码目录（`<agentDir>/sessions/--C--...-Percho--`）。
 * SDK 的 getDefaultSessionDirPath 未从包根导出，此处按 session-manager.js 的
 * 规则复刻；兼容性由 move-session.test.ts 的 SessionManager.list 反证固定，
 * 若 SDK 改编码规则该测试会红。
 */
export function sessionDirForCwd(cwd: string, agentDir = getAgentDir()): string {
	const safePath = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolve(agentDir), "sessions", safePath);
}

/**
 * 把会话 jsonl 搬到 targetCwd 的会话目录，并把首行 session header 的 cwd 改写为 targetCwd。
 * 返回新文件路径。sessionId / 文件名不变（置顶等按 sessionId 记录的状态无损保留）。
 *
 * 步骤：校验源与目标 → 内存中改写 header → 目标目录 mkdir → 同名冲突拒绝 →
 * 同目录 tmp 写入 + rename 原子落位 → 删源。第 5 步之前源文件只读不写。
 */
export async function moveSessionFile(sourceFile: string, targetCwd: string): Promise<string> {
	const source = resolve(sourceFile);
	if (!existsSync(source) || !statSync(source).isFile()) {
		throw new Error(`Session file not found: ${sourceFile}`);
	}
	const target = resolve(targetCwd);
	if (!existsSync(target) || !statSync(target).isDirectory()) {
		throw new Error(`Target project directory not found: ${targetCwd}`);
	}

	// header 改写在内存中完成：解析失败/非 session header 都在这里抛，源文件未动
	const content = readFileSync(source, "utf8");
	const newlineAt = content.indexOf("\n");
	const firstLine = newlineAt === -1 ? content : content.slice(0, newlineAt);
	const rest = newlineAt === -1 ? "" : content.slice(newlineAt + 1);
	let header: Record<string, unknown>;
	try {
		header = JSON.parse(firstLine) as Record<string, unknown>;
	} catch {
		throw new Error(`Session file header is not valid JSON: ${source}`);
	}
	if (header?.type !== "session") {
		throw new Error(`Session file does not start with a session header: ${source}`);
	}
	header.cwd = target;
	const newContent = `${JSON.stringify(header)}\n${rest}`;

	const targetDir = sessionDirForCwd(target);
	mkdirSync(targetDir, { recursive: true });
	const targetFile = join(targetDir, basename(source));
	if (existsSync(targetFile)) {
		throw new Error(`Session file already exists in target project: ${targetFile}`);
	}

	// tmp 与目标同目录 → rename 恒同盘，原子无跨设备问题
	const tmpFile = `${targetFile}.tmp-${process.pid}`;
	writeFileSync(tmpFile, newContent);
	try {
		renameSync(tmpFile, targetFile);
	} catch (error) {
		try {
			unlinkSync(tmpFile);
		} catch {
			// tmp 清理失败不影响主错误
		}
		throw error;
	}
	unlinkSync(source);
	return targetFile;
}
