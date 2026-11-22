import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PerchoSubagentNotificationDetails, PerchoSubagentNotificationRun } from "@percho/shared";
import type { SubagentDefinition } from "./agents";
import {
	createSubagentSessionManager,
	type RunSubagentDeps,
	runSubagent,
	type SingleResult,
	type SubagentRunHandle,
} from "./runner";

const MAX_CONCURRENCY = 4;
const MAX_RECENT_BATCHES_PER_PARENT = 50;
const MAX_REPORT_CONTENT = 24_000;

export interface BackgroundBatchSnapshot {
	runId: string;
	parentSessionId: string;
	mode: "single" | "parallel";
	status: "running" | "done" | "error" | "aborted";
	startedAt: number;
	finishedAt?: number;
	results: SingleResult[];
}

export interface BackgroundDispatchInput {
	parentSessionId: string;
	mode: "single" | "parallel";
	definitions: Array<{
		task: { agent: string; task: string; cwd?: string };
		cwd: string;
		agent: SubagentDefinition;
	}>;
	projectTrusted: boolean;
	model?: Model<any>;
	deps: RunSubagentDeps;
	onUpdate?: (parentSessionId: string, notification: PerchoSubagentNotificationDetails) => void;
	onComplete?: (
		parentSessionId: string,
		notification: PerchoSubagentNotificationDetails,
		reportText: string,
	) => Promise<void>;
}

interface InternalBatch {
	runId: string;
	parentSessionId: string;
	mode: "single" | "parallel";
	status: "running" | "done" | "error" | "aborted";
	startedAt: number;
	finishedAt?: number;
	slots: SingleResult[];
	controller: AbortController;
	donePromise: Promise<void>;
	resolveDone: () => void;
}

function cloneResult(result: SingleResult): SingleResult {
	return {
		...result,
		usage: { ...result.usage, totalTokens: { ...result.usage.totalTokens } },
		artifactPaths: { ...result.artifactPaths },
	};
}

function toUiStatus(status: SingleResult["status"]): PerchoSubagentNotificationRun["status"] {
	if (status === "queued" || status === "running" || status === "done" || status === "aborted") {
		return status;
	}
	return "error";
}

function toNotification(batch: InternalBatch): PerchoSubagentNotificationDetails {
	return {
		runId: batch.runId,
		mode: batch.mode,
		status: batch.status,
		runs: batch.slots.map((slot) => ({
			runId: batch.runId,
			...(slot.index != null ? { index: slot.index } : {}),
			agent: slot.agent,
			status: toUiStatus(slot.status),
			...(slot.artifactPaths.jsonlPath ? { sessionFile: slot.artifactPaths.jsonlPath } : {}),
			...(slot.exitCode >= 0 ? { exitCode: slot.exitCode } : {}),
			...(slot.error ? { error: slot.error } : {}),
			...(slot.usage.totalTokens.tokens > 0 ? { tokens: slot.usage.totalTokens.tokens } : {}),
			...(slot.summary ? { summary: slot.summary } : {}),
		})),
	};
}

function formatBackgroundReport(batch: InternalBatch): string {
	const lines: string[] = [
		`<subagent-notification runId="${batch.runId}" mode="${batch.mode}" status="${batch.status}">`,
	];
	for (const slot of batch.slots) {
		const label = slot.index != null ? `[${slot.index}] ${slot.agent}` : slot.agent;
		const status = toUiStatus(slot.status);
		lines.push(`## ${label} (${status})`);
		if (slot.artifactPaths.jsonlPath) lines.push(`sessionFile: ${slot.artifactPaths.jsonlPath}`);
		if (slot.error) {
			lines.push(`Error: ${slot.error}`);
		} else if (slot.content) {
			const body =
				slot.content.length <= MAX_REPORT_CONTENT
					? slot.content
					: `${slot.content.slice(0, MAX_REPORT_CONTENT)}\n[truncated]`;
			lines.push(body);
		}
		if (slot.summary) {
			const s = slot.summary;
			if (s.changedFiles.length > 0) {
				lines.push(
					`Changed files: ${s.changedFiles.map((f) => `${f.path} (+${f.added}/-${f.removed})`).join(", ")}`,
				);
			}
			if (s.commands.length > 0) {
				lines.push(`Commands: ${s.commands.length} (${s.failedCommands} failed)`);
			}
			lines.push(`Duration: ${(s.durationMs / 1000).toFixed(1)}s`);
		}
		lines.push("");
	}
	lines.push("</subagent-notification>");
	return lines.join("\n");
}

