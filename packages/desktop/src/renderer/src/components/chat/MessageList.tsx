import {
	buildChatRows,
	type ChatRow,
	deriveTurnChanges,
	deriveTurnTimings,
	isAgentWorking,
	type SessionNavigationEntry,
} from "@percho/shared";
import {
	type CSSProperties,
	type MouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useT } from "../../i18n";
import { useEdgeFade } from "../../lib/use-edge-fade";
import { Slot } from "../../plugins/Slot";
import { UI_SLOTS } from "../../plugins/slots";
import {
	getSessionHistoryWindow,
	historyOpenEpoch,
	loadHistoryThrough,
	loadOlderSessionHistory,
	loadSessionNavigation,
	useSessionHistoryWindow,
} from "../../stores/session-history";
import { useSessionWorkspaceStore } from "../../stores/session-workspace";
import { useSessionsStore } from "../../stores/sessions";
import { selectTranscript, useTranscriptStore } from "../../stores/transcript";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { SessionViewContext } from "../ui/DeferredDetails";
import { CenterOrb } from "./CenterOrb";
import { HistoryImageRootProvider } from "./history-image/history-image-root";
import { thumbnailService } from "./history-image/history-image-service";
import { MessageItem } from "./MessageItem";
import { MessageRail } from "./MessageRail";
import { MetaGroup } from "./MetaGroup";
import { type RailNode, railNodes, turnsInView } from "./message-rail";
import { RetryNote } from "./RetryNote";
import { type RowKind, RowPositions } from "./row-positions";
import { SelectionToolbar } from "./SelectionToolbar";
import { SubagentRunCard } from "./SubagentRunCard";
import { scrollIntentIsCurrent } from "./scroll-intent";
import { TurnDiffChip } from "./TurnDiffChip";
import { useNativeSelectionRange } from "./use-native-selection-range";
import { restoreRowAnchor, useRowGeometry } from "./use-row-geometry";
import { useShownWorking } from "./use-shown-working";
import { windowFor } from "./virtual-window";

/** 距底 ≤ 此值视为「在底部」，自动恢复跟随 */
const BOTTOM_THRESHOLD = 48;
/** 行间距：与内容列 gap-6 一致（行测量取 margin box，间距由位置索引统一加） */
const ROW_GAP = 24;
/** 距顶 ≤ 此值且还有更早历史：请求下一页（与旧挂载窗口的触发距离一致） */
const HISTORY_TRIGGER_PX = 1000;
/** 跳转目标落在视口顶下方的距离 */
const JUMP_OFFSET = 12;

const rowKind = (row: ChatRow): RowKind =>
	row.kind === "message"
		? row.message.kind === "user"
			? "user"
			: row.message.kind === "assistant"
				? "assistant"
				: "other"
		: row.kind === "metaGroup"
			? "metaGroup"
			: row.kind === "turnDiff"
				? "turnDiff"
				: "other";

/**
 * 中央消息流：最大宽度 760px 居中。
 * 合并规则：assistant 消息的思考/工具全部并入一个折叠组，正文（text）是边界。
 *
 * 底部跟随：ResizeObserver 监听内容/容器尺寸，跟随中即时贴底；仅「向上滚动」脱离跟随，
 * 回到底部恢复；用户发出新消息与切换会话时强制回底。
 *
 * 有界渲染（#110）：只渲染视口和附近行，其余用上下占位撑出高度；120 行是常态预算，
 * 超大视口可超过预算。行高按 key 缓存，未测行用估算，位置查询走前缀树。
 * 锚定仍交给浏览器原生滚动锚定（占位不参与选锚，见下），视口上方行的异步定型（Monaco、图片）
 * 与窗口移动都由它补偿；顶部前插及测量失效使用实际偏移补差。
 */
