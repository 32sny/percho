import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 只运行真实 UI 状态机；当前项目没有 DOM 测试运行器，不以此代替 Electron 焦点/视觉验收。
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../stores/projects", () => ({ useProjectsStore: {} }));
vi.mock("../../stores/sessions", () => ({ useSessionsStore: {} }));
vi.mock("../../stores/settings", () => ({ useSettingsStore: {} }));
vi.mock("../../stores/transcript", () => ({ useTranscriptStore: {} }));
vi.mock("./SessionHoverCard", () => ({ SessionHoverCard: () => null }));

import {
	collectChangedSessionIds,
	collectTranscriptInvalidationIds,
	createSessionHoverController,
	type SessionHoverTarget,
} from "./SessionHoverProvider";

const target = (sessionId: string): SessionHoverTarget => ({
	sessionId,
	cwd: "C:/project",
	element: { focus: vi.fn() } as unknown as HTMLButtonElement,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("侧栏悬停缓存失效收集", () => {
	it("metadata 集合比较并集中的 id，包括新增、移除和替换", () => {
		const a = { sessionId: "a", name: "old" };
		const b = { sessionId: "b", name: "same" };
		expect(
			collectChangedSessionIds([a, b], [{ sessionId: "a", name: "new" }, { ...b }, { sessionId: "c" }]),
		).toEqual(["a", "b", "c"]);
	});

	it("transcript 遍历所有已加载项，历史变化/结束会传 ID，streaming token 不传", () => {
		const stableMessages = [{}];
		const before = {
			parent: { messages: stableMessages, agentActive: true },
			tokenOnly: { messages: stableMessages, agentActive: true },
			finished: { messages: stableMessages, agentActive: true },
		};
		const after = {
			parent: { messages: [{}], agentActive: false },
			tokenOnly: { messages: stableMessages, agentActive: true },
			finished: { messages: stableMessages, agentActive: false },
		};
		expect(collectTranscriptInvalidationIds(before, after)).toEqual(["parent", "finished"]);
	});
});

describe("侧栏悬停控制器计时与目标隔离", () => {
	it("停留 300ms 才打开，提前离开不会请求打开卡片", () => {
		const controller = createSessionHoverController();
		const a = target("A");
		controller.pointerEnter(a);
		vi.advanceTimersByTime(299);
		expect(controller.getSnapshot()).toBeNull();
		controller.pointerLeave(a.element);
		vi.advanceTimersByTime(1000);
		expect(controller.getSnapshot()).toBeNull();
		controller.pointerEnter(a);
		vi.advanceTimersByTime(300);
		expect(controller.getSnapshot()).toBe(a);
	});

	it("离开双方后 200ms 关闭；穿过间隙进入卡片或返回行会取消关闭", () => {
		const controller = createSessionHoverController();
		const a = target("A");
		controller.pointerEnter(a);
		vi.advanceTimersByTime(300);
		controller.pointerLeave(a.element);
		vi.advanceTimersByTime(199);
		controller.enterCard();
		vi.advanceTimersByTime(1000);
		expect(controller.getSnapshot()).toBe(a);
		controller.leaveCard();
		vi.advanceTimersByTime(150);
		controller.pointerEnter(a);
		vi.advanceTimersByTime(1000);
		expect(controller.getSnapshot()).toBe(a);
		controller.pointerLeave(a.element);
		vi.advanceTimersByTime(200);
		expect(controller.getSnapshot()).toBeNull();
	});

	it("切目标立即撤掉旧卡，300ms 从新目标重新计时，不串旧计时器", () => {
		const onClose = vi.fn();
		const controller = createSessionHoverController({ onClose });
		const a = target("A");
		const b = target("B");
		const c = target("C");
		controller.pointerEnter(a);
		vi.advanceTimersByTime(300);
		controller.pointerLeave(a.element);
		controller.pointerEnter(b);
		expect(controller.getSnapshot()).toBeNull();
		expect(onClose).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(150);
		controller.pointerLeave(b.element);
		controller.pointerEnter(c);
		vi.advanceTimersByTime(299);
		expect(controller.getSnapshot()).toBeNull();
		vi.advanceTimersByTime(1);
		expect(controller.getSnapshot()).toBe(c);
	});

	it("相同目标重复进入不替换打开快照，不制造 React 更新循环", () => {
		const controller = createSessionHoverController();
		const a = target("A");
		const changed = vi.fn();
		const unsubscribe = controller.subscribe(changed);
		controller.pointerEnter(a);
		vi.advanceTimersByTime(300);
		controller.pointerEnter({ ...a });
		controller.focusRow({ ...a });
		expect(controller.getSnapshot()).toBe(a);
		expect(changed).toHaveBeenCalledOnce();
		unsubscribe();
		controller.dismiss();
		expect(changed).toHaveBeenCalledOnce();
	});
});

describe("键盘、Escape 与模态关闭", () => {
	it("键盘焦点立即可查看，但控制器不自动抢焦点或选择会话", () => {
		const controller = createSessionHoverController();
		const a = target("A");
		controller.focusRow(a);
		expect(controller.getSnapshot()).toBe(a);
		expect(a.element.focus).not.toHaveBeenCalled();
		controller.blurRow(a.element);
		controller.focusCard();
		vi.advanceTimersByTime(1000);
		expect(controller.getSnapshot()).toBe(a);
		controller.blurCard();
		vi.advanceTimersByTime(200);
		expect(controller.getSnapshot()).toBeNull();
	});

	it("卡片键盘聚焦时鼠标离开不关闭；返回行也不困住焦点", () => {
		const controller = createSessionHoverController();
		const a = target("A");
		controller.focusRow(a);
		controller.blurRow(a.element);
		controller.focusCard();
		controller.enterCard();
		controller.leaveCard();
		vi.advanceTimersByTime(1000);
		expect(controller.getSnapshot()).toBe(a);
		controller.blurCard();
		controller.focusRow(a);
		vi.advanceTimersByTime(1000);
		expect(controller.getSnapshot()).toBe(a);
	});

	it("Escape 关闭后，指针停留及主动归还焦点都不能立即重开", () => {
		const controller = createSessionHoverController();
		const a = target("A");
		controller.pointerEnter(a);
		vi.advanceTimersByTime(300);
		controller.focusCard();
		controller.dismiss();
		controller.restoreFocus(() => controller.focusRow(a));
		controller.pointerEnter(a);
		vi.advanceTimersByTime(1000);
		expect(controller.getSnapshot()).toBeNull();
		controller.blurRow(a.element);
		controller.focusRow(a); // 真正重新聚焦是新的键盘意图
		expect(controller.getSnapshot()).toBe(a);
	});

	it("Escape 后离开再进入允许再次悬停", () => {
		const controller = createSessionHoverController();
		const a = target("A");
		controller.pointerEnter(a);
		vi.advanceTimersByTime(300);
		controller.dismiss();
		controller.pointerLeave(a.element);
		controller.pointerEnter(a);
		vi.advanceTimersByTime(300);
		expect(controller.getSnapshot()).toBe(a);
	});

	it("只用鼠标开过卡片，关闭后新的键盘聚焦仍能打开", () => {
		const controller = createSessionHoverController();
		const a = target("A");
		controller.pointerEnter(a);
		vi.advanceTimersByTime(300);
		controller.dismiss();
		controller.focusRow(a);
		expect(controller.getSnapshot()).toBe(a);
	});

	it("设置/侧栏折叠禁用时取消待打开与已打开状态，不在解除禁用后自行重开", () => {
		const controller = createSessionHoverController();
		const a = target("A");
		controller.pointerEnter(a);
		vi.advanceTimersByTime(100);
		controller.setEnabled(false);
		vi.advanceTimersByTime(500);
		expect(controller.getSnapshot()).toBeNull();
		controller.setEnabled(true);
		vi.advanceTimersByTime(500);
		expect(controller.getSnapshot()).toBeNull();
		controller.pointerLeave(a.element);
		controller.focusRow(a);
		expect(controller.getSnapshot()).toBe(a);
		controller.setEnabled(false);
		expect(controller.getSnapshot()).toBeNull();
	});

	it("到期复核锚点/模态有效性，不能在信任弹窗后迟到开卡", () => {
		let allowed = true;
		const controller = createSessionHoverController({ canOpen: () => allowed });
		controller.pointerEnter(target("A"));
		allowed = false;
		vi.advanceTimersByTime(300);
		expect(controller.getSnapshot()).toBeNull();
	});

	it("卸载/reset 清除所有计时器与抑制态", () => {
		const controller = createSessionHoverController();
		const a = target("A");
		controller.pointerEnter(a);
		controller.reset();
		vi.advanceTimersByTime(1000);
		expect(controller.getSnapshot()).toBeNull();
		controller.focusRow(a);
		controller.dismiss();
		controller.reset();
		controller.pointerEnter(a);
		vi.advanceTimersByTime(300);
		expect(controller.getSnapshot()).toBe(a);
	});
});
