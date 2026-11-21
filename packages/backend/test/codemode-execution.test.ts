import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionFactory, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	createCodemodeExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { makePermissionGateExtension } from "../src/permissions/extension";
import {
	assistantTurn,
	cleanupSdkTest,
	gate,
	MODEL,
	messageText,
	response,
	textTurn,
	withTimeout,
} from "./message-control-sdk-harness";

/**
 * Code Mode / tool_search 的真实 SDK 执行链证据。
 *
 * 只用真实 AgentSession、真实扩展工厂（codemode / tool_search / permission-gate）与内存模型流；
 * 脚本经 `codemode` 的 `ctx.executeTool()` 进入真实嵌套工具管线（校验、tool_call 钩子、权限门控），
 * 不替换 executeTool、不伪造工具结果、不联网。
 *
 * 这里不用 harness 的 `sdkFixture()`：它的 `tools` 参数同时是 SDK 的 allowlist，而空数组会过滤掉
 * 扩展注册的工具（codemode / tool_search / deferred）。本文件自建同形真实会话，仍复用 harness 的
 * `assistantTurn` / `response` / `textTurn` / `gate` / `withTimeout` / `cleanupSdkTest`。
 */

interface LocalFixture {
	session: AgentSession;
	dir: string;
}

const fixtures: LocalFixture[] = [];
const dirs: string[] = [];

function isolatedDir(): string {
	const base = resolve("../../.local/tmp/codemode-execution-tests");
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, "case-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	const errors: unknown[] = [];
	// 先释放 harness 门闩，再等本地会话空闲，避免非合作工具把清理拖成超时。
	try {
		await cleanupSdkTest();
	} catch (error) {
		errors.push(error);
	}
	for (const fixture of fixtures.splice(0).reverse()) {
		try {
			await withTimeout(fixture.session.waitForIdle(), 3_000, "local session idle during cleanup");
		} catch (error) {
			errors.push(error);
		}
		try {
			fixture.session.dispose();
		} catch (error) {
			errors.push(error);
		}
	}
	for (const dir of dirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0) throw new AggregateError(errors, "codemode execution test cleanup failed");
});

interface FixtureOptions {
	extensions: ExtensionFactory[];
	/** 临时目录；权限用例需要先写 permissions.json 再加载扩展。 */
	dir?: string;
	defaultTools?: string[];
}

/** 真实 AgentSession：真实 DefaultResourceLoader 加载扩展，模型传输由测试内存流替代。 */
async function createFixture(options: FixtureOptions): Promise<LocalFixture> {
	const dir = options.dir ?? isolatedDir();
	const settings = SettingsManager.inMemory({
		defaultTools: options.defaultTools ?? ["codemode"],
		compaction: { enabled: false },
		retry: { enabled: false },
		cacheWarming: "off",
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager: settings,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: options.extensions.map((factory, index) => ({
			name: `codemode-exec-${index + 1}`,
			factory,
			hidden: true,
		})),
	});
	await resourceLoader.reload();
	const modelRuntime = {
		getModel: () => MODEL,
		hasConfiguredAuth: () => true,
		checkAuth: async () => ({ type: "api_key", key: "test-key" }),
		getAuth: async () => undefined,
		isUsingOAuth: () => false,
		getAvailableSnapshot: () => [MODEL],
	} as unknown as ModelRuntime;
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: MODEL,
		modelRuntime,
		settingsManager: settings,
		sessionManager: SessionManager.create(dir, dir),
		resourceLoader,
	});
	fixtures.push({ session, dir });
	return { session, dir };
}

/** 模型当前被声明的工具（transcript 的 toolsAdded/toolsRemoved 增量重放）。 */
function declaredToolNames(messages: readonly { role: string }[]): string[] {
	return getCurrentTools(messages).map((tool) => tool.name);
}

function toolResultFor(session: AgentSession, toolName: string): ToolResultMessage {
	const result = session.messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
	);
	if (!result) throw new Error(`missing tool result for ${toolName}`);
	return result;
}

const codemodeExtension = (): ExtensionFactory => createCodemodeExtension({ mode: "on", models: false });