export function MessageList() {
	const t = useT();
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const transcript = useTranscriptStore((s) => selectTranscript(s, activeSessionId));
	const streaming = transcript.streaming;
	const historyWindow = useSessionHistoryWindow(activeSessionId);
	const historyGeneration = historyWindow?.generation;
	const hasOlder = historyWindow?.hasOlder ?? false;
	const agentWorking = isAgentWorking(transcript);

	const centerOrbEnabled = useUiPreferencesStore((s) => s.centerOrbEnabled);
	const sessionRailEnabled = useUiPreferencesStore((s) => s.sessionRailEnabled);
	const hasWorkspaceMembers = useSessionWorkspaceStore((s) => s.members.length > 0);
	const railInset = sessionRailEnabled && hasWorkspaceMembers ? 24 : 0;
	const codeFontSize = useUiPreferencesStore((s) => s.codeFontSize);
	const uiFontSize = useUiPreferencesStore((s) => s.uiFontSize);
	const shownWorking = useShownWorking(
		agentWorking,
		transcript.compacting || Boolean(streaming?.text) || !transcript.agentActive,
		activeSessionId,
	);

	const scrollRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const [historyImageRoot, setHistoryImageRoot] = useState<HTMLElement | null>(null);
	const attachScroller = useCallback((element: HTMLDivElement | null) => {
		scrollRef.current = element;
		setHistoryImageRoot((previous) => (previous === element ? previous : element));
	}, []);
	useEdgeFade(scrollRef, "top");
	const intentRef = useRef<
		| { kind: "following" | "reading"; sequence: number }
		| {
				kind: "jump";
				sequence: number;
				phase: "waiting" | "aligning";
				key?: string;
				tries: number;
				smooth: boolean;
		  }
	>({ kind: "following", sequence: 0 });
	const jumpCleanupRef = useRef<(() => void) | null>(null);
	const bottomCleanupRef = useRef<(() => void) | null>(null);
	const followingRef = useRef(true);
	const [following, setFollowing] = useState(true);
	const lastScrollTopRef = useRef(0);
	const lastRemainingRef = useRef(0);

	const updateFollowing = useCallback((value: boolean) => {
		followingRef.current = value;
		setFollowing(value);
	}, []);

	const cancelIntent = useCallback(
		(kind: "following" | "reading") => {
			const previous = intentRef.current;
			intentRef.current = { kind, sequence: previous.sequence + 1 };
			jumpCleanupRef.current?.();
			jumpCleanupRef.current = null;
			const wasBottomScrolling = bottomCleanupRef.current !== null;
			bottomCleanupRef.current?.();
			if (previous.kind === "jump" || wasBottomScrolling) {
				const el = scrollRef.current;
				if (el) el.scrollTo({ top: el.scrollTop, behavior: "instant" });
			}
			updateFollowing(kind === "following");
		},
		[updateFollowing],
	);

	// Session ids are environment-qualified. Epoch also rejects close/reopen of the same id.
	const opening = activeSessionId ? historyOpenEpoch(activeSessionId) : 0;
	// biome-ignore lint/correctness/useExhaustiveDependencies: each identity change invalidates pending work
	useLayoutEffect(() => {
		cancelIntent("following");
		return () => cancelIntent("reading");
	}, [activeSessionId, opening, historyGeneration, cancelIntent]);

	const pinToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
		const el = scrollRef.current;
		if (!el) return;
		bottomCleanupRef.current?.();
		if (behavior === "smooth") {
			const cleanup = () => {
				clearTimeout(timer);
				el.removeEventListener("scrollend", cleanup);
				if (bottomCleanupRef.current === cleanup) bottomCleanupRef.current = null;
			};
			const timer = setTimeout(cleanup, 900);
			bottomCleanupRef.current = cleanup;
			el.addEventListener("scrollend", cleanup, { once: true });
		}
		el.scrollTo({ top: el.scrollHeight, behavior });
	}, []);

	const lastMessage = transcript.messages[transcript.messages.length - 1];
	const lastUserMessageId = lastMessage?.kind === "user" ? lastMessage.id : null;
	useEffect(() => {
		if (!lastUserMessageId) return;
		cancelIntent("following");
		pinToBottom();
	}, [lastUserMessageId, pinToBottom, cancelIntent]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: activeSessionId 是刻意的重跑触发器
	useEffect(() => {
		thumbnailService().reset();
	}, [activeSessionId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: activeSessionId 是刻意的重跑触发器（切换会话时重新贴底）
	useEffect(() => {
		updateFollowing(true);
		pinToBottom();
	}, [activeSessionId, historyGeneration, pinToBottom, updateFollowing]);

	const handleSummaryToggle = (e: MouseEvent) => {
		if (e.target instanceof Element && e.target.closest("summary")) cancelIntent("reading");
	};

	const turnChanges = useMemo(() => deriveTurnChanges(transcript.messages), [transcript.messages]);
	const turnTimings = useMemo(
		() => deriveTurnTimings(transcript.messages, transcript.runEndedAt),
		[transcript.messages, transcript.runEndedAt],
	);
	const lastTurnId = transcript.messages.findLast((message) => message.kind === "user")?.id;
	const lastTurnIndex = turnTimings.at(-1)?.turnIndex ?? null;
	const turnBaselineRef = useRef({
		sid: activeSessionId,
		generation: historyGeneration,
		last: lastTurnId,
		entering: null as string | null,
	});
	if (
		turnBaselineRef.current.sid !== activeSessionId ||
		turnBaselineRef.current.generation !== historyGeneration
	) {
		turnBaselineRef.current = {
			sid: activeSessionId,
			generation: historyGeneration,
			last: lastTurnId,
			entering: null,
		};
	} else if (turnBaselineRef.current.last !== lastTurnId) {
		const previous = turnBaselineRef.current.last;
		turnBaselineRef.current.entering =
			previous && transcript.messages.some((message) => message.id === previous)
				? (lastTurnId ?? null)
				: null;
		turnBaselineRef.current.last = lastTurnId;
	}
	const enteringTurn = turnBaselineRef.current.entering === lastTurnId ? lastTurnIndex : null;

	const rows = useMemo(
		() =>
			buildChatRows(
				{
					messages: transcript.messages,
					streaming,
					agentActive: transcript.agentActive,
					compacting: transcript.compacting,
					runEndedAt: transcript.runEndedAt,
				},
				String(activeSessionId),
				Date.now(),
				{
					turnChanges,
					turnTimings,
					enteringTurn,
				},
			),
		[
			transcript.messages,
			streaming,
			transcript.agentActive,
			transcript.compacting,
			transcript.runEndedAt,
			activeSessionId,
			turnChanges,
			turnTimings,
			enteringTurn,
		],
	);

	// 索引只属于当前会话和历史来源；切换或换代即释放。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 会话和来源代次决定索引身份
	const positions = useMemo(() => new RowPositions(ROW_GAP), [activeSessionId, historyGeneration]);
	useMemo(() => positions.sync(rows.map((row) => ({ key: row.key, kind: rowKind(row) }))), [positions, rows]);

	// —— 窗口 ——
	// 渲染区间由滚动位置算出；测量后高度变化也需要重算（state 只存触发计数，区间每次渲染现算）
	const anchorRef = useRef<{ key: string; top: number; owner: RowPositions } | null>(null);
	const geometryAnchorRef = useRef<{ key: string; owner: RowPositions } | null>(null);
	const [layoutTick, setLayoutTick] = useState(0);
	const viewportRef = useRef({ top: 0, height: 800 });
	const normalWindow = windowFor(
		positions,
		viewportRef.current.top,
		viewportRef.current.height,
		followingRef.current,
	);
	const selectionRange = useNativeSelectionRange(contentRef, positions);
	const anchorIndex =
		anchorRef.current?.owner === positions ? positions.indexOfKey(anchorRef.current.key) : -1;
	const geometryAnchorIndex =
		geometryAnchorRef.current?.owner === positions && intentRef.current.kind !== "jump"
			? positions.indexOfKey(geometryAnchorRef.current.key)
			: -1;
	const start = Math.min(
		normalWindow.start,
		selectionRange?.start ?? normalWindow.start,
		anchorIndex >= 0 ? anchorIndex : normalWindow.start,
		geometryAnchorIndex >= 0 ? geometryAnchorIndex : normalWindow.start,
	);
	const end = Math.max(
		normalWindow.end,
		selectionRange?.end ?? normalWindow.end,
		anchorIndex >= 0 ? anchorIndex + 1 : normalWindow.end,
		geometryAnchorIndex >= 0 ? geometryAnchorIndex + 1 : normalWindow.end,
	);
	const topSpacer = positions.offsetOf(start);
	const bottomSpacer =
		end > 0 && end < rows.length ? positions.total() - positions.offsetOf(end) + ROW_GAP : 0;
	const rendered = rows.slice(start, end);
	const windowRef = useRef({ start, end });
	windowRef.current = normalWindow;
	void layoutTick;

	/** 第 0 行顶在滚动容器内容坐标中的位置（容器顶 → 内容列内边距之下） */
	const rowTop = useCallback(() => {
		const content = contentRef.current;
		return content ? content.offsetTop + Number.parseFloat(getComputedStyle(content).paddingTop) : 0;
	}, []);
	const scheduleRef = useRef(0);
	/** 滚动/尺寸变化合并到一帧：读视口 → 必要时触发重渲染（区间变化才 setState） */
	const scheduleLayout = useCallback(() => {
		if (scheduleRef.current) return;
		scheduleRef.current = requestAnimationFrame(() => {
			scheduleRef.current = 0;
			const el = scrollRef.current;
			const content = contentRef.current;
			if (!el || !content) return;
			// 内容列的顶内边距在第 0 行之前：视口坐标换算到行坐标
			viewportRef.current = { top: el.scrollTop - rowTop(), height: el.clientHeight };
			// 跳转对齐期间由 alignJump 自己推进窗口，这里不重算（否则两边互相覆盖）
			if (intentRef.current.kind === "jump" && intentRef.current.phase === "aligning") return;
			const next = windowFor(positions, viewportRef.current.top, el.clientHeight, followingRef.current);
			if (next.start !== windowRef.current.start || next.end !== windowRef.current.end)
				setLayoutTick((n) => n + 1);
			setRailTick((n) => n + 1);
		});
	}, [positions, rowTop]);
	// 取消时必须清零：StrictMode 会卸载再挂载，残留的帧 id 会让 scheduleLayout 永远提前返回
	// biome-ignore lint/correctness/useExhaustiveDependencies: 索引变更时取消旧索引的待执行帧
	useLayoutEffect(
		() => () => {
			cancelAnimationFrame(scheduleRef.current);
			scheduleRef.current = 0;
		},
		[scheduleLayout],
	);

	useRowGeometry(
		contentRef,
		scrollRef,
		positions,
		`${uiFontSize}:${codeFontSize}`,
		rows,
		start,
		end,
		layoutTick,
		following,
		() => {
			setLayoutTick((n) => n + 1);
			scheduleLayout();
		},
		() => {
			if (followingRef.current) pinToBottom();
			scheduleLayout();
		},
		(key) => {
			geometryAnchorRef.current = key ? { key, owner: positions } : null;
		},
		() => intentRef.current.kind === "reading",
	);

	// 首次进入/切会话：窗口按「跟随=锁尾」计算；首帧后读真实视口
	// biome-ignore lint/correctness/useExhaustiveDependencies: 会话/代次变化是刻意触发器
	useLayoutEffect(() => {
		scheduleLayout();
	}, [activeSessionId, historyGeneration, scheduleLayout]);

	// —— 历史分页 ——
	const [failedWindow, setFailedWindow] = useState<typeof historyWindow>();
	const requestOlderHistory = (retry = false) => {
		if (!activeSessionId || !hasOlder || (!retry && failedWindow === historyWindow)) return;
		const sessionId = activeSessionId;
		const isCurrent = () =>
			useSessionsStore.getState().activeSessionId === sessionId &&
			historyOpenEpoch(sessionId) === opening &&
			intentRef.current.kind !== "jump";
		if (retry) setFailedWindow(undefined);
		void loadOlderSessionHistory(sessionId, isCurrent, captureAnchor).then((loaded) => {
			if (loaded === false && isCurrent() && getSessionHistoryWindow(sessionId) === historyWindow) {
				setFailedWindow(historyWindow);
			}
		});
	};
	// 前插的行在视口上方：浏览器原生锚定补偿；scrollTop===0 时 Chromium 不调整，这里按首个可见行补差
	const captureAnchor = () => {
		if (followingRef.current || intentRef.current.kind === "jump") return;
		const el = scrollRef.current;
		const content = contentRef.current;
		if (!el || !content) return;
		const box = el.getBoundingClientRect();
		for (const wrapper of content.querySelectorAll<HTMLElement>(":scope > [data-chat-row-key]")) {
			const rect = wrapper.firstElementChild?.getBoundingClientRect();
			if (rect && rect.height > 0 && rect.bottom > box.top) {
				anchorRef.current = {
					key: wrapper.dataset.chatRowKey ?? "",
					top: rect.top - box.top,
					owner: positions,
				};
				return;
			}
		}
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: 首行变化（前插）才需要补差
	useLayoutEffect(() => {
		if (anchorRef.current?.owner === positions)
			restoreRowAnchor(contentRef.current, scrollRef.current, anchorRef.current);
		anchorRef.current = null;
		scheduleLayout();
	}, [rows[0]?.key, historyGeneration]);

	const handleScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
		const atBottom = remaining <= BOTTOM_THRESHOLD;
		// 用户向上滚 = scrollTop 变小且距底变大。视口上方变矮时原生锚定也会减小 scrollTop，但距底不变；
		// 内容变矮夹位会落到底。两个量都在本次事件里读，不依赖可能过期的旧高度。
		const upward = el.scrollTop < lastScrollTopRef.current && remaining > lastRemainingRef.current + 1;
		// 跳转进行中（含按需加载历史的等待期）：不能因为「此刻还在底部」重新打开跟随，
		// 否则 ResizeObserver 会把前插的历史里的跳转拉回底部（实测重型会话点未加载节点不动）
		if (intentRef.current.kind !== "jump" && geometryAnchorRef.current?.owner !== positions) {
			if (atBottom) updateFollowing(true);
			else if (upward) updateFollowing(false);
			intentRef.current = {
				kind: atBottom ? "following" : followingRef.current ? "following" : "reading",
				sequence: intentRef.current.sequence,
			};
		}
		lastScrollTopRef.current = el.scrollTop;
		lastRemainingRef.current = remaining;
		scheduleLayout();
		// 触顶 = 真实滚动位置离「已加载第 0 行」很近。第 0 行的位置 = 内容列顶 + 0，不受窗口影响；
		// 不用「窗口 start===0」，它在下一帧才更新，连续滚轮时一直是旧值（实测停在 scrollTop 0 却不翻页）
		if (upward && el.scrollTop - rowTop() < HISTORY_TRIGGER_PX && intentRef.current.kind !== "jump") {
			requestOlderHistory();
		}
	};

	// —— Minimap ——
	const [navigation, setNavigation] = useState<{
		generation: string;
		entries: SessionNavigationEntry[];
	} | null>(null);
	useEffect(() => {
		if (!activeSessionId || !historyGeneration || !hasOlder) return;
		let live = true;
		void loadSessionNavigation(activeSessionId, historyGeneration).then((entries) => {
			if (live && entries) setNavigation({ generation: historyGeneration, entries });
		});
		return () => {
			live = false;
		};
	}, [activeSessionId, historyGeneration, hasOlder]);
	const entries = hasOlder && navigation?.generation === historyGeneration ? navigation?.entries : null;
	const nodes = useMemo(() => railNodes(rows, entries ?? null), [rows, entries]);
	const [railTick, setRailTick] = useState(0);
	void railTick;
	const viewTop = Math.max(0, viewportRef.current.top);
	// 视口内的轮次：由位置索引二分得到视口首末行，再映射到轮次（不依赖历史 DOM 是否挂载）。
	// 顶部判定线略过跳转偏移：跳到某轮后它的顶边在 12px，应算作在视口内的第一轮
	const firstVisible = positions.indexAt(viewTop + JUMP_OFFSET + 4);
	const lastVisible = positions.indexAt(viewTop + viewportRef.current.height - 1);
	const turns = turnsInView(nodes, firstVisible, lastVisible);
	const inViewFrom = turns?.from ?? -1;
	const inViewTo = turns?.to ?? -1;
	const inView = useMemo(
		() => (inViewFrom < 0 ? null : { from: inViewFrom, to: inViewTo }),
		[inViewFrom, inViewTo],
	);

	const jumpToNode = (node: RailNode, behavior: ScrollBehavior = "instant") => {
		if (!activeSessionId) return;
		cancelIntent("reading");
		const intent = {
			kind: "jump" as const,
			sequence: intentRef.current.sequence + 1,
			phase: "waiting" as "waiting" | "aligning",
			key: undefined as string | undefined,
			tries: 0,
			smooth: behavior === "smooth" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
		};
		intentRef.current = intent;
		const sid = activeSessionId;
		// This predicate is also the integration point for the cancellable pager (ticket 05).
		const isCurrent = scrollIntentIsCurrent(
			{ sessionId: sid, openEpoch: opening, historyGeneration, sequence: intent.sequence },
			() => {
				return {
					sessionId: useSessionsStore.getState().activeSessionId,
					openEpoch: historyOpenEpoch(sid),
					historyGeneration: getSessionHistoryWindow(sid)?.generation,
					sequence: intentRef.current.sequence,
				};
			},
		);
		let frame = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let listening: HTMLElement | null = null;
		const cleanup = () => {
			cancelAnimationFrame(frame);
			if (timer !== undefined) clearTimeout(timer);
			listening?.removeEventListener("scrollend", realign);
			listening = null;
		};
		const finish = () => {
			if (!isCurrent()) return;
			cleanup();
			jumpCleanupRef.current = null;
			intentRef.current = { kind: "reading", sequence: intent.sequence };
			scheduleLayout();
		};
		const queue = () => {
			if (isCurrent()) frame = requestAnimationFrame(align);
		};
		const realign = () => {
			cleanup();
			queue();
		};
		const align = () => {
			if (!isCurrent() || !intent.key) return;
			const el = scrollRef.current;
			const content = contentRef.current;
			if (!el || !content) return finish();
			const index = positions.indexOfKey(intent.key);
			if (index < 0) return finish();
			const target = content.querySelector(
				`:scope > [data-chat-row-key="${CSS.escape(intent.key)}"]`,
			)?.firstElementChild;
			if (target) {
				const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top - JUMP_OFFSET;
				if (intent.smooth && Math.abs(delta) > 1) {
					intent.smooth = false;
					el.scrollTo({ top: el.scrollTop + delta, behavior: "smooth" });
					listening = el;
					el.addEventListener("scrollend", realign, { once: true });
					timer = setTimeout(realign, 900);
					return;
				}
				if (Math.abs(delta) > 1) el.scrollTop += delta;
				intent.tries++;
				if (Math.abs(delta) <= 1 || intent.tries >= 4) return finish();
			} else {
				el.scrollTop = rowTop() + positions.offsetOf(index) - JUMP_OFFSET;
				intent.smooth = false;
				if (++intent.tries >= 8) return finish();
			}
			viewportRef.current = { top: el.scrollTop - rowTop(), height: el.clientHeight };
			setLayoutTick((n) => n + 1);
			queue();
		};
		jumpCleanupRef.current = cleanup;
		const start = (key: string) => {
			if (!isCurrent()) return;
			intent.phase = "aligning";
			intent.key = key;
			queue();
		};
		if (node.index >= 0) {
			const key = rows[node.index]?.key;
			if (key) start(key);
			else finish();
			return;
		}
		if (!node.entryId) return finish();
		const entryId = node.entryId;
		intent.smooth = false;
		void loadHistoryThrough(sid, entryId, isCurrent).then((ok) => {
			if (!isCurrent()) return;
			const row =
				ok &&
				useTranscriptStore
					.getState()
					.bySession[sid]?.messages.find((message) => message.kind === "user" && message.entryId === entryId);
			if (row) start(row.id);
			else finish();
		}, finish);
	};

	// Alt+↑/↓：跳到上一/下一条用户消息（参考 pi-gna 的 ⌥↑/⌥↓）。以视口内首轮为基准：
	// 向下 = 下一轮；向上 = 当前轮开头（已在开头则上一轮）。输入框有内容时让给输入框。
	useEffect(() => {
		const onReadingKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
			if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
			const target = event.target;
			if (
				target instanceof HTMLElement &&
				(target.isContentEditable || target.closest("input, textarea, select, button"))
			)
				return;
			if (target === document.body || (target instanceof Node && scrollRef.current?.contains(target)))
				cancelIntent("reading");
		};
		document.addEventListener("keydown", onReadingKey);
		return () => document.removeEventListener("keydown", onReadingKey);
	}, [cancelIntent]);

	const railKeys = useRef({ nodes, inView, jump: jumpToNode });
	railKeys.current = { nodes, inView, jump: jumpToNode };
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || !event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return;
			if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
			const target = event.target;
			if (target instanceof HTMLElement && target.isContentEditable && target.textContent) return;
			if ((target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) && target.value)
				return;
			const { nodes: list, inView: view, jump } = railKeys.current;
			if (list.length === 0) return;
			const current = view?.from ?? list.length - 1;
			let next = current;
			if (event.key === "ArrowDown") next = current + 1;
			else {
				const scroller = scrollRef.current;
				const start = list[current];
				const key = start && start.index >= 0 ? rows[start.index]?.key : undefined;
				const node = key
					? contentRef.current?.querySelector(`:scope > [data-chat-row-key="${CSS.escape(key)}"]`)
							?.firstElementChild
					: undefined;
				const offset =
					node && scroller
						? node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - JUMP_OFFSET
						: start && scroller
							? positions.offsetOf(start.index) + rowTop() - scroller.scrollTop - JUMP_OFFSET
							: 0;
				// 已经在本轮开头（误差 24px 内，同 pi-gna AT_TOP）就去上一轮
				next = offset < -24 ? current : current - 1;
			}
			const target2 = list[next];
			if (!target2) return;
			event.preventDefault();
			jump(target2, "smooth");
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [positions, rowTop, rows]);

	const renderRow = (row: ChatRow): ReactNode => {
		if (row.kind === "turnDiff") {
			return (
				<div className={row.running || row.afterMetaGroup ? undefined : "-mt-4"}>
					<TurnDiffChip
						changes={row.changes}
						timing={row.timing}
						running={row.running}
						entering={row.entering}
					/>
				</div>
			);
		}
		if (row.kind === "metaGroup") {
			return (
				<MetaGroup
					viewKey={row.key}
					items={row.items}
					working={row.working}
					endImmediately={row.endImmediately}
					subagentCount={row.subagentCount}
				/>
			);
		}
		if (row.kind === "streamingSubagents") {
			return <Slot name={UI_SLOTS.SubagentCard} props={{ runs: row.runs }} fallback={SubagentRunCard} />;
		}
		return (
			<MessageItem
				message={row.message}
				metaInGroup={row.metaInGroup}
				showActions={row.showActions}
				streaming={row.streaming}
				sessionId={activeSessionId}
			/>
		);
	};

	return (
		<div className="relative h-full">
			{centerOrbEnabled && <CenterOrb visible={shownWorking} />}
			<div
				ref={attachScroller}
				onScroll={handleScroll}
				onWheel={(event) => {
					const el = scrollRef.current;
					if (
						event.deltaY !== 0 &&
						(intentRef.current.kind === "jump" ||
							event.deltaY < 0 ||
							(el && el.scrollHeight - el.scrollTop - el.clientHeight > BOTTOM_THRESHOLD))
					)
						cancelIntent("reading");
					if (event.deltaY >= 0) return;
					// 已在顶部时向上滚不会产生 scroll 事件（scrollTop 已是 0），分页只能从这里触发（与基线一致）
					if (el && el.scrollTop - rowTop() < HISTORY_TRIGGER_PX && intentRef.current.kind !== "jump") {
						requestOlderHistory();
					}
				}}
				onTouchStart={() => {
					if (intentRef.current.kind === "jump") cancelIntent("reading");
				}}
				onPointerDown={(event) => {
					if (event.target === event.currentTarget && intentRef.current.kind === "jump")
						cancelIntent("reading");
				}}
				onClickCapture={handleSummaryToggle}
				style={{ "--edge-fade-size": "28px" } as CSSProperties}
				className="edge-fade chat-scrollbar relative z-10 h-full overflow-x-hidden overflow-y-auto [overflow-anchor:auto] [scrollbar-gutter:stable]"
			>
				{/* data-chat-column：对话区列的几何锚点（「返回父会话」入口与 Minimap 靠它定位） */}
				<div
					ref={contentRef}
					data-chat-column
					className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 pt-8 pb-16"
				>
					<HistoryImageRootProvider root={historyImageRoot}>
						{/* 占位不参与原生滚动锚定选锚，锚点只会是真实行（否则窗口移动时锚定会钉在占位上失效） */}
						{topSpacer > 0 && (
							<div
								aria-hidden="true"
								data-chat-spacer
								className="[overflow-anchor:none]"
								style={{ height: topSpacer - ROW_GAP, flexShrink: 0 }}
							/>
						)}
						{rendered.map((row) => (
							<div key={`${activeSessionId}:${row.key}`} data-chat-row-key={row.key} className="contents">
								<SessionViewContext.Provider value={activeSessionId}>
									{renderRow(row)}
								</SessionViewContext.Provider>
							</div>
						))}
						{bottomSpacer > 0 && (
							<div
								aria-hidden="true"
								data-chat-spacer
								className="[overflow-anchor:none]"
								style={{ height: bottomSpacer - ROW_GAP, flexShrink: 0 }}
							/>
						)}
						{transcript.retrying && <RetryNote info={transcript.retrying} />}
					</HistoryImageRootProvider>
				</div>
			</div>
			{/* 按会话重建：焦点/悬停等状态不能带到下一个会话 */}
			<MessageRail
				key={activeSessionId ?? "none"}
				nodes={nodes}
				inView={inView}
				onJump={jumpToNode}
				inset={railInset}
				columnRef={contentRef}
			/>
			{hasOlder && failedWindow === historyWindow && (
				<div
					role="status"
					className="absolute top-2 left-1/2 z-20 -translate-x-1/2 rounded-xl bg-surface px-3 py-2 text-ui-12 text-ink-dim shadow-pop"
				>
					{t("message.historyLoadFailed")}{" "}
					<button
						type="button"
						className="rounded-md px-2 py-1 hover:bg-hover"
						onClick={() => requestOlderHistory(true)}
					>
						{t("message.historyRetry")}
					</button>
				</div>
			)}
			<SelectionToolbar containerRef={scrollRef} />
			{!following && (
				<button
					type="button"
					onClick={() => {
						cancelIntent("following");
						pinToBottom(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
					}}
					className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface/95 px-3 py-1.5 text-ui-12 leading-[calc(1_/_0.75)] text-ink-2 shadow-pop backdrop-blur transition-colors hover:bg-hover"
					aria-label={t("message.scrollToBottom")}
				>
					<svg
						width="13"
						height="13"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<path d="M12 5v14" />
						<path d="m19 12-7 7-7-7" />
					</svg>
					{t("message.scrollToBottom")}
				</button>
			)}
		</div>
	);
}
