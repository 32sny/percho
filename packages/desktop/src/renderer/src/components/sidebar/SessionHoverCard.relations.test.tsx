import type { SessionHoverPreviewResult, SessionHoverRelationChild, SessionMeta } from "@percho/shared";
import { emptyTranscript } from "@percho/shared";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHoverPreviewTarget } from "../../stores/session-hover-preview";
import type { SessionEntry } from "../../stores/transcript";

/**
 * 悬停卡子代理父子关系（SESSION-HOVER-01 定稿方向 C）：
 * - 默认收起：`.fade-rule` + 全量 roleCounts 胶囊 + 「全部 N ▾」+ 最新 1 条浅灰直达行；
 * - 点「全部 N」调用独立 expand()，不要求已有 hidden，也不重复读取/拼页/重算 hidden；
 * - 展开：24px 单行三列（状态 glyph / Agent 固定列 / 摘要 truncate / ↗）+ max-h-[144px] edge-fade；
 * - 只渲染 hook 返回的累计 relations；sessionFile 只作导航目标与 React key，不进 DOM/title/aria；
 * - 状态不只靠颜色（sr-only 文案 + 状态点 token），running 用 motion-safe:animate-pulse；
 * - 子行/父入口导航先 onDismiss（不恢复触发行焦点）再 withSessionSlide；
 * - 父入口：内存返回目标优先，否则用后端验证的 parent DTO 作 fallback（不写返回 store）。
 *
 * 环境无 jsdom/testing-library：结构/隐私用 SSR 断言；点击与导航顺序按本仓 SessionRow
 * 既有做法直接调用组件并触发元素 props（hook 打桩），不冒充真实浏览器事件。
 */
const harness = vi.hoisted(() => ({
	language: "zh",
	sessions: [] as SessionMeta[],
	history: [] as SessionMeta[],
	entries: {} as Record<string, SessionEntry>,
	pages: {
		preview: null as SessionHoverPreviewResult | null,
		loadingMore: false,
		moreError: false,
		expanded: false,
		loadMore: vi.fn<() => Promise<void>>(),
		expand: vi.fn<() => void>(),
		collapse: vi.fn<() => void>(),
	},
	target: undefined as SessionHoverPreviewTarget | SessionMeta | undefined,
	parent: undefined as { parentSessionId: string; parentFile?: string } | undefined,
	openSubagentSessionFrom: vi.fn<(parent: unknown, filePath: string) => Promise<unknown>>(),
	returnToParent: vi.fn<(childSessionId: string, fallback?: unknown) => Promise<boolean>>(),
	slide: vi.fn<(direction: string, fn: () => unknown) => Promise<unknown>>(),
}));

vi.mock("../../i18n", async () => {
	const { zh } = await import("../../i18n/zh");
	const { en } = await import("../../i18n/en");
	const dictionary = () => (harness.language === "zh" ? zh : en);
	return {
		useT: () => (key: string, params?: Record<string, string | number>) => {
			const node = key
				.split(".")
				.reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], dictionary());
			const template = typeof node === "string" ? node : key;
			return params
				? template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
				: template;
		},
		useI18nStore: (select: (state: { language: string }) => unknown) =>
			select({ language: harness.language }),
	};
});
vi.mock("../../stores/sessions", () => ({
	useSessionsStore: (
		select: (state: {
			sessions: SessionMeta[];
			lastUsedModel: null;
			openSubagentSessionFrom: unknown;
			returnToParent: unknown;
		}) => unknown,
	) =>
		select({
			sessions: harness.sessions,
			lastUsedModel: null,
			openSubagentSessionFrom: harness.openSubagentSessionFrom,
			returnToParent: harness.returnToParent,
		}),
}));
vi.mock("../../stores/transcript", () => ({
	useTranscriptStore: (select: (state: { bySession: Record<string, SessionEntry> }) => unknown) =>
		select({ bySession: harness.entries }),
}));
vi.mock("../../stores/projects", () => ({
	useProjectsStore: (select: (state: { allSessions: SessionMeta[] }) => unknown) =>
		select({ allSessions: harness.history }),
}));
vi.mock("../../stores/subagent-return", () => ({ useParentTarget: () => harness.parent }));
vi.mock("../../lib/session-page-slide", () => ({
	withSessionSlide: (direction: string, fn: () => unknown) => harness.slide(direction, fn),
}));
// 固定契约：Card 调 useSessionHoverPages(previewTarget ?? session)，分页/展开状态与动作全部由 hook 给。
vi.mock("./useSessionHoverPages", () => ({
	useSessionHoverPages: (target: SessionHoverPreviewTarget | SessionMeta) => {
		harness.target = target;
		return harness.pages;
	},
}));
vi.mock("react-dom", async (original) => ({
	...(await original<typeof import("react-dom")>()),
	createPortal: (children: React.ReactNode) => children,
}));
// 直调组件的 hook 打桩：状态取初始值、effect 不跑（定位/滚动淡出/剪贴板副作用不属于本测试范围）。
vi.mock("react", async (original) => {
	const react = await original<typeof import("react")>();
	return {
		...react,
		useState: <T,>(initial: T) => [initial, () => {}] as const,
		useRef: <T,>(initial: T) => ({ current: initial }),
		useMemo: <T,>(compute: () => T) => compute(),
		useEffect: () => {},
		useLayoutEffect: () => {},
		useSyncExternalStore: <T,>(_subscribe: () => () => void, getSnapshot: () => T) => getSnapshot(),
	};
});

