import { collectSessionHoverLiveRuns, type SessionMeta } from "@percho/shared";
import {
	createContext,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useT } from "../../i18n";
import { useProjectsStore } from "../../stores/projects";
import { type SessionHoverPreviewTarget, sessionHoverPreview } from "../../stores/session-hover-preview";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { useTranscriptStore } from "../../stores/transcript";
import { SessionHoverCard } from "./SessionHoverCard";

export interface SessionHoverTarget {
	sessionId: string;
	cwd: string;
	element: HTMLButtonElement;
}

const OPEN_DELAY = 300;
const CLOSE_DELAY = 200;

export function collectChangedSessionIds<T extends { sessionId: string }>(
	before: readonly T[],
	after: readonly T[],
): string[] {
	const previous = new Map(before.map((item) => [item.sessionId, item]));
	const next = new Map(after.map((item) => [item.sessionId, item]));
	const changed: string[] = [];
	for (const id of new Set([...previous.keys(), ...next.keys()])) {
		if (previous.get(id) !== next.get(id)) changed.push(id);
	}
	return changed;
}

export function collectTranscriptInvalidationIds(
	before: Record<string, { messages: unknown[]; agentActive: boolean } | undefined>,
	after: Record<string, { messages: unknown[]; agentActive: boolean } | undefined>,
): string[] {
	const changed: string[] = [];
	for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const previous = before[id];
		const next = after[id];
		if (previous === next) continue;
		const historyChanged =
			previous?.messages !== next?.messages &&
			(!next?.agentActive || previous?.messages.length !== next.messages.length);
		if (historyChanged || (previous?.agentActive && !next?.agentActive)) changed.push(id);
	}
	return changed;
}

/** UI 计时状态机独立于 React：稳定快照、可测计时，不用 effect 相互写 state 来维持开关。 */
export function createSessionHoverController({
	canOpen = () => true,
	onClose = () => {},
}: {
	canOpen?: (target: SessionHoverTarget) => boolean;
	onClose?: () => void;
} = {}) {
	let current: SessionHoverTarget | null = null;
	let opened: SessionHoverTarget | null = null;
	let pointerRow: HTMLButtonElement | null = null;
	let focusedRow: HTMLButtonElement | null = null;
	let pointerInCard = false;
	let focusInCard = false;
	let restoringFocus = false;
	let suppressed: HTMLButtonElement | null = null;
	let enabled = true;
	let openTimer: ReturnType<typeof setTimeout> | undefined;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	const listeners = new Set<() => void>();

	function clearOpen(): void {
		clearTimeout(openTimer);
		openTimer = undefined;
	}
	function clearClose(): void {
		clearTimeout(closeTimer);
		closeTimer = undefined;
	}
	function publish(target: SessionHoverTarget | null): void {
		if (opened === target) return;
		opened = target;
		if (!target) onClose();
		for (const listener of listeners) listener();
	}
	function dismiss(suppress = true): void {
		if (suppress && current) suppressed = current.element;
		clearOpen();
		clearClose();
		current = null;
		pointerInCard = false;
		focusInCard = false;
		publish(null);
	}
	function isInside(): boolean {
		return (
			!!current &&
			(pointerRow === current.element || focusedRow === current.element || pointerInCard || focusInCard)
		);
	}
	function maybeClose(): void {
		if (isInside()) {
			clearClose();
			return;
		}
		clearOpen();
		if (!opened) {
			current = null;
			return;
		}
		if (closeTimer === undefined) {
			closeTimer = setTimeout(() => {
				closeTimer = undefined;
				if (!isInside()) dismiss(false);
			}, CLOSE_DELAY);
		}
	}
	function show(target: SessionHoverTarget): void {
		if (!enabled || suppressed === target.element || !canOpen(target)) {
			dismiss();
			return;
		}
		clearOpen();
		clearClose();
		publish(target);
	}
	function enter(target: SessionHoverTarget, keyboard: boolean): void {
		if (!enabled || suppressed === target.element || !canOpen(target)) return;
		const same =
			current?.element === target.element &&
			current.sessionId === target.sessionId &&
			current.cwd === target.cwd;
		clearClose();
		if (!same) {
			clearOpen();
			publish(null); // 目标变化立刻作废旧卡；300ms 后才为新卡请求数据
			pointerInCard = false;
			focusInCard = false;
			current = target;
		}
		if (keyboard) show(current ?? target);
		else if (!opened && openTimer === undefined) {
			openTimer = setTimeout(() => {
				openTimer = undefined;
				if (current && isInside()) show(current);
			}, OPEN_DELAY);
		}
	}

	return {
		getSnapshot: () => opened,
		getTarget: () => current,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		pointerEnter(target: SessionHoverTarget): void {
			pointerRow = target.element;
			if (suppressed !== target.element) suppressed = null;
			enter(target, false);
		},
		pointerLeave(element: HTMLButtonElement): void {
			if (pointerRow === element) pointerRow = null;
			if (suppressed === element) suppressed = null;
			maybeClose();
		},
		focusRow(target: SessionHoverTarget): void {
			focusedRow = target.element;
			if (restoringFocus) return;
			// 真正重新聚焦是新意图；Escape/关闭按钮主动还焦点则通过 restoreFocus 保持抑制。
			if (suppressed === target.element) suppressed = null;
			enter(target, true); // 键盘直接可查看；不把焦点从行移进卡片
		},
		restoreFocus(focus: () => void): void {
			restoringFocus = true;
			try {
				focus();
			} finally {
				restoringFocus = false;
			}
		},
		blurRow(element: HTMLButtonElement): void {
			if (focusedRow === element) focusedRow = null;
			if (suppressed === element) suppressed = null;
			maybeClose();
		},
		enterCard(): void {
			if (!opened) return;
			pointerInCard = true;
			clearClose();
		},
		leaveCard(): void {
			pointerInCard = false;
			maybeClose();
		},
		focusCard(): void {
			if (!opened) return;
			focusInCard = true;
			clearClose();
		},
		blurCard(): void {
			focusInCard = false;
			maybeClose();
		},
		dismiss,
		setEnabled(value: boolean): void {
			enabled = value;
			if (!enabled) dismiss();
		},
		reset(): void {
			dismiss(false);
			pointerRow = null;
			focusedRow = null;
			suppressed = null;
		},
	};
}

