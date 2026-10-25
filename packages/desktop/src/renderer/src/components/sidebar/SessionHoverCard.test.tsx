import type { SessionHoverPreviewResult, SessionMeta } from "@percho/shared";
import { emptyTranscript } from "@percho/shared";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHoverPreviewSnapshot } from "../../stores/session-hover-preview";
import type { SessionEntry } from "../../stores/transcript";

const harness = vi.hoisted(() => ({
	language: "zh",
	sessions: [] as SessionMeta[],
	entries: {} as Record<string, SessionEntry>,
	snapshot: null as SessionHoverPreviewSnapshot | null,
	hover: {
		opened: null,
		cardId: "hover-card",
		helpId: "hover-help",
		focusCard: vi.fn().mockReturnValue(false),
		controller: {
			pointerEnter: vi.fn(),
			pointerLeave: vi.fn(),
			focusRow: vi.fn(),
			blurRow: vi.fn(),
			dismiss: vi.fn(),
		},
	},
}));
vi.mock("../../i18n", async () => {
	const { zh } = await import("../../i18n/zh");
	const { en } = await import("../../i18n/en");
	return {
		useT: () => (key: string) =>
			key
				.split(".")
				.reduce<unknown>(
					(value, part) => (value as Record<string, unknown>)[part],
					harness.language === "zh" ? zh : en,
				),
		useI18nStore: (select: (state: { language: string }) => unknown) =>
			select({ language: harness.language }),
	};
});
vi.mock("../../stores/sessions", () => ({
	useSessionsStore: (
		select: (state: { sessions: SessionMeta[]; lastUsedModel: { modelId: string } }) => unknown,
	) => select({ sessions: harness.sessions, lastUsedModel: { modelId: "DO-NOT-BORROW-CURRENT-MODEL" } }),
}));
vi.mock("../../stores/transcript", () => ({
	useTranscriptStore: (select: (state: { bySession: Record<string, SessionEntry> }) => unknown) =>
		select({ bySession: harness.entries }),
}));
vi.mock("../../stores/session-hover-preview", async (original) => ({
	...(await original<typeof import("../../stores/session-hover-preview")>()),
	sessionHoverPreview: {
		getSnapshot: () => harness.snapshot,
		subscribe: () => () => {},
		setTarget: vi.fn(),
	},
}));
// SSR 检查文本/语义结构，Portal 展平仅用于序列化，不声称覆盖真实 DOM 事件传播或视觉。
vi.mock("react-dom", async (original) => ({
	...(await original<typeof import("react-dom")>()),
	createPortal: (children: React.ReactNode) => children,
}));
vi.mock("./SessionHoverProvider", () => ({ useSessionHover: () => harness.hover }));

import { sessionHoverPreviewKey } from "../../stores/session-hover-preview";
import { SessionHoverCard } from "./SessionHoverCard";
import { SessionRow } from "./SessionRow";