import { SessionHoverCard } from "./SessionHoverCard";

const PARENT_FILE = "C:/Users/x/sessions/parent-secret.jsonl";
const CHILD_FILE = "C:/Users/x/sessions-subagents/explore/child_secret_9a8b7c6d.jsonl";

const meta = (patch: Partial<SessionMeta> = {}): SessionMeta => ({
	sessionId: "A",
	cwd: "C:/项目/完整目录",
	name: "被悬停的父会话",
	sessionFile: PARENT_FILE,
	active: true,
	messageCount: 4,
	createdAt: 1_700_000_000_000,
	modifiedAt: 1_700_010_000_000,
	...patch,
});
const child = (patch: Partial<SessionHoverRelationChild> = {}): SessionHoverRelationChild => ({
	sessionFile: CHILD_FILE,
	agent: "explore",
	taskFirstLine: "读取目录结构",
	status: "done",
	...patch,
});
const resultWith = (relations: SessionHoverPreviewResult["relations"]): SessionHoverPreviewResult => ({
	status: "empty",
	sessionId: "A",
	...(relations ? { relations } : {}),
});
const entry = (patch: Partial<SessionEntry> = {}): SessionEntry => ({
	...emptyTranscript(),
	pendingPermissions: [],
	pendingDialogs: [],
	...patch,
});

function props(session: SessionMeta, extra: Record<string, unknown> = {}) {
	return {
		id: "hover-card",
		cardRef: { current: null },
		anchor: {} as HTMLButtonElement,
		session,
		onClose: vi.fn(),
		onDismiss: vi.fn(),
		onPointerEnter: vi.fn(),
		onPointerLeave: vi.fn(),
		onFocus: vi.fn(),
		onBlur: vi.fn(),
		onKeyDown: vi.fn(),
		...extra,
	};
}
function render(session = meta(), result: SessionHoverPreviewResult | null = null, extra = {}) {
	harness.pages.preview = result;
	return renderToStaticMarkup(React.createElement(SessionHoverCard, props(session, extra)));
}
/** 直调组件（hook 已打桩）取元素树；Portal 已展平为 children。 */
function renderElement(session = meta(), result: SessionHoverPreviewResult | null = null) {
	harness.pages.preview = result;
	const given = props(session);
	return { tree: SessionHoverCard(given) as React.ReactElement<Record<string, unknown>>, given };
}
type AnyElement = React.ReactElement<Record<string, any>>; // eslint 之外：测试只读 props
function collectButtons(node: React.ReactNode, out: AnyElement[] = []): AnyElement[] {
	if (!node || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const item of node) collectButtons(item, out);
		return out;
	}
	const element = node as AnyElement;
	if (element.type === "button") out.push(element);
	collectButtons(element.props?.children, out);
	return out;
}
/** 展平 React 子节点文本：按钮文案常被拆成多个 span（如「全部 2」+「▾」）。 */
function textOf(node: React.ReactNode): string {
	if (node === null || node === undefined || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	const element = node as AnyElement;
	return element?.props ? textOf(element.props.children) : "";
}
const buttonByText = (tree: AnyElement, text: string) =>
	collectButtons(tree.props.children as React.ReactNode).find((button) =>
		textOf(button.props.children).includes(text),
	);

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("React", React);
	vi.stubGlobal("document", { body: {} });
	harness.language = "zh";
	harness.sessions = [meta()];
	harness.history = [];
	harness.entries = { A: entry() };
	harness.parent = undefined;
	harness.pages.preview = null;
	harness.pages.loadingMore = false;
	harness.pages.moreError = false;
	harness.pages.expanded = false;
	harness.target = undefined;
	harness.openSubagentSessionFrom.mockResolvedValue({ ok: true });
	harness.returnToParent.mockResolvedValue(true);
	harness.slide.mockImplementation(async (_direction, fn) => fn() as never);
});
afterEach(() => vi.unstubAllGlobals());

