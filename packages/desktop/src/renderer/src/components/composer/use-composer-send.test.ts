import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	prompt: vi.fn(),
	setSessionName: vi.fn(),
	toast: vi.fn(),
	states: [] as unknown[][],
	activeSessionId: "s1",
	// 托管控制通道：control=false 时 getPi 不暴露这些方法（走 legacy prompt 路径）
	control: false,
	submitMessage: vi.fn(),
	getMessageControl: vi.fn(),
	stopMessageControl: vi.fn(),
	changePendingMessage: vi.fn(),
	recoverPendingMessage: vi.fn(),
	clearQueue: vi.fn(),
	abort: vi.fn(),
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
	getPi: () => ({
		prompt: mocks.prompt,
		setSessionName: mocks.setSessionName,
		clearQueue: mocks.clearQueue,
		abort: mocks.abort,
		...(mocks.control
			? {
					submitMessage: mocks.submitMessage,
					getMessageControl: mocks.getMessageControl,
					stopMessageControl: mocks.stopMessageControl,
					changePendingMessage: mocks.changePendingMessage,
					recoverPendingMessage: mocks.recoverPendingMessage,
				}
			: {}),
	}),
}));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../stores/sessions", () => ({
	useSessionsStore: { getState: () => ({ activeSessionId: mocks.activeSessionId }) },
}));
vi.mock("../../stores/settings", () => ({ useSettingsStore: { getState: () => ({ openWith: vi.fn() }) } }));
vi.mock("../../stores/toasts", () => ({ pushToast: mocks.toast }));

