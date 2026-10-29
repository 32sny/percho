import type { SessionHoverPreviewResult, SessionHoverRelationChild } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { mergeSessionHoverPage, visibleSessionHoverChildren } from "./useSessionHoverPages";

const children = (start: number, count: number): SessionHoverRelationChild[] =>
	Array.from({ length: count }, (_, index) => ({
		sessionId: `child-${start + index}`,
		sessionFile: `/sessions-subagents/child-${start + index}.jsonl`,
		agent: "Explore",
		status: "done",
	}));
const page = (
	offset: number,
	count: number,
	total: number,
	revision?: string,
): SessionHoverPreviewResult => ({
	status: "empty",
	sessionId: "parent",
	relations: {
		children: children(offset, count),
		hidden: total - offset - count,
		offset,
		total,
		...(revision ? { revision } : {}),
	},
});

describe("悬停关系分页纯逻辑", () => {
	it("九条按 6 → 9 展开、收起立即回到 6，剩余计数准确", () => {
		const first = mergeSessionHoverPage(null, page(0, 6, 9, "r1"), "source", 0);
		const next = mergeSessionHoverPage(first, page(6, 3, 9, "r1"), "source", 6);
		expect(visibleSessionHoverChildren(first, false)).toEqual({ children: children(0, 6), hidden: 3 });
		expect(visibleSessionHoverChildren(next, true)).toEqual({ children: children(0, 9), hidden: 0 });
		expect(visibleSessionHoverChildren(next, false)).toEqual({ children: children(0, 6), hidden: 3 });
	});

	it("revision 變更、offset 不連續或缺失 revision 不拼接後頁", () => {
		const first = mergeSessionHoverPage(null, page(0, 6, 9, "r1"), "source", 0);
		expect(mergeSessionHoverPage(first, page(6, 3, 9, "r2"), "source", 6)).toBeNull();
		expect(mergeSessionHoverPage(first, page(3, 3, 9, "r1"), "source", 6)).toBeNull();
		expect(mergeSessionHoverPage(first, page(6, 3, 9), "source", 6)).toBeNull();
	});

	it("source key 變化不能沿用前一目標的已確認頁", () => {
		const first = mergeSessionHoverPage(null, page(0, 6, 9, "r1"), "parent-A", 0);
		expect(mergeSessionHoverPage(first, page(6, 3, 9, "r1"), "parent-B", 6)).toBeNull();
	});

	it("legacy 首屏可見，但沒有 revision 的舊頁不能合併新後頁", () => {
		const legacy = mergeSessionHoverPage(null, page(0, 6, 9), "source", 0);
		expect(legacy?.children).toHaveLength(6);
		expect(mergeSessionHoverPage(legacy, page(6, 3, 9, "r1"), "source", 6)).toBeNull();
	});
});
