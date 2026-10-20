import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moveSessionFile, sessionDirForCwd } from "../src/session/move-session";

/**
 * 阶段 0 红测（spec PLAN-session-move-project §六）：会话跨项目移动的文件层契约。
 *
 * moveSessionFile = 「文件搬家 + 头部 cwd 改写」的纯函数核心（PiBackend.moveSession 只在其上
 * 叠加活跃会话 dispose / meta 返回）。fail-closed：任一步失败源文件必须原封不动。
 *
 * 通过 PI_CODING_AGENT_DIR 把 agent 目录重定向到临时目录，编码规则与 SDK 的兼容性用
 * SessionManager.list(targetCwd) 反证（未导出的 getDefaultSessionDirPath 不允许复刻漂移）。
 */

const SESSION_ID = "01a076c2-b8b4-771d-aa02-22c81f40dea2";
const CREATED_ISO = "2020-01-01T00:00:00.000Z";

let agentDir: string;
let sourceProject: string;
let targetProject: string;

function writeSessionFile(cwd: string, dir: string): string {
	const file = join(dir, `2026-09-22T00-00-00-000Z_${SESSION_ID}.jsonl`);
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: CREATED_ISO, cwd }),
		JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2021-03-04T05:06:07.000Z",
			message: { role: "user", content: "hi", timestamp: Date.parse("2021-03-04T05:06:07.000Z") },
		}),
	];
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "move-session-agent-"));
	sourceProject = mkdtempSync(join(tmpdir(), "move-session-src-"));
	targetProject = mkdtempSync(join(tmpdir(), "move-session-dst-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(sourceProject, { recursive: true, force: true });
	rmSync(targetProject, { recursive: true, force: true });
});

describe("moveSessionFile · 成功路径", () => {
	it("目标编码目录出现同名文件、源文件消失、首行 cwd 改写为 targetCwd、其余 entry 原样", async () => {
		const source = writeSessionFile(sourceProject, sourceProject);

		const moved = await moveSessionFile(source, targetProject);

		const expectedDir = sessionDirForCwd(targetProject);
		const expectedFile = join(expectedDir, `2026-09-22T00-00-00-000Z_${SESSION_ID}.jsonl`);
		expect(moved).toBe(expectedFile);
		expect(existsSync(expectedFile)).toBe(true);
		expect(existsSync(source)).toBe(false);

		const lines = readFileSync(expectedFile, "utf8").trimEnd().split("\n");
		const header = JSON.parse(lines[0]) as { type: string; id: string; cwd: string };
		expect(header.type).toBe("session");
		expect(header.id).toBe(SESSION_ID);
		expect(header.cwd).toBe(targetProject);
		// 消息 entry 原样保留
		expect(JSON.parse(lines[1])).toMatchObject({ type: "message", id: "m1" });
	});

	it("移动结果可被 SessionManager.list(targetCwd) 枚举（编码规则与 SDK 一致，cwd 过滤命中）", async () => {
		const source = writeSessionFile(sourceProject, sourceProject);

		await moveSessionFile(source, targetProject);

		const infos = await SessionManager.list(targetProject);
		const info = infos.find((item) => item.id === SESSION_ID);
		expect(info).toBeDefined();
		expect(info?.cwd).toBe(targetProject);
		// 旧项目枚举不到（文件已搬走）
		const oldInfos = await SessionManager.list(sourceProject);
		expect(oldInfos.find((item) => item.id === SESSION_ID)).toBeUndefined();
	});
});

describe("moveSessionFile · fail-closed", () => {
	it("源文件不存在 → reject", async () => {
		const missing = join(sourceProject, "no-such-session.jsonl");
		await expect(moveSessionFile(missing, targetProject)).rejects.toThrow();
	});

	it("targetCwd 不是存在的目录 → reject 且源文件原封不动", async () => {
		const source = writeSessionFile(sourceProject, sourceProject);
		const before = readFileSync(source, "utf8");

		await expect(moveSessionFile(source, join(targetProject, "not-exist"))).rejects.toThrow();

		expect(existsSync(source)).toBe(true);
		expect(readFileSync(source, "utf8")).toBe(before);
	});

	it("目标同名文件已存在 → reject 且不覆盖既有文件", async () => {
		const source = writeSessionFile(sourceProject, sourceProject);
		const targetDir = sessionDirForCwd(targetProject);
		mkdirSync(targetDir, { recursive: true });
		const existing = join(targetDir, `2026-09-22T00-00-00-000Z_${SESSION_ID}.jsonl`);
		writeFileSync(existing, "EXISTING-CONTENT\n");

		await expect(moveSessionFile(source, targetProject)).rejects.toThrow();

		expect(readFileSync(existing, "utf8")).toBe("EXISTING-CONTENT\n");
		expect(existsSync(source)).toBe(true);
	});

	it("首行不是 session header（坏文件）→ reject 且源文件原封不动", async () => {
		const source = join(sourceProject, "bad.jsonl");
		writeFileSync(source, "not-json-at-all\n");

		await expect(moveSessionFile(source, targetProject)).rejects.toThrow();
		expect(existsSync(source)).toBe(true);
		expect(readFileSync(source, "utf8")).toBe("not-json-at-all\n");
	});
});