type HoverController = ReturnType<typeof createSessionHoverController>;
interface HoverContext {
	controller: HoverController;
	opened: SessionHoverTarget | null;
	cardId: string;
	helpId: string;
	focusCard: (element: HTMLButtonElement) => boolean;
}
const SessionHoverContext = createContext<HoverContext | null>(null);
export const useSessionHover = () => useContext(SessionHoverContext);

function isVisible(element: HTMLElement): boolean {
	return (
		element.isConnected &&
		!element.closest('[hidden], [inert], [aria-hidden="true"]') &&
		element.getClientRects().length > 0 &&
		getComputedStyle(element).visibility !== "hidden"
	);
}

/** Trust 在 App 的局部 state 中，不能只订阅 settings.open；同时观察宿主实际模态语义。 */
function hasBlockingModal(): boolean {
	return [...document.querySelectorAll<HTMLElement>('[aria-modal="true"], dialog[open]')].some(isVisible);
}

function tabStops(root: ParentNode): HTMLElement[] {
	return [
		...root.querySelectorAll<HTMLElement>(
			'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]',
		),
	].filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && isVisible(element));
}

/**
 * 挂在 Sidebar 一次。Portal 是列表的兄弟分支，不在 SessionRow button 的 React 子树里，
 * 因而卡内点击/选择/复制不会冒泡触发行选择。所有关闭监听都只改变浮层，不拦截原行操作。
 */
