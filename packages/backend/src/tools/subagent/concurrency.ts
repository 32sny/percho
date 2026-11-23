import { SUBAGENT_MAX_CONCURRENCY } from "@percho/shared";

/**
 * 子代理并发闸（前台 subagent 与后台批次共用同一份实现与上限）。
 *
 * 之前 `tool.ts` 的 `withConcurrency` 与 `background.ts` 的 `runWithConcurrency` 是两份逐行相同的
 * 副本，`MAX_CONCURRENCY = 4` 也各写一次——调上限必须记得改两处，是典型的分叉风险。
 * 上限本身放在 shared：reducer 按它区分初始 running/queued 占位。
 */
export const MAX_CONCURRENCY = SUBAGENT_MAX_CONCURRENCY;

/**
 * 以固定并发跑完 items：worker 抛错会向上冒泡（调用方自行 try/catch），
 * `signal.aborted` 时不再领取新项，但已在跑的项不受影响（取消要靠 worker 自己把 signal 传下去）。
 */
export async function runWithConcurrency<T>(
	items: readonly T[],
	limit: number,
	signal: AbortSignal | undefined,
	worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	const consume = async () => {
		while (cursor < items.length) {
			if (signal?.aborted) return;
			const index = cursor++;
			const item = items[index];
			if (item === undefined) return;
			await worker(item, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
}
