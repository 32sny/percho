import {
	type AgentSessionEvent,
	type AgentToolResult,
	defineTool,
	type ExtensionContext,
	type ModelRuntime,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "@percho/shared";
import { type Static, Type } from "typebox";
import type { PermissionGate } from "../../permissions/gate";
import type { SessionTraces } from "../../session/traces";
import { discoverAgents, findAgent } from "./agents";
import type {
	BackgroundBatchSnapshot,
	BackgroundDispatchInput,
	BackgroundSubagentManager,
} from "./background";
import { MAX_CONCURRENCY, runWithConcurrency } from "./concurrency";
import {
	failedResult,
	formatRunSummary,
	pendingResult,
	runSubagent,
	type SingleResult,
	type SubagentRunHandle,
} from "./runner";

const MAX_TASKS = 8;
const MAX_CONTENT = 50_000;

const taskSchema = Type.Object({
	agent: Type.String({ minLength: 1, description: "Agent definition name, e.g. scout" }),
	task: Type.String({ minLength: 1, description: "Self-contained task for the subagent" }),
	cwd: Type.Optional(Type.String({ minLength: 1, description: "Optional working directory" })),
});

/**
 * 拍平为单一 object schema（导出供测试断言）。不能用 Type.Union/Intersect：
 * - openai-completions 路径原样发送 schema，anyOf 顶层无 type:"object"，DeepSeek 直接 400；
 * - anthropic 路径的 convertTools 只保留顶层 properties/required，anyOf 会被剥成空 object，
 *   模型失去参数描述（kimi 断流/参数空洞的诱因）。
 * single / parallel 的互斥约束因此下沉到 execute 运行时校验。
 */
export const subagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({ minLength: 1, description: "Agent definition name, e.g. scout (single run)" }),
	),
	task: Type.Optional(
		Type.String({ minLength: 1, description: "Self-contained task for the subagent (single run)" }),
	),
	cwd: Type.Optional(Type.String({ minLength: 1, description: "Optional working directory" })),
	tasks: Type.Optional(
		Type.Array(taskSchema, {
			minItems: 1,
			maxItems: MAX_TASKS,
			description: `Parallel runs (up to ${MAX_TASKS} tasks); mutually exclusive with agent/task`,
		}),
	),
	confirmProjectAgents: Type.Optional(Type.Boolean()),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Run in background and return immediately with runId; parent session is automatically notified when finished. Prefer for read-only or non-conflicting long tasks.",
		}),
	),
});

export interface SubagentBackgroundBridge {
	manager: BackgroundSubagentManager;
	getParentSessionId: () => string | undefined;
	onUpdate?: BackgroundDispatchInput["onUpdate"];
	onComplete?: BackgroundDispatchInput["onComplete"];
}

export interface MakeSubagentToolDeps {
	getModelRuntime: () => Promise<ModelRuntime>;
	getSubagentModel: (agentName: string) => Promise<string | undefined>;
	/** 设置页的 per-agent 思考深度覆盖；无配置时返回 undefined 并继续走 frontmatter。 */
	getSubagentThinkingLevel: (agentName: string) => Promise<string | undefined>;
	getPermissionMode?: () => PermissionMode;
	gate: PermissionGate;
	traces: SessionTraces;
	registerRun?: (handle: SubagentRunHandle) => void;
	unregisterRun?: (sessionId: string) => void;
	/** 把运行中子会话事件转发给桌面会话订阅方。 */
	onEvent?: (sessionId: string, event: AgentSessionEvent, abort: () => Promise<void>) => void;
	background?: SubagentBackgroundBridge;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "background";
	runId?: string;
	results: SingleResult[];
}

function truncate(text: string): string {
	return text.length <= MAX_CONTENT ? text : `${text.slice(0, MAX_CONTENT)}\n[truncated]`;
}

function partialResult(
	mode: SubagentDetails["mode"],
	results: SingleResult[],
): AgentToolResult<SubagentDetails> {
	return {
		content: [{ type: "text", text: "Subagent tasks are running..." }],
		details: { mode, results: results.map((result) => ({ ...result, usage: { ...result.usage } })) },
	};
}