describe("关系区默认收起态（SSR 结构与隐私，非视觉验收）", () => {
	it("显示全量角色胶囊与「全部 N ▾」，下方只给最新 1 条浅灰直达行", () => {
		const html = render(
			meta(),
			resultWith({
				children: [
					child({ agent: "fixer", taskFirstLine: "最新一条任务", status: "running" }),
					child({ sessionFile: "C:/x/2.jsonl", agent: "oracle", taskFirstLine: "旧任务" }),
				],
				hidden: 3,
				total: 5,
				roleCounts: [
					{ label: "Fixer", count: 4, status: "running" },
					{ label: "Oracle", count: 1, status: "done" },
				],
			}),
		);
		expect(html).toContain("fade-rule");
		// 计数拆成独立 mono 尾缀（原型 `Agent` + `×N`），不再拼成同一段文本。
		expect(html).toContain(">Fixer</span>");
		expect(html).toContain("×4</span>");
		expect(html).toContain(">Oracle</span>");
		expect(html).toContain("×1</span>");
		expect(html).toContain("全部 5");
		expect(html).toContain("▾");
		// 收起态只渲染最新一条；旧任务不在 DOM
		expect(html).toContain("最新");
		expect(html).toContain("最新一条任务");
		expect(html).not.toContain("旧任务");
		expect(html).not.toContain("显示更多");
		expect(html).not.toContain("edge-fade");
		expect(html).toContain('aria-expanded="false"');
		// 路径不进 DOM/title/aria
		expect(html).not.toContain(CHILD_FILE);
		expect(html).not.toContain("child_secret");
	});

	it("四种状态点用主题 token；状态不只靠颜色（sr-only 文案）", () => {
		const html = render(
			meta(),
			resultWith({
				children: [child()],
				hidden: 0,
				roleCounts: [
					{ label: "done", count: 1, status: "done" },
					{ label: "error", count: 1, status: "error" },
					{ label: "running", count: 1, status: "running" },
					{ label: "unknown", count: 1, status: "unknown" },
				],
			}),
		);
		for (const token of ["bg-ok", "bg-err", "bg-accent", "bg-ink-dim"]) expect(html).toContain(token);
		expect(html).toContain("motion-safe:animate-pulse");
		expect(html).toContain("运行中");
		expect(html).toContain("状态未知");
		expect(html).toMatch(/class="sr-only">(运行中|已结束|出错结束|状态未知)</);
	});

	it("后端没给 roleCounts 时用已加载项兜底聚合，不改 hidden/total", () => {
		const html = render(
			meta(),
			resultWith({
				children: [
					child({ agent: "fixer", status: "done" }),
					child({ sessionFile: "C:/x/2.jsonl", agent: "Fixer", status: "running" }),
				],
				hidden: 0,
				total: 2,
			}),
		);
		expect(html).toContain(">Fixer</span>");
		expect(html).toContain("×2</span>");
		expect(html).toContain("全部 2");
	});

	it("无关系、空 children 或加载中都不显示关系区", () => {
		expect(render(meta(), resultWith(undefined))).not.toContain("fade-rule");
		expect(render(meta(), resultWith({ children: [], hidden: 0 }))).not.toContain("fade-rule");
		expect(render(meta(), null)).not.toContain("fade-rule");
	});

	it("unavailable/ok 变体同样渲染后端认可的 relations，卡片不自行重算 hidden", () => {
		const html = render(meta(), {
			status: "unavailable",
			sessionId: "A",
			reason: "read_failed",
			relations: { children: [child()], hidden: 42, total: 43 },
		});
		expect(html).toContain("全部 43");
	});
});

