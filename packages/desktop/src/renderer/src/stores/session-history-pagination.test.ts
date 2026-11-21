import type { SessionHistoryWindow, SessionMessage } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pi = vi.hoisted(() => ({
	getSessionHistoryWindow: vi.fn(),
	getSessionHistoryPage: vi.fn(),
	getSessionMessages: vi.fn(),
}));
vi.mock("../api", () => ({ getPi: () => pi }));

import {
	clearSessionHistory,
	historyWindowMessages,
	loadHistoryThrough,
	loadOlderSessionHistory,
	requestSessionHistoryWindow,
	setSessionHistoryWindow,
} from "./session-history";
import { useTranscriptStore } from "./transcript";

function user(text: string, timestamp: number): SessionMessage {
	return { role: "user", text, thinking: "", tools: [], images: [], timestamp, entryId: `u${timestamp}` };
}

function windowOf(
	messages: SessionMessage[],
	values: Partial<SessionHistoryWindow> = {},
): SessionHistoryWindow {
	return {
		messages,
		hasOlder: false,
		startIndex: 0,
		generation: "generation-1",
		...values,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const sessionId = "history-pagination-session";

beforeEach(() => {
	vi.resetAllMocks();
	useTranscriptStore.setState({ bySession: {} });
});

afterEach(() => clearSessionHistory(sessionId));

describe("session history pagination", () => {
	it("prepends older messages and generates page-scoped UI ids", async () => {
		const initial = windowOf([user("newer", 2)], {
			hasOlder: true,
			cursor: "cursor-1",
			startIndex: 20,
			generation: "generation-1",
		});
		const older = windowOf([user("older", 1)], {
			startIndex: 10,
			generation: "generation-1",
		});
		setSessionHistoryWindow(sessionId, initial);
		useTranscriptStore.getState().loadHistory(sessionId, historyWindowMessages(initial));
		pi.getSessionHistoryPage.mockResolvedValue(older);

		expect(await loadOlderSessionHistory(sessionId, () => true)).toBe(true);
		const messages = useTranscriptStore.getState().bySession[sessionId]?.messages ?? [];
		expect(messages.map((message) => (message.kind === "user" ? message.text : message.kind))).toEqual([
			"older",
			"newer",
		]);
		expect(messages[0]?.id).not.toBe(messages[1]?.id);
		expect(pi.getSessionHistoryPage).toHaveBeenCalledWith({ sessionId, cursor: "cursor-1" });
	});

	it("discards a late page after the active history window changes", async () => {
		const initial = windowOf([user("newer", 2)], {
			hasOlder: true,
			cursor: "cursor-1",
			generation: "generation-1",
		});
		setSessionHistoryWindow(sessionId, initial);
		useTranscriptStore.getState().loadHistory(sessionId, historyWindowMessages(initial));
		const page = deferred<SessionHistoryWindow>();
		pi.getSessionHistoryPage.mockReturnValue(page.promise);
		const loading = loadOlderSessionHistory(sessionId, () => true);
		setSessionHistoryWindow(sessionId, windowOf([user("replacement", 3)], { generation: "generation-2" }));
		page.resolve(windowOf([user("obsolete", 1)], { generation: "generation-1" }));

		expect(await loading).toBe(false);
		expect(
			useTranscriptStore
				.getState()
				.bySession[sessionId]?.messages.map((message) =>
					message.kind === "user" ? message.text : message.kind,
				),
		).toEqual(["newer"]);
	});

	it("falls back to full history when the newest turn exceeds the page hard limit", async () => {
		pi.getSessionHistoryWindow.mockRejectedValue(new Error("HISTORY_PAGE_TOO_LARGE: turn exceeds 1 MiB"));
		pi.getSessionMessages.mockResolvedValue([user("large image turn", 1)]);

		const window = await requestSessionHistoryWindow(sessionId);

		expect(window.messages).toEqual([user("large image turn", 1)]);
		expect(window.hasOlder).toBe(false);
		expect(window.generation).toContain("fallback:");
	});

	it("falls back to full history when an older turn exceeds the page hard limit", async () => {
		const initial = windowOf([user("newer", 2)], {
			hasOlder: true,
			cursor: "cursor-1",
			generation: "generation-1",
		});
		setSessionHistoryWindow(sessionId, initial);
		useTranscriptStore.getState().loadHistory(sessionId, historyWindowMessages(initial));
		useTranscriptStore.setState((state) => ({
			bySession: {
				...state.bySession,
				[sessionId]: { ...state.bySession[sessionId]!, agentActive: true },
			},
		}));
		pi.getSessionHistoryPage.mockRejectedValue(new Error("HISTORY_PAGE_TOO_LARGE: turn exceeds 1 MiB"));
		pi.getSessionMessages.mockResolvedValue([user("older", 1), user("newer", 2)]);

		expect(await loadOlderSessionHistory(sessionId, () => true)).toBe(true);
		expect(
			useTranscriptStore
				.getState()
				.bySession[sessionId]?.messages.map((message) =>
					message.kind === "user" ? message.text : message.kind,
				),
		).toEqual(["older", "newer"]);
		expect(useTranscriptStore.getState().bySession[sessionId]?.agentActive).toBe(true);
		expect(await loadOlderSessionHistory(sessionId, () => true)).toBe(false);
		expect(pi.getSessionHistoryPage).toHaveBeenCalledOnce();
	});

	it("a navigation jump can take over an older-page request cancelled by its own intent", async () => {
		const initial = windowOf([user("newer", 2)], { hasOlder: true, cursor: "cursor-1", startIndex: 2 });
		const older = windowOf([user("older", 1)]);
		setSessionHistoryWindow(sessionId, initial);
		useTranscriptStore.getState().loadHistory(sessionId, historyWindowMessages(initial));
		const page = deferred<SessionHistoryWindow>();
		pi.getSessionHistoryPage.mockReturnValueOnce(page.promise).mockResolvedValueOnce(older);
		let reading = true;
		const scroll = loadOlderSessionHistory(sessionId, () => reading);
		reading = false;
		const jump = loadHistoryThrough(sessionId, "u1", () => true);
		expect(pi.getSessionHistoryPage).toHaveBeenCalledOnce();
		page.resolve(older);
		expect(await scroll).toBe(false);
		expect(await jump).toBe(true);
		expect(pi.getSessionHistoryPage).toHaveBeenCalledTimes(2);
		expect(useTranscriptStore.getState().bySession[sessionId]?.messages).toHaveLength(2);
	});

	it("does not request a page after the view has moved to another session", async () => {
		const initial = windowOf([user("newer", 2)], { hasOlder: true, cursor: "cursor-1" });
		setSessionHistoryWindow(sessionId, initial);

		expect(await loadOlderSessionHistory(sessionId, () => false)).toBe(false);
		expect(pi.getSessionHistoryPage).not.toHaveBeenCalled();
	});
});