function isFailed(result: SingleResult): boolean {
	return (
		result.status === "failed" || result.status === "aborted" || result.exitCode !== 0 || result.error != null
	);
}

function contentForResults(results: SingleResult[], mode: "single" | "parallel"): string {
	if (mode === "single") {
		const result = results[0];
		if (!result) return "";
		// 失败必须让模型看到诊断（spec §6：失败 = isError + 诊断）——空 content 会被当成「成功但无输出」
		const body = isFailed(result)
			? `Subagent ${result.agent} ${result.status === "aborted" ? "aborted" : "failed"}: ${result.error ?? "aborted"}`
			: truncate(result.content ?? "");
		const summary = formatRunSummary(result.summary);
		return summary ? `${body}\n\n${summary}` : body;
	}
	return truncate(
		results
			.map((result, index) => {
				const header = `## ${index + 1}. ${result.agent}`;
				// 每任务独立截断，防单个超长输出挤掉其他任务（对齐官方 example 的 per-task cap）
				const body = isFailed(result)
					? `Error: ${result.error ?? (result.status === "aborted" ? "aborted" : "failed")}`
					: (result.content ?? "");
				const summary = formatRunSummary(result.summary);
				const fullBody = summary ? `${truncate(body)}\n\n${summary}` : truncate(body);
				return `${header}\n${fullBody}`;
			})
			.join("\n\n"),
	);
}

/**
 * 收尾组装工具结果（纯函数，可单测）：single 任一失败 / parallel 全败 → isError。
 * parallel 部分失败不置 isError（各任务 Error 行已在 content 里，模型可自行消化）。
 */
export function finalizeSubagentResult(
	mode: "single" | "parallel",
	results: SingleResult[],
): AgentToolResult<SubagentDetails> {
	const anyFailed = results.some(isFailed);
	const allFailed = results.length > 0 && results.every(isFailed);
	const isError = mode === "single" ? anyFailed : allFailed;
	return {
		content: [{ type: "text", text: contentForResults(results, mode) }],
		details: { mode, results },
		...(isError ? { isError: true } : {}),
	};
}

async function confirmProjectAgents(
	ctx: ExtensionContext,
	shouldConfirm: boolean,
	agents: Array<{ name: string; source: string }>,
): Promise<void> {
	const projectNames = [
		...new Set(agents.filter((agent) => agent.source === "project").map((agent) => agent.name)),
	];
	if (!shouldConfirm || projectNames.length === 0 || !ctx.hasUI) return;
	const allowed = await ctx.ui.confirm(
		"Allow project subagent definitions?",
		`This project provides subagent definitions: ${projectNames.join(", ")}. Their instructions will be executed in isolated sessions.`,
	);
	if (!allowed) throw new Error("Project subagent definitions were not approved");
}

