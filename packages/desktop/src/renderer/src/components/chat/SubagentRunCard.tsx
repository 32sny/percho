import { type MessageKey, useT } from "../../i18n";
import { withSessionSlide } from "../../lib/session-page-slide";
import { useSessionsStore } from "../../stores/sessions";
import type { SubagentRunUi } from "../../stores/transcript";

/** 子代理名展示：首字母大写，其余原样（不翻译、不改写） */
function displayName(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/** 紧凑 token 数：13200 → "13.2k token"（与 pi-subagents 自己的显示口径一致） */
function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
	return `${count} token`;
}

/** 单个子代理行：保留真实 Agent 名与关键元信息 + 右侧跳动三点胶囊（终态收成圆点）；有会话文件时可点击打开 */
function SubagentRunRow({ run }: { run: SubagentRunUi }) {
	const t = useT();
	// 走统一入口：它同步捕获父目标并只在「仍是最新导航意图」时记下返回关系（spec D4）
	const openSubagentSession = useSessionsStore((s) => s.openSubagentSession);

	// runner 创建会话文件后即回填 sessionFile；运行中同样允许打开只读检视页。
	const clickable = run.sessionFile != null;
	const statusLabel =
		run.status === "running"
			? t("message.subagent.running")
			: run.status === "queued"
				? t("message.subagent.queued")
				: run.status === "aborted"
					? t("message.subagent.aborted")
					: run.status === "error"
						? t("message.subagent.failed")
						: t("message.subagent.done");
	const agentLabel = run.index != null ? `${displayName(run.agent)} #${run.index}` : displayName(run.agent);

	return (
		<button
			type="button"
			disabled={!clickable}
			aria-label={`${agentLabel} · ${statusLabel}`}
			// 后台派工时这一行就是"派工回执"：agent id 是 steer_subagent / get_subagent_result
			// 的唯一凭据，但卡片本身不展示它（太长），挂 hover 提示里供复制。
			title={run.agentId ?? statusLabel}
			// 推入过渡：子代理页从右向左滑入（父页同时向左滑出，见 lib/session-page-slide.ts）
			onClick={() => {
				if (!clickable || !run.sessionFile) return;
				void withSessionSlide("push", () => openSubagentSession(run.sessionFile as string));
			}}
			className={`flex w-full items-center justify-between gap-2 py-1 text-left ${
				clickable ? "cursor-pointer rounded-md hover:bg-hover" : "cursor-default"
			} px-1.5 transition-colors`}
		>
			<span className="flex min-w-0 items-center gap-2">
				<span className="truncate text-ui-13 font-semibold text-ink">{agentLabel}</span>
				{run.thinkingLevel && (
					<span className="shrink-0 text-ui-11 text-ink-faint">
						{t(`thinkingLevels.${run.thinkingLevel}` as MessageKey)}
					</span>
				)}
				{run.model && <span className="shrink-0 text-ui-11 text-ink-faint">{run.model}</span>}
				{run.tokens != null && (
					<span className="shrink-0 text-ui-11 text-ink-faint">{formatTokens(run.tokens)}</span>
				)}
			</span>
			<span className="subagent-slot" aria-hidden="true">
				<span className="subagent-cap" data-state={run.status}>
					<span className="subagent-dots">
						<span className="subagent-dot" />
						<span className="subagent-dot" />
						<span className="subagent-dot" />
					</span>
				</span>
			</span>
		</button>
	);
}

/** subagent 独立行：子代理调用结果（工作中/完成/失败 + 点击打开子会话），不进工具折叠区 */
export function SubagentRunCard({ runs }: { runs: SubagentRunUi[] }) {
	return (
		<div className="mt-1">
			{runs.map((run) => (
				<SubagentRunRow key={run.key} run={run} />
			))}
		</div>
	);
}
