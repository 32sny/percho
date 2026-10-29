import type { SessionHoverLiveRun } from "@percho/shared";

/**
 * 仅用于进程内缓存分桶的四路 32 位指纹，附规范输入长度；不是签名/权限凭据。
 * 保留四个最终混合字，不把任务正文留在 LRU key 中，也不引入浏览器异步摘要队列。
 */
export function hoverLiveFingerprint(runs: readonly SessionHoverLiveRun[] | undefined): string | null {
	if (!runs?.length) return null;
	const input = JSON.stringify(
		runs.map((run) => [
			run.sessionFile,
			run.agent,
			run.task ?? null,
			run.status,
			run.exitCode ?? null,
			run.source,
		]),
	);
	let a = 1779033703,
		b = 3144134277,
		c = 1013904242,
		d = 2773480762;
	for (let i = 0; i < input.length; i++) {
		const code = input.charCodeAt(i);
		a = b ^ Math.imul(a ^ code, 597399067);
		b = c ^ Math.imul(b ^ code, 2869860233);
		c = d ^ Math.imul(c ^ code, 951274213);
		d = a ^ Math.imul(d ^ code, 2716044179);
	}
	a = Math.imul(c ^ (a >>> 18), 597399067);
	b = Math.imul(d ^ (b >>> 22), 2869860233);
	c = Math.imul(a ^ (c >>> 17), 951274213);
	d = Math.imul(b ^ (d >>> 19), 2716044179);
	return `${input.length}:${[a, b, c, d].map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("")}`;
}