/** 内置进程内 subagent 工具：single + bounded parallel，子会话深度固定为 1。 */
export function makeSubagentTool(deps: MakeSubagentToolDeps): ToolDefinition {
	// defineTool：官方 1.0.4 的类型收窄入口（execute 参数由 TParams 推导）
	return defineTool({
		name: "subagent",
		// 子会话会跑工具（可能改环境），且它不带权限扩展 → 这里如实声明为写且可破坏
		// （声明不参与本机弹窗判定：自研工具在权限门控里走「内置短路」，见 permissions/annotations.ts）
		annotations: { readOnlyHint: false, destructiveHint: true },
		label: "Subagent",
		description:
			"Delegate a self-contained read-only or project-scoped task to an isolated subagent session. Use {agent, task} for one run or {tasks:[{agent, task}, ...]} for parallel exploration (up to 8 tasks, 4 at once). Built-in agent: scout. More agents may be defined in ~/.pi/agent/agents/. The subagent returns only its final conclusion while its full session remains available from the result card.",
		parameters: subagentParams,
		execute: async (
			toolCallId,
			rawParams,
			signal,
			onUpdate,
			ctx,
		): Promise<AgentToolResult<SubagentDetails>> => {
			void toolCallId;
			const params = rawParams as Static<typeof subagentParams>;
			// 原 Union 的互斥约束运行时兜底：tasks 非空 → parallel，否则 agent+task 必填
			const parallelTasks = params.tasks?.length ? params.tasks : undefined;
			let tasks: Array<Static<typeof taskSchema>>;
			if (parallelTasks) {
				tasks = parallelTasks;
			} else {
				if (!params.agent || !params.task) {
					throw new Error(
						'Missing "agent"/"task": pass { agent, task } for one run or { tasks: [...] } for parallel',
					);
				}
				tasks = [{ agent: params.agent, task: params.task, ...(params.cwd ? { cwd: params.cwd } : {}) }];
			}
			const mode: "single" | "parallel" = parallelTasks ? "parallel" : "single";
			const shouldConfirm = params.confirmProjectAgents !== false;
			const projectTrusted = ctx.isProjectTrusted();
			const definitions = await Promise.all(
				tasks.map(async (task) => {
					const cwd = task.cwd ?? ctx.cwd;
					const agents = await discoverAgents(cwd, { projectTrusted });
					return { task, cwd, agents, agent: findAgent(agents, task.agent) };
				}),
			);
			await confirmProjectAgents(
				ctx,
				shouldConfirm,
				definitions.map(({ agent }) => agent),
			);

			if (params.run_in_background) {
				const parentSessionId = deps.background?.getParentSessionId();
				if (!deps.background || !parentSessionId) {
					return {
						content: [{ type: "text", text: "Background subagent execution is unavailable in this host." }],
						details: { mode, results: [] },
						isError: true,
					};
				}
				const dispatched = deps.background.manager.dispatch({
					parentSessionId,
					mode,
					definitions,
					projectTrusted,
					model: ctx.model,
					deps,
					onUpdate: deps.background.onUpdate,
					onComplete: deps.background.onComplete,
				});
				const hasMutatingAgent = definitions.some(({ agent }) =>
					agent.tools.some((t) => t === "edit" || t === "write" || t === "bash"),
				);
				const lines = [
					`Dispatched background subagent batch ${dispatched.runId} (${definitions.length} task(s)).`,
					"You can continue other work; completion will automatically report back to this session.",
					"Use subagent_status / subagent_wait / subagent_stop if you need to inspect, wait for, or cancel it.",
					...(hasMutatingAgent
						? [
								"Warning: one or more background agents have write/bash tools — avoid editing the same files concurrently in the parent session.",
							]
						: []),
					...dispatched.results.map((r) => {
						const label = r.index != null ? `[${r.index}] ${r.agent}` : r.agent;
						const file = r.artifactPaths.jsonlPath ? ` (${r.artifactPaths.jsonlPath})` : "";
						return `- ${label}: ${r.status}${file}`;
					}),
				];
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						mode: "background",
						runId: dispatched.runId,
						results: dispatched.results,
					},
				};
			}

			// 固定槽位：结果按请求顺序归位（完成顺序不定），模型看到的结果顺序与请求一致
			const slots: SingleResult[] = definitions.map(({ task, agent }, index) =>
				pendingResult(agent.name, task.task, "queued", definitions.length > 1 ? { index: index + 1 } : {}),
			);
			const emit = () => onUpdate?.(partialResult(mode, slots));
			await runWithConcurrency(definitions, MAX_CONCURRENCY, signal, async ({ task, cwd, agent }, index) => {
				const startedAt = Date.now();
				let result: SingleResult;
				try {
					result = await runSubagent(deps, {
						agent,
						task: task.task,
						cwd,
						projectTrusted,
						...(definitions.length > 1 ? { index: index + 1 } : {}),
						model: ctx.model,
						signal,
						onProgress: (progress) => {
							slots[index] = progress;
							emit();
						},
					});
				} catch (error) {
					result = failedResult(agent.name, task.task, error, {
						aborted: signal?.aborted === true,
						startedAt,
						...(definitions.length > 1 ? { index: index + 1 } : {}),
					});
				}
				slots[index] = result;
				emit();
			});
			if (signal?.aborted) {
				for (let i = 0; i < slots.length; i++) {
					const slot = slots[i];
					if (slot?.status === "queued") {
						slots[i] = {
							...slot,
							status: "aborted",
							exitCode: 1,
							error: "aborted",
						};
					}
				}
			}
			return finalizeSubagentResult(mode, slots);
		},
	});
}

