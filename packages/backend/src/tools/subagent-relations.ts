import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { projectSessionHoverTask } from "@percho/shared";
import { createLogger } from "../log";
import { backendSessionPathKey } from "../session/session-paths";
import {
	findRelationAnchor,
	parseRelationRecord,
	type RelationRecordV1,
	relationObject,
	relationRecordKey,
	relationText,
	SUBAGENT_RELATION_CUSTOM_TYPE,
} from "../session/subagent-relation-records";

const log = createLogger("subagent-relations");
const MAX_ACTIVE = 512;
const MAX_DEPTH = 16;
type Entry = Record<string, unknown>;
type Binding = Pick<
	RelationRecordV1,
	"parentSessionId" | "parentSessionFile" | "anchorEntryId" | "rootToolCallId"
>;
type Capture =
	| { toolName: "subagent"; tasks: Array<{ agent: string; taskFirstLine?: string }> }
	| { toolName: "Agent"; subagentType: string };
type Active = Binding & { parentToolCallId: string; depth: number; startedAt: number; capture?: Capture };
// SAFETY: SDK session entries are plain JSON records; this read-only view does not mutate them.
const branchOf = (ctx: ExtensionContext) => ctx.sessionManager.getBranch() as unknown as Entry[];

function taskLine(task: unknown, file: string): string | undefined {
	const first = typeof task === "string" ? task.split(/\r?\n/, 1)[0] : undefined;
	if (!relationText(first)) return undefined;
	return projectSessionHoverTask(first, file);
}

function captureInput(toolName: string, args: unknown): Capture | undefined {
	if (!relationObject(args)) return undefined;
	if (toolName === "Agent") {
		if (!relationText(args.subagent_type) || (typeof args.resume === "string" && args.resume.trim()))
			return undefined;
		return { toolName, subagentType: args.subagent_type };
	}
	if (toolName !== "subagent") return undefined;
	const inputs = Array.isArray(args.tasks) && args.tasks.length ? args.tasks : [args];
	if (inputs.length > 8) return undefined;
	const tasks: Extract<Capture, { toolName: "subagent" }>["tasks"] = [];
	for (const input of inputs) {
		if (!relationObject(input) || !relationText(input.agent)) return undefined;
		const taskFirstLine = taskLine(input.task, "");
		tasks.push({ agent: input.agent, ...(taskFirstLine ? { taskFirstLine } : {}) });
	}
	return { toolName, tasks };
}

function candidate(item: Active, toolCallId: string, details: unknown): RelationRecordV1 | undefined {
	if (!item.capture || !relationObject(details)) return undefined;
	const base = {
		version: 1 as const,
		origin: "runtime" as const,
		parentSessionId: item.parentSessionId,
		parentSessionFile: item.parentSessionFile,
		anchorEntryId: item.anchorEntryId,
		rootToolCallId: item.rootToolCallId,
		toolCallId,
		parentToolCallId: item.parentToolCallId,
		toolName: item.capture.toolName,
		startedAt: item.startedAt,
		finishedAt: Math.max(Date.now(), item.startedAt),
	};
	if (item.capture.toolName === "Agent") {
		if (details.subagentType !== item.capture.subagentType) return undefined;
		return parseRelationRecord({
			...base,
			claim: {
				agentId: details.agentId,
				subagentType: details.subagentType,
				description: taskLine(details.description, "") ?? "",
				status: details.status,
			},
		});
	}
	if (
		!Array.isArray(details.results) ||
		details.results.length > 8 ||
		details.results.length !== item.capture.tasks.length
	)
		return undefined;
	const runs: NonNullable<RelationRecordV1["runs"]> = [];
	for (const [index, result] of details.results.entries()) {
		if (!relationObject(result)) continue;
		const requested = item.capture.tasks[index]!;
		if (!relationText(result.agent) || requested.agent.toLowerCase() !== result.agent.toLowerCase()) continue;
		const paths = relationObject(result.artifactPaths) ? result.artifactPaths : undefined;
		const sessionFile = result.sessionFile ?? paths?.jsonlPath;
		if (!relationText(sessionFile)) continue;
		const taskFirstLine = taskLine(result.task ?? requested.taskFirstLine, sessionFile);
		runs.push({
			agent: result.agent,
			sessionFile,
			...(taskFirstLine ? { taskFirstLine } : {}),
			...(typeof result.exitCode === "number" && Number.isFinite(result.exitCode)
				? { exitCode: result.exitCode }
				: {}),
		});
	}
	return runs.length ? parseRelationRecord({ ...base, runs }) : undefined;
}

