import type {
	SessionHoverPreviewResult,
	SessionHoverRelationChild,
	SessionHoverRoleCount,
	SessionMeta,
} from "@percho/shared";
import {
	type FocusEventHandler,
	type KeyboardEventHandler,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { type MessageKey, useI18nStore, useT } from "../../i18n";
import { withSessionSlide } from "../../lib/session-page-slide";
import { useEdgeFade } from "../../lib/use-edge-fade";
import { useProjectsStore } from "../../stores/projects";
import type { SessionHoverPreviewTarget } from "../../stores/session-hover-preview";
import { useSessionsStore } from "../../stores/sessions";
import { useParentTarget } from "../../stores/subagent-return";
import { useTranscriptStore } from "../../stores/transcript";
import { ArrowUpRightIcon, CheckIcon, CopyIcon } from "../icons";
import { type SessionStatus, sessionTitle, useSessionStatus } from "../session/session-status";
import { Tooltip } from "../ui/Tooltip";
import {
	positionSessionHoverCard,
	SESSION_HOVER_WIDTH,
	type SessionHoverPosition,
} from "./session-hover-position";
import { useSessionHoverPages } from "./useSessionHoverPages";

type HoverStatus = SessionStatus | "unloaded";
const STATUS_LABEL: Record<HoverStatus, MessageKey> = {
	attention: "sessionHover.status.attention",
	working: "sessionHover.status.working",
	done: "sessionHover.status.done",
	idle: "sessionHover.status.idle",
	unloaded: "sessionHover.status.unloaded",
};
// 状态 token 只给 glyph 着色；文案保持 ink-faint，深浅主题均可读，不把 done 包装成验收成功。
const STATUS_DOT: Record<HoverStatus, string> = {
	attention: "bg-warn",
	working: "bg-ink",
	done: "bg-ok",
	idle: "bg-ink-dim",
	unloaded: "border-[1.25px] border-border-strong",
};
// 子会话状态点只用主题 token；可访问状态另给 sr-only 文案，不只靠颜色。
const RELATION_DOT: Record<SessionHoverRelationChild["status"], string> = {
	running: "bg-accent motion-safe:animate-pulse",
	done: "bg-ok",
	error: "bg-err",
	unknown: "bg-ink-dim",
};
const RELATION_STATUS_LABEL: Record<SessionHoverRelationChild["status"], MessageKey> = {
	running: "sessionHover.relationStatus.running",
	done: "sessionHover.relationStatus.done",
	error: "sessionHover.relationStatus.error",
	unknown: "sessionHover.relationStatus.unknown",
};
const relationAgentName = (agent: string) => agent.charAt(0).toUpperCase() + agent.slice(1);

const UNAVAILABLE_LABEL: Record<
	Extract<SessionHoverPreviewResult, { status: "unavailable" }>["reason"],
	MessageKey
> = {
	not_found: "sessionHover.unavailable.notFound",
	identity_mismatch: "sessionHover.unavailable.identityMismatch",
	invalid_history: "sessionHover.unavailable.invalidHistory",
	read_failed: "sessionHover.unavailable.readFailed",
	limit_exceeded: "sessionHover.unavailable.limitExceeded",
	unsafe_projection: "sessionHover.unavailable.unsafeProjection",
};

/**
 * 用户主目录前缀折叠成 `~`：Windows `C:\Users\x` / `C:/Users/x`、Unix `/home/x`、`/Users/x`、`/root`。
 * 渲染端拿不到 os.homedir()，按真实路径形态判断；只影响展示，完整路径不写进 title/aria。
 */
export function compactHomePath(cwd: string): string {
	const trimmed = cwd.trim();
	if (!trimmed) return "";
	const folded = trimmed.replace(
		/^(?:[A-Za-z]:[\\/]Users[\\/][^\\/]+|\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=[\\/]|$)/,
		"~",
	);
	// 折叠后统一成 `/`：Windows 的 cwd 是反斜杠，否则会显示成 `~\Desktop\Percho`（原型是 `~/Desktop/Percho`）。
	// 仅影响展示，该字符串不参与导航，也不写进 title/aria。
	return folded.startsWith("~") ? folded.replace(/\\/g, "/") : folded;
}

/** 模型只展示最后一段（`provider/modelId` → `modelId`），标签本身不含分隔符时原样显示。 */
export function compactModelLabel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const segments = model.split("/").filter((segment) => segment.trim() !== "");
	return segments.at(-1);
}

