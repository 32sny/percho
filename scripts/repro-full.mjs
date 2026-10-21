// 完整复现：console hook + 探针读取 + 全量回放（gap 8ms）
import { execSync } from "node:child_process";

let wsUrl;
try {
	wsUrl = execSync(
		`curl -s http://127.0.0.1:9224/json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.find(x=>x.type==='page').webSocketDebuggerUrl)})"`,
	)
		.toString()
		.trim();
	if (!wsUrl) throw new Error("dev 实例未运行或未开 --remote-debugging-port=9224");
} catch (err) {
	console.error("[repro-full] 拿不到 CDP 页面地址：", err.message);
	process.exit(1);
}
const { WebSocket } = await import("ws");
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const consoleErrs = [];
ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return; // 非 JSON 帧（保留字节数据时不常见，忽略即可）
	}
	if (m.id && pending.has(m.id)) {
		pending.get(m.id)(m);
		pending.delete(m.id);
		return;
	}
	if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) {
		consoleErrs.push(
			`${m.params.type}: ${m.params.args
				.map((a) => a.description ?? a.value ?? "")
				.join(" ")
				.slice(0, 400)}`,
		);
	}
});
await new Promise((r) => ws.on("open", r));
const send = (method, params = {}) =>
	new Promise((res) => {
		const mid = ++id;
		pending.set(mid, res);
		ws.send(JSON.stringify({ id: mid, method, params }));
	});
await send("Runtime.enable");
let payload;
try {
	payload = JSON.parse(
		(await import("node:fs")).readFileSync(process.argv[2] || "/tmp/replay-A.json", "utf8"),
	);
} catch (err) {
	console.error("[repro-full] 回放文件读取/解析失败：", err.message);
	process.exit(1);
}
console.log(`全量回放 ${payload.length} 条 @8ms ≈ ${((payload.length * 8) / 1000).toFixed(0)}s …`);
await send("Runtime.evaluate", {
	expression: `window.__injectEvents("01a033f8-ba6a-78ab-99cb-c91b1fa6790e", ${JSON.stringify(payload)}, 8)`,
	awaitPromise: false,
});
const t0 = Date.now();
while (Date.now() - t0 < payload.length * 8 + 45000) {
	await new Promise((r) => setTimeout(r, 3000));
	const st = await send("Runtime.evaluate", {
		expression:
			"({m:(window.__mLog||[]).length, done:window.__injectDone===true, blank:document.body.innerText.length===0})",
		returnByValue: true,
	});
	const v = st.result?.result?.value;
	process.stdout.write(
		`  [${Math.round((Date.now() - t0) / 1000)}s] mLog=${v?.m} done=${v?.done} blank=${v?.blank}\n`,
	);
	if (v?.done && Date.now() - t0 > payload.length * 8 + 35000) break;
}
const out = await send("Runtime.evaluate", {
	expression:
		"JSON.stringify({mLogHead:(window.__mLog||[]).slice(0,30), mLogLen:(window.__mLog||[]).length, mLogTail:(window.__mLog||[]).slice(-15)})",
	returnByValue: true,
	awaitPromise: true,
});
console.log("=== measure 震荡记录 ===");
console.log(out.result?.result?.value);
console.log("=== console error/warn（前 12）===");
for (const e of consoleErrs.slice(0, 12)) console.log(" ", e.slice(0, 200));
ws.close();
process.exit(0);