describe("展开 / 收起触发（独立 expand 动作）", () => {
	const relations = {
		children: [child(), child({ sessionFile: "C:/x/2.jsonl" })],
		hidden: 0,
		total: 2,
		roleCounts: [{ label: "Explore", count: 2, status: "done" as const }],
	};

	it("点「全部 N」调用 expand()，不依赖 hidden，也不调用 loadMore", async () => {
		const { tree } = renderElement(meta(), resultWith(relations));
		const toggle = buttonByText(tree, "全部 2");
		expect(toggle?.props.type).toBe("button");
		expect(toggle?.props["aria-expanded"]).toBe(false);
		await toggle?.props.onClick();
		expect(harness.pages.expand).toHaveBeenCalledTimes(1);
		expect(harness.pages.loadMore).not.toHaveBeenCalled();
	});

	it("展开态：单行三列 + edge-fade 滚动容器 + 显示更多/重试/收起", async () => {
		harness.pages.expanded = true;
		harness.pages.moreError = true;
		const html = render(meta(), resultWith({ ...relations, hidden: 46, total: 48 }));
		expect(html).toContain("edge-fade");
		expect(html).toContain("max-h-36");
		expect(html).toContain("overflow-y-auto");
		expect(html).toContain("grid-cols-[64px_1fr_14px]");
		expect(html).toContain('id="hover-card-children-list"');
		expect(html).toContain('aria-expanded="true"');
		expect(html).toContain("收起");
		expect(html).toContain("▴");
		expect(html).toContain("显示更多（还有 46 个）");
		expect(html).toContain("加载更多失败");
		expect(html).toContain("重试");
		// 展开态不再单独渲染「最新」直达行
		expect(html).not.toContain(">最新<");
	});

	it("展开态「收起」调用 collapse()；「显示更多」调用 loadMore 并在加载中禁重复点击", async () => {
		harness.pages.expanded = true;
		const { tree } = renderElement(meta(), resultWith({ ...relations, hidden: 46, total: 48 }));
		const collapse = buttonByText(tree, "收起");
		expect(collapse?.props["aria-expanded"]).toBe(true);
		await collapse?.props.onClick();
		expect(harness.pages.collapse).toHaveBeenCalledTimes(1);

		const more = buttonByText(tree, "显示更多");
		expect(more?.props["aria-disabled"]).toBeUndefined();
		await more?.props.onClick();
		expect(harness.pages.loadMore).toHaveBeenCalledTimes(1);

		harness.pages.loadingMore = true;
		const { tree: loading } = renderElement(meta(), resultWith({ ...relations, hidden: 46, total: 48 }));
		const busy = buttonByText(loading, "正在加载更多");
		expect(busy?.props["aria-disabled"]).toBe(true);
		await busy?.props.onClick();
		expect(harness.pages.loadMore).toHaveBeenCalledTimes(1);
	});

	it("重试直接复用 loadMore，保留已确认前页", async () => {
		harness.pages.expanded = true;
		harness.pages.moreError = true;
		const { tree } = renderElement(meta(), resultWith({ ...relations, hidden: 46, total: 48 }));
		const retry = collectButtons(tree.props.children as React.ReactNode).find(
			(button) => textOf(button.props.children) === "重试",
		);
		await retry?.props.onClick();
		expect(harness.pages.loadMore).toHaveBeenCalledTimes(1);
	});
});

describe("父会话入口（SSR 与标题回退）", () => {
	it("父标题来自内存 sessions；缺关系不渲染区块；parentFile 不进 DOM", () => {
		harness.parent = { parentSessionId: "P", parentFile: "C:/secret/parent-file.jsonl" };
		harness.sessions = [meta(), meta({ sessionId: "P", name: "父会话的真实标题" })];
		const html = render();
		expect(html).toContain("父会话");
		expect(html).toContain("父会话的真实标题");
		expect(html).toContain("fade-rule");
		expect(html).toContain('aria-label="返回父会话 父会话的真实标题"');
		expect(html).not.toContain("parent-file.jsonl");
		harness.parent = undefined;
		expect(render()).not.toContain("返回父会话");
	});

	it("父已卸载但历史仍有标题时，优先显示历史标题", () => {
		harness.parent = { parentSessionId: "P", parentFile: PARENT_FILE };
		harness.history = [meta({ sessionId: "P", name: "历史里的父标题" })];
		expect(render()).toContain("历史里的父标题");
		expect(render()).not.toContain("未知标题的父会话");
	});

	it("父不在内存时使用本地化通用标题，不显示 parentFile", () => {
		harness.parent = { parentSessionId: "P", parentFile: "C:/secret/parent-file.jsonl" };
		const html = render();
		expect(html).toContain("未知标题的父会话");
		expect(html).not.toContain("parent-file.jsonl");
		harness.language = "en";
		expect(render()).toContain("Parent session (title unknown)");
	});
});

