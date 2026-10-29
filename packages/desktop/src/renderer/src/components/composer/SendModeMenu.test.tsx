import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({
	useT: () => (key: string) => key,
}));

import type { ControlledItem } from "@percho/shared";

beforeEach(() => vi.stubGlobal("React", React)); // classic JSX：给产品文件提供 React 全局（仅本文件）
afterEach(() => vi.unstubAllGlobals());

import { QueueBar, queueItemActions } from "./QueueBar";
import { SendModeMenu } from "./SendModeMenu";

const item = (over: Partial<ControlledItem> = {}): ControlledItem => ({
	messageId: "m1",
	source: "user",
	mode: "queue",
	state: "queued",
	preview: "待办内容",
	imageCount: 0,
	...over,
});

describe("SendModeMenu", () => {
	it("提供一次性模式项：优先插话 / 打断并发送（各自边界描述），不含默认模式记忆", () => {
		const html = renderToStaticMarkup(
			<SendModeMenu disabledReason={null} onPick={() => {}} onClose={() => {}} />,
		);
		expect(html).toContain("composer.modeSteer");
		expect(html).toContain("composer.modeSteerDesc");
		expect(html).toContain("composer.modeInterrupt");
		expect(html).toContain("composer.modeInterruptDesc");
		// 一次性菜单：不出现「设为默认」类入口
		expect(html).not.toContain("modeMakeDefault");
	});

	it("禁用态渲染可解释原因（readOnly / compacting / slash）", () => {
		const html = renderToStaticMarkup(
			<SendModeMenu disabledReason="composer.modeDisabledSlash" onPick={() => {}} onClose={() => {}} />,
		);
		expect(html).toContain("composer.modeDisabledSlash");
		expect(html).toContain('aria-disabled="true"');
	});
});

describe("queueItemActions（队列项可用操作）", () => {
	it("queued(queue)：优先插话 / 打断并发送 / 取回 / 放弃", () => {
		expect(queueItemActions(item())).toEqual(["steer", "interrupt", "recover", "discard"]);
	});
	it("queued(steer)：不重复提供插话", () => {
		expect(queueItemActions(item({ mode: "steer" }))).toEqual(["interrupt", "recover", "discard"]);
	});
	it("held：重发 / 取回 / 放弃（不再 steer）", () => {
		expect(queueItemActions(item({ state: "held" }))).toEqual(["resend", "recover", "discard"]);
	});
	it("recovering：重载后可再次取回，但不能自动重发", () => {
		expect(queueItemActions(item({ state: "recovering" }))).toEqual(["recover"]);
	});
});

describe("QueueBar", () => {
	it("后台 recovering 项在渲染器重载丢失草稿后仍提供取回入口", () => {
		const html = renderToStaticMarkup(
			<QueueBar items={[item({ state: "recovering", imageCount: 1 })]} onAction={() => {}} />,
		);
		expect(html).toContain("composer.queueActionRecover");
		expect(html).not.toContain("composer.queueActionResend");
	});
	it("渲染控制项：状态标签 + 预览 + 图片计数", () => {
		const html = renderToStaticMarkup(
			<QueueBar
				items={[item({ imageCount: 2 }), item({ messageId: "m2", state: "held", preview: "被冻结" })]}
				onAction={() => {}}
			/>,
		);
		expect(html).toContain("composer.queueStateQueued");
		expect(html).toContain("composer.queueStateHeld");
		expect(html).toContain("待办内容");
		expect(html).toContain("被冻结");
		expect(html).toContain("2");
	});

	it("legacy 文本模式：首条排队文本 + 取回", () => {
		const html = renderToStaticMarkup(<QueueBar legacyText="旧排队" onRestore={() => {}} />);
		expect(html).toContain("旧排队");
		expect(html).toContain("composer.queueRestore");
	});
});