function formatBatchSnapshot(batch: BackgroundBatchSnapshot): string {
	const elapsedSec = (((batch.finishedAt ?? Date.now()) - batch.startedAt) / 1000).toFixed(1);
	const lines = [`Batch ${batch.runId} (${batch.mode}): ${batch.status} (${elapsedSec}s)`];
	for (const r of batch.results) {
		const label = r.index != null ? `[${r.index}] ${r.agent}` : r.agent;
		const file = r.artifactPaths.jsonlPath ? ` | ${r.artifactPaths.jsonlPath}` : "";
		const err = r.error ? ` | error: ${r.error}` : "";
		lines.push(`- ${label}: ${r.status}${file}${err}`);
	}
	return lines.join("\n");
}

export function makeSubagentBackgroundTools(bridge: SubagentBackgroundBridge): ToolDefinition[] {
	const statusTool = defineTool({
		name: "subagent_status",
		label: "Subagent Status",
		description: "Check status of background subagent batches dispatched from this session.",
		parameters: Type.Object({
			runId: Type.Optional(Type.String({ description: "Optional background batch runId" })),
		}),
		async execute(_toolCallId, params) {
			const parentSessionId = bridge.getParentSessionId();
			if (!parentSessionId) {
				return { content: [{ type: "text", text: "No active parent session." }], details: { batches: [] } };
			}
			const batches = bridge.manager.list(parentSessionId, params.runId);
			if (batches.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: params.runId
								? `No background subagent batch found for runId "${params.runId}".`
								: "No background subagent batches in this session.",
						},
					],
					details: { batches: [] },
				};
			}
			return {
				content: [{ type: "text", text: batches.map(formatBatchSnapshot).join("\n\n") }],
				details: { batches },
			};
		},
	});

	const waitTool = defineTool({
		name: "subagent_wait",
		label: "Wait Subagent",
		description: "Wait for a background subagent batch to finish (or until timeoutMs).",
		parameters: Type.Object({
			runId: Type.String({ description: "Background batch runId returned by subagent" }),
			timeoutMs: Type.Optional(
				Type.Number({ description: "Optional timeout in milliseconds (default 120000)", minimum: 100 }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const parentSessionId = bridge.getParentSessionId();
			if (!parentSessionId) {
				return {
					content: [{ type: "text", text: "No active parent session." }],
					details: { timedOut: false, batches: [] as BackgroundBatchSnapshot[] },
				};
			}
			const res = await bridge.manager.wait(parentSessionId, params.runId, params.timeoutMs, signal);
			if (!res.batch) {
				return {
					content: [
						{ type: "text", text: `No background subagent batch found for runId "${params.runId}".` },
					],
					details: { timedOut: false, batches: [] as BackgroundBatchSnapshot[] },
					isError: true,
				};
			}
			const prefix = res.timedOut ? "Timed out waiting; current status:\n" : "";
			return {
				content: [{ type: "text", text: `${prefix}${formatBatchSnapshot(res.batch)}` }],
				details: { timedOut: res.timedOut, batches: [res.batch] as BackgroundBatchSnapshot[] },
			};
		},
	});

	const stopTool = defineTool({
		name: "subagent_stop",
		label: "Stop Subagent",
		description: "Abort a running background subagent batch.",
		parameters: Type.Object({
			runId: Type.String({ description: "Background batch runId returned by subagent" }),
		}),
		async execute(_toolCallId, params) {
			const parentSessionId = bridge.getParentSessionId();
			if (!parentSessionId) {
				return { content: [{ type: "text", text: "No active parent session." }], details: { batches: [] } };
			}
			const res = await bridge.manager.stop(parentSessionId, params.runId);
			if (!res.stopped || !res.batch) {
				return {
					content: [
						{ type: "text", text: `No background subagent batch found for runId "${params.runId}".` },
					],
					details: { batches: [] },
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: formatBatchSnapshot(res.batch) }],
				details: { batches: [res.batch] },
			};
		},
	});

	return [statusTool, waitTool, stopTool];
}