describe("父 DTO 冷启动回退（无内存 remember 关系）", () => {
	const parentDto = {
		sessionId: "P",
		sessionFile: "C:/secret/parent-file.jsonl",
		cwd: "C:/项目/完整目录",
		name: "DTO 里的父名",
	};
	it("无 remember 时用 relations.parent 显示返回入口，标题 DTO.name；路径不进 DOM", () => {
		const html = render(meta(), resultWith({ children: [child()], hidden: 0, parent: parentDto }));
		expect(html).toContain("返回父会话");
		expect(html).toContain("DTO 里的父名");
		expect(html).not.toContain("parent-file.jsonl");
		expect(html).not.toContain("未知标题的父会话");
	});
	it("DTO 无 name 时回落本地化通用标题；sessions/history 优先于 DTO.name", () => {
		const anonymous = { ...parentDto, name: undefined };
		expect(render(meta(), resultWith({ children: [], hidden: 0, parent: anonymous }))).toContain(
			"未知标题的父会话",
		);
		harness.history = [meta({ sessionId: "P", name: "历史里的父标题" })];
		const html = render(meta(), resultWith({ children: [], hidden: 0, parent: parentDto }));
		expect(html).toContain("历史里的父标题");
		expect(html).not.toContain("DTO 里的父名");
	});
	it("内存 remember 目标优先于 DTO；点父入口传有效 fallback 且不写 store", async () => {
		harness.parent = { parentSessionId: "R", parentFile: "C:/secret/remembered.jsonl" };
		harness.sessions = [meta(), meta({ sessionId: "R", name: "内存里的父" })];
		const html = render(meta(), resultWith({ children: [], hidden: 0, parent: parentDto }));
		expect(html).toContain("内存里的父");
		expect(html).not.toContain("DTO 里的父名");
		const { tree, given } = renderElement(meta(), resultWith({ children: [], hidden: 0, parent: parentDto }));
		const parentRow = collectButtons(tree.props.children as React.ReactNode).find((button) =>
			String(button.props["aria-label"]).includes("返回父会话"),
		);
		await parentRow?.props.onClick();
		expect(given.onDismiss).toHaveBeenCalledOnce();
		expect(harness.returnToParent).toHaveBeenCalledWith("A", undefined);
		expect(harness.slide).toHaveBeenCalledWith("pop", expect.any(Function));
	});
	it("冷 DTO 父点击：先 onDismiss 再 pop returnToParent(sessionId, DTO 映射目标）", async () => {
		const { tree, given } = renderElement(meta(), resultWith({ children: [], hidden: 0, parent: parentDto }));
		const parentRow = collectButtons(tree.props.children as React.ReactNode).find((button) =>
			String(button.props["aria-label"]).includes("返回父会话"),
		);
		await parentRow?.props.onClick();
		expect(given.onDismiss).toHaveBeenCalledOnce();
		expect(harness.returnToParent).toHaveBeenCalledWith("A", {
			parentSessionId: "P",
			parentFile: "C:/secret/parent-file.jsonl",
			cwd: parentDto.cwd,
		});
		expect(given.onDismiss.mock.invocationCallOrder[0] ?? -1).toBeLessThan(
			harness.returnToParent.mock.invocationCallOrder[0] ?? -1,
		);
	});
});

describe("预览目标传递", () => {
	it("固定传 previewTarget ?? session 给 useSessionHoverPages；key/缓存/失效由 hook 负责", () => {
		const session = meta();
		const target = { ...session, modifiedAt: 1_700_020_000_000, messageCount: 5 };
		render(session, resultWith({ children: [child()], hidden: 0 }), { previewTarget: target });
		expect(harness.target).toBe(target);
		render(session, resultWith({ children: [child()], hidden: 0 }));
		expect(harness.target).toBe(session);
	});
});

