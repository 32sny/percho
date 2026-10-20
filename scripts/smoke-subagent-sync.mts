// 阶段 0 冒烟（subagent-model-sync）：验证 spec「待验证」三项事实。
// 只读操作（read/access），不写任何文件；需要真实 ~/.pi/agent/agents 下存在 fixer.md。
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const { discoverAgents } = await import("../packages/backend/src/tools/subagent/agents.ts");

// T1：discoverAgents 发现 fixer，source=user、path 绝对路径、可写
const agents = await discoverAgents(homedir(), { projectTrusted: false });
const fixer = agents.find((a) => a.name === "fixer");
if (!fixer) throw new Error(`T1 FAIL: fixer not found; found: ${agents.map((a) => a.name).join(", ")}`);
if (fixer.source !== "user") throw new Error(`T1 FAIL: fixer.source = ${fixer.source}, expected "user"`);
if (!fixer.path || !isAbsolute(fixer.path)) throw new Error(`T1 FAIL: fixer.path not absolute: ${fixer.path}`);
await access(fixer.path); // 存在性 + 读权限
try {
	await access(fixer.path, 0o2); // W_OK
} catch {
	throw new Error(`T1 FAIL: fixer.path not writable: ${fixer.path}`);
}
console.log(`T1 PASS: fixer source=user path=${fixer.path} model=${fixer.model ?? "(none)"}`);

// T2：生产代码仅 pi-backend.ts 一处实例化（grep 由执行方完成，此处复核 test 外无其他 import 实例化）
const { execFileSync } = await import("node:child_process");
const grepOut = execFileSync(
	"grep",
	["-rn", "new ModelPrefsService", "packages/", "--include=*.ts"],
	{ cwd: join(process.cwd()), encoding: "utf8" },
);
const hits = grepOut.split("\n").filter((l) => l && !l.includes("/test/") && !l.includes("\\test\\"));
if (hits.length !== 1 || !hits[0]!.includes("pi-backend.ts")) {
	throw new Error(`T2 FAIL: unexpected production instantiation sites:\n${hits.join("\n")}`);
}
console.log(`T2 PASS: production instantiation only at ${hits[0]!.trim()}`);

// T3：model-prefs 相关测试文件清单与构造形态（结论供 IMPL-NOTES 决策用，仅输出）
const { readdir, readFile } = await import("node:fs/promises");
const testDir = join(process.cwd(), "packages", "backend", "test");
const testFiles = (await readdir(testDir)).filter((f) => f.includes("model-prefs"));
for (const f of testFiles) {
	const content = await readFile(join(testDir, f), "utf8");
	const ctorCount = (content.match(/new ModelPrefsService\(/g) ?? []).length;
	console.log(`T3 INFO: ${f} — ${ctorCount} 处 new ModelPrefsService`);
}
console.log("SMOKE OK");
