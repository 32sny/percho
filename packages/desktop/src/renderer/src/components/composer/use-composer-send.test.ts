import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	prompt: vi.fn(),
	setSessionName: vi.fn(),
	toast: vi.fn(),
	states: [] as unknown[][],
	activeSessionId: "s1",
}));

vi.mock("react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react")>();
	return {
		...actual,
		useState: (initial: unknown) => {
			const index = mocks.states.length;
			mocks.states.push([initial]);
			return [
				initial,
				(next: unknown) => {
					const previous = mocks.states[index]?.at(-1);
					mocks.states[index]?.push(
						typeof next === "function" ? (next as (value: unknown) => unknown)(previous) : next,
					);
				},
			];
		},
		useRef: (initial: unknown) => ({ current: initial }),
		useEffect: () => {},
	};
});
vi.mock("../../api", () => ({
	getPi: () => ({ prompt: mocks.prompt, setSessionName: mocks.setSessionName }),
}));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../stores/sessions", () => ({
	useSessionsStore: { getState: () => ({ activeSessionId: mocks.activeSessionId }) },
}));
vi.mock("../../stores/settings", () => ({ useSettingsStore: { getState: () => ({ openWith: vi.fn() }) } }));
vi.mock("../../stores/toasts", () => ({ pushToast: mocks.toast }));

import { buildChatRows, isAgentWorking, type PromptAck } from "@percho/shared";
import { useTranscriptStore } from "../../stores/transcript";
import { useComposerSend } from "./use-composer-send";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function promptGate<T = PromptAck>() {
	const entered = deferred<void>();
	const result = deferred<T>();
	mocks.prompt.mockImplementation(() => {
		entered.resolve();
		return result.promise;
	});
	return { entered, result };
}

function makeOptions(overrides: Record<string, unknown> = {}) {
	return {
		activeSessionId: "s1",
		text: "",
		images: [],
		attachments: [],
		quotes: [],
		slashCommand: "session-name-refresh",
		followUpQueue: [],
		compacting: false,
		imagesSupported: true,
		agentActive: false,
		setText: vi.fn(),
		setImages: vi.fn(),
		setAttachments: vi.fn(),
		setQuotes: vi.fn(),
		setSlashCommand: vi.fn(),
		...overrides,
	};
}

function entry(sessionId = "s1") {
	return useTranscriptStore.getState().bySession[sessionId];
}

function expectNotWorking(sessionId = "s1") {
	const transcript = entry(sessionId);
	expect(transcript).toBeDefined();
	if (!transcript) throw new Error(`Missing transcript for ${sessionId}`);
	expect(transcript.agentActive).toBe(false);
	expect(isAgentWorking(transcript)).toBe(false);
	expect(buildChatRows(transcript, sessionId).some((row) => row.kind === "metaGroup" && row.working)).toBe(
		false,
	);
}