export function SessionHoverProvider({
	children,
	sessions,
	disabled = false,
}: {
	children: ReactNode;
	/** Sidebar 当前投影：名称、模型和元数据随 store 更新，不保存进入时的 SessionMeta 快照。 */
	sessions: readonly SessionMeta[];
	disabled?: boolean;
}) {
	const t = useT();
	const cardId = useId();
	const helpId = `${cardId}-help`;
	const cardRef = useRef<HTMLDivElement>(null);
	const settingsOpen = useSettingsStore((state) => state.open);
	const [controller] = useState(() =>
		createSessionHoverController({
			canOpen: (target) => isVisible(target.element) && !hasBlockingModal(),
			onClose: () => sessionHoverPreview.setTarget(null),
		}),
	);
	const opened = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
	const session = opened
		? sessions.find((item) => item.sessionId === opened.sessionId && item.cwd === opened.cwd)
		: undefined;
	const messages = useTranscriptStore((state) =>
		opened ? state.bySession[opened.sessionId]?.messages : undefined,
	);
	const streamingRuns = useTranscriptStore((state) =>
		opened ? state.bySession[opened.sessionId]?.streaming?.subagentRuns : undefined,
	);
	const liveRuns = useMemo(
		() =>
			collectSessionHoverLiveRuns(
				messages || streamingRuns
					? { messages: messages ?? [], streaming: streamingRuns ? { subagentRuns: streamingRuns } : null }
					: undefined,
			),
		[messages, streamingRuns],
	);
	const previewTarget = useMemo<SessionHoverPreviewTarget | null>(
		() =>
			opened && session && !disabled && !settingsOpen
				? {
						sessionId: session.sessionId,
						cwd: session.cwd,
						modifiedAt: session.modifiedAt,
						messageCount: session.messageCount,
						...(liveRuns.length ? { liveRuns } : {}),
					}
				: null,
		[opened, session, disabled, settingsOpen, liveRuns],
	);

	useLayoutEffect(() => {
		controller.setEnabled(!disabled && !settingsOpen);
	}, [controller, disabled, settingsOpen]);
	useLayoutEffect(() => {
		if (opened && (!session || !isVisible(opened.element))) controller.dismiss();
	}, [controller, opened, session]);

	useEffect(() => {
		const dismiss = () => controller.dismiss();
		const onPointerDown = (event: PointerEvent) => {
			const node = event.target;
			if (
				node instanceof Node &&
				(cardRef.current?.contains(node) || controller.getTarget()?.element.contains(node))
			)
				return;
			dismiss();
		};
		const onScroll = (event: Event) => {
			// scroll 不冒泡但本监听是 capture；务必先豁免卡片及其内部滚动节点。
			if (event.target instanceof Node && cardRef.current?.contains(event.target)) return;
			dismiss();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			const target = controller.getTarget();
			if (!target) return;
			const returnFocus = cardRef.current?.contains(document.activeElement);
			dismiss(); // 先抑制，再恢复焦点；focus 事件不能马上开回原卡
			if (returnFocus && isVisible(target.element) && !hasBlockingModal()) {
				controller.restoreFocus(() => target.element.focus({ preventScroll: true }));
			}
			event.preventDefault();
			event.stopPropagation();
		};
		const observer = new MutationObserver(() => {
			const target = controller.getTarget();
			if (target && (!isVisible(target.element) || hasBlockingModal())) dismiss();
		});
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["aria-modal", "inert", "hidden", "aria-hidden", "open"],
		});
		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", dismiss);
		window.addEventListener("contextmenu", dismiss, true);
		window.addEventListener("dragstart", dismiss, true);
		window.addEventListener("blur", dismiss);
		window.addEventListener("keydown", onKeyDown, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", dismiss);
			window.removeEventListener("contextmenu", dismiss, true);
			window.removeEventListener("dragstart", dismiss, true);
			window.removeEventListener("blur", dismiss);
			window.removeEventListener("keydown", onKeyDown, true);
			controller.reset();
		};
	}, [controller]);

	useEffect(() => {
		// 订阅生命周期，而不是依赖各菜单操作自觉清缓存；不改 projects/sessions 的业务行为。
		const invalidateMetas = (
			before: readonly SessionMeta[],
			after: readonly SessionMeta[],
			catalog: boolean,
		) => {
			if (sessionHoverPreview.getSessionIds().length === 0) return;
			const changedIds = collectChangedSessionIds(before, after);
			if (!changedIds.length) return;
			const target = controller.getTarget();
			if (target && changedIds.includes(target.sessionId)) {
				const oldMeta = before.find((item) => item.sessionId === target.sessionId);
				const newMeta = after.find((item) => item.sessionId === target.sessionId);
				if (
					(catalog && !newMeta) ||
					(newMeta && newMeta.cwd !== target.cwd) ||
					(oldMeta && newMeta && oldMeta.sessionFile !== newMeta.sessionFile)
				)
					controller.dismiss();
			}
			sessionHoverPreview.invalidateMany(changedIds, true);
		};
		const offProjects = useProjectsStore.subscribe((state, previous) => {
			if (state.loading && !previous.loading) sessionHoverPreview.invalidate();
			if (state.allSessions !== previous.allSessions) {
				invalidateMetas(previous.allSessions, state.allSessions, true);
			}
		});
		const offSessions = useSessionsStore.subscribe((state, previous) => {
			if (state.activeSessionId !== previous.activeSessionId) controller.dismiss();
			if (state.sessions !== previous.sessions) invalidateMetas(previous.sessions, state.sessions, false);
		});
		const offTranscript = useTranscriptStore.subscribe((state, previous) => {
			if (sessionHoverPreview.getSessionIds().length === 0) return;
			const changedIds = collectTranscriptInvalidationIds(previous.bySession, state.bySession);
			if (changedIds.length) sessionHoverPreview.invalidateMany(changedIds, true);
		});
		return () => {
			offProjects();
			offSessions();
			offTranscript();
			sessionHoverPreview.setTarget(null);
			sessionHoverPreview.invalidate();
		};
	}, [controller]);

	const context = useMemo<HoverContext>(
		() => ({
			controller,
			opened,
			cardId,
			helpId,
			focusCard: (element) => {
				if (controller.getSnapshot()?.element !== element || !cardRef.current) return false;
				cardRef.current.focus({ preventScroll: true });
				return document.activeElement === cardRef.current;
			},
		}),
		[controller, opened, cardId, helpId],
	);

	const closeCard = () => {
		const target = controller.getTarget();
		const returnFocus = cardRef.current?.contains(document.activeElement);
		controller.dismiss();
		if (returnFocus && target && isVisible(target.element) && !hasBlockingModal()) {
			controller.restoreFocus(() => target.element.focus({ preventScroll: true }));
		}
	};
	const onCardKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey || !opened) return;
		const root = cardRef.current;
		if (!root) return;
		const stops = tabStops(root);
		if (event.shiftKey && (event.target === root || event.target === stops[0])) {
			if (isVisible(opened.element)) {
				event.preventDefault();
				opened.element.focus({ preventScroll: true });
			}
		} else if (!event.shiftKey && (stops.length === 0 || event.target === stops[stops.length - 1])) {
			// Portal 位于 body 尾部，但逻辑 Tab 序仍接在触发行后；不循环困在卡片里。
			const outside = tabStops(document).filter((element) => !root.contains(element));
			const index = outside.indexOf(opened.element);
			const next = index >= 0 ? outside[index + 1] : undefined;
			controller.dismiss();
			if (next) {
				event.preventDefault();
				next.focus();
			}
		}
	};

	return (
		<SessionHoverContext.Provider value={context}>
			{children}
			<span id={helpId} className="sr-only">
				{t("sessionHover.keyboardHint")}
			</span>
			{opened && session && !disabled && !settingsOpen && (
				<SessionHoverCard
					key={JSON.stringify([opened.sessionId, opened.cwd])}
					id={cardId}
					cardRef={cardRef}
					anchor={opened.element}
					session={session}
					previewTarget={previewTarget ?? undefined}
					onDismiss={controller.dismiss}
					onClose={closeCard}
					onPointerEnter={controller.enterCard}
					onPointerLeave={controller.leaveCard}
					onFocus={controller.focusCard}
					onBlur={(event) => {
						if (!event.currentTarget.contains(event.relatedTarget)) controller.blurCard();
					}}
					onKeyDown={onCardKeyDown}
				/>
			)}
		</SessionHoverContext.Provider>
	);
}
