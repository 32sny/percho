import type { ControlSnapshot } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { resolveCompactionSendPolicy } from "./compaction-gate";

const snap = (over: Partial<ControlSnapshot> = {}): ControlSnapshot => ({
	runtimeId: "rt1",
	revision: 1,
	phase: "idle",
	autoDispatchPaused: false,
	items: [],
	...over,
});

describe("resolveCompactionSendPolicy", () => {
	it("非压缩态：无压缩指示、不拦发送", () => {
		expect(
			resolveCompactionSendPolicy({
				transcriptCompacting: false,
				control: snap(),
				controlReady: true,
			}),
		).toEqual({ compacting: false, blocked: false, autoDispatch: false });
	});

	it("无快照也算非压缩态（尚未加载控制通道）", () => {
		expect(
			resolveCompactionSendPolicy({ transcriptCompacting: false, control: null, controlReady: false }),
		).toEqual({ compacting: false, blocked: false, autoDispatch: false });
	});

	it("auto 压缩 + 控制 API 完整：保留压缩指示，但放行（可排队/插话/打断）", () => {
		expect(
			resolveCompactionSendPolicy({
				transcriptCompacting: true,
				control: snap({ phase: "compacting", compactionKind: "auto" }),
				controlReady: true,
			}),
		).toEqual({ compacting: true, blocked: false, autoDispatch: true });
	});

	it("auto 压缩但控制 API 不完整：保守拒绝（不放宽 legacy 宿主）", () => {
		expect(
			resolveCompactionSendPolicy({
				transcriptCompacting: true,
				control: snap({ phase: "compacting", compactionKind: "auto" }),
				controlReady: false,
			}),
		).toEqual({ compacting: true, blocked: true, autoDispatch: false });
	});

	it.each(["auto-无快照", "auto-kind-缺失", "manual"] as const)(
		"保守拒绝分支 %s：压缩指示保留、禁发",
		(kind) => {
			const cases = {
				"auto-无快照": { transcriptCompacting: true, control: null, controlReady: true },
				"auto-kind-缺失": {
					transcriptCompacting: true,
					control: snap({ phase: "compacting" }),
					controlReady: true,
				},
				manual: {
					transcriptCompacting: false,
					control: snap({ phase: "compacting", compactionKind: "manual" }),
					controlReady: true,
				},
			} as const;
			expect(resolveCompactionSendPolicy(cases[kind])).toEqual({
				compacting: true,
				blocked: true,
				autoDispatch: false,
			});
		},
	);

	it("事件态压缩中但快照不认为压缩（kind 无从判断）：保守拒绝", () => {
		expect(
			resolveCompactionSendPolicy({
				transcriptCompacting: true,
				control: snap({ phase: "running" }),
				controlReady: true,
			}),
		).toEqual({ compacting: true, blocked: true, autoDispatch: false });
	});

	it("事件态已结束但快照仍在 auto：以快照为准放行（发送时判定）", () => {
		expect(
			resolveCompactionSendPolicy({
				transcriptCompacting: false,
				control: snap({ phase: "compacting", compactionKind: "auto" }),
				controlReady: true,
			}),
		).toEqual({ compacting: true, blocked: false, autoDispatch: true });
	});
});