const meta = (patch: Partial<SessionMeta> = {}): SessionMeta => ({
	sessionId: "A",
	cwd: "C:/项目/完整目录",
	name: "已保存的标题",
	active: true,
	messageCount: 4,
	createdAt: 1_700_000_000_000,
	modifiedAt: 1_700_010_000_000,
	...patch,
});
const preview = (text: string): SessionHoverPreviewResult => ({
	status: "ok",
	sessionId: "A",
	source: "current-branch-first-user-text",
	text,
});
const entry = (patch: Partial<SessionEntry> = {}): SessionEntry => ({
	...emptyTranscript(),
	pendingPermissions: [],
	pendingDialogs: [],
	...patch,
});
function render(session = meta(), result: SessionHoverPreviewResult | null = null) {
	harness.snapshot = { key: sessionHoverPreviewKey(session), result };
	return renderToStaticMarkup(
		React.createElement(SessionHoverCard, {
			id: "hover-card",
			cardRef: { current: null },
			anchor: {} as HTMLButtonElement,
			session,
			onClose: vi.fn(),
			onPointerEnter: vi.fn(),
			onPointerLeave: vi.fn(),
			onFocus: vi.fn(),
			onBlur: vi.fn(),
			onKeyDown: vi.fn(),
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("React", React);
	vi.stubGlobal("document", { body: {} });
	harness.language = "zh";
	harness.sessions = [meta()];
	harness.entries = { A: entry() };
	harness.hover.focusCard.mockReturnValue(false);
});
afterEach(() => vi.unstubAllGlobals());

describe("悬停卡信息与可访问结构（SSR，非视觉验收）", () => {
	it("长标题与 Emoji 完整保留、可选中；卡片为非模态而非 tooltip", () => {
		const title = `${"很长的完整标题".repeat(200)}😀END`;
		const html = render(meta({ name: title }));
		expect(html).toContain(title);
		expect(html).toContain('role="dialog"');
		expect(html).toContain('aria-modal="false"');
		expect(html).toContain('aria-labelledby="hover-card-title"');
		expect(html).toContain("select-text");
		expect(html).toContain("overflow-y-auto");
		expect(html).toContain("overscroll-contain");
		expect(html).toContain("overflow-wrap:anywhere");
		expect(html).toContain('aria-label="复制完整标题"');
		expect(html).not.toMatch(/truncate|line-clamp|role="tooltip"/);
	});

	it("使用宿主主题 token 和低于设置弹窗的 z-30，不添加动画", () => {
		const html = render();
		for (const token of ["bg-surface", "border-border", "text-ink", "shadow-pop", "z-30"])
			expect(html).toContain(token);
		expect(html).not.toMatch(/animate-|z-50|z-\[999/);
	});

	it("提问与已保存标题相同或 empty 时隐藏重复区块", () => {
		expect(render(meta(), preview("已保存的标题"))).not.toContain("首条提问（当前分支首行）");
		expect(render(meta(), { status: "empty", sessionId: "A" })).not.toContain("首条提问");
		const html = render(meta(), preview("不同的原始提问"));
		expect(html).toContain("首条提问（当前分支首行）");
		expect(html).toContain("不同的原始提问");
		expect(html).toContain("已保存的标题");
	});

	it("预览只按纯文本渲染，不解释 HTML 或输出 DTO 的额外 sourceText", () => {
		const result = { ...preview("<script>不执行</script>"), sourceText: "SECRET-EXPANDED-SKILL" };
		const html = render(meta(), result);
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("SECRET-EXPANDED-SKILL");
	});

	it.each([
		"not_found",
		"identity_mismatch",
		"invalid_history",
		"read_failed",
		"limit_exceeded",
		"unsafe_projection",
	] as const)("%s 仅 inline 降级，保留标题与基础详情", (reason) => {
		const html = render(meta(), { status: "unavailable", sessionId: "A", reason });
		expect(html).toContain("已保存的标题");
		expect(html).toContain("C:/项目/完整目录");
		expect(html).toContain('role="status"');
		expect(html).toContain("首条提问");
		expect(html).not.toContain('role="alert"');
	});

	it("只显示目标已有模型，缺失模型与时间不借用或伪造", () => {
		const html = render(meta({ createdAt: 0, modifiedAt: undefined }));
		expect(html).not.toContain("DO-NOT-BORROW-CURRENT-MODEL");
		expect(html).not.toContain(">模型<");
		expect(html).not.toContain("<time");
		const known = render(meta({ modelLabel: "旧标签", model: { provider: "目标", modelId: "当前模型" } }));
		expect(known).toContain("目标/当前模型");
		expect(known).not.toContain("旧标签");
		expect(render(meta({ modelLabel: "已有模型标签" }))).toContain("已有模型标签");
	});

	it("done 是完成未读，状态优先级遵从实时 store", () => {
		harness.entries.A = entry({ unseenCompletion: true });
		expect(render()).toContain("完成未读");
		expect(render()).not.toContain("成功");
		harness.entries.A = entry({ agentActive: true, unseenCompletion: true });
		expect(render()).toContain('data-session-hover-status="working"');
		harness.entries.A.pendingDialogs = new Array(1);
		expect(render()).toContain('data-session-hover-status="attention"');
	});

	it("缺实时数据或不在内存，即使历史 active 为 true 也不推断结局", () => {
		harness.entries = {};
		expect(render()).toContain("未加载 / 无实时状态");
		harness.entries.A = entry({ agentActive: true });
		harness.sessions = [];
		expect(render()).toContain('data-session-hover-status="unloaded"');
	});

	it("新标题与新实时状态读取当前值，不受预览快照冻结；英文词条同形", () => {
		harness.entries.A = entry({ unseenCompletion: true });
		expect(render(meta({ name: "改名后的完整标题" }), preview("原提问"))).toContain("改名后的完整标题");
		harness.language = "en";
		const html = render();
		expect(html).toContain("Completed · unread");
		expect(html).toContain("Copy full title");
		expect(html).not.toContain("sessionHover.");
	});
});

describe("SessionRow 原操作与详情触发接线", () => {
	function row() {
		const onSelect = vi.fn();
		const onContextMenu = vi.fn();
		const button = SessionRow({
			session: meta(),
			active: false,
			onSelect,
			onContextMenu,
		}) as React.ReactElement<React.ComponentProps<"button">>;
		return { button, onSelect, onContextMenu };
	}
	it("悬停/键盘焦点不选择会话，触发行下没有 Portal/dialog 子节点", () => {
		const { button, onSelect } = row();
		const element = { matches: () => true } as unknown as HTMLButtonElement;
		button.props.onPointerEnter?.({
			pointerType: "mouse",
			currentTarget: element,
		} as React.PointerEvent<HTMLButtonElement>);
		button.props.onFocus?.({ currentTarget: element } as React.FocusEvent<HTMLButtonElement>);
		expect(harness.hover.controller.pointerEnter).toHaveBeenCalledWith({
			sessionId: "A",
			cwd: meta().cwd,
			element,
		});
		expect(harness.hover.controller.focusRow).toHaveBeenCalledOnce();
		expect(onSelect).not.toHaveBeenCalled();
		expect(renderToStaticMarkup(button)).not.toContain('role="dialog"');
	});

	it("触屏 pointerenter 不启动悬停，鼠标点击保留原选择动作并关闭卡片", () => {
		const { button, onSelect } = row();
		button.props.onPointerEnter?.({ pointerType: "touch" } as React.PointerEvent<HTMLButtonElement>);
		expect(harness.hover.controller.pointerEnter).not.toHaveBeenCalled();
		button.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
		expect(harness.hover.controller.dismiss).toHaveBeenCalledOnce();
		expect(onSelect).toHaveBeenCalledOnce();
	});

	it("Tab 只在能主动进入卡片时拦截；Shift+Tab 保留原序", () => {
		const { button } = row();
		const preventDefault = vi.fn();
		const event = {
			key: "Tab",
			preventDefault,
			currentTarget: {},
		} as unknown as React.KeyboardEvent<HTMLButtonElement>;
		button.props.onKeyDown?.(event);
		expect(preventDefault).not.toHaveBeenCalled();
		harness.hover.focusCard.mockReturnValue(true);
		button.props.onKeyDown?.(event);
		expect(preventDefault).toHaveBeenCalledOnce();
		button.props.onKeyDown?.({ ...event, shiftKey: true });
		expect(preventDefault).toHaveBeenCalledOnce();
	});

	it("右键与拖拽关闭详情但继续原菜单/拖拽载荷，不误选择", () => {
		const { button, onSelect, onContextMenu } = row();
		const preventDefault = vi.fn();
		button.props.onContextMenu?.({
			clientX: 20,
			clientY: 30,
			preventDefault,
		} as unknown as React.MouseEvent<HTMLButtonElement>);
		expect(onContextMenu).toHaveBeenCalledWith({ left: 20, top: 30, width: 0, height: 0 });
		const dataTransfer = { setData: vi.fn(), effectAllowed: "" };
		button.props.onDragStart?.({ dataTransfer } as unknown as React.DragEvent<HTMLButtonElement>);
		expect(dataTransfer.setData).toHaveBeenCalledWith(
			"application/x-percho-session",
			expect.stringContaining('"sessionId":"A"'),
		);
		expect(dataTransfer.effectAllowed).toBe("copy");
		expect(harness.hover.controller.dismiss).toHaveBeenCalledTimes(2);
		expect(onSelect).not.toHaveBeenCalled();
	});
});