describe("codemode real SDK execution", () => {
	it("deferred 工具初始不声明，tool_search 激活后可调用；codemode searchTools 发现并调用", async () => {
		let executions = 0;
		const deferred: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "alpha_report",
				label: "alpha report",
				description: "Report the deferred alpha metrics from the internal audit ledger.",
				parameters: Type.Object({ note: Type.String() }),
				exposure: "deferred",
				execute: async (_toolCallId, params) => {
					executions += 1;
					return { content: [{ type: "text", text: `alpha:${params.note}` }], details: {} };
				},
			});
		};
		const { session } = await createFixture({
			extensions: [codemodeExtension(), createToolSearchExtension(), deferred],
			defaultTools: ["codemode", "tool_search"],
		});

		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["codemode", "tool_search"]));
		expect(session.getActiveToolNames()).not.toContain("alpha_report");
		expect(session.getAllTools().find((tool) => tool.name === "alpha_report")?.exposure).toBe("deferred");

		const declared: string[][] = [];
		let turn = 0;
		session.agent.streamFunction = (_model, context) => {
			declared.push(declaredToolNames(context.messages));
			turn += 1;
			if (turn === 1) {
				return response(
					assistantTurn(
						[
							{
								type: "toolCall",
								id: "deferred-search",
								name: "tool_search",
								arguments: { query: "alpha_report" },
							},
						],
						"toolUse",
					),
				);
			}
			if (turn === 2) {
				return response(
					assistantTurn(
						[
							{
								type: "toolCall",
								id: "deferred-codemode",
								name: "codemode",
								arguments: {
									code: 'const matches = await searchTools("alpha_report"); const out = await tools.alpha_report({ note: "via-codemode" }); return matches.map((match) => match.name).join(",") + "|" + out;',
								},
							},
						],
						"toolUse",
					),
				);
			}
			if (turn === 4) {
				return response(
					assistantTurn(
						[
							{
								type: "toolCall",
								id: "deferred-direct",
								name: "alpha_report",
								arguments: { note: "direct" },
							},
						],
						"toolUse",
					),
				);
			}
			return response(textTurn("done"));
		};

		await session.prompt("discover the deferred alpha report tool");

		// 第一次请求时 deferred 工具不在模型声明中；tool_search 激活后下一次请求才声明。
		expect(declared).toHaveLength(3);
		expect(declared[0]).toEqual(expect.arrayContaining(["codemode", "tool_search"]));
		expect(declared[0]).not.toContain("alpha_report");
		expect(declared[1]).toContain("alpha_report");
		expect(session.getActiveToolNames()).toContain("alpha_report");

		const searchResult = toolResultFor(session, "tool_search");
		expect(searchResult.isError).toBe(false);
		expect(messageText(searchResult.content)).toContain("Loaded 1 tool");
		expect(messageText(searchResult.content)).toContain("alpha_report");

		const codemodeResult = toolResultFor(session, "codemode");
		expect(codemodeResult.isError).toBe(false);
		const codemodeText = messageText(codemodeResult.content);
		expect(codemodeText).toContain("Script completed");
		expect(codemodeText).toContain("alpha_report|alpha:via-codemode");
		expect(codemodeResult.nestedCalls?.calls).toMatchObject([
			{ name: "alpha_report", status: "ok", arguments: { note: "via-codemode" } },
		]);
		// searchTools 只是发现；脚本里的 tools.alpha_report 才真正执行一次。
		expect(executions).toBe(1);

		await session.prompt("call the now-loaded tool directly");
		// 激活跨轮保留：第二次 prompt 的首个请求仍声明它，且可直接调用。
		expect(declared).toHaveLength(5);
		expect(declared[3]).toContain("alpha_report");
		const directResult = toolResultFor(session, "alpha_report");
		expect(directResult.isError).toBe(false);
		expect(messageText(directResult.content)).toBe("alpha:direct");
		expect(executions).toBe(2);
	});

	it("codemode 容器 allow 不覆盖内部工具 deny：副作用未执行，错误回到脚本", async () => {
		let executions = 0;
		let confirms = 0;
		const dir = isolatedDir();
		writeFileSync(join(dir, "permissions.json"), JSON.stringify({ rules: { danger_tool: "deny" } }));

		const danger: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "danger_tool",
				label: "danger tool",
				description: "Internal tool that must stay denied inside a codemode script.",
				parameters: Type.Object({ note: Type.String() }),
				exposure: "codemode",
				execute: async (_toolCallId, params) => {
					executions += 1;
					return { content: [{ type: "text", text: `danger:${params.note}` }], details: {} };
				},
			});
		};
		const permissionExtension = makePermissionGateExtension(dir, {
			confirm: async () => {
				confirms += 1;
				return true;
			},
		});
		const permissionGate: ExtensionFactory = (pi) =>
			typeof permissionExtension === "function" ? permissionExtension(pi) : permissionExtension.factory(pi);

		const { session } = await createFixture({
			dir,
			extensions: [codemodeExtension(), permissionGate, danger],
			defaultTools: ["codemode"],
		});

		let turn = 0;
		session.agent.streamFunction = () => {
			turn += 1;
			if (turn === 1) {
				return response(
					assistantTurn(
						[
							{
								type: "toolCall",
								id: "deny-inside",
								name: "codemode",
								arguments: {
									code: 'let message = "no-error"; try { const value = await tools.danger_tool({ note: "inside" }); message = "unexpected:" + value; } catch (error) { message = error instanceof Error ? error.message : String(error); } return message;',
								},
							},
						],
						"toolUse",
					),
				);
			}
			return response(textTurn("done"));
		};

		await session.prompt("run the denied internal tool inside codemode");

		const codemodeResult = toolResultFor(session, "codemode");
		// 容器本身放行：脚本正常完成并把内部拒绝文本返回给脚本。
		expect(codemodeResult.isError).toBe(false);
		const codemodeText = messageText(codemodeResult.content);
		expect(codemodeText).toContain("Script completed");
		expect(codemodeText).toContain("Blocked by permission rule (danger_tool)");
		expect(codemodeText).not.toContain("unexpected:");
		expect(codemodeResult.nestedCalls?.calls).toMatchObject([
			{
				name: "danger_tool",
				status: "error",
				error: expect.stringContaining("Blocked by permission rule (danger_tool)"),
			},
		]);
		// deny 在规则层短路：工具 execute 未执行，也没有走到用户确认。
		expect(executions).toBe(0);
		expect(confirms).toBe(0);
	});

	it("脚本异常以可见的 Script failed / Script error 返回，不中断会话", async () => {
		const { session } = await createFixture({ extensions: [codemodeExtension()] });

		let turn = 0;
		session.agent.streamFunction = () => {
			turn += 1;
			if (turn === 1) {
				return response(
					assistantTurn(
						[
							{
								type: "toolCall",
								id: "script-throws",
								name: "codemode",
								arguments: { code: 'throw new Error("boom-marker")' },
							},
						],
						"toolUse",
					),
				);
			}
			return response(textTurn("done"));
		};

		await session.prompt("throw inside a codemode script");

		const codemodeResult = toolResultFor(session, "codemode");
		expect(codemodeResult.isError).toBe(true);
		const text = messageText(codemodeResult.content);
		expect(text).toContain("Script failed");
		expect(text).toContain("Script error:");
		expect(text).toContain("boom-marker");

		// 失败作为工具结果回到模型，循环继续到下一次正常回复。
		expect(turn).toBe(2);
		const last = session.messages[session.messages.length - 1];
		expect(last.role).toBe("assistant");
		if (last.role !== "assistant") throw new Error("expected the final message to be an assistant message");
		const lastText = last.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("");
		expect(lastText).toContain("done");
	});

	it("session.abort() 取消脚本并把取消传到内部工具，结束后会话完整空闲", async () => {
		const entered = gate();
		const log: string[] = [];
		const gated: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "gated_nested",
				label: "gated nested",
				description: "Nested tool that waits until its signal aborts.",
				parameters: Type.Object({}),
				exposure: "codemode",
				execute: async (_toolCallId, _params, signal) => {
					log.push("start");
					entered.resolve();
					await new Promise<void>((resolveAbort) => {
						if (signal?.aborted) {
							log.push("aborted");
							resolveAbort();
							return;
						}
						signal?.addEventListener(
							"abort",
							() => {
								log.push("aborted");
								resolveAbort();
							},
							{ once: true },
						);
					});
					log.push(`end:${signal?.aborted === true}`);
					return { content: [{ type: "text", text: "nested-finished" }], details: {} };
				},
			});
		};
		const { session } = await createFixture({ extensions: [codemodeExtension(), gated] });

		let streams = 0;
		session.agent.streamFunction = () => {
			streams += 1;
			return response(
				assistantTurn(
					[
						{
							type: "toolCall",
							id: "abort-inside",
							name: "codemode",
							arguments: { code: "const value = await tools.gated_nested({}); return value;" },
						},
					],
					"toolUse",
				),
			);
		};

		const run = session.prompt("abort a running codemode script");
		await withTimeout(entered.promise, 5_000, "nested gated tool entered");

		const stopping = session.abort();
		await withTimeout(stopping, 5_000, "session.abort settles");
		await withTimeout(run, 5_000, "aborted prompt settles");
		await withTimeout(session.waitForIdle(), 5_000, "session idle after abort");

		expect(log).toEqual(["start", "aborted", "end:true"]);
		const codemodeResult = toolResultFor(session, "codemode");
		expect(codemodeResult.isError).toBe(true);
		const text = messageText(codemodeResult.content);
		expect(text).toContain("Script failed");
		expect(text).toContain("Script aborted");
		expect(text).toContain("gated_nested (cancelled)");

		// 取消后不再进入下一次 provider-stream，也没有残留的 aborted assistant 消息。
		expect(streams).toBe(1);
		expect(session.isIdle).toBe(true);
		expect(session.agent.state.isStreaming).toBe(false);
		expect(session.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"toolResult",
		]);
		expect(
			session.messages.filter(
				(message) =>
					message.role === "assistant" && (message as { stopReason?: string }).stopReason === "aborted",
			),
		).toHaveLength(0);
	});
});
