#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const usage = `用法：
  node scripts/recover-session-subagent-relations.mjs --agent-dir <目录> --parent <父文件> [--parent <父文件> ...] [--report <新报告文件>]
  node scripts/recover-session-subagent-relations.mjs --agent-dir <目录> --apply <已审查报告> --confirm-host-closed
  node scripts/recover-session-subagent-relations.mjs --agent-dir <目录> --rollback --parent <父文件> --backup <备份> --applied-hash <sha256> --confirm-host-closed

默认只读 dry-run，不修改任何会话。报告写入只允许新文件。
apply / rollback 会修改历史，必须先审查清单、另获用户批准，并关闭该目录的全部 Percho/CLI 宿主。
--confirm-host-closed 仅是操作者确认，不代表工具能阻止外部进程同时写入。
备份和回滚清单保留在父文件同目录；回滚会校验备份完整性及修复后原文件 hash。`;

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		console.log(usage);
		return;
	}
	const flags = new Set(["--rollback", "--confirm-host-closed"]);
	const fields = new Set(["--agent-dir", "--parent", "--report", "--apply", "--backup", "--applied-hash"]);
	const values = new Map(),
		parents = [];
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (flags.has(flag)) {
			values.set(flag, true);
			continue;
		}
		if (!fields.has(flag) || !args[i + 1] || args[i + 1].startsWith("--"))
			throw new Error(`无效参数：${flag}`);
		const value = args[++i];
		if (flag === "--parent") parents.push(resolve(value));
		else {
			if (values.has(flag)) throw new Error(`重复参数：${flag}`);
			values.set(flag, value);
		}
	}
	if (!values.has("--agent-dir")) throw new Error("必须显式指定 --agent-dir");
	if (values.has("--apply") && values.has("--rollback")) throw new Error("apply 与 rollback 互斥");
	const agentDir = resolve(values.get("--agent-dir")),
		confirmed = values.has("--confirm-host-closed");
	if ((values.has("--apply") || values.has("--rollback")) && !confirmed)
		throw new Error("写入前必须确认 --confirm-host-closed");
	if (!values.has("--apply") && !parents.length) throw new Error("至少需要一个 --parent");
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const temp = await mkdtemp(resolve(root, ".percho-recovery-"));
	try {
		const output = resolve(temp, "recovery.mjs");
		await build({
			entryPoints: [resolve(root, "packages/backend/src/session/subagent-relation-recovery.ts")],
			outfile: output,
			bundle: true,
			platform: "node",
			format: "esm",
			external: ["@earendil-works/*"],
			logLevel: "silent",
			nodePaths: [resolve(root, "node_modules")],
		});
		const api = await import(pathToFileURL(output).href);
		if (values.has("--rollback")) {
			if (parents.length !== 1 || !values.has("--backup") || !values.has("--applied-hash"))
				throw new Error("rollback 需要唯一父文件、备份和 applied-hash");
			await api.rollbackRecovery(parents[0], resolve(values.get("--backup")), values.get("--applied-hash"), {
				agentDir,
				confirmed,
			});
			console.log(JSON.stringify({ mode: "rollback", status: "restored", parent: parents[0] }, null, 2));
		} else if (values.has("--apply")) {
			const reviewed = JSON.parse(await readFile(resolve(values.get("--apply")), "utf8"));
			const results = await api.applyRecoveryReport(
				reviewed,
				{ parentFiles: reviewed.parents.map((p) => p.parentFile), agentDir },
				confirmed,
			);
			console.log(JSON.stringify({ mode: "apply", results }, null, 2));
			if (results.some((r) => r.status === "failed" || r.status === "rejected")) process.exitCode = 1;
		} else {
			const report = await api.createRecoveryReport({ parentFiles: parents, agentDir });
			const reportPath = values.has("--report") ? resolve(values.get("--report")) : undefined;
			if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
			console.log(JSON.stringify({ mode: "dry-run", reportPath, report }, null, 2));
		}
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}
main().catch((error) => {
	console.error(String(error));
	process.exitCode = 1;
});
