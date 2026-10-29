import { describe, expect, it, vi } from "vitest";
import {
	createQuitConfirmationRequest,
	pendingMessageCount,
	shouldConfirmQuitWithPendingMessages,
} from "./message-control-exit";

describe("message-control exit guard", () => {
	it("counts all pending items and deduplicates the active operation message", () => {
		expect(
			pendingMessageCount([
				{
					phase: "idle",
					items: [
						{ messageId: "q", source: "user", state: "queued" },
						{ messageId: "h", source: "user", state: "held" },
					],
				},
				{ phase: "interrupting", operation: { messageId: "q", sendAfterStop: true }, items: [] },
				{
					phase: "running",
					items: [
						{ messageId: "sys", source: "system", state: "queued" },
						{ messageId: "ext", source: "extension", state: "held" },
					],
				},
			]),
		).toBe(4);
		expect(
			shouldConfirmQuitWithPendingMessages([
				{ phase: "idle", items: [{ messageId: "x", source: "system", state: "held" }] },
			]),
		).toBe(true);
	});

	it("single-flights dialogs and asks again when the item set changes during confirmation", async () => {
		let snapshots: { phase: string; items: { messageId: string; source: string; state: string }[] }[] = [
			{ phase: "idle", items: [{ messageId: "one", source: "user", state: "queued" }] },
		];
		let resolveFirst!: (value: boolean) => void;
		const confirm = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<boolean>((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockResolvedValueOnce(true);
		const quit = vi.fn();
		const request = createQuitConfirmationRequest({ getSnapshots: () => snapshots, confirm, quit });
		const first = request();
		const duplicate = request();
		expect(first).toBe(duplicate);
		snapshots = [{ phase: "idle", items: [{ messageId: "two", source: "system", state: "held" }] }];
		resolveFirst(true);
		await first;
		expect(confirm).toHaveBeenCalledTimes(2);
		expect(quit).toHaveBeenCalledTimes(1);
	});

	it("cancel leaves the app running", async () => {
		const quit = vi.fn();
		const request = createQuitConfirmationRequest({
			getSnapshots: () => [{ phase: "idle", items: [{ messageId: "x", source: "user", state: "queued" }] }],
			confirm: async () => false,
			quit,
		});
		await request();
		expect(quit).not.toHaveBeenCalled();
	});
});
