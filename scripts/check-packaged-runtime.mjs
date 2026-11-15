#!/usr/bin/env node
/**
 * 打包产物运行时验收（三平台 CI 与本地 G6 包共用）。
 *
 * 验的是 electron-builder --dir 的**真实目录包**：直接启动包内 exe（app.isPackaged=true），
 * 不包 wrapper、不伪造 app.isPackaged、不注入 NODE_OPTIONS 钩子。
 *
 * 用法：
 *   node scripts/check-packaged-runtime.mjs
 *   node scripts/check-packaged-runtime.mjs --exe <包内可执行文件> --output <证据目录>
 *
 * 默认从 packages/desktop/dist 定位当前平台目录包；--exe 用于验收本机已有包（如 G6）。
 * Linux 需要 X 显示：CI 用 `xvfb-run -a node scripts/check-packaged-runtime.mjs`。
 *
 * 退出码：0 全绿 / 1 检查失败 / 2 环境不支持或被权限弹窗阻塞（不重试、不循环）。
 *
 * 边界：隔离目录只建在 os.tmpdir()；不复制正式凭证；只读 IPC（listModels/listAllSessions），
 * 不发送 prompt、不触发 provider 请求；证据只落限定字段，不 dump 完整窗口/环境配置。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEADLINE_MS = 60_000;
const READY_MS = 30_000;
const REQUIRED_API = ["platform", "getPathForFile", "listModels", "listAllSessions", "confirmQuit"];
const REQUIRED_RESOURCES = [
	"pi-package/docs",
	"pi-package/examples",
	"pi-package/README.md",
	"pi-package/CHANGELOG.md",
	"pi-package/package.json",
	"pi-package/dist/core/export-html",
	"pi-package/dist/modes/interactive/theme",
	"pi-package/dist/modes/interactive/assets",
	"ui-plugins",
	"skills",
	"update-diagnostics",
];
const PERMISSION_HINT = /权限|permission|屏幕录制|辅助功能|无法打开|已损坏|Gatekeeper|SmartScreen|allow/i;
// 只保留 OS 运行所需变量；provider key、cloud 凭证、NODE_OPTIONS、ELECTRON_RUN_AS_NODE、PI_PACKAGE_DIR
// 等一律不进子进程环境（白名单之外的变量天然被丢弃）。
const ENV_ALLOWLIST = [
	"PATH",
	"Path",
	"PATHEXT",
	"SystemRoot",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"NUMBER_OF_PROCESSORS",
	"USERNAME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TERM",
	"HOSTNAME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"DISPLAY",
	"XAUTHORITY",
	"WAYLAND_DISPLAY",
	"XDG_RUNTIME_DIR",
	"XDG_SESSION_TYPE",
	"DBUS_SESSION_BUS_ADDRESS",
	"LD_LIBRARY_PATH",
	"TMPDIR",
];

class BlockedError extends Error {}

function limit(value, max) {
	const text = String(value ?? "");
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sleep(ms) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function parseArgs(argv) {
	const parsed = { exe: null, output: null };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--exe" || arg === "--output") {
			const value = argv[index + 1];
			if (value === undefined || value === "" || value.startsWith("--")) {
				throw new Error(`${arg} requires a path`);
			}
			parsed[arg.slice(2)] = value;
			index++;
		} else if (arg.startsWith("--exe=")) parsed.exe = arg.slice("--exe=".length);
		else if (arg.startsWith("--output=")) parsed.output = arg.slice("--output=".length);
		else throw new Error(`unknown argument: ${arg}`);
	}
	if (parsed.exe === "") throw new Error("--exe requires a path");
	if (parsed.output === "") throw new Error("--output requires a path");
	return parsed;
}

function defaultExeCandidates() {
	if (process.platform === "win32") {
		return [join(ROOT, "packages/desktop/dist/win-unpacked/Percho.exe")];
	}
	if (process.platform === "linux") {
		return [join(ROOT, "packages/desktop/dist/linux-unpacked/percho")];
	}
	if (process.platform === "darwin") {
		const primary = process.arch === "arm64" ? "mac-arm64" : "mac";
		const secondary = process.arch === "arm64" ? "mac" : "mac-arm64";
		return [primary, secondary].map((dir) =>
			join(ROOT, "packages/desktop/dist", dir, "Percho.app/Contents/MacOS/Percho"),
		);
	}
	return [];
}

function locatePackage(exe) {
	if (process.platform === "darwin") {
		const appBundle = resolve(dirname(exe), "..", "..");
		return {
			packageRoot: dirname(appBundle),
			resources: join(appBundle, "Contents", "Resources"),
		};
	}
	const packageRoot = dirname(exe);
	return { packageRoot, resources: join(packageRoot, "resources") };
}

function record(checks, id, ok, detail = null) {
	checks.push({ id, ok: Boolean(ok), detail });
	const suffix = detail === null ? "" : ` ${limit(JSON.stringify(detail), 300)}`;
	console.log(`${ok ? "PASS" : "FAIL"} ${id}${suffix}`);
}

async function allocatePort() {
	const server = createServer();
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	await new Promise((resolvePromise) => server.close(resolvePromise));
	if (!port) throw new Error("failed to preallocate a loopback CDP port");
	return port;
}

function isPortOpen(port, timeoutMs = 400) {
	return new Promise((resolvePromise) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		let settled = false;
		const done = (open) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolvePromise(open);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

async function waitForPortClosed(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await isPortOpen(port))) return true;
		await sleep(200);
	}
	return !(await isPortOpen(port));
}

function isPidAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

async function waitForPidGone(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isPidAlive(pid)) return true;
		await sleep(200);
	}
	return !isPidAlive(pid);
}

function isGroupAlive(pid) {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

function childPid(child) {
	return typeof child?.pid === "number" && child.pid > 0 ? child.pid : null;
}

function forceKill(child) {
	if (!child || child.exitCode !== null) return;
	const pid = childPid(child);
	if (pid === null) return;
	if (process.platform === "win32") {
		spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 20_000 });
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
	}
}

async function terminateChild(child, port, isoRoot) {
	const pid = childPid(child);
	const result = {
		method:
			process.platform === "win32" ? "taskkill /PID <pid> /T /F" : "detached group SIGTERM then SIGKILL",
		pid,
		pidAlive: null,
		portReleased: null,
		isoRemoved: false,
	};
	if (child && pid === null) {
		// spawn 未真正启动（如非 PE 文件）：没有 pid 可杀，不拼 taskkill 参数，直接走清理。
		result.pidAlive = false;
		result.note = "child has no pid (spawn never started); kill skipped";
	}
	if (child && pid !== null) {
		if (process.platform === "win32") {
			spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
				encoding: "utf8",
				timeout: 20_000,
			});
		} else {
			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				// already gone
			}
			await waitForPidGone(pid, 5_000);
			if (isPidAlive(pid) || isGroupAlive(pid)) {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					// already gone
				}
			}
		}
		await waitForPidGone(pid, 10_000);
		result.pidAlive = isPidAlive(pid);
	}
	if (port) result.portReleased = await waitForPortClosed(port, 5_000);
	// 没有存活 pid（含 spawn 从未成功、child 为 null）且端口已释放时也要清 iso 目录。
	if (isoRoot && result.pidAlive !== true && result.portReleased !== false) {
		try {
			await rm(isoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		} catch (error) {
			result.isoRemoveError = limit(error.message, 200);
		}
		result.isoRemoved = !existsSync(isoRoot);
	}
	return result;
}

async function waitForTargets(port, deadline, child, getSpawnError) {
	let lastError = "no response";
	while (Date.now() < deadline) {
		const spawnError = getSpawnError?.();
		if (spawnError) {
			throw new Error(`packaged app failed to spawn: ${limit(spawnError.message, 200)}`);
		}
		if (child && (child.exitCode !== null || child.signalCode !== null)) {
			throw new Error(
				`packaged app exited before CDP was ready (code ${child.exitCode}, signal ${child.signalCode})`,
			);
		}
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
				signal: AbortSignal.timeout(1000),
			});
			if (response.ok) {
				const targets = await response.json();
				if (Array.isArray(targets) && targets.length > 0) return targets;
			}
			lastError = `HTTP ${response.status}`;
		} catch (error) {
			lastError = limit(error.message, 160);
		}
		await sleep(250);
	}
	const spawnError = getSpawnError?.();
	if (spawnError) throw new Error(`packaged app failed to spawn: ${limit(spawnError.message, 200)}`);
	throw new Error(`CDP endpoint on 127.0.0.1:${port} not ready: ${lastError}`);
}

async function connectCdp(wsUrl, onEvent) {
	if (typeof WebSocket !== "function") {
		throw new Error("Node 22 built-in WebSocket is required (global WebSocket missing)");
	}
	const socket = new WebSocket(wsUrl);
	await new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => reject(new Error("CDP WebSocket open timed out")), 10_000);
		socket.addEventListener(
			"open",
			() => {
				clearTimeout(timer);
				resolvePromise();
			},
			{ once: true },
		);
		socket.addEventListener(
			"error",
			(event) => {
				clearTimeout(timer);
				reject(new Error(`CDP WebSocket error: ${limit(event.error?.message ?? event.message, 200)}`));
			},
			{ once: true },
		);
	});

	const pending = new Map();
	let nextId = 0;
	socket.addEventListener("message", (event) => {
		let message;
		try {
			const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
			message = JSON.parse(raw);
		} catch {
			return;
		}
		if (message.id && pending.has(message.id)) {
			const entry = pending.get(message.id);
			pending.delete(message.id);
			clearTimeout(entry.timer);
			if (message.error) entry.reject(new Error(limit(message.error.message, 300)));
			else entry.resolve(message.result);
			return;
		}
		if (message.method) onEvent(message);
	});

	function send(method, params = {}) {
		const id = ++nextId;
		return new Promise((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`CDP ${method} timed out`));
			}, 10_000);
			pending.set(id, { resolve: resolvePromise, reject, timer });
			socket.send(JSON.stringify({ id, method, params }));
		});
	}

	async function evaluate(expression) {
		const result = await send("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		if (result.exceptionDetails) {
			const details = result.exceptionDetails;
			throw new Error(limit(details.exception?.description ?? details.text ?? "evaluation failed", 300));
		}
		return result.result?.value;
	}

	return {
		send,
		evaluate,
		close() {
			for (const entry of pending.values()) {
				clearTimeout(entry.timer);
				entry.reject(new Error("CDP connection closed"));
			}
			pending.clear();
			try {
				socket.close();
			} catch {
				// already closed
			}
		},
	};
}

const PROBE = `(() => {
	const root = document.getElementById("root");
	const api = window.pi;
	const apiTypes = {};
	if (api) for (const key of ${JSON.stringify(REQUIRED_API)}) apiTypes[key] = typeof api[key];
	return {
		href: location.href,
		title: document.title.slice(0, 120),
		readyState: document.readyState,
		bodyTextLength: document.body ? document.body.innerText.length : 0,
		bodySnippet: document.body ? document.body.innerText.slice(0, 200) : "",
		rootChildren: root ? root.children.length : 0,
		appReady: document.documentElement.dataset.appReady === "true",
		splashPresent: Boolean(document.getElementById("splash")),
		pi: apiTypes,
		piReady: Boolean(api) && ${JSON.stringify(REQUIRED_API)}.every((key) => key === "platform" ? typeof api[key] === "string" : typeof api[key] === "function"),
	};
})()`;

function collectPageError(message, errors) {
	if (errors.length >= 20) return;
	if (message.method === "Runtime.exceptionThrown") {
		const details = message.params?.exceptionDetails;
		errors.push({
			kind: "exception",
			text: limit(details?.exception?.description ?? details?.text ?? "unknown", 300),
		});
		return;
	}
	if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
		const entry = message.params.entry;
		errors.push({ kind: "log", text: limit(`${entry.source}: ${entry.text}`, 300) });
		return;
	}
	if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
		const text = (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" ");
		errors.push({ kind: "console", text: limit(text, 300) });
	}
}

async function ipcArray(cdp, method) {
	return cdp.evaluate(`(async () => {
		const value = await window.pi.${method}();
		return { isArray: Array.isArray(value), length: Array.isArray(value) ? value.length : -1 };
	})()`);
}

let cli;
try {
	cli = parseArgs(process.argv.slice(2));
} catch (error) {
	console.error(`argument error: ${error.message}`);
	process.exit(2);
}
const outputDir = resolve(
	cli.output ?? join(ROOT, ".local/tmp/packaged-runtime", `${process.platform}-${process.arch}`),
);
await mkdir(outputDir, { recursive: true });

const evidence = {
	schema: "packaged-runtime-smoke/1",
	generatedAt: new Date().toISOString(),
	host: { platform: process.platform, arch: process.arch, node: process.version },
	package: {},
	launch: {},
	checks: [],
	page: null,
	ipc: {},
	errors: [],
	screenshot: null,
	termination: {},
	promptInvoked: false,
	verdict: "FAIL",
};
const checks = evidence.checks;

let child = null;
let spawnError = null;
let isoRoot = null;
let port = null;
let cdp = null;
let watchdog = null;
let timedOut = false;
let blocked = false;
let startedAt = 0;
let stderrTail = "";

try {
	const candidates = defaultExeCandidates();
	if (candidates.length === 0) {
		throw new BlockedError(
			`unsupported host ${process.platform}-${process.arch}: no packaged runtime acceptance path is defined`,
		);
	}

	const exe = resolve(cli.exe ?? candidates[0]);
	evidence.package.exe = exe;
	const exeOk = existsSync(exe);
	record(checks, "exe-located", exeOk, { exe });
	if (!exeOk) throw new Error(`packaged executable not found: ${exe}`);

	const location = locatePackage(exe);
	evidence.package.resources = location.resources;
	const asarPath = join(location.resources, "app.asar");
	const asarOk = existsSync(asarPath);
	record(checks, "asar-present", asarOk, { asar: asarPath });
	if (!asarOk) throw new Error(`app.asar not found: ${asarPath}`);

	const expectedManifest = join(ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json");
	const packagedManifest = join(location.resources, "pi-package/package.json");
	let expectedVersion = null;
	let actualVersion = null;
	try {
		expectedVersion = JSON.parse(await readFile(expectedManifest, "utf8")).version ?? null;
	} catch (error) {
		evidence.package.expectedVersionError = limit(error.message, 200);
	}
	try {
		actualVersion = JSON.parse(await readFile(packagedManifest, "utf8")).version ?? null;
	} catch (error) {
		evidence.package.actualVersionError = limit(error.message, 200);
	}
	const versionOk = Boolean(expectedVersion) && expectedVersion === actualVersion;
	evidence.package.sdk = { expected: expectedVersion, actual: actualVersion, match: versionOk };
	record(checks, "pi-package-version", versionOk, evidence.package.sdk);

	const missingResources = REQUIRED_RESOURCES.filter(
		(relative) => !existsSync(join(location.resources, relative)),
	);
	record(checks, "package-resources", missingResources.length === 0, {
		required: REQUIRED_RESOURCES.length,
		missing: missingResources,
	});

	const esbuildDir = `${process.platform}-${process.arch}`;
	const esbuildBin = join(
		location.resources,
		"app.asar.unpacked/node_modules/@esbuild",
		esbuildDir,
		...(process.platform === "win32" ? ["esbuild.exe"] : ["bin", "esbuild"]),
	);
	if (!existsSync(esbuildBin)) {
		record(checks, "esbuild-native", false, { expected: esbuildDir, found: false });
	} else {
		const run = spawnSync(esbuildBin, ["--version"], { encoding: "utf8", timeout: 15_000 });
		const version = (run.stdout ?? "").trim();
		record(checks, "esbuild-native", run.status === 0 && /^\d+\.\d+\.\d+/.test(version), {
			path: `app.asar.unpacked/node_modules/@esbuild/${esbuildDir}`,
			version: limit(version, 40),
			status: run.status,
			error: run.error ? limit(run.error.message, 200) : null,
		});
	}

	let asar = null;
	try {
		const requireFromDesktop = createRequire(join(ROOT, "packages/desktop/package.json"));
		asar = requireFromDesktop("@electron/asar");
		record(checks, "asar-module", true, { resolved: true });
	} catch (error) {
		record(checks, "asar-module", false, { message: limit(error.message, 200) });
	}

	let asarEntries = [];
	if (asar) {
		try {
			asarEntries = asar
				.listPackage(asarPath)
				.map((entry) => entry.replaceAll("\\", "/").replace(/^\/+/, ""));
		} catch (error) {
			evidence.package.asarListError = limit(error.message, 200);
		}
	}
	const requiredEntries = ["out/main/index.js", "out/preload/index.cjs", "out/renderer/index.html"];
	const missingEntries = requiredEntries.filter((entry) => !asarEntries.includes(entry));
	record(checks, "asar-entries", asar !== null && missingEntries.length === 0, {
		required: requiredEntries,
		missing: missingEntries,
	});

	if (!asar) {
		record(checks, "preload-static", false, { message: "@electron/asar unavailable" });
	} else {
		try {
			const preload = asar.extractFile(asarPath, join("out", "preload", "index.cjs"));
			const text = preload.toString("utf8");
			const exposesPi = /exposeInMainWorld\(\s*"pi"\s*,/.test(text);
			const cjs = text.includes('require("electron")') && !/^export\s/m.test(text);
			record(checks, "preload-static", preload.length > 0 && exposesPi && cjs, {
				entry: "out/preload/index.cjs",
				bytes: preload.length,
				exposesPi,
				cjs,
			});
		} catch (error) {
			record(checks, "preload-static", false, { message: limit(error.message, 200) });
		}
	}

	isoRoot = await mkdtemp(join(tmpdir(), "percho-packaged-runtime-"));
	const iso = {
		home: join(isoRoot, "home"),
		appdata: join(isoRoot, "appdata"),
		localappdata: join(isoRoot, "localappdata"),
		temp: join(isoRoot, "temp"),
		agent: join(isoRoot, "agent"),
		userData: join(isoRoot, "user-data"),
	};
	for (const dir of Object.values(iso)) await mkdir(dir, { recursive: true });
	await writeFile(join(iso.agent, "auth.json"), "{}\n", "utf8");
	await writeFile(join(iso.agent, "models.json"), '{\n\t"providers": {}\n}\n', "utf8");
	await writeFile(join(iso.agent, "settings.json"), "{}\n", "utf8");

	const env = {};
	for (const key of ENV_ALLOWLIST) {
		if (typeof process.env[key] === "string") env[key] = process.env[key];
	}
	Object.assign(env, {
		HOME: iso.home,
		USERPROFILE: iso.home,
		APPDATA: iso.appdata,
		LOCALAPPDATA: iso.localappdata,
		TEMP: iso.temp,
		TMP: iso.temp,
		TMPDIR: iso.temp,
		PI_CODING_AGENT_DIR: iso.agent,
		PI_OFFLINE: "1",
	});

	port = await allocatePort();
	const spawnArgs = [`--user-data-dir=${iso.userData}`, `--remote-debugging-port=${port}`];
	// Linux CI 的目录包没有 SUID sandbox helper，验收进程显式关 sandbox；其它平台保持默认。
	if (process.platform === "linux") spawnArgs.push("--no-sandbox");
	evidence.launch = { port, args: spawnArgs };

	startedAt = Date.now();
	try {
		child = spawn(exe, spawnArgs, {
			cwd: location.packageRoot,
			env,
			windowsHide: true,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		// Windows 上不可执行文件（非 PE）会让 uv_spawn 同步抛错，与异步 error 统一成 spawnError。
		spawnError = error;
		child = null;
	}
	evidence.launch.pid = childPid(child);
	if (child) {
		// 异步 spawn 失败只能通过 error 事件暴露：捕获后纳入 waitForTargets 的失败路径，
		// 避免 unhandled 'error' 直接把进程打崩。
		child.on("error", (error) => {
			spawnError = error;
		});
		child.stdout?.on("data", () => {});
		child.stdout?.on("error", () => {});
		child.stderr?.on("data", (data) => {
			stderrTail = limit(stderrTail + data.toString(), 2_000);
		});
		child.stderr?.on("error", () => {});
	}
	watchdog = setTimeout(() => {
		timedOut = true;
		forceKill(child);
	}, DEADLINE_MS);

	const cdpDeadline = Date.now() + Math.min(20_000, Math.max(1_000, DEADLINE_MS - (Date.now() - startedAt)));
	const targets = await waitForTargets(port, cdpDeadline, child, () => spawnError);
	evidence.launch.targets = targets
		.filter((target) => target.type === "page")
		.slice(0, 5)
		.map((target) => ({ type: target.type, url: limit(target.url, 200) }));
	const pageTarget =
		targets.find((target) => target.type === "page" && target.url.includes("/app.asar/out/renderer/")) ??
		targets.find((target) => target.type === "page");
	record(checks, "cdp-page-target", Boolean(pageTarget), {
		count: targets.length,
		url: pageTarget ? limit(pageTarget.url, 200) : null,
	});
	if (!pageTarget) throw new Error("no page target exposed by the packaged app");

	const pageErrors = [];
	cdp = await connectCdp(pageTarget.webSocketDebuggerUrl, (message) => collectPageError(message, pageErrors));
	await cdp.send("Runtime.enable");
	await cdp.send("Log.enable");
	await cdp.send("Page.enable");

	let snapshot = null;
	let hintSince = 0;
	const readyDeadline =
		Date.now() + Math.min(READY_MS, Math.max(1_000, DEADLINE_MS - (Date.now() - startedAt)));
	while (Date.now() < readyDeadline) {
		if (timedOut) throw new Error("packaged runtime exceeded the 60s process limit");
		snapshot = await cdp.evaluate(PROBE);
		if (
			snapshot?.piReady &&
			snapshot.rootChildren > 0 &&
			snapshot.bodyTextLength > 0 &&
			snapshot.appReady &&
			!snapshot.splashPresent
		) {
			break;
		}
		if (PERMISSION_HINT.test(snapshot?.bodySnippet ?? "")) {
			if (hintSince === 0) hintSince = Date.now();
			if (Date.now() - hintSince > 5_000) {
				throw new BlockedError(
					"a permission/blocked dialog appears to be showing; resolve it manually and rerun " +
						"(the script does not loop on dialogs)",
				);
			}
		}
		await sleep(250);
	}

	if (
		!snapshot?.piReady ||
		snapshot.rootChildren === 0 ||
		snapshot.bodyTextLength === 0 ||
		!snapshot.appReady ||
		snapshot.splashPresent
	) {
		const hint = PERMISSION_HINT.test(snapshot?.bodySnippet ?? "");
		throw new BlockedError(
			hint
				? "packaged renderer stayed blocked by a permission/blocked dialog; resolve it manually and rerun"
				: `packaged renderer did not become ready within ${READY_MS / 1000}s`,
		);
	}

	evidence.page = {
		href: limit(snapshot.href, 200),
		title: limit(snapshot.title, 120),
		readyState: snapshot.readyState,
		bodyTextLength: snapshot.bodyTextLength,
		rootChildren: snapshot.rootChildren,
		appReady: snapshot.appReady,
		splashRemoved: !snapshot.splashPresent,
		pi: snapshot.pi,
	};
	record(
		checks,
		"renderer-file-url",
		typeof snapshot.href === "string" &&
			snapshot.href.startsWith("file://") &&
			snapshot.href.includes("/app.asar/out/renderer/"),
		{ href: evidence.page.href },
	);
	record(
		checks,
		"renderer-dom",
		snapshot.readyState !== "loading" &&
			snapshot.bodyTextLength > 0 &&
			snapshot.rootChildren > 0 &&
			snapshot.appReady &&
			!snapshot.splashPresent,
		{
			readyState: snapshot.readyState,
			bodyTextLength: snapshot.bodyTextLength,
			rootChildren: snapshot.rootChildren,
			appReady: snapshot.appReady,
			splashRemoved: !snapshot.splashPresent,
		},
	);
	record(checks, "window-pi-api", Boolean(snapshot.piReady), {
		required: REQUIRED_API,
		actual: snapshot.pi,
	});

	for (const method of ["listModels", "listAllSessions"]) {
		try {
			const result = await ipcArray(cdp, method);
			evidence.ipc[method] = result;
			record(checks, `ipc-${method}`, result.isArray, result);
		} catch (error) {
			record(checks, `ipc-${method}`, false, { message: limit(error.message, 300) });
		}
	}

	try {
		const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
		const buffer = Buffer.from(shot.data, "base64");
		await writeFile(join(outputDir, "runtime.png"), buffer);
		evidence.screenshot = { file: "runtime.png", bytes: buffer.length };
		record(checks, "screenshot", buffer.length > 1024, evidence.screenshot);
	} catch (error) {
		record(checks, "screenshot", false, { message: limit(error.message, 200) });
	}

	evidence.errors = pageErrors.slice(0, 20);
	const fatalErrors = pageErrors.filter(
		(entry) =>
			entry.kind === "exception" ||
			/ERR_FILE_NOT_FOUND|app\.asar\/out\/renderer.*(fail|not found|cannot)/i.test(entry.text),
	);
	record(checks, "page-load-errors", fatalErrors.length === 0, {
		total: pageErrors.length,
		fatal: fatalErrors.length,
		samples: fatalErrors.slice(0, 5).map((entry) => ({ kind: entry.kind, text: limit(entry.text, 160) })),
	});

	record(checks, "process-limit", Date.now() - startedAt <= DEADLINE_MS, {
		elapsedMs: Date.now() - startedAt,
		limitMs: DEADLINE_MS,
	});
} catch (error) {
	blocked = error instanceof BlockedError;
	record(checks, "fatal", false, { message: limit(error.message, 400) });
} finally {
	clearTimeout(watchdog);
	cdp?.close();
	if (stderrTail) evidence.launch.stderrTail = stderrTail;
	if (spawnError) {
		evidence.launch.spawnError = limit(spawnError.message, 300);
		evidence.launch.spawnErrorCode = spawnError.code ?? null;
	}
	const termination = await terminateChild(child, port, isoRoot);
	evidence.termination = termination;
	if (child || isoRoot || port) {
		record(
			checks,
			"teardown",
			termination.pidAlive !== true && termination.portReleased !== false && termination.isoRemoved === true,
			termination,
		);
	}
	evidence.verdict = blocked ? "BLOCKED" : checks.every((check) => check.ok) ? "PASS" : "FAIL";
	await writeFile(join(outputDir, "runtime-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
	const passed = checks.filter((check) => check.ok).length;
	console.log(`\n${evidence.verdict}: ${passed}/${checks.length} checks passed`);
	console.log(`evidence: ${join(outputDir, "runtime-evidence.json")}`);
	process.exit(blocked ? 2 : checks.every((check) => check.ok) ? 0 : 1);
}