/** 后端未返回 roleCounts 的旧数据兜底：按当前已加载子项聚合，不改 hidden/total。 */
function loadedRoleCounts(children: readonly SessionHoverRelationChild[]): SessionHoverRoleCount[] {
	const byRole = new Map<string, SessionHoverRoleCount>();
	for (const child of children) {
		const label = child.agent;
		const key = label.toLowerCase();
		if (!key.trim()) continue;
		const existing = byRole.get(key);
		if (existing) existing.count += 1;
		else byRole.set(key, { label, count: 1, status: child.status });
	}
	return [...byRole.values()];
}

export function SessionHoverCard({
	id,
	cardRef,
	anchor,
	session,
	previewTarget,
	onDismiss,
	onPointerEnter,
	onPointerLeave,
	onFocus,
	onBlur,
	onKeyDown,
}: {
	id: string;
	cardRef: RefObject<HTMLDivElement | null>;
	anchor: HTMLButtonElement;
	session: SessionMeta;
	/** Provider 传的实际预览目标（含 liveRuns 签名）；缺省退回 session 本身。 */
	previewTarget?: SessionHoverPreviewTarget;
	/** 外部关闭能力保留（卡片内不再有 × 按钮）：Esc/移开由 Provider 调用。 */
	onClose: () => void;
	/** 关系导航触发的关闭：不恢复触发行焦点，与关闭按钮的 onClose 分离。 */
	onDismiss: () => void;
	onPointerEnter: () => void;
	onPointerLeave: () => void;
	onFocus: FocusEventHandler<HTMLDivElement>;
	onBlur: FocusEventHandler<HTMLDivElement>;
	onKeyDown: KeyboardEventHandler<HTMLDivElement>;
}) {
	const t = useT();
	const language = useI18nStore((state) => state.language);
	const title = sessionTitle(session, t("projects.untitled"), t("projects.daily"));
	const liveStatus = useSessionStatus(session.sessionId);
	const hasTranscript = useTranscriptStore((state) => state.bySession[session.sessionId] !== undefined);
	const loaded = useSessionsStore((state) =>
		state.sessions.some((item) => item.sessionId === session.sessionId && item.cwd === session.cwd),
	);
	const status: HoverStatus = loaded && hasTranscript ? liveStatus : "unloaded";
	// hook 是预览请求所有者：接管 setTarget/累计分页；卡片不自行拼页或重算 hidden。
	const { preview, loadingMore, moreError, expanded, loadMore, expand, collapse } = useSessionHoverPages(
		previewTarget ?? session,
	);
	// 只展示后端认可的关系；卡片不自行读取/合并 transcript，也不重复截断或重算 hidden。
	const relations = preview?.relations;
	const children = relations?.children ?? [];
	const hidden = relations?.hidden ?? 0;
	const total = relations?.total ?? children.length + hidden;
	const roleCounts = relations?.roleCounts?.length ? relations.roleCounts : loadedRoleCounts(children);
	const latestChild = children[0];
	// 模型优先级：目标会话自己的 model → 旧 meta 的 modelLabel → 首问预览顺手读到的分支模型。
	const model = compactModelLabel(
		session.model
			? `${session.model.provider}/${session.model.modelId}`
			: (session.modelLabel ?? preview?.model),
	);
	// 目录只作展示，路径不进 DOM title/aria。
	const cwd = compactHomePath(session.cwd);
	const formatter = useMemo(
		() =>
			new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
			}),
		[language],
	);
	// 展开态底部把时间压缩成 `MM/DD HH:mm`，仍用同一份 Intl，不手写补零。
	const compactFormatter = useMemo(
		() =>
			new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
			}),
		[language],
	);
	const date = (timestamp: number | undefined) => {
		if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return null;
		const value = new Date(timestamp);
		return Number.isNaN(value.getTime())
			? null
			: { label: formatter.format(value), compact: compactFormatter.format(value), iso: value.toISOString() };
	};
	const created = date(session.createdAt);
	const modified = date(session.modifiedAt);
	const openSubagentSessionFrom = useSessionsStore((state) => state.openSubagentSessionFrom);
	const returnToParent = useSessionsStore((state) => state.returnToParent);
	// 父入口：内存返回目标优先；冷启动（无内存关系）用后端验证过的 parent DTO 作回退，不往 store 写。
	const rememberedParent = useParentTarget(session.sessionId);
	const parentDto = relations?.parent;
	const recoveredParent = parentDto
		? { parentSessionId: parentDto.sessionId, parentFile: parentDto.sessionFile, cwd: parentDto.cwd }
		: undefined;
	const parentTarget = rememberedParent ?? recoveredParent;
	const parentMeta = useSessionsStore((state) =>
		parentTarget ? state.sessions.find((item) => item.sessionId === parentTarget.parentSessionId) : undefined,
	);
	const parentHistory = useProjectsStore((state) =>
		parentTarget
			? state.allSessions.find((item) => item.sessionId === parentTarget.parentSessionId)
			: undefined,
	);
	const knownParent = parentMeta ?? parentHistory;
	// 标题优先现有 sessions/history，其次 DTO 已保存 name，最后本地化通用名；路径不进 DOM。
	const parentTitle = parentTarget
		? knownParent
			? sessionTitle(knownParent, t("projects.untitled"), t("projects.daily"))
			: (rememberedParent ? undefined : parentDto?.name) || t("sessionHover.parentUnknownTitle")
		: null;
	// 路径只作导航目标/React key，不进 DOM 属性、title、aria 或日志。
	const openChild = (child: SessionHoverRelationChild) => {
		onDismiss();
		void withSessionSlide("push", () =>
			openSubagentSessionFrom(
				{ sessionId: session.sessionId, sessionFile: session.sessionFile },
				child.sessionFile,
			),
		);
	};
	const openParent = () => {
		onDismiss();
		void withSessionSlide("pop", () =>
			returnToParent(session.sessionId, rememberedParent ? undefined : recoveredParent),
		);
	};

	// 分页焦点归还：收起后焦点回到「全部 N」触发钮；加载完最后一页时同样落到该钮（「显示更多」已消失）。
	const moreButtonRef = useRef<HTMLButtonElement | null>(null);
	const toggleButtonRef = useRef<HTMLButtonElement | null>(null);
	const pagingBefore = useRef<{ count: number; hidden: number; expanded: boolean } | null>(null);
	useLayoutEffect(() => {
		const before = pagingBefore.current;
		pagingBefore.current = { count: children.length, hidden, expanded };
		if (!before) return;
		const card = cardRef.current;
		if (!card) return;
		const active = document.activeElement;
		const focusLost = !(active instanceof HTMLElement) || !card.contains(active);
		if (!focusLost) return;
		if (before.expanded && !expanded) {
			toggleButtonRef.current?.focus();
		} else if (before.hidden > 0 && hidden === 0 && children.length > before.count) {
			toggleButtonRef.current?.focus();
		}
	});
	const requestMore = () => {
		if (loadingMore) return;
		void loadMore();
	};
	// 展开态列表的滚动边界淡出（收起时容器不挂载，ref 为 null，effect 自然空转）。
	const listRef = useRef<HTMLUListElement | null>(null);
	useEdgeFade(listRef);

	const [position, setPosition] = useState<SessionHoverPosition | null>(null);
	useLayoutEffect(() => {
		const element = cardRef.current;
		if (!element) return;
		const measure = () => {
			const next = positionSessionHoverCard(
				anchor.getBoundingClientRect(),
				{ width: SESSION_HOVER_WIDTH, height: element.getBoundingClientRect().height },
				{ width: window.innerWidth, height: window.innerHeight },
			);
			setPosition((before) =>
				before &&
				before.x === next.x &&
				before.y === next.y &&
				before.width === next.width &&
				before.maxHeight === next.maxHeight &&
				before.side === next.side
					? before
					: next,
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [anchor, cardRef]);

	const copyGeneration = useRef(0);
	const [copyFeedback, setCopyFeedback] = useState<{ title: string; status: "copied" | "failed" } | null>(
		null,
	);
	useEffect(
		() => () => {
			copyGeneration.current += 1;
		},
		[],
	);
	const feedback = copyFeedback?.title === title ? copyFeedback.status : null;
	const copyTitle = async () => {
		const generation = ++copyGeneration.current;
		let status: "copied" | "failed" = "copied";
		try {
			await navigator.clipboard.writeText(title);
		} catch {
			status = "failed";
		}
		if (generation === copyGeneration.current) setCopyFeedback({ title, status });
	};

	const question =
		preview?.status === "ok" && preview.text.trim() !== title.trim()
			? preview.text.replace(/\s+/g, " ").trim()
			: null;
	const showRelations = children.length > 0 || roleCounts.length > 0;
	// 无中日韩字符的首问（路径/英文指令）按原型的 mono 展示；中文提问保持正常字重。
	const questionMono = question !== null && !/[\u3400-\u9fff]/.test(question);
	const compactTime = [created?.compact, modified?.compact].filter(Boolean).join(" · ");

	return createPortal(
		<div
			ref={cardRef}
			id={id}
			role="dialog"
			aria-modal="false"
			aria-labelledby={`${id}-title`}
			tabIndex={-1}
			draggable={false}
			data-session-hover-card={session.sessionId}
			data-side={position?.side}
			className="no-drag thin-scrollbar fixed z-30 select-text overflow-x-hidden overscroll-contain rounded-xl bg-surface px-3.5 py-3 text-ink shadow-pop"
			style={{
				left: position?.x ?? 0,
				top: position?.y ?? 0,
				width: position?.width ?? `min(${SESSION_HOVER_WIDTH}px, calc(100vw - 16px))`,
				maxHeight: position?.maxHeight ?? "calc(100vh - 16px)",
				visibility: position ? "visible" : "hidden",
			}}
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
			onFocus={onFocus}
			onBlur={onBlur}
			onKeyDown={onKeyDown}
		>
			<div className="flex items-start gap-2">
				<h2
					id={`${id}-title`}
					className="min-w-0 flex-1 whitespace-pre-wrap text-ui-13 font-medium leading-[1.48] text-ink [overflow-wrap:anywhere]"
				>
					{title}
				</h2>
				<Tooltip label={t("sessionHover.copyTitle")} align="end">
					<button
						type="button"
						aria-label={t("sessionHover.copyTitle")}
						className="grid size-5.5 place-items-center rounded-md text-ink-faint hover:bg-hover hover:text-ink-2"
						onClick={() => void copyTitle()}
					>
						{feedback === "copied" ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
					</button>
				</Tooltip>
			</div>
			<p
				className="mt-1.25 flex min-w-0 items-center gap-1.25 overflow-hidden text-ui-11 text-ink-faint"
				data-session-hover-status={status}
			>
				<span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
				<span className="shrink-0 text-ink-dim">{t(STATUS_LABEL[status])}</span>
				{model && (
					<>
						<span aria-hidden="true" className="shrink-0">
							·
						</span>
						<span className="min-w-0 truncate font-mono text-ink-dim">{model}</span>
					</>
				)}
				{cwd && (
					<>
						<span aria-hidden="true" className="shrink-0">
							·
						</span>
						<span className="min-w-0 truncate font-mono">{cwd}</span>
					</>
				)}
			</p>
			{!preview ? (
				<p className="mt-2 text-ui-11 leading-relaxed text-ink-dim" role="status">
					{t("sessionHover.loading")}
				</p>
			) : preview.status === "unavailable" ? (
				<p className="mt-2 text-ui-11 leading-relaxed text-ink-dim" role="status">
					{t(UNAVAILABLE_LABEL[preview.reason])}
				</p>
			) : question ? (
				<div className="mt-1.75 flex items-center gap-1.5 rounded-lg bg-hover px-2 py-1.5">
					<span className="shrink-0 text-ui-11 text-ink-faint">{t("sessionHover.firstQuestionShort")}</span>
					<p
						className={`min-w-0 flex-1 truncate text-ui-115 text-ink-dim ${questionMono ? "font-mono" : ""}`}
					>
						{question}
					</p>
				</div>
			) : null}
			{showRelations && (
				<section className="mt-2.25" aria-labelledby={`${id}-children`}>
					<h3 id={`${id}-children`} className="sr-only">
						{t("sessionHover.children")}
					</h3>
					<div className="fade-rule" aria-hidden="true" />
					<div className="mt-2 flex min-w-0 items-center gap-1.25">
						<ul className="flex min-w-0 flex-1 flex-wrap items-center gap-1.25">
							{roleCounts.map((role) => (
								<li
									key={role.label.toLowerCase()}
									className="flex items-center gap-1 rounded-full bg-hover px-1.75 py-0.5 text-ui-11 text-ink-2"
								>
									<span
										aria-hidden="true"
										className={`size-1.5 shrink-0 rounded-full ${RELATION_DOT[role.status]}`}
									/>
									<span className="truncate">{relationAgentName(role.label)}</span>
									<span className="shrink-0 font-mono text-ink-faint">×{role.count}</span>
									<span className="sr-only">{t(RELATION_STATUS_LABEL[role.status])}</span>
								</li>
							))}
						</ul>
						<button
							ref={toggleButtonRef}
							type="button"
							aria-expanded={expanded}
							aria-controls={expanded ? `${id}-children-list` : undefined}
							aria-label={
								expanded
									? t("sessionHover.collapseAllHint")
									: t("sessionHover.expandAllHint", { count: total })
							}
							className="flex shrink-0 items-center gap-1 rounded-md bg-hover px-1.5 py-0.5 text-ui-11 font-medium text-ink-2"
							onClick={() => (expanded ? collapse() : expand())}
						>
							<span>{expanded ? t("sessionHover.collapse") : t("sessionHover.all", { count: total })}</span>
							<span aria-hidden="true">{expanded ? "▴" : "▾"}</span>
						</button>
					</div>
					{expanded ? (
						<>
							<ul
								ref={listRef}
								id={`${id}-children-list`}
								className="edge-fade mt-1 max-h-36 overflow-y-auto overscroll-contain"
							>
								{children.map((child) => {
									const name = relationAgentName(child.agent);
									return (
										<li key={child.sessionFile}>
											<button
												type="button"
												aria-label={
													child.taskFirstLine
														? t("sessionHover.openChildWithTask", { name, task: child.taskFirstLine })
														: t("sessionHover.openChild", { name })
												}
												className="grid h-6 w-full grid-cols-[64px_1fr_14px] items-center gap-1.5 rounded-md px-1.25 text-left hover:bg-hover"
												onClick={() => openChild(child)}
											>
												<span className="flex min-w-0 items-center gap-1.25">
													<span
														aria-hidden="true"
														className={`size-1.75 shrink-0 rounded-full ${RELATION_DOT[child.status]}`}
													/>
													<span className="truncate text-ui-12 font-medium text-ink-2">{name}</span>
												</span>
												<span className="min-w-0 truncate text-ui-11 text-ink-dim">
													{child.taskFirstLine ?? ""}
												</span>
												<ArrowUpRightIcon size={13} className="shrink-0 text-ink-faint" />
												<span className="sr-only">{t(RELATION_STATUS_LABEL[child.status])}</span>
											</button>
										</li>
									);
								})}
							</ul>
						</>
					) : (
						latestChild && (
							<button
								type="button"
								aria-label={
									latestChild.taskFirstLine
										? t("sessionHover.openChildWithTask", {
												name: relationAgentName(latestChild.agent),
												task: latestChild.taskFirstLine,
											})
										: t("sessionHover.openChild", { name: relationAgentName(latestChild.agent) })
								}
								className="mt-1.25 flex w-full items-center gap-1.5 rounded-lg bg-hover px-2 py-1.25 text-left hover:bg-hover"
								onClick={() => openChild(latestChild)}
							>
								<span className="shrink-0 text-ui-11 text-ink-faint">{t("sessionHover.latest")}</span>
								<span className="shrink-0 text-ui-12 font-medium text-ink-2">
									{relationAgentName(latestChild.agent)}
								</span>
								<span className="min-w-0 flex-1 truncate text-ui-11 text-ink-dim">
									{latestChild.taskFirstLine ?? ""}
								</span>
								<ArrowUpRightIcon size={13} className="shrink-0 text-ink-faint" />
								<span className="sr-only">{t(RELATION_STATUS_LABEL[latestChild.status])}</span>
							</button>
						)
					)}
				</section>
			)}
			{parentTarget && parentTitle && (
				<section className="mt-2.25" aria-labelledby={`${id}-parent`}>
					<h3 id={`${id}-parent`} className="sr-only">
						{t("sessionHover.parent")}
					</h3>
					<div className="fade-rule" aria-hidden="true" />
					<button
						type="button"
						aria-label={t("sessionHover.openParent", { title: parentTitle })}
						className="mt-1 flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-hover"
						onClick={openParent}
					>
						<span className="min-w-0 flex-1 truncate text-ui-11 text-ink-2">{parentTitle}</span>
						<ArrowUpRightIcon size={12} className="shrink-0 text-ink-faint" />
					</button>
				</section>
			)}
			{expanded ? (
				<div className="mt-1.5 flex items-center justify-between gap-2 text-ui-11">
					<div className="flex min-w-0 items-center gap-2">
						{hidden > 0 && (
							<button
								ref={moreButtonRef}
								type="button"
								aria-disabled={loadingMore || undefined}
								className={`rounded-md px-1 py-0.5 font-medium hover:bg-hover ${
									loadingMore ? "cursor-default text-ink-faint" : "text-ink-2"
								}`}
								onClick={requestMore}
							>
								{loadingMore
									? t("sessionHover.childrenLoadingMore")
									: t("sessionHover.childrenShowMore", { count: hidden })}
							</button>
						)}
						{moreError && (
							<p role="status" className="flex items-center gap-2 text-ink-dim">
								<span>{t("sessionHover.childrenMoreFailed")}</span>
								<button
									type="button"
									className="rounded-md px-1 py-0.5 text-ink-2 hover:bg-hover"
									onClick={requestMore}
								>
									{t("sessionHover.childrenRetry")}
								</button>
							</p>
						)}
					</div>
					{compactTime && <span className="shrink-0 font-mono text-ink-faint">{compactTime}</span>}
				</div>
			) : (
				(created || modified) && (
					<div className="mt-2 flex items-center justify-between gap-2 overflow-hidden text-ui-11 font-mono text-ink-faint">
						{created ? (
							<time className="min-w-0 truncate" dateTime={created.iso}>
								{t("sessionHover.created")} {created.label}
							</time>
						) : (
							<span />
						)}
						{modified ? (
							<time className="min-w-0 shrink-0 truncate" dateTime={modified.iso}>
								{t("sessionHover.modified")} {modified.compact}
							</time>
						) : null}
					</div>
				)
			)}
			{feedback && (
				<p role="status" className="mt-1 text-ui-11 text-ink-faint">
					{t(feedback === "copied" ? "sessionHover.copied" : "sessionHover.copyFailed")}
				</p>
			)}
		</div>,
		document.body,
	);
}
