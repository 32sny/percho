/** 生成 Release Notes 骨架（版式真源见 docs/release-notes.md）。
 * 只打印到 stdout，不写文件、不碰 git 状态；版本号与 compare 链接自动填好，
 * 人只需补各小节内容。用法：
 *   node scripts/release-notes.mjs              # 版本取 package.json，起点取最近 tag
 *   node scripts/release-notes.mjs --from v0.7.2
 * 退出码 1 = 参数或 git 查询失败（不猜版本，不输出半成品）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	} catch (error) {
		console.error(`git ${args.join(" ")} 失败：${error.message}`);
		process.exit(1);
	}
}

const args = process.argv.slice(2);
const fromIndex = args.indexOf("--from");
const rawFrom = fromIndex >= 0 ? args[fromIndex + 1] : undefined;
if (fromIndex >= 0 && (!rawFrom || rawFrom.startsWith("--"))) {
	console.error("--from 需要一个 tag，例如 --from v0.7.3");
	process.exit(1);
}

function readVersion() {
	try {
		return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
	} catch (error) {
		console.error(`读取根 package.json 版本失败：${error.message}`);
		process.exit(1);
	}
}

const version = readVersion();
const tag = `v${version}`;
// 起点默认取「当前版本之前的最近 tag」：当前 tag 已存在时取它自身，避免 compare 变成空区间。
const latest = rawFrom ?? git(["describe", "--tags", "--abbrev=0", `${tag}^`]);
const from = latest.replace(/^v/, "");
const to = version;

const notes = `## What's Changed in v${to}

### <主题一：一句话说清用户能感知的变化>

<!-- 每条先讲用户场景，再讲能力。状态、边界、失败表现要说实话，不承诺未验证的行为。 -->

-
-

### <主题二：按需增删，没有就删掉整节>

-

### 修复

-

### 验证

<!-- 只写真实跑过的：全量测试文件/用例数、类型检查、实机验收、Release 三平台结果。 -->

- 全量测试：
- 类型检查：
- 实机验收：
- Release workflow：

### 已知限制

<!-- 有就说，没有删掉整节。不把「未验证」写成「无问题」。 -->

-

### Downloads

| Platform | Download |
| --- | --- |
| macOS (Apple Silicon) | percho-mac-arm64.dmg |
| macOS (Intel) | percho-mac-x64.dmg |
| Windows | percho-windows-x64.exe |
| Windows (zip) | percho-windows-x64.zip |
| Linux (x64) | percho-linux-x86_64.AppImage |

> macOS 为 Ad-hoc 签名，Gatekeeper 拦截时右键 →「打开」。Windows/Linux 支持应用内自动更新。

**Full Changelog**: https://github.com/32sny/percho/compare/v${from}...v${to}
`;

process.stdout.write(notes);
