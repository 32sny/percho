import { describe, expect, it } from "vitest";
import { positionSessionHoverCard } from "./session-hover-position";

const row = { left: 8, top: 120, width: 224, height: 31 };
const card = { width: 360, height: 280 };

describe("会话悬停卡定位", () => {
	it("优先在行右侧，保留 8px 间隙", () => {
		expect(positionSessionHoverCard(row, card, { width: 1200, height: 800 })).toEqual({
			x: 240,
			y: 120,
			width: 360,
			maxHeight: 784,
			side: "right",
		});
	});

	it("右侧不足且左侧可放时翻到左侧", () => {
		expect(positionSessionHoverCard({ ...row, left: 800 }, card, { width: 1100, height: 800 })).toMatchObject(
			{ x: 432, y: 120, side: "left" },
		);
	});

	it("右侧恰好满足最小视口边距时不翻转", () => {
		expect(positionSessionHoverCard(row, card, { width: 608, height: 800 }).side).toBe("right");
	});

	it("屏幕底部向上夹取，顶部也保留 8px", () => {
		expect(positionSessionHoverCard({ ...row, top: 780 }, card, { width: 1200, height: 800 }).y).toBe(512);
		expect(positionSessionHoverCard({ ...row, top: -20 }, card, { width: 1200, height: 800 }).y).toBe(8);
	});

	it("两侧都放不下时缩到视口宽度减 16px，再夹入视口", () => {
		expect(positionSessionHoverCard(row, card, { width: 320, height: 500 })).toEqual({
			x: 8,
			y: 120,
			width: 304,
			maxHeight: 484,
			side: "left",
		});
	});

	it("超高内容只限制卡片高度，不把卡片顶端推出屏幕", () => {
		expect(
			positionSessionHoverCard(row, { width: 360, height: 9000 }, { width: 1200, height: 240 }),
		).toMatchObject({ x: 240, y: 8, width: 360, maxHeight: 224 });
	});

	it("测量值超过目标宽度时仍限制在 360px", () => {
		expect(
			positionSessionHoverCard(row, { width: 900, height: 40 }, { width: 1200, height: 800 }).width,
		).toBe(360);
	});

	it("零尺寸与极小视口不产生负尺寸或非有限坐标", () => {
		for (const viewport of [
			{ width: 0, height: 0 },
			{ width: 10, height: 12 },
		]) {
			const result = positionSessionHoverCard(row, card, viewport);
			expect(result.width).toBeGreaterThanOrEqual(0);
			expect(result.maxHeight).toBeGreaterThanOrEqual(0);
			expect(result.x).toBeGreaterThanOrEqual(0);
			expect(result.y).toBeGreaterThanOrEqual(0);
			expect(result.x + result.width).toBeLessThanOrEqual(viewport.width);
			expect(result.y).toBeLessThanOrEqual(viewport.height);
		}
	});
});
