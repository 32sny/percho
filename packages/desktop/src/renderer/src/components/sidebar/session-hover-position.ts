import type { MenuAnchor, MenuSize, ViewportSize } from "../ui/place-menu";

export const SESSION_HOVER_WIDTH = 360;
const MARGIN = 8;
const GAP = 8;

export interface SessionHoverPosition {
	x: number;
	y: number;
	width: number;
	maxHeight: number;
	side: "right" | "left";
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), Math.max(min, max));
}

/** 侧向定位独立于菜单：右侧优先 → 左翻 → 夹入视口；高度约束交给卡片内部滚动。 */
export function positionSessionHoverCard(
	anchor: MenuAnchor,
	size: MenuSize,
	viewport: ViewportSize,
): SessionHoverPosition {
	const viewportWidth = Math.max(0, viewport.width);
	const viewportHeight = Math.max(0, viewport.height);
	// 极小/最小化视口无法保留两侧 8px 时，把可用空间降到 0，不产生负尺寸。
	const marginX = Math.min(MARGIN, viewportWidth / 2);
	const marginY = Math.min(MARGIN, viewportHeight / 2);
	const width = Math.min(SESSION_HOVER_WIDTH, Math.max(0, size.width), viewportWidth - marginX * 2);
	const maxHeight = viewportHeight - marginY * 2;
	const height = Math.min(Math.max(0, size.height), maxHeight);
	const right = anchor.left + anchor.width + GAP;
	const side = right + width <= viewportWidth - marginX ? "right" : "left";
	return {
		x: clamp(side === "right" ? right : anchor.left - GAP - width, marginX, viewportWidth - width - marginX),
		y: clamp(anchor.top, marginY, viewportHeight - height - marginY),
		width,
		maxHeight,
		side,
	};
}