async function runWithConcurrency<T>(
	items: readonly T[],
	limit: number,
	signal: AbortSignal,
	worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	const consume = async () => {
		while (cursor < items.length) {
			if (signal.aborted) return;
			const index = cursor++;
			const item = items[index];
			if (item === undefined) return;
			await worker(item, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
}

export class BackgroundSubagentManager {
	private readonly batchesByParent = new Map<string, Map<string, InternalBatch>>();

	dispatch(input: BackgroundDispatchInput): { runId: string; results: SingleResult[] } {
		const runId = `bg_${randomUUID().slice(0, 8)}`;
		const controller = new AbortController();
		const preManagers = new Map<number, SessionManager>();
		const placeholderIds: string[] = [];
		const initialActiveCount = Math.min(MAX_CONCURRENCY, input.definitions.length);

		const slots: SingleResult[] = input.definitions.map(({ task, cwd, agent }, index) => {
			const isInitialRunning = index < initialActiveCount;
			let sessionFile: string | undefined;
			if (isInitialRunning) {
				const sm = createSubagentSessionManager(cwd);
				preManagers.set(index, sm);
				sessionFile = sm.getSessionFile();
				const placeholderId = sm.getSessionId();
				placeholderIds.push(placeholderId);
				const placeholder: SubagentRunHandle = {
					sessionId: placeholderId,
					sessionFile,
					cwd,
					getBranch: () => sm.getBranch(),
					isStreaming: () => true,
					abort: async () => {
						controller.abort();
					},
				};
				input.deps.registerRun?.(placeholder);
			}
			return {
				agent: agent.name,
				task: task.task,
				status: isInitialRunning ? "running" : "queued",
				...(input.definitions.length > 1 ? { index: index + 1 } : {}),
				exitCode: -1,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: { tokens: 0 } },
				artifactPaths: sessionFile ? { jsonlPath: sessionFile } : {},
			};
		});

		let resolveDone!: () => void;
		const donePromise = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const batch: InternalBatch = {
			runId,
			parentSessionId: input.parentSessionId,
			mode: input.mode,
			status: "running",
			startedAt: Date.now(),
			slots,
			controller,
			donePromise,
			resolveDone,
		};

		let parentMap = this.batchesByParent.get(input.parentSessionId);
		if (!parentMap) {
			parentMap = new Map();
			this.batchesByParent.set(input.parentSessionId, parentMap);
		}
		parentMap.set(runId, batch);

		void this.executeBatch(batch, input, preManagers, placeholderIds);
		return { runId, results: slots.map(cloneResult) };
	}

	private async executeBatch(
		batch: InternalBatch,
		input: BackgroundDispatchInput,
		preManagers: Map<number, SessionManager>,
		placeholderIds: string[],
	): Promise<void> {
		const startedIndices = new Set<number>();
		try {
			await runWithConcurrency(
				input.definitions,
				MAX_CONCURRENCY,
				batch.controller.signal,
				async ({ task, cwd, agent }, index) => {
					startedIndices.add(index);
					const startedAt = Date.now();
					const preManager = preManagers.get(index);
					let result: SingleResult;
					try {
						result = await runSubagent(input.deps, {
							agent,
							task: task.task,
							cwd,
							projectTrusted: input.projectTrusted,
							...(input.definitions.length > 1 ? { index: index + 1 } : {}),
							model: input.model,
							signal: batch.controller.signal,
							...(preManager ? { sessionManager: preManager } : {}),
							onProgress: (progress) => {
								batch.slots[index] = progress;
								input.onUpdate?.(batch.parentSessionId, toNotification(batch));
							},
						});
					} catch (error) {
						result = {
							agent: agent.name,
							task: task.task,
							status: batch.controller.signal.aborted ? "aborted" : "failed",
							...(input.definitions.length > 1 ? { index: index + 1 } : {}),
							summary: {
								changedFiles: [],
								commands: [],
								failedCommands: 0,
								durationMs: Date.now() - startedAt,
							},
							exitCode: 1,
							error: error instanceof Error ? error.message : String(error),
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								cost: 0,
								totalTokens: { tokens: 0 },
							},
							artifactPaths: preManager ? { jsonlPath: preManager.getSessionFile() } : {},
						};
					}
					batch.slots[index] = result;
					input.onUpdate?.(batch.parentSessionId, toNotification(batch));
				},
			);
		} finally {
			for (let i = 0; i < placeholderIds.length; i++) {
				if (!startedIndices.has(i)) {
					const id = placeholderIds[i];
					if (id) input.deps.unregisterRun?.(id);
				}
			}
			for (let i = 0; i < batch.slots.length; i++) {
				const slot = batch.slots[i];
				if (slot && (slot.status === "queued" || slot.status === "running")) {
					batch.slots[i] = {
						...slot,
						status: batch.controller.signal.aborted ? "aborted" : "failed",
						exitCode: 1,
						error: slot.error ?? (batch.controller.signal.aborted ? "aborted" : "failed"),
					};
				}
			}
			const allAborted = batch.slots.length > 0 && batch.slots.every((s) => s.status === "aborted");
			const anyFailed = batch.slots.some(
				(s) => s.status === "failed" || s.status === "aborted" || s.exitCode !== 0,
			);
			batch.status = allAborted ? "aborted" : anyFailed ? "error" : "done";
			batch.finishedAt = Date.now();
			this.pruneCompleted(batch.parentSessionId);
			const notif = toNotification(batch);
			const report = formatBackgroundReport(batch);
			try {
				await input.onComplete?.(batch.parentSessionId, notif, report);
			} catch {
				// 通知投递失败不得阻塞后台批次收口
			} finally {
				batch.resolveDone();
			}
		}
	}

	private pruneCompleted(parentSessionId: string): void {
		const parentMap = this.batchesByParent.get(parentSessionId);
		if (!parentMap || parentMap.size <= MAX_RECENT_BATCHES_PER_PARENT) return;
		for (const [id, batch] of parentMap) {
			if (parentMap.size <= MAX_RECENT_BATCHES_PER_PARENT) break;
			if (batch.status !== "running") parentMap.delete(id);
		}
	}

	private toSnapshot(batch: InternalBatch): BackgroundBatchSnapshot {
		return {
			runId: batch.runId,
			parentSessionId: batch.parentSessionId,
			mode: batch.mode,
			status: batch.status,
			startedAt: batch.startedAt,
			...(batch.finishedAt != null ? { finishedAt: batch.finishedAt } : {}),
			results: batch.slots.map(cloneResult),
		};
	}

	list(parentSessionId: string, runId?: string): BackgroundBatchSnapshot[] {
		const parentMap = this.batchesByParent.get(parentSessionId);
		if (!parentMap) return [];
		if (runId) {
			const batch = parentMap.get(runId);
			return batch ? [this.toSnapshot(batch)] : [];
		}
		return [...parentMap.values()].map((b) => this.toSnapshot(b));
	}

	async wait(
		parentSessionId: string,
		runId: string,
		timeoutMs = 120_000,
		signal?: AbortSignal,
	): Promise<{ timedOut: boolean; batch?: BackgroundBatchSnapshot }> {
		const batch = this.batchesByParent.get(parentSessionId)?.get(runId);
		if (!batch) return { timedOut: false };
		if (batch.status !== "running") return { timedOut: false, batch: this.toSnapshot(batch) };
		let timer: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		const waitRace: Array<Promise<void>> = [batch.donePromise];
		if (timeoutMs > 0) {
			waitRace.push(
				new Promise<void>((resolve) => {
					timer = setTimeout(() => {
						timedOut = true;
						resolve();
					}, timeoutMs);
				}),
			);
		}
		let onAbort: (() => void) | undefined;
		if (signal) {
			if (signal.aborted) return { timedOut: true, batch: this.toSnapshot(batch) };
			waitRace.push(
				new Promise<void>((resolve) => {
					onAbort = () => {
						timedOut = true;
						resolve();
					};
					signal.addEventListener("abort", onAbort, { once: true });
				}),
			);
		}
		try {
			await Promise.race(waitRace);
		} finally {
			if (timer) clearTimeout(timer);
			if (onAbort && signal) signal.removeEventListener("abort", onAbort);
		}
		return { timedOut, batch: this.toSnapshot(batch) };
	}

	async stop(
		parentSessionId: string,
		runId: string,
	): Promise<{ stopped: boolean; batch?: BackgroundBatchSnapshot }> {
		const batch = this.batchesByParent.get(parentSessionId)?.get(runId);
		if (!batch) return { stopped: false };
		if (batch.status === "running") {
			batch.controller.abort();
			await batch.donePromise;
		}
		return { stopped: true, batch: this.toSnapshot(batch) };
	}

	hasRunning(parentSessionId: string): boolean {
		const parentMap = this.batchesByParent.get(parentSessionId);
		if (!parentMap) return false;
		for (const batch of parentMap.values()) {
			if (batch.status === "running") return true;
		}
		return false;
	}

	snapshotForParent(parentSessionId: string): PerchoSubagentNotificationDetails[] {
		const parentMap = this.batchesByParent.get(parentSessionId);
		if (!parentMap) return [];
		return [...parentMap.values()].map((batch) => toNotification(batch));
	}

	async abortForParent(parentSessionId: string): Promise<void> {
		const parentMap = this.batchesByParent.get(parentSessionId);
		if (!parentMap) return;
		const running = [...parentMap.values()].filter((b) => b.status === "running");
		for (const batch of running) batch.controller.abort();
		await Promise.allSettled(running.map((b) => b.donePromise));
		this.batchesByParent.delete(parentSessionId);
	}

	async disposeAll(): Promise<void> {
		const allRunning: InternalBatch[] = [];
		for (const parentMap of this.batchesByParent.values()) {
			for (const batch of parentMap.values()) {
				if (batch.status === "running") {
					batch.controller.abort();
					allRunning.push(batch);
				}
			}
		}
		await Promise.allSettled(allRunning.map((b) => b.donePromise));
		this.batchesByParent.clear();
	}
}
