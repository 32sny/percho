import { beforeEach, describe, expect, it, vi } from "vitest";

const pi = vi.hoisted(() => ({
	getMessageControl: vi.fn(),
	changePendingMessage: vi.fn(),
	legacy: false,
}));

vi.mock("../api", () => ({
	getPi: () =>
		pi.legacy
			? {}
			: { getMessageControl: pi.getMessageControl, changePendingMessage: pi.changePendingMessage },
}));

import type { ControlSnapshot } from "@percho/shared";
import {
	discardPendingPayloads,
	pendingPayloadItems,
	setPendingPayloadConfirmation,
} from "./pending-payloads";
import { useTranscriptStore } from "./transcript";

const snap = (over: Partial<ControlSnapshot> = {}): ControlSnapshot => ({
	runtimeId: "rt1",
	revision: 3,
	phase: "idle",
	autoDispatchPaused: false,
	items: [
		{
			messageId: "m1",
			source: "user",
			mode: "queue",
			state: "queued",
			preview: "a",
			imageCount: 0,
		},
		{
			messageId: "m2",
			source: "user",
			mode: "queue",
			state: "held",
			preview: "b",
			imageCount: 1,
		},
	],
	...over,
});
const ok = <T>(value: T) => ({ ok: true as const, value });

describe("pending-payloads（关闭/删除前的待发载荷守卫）", () => {
	beforeEach(() => {
		useTranscriptStore.setState({ bySession: {} });
		pi.legacy = false;
		pi.getMessageControl.mockReset();
		pi.changePendingMessage.mockReset();
		setPendingPayloadConfirmation(() => true);
	});

	it("pendingPayloadItems 读投影快照；无快照为空", () => {
		expect(pendingPayloadItems("s1")).toEqual([]);
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		expect(pendingPayloadItems("s1").map((i) => i.messageId)).toEqual(["m1", "m2"]);
	});

	it("legacy（无控制通道）：无可丢弃实体，返回 empty", async () => {
		pi.legacy = true;
		expect(await discardPendingPayloads("s1")).toBe("empty");
	});

	it("用户取消专项确认时不执行任何 discard", async () => {
		const restore = setPendingPayloadConfirmation(() => false);
		pi.getMessageControl.mockResolvedValue(ok(snap()));
		expect(await discardPendingPayloads("s1")).toBe("cancelled");
		expect(pi.getMessageControl).toHaveBeenCalledTimes(1);
		expect(pi.changePendingMessage).not.toHaveBeenCalled();
		restore();
	});

	it("确认期间新增 item：确认后复核集合变化，不 discard", async () => {
		pi.getMessageControl
			.mockResolvedValueOnce(ok(snap()))
			.mockResolvedValueOnce(
				ok(snap({ items: [...snap().items, { ...snap().items[0]!, messageId: "m3" }] })),
			);
		expect(await discardPendingPayloads("s1")).toBe("changed");
		expect(pi.changePendingMessage).not.toHaveBeenCalled();
	});

	it("确认期间 runtime 替换：不 discard 新实例中的项目", async () => {
		pi.getMessageControl
			.mockResolvedValueOnce(ok(snap()))
			.mockResolvedValueOnce(ok(snap({ runtimeId: "rt2" })));
		expect(await discardPendingPayloads("s1")).toBe("changed");
		expect(pi.changePendingMessage).not.toHaveBeenCalled();
	});

	it("逐 messageId + 最新 revision 显式 discard；完成后无残留返回 ok", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		pi.getMessageControl
			.mockResolvedValueOnce(ok(snap())) // 初次
			.mockResolvedValueOnce(ok(snap())) // 确认后集合复核
			.mockResolvedValueOnce(ok(snap({ revision: 5, items: [] }))); // 复核
		pi.changePendingMessage.mockResolvedValue(ok({ snapshot: snap({ revision: 4 }) }));
		expect(await discardPendingPayloads("s1")).toBe("ok");
		expect(pi.changePendingMessage).toHaveBeenCalledTimes(2);
		for (const [index, messageId] of ["m1", "m2"].entries()) {
			expect(pi.changePendingMessage.mock.calls[index]![0]).toMatchObject({
				sessionId: "s1",
				runtimeId: "rt1",
				messageId,
				action: "discard",
			});
		}
		// 复核快照已钉进 store
		expect(useTranscriptStore.getState().bySession.s1?.control?.revision).toBe(5);
	});

	it("中途新 item 加入：复核发现残留 → changed（不暗丢新项，调用方须再次确认/停止）", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		pi.getMessageControl
			.mockResolvedValueOnce(ok(snap()))
			.mockResolvedValueOnce(ok(snap())) // 确认后集合复核
			.mockResolvedValueOnce(
				ok(
					snap({
						revision: 6,
						items: [
							{
								messageId: "m3",
								source: "user",
								mode: "queue",
								state: "queued",
								preview: "新来的",
								imageCount: 0,
							},
						],
					}),
				),
			);
		pi.changePendingMessage.mockResolvedValue(ok({ snapshot: snap({ revision: 4 }) }));
		expect(await discardPendingPayloads("s1")).toBe("changed");
		// 只 discard 了原快照的两条，没动 m3
		expect(pi.changePendingMessage.mock.calls.map((c) => (c[0] as { messageId: string }).messageId)).toEqual([
			"m1",
			"m2",
		]);
	});

	it("历史会话没有本地 control 且后端 not_found：兼容为空", async () => {
		pi.getMessageControl.mockResolvedValue({ ok: false, error: { code: "not_found", message: "closed" } });
		expect(await discardPendingPayloads("history")).toBe("empty");
		expect(pi.changePendingMessage).not.toHaveBeenCalled();
	});

	it("快照拉取失败：unavailable（调用方中止，不静默丢）", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		pi.getMessageControl.mockRejectedValue(new Error("ipc down"));
		expect(await discardPendingPayloads("s1")).toBe("unavailable");
		expect(pi.changePendingMessage).not.toHaveBeenCalled();
	});
});
