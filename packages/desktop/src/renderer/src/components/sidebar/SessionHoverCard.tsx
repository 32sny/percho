import type { SessionHoverPreviewResult, SessionMeta } from "@percho/shared";
import {
	type FocusEventHandler,
	type KeyboardEventHandler,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { type MessageKey, useI18nStore, useT } from "../../i18n";
import { sessionHoverPreview, sessionHoverPreviewKey } from "../../stores/session-hover-preview";
import { useSessionsStore } from "../../stores/sessions";
import { useTranscriptStore } from "../../stores/transcript";
import { CheckIcon, CloseIcon, CopyIcon } from "../icons";
import { type SessionStatus, sessionTitle, useSessionStatus } from "../session/session-status";
import {
	positionSessionHoverCard,
	SESSION_HOVER_WIDTH,
	type SessionHoverPosition,
} from "./session-hover-position";

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
	onClose,
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
	onClose: () => void;
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
	const key = sessionHoverPreviewKey(session);
	const snapshot = useSyncExternalStore(
		sessionHoverPreview.subscribe,
		sessionHoverPreview.getSnapshot,
		sessionHoverPreview.getSnapshot,
	);
	const preview = snapshot?.key === key ? snapshot.result : null;

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