/** SDK emits nested results before forwarding the end event; retain only non-context relation metadata. */
export function makeSubagentRelationsExtension(): InlineExtension {
	return {
		name: "subagent-relations",
		factory: (pi) => {
			const active = new Map<string, Active>();
			pi.on("tool_execution_start", (event, ctx) => {
				if (!event.parentToolCallId) return;
				if (
					!relationText(event.toolCallId) ||
					!relationText(event.parentToolCallId) ||
					active.size >= MAX_ACTIVE ||
					active.has(event.toolCallId)
				) {
					log.warn("嵌套关系映射无效或达到数量上限");
					return;
				}
				const parent = active.get(event.parentToolCallId);
				const anchorEntryId =
					parent?.anchorEntryId ?? findRelationAnchor(branchOf(ctx), event.parentToolCallId);
				const parentSessionFile = parent?.parentSessionFile ?? ctx.sessionManager.getSessionFile();
				const depth = (parent?.depth ?? 0) + 1;
				if (!anchorEntryId || !parentSessionFile || depth > MAX_DEPTH) {
					log.warn("嵌套关系无法锚定或达到深度上限", { toolCallId: event.toolCallId });
					return;
				}
				// Copy binding only: intermediate tools must not inherit their parent's capture/input.
				active.set(event.toolCallId, {
					parentSessionId: parent?.parentSessionId ?? ctx.sessionManager.getSessionId(),
					parentSessionFile,
					rootToolCallId: parent?.rootToolCallId ?? event.parentToolCallId,
					anchorEntryId,
					parentToolCallId: event.parentToolCallId,
					depth,
					startedAt: Date.now(),
					capture: captureInput(event.toolName, event.args),
				});
			});
			pi.on("tool_execution_end", (event, ctx) => {
				const item = active.get(event.toolCallId);
				active.delete(event.toolCallId);
				if (
					!item?.capture ||
					event.parentToolCallId !== item.parentToolCallId ||
					event.toolName !== item.capture.toolName
				)
					return;
				try {
					const record = candidate(
						item,
						event.toolCallId,
						relationObject(event.result) ? event.result.details : undefined,
					);
					if (!record) return;
					const branch = branchOf(ctx);
					if (
						ctx.sessionManager.getSessionId() !== item.parentSessionId ||
						backendSessionPathKey(ctx.sessionManager.getSessionFile() ?? "") !==
							backendSessionPathKey(item.parentSessionFile) ||
						findRelationAnchor(branch, item.rootToolCallId) !== item.anchorEntryId
					) {
						log.warn("父会话或分支锚点已变化，跳过关系记录", { toolCallId: event.toolCallId });
						return;
					}
					const key = relationRecordKey(record);
					for (const entry of branch) {
						if (entry.type !== "custom" || entry.customType !== SUBAGENT_RELATION_CUSTOM_TYPE) continue;
						const existing = parseRelationRecord(entry.data);
						if (!existing || relationRecordKey(existing) !== key) continue;
						if (JSON.stringify(existing) !== JSON.stringify(record))
							log.warn("拒绝冲突的重复子代理关系", { toolCallId: event.toolCallId });
						return;
					}
					// No await from current-branch/identity check through append.
					pi.appendEntry(SUBAGENT_RELATION_CUSTOM_TYPE, record);
				} catch (error) {
					log.warn("无法持久化子代理关系", { error: String(error), toolCallId: event.toolCallId });
				}
			});
			pi.on("agent_settled", () => active.clear());
			pi.on("session_shutdown", () => active.clear());
			pi.on("session_start", () => active.clear());
		},
	};
}