import { buildChatRows, isAgentWorking, type PromptAck } from "@percho/shared";
import { useDraftStore } from "../../stores/drafts";
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
		useDraftStore.setState({ bySession: {} });
		mocks.control = false;
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

	it("reject retains text, images, attachments and quotes without restoring over input", async () => {
		const options = makeOptions({
			text: "body",
			images: [{ data: "AAAA", mimeType: "image/png", name: "image.png" }],
			attachments: ["src/a.ts"],
			quotes: ["quoted"],
			slashCommand: null,
		});
		mocks.prompt.mockRejectedValue(new Error("offline"));
		await useComposerSend(options).handleSend();
		expect(options.setText).not.toHaveBeenCalled();
		expect(options.setImages).not.toHaveBeenCalled();
		expect(options.setAttachments).not.toHaveBeenCalled();
		expect(options.setQuotes).not.toHaveBeenCalled();
		expectNotWorking();
		expect(mocks.states[0]).toEqual([false, true, false]);
	});

	it("本地 slash 失败保留草稿，未知 slash 透传时不预清", async () => {
		useDraftStore.getState().updateDraft("s1", () => ({
			text: "New name",
			images: [],
			slashCommand: "name",
			attachments: [],
			quotes: [],
		}));
		mocks.setSessionName.mockRejectedValueOnce(new Error("denied"));
		await useComposerSend(makeOptions({ slashCommand: "name", text: "New name" })).handleSend();
		expect(useDraftStore.getState().bySession.s1?.text).toBe("New name");

		const unknown = { text: "topic", images: [], slashCommand: "skill:mindmap", attachments: [], quotes: [] };
		useDraftStore.getState().updateDraft("s1", () => unknown);
		const gate = promptGate<{ disposition: "started" }>();
		const pending = useComposerSend(
			makeOptions({ text: "topic", slashCommand: "skill:mindmap" }),
		).handleSend();
		await gate.entered.promise;
		expect(useDraftStore.getState().bySession.s1).toEqual(unknown);
		gate.result.resolve({ disposition: "started" });
		await pending;
	});

	it("built-in commands clear matching draft only after success; synchronous guard rejects duplicate send", async () => {
		useDraftStore.getState().updateDraft("s1", () => ({
			text: "Example",
			images: [],
			slashCommand: "name",
			attachments: [],
			quotes: [],
		}));
		const builtIn = useComposerSend(makeOptions({ slashCommand: "name", text: "Example" }));
		await builtIn.handleSend();
		expect(mocks.setSessionName).toHaveBeenCalledWith({ sessionId: "s1", name: "Example" });
		expect(mocks.states[1]).toEqual([null]);
		expect(mocks.prompt).not.toHaveBeenCalled();
		expect(useDraftStore.getState().bySession.s1).toBeUndefined();
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

describe("useComposerSend 消息控制路径（submitMessage 三态）", () => {
	const snap = (over: Record<string, unknown> = {}) => ({
		runtimeId: "rt1",
		revision: 7,
		phase: "idle" as const,
		autoDispatchPaused: false,
		items: [],
		...over,
	});
	const ok = <T>(value: T) => ({ ok: true as const, value });
	const fail = (code: string, message = code) => ({
		ok: false as const,
		error: { code, message },
	});

	beforeEach(() => {
		useTranscriptStore.setState({ bySession: {} });
		useDraftStore.setState({ bySession: {} });
		mocks.states.length = 0;
		mocks.control = true;
		mocks.prompt.mockReset();
		mocks.toast.mockReset();
		mocks.submitMessage
			.mockReset()
			.mockResolvedValue(ok({ requestId: "x", messageId: "x", disposition: "started" }));
		mocks.getMessageControl.mockReset().mockResolvedValue(ok(snap()));
		mocks.stopMessageControl
			.mockReset()
			.mockResolvedValue(ok({ operationId: "op1", snapshot: snap({ phase: "interrupting" }) }));
		mocks.changePendingMessage.mockReset().mockResolvedValue(ok({ snapshot: snap({ revision: 8 }) }));
		mocks.recoverPendingMessage.mockReset();
		mocks.clearQueue.mockReset().mockResolvedValue({ followUp: [] });
		mocks.abort.mockReset().mockResolvedValue(undefined);
	});

	it("idle 发送走 submitMessage（requestId=messageId，payload 含 draft 恢复信息），不再走旧 prompt", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		const send = useComposerSend(
			makeOptions({
				text: "正文",
				slashCommand: null,
				attachments: ["src/a.ts"],
				quotes: ["引用"],
				images: [{ data: "AAAA", mimeType: "image/png", name: "p.png" }],
			}),
		);
		await send.handleSend();
		expect(mocks.prompt).not.toHaveBeenCalled();
		expect(mocks.submitMessage).toHaveBeenCalledTimes(1);
		const req = mocks.submitMessage.mock.calls[0]![0];
		expect(req.sessionId).toBe("s1");
		expect(req.runtimeId).toBe("rt1");
		expect(req.mode).toBe("queue");
		expect(req.requestId).toBeTruthy();
		// payload.text 是完整拼接；draft 保留未拼接原件用于恢复
		expect(req.payload.draft).toMatchObject({
			text: "正文",
			attachments: ["src/a.ts"],
			quotes: ["引用"],
			slashCommand: null,
			imageNames: ["p.png"],
		});
		expect(req.payload.images).toEqual([{ data: "AAAA", mimeType: "image/png" }]);
		// 普通发送的乐观气泡以 requestId 精确认领。
		const pending = entry()?.messages[0];
		expect(pending).toMatchObject({ kind: "user", pending: true, controlMessageId: req.requestId });
	});

	it.each(["before", "after"] as const)(
		"recovered idle queue resend is claimed by original message id when message_start arrives %s submit ACK",
		async (order) => {
			useTranscriptStore.getState().setControlSnapshot("s1", snap());
			useDraftStore.getState().updateDraft("s1", () => ({
				text: "编辑后重发",
				images: [],
				slashCommand: null,
				attachments: [],
				quotes: [],
				recovery: { messageId: "original-message", expectedRevision: 6 },
			}));
			const gate = deferred<ReturnType<typeof ok>>();
			mocks.submitMessage.mockReturnValue(gate.promise);
			const pendingSend = useComposerSend(
				makeOptions({ text: "编辑后重发", slashCommand: null }),
			).handleSend();
			await vi.waitFor(() => expect(mocks.submitMessage).toHaveBeenCalledTimes(1));
			const requestId = mocks.submitMessage.mock.calls[0]![0].requestId;
			expect(requestId).not.toBe("original-message");
			expect(entry()?.messages[0]).toMatchObject({
				kind: "user",
				pending: true,
				controlMessageId: "original-message",
			});
			const applyStart = () => {
				useTranscriptStore.getState().applyEvent("s1", {
					type: "message_start",
					controlMessageId: "original-message",
					message: { role: "user", content: [{ type: "text", text: "编辑后重发" }] },
				} as never);
			};
			if (order === "before") {
				applyStart();
				gate.resolve(ok({ requestId, messageId: "original-message", disposition: "started" }));
				await pendingSend;
			} else {
				gate.resolve(ok({ requestId, messageId: "original-message", disposition: "started" }));
				await pendingSend;
				applyStart();
			}
			const userMessages = entry()?.messages.filter((message) => message.kind === "user") ?? [];
			expect(userMessages).toHaveLength(1);
			expect(userMessages[0]).toMatchObject({ kind: "user", text: "编辑后重发" });
			expect(userMessages[0]?.pending).toBeFalsy();
			expect(userMessages.some((message) => message.pending)).toBe(false);
		},
	);

	it("IPC pending 时保留整份草稿快照，成功回执后才清理", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		const original = {
			text: "正文",
			images: [{ data: "AAAA", mimeType: "image/png", name: "p.png" }],
			slashCommand: null,
			attachments: ["src/a.ts"],
			quotes: ["引用"],
		};
		useDraftStore.getState().updateDraft("s1", () => original);
		const gate = deferred<ReturnType<typeof ok>>();
		mocks.submitMessage.mockReturnValue(gate.promise);
		const pending = useComposerSend(makeOptions(original)).handleSend();
		await vi.waitFor(() => expect(mocks.submitMessage).toHaveBeenCalledTimes(1));
		expect(useDraftStore.getState().bySession.s1).toEqual(original);
		gate.resolve(ok({ requestId: "r", messageId: "r", disposition: "queued" }));
		await pending;
		expect(useDraftStore.getState().bySession.s1).toBeUndefined();
	});

	it("await 中的新编辑、切换会话及新 recovery 不被迟到成功回执清除", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		useDraftStore.getState().updateDraft("s1", () => ({
			text: "original",
			images: [],
			slashCommand: null,
			attachments: ["a.ts"],
			quotes: [],
			recovery: { messageId: "old", expectedRevision: 4 },
		}));
		const gate = deferred<ReturnType<typeof ok>>();
		mocks.submitMessage.mockReturnValue(gate.promise);
		const pending = useComposerSend(
			makeOptions({ text: "original", slashCommand: null, attachments: ["a.ts"] }),
		).handleSend();
		await vi.waitFor(() => expect(mocks.submitMessage).toHaveBeenCalledTimes(1));
		mocks.activeSessionId = "s2";
		useDraftStore.getState().updateDraft("s1", () => ({
			text: "new input",
			images: [],
			slashCommand: "template:new",
			attachments: ["b.ts"],
			quotes: ["new quote"],
			recovery: { messageId: "new", expectedRevision: 9 },
		}));
		gate.resolve(ok({ requestId: "r", messageId: "r", disposition: "queued" }));
		await pending;
		expect(useDraftStore.getState().bySession.s1).toMatchObject({
			text: "new input",
			slashCommand: "template:new",
			attachments: ["b.ts"],
			quotes: ["new quote"],
			recovery: { messageId: "new", expectedRevision: 9 },
		});
	});

	it("submitMessage 拒绝时移除未认领的 optimistic 用户消息", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		mocks.submitMessage.mockResolvedValue(fail("queue_full"));
		await useComposerSend(makeOptions({ text: "keep me", slashCommand: null })).handleSend();
		expect(entry()?.messages.filter((message) => message.kind === "user" && message.pending)).toHaveLength(0);
	});

	it("submitMessage 拒绝保留原草稿快照", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		useDraftStore.getState().updateDraft("s1", () => ({
			text: "keep me",
			images: [],
			slashCommand: null,
			attachments: ["a.ts"],
			quotes: ["q"],
		}));
		mocks.submitMessage.mockResolvedValue(fail("queue_full"));
		await useComposerSend(
			makeOptions({ text: "keep me", slashCommand: null, attachments: ["a.ts"], quotes: ["q"] }),
		).handleSend();
		expect(useDraftStore.getState().bySession.s1).toMatchObject({
			text: "keep me",
			attachments: ["a.ts"],
			quotes: ["q"],
		});
	});

	it("新 API 快照失败时不调用 prompt，保留草稿并提示", async () => {
		mocks.getMessageControl.mockResolvedValue(fail("unavailable"));
		const options = makeOptions({ text: "keep me", slashCommand: null });
		await useComposerSend(options).handleSend("interrupt");
		expect(mocks.prompt).not.toHaveBeenCalled();
		expect(mocks.submitMessage).not.toHaveBeenCalled();
		expect(options.setText).not.toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledWith("warning", "composer.controlActionFailed");
		expect(mocks.states[0]).toEqual([false, true, false]);
	});

	it("无快照时先 getMessageControl 取得 runtimeId 再提交（sendGuard 覆盖，无双发）", async () => {
		const send = useComposerSend(makeOptions({ text: "hi", slashCommand: null }));
		await send.handleSend();
		expect(mocks.getMessageControl).toHaveBeenCalledWith({ sessionId: "s1" });
		expect(mocks.submitMessage).toHaveBeenCalledTimes(1);
		expect(mocks.submitMessage.mock.calls[0]![0].runtimeId).toBe("rt1");
		// 拉取的快照已钉进 store（后续事件按 runtime 过滤）
		expect(entry()?.controlRuntimeId).toBe("rt1");
	});

	it("运行中 queue/steer/interrupt 透传模式且不插乐观气泡", async () => {
		useTranscriptStore.getState().applyEvent("s1", { type: "agent_start" } as never);
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ phase: "running" }));
		const sendInMode = async (mode: "queue" | "steer" | "interrupt") => {
			mocks.submitMessage.mockClear();
			await useComposerSend(
				makeOptions({ text: `via ${mode}`, slashCommand: null, agentActive: true }),
			).handleSend(mode);
			expect(mocks.submitMessage.mock.calls[0]![0].mode).toBe(mode);
			expect(entry()?.messages.some((m) => m.kind === "user" && m.pending)).toBeFalsy();
		};
		await sendInMode("queue");
		await sendInMode("steer");
		await sendInMode("interrupt");
	});

	it("slash 命令在 steer/interrupt 下被禁用并提示（仅普通路径）", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ phase: "running" }));
		const send = useComposerSend(makeOptions({ text: "", slashCommand: "compact", agentActive: true }));
		await send.handleSend("interrupt");
		expect(mocks.submitMessage).not.toHaveBeenCalled();
		expect(mocks.states[2]?.at(-1)).toEqual({ message: "composer.slashModeBlocked", tone: "warn" });
	});

	it("ack interrupting 立即释放 sending（不等旧 run 收束）", async () => {
		useTranscriptStore.getState().applyEvent("s1", { type: "agent_start" } as never);
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ phase: "running" }));
		mocks.submitMessage.mockResolvedValue(
			ok({ requestId: "r", messageId: "r", disposition: "interrupting", operationId: "op" }),
		);
		const send = useComposerSend(makeOptions({ text: "urgent", slashCommand: null, agentActive: true }));
		await send.handleSend("interrupt");
		expect(mocks.states[0]).toEqual([false, true, false]);
		// 不伪造 idle：真实事件没到，agentActive 保持
		expect(entry()?.agentActive).toBe(true);
	});

	it("同图片数但图片内容变化时生成新 requestId", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		const send = useComposerSend(
			makeOptions({ text: "same", slashCommand: null, images: [{ data: "AAAA", mimeType: "image/png" }] }),
		);
		mocks.submitMessage.mockRejectedValueOnce(new Error("network"));
		await send.handleSend();
		const firstId = mocks.submitMessage.mock.calls[0]![0].requestId;
		const edited = useComposerSend(
			makeOptions({ text: "same", slashCommand: null, images: [{ data: "BBBB", mimeType: "image/png" }] }),
		);
		await edited.handleSend();
		expect(mocks.submitMessage.mock.calls[1]![0].requestId).not.toBe(firstId);
	});

	it("传输失败保留草稿；同内容重试复用同一 requestId，改内容换新 id", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		mocks.submitMessage.mockRejectedValueOnce(new Error("network"));
		const options = makeOptions({ text: "again", slashCommand: null });
		useDraftStore.getState().updateDraft("s1", (draft) => ({ ...draft, text: "again" }));
		const send = useComposerSend(options);
		await send.handleSend();
		expect(options.setText).not.toHaveBeenCalled();
		expect(mocks.states[0]).toEqual([false, true, false]);
		// 重试同内容：同 requestId（幂等）
		await send.handleSend();
		const [first, second] = mocks.submitMessage.mock.calls.map(
			(c) => (c[0] as { requestId: string }).requestId,
		);
		expect(second).toBe(first);
		// 改内容 → 新 requestId
		const edited = useComposerSend(makeOptions({ text: "changed", slashCommand: null }));
		await edited.handleSend();
		expect(mocks.submitMessage.mock.calls[2]![0].requestId).not.toBe(first);
	});

	it("携带 recovery 元数据提交；受理成功后清除对应草稿及 recovery", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		useDraftStore.setState({
			bySession: {
				s1: {
					text: "编辑后重发",
					images: [],
					slashCommand: null,
					attachments: [],
					quotes: [],
					recovery: { messageId: "m-9", expectedRevision: 6 },
				},
			},
		});
		const send = useComposerSend(makeOptions({ text: "编辑后重发", slashCommand: null }));
		await send.handleSend();
		expect(mocks.submitMessage.mock.calls[0]![0].recovery).toEqual({
			messageId: "m-9",
			expectedRevision: 6,
		});
		expect(useDraftStore.getState().bySession.s1).toBeUndefined();
	});

	it("匹配 payload 但 recovery 已换关联时不清新草稿或 recovery", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		useDraftStore.getState().updateDraft("s1", () => ({
			text: "retry",
			images: [],
			slashCommand: null,
			attachments: [],
			quotes: [],
			recovery: { messageId: "old", expectedRevision: 4 },
		}));
		const gate = deferred<ReturnType<typeof ok>>();
		mocks.submitMessage.mockReturnValue(gate.promise);
		const pending = useComposerSend(makeOptions({ text: "retry", slashCommand: null })).handleSend();
		await vi.waitFor(() => expect(mocks.submitMessage).toHaveBeenCalledTimes(1));
		useDraftStore.getState().updateDraft("s1", (draft) => ({
			...draft,
			recovery: { messageId: "new", expectedRevision: 9 },
		}));
		gate.resolve(ok({ requestId: "r", messageId: "r", disposition: "queued" }));
		await pending;
		expect(useDraftStore.getState().bySession.s1).toMatchObject({
			text: "retry",
			recovery: { messageId: "new", expectedRevision: 9 },
		});
	});

	it("stale_revision 拒绝：刷新快照 + 保留原草稿，不暗自重发", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		mocks.submitMessage.mockResolvedValue(fail("stale_revision"));
		mocks.getMessageControl.mockResolvedValue(ok(snap({ revision: 9 })));
		const options = makeOptions({ text: "recover me", slashCommand: null });
		useDraftStore.getState().updateDraft("s1", (draft) => ({ ...draft, text: "recover me" }));
		await useComposerSend(options).handleSend();
		expect(mocks.submitMessage).toHaveBeenCalledTimes(1);
		expect(mocks.getMessageControl).toHaveBeenCalledWith({ sessionId: "s1" });
		expect(entry()?.control?.revision).toBe(9);
		expect(options.setText).not.toHaveBeenCalled();
	});

	it("handleStop 走 stopMessageControl（独立停止，不动 clearQueue/abort）", async () => {
		useTranscriptStore.getState().applyEvent("s1", { type: "agent_start" } as never);
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ phase: "running" }));
		const send = useComposerSend(makeOptions({ agentActive: true }));
		await send.handleStop();
		expect(mocks.stopMessageControl).toHaveBeenCalledTimes(1);
		const identity = mocks.stopMessageControl.mock.calls[0]![0];
		expect(identity).toMatchObject({ sessionId: "s1", runtimeId: "rt1" });
		expect(identity.requestId).toBeTruthy();
		expect(mocks.clearQueue).not.toHaveBeenCalled();
		expect(mocks.abort).not.toHaveBeenCalled();
	});

	it("控制 stop 失败时提示且不清队列或 abort", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ phase: "running" }));
		mocks.stopMessageControl.mockResolvedValue(fail("unavailable"));
		await useComposerSend(makeOptions({ agentActive: true })).handleStop();
		expect(mocks.clearQueue).not.toHaveBeenCalled();
		expect(mocks.abort).not.toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledWith("warning", "composer.controlActionFailed");
	});

	it("handleStop 无控制快照时先获取快照再走控制 stop", async () => {
		useTranscriptStore.getState().applyEvent("s1", { type: "agent_start" } as never);
		mocks.clearQueue.mockResolvedValue({ followUp: ["queued text"] });
		const options = makeOptions({ agentActive: true });
		await useComposerSend(options).handleStop();
		expect(mocks.getMessageControl).toHaveBeenCalledWith({ sessionId: "s1" });
		expect(mocks.stopMessageControl).toHaveBeenCalledTimes(1);
		expect(mocks.clearQueue).not.toHaveBeenCalled();
		expect(mocks.abort).not.toHaveBeenCalled();
	});

	it("changePending 携带快照 revision；受理后替换快照", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ phase: "running" }));
		const send = useComposerSend(makeOptions({ agentActive: true }));
		await send.changePending({ messageId: "m1", preview: "x" }, "steer");
		expect(mocks.changePendingMessage).toHaveBeenCalledWith({
			sessionId: "s1",
			runtimeId: "rt1",
			requestId: expect.any(String),
			messageId: "m1",
			expectedRevision: 7,
			action: "steer",
		});
		expect(entry()?.control?.revision).toBe(8);
	});

	it("recoverPending：空草稿取回完整载荷并写入草稿（含 recovery 元数据）", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ phase: "idle" }));
		mocks.recoverPendingMessage.mockResolvedValue(
			ok({
				messageId: "m1",
				snapshot: snap({ revision: 8 }),
				payload: {
					text: "最终文本",
					images: [{ data: "AAAA", mimeType: "image/png" }],
					draft: {
						text: "原始文本",
						attachments: ["a.ts"],
						quotes: ["q"],
						slashCommand: null,
						imageNames: ["p.png"],
					},
				},
			}),
		);
		const send = useComposerSend(makeOptions({}));
		const okResult = await send.recoverPending({ messageId: "m1", preview: "x" });
		expect(okResult).toBe(true);
		expect(mocks.recoverPendingMessage).toHaveBeenCalledWith({
			sessionId: "s1",
			runtimeId: "rt1",
			requestId: expect.any(String),
			messageId: "m1",
			expectedRevision: 7,
		});
		const draft = useDraftStore.getState().bySession.s1;
		expect(draft).toMatchObject({
			text: "原始文本",
			attachments: ["a.ts"],
			quotes: ["q"],
			recovery: { messageId: "m1", expectedRevision: 8 },
		});
		expect(draft?.images).toEqual([{ data: "AAAA", mimeType: "image/png", name: "p.png" }]);
	});

	it("旧 host 的 steer/interrupt 拒绝，不假装 legacy prompt 成功", async () => {
		mocks.control = false;
		const options = makeOptions({ text: "keep me", slashCommand: null, agentActive: true });
		await useComposerSend(options).handleSend("steer");
		expect(mocks.prompt).not.toHaveBeenCalled();
		expect(options.setText).not.toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledWith("warning", "composer.controlActionFailed");
	});

	it("recoverPending 等待期间出现的新草稿不会被 SDK 返回值覆盖", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		const gate = deferred<ReturnType<typeof ok>>();
		mocks.recoverPendingMessage.mockReturnValue(gate.promise);
		const pending = useComposerSend(makeOptions({})).recoverPending({ messageId: "m1" });
		useDraftStore.getState().updateDraft("s1", () => ({
			text: "typed while waiting",
			images: [],
			slashCommand: null,
			attachments: [],
			quotes: [],
		}));
		gate.resolve(
			ok({
				messageId: "m1",
				snapshot: snap({ revision: 8 }),
				payload: { text: "recovered payload", images: [], draft: { text: "recovered payload" } },
			}),
		);
		expect(await pending).toBe(false);
		expect(useDraftStore.getState().bySession.s1?.text).toBe("typed while waiting");
		expect(mocks.toast).toHaveBeenCalledWith("warning", "composer.recoverDraftConflict");
	});

	it("recoverPending：已有未保存草稿时拒绝覆盖（toast 提示先处理草稿）", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		useDraftStore.setState({
			bySession: {
				s1: { text: "未发送草稿", images: [], slashCommand: null, attachments: [], quotes: [] },
			},
		});
		const send = useComposerSend(makeOptions({ text: "未发送草稿" }));
		const okResult = await send.recoverPending({ messageId: "m1", preview: "x" });
		expect(okResult).toBe(false);
		expect(mocks.recoverPendingMessage).not.toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledWith("warning", "composer.recoverDraftConflict");
	});
});