describe("关系导航（组件直调 + props 触发，非真实 DOM 事件）", () => {
	it("点子行：先 onDismiss，再 withSessionSlide('push') 调显式父目标打开", async () => {
		const { tree } = renderElement(meta(), resultWith({ children: [child()], hidden: 0 }));
		const buttons = collectButtons(tree.props.children as React.ReactNode);
		const row = buttons.find((button) => String(button.props["aria-label"]).includes("打开子会话 Explore"));
		expect(row).toBeDefined();
		expect(row?.props.type).toBe("button");
		await row?.props.onClick();
		expect(harness.openSubagentSessionFrom).toHaveBeenCalledWith(
			{ sessionId: "A", sessionFile: PARENT_FILE },
			CHILD_FILE,
		);
		expect(harness.slide).toHaveBeenCalledWith("push", expect.any(Function));
	});

	it("展开态子行同样可导航，onDismiss 先于导航动作", async () => {
		harness.pages.expanded = true;
		const { tree, given } = renderElement(
			meta(),
			resultWith({ children: [child(), child({ sessionFile: "C:/x/2.jsonl" })], hidden: 0 }),
		);
		const rows = collectButtons(tree.props.children as React.ReactNode).filter((button) =>
			String(button.props["aria-label"]).includes("打开子会话 Explore"),
		);
		expect(rows).toHaveLength(2);
		await rows[1]?.props.onClick();
		expect(harness.openSubagentSessionFrom).toHaveBeenCalledWith(
			{ sessionId: "A", sessionFile: PARENT_FILE },
			"C:/x/2.jsonl",
		);
		expect(given.onDismiss.mock.invocationCallOrder[0] ?? -1).toBeLessThan(
			harness.openSubagentSessionFrom.mock.invocationCallOrder[0] ?? -1,
		);
	});

	it("onDismiss 先于导航动作；父入口先 onDismiss 再 pop returnToParent", async () => {
		harness.parent = { parentSessionId: "P" };
		harness.sessions = [meta(), meta({ sessionId: "P", name: "父会话的真实标题" })];
		const { tree, given } = renderElement(meta(), resultWith({ children: [child()], hidden: 0 }));
		const buttons = collectButtons(tree.props.children as React.ReactNode);
		const childRow = buttons.find((button) => String(button.props["aria-label"]).includes("打开子会话"));
		const parentRow = buttons.find((button) => String(button.props["aria-label"]).includes("返回父会话"));
		const onDismiss = given.onDismiss;
		await childRow?.props.onClick();
		await parentRow?.props.onClick();
		expect(onDismiss).toHaveBeenCalledTimes(2);
		expect(harness.returnToParent).toHaveBeenCalledWith("A", undefined);
		expect(harness.slide).toHaveBeenCalledWith("pop", expect.any(Function));
		expect(onDismiss.mock.invocationCallOrder[0] ?? -1).toBeLessThan(
			harness.openSubagentSessionFrom.mock.invocationCallOrder[0] ?? -1,
		);
		expect(onDismiss.mock.invocationCallOrder[1] ?? -1).toBeLessThan(
			harness.returnToParent.mock.invocationCallOrder[0] ?? -1,
		);
	});

	it("关系行保留原按钮语义与 Tab 顺序：type=button、无负 tabIndex、无路径 aria", () => {
		harness.pages.expanded = true;
		harness.parent = { parentSessionId: "P" };
		const { tree } = renderElement(meta(), resultWith({ children: [child()], hidden: 0 }));
		const buttons = collectButtons(tree.props.children as React.ReactNode);
		const rows = buttons.filter((button) =>
			/打开子会话|返回父会话|全部 \d+|收起/.test(
				`${String(button.props["aria-label"])}${textOf(button.props.children)}`,
			),
		);
		expect(rows.length).toBeGreaterThanOrEqual(3);
		for (const row of rows) {
			expect(row.props.type).toBe("button");
			expect(row.props.tabIndex).toBeUndefined();
			expect(String(row.props["aria-label"])).not.toContain(".jsonl");
			expect(row.props.title).toBeUndefined();
		}
	});
});
