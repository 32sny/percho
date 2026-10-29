import type { ControlSnapshot, MessagePayload } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";
import { createMessageControlAdapter, validateControlledPayload } from "../src/session/message-control";

const snapshot: ControlSnapshot = {
	runtimeId: "runtime-1",
	revision: 1,
	phase: "idle",
	autoDispatchPaused: false,
	items: [],
};

function makeHandle() {
	return {
		submit: vi.fn(async (req: unknown, source?: string) => ({
			ok: true as const,
			value: { requestId: "request-1", messageId: "message-1", disposition: "started" as const },
		})),
		getSnapshot: vi.fn(() => snapshot),
		changePending: vi.fn(),
		recover: vi.fn(),
		stop: vi.fn(),
		subscribe: vi.fn(() => () => {}),
		signal: new AbortController().signal,
		waitForIdle: vi.fn(async () => {}),
		dispose: vi.fn(),
	};
}

describe("message control backend adapter", () => {
	it("forces user source at the host boundary and preserves the SDK result", async () => {
		const handle = makeHandle();
		const adapter = createMessageControlAdapter(handle);
		const request = {
			sessionId: "s1",
			runtimeId: "runtime-1",
			requestId: "request-1",
			mode: "queue" as const,
			payload: { text: "hello" },
		};

		await expect(adapter.submit(request)).resolves.toMatchObject({ ok: true });
		expect(handle.submit).toHaveBeenCalledWith(request, "user");
	});

	it("rejects malformed image payloads without rewriting valid encoded data", () => {
		const payload: MessagePayload = { text: "see image", images: [{ data: "YWJj", mimeType: "image/png" }] };
		expect(validateControlledPayload(payload)).toEqual({ ok: true, value: payload });
		expect(
			validateControlledPayload({ text: "x", images: [{ data: "%%%", mimeType: "image/png" }] }),
		).toMatchObject({
			ok: false,
			error: { code: "invalid_payload" },
		});
	});
});