describe("useComposerSend prompt acknowledgement", () => {
	beforeEach(() => {
		useTranscriptStore.setState({ bySession: {} });
		mocks.states.length = 0;
		mocks.prompt.mockReset().mockResolvedValue({ disposition: "handled" });
		mocks.toast.mockReset();
		mocks.setSessionName.mockReset().mockResolvedValue(undefined);
		mocks.activeSessionId = "s1";
	});

	it.each(["refresh", "status", "lock", "unlock"])(
		"handled /session-name-%s rolls back only its UI activity",
		async (command) => {
			const send = useComposerSend(makeOptions({ slashCommand: `session-name-${command}` }));
			const gate = promptGate();
			const pending = send.handleSend();
			await gate.entered.promise;
			expect(useTranscriptStore.getState().bySession.s1?.optimisticActivityToken).toBeTruthy();
			gate.result.resolve({ disposition: "handled" });
			await pending;
			expectNotWorking();
			expect(entry()?.optimisticActivityToken).toBeUndefined();
			expect(mocks.states[0]).toEqual([false, true, false]);
		},
	);

	it("handled plain text removes an unclaimed optimistic bubble", async () => {
		const send = useComposerSend(makeOptions({ text: "plain question", slashCommand: null }));
		const gate = promptGate();
		const pending = send.handleSend();
		await gate.entered.promise;
		expect(entry()?.messages).toHaveLength(1);
		expect(entry()?.optimisticActivityToken).toBeTruthy();
		gate.result.resolve({ disposition: "handled" });
		await pending;
		expect(entry()?.messages).toHaveLength(0);
		expectNotWorking();
	});

	it("handled does not remove an optimistic bubble already claimed by message_start", async () => {
		const send = useComposerSend(makeOptions({ text: "claimed text", slashCommand: null }));
		const gate = promptGate();
		const pending = send.handleSend();
		await gate.entered.promise;
		useTranscriptStore.getState().applyEvent("s1", {
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "claimed text" }] },
		} as never);
		gate.result.resolve({ disposition: "handled" });
		await pending;
		expect(entry()?.messages).toHaveLength(1);
		expect(entry()?.messages[0]).toMatchObject({ kind: "user", text: "claimed text" });
		expectNotWorking();
	});

	it.each([
		["plain text", { text: "question", slashCommand: null }],
		[
			"image",
			{
				text: "look",
				slashCommand: null,
				images: [{ data: "AAAA", mimeType: "image/png", name: "local.png" }],
			},
		],
		["skill", { text: "topic", slashCommand: "skill:mindmap" }],
		["template", { text: "topic", slashCommand: "template:review" }],
	] as const)("%s started keeps busy and authoritative user message", async (_label, overrides) => {
		const send = useComposerSend(makeOptions(overrides as Record<string, unknown>));
		const gate = promptGate<{ disposition: "started" }>();
		const pending = send.handleSend();
		await gate.entered.promise;
		expect(entry()?.optimisticActivityToken).toBeTruthy();
		useTranscriptStore.getState().applyEvent("s1", {
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "authoritative" }] },
		} as never);
		gate.result.resolve({ disposition: "started" });
		await pending;
		expect(entry()?.agentActive).toBe(true);
		expect(entry()?.messages.some((message) => message.kind === "user" && !message.pending)).toBe(true);
		if (_label === "image") {
			expect(mocks.prompt).toHaveBeenCalledWith({
				sessionId: "s1",
				text: "look",
				images: [{ data: "AAAA", mimeType: "image/png" }],
			});
		}
	});

	it.each(["queued", "handled"] as const)(
		"running session follow-up %s preserves existing busy and queue",
		async (disposition) => {
			useTranscriptStore.getState().applyEvent("s1", { type: "agent_start" } as never);
			useTranscriptStore.getState().setFollowUpQueue("s1", ["queued item"]);
			const send = useComposerSend(makeOptions({ text: "follow up", slashCommand: null, agentActive: true }));
			const gate = promptGate<{ disposition: "queued" | "handled" }>();
			const pending = send.handleSend();
			await gate.entered.promise;
			expect(entry()?.optimisticActivityToken).toBeUndefined();
			gate.result.resolve({ disposition });
			await pending;
			expect(entry()?.agentActive).toBe(true);
			expect(entry()?.followUpQueue).toEqual(["queued item"]);
		},
	);

	it.each(["handled", "reject"] as const)(
		"idle send is not cleared after real agent_start then %s",
		async (outcome) => {
			const send = useComposerSend(makeOptions({ text: "question", slashCommand: null }));
			const gate = promptGate();
			const pending = send.handleSend();
			await gate.entered.promise;
			const token = entry()?.optimisticActivityToken;
			expect(token).toBeTruthy();
			useTranscriptStore.getState().applyEvent("s1", { type: "agent_start" } as never);
			if (outcome === "handled") gate.result.resolve({ disposition: "handled" });
			else gate.result.reject(new Error("late failure"));
			await pending;
			expect(entry()?.agentActive).toBe(true);
			expect(entry()?.optimisticActivityToken).toBeUndefined();
		},
	);

	it("started acknowledgement before agent_start remains normal and lifecycle takes ownership", async () => {
		const send = useComposerSend(makeOptions({ text: "question", slashCommand: null }));
		const gate = promptGate<{ disposition: "started" }>();
		const pending = send.handleSend();
		await gate.entered.promise;
		gate.result.resolve({ disposition: "started" });
		await pending;
		expect(entry()?.agentActive).toBe(true);
		useTranscriptStore.getState().applyEvent("s1", { type: "agent_start" } as never);
		expect(entry()?.agentActive).toBe(true);
	});

	it.each(["agent_end", "agent_settled"] as const)(
		"pending command after %s cannot resurrect old activity on handled/reject",
		async (eventType) => {
			for (const outcome of ["handled", "reject"] as const) {
				useTranscriptStore.setState({ bySession: {} });
				useTranscriptStore.getState().applyEvent("s1", { type: "agent_start" } as never);
				// biome-ignore lint/correctness/useHookAtTopLevel: Hook is invoked as a test harness, not a React render.
				const send = useComposerSend(
					makeOptions({ slashCommand: "session-name-refresh", agentActive: true }),
				);
				const gate = promptGate();
				const pending = send.handleSend();
				await gate.entered.promise;
				expect(entry()?.optimisticActivityToken).toBeUndefined();
				useTranscriptStore.getState().applyEvent("s1", {
					type: eventType,
					...(eventType === "agent_end" ? { willRetry: false, messages: [] } : {}),
				} as never);
				if (outcome === "handled") gate.result.resolve({ disposition: "handled" });
				else gate.result.reject(new Error("late failure"));
				await pending;
				expect(entry()?.agentActive).toBe(false);
			}
		},
	);

	it("willRetry=true takes ownership before a late handled acknowledgement", async () => {
		const send = useComposerSend(makeOptions());
		const gate = promptGate();
		const pending = send.handleSend();
		await gate.entered.promise;
		useTranscriptStore
			.getState()
			.applyEvent("s1", { type: "agent_end", willRetry: true, messages: [] } as never);
		gate.result.resolve({ disposition: "handled" });
		await pending;
		expect(entry()?.agentActive).toBe(true);
	});

	it("reset and loadHistory invalidate prior token; new activity is not settled by old acknowledgement", async () => {
		for (const rebuild of ["reset", "history"] as const) {
			useTranscriptStore.setState({ bySession: {} });
			const gate = promptGate();
			// biome-ignore lint/correctness/useHookAtTopLevel: Hook is invoked as a test harness, not a React render.
			const pending = useComposerSend(makeOptions()).handleSend();
			await gate.entered.promise;
			const oldToken = entry()?.optimisticActivityToken;
			expect(oldToken).toBeTruthy();
			if (rebuild === "reset") useTranscriptStore.getState().resetSession("s1");
			else useTranscriptStore.getState().loadHistory("s1", []);
			const newToken = useTranscriptStore.getState().beginPromptActivity("s1");
			expect(newToken).toBeTruthy();
			expect(newToken).not.toBe(oldToken);
			gate.result.resolve({ disposition: "handled" });
			await pending;
			expect(entry()?.optimisticActivityToken).toBe(newToken);
			expect(entry()?.agentActive).toBe(true);
		}
	});

	it("settling a send for session A cannot modify session B", async () => {
		const gate = promptGate();
		const pending = useComposerSend(makeOptions()).handleSend();
		await gate.entered.promise;
		mocks.activeSessionId = "s2";
		useTranscriptStore.getState().beginPromptActivity("s2");
		gate.result.resolve({ disposition: "handled" });
		await pending;
		expectNotWorking("s1");
		expect(entry("s2")?.agentActive).toBe(true);
		expect(entry("s2")?.optimisticActivityToken).toBeTruthy();
	});

	it.each([undefined, { disposition: "unknown" }, { disposition: "nonsense" }])(
		"unknown acknowledgement conservatively keeps activity",
		async (ack) => {
			mocks.prompt.mockResolvedValue(ack);
			await useComposerSend(makeOptions()).handleSend();
			expect(entry()?.agentActive).toBe(true);
			expect(entry()?.optimisticActivityToken).toBeUndefined();
		},
	);

	it("reject restores text, images, attachments, quotes and clears sending", async () => {
		const options = makeOptions({
			text: "body",
			images: [{ data: "AAAA", mimeType: "image/png", name: "image.png" }],
			attachments: ["src/a.ts"],
			quotes: ["quoted"],
			slashCommand: null,
		});
		mocks.prompt.mockRejectedValue(new Error("offline"));
		await useComposerSend(options).handleSend();
		expect(options.setText).toHaveBeenCalledWith("body");
		expect(options.setImages).toHaveBeenCalledWith([{ data: "AAAA", mimeType: "image/png" }]);
		expect(options.setAttachments).toHaveBeenCalledWith(["src/a.ts"]);
		expect(options.setQuotes).toHaveBeenCalledWith(["quoted"]);
		expectNotWorking();
		expect(mocks.states[0]).toEqual([false, true, false]);
	});

	it("built-in commands do not call prompt or claim activity; synchronous guard rejects duplicate send", async () => {
		const builtIn = useComposerSend(makeOptions({ slashCommand: "name", text: "Example" }));
		await builtIn.handleSend();
		expect(mocks.setSessionName).toHaveBeenCalledWith({ sessionId: "s1", name: "Example" });
		expect(mocks.states[1]).toEqual([null]);
		expect(mocks.prompt).not.toHaveBeenCalled();
		expect(entry()?.optimisticActivityToken).toBeUndefined();
		expect(entry()?.agentActive).not.toBe(true);

		const gate = promptGate();
		const send = useComposerSend(makeOptions({ text: "one", slashCommand: null }));
		const first = send.handleSend();
		const duplicate = send.handleSend();
		await gate.entered.promise;
		await duplicate;
		expect(mocks.prompt).toHaveBeenCalledTimes(1);
		gate.result.resolve({ disposition: "started" });
		await first;
	});
});
