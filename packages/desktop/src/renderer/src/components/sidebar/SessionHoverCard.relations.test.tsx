import type { SessionHoverPreviewResult, SessionHoverRelationChild, SessionMeta } from "@percho/shared";
import { emptyTranscript } from "@percho/shared";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHoverPreviewTarget } from "../../stores/session-hover-preview";
import type { SessionEntry } from "../../stores/transcript";

/**
 * 悬停卡子代理父子关系（PLAN-session-hover-subagent-relations §六/§十二）：
 * - 只渲染 hook 返回的累计 relations，不自行读取/合并 transcript、不拼页/重算 hidden；
 * - sessionFile 只作导航目标与 React key，不进 DOM/title/aria；
 * - 状态不只靠颜色（sr-only 文案 + 状态点 token），running 用 motion-safe:animate-pulse；
 * - 子行/父入口导航先 onDismiss（不恢复触发行焦点）再 withSessionSlide；
 * - 父入口：内存返回目标优先，否则用后端验证的 parent DTO 作 fallback（不写返回 store）；
 * - “显示更多/收起/重试”按钮替代静态隐藏计数，加载中禁重复点击。
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
// 固定契约：Card 调 useSessionHoverPages(previewTarget ?? session)，分页状态/动作全部由 hook 给。
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
// 直调组件的 hook 打桩：状态取初始值、effect 不跑（定位/剪贴板副作用不属于本测试范围）。
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

describe("子会话区块（SSR 结构与隐私，非视觉验收）", () => {
	it("渲染子行：名称首字母大写、任务两行截断类、状态 sr-only、↗ aria-hidden、隐藏计数插值", () => {
		const html = render(
			meta(),
			resultWith({
				children: [
					child({ agent: "explore", taskFirstLine: "读取目录结构", status: "running" }),
					child({
						sessionFile: "C:/x/other.jsonl",
						agent: "fixer",
						taskFirstLine: undefined,
						status: "unknown",
					}),
				],
				hidden: 3,
			}),
		);
		expect(html).toContain("创建的子会话");
		expect(html).toContain("Explore");
		expect(html).toContain("读取目录结构");
		expect(html).toContain("line-clamp-2");
		expect(html).toContain("motion-safe:animate-pulse");
		expect(html).toContain("bg-accent");
		expect(html).toContain("bg-ink-dim");
		expect(html).toContain("运行中");
		expect(html).toContain('aria-describedby="hover-card-child-status-0"');
		expect(html).toContain('id="hover-card-child-status-0" class="sr-only">运行中');
		expect(html).not.toContain("line-clamp-2 block");
		expect(html).toContain("状态未知");
		expect(html).toContain('aria-label="打开子会话 Explore：读取目录结构"');
		expect(html).toContain('aria-label="打开子会话 Fixer"');
		expect(html).toContain("显示更多（还有 3 个）");
		expect(html.match(/aria-hidden="true"[^>]*><path d="M7 17L17 7"/g)?.length).toBeGreaterThan(0);
	});

	it("路径不进 DOM/title/aria；hidden=0 且未展开时不显示更多按钮；无任务不渲染任务行", () => {
		const html = render(meta(), resultWith({ children: [child({ taskFirstLine: undefined })], hidden: 0 }));
		expect(html).not.toContain(CHILD_FILE);
		expect(html).not.toContain("child_secret");
		// 行级无 title（整卡复制/关闭按钮的原生 title 属既有行为，props 级断言见导航组）
		expect(html).not.toContain("显示更多");
		expect(html).not.toContain("收起子会话列表");
		expect(html.match(/line-clamp-2/g)).toBeNull();
	});

	it("四种状态点用主题 token；无关系、空 children 或加载中都不显示区块", () => {
		const html = render(
			meta(),
			resultWith({
				children: [
					child({ status: "done", sessionFile: "C:/x/d.jsonl" }),
					child({ status: "error", sessionFile: "C:/x/e.jsonl" }),
					child({ status: "running", sessionFile: "C:/x/r.jsonl" }),
					child({ status: "unknown", sessionFile: "C:/x/u.jsonl" }),
				],
				hidden: 0,
			}),
		);
		for (const token of ["bg-ok", "bg-err", "bg-accent", "bg-ink-dim"]) expect(html).toContain(token);
		expect(render(meta(), resultWith(undefined))).not.toContain("创建的子会话");
		expect(render(meta(), resultWith({ children: [], hidden: 0 }))).not.toContain("创建的子会话");
		expect(render(meta(), null)).not.toContain("创建的子会话");
	});

	it("unavailable/ok 变体同样渲染后端认可的 relations；卡片不自行重算 hidden", () => {
		const html = render(meta(), {
			status: "unavailable",
			sessionId: "A",
			reason: "read_failed",
			relations: { children: [child()], hidden: 42 },
		});
		expect(html).toContain("创建的子会话");
		expect(html).toContain("显示更多（还有 42 个）");
	});
});

describe("父会话入口（SSR 与标题回退）", () => {
	it("父标题来自内存 sessions；缺关系不渲染区块；parentFile 不进 DOM", () => {
		harness.parent = { parentSessionId: "P", parentFile: "C:/secret/parent-file.jsonl" };
		harness.sessions = [meta(), meta({ sessionId: "P", name: "父会话的真实标题" })];
		const html = render();
		expect(html).toContain("父会话");
		expect(html).toContain("父会话的真实标题");
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

describe("分页按钮（显示更多 / 收起 / 重试）", () => {
	it("显示更多调用 loadMore；加载中 aria-disabled 且禁重复点击", async () => {
		const { tree } = renderElement(meta(), resultWith({ children: [child()], hidden: 5 }));
		const more = collectButtons(tree.props.children as React.ReactNode).find((button) =>
			String(button.props.children).includes("显示更多"),
		);
		expect(more).toBeDefined();
		expect(more?.props.type).toBe("button");
		expect(more?.props["aria-disabled"]).toBeUndefined();
		await more?.props.onClick();
		expect(harness.pages.loadMore).toHaveBeenCalledTimes(1);
		harness.pages.loadingMore = true;
		const { tree: loading } = renderElement(meta(), resultWith({ children: [child()], hidden: 5 }));
		const busy = collectButtons(loading.props.children as React.ReactNode).find((button) =>
			String(button.props.children).includes("正在加载更多"),
		);
		expect(busy?.props["aria-disabled"]).toBe(true);
		await busy?.props.onClick();
		expect(harness.pages.loadMore).toHaveBeenCalledTimes(1);
	});

	it("加载更多失败 inline 提示并可重试，重试调 loadMore；保留已确认前页", async () => {
		harness.pages.moreError = true;
		const html = render(meta(), resultWith({ children: [child()], hidden: 3 }));
		expect(html).toContain("加载更多失败");
		expect(html).toContain("Explore"); // 前页子行仍在
		const { tree } = renderElement(meta(), resultWith({ children: [child()], hidden: 3 }));
		const retry = collectButtons(tree.props.children as React.ReactNode).find(
			(button) => button.props.children === "重试",
		);
		await retry?.props.onClick();
		expect(harness.pages.loadMore).toHaveBeenCalledTimes(1);
	});

	it("展开后提供收起；收起调用 collapse；按钮是原生 button 支持 Enter/Space", async () => {
		harness.pages.expanded = true;
		const html = render(
			meta(),
			resultWith({ children: [child(), child({ sessionFile: "C:/x/2.jsonl" })], hidden: 0 }),
		);
		expect(html).toContain("收起子会话列表");
		expect(html).not.toContain("显示更多");
		const { tree } = renderElement(
			meta(),
			resultWith({ children: [child(), child({ sessionFile: "C:/x/2.jsonl" })], hidden: 0 }),
		);
		const collapseButton = collectButtons(tree.props.children as React.ReactNode).find(
			(button) => button.props.children === "收起子会话列表",
		);
		expect(collapseButton?.props.type).toBe("button");
		expect(collapseButton?.props.tabIndex).toBeUndefined();
		await collapseButton?.props.onClick();
		expect(harness.pages.collapse).toHaveBeenCalledTimes(1);
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
		harness.parent = { parentSessionId: "P" };
		const { tree } = renderElement(meta(), resultWith({ children: [child()], hidden: 0 }));
		const buttons = collectButtons(tree.props.children as React.ReactNode);
		const rows = buttons.filter((button) => /打开子会话|返回父会话/.test(String(button.props["aria-label"])));
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.props.type).toBe("button");
			expect(row.props.tabIndex).toBeUndefined();
			expect(String(row.props["aria-label"])).not.toContain(".jsonl");
			expect(row.props.title).toBeUndefined();
		}
	});
});
