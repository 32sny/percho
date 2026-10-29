import type { SessionHoverPreviewResult, SessionHoverRelationChild, SessionMeta } from "@percho/shared";
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
import { useProjectsStore } from "../../stores/projects";
import type { SessionHoverPreviewTarget } from "../../stores/session-hover-preview";
import { useSessionsStore } from "../../stores/sessions";
import { useParentTarget } from "../../stores/subagent-return";
import { useTranscriptStore } from "../../stores/transcript";
import { ArrowUpRightIcon, CheckIcon, CloseIcon, CopyIcon } from "../icons";
import { type SessionStatus, sessionTitle, useSessionStatus } from "../session/session-status";
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
// 状态 token 只给 glyph 着色；文案保持 ink-2，深浅主题均可读，不把 done 包装成验收成功。
const STATUS_DOT: Record<HoverStatus, string> = {
	attention: "bg-warn",
	working: "bg-ink",
	done: "bg-ok",
	idle: "bg-ink-dim",
	unloaded: "border border-border-strong",
};
// 子会话行状态点只用主题 token；可访问状态另给 sr-only 文案，不只靠颜色。
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

export function SessionHoverCard({
	id,
	cardRef,
	anchor,
	session,
	previewTarget,
	onClose,
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
	// model 优先于可能来自旧 meta 的 modelLabel；绝不读取 lastUsedModel/activeSessionId 的模型。
	const model = session.model ? `${session.model.provider}/${session.model.modelId}` : session.modelLabel;
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
	const date = (timestamp: number | undefined) => {
		if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return null;
		const value = new Date(timestamp);
		return Number.isNaN(value.getTime())
			? null
			: { label: formatter.format(value), iso: value.toISOString() };
	};
	const created = date(session.createdAt);
	const modified = date(session.modifiedAt);
	const openSubagentSessionFrom = useSessionsStore((state) => state.openSubagentSessionFrom);
	const returnToParent = useSessionsStore((state) => state.returnToParent);
	// hook 是预览请求所有者：接管 setTarget/累计分页；卡片不自行拼页或重算 hidden。
	const { preview, loadingMore, moreError, expanded, loadMore, collapse } = useSessionHoverPages(
		previewTarget ?? session,
	);
	// 只展示后端认可的关系；卡片不自行读取/合并 transcript，也不重复截断或重算 hidden。
	const relations = preview?.relations;
	const children = relations?.children ?? [];
	const hidden = relations?.hidden ?? 0;
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

	// 分页焦点归还：加载完最后一页「显示更多」消失时焦点给「收起」；收起后焦点回到「显示更多」或首个子行。
	const moreButtonRef = useRef<HTMLButtonElement | null>(null);
	const collapseButtonRef = useRef<HTMLButtonElement | null>(null);
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
			(moreButtonRef.current ?? card.querySelector<HTMLButtonElement>("li button"))?.focus();
		} else if (before.hidden > 0 && hidden === 0 && children.length > before.count) {
			collapseButtonRef.current?.focus();
		}
	});
	const requestMore = () => {
		if (loadingMore) return;
		void loadMore();
	};

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

	return createPortal(
		<div
			ref={cardRef}
			id={id}
			role="dialog"
			aria-modal="false"
			aria-labelledby={`${id}-title`}
			aria-describedby={`${id}-hint`}
			tabIndex={-1}
			draggable={false}
			data-session-hover-card={session.sessionId}
			data-side={position?.side}
			className="no-drag thin-scrollbar fixed z-30 select-text overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl border border-border bg-surface p-3.5 text-ink shadow-pop"
			style={{
				left: position?.x ?? 0,
				top: position?.y ?? 0,
				width: position?.width ?? "min(360px, calc(100vw - 16px))",
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
					className="min-w-0 flex-1 whitespace-pre-wrap text-ui-14 font-medium leading-relaxed text-ink [overflow-wrap:anywhere]"
				>
					{title}
				</h2>
				<button
					type="button"
					aria-label={t("sessionHover.copyTitle")}
					title={t("sessionHover.copyTitle")}
					className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-dim hover:bg-hover hover:text-ink"
					onClick={() => void copyTitle()}
				>
					{feedback === "copied" ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
				</button>
				<button
					type="button"
					aria-label={t("common.close")}
					title={t("common.close")}
					className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-dim hover:bg-hover hover:text-ink"
					onClick={onClose}
				>
					<CloseIcon size={12} />
				</button>
			</div>
			<p className="mt-2 flex items-center gap-2 text-ui-12 text-ink-2" data-session-hover-status={status}>
				<span aria-hidden="true" className={`h-[7px] w-[7px] shrink-0 rounded-full ${STATUS_DOT[status]}`} />
				{t(STATUS_LABEL[status])}
			</p>
			{!preview ? (
				<p className="mt-3 text-ui-12 leading-relaxed text-ink-dim" role="status">
					{t("sessionHover.loading")}
				</p>
			) : preview.status === "unavailable" ? (
				<p className="mt-3 text-ui-12 leading-relaxed text-ink-dim" role="status">
					{t(UNAVAILABLE_LABEL[preview.reason])}
				</p>
			) : preview.status === "ok" && preview.text.trim() !== title.trim() ? (
				<section className="mt-3 border-t border-border pt-3" aria-labelledby={`${id}-question`}>
					<h3 id={`${id}-question`} className="text-ui-12 text-ink-dim">
						{t("sessionHover.firstQuestion")}
					</h3>
					<p className="mt-1.5 whitespace-pre-wrap text-ui-13 leading-relaxed text-ink-2 [overflow-wrap:anywhere]">
						{preview.text}
					</p>
				</section>
			) : null}
			{children.length > 0 && (
				<section className="mt-3 border-t border-border pt-3" aria-labelledby={`${id}-children`}>
					<h3 id={`${id}-children`} className="text-ui-12 text-ink-dim">
						{t("sessionHover.children")}
					</h3>
					<ul className="mt-1.5">
						{children.map((child, index) => {
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
										aria-describedby={`${id}-child-status-${index}`}
										className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-hover"
										onClick={() => openChild(child)}
									>
										<span
											aria-hidden="true"
											className={`h-[7px] w-[7px] shrink-0 rounded-full ${RELATION_DOT[child.status]}`}
										/>
										<span className="min-w-0 flex-1">
											<span className="whitespace-pre-wrap text-ui-13 leading-relaxed text-ink-2 [overflow-wrap:anywhere]">
												{name}
											</span>
											{child.taskFirstLine && (
												<span className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-ui-12 leading-relaxed text-ink-dim [overflow-wrap:anywhere]">
													{child.taskFirstLine}
												</span>
											)}
										</span>
										<span id={`${id}-child-status-${index}`} className="sr-only">
											{t(RELATION_STATUS_LABEL[child.status])}
										</span>
										<ArrowUpRightIcon size={14} className="shrink-0 text-ink-dim" />
									</button>
								</li>
							);
						})}
					</ul>
					{moreError && (
						<p
							role="status"
							className="mt-1 flex items-center gap-2 px-1.5 text-ui-12 leading-relaxed text-ink-dim"
						>
							<span>{t("sessionHover.childrenMoreFailed")}</span>
							<button
								type="button"
								className="rounded-md px-1.5 py-0.5 text-ink-2 hover:bg-hover"
								onClick={requestMore}
							>
								{t("sessionHover.childrenRetry")}
							</button>
						</p>
					)}
					{(hidden > 0 || expanded) && (
						<div className="mt-1 flex items-center gap-2 px-1.5">
							{hidden > 0 && (
								<button
									ref={moreButtonRef}
									type="button"
									aria-disabled={loadingMore || undefined}
									className={`rounded-md px-1.5 py-0.5 text-ui-12 leading-relaxed hover:bg-hover ${
										loadingMore ? "cursor-default text-ink-dim" : "text-ink-2"
									}`}
									onClick={requestMore}
								>
									{loadingMore
										? t("sessionHover.childrenLoadingMore")
										: t("sessionHover.childrenShowMore", { count: hidden })}
								</button>
							)}
							{expanded && (
								<button
									ref={collapseButtonRef}
									type="button"
									className="rounded-md px-1.5 py-0.5 text-ui-12 leading-relaxed text-ink-2 hover:bg-hover"
									onClick={() => collapse()}
								>
									{t("sessionHover.childrenCollapse")}
								</button>
							)}
						</div>
					)}
				</section>
			)}
			{parentTarget && parentTitle && (
				<section className="mt-3 border-t border-border pt-3" aria-labelledby={`${id}-parent`}>
					<h3 id={`${id}-parent`} className="text-ui-12 text-ink-dim">
						{t("sessionHover.parent")}
					</h3>
					<button
						type="button"
						aria-label={t("sessionHover.openParent", { title: parentTitle })}
						className="mt-1.5 flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-hover"
						onClick={openParent}
					>
						<span className="min-w-0 flex-1 whitespace-pre-wrap text-ui-13 leading-relaxed text-ink-2 [overflow-wrap:anywhere]">
							{parentTitle}
						</span>
						<ArrowUpRightIcon size={14} className="shrink-0 text-ink-dim" />
					</button>
				</section>
			)}
			<dl className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2 border-t border-border pt-3 text-ui-12 leading-relaxed">
				{model && (
					<>
						<dt className="text-ink-dim">{t("sessionHover.model")}</dt>
						<dd className="min-w-0 whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{model}</dd>
					</>
				)}
				<dt className="text-ink-dim">{t("sessionHover.directory")}</dt>
				<dd className="min-w-0 whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{session.cwd}</dd>
				{created && (
					<>
						<dt className="text-ink-dim">{t("sessionHover.created")}</dt>
						<dd className="min-w-0 text-ink-2 [overflow-wrap:anywhere]">
							<time dateTime={created.iso}>{created.label}</time>
						</dd>
					</>
				)}
				{modified && (
					<>
						<dt className="text-ink-dim">{t("sessionHover.modified")}</dt>
						<dd className="min-w-0 text-ink-2 [overflow-wrap:anywhere]">
							<time dateTime={modified.iso}>{modified.label}</time>
						</dd>
					</>
				)}
			</dl>
			<p id={`${id}-hint`} className="mt-3 text-ui-11 text-ink-dim">
				{t("sessionHover.cardHint")}
			</p>
			{feedback && (
				<p role="status" className="mt-1 text-ui-12 text-ink-2">
					{t(feedback === "copied" ? "sessionHover.copied" : "sessionHover.copyFailed")}
				</p>
			)}
		</div>,
		document.body,
	);
}
