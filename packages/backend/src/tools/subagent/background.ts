import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PerchoSubagentNotificationDetails, PerchoSubagentNotificationRun } from "@percho/shared";
import type { SubagentDefinition } from "./agents";
import { MAX_CONCURRENCY, runWithConcurrency } from "./concurrency";
import {
	createSubagentSessionManager,
	failedResult,
	formatRunSummary,
	pendingResult,
	type RunSubagentDeps,
	runSubagent,
	type SingleResult,
	type SubagentRunHandle,
} from "./runner";

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
	/**
	 * 批次收口投递。`triggerTurn: false` = 结果已被 subagent_wait / subagent_stop 同轮消费，
	 * 只落盘收尾卡片，不再唤醒父会话（否则父代理会对同一结果再汇报一轮）。
	 */
	onComplete?: (
		parentSessionId: string,
		notification: PerchoSubagentNotificationDetails,
		reportText: string,
		options: { triggerTurn: boolean },
	) => Promise<void>;
}

/** wake = 收口后唤醒父会话；silent = 只落盘（stop 主动停止）；none = 不投递（父会话将被删除） */
type BatchDelivery = "wake" | "silent" | "none";

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
	delivery: BatchDelivery;
	/** 正在 subagent_wait 该批次的调用数；收口时 >0 说明结果会经 wait 同轮返回 */
	waiters: number;
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
		const summary = formatRunSummary(slot.summary);
		if (summary) lines.push(summary);
		lines.push("");
	}
	lines.push("</subagent-notification>");
	return lines.join("\n");
}

export class BackgroundSubagentManager {
	private readonly batchesByParent = new Map<string, Map<string, InternalBatch>>();

	dispatch(input: BackgroundDispatchInput): { runId: string; results: SingleResult[] } {
		const runId = `bg_${randomUUID().slice(0, 8)}`;
		const controller = new AbortController();
		const preManagers = new Map<number, SessionManager>();
		// index → 占位 sessionId。用 Map 而非数组：数组只能靠「初始 running 恰好是前 N 个」的巧合对齐下标
		const placeholderIds = new Map<number, string>();
		const initialActiveCount = Math.min(MAX_CONCURRENCY, input.definitions.length);

		const slots: SingleResult[] = input.definitions.map(({ task, cwd, agent }, index) => {
			const isInitialRunning = index < initialActiveCount;
			let sessionFile: string | undefined;
			if (isInitialRunning) {
				const sm = createSubagentSessionManager(cwd);
				preManagers.set(index, sm);
				sessionFile = sm.getSessionFile();
				const placeholderId = sm.getSessionId();
				placeholderIds.set(index, placeholderId);
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
			return pendingResult(agent.name, task.task, isInitialRunning ? "running" : "queued", {
				...(input.definitions.length > 1 ? { index: index + 1 } : {}),
				...(sessionFile ? { jsonlPath: sessionFile } : {}),
			});
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
			delivery: "wake",
			waiters: 0,
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
		placeholderIds: Map<number, string>,
	): Promise<void> {
		try {
			await runWithConcurrency(
				input.definitions,
				MAX_CONCURRENCY,
				batch.controller.signal,
				async ({ task, cwd, agent }, index) => {
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
						result = failedResult(agent.name, task.task, error, {
							aborted: batch.controller.signal.aborted,
							startedAt,
							...(input.definitions.length > 1 ? { index: index + 1 } : {}),
							...(preManager ? { jsonlPath: preManager.getSessionFile() } : {}),
						});
					}
					// 起跑前就失败（runtime/资源加载/建会话抛错）走不到 runner 自己的注销，这里立即收掉占位，
					// 否则只读检视会把它当运行中一直显示「工作中」。按 id 删除，runner 已注销时幂等。
					const placeholderId = placeholderIds.get(index);
					if (placeholderId) input.deps.unregisterRun?.(placeholderId);
					batch.slots[index] = result;
					input.onUpdate?.(batch.parentSessionId, toNotification(batch));
				},
			);
		} finally {
			// 中止后从未领取的任务也有占位：批次收口一律注销（幂等）
			for (const id of placeholderIds.values()) input.deps.unregisterRun?.(id);
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
				if (batch.delivery !== "none") {
					await input.onComplete?.(batch.parentSessionId, notif, report, {
						triggerTurn: batch.delivery === "wake" && batch.waiters === 0,
					});
				}
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
		if (signal?.aborted) return { timedOut: true, batch: this.toSnapshot(batch) };
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
		batch.waiters++;
		try {
			await Promise.race(waitRace);
		} finally {
			batch.waiters--;
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
			if (batch.delivery === "wake") batch.delivery = "silent";
			batch.controller.abort();
			await batch.donePromise;
		}
		return { stopped: true, batch: this.toSnapshot(batch) };
	}

	/** 按 runId 取批次的实时通知快照（历史回放据此收口后台卡片）；本进程不认识的批次返回 null。 */
	resolveNotification(runId: string): PerchoSubagentNotificationDetails | null {
		for (const parentMap of this.batchesByParent.values()) {
			const batch = parentMap.get(runId);
			if (batch) return toNotification(batch);
		}
		return null;
	}

	hasRunning(parentSessionId: string): boolean {
		const parentMap = this.batchesByParent.get(parentSessionId);
		if (!parentMap) return false;
		for (const batch of parentMap.values()) {
			if (batch.status === "running") return true;
		}
		return false;
	}

	async abortForParent(parentSessionId: string): Promise<void> {
		const parentMap = this.batchesByParent.get(parentSessionId);
		if (!parentMap) return;
		const running = [...parentMap.values()].filter((b) => b.status === "running");
		for (const batch of running) {
			batch.delivery = "none";
			batch.controller.abort();
		}
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
