import { describe, expect, it } from "vitest";
import { type DraftEntry, EMPTY_DRAFT } from "../../stores/drafts";
import { buildComposerSendContent, buildComposerSendSnapshot } from "./send-snapshot";

describe("composer send snapshot", () => {
	it("keeps quote, command, attachment and body order while retaining editable input", () => {
		const draft: DraftEntry = {
			text: "  review this  ",
			slashCommand: "skill:review",
			attachments: ["src/a.ts", "src/b.ts"],
			quotes: ["first\n\nsecond", "last"],
			images: [
				{ data: "AAAA", mimeType: "image/png", name: "one.png" },
				{ data: "BBBB", mimeType: "image/jpeg" },
			],
			recovery: { messageId: "protected", expectedRevision: 1 },
		};
		const snapshot = buildComposerSendSnapshot("s1", draft, "queue", true);
		expect(snapshot.content).toBe(
			"> first\n>\n> second\n\n> last\n\n/skill:review @src/a.ts @src/b.ts\nreview this",
		);
		expect(snapshot).toMatchObject({
			draftKey: "s1",
			text: draft.text,
			imageNames: ["one.png", ""],
			mode: "queue",
			wasActive: true,
		});
		expect(snapshot).not.toHaveProperty("recovery");
	});

	it("copies arrays and image objects rather than retaining editable references", () => {
		const image = { data: "AAAA", mimeType: "image/png", name: "before.png" };
		const draft = { ...EMPTY_DRAFT, images: [image], attachments: ["before.ts"], quotes: ["before"] };
		const snapshot = buildComposerSendSnapshot("__new__", draft, "interrupt", false);
		image.name = "after.png";
		draft.images.push({ ...image });
		draft.attachments[0] = "after.ts";
		draft.quotes[0] = "after";
		expect(snapshot.images).toEqual([{ data: "AAAA", mimeType: "image/png", name: "before.png" }]);
		expect(snapshot.attachments).toEqual(["before.ts"]);
		expect(snapshot.quotes).toEqual(["before"]);
		expect(snapshot.content).toBe("> before\n\n@before.ts");
	});

	it("preserves whitespace-only and command-only formatting", () => {
		expect(buildComposerSendContent({ ...EMPTY_DRAFT, text: " \n " })).toBe("");
		expect(buildComposerSendContent({ ...EMPTY_DRAFT, text: " \n ", slashCommand: "name" })).toBe("/name");
	});
});
