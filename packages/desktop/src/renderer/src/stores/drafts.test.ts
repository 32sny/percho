import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_DRAFT, isDraftEmpty, useDraftStore } from "./drafts";

describe("draft dequeue protection marker", () => {
	beforeEach(() => useDraftStore.setState({ bySession: {} }));

	it("clearing returned content retains the pending-dequeue marker for the next edit", () => {
		const recovery = { messageId: "pending-1", expectedRevision: 8 };
		useDraftStore.getState().updateDraft("s1", () => ({ ...EMPTY_DRAFT, text: "original", recovery }));
		useDraftStore.getState().updateDraft("s1", (draft) => ({ ...draft, text: "" }));
		expect(useDraftStore.getState().bySession.s1?.recovery).toEqual(recovery);
		const cleared = useDraftStore.getState().bySession.s1;
		if (!cleared) throw new Error("Recovered draft was lost");
		expect(isDraftEmpty(cleared)).toBe(true);
		useDraftStore.getState().updateDraft("s1", (draft) => ({ ...draft, text: "replacement" }));
		expect(useDraftStore.getState().bySession.s1).toMatchObject({ text: "replacement", recovery });
	});

	it("deleting the last image retains recovery but explicit release removes an empty entry", () => {
		useDraftStore.getState().updateDraft("s1", () => ({
			...EMPTY_DRAFT,
			images: [{ data: "AAAA", mimeType: "image/png" }],
			recovery: { messageId: "image-1", expectedRevision: 8 },
		}));
		useDraftStore.getState().updateDraft("s1", (draft) => ({ ...draft, images: [] }));
		expect(useDraftStore.getState().bySession.s1?.recovery?.messageId).toBe("image-1");
		useDraftStore.getState().updateDraft("s1", (draft) => ({ ...draft, recovery: undefined }));
		expect(useDraftStore.getState().bySession.s1).toBeUndefined();
	});

	it("ordinary empty drafts are still removed", () => {
		useDraftStore.getState().updateDraft("s1", () => ({ ...EMPTY_DRAFT, text: "normal" }));
		useDraftStore.getState().updateDraft("s1", (draft) => ({ ...draft, text: "" }));
		expect(useDraftStore.getState().bySession.s1).toBeUndefined();
	});
});
