import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	prompt: vi.fn(),
	setSessionName: vi.fn(),
	toast: vi.fn(),
	states: [] as unknown[][],
	activeSessionId: "s1",
	// 托管控制通道：control=false 时 getPi 不暴露这些方法（走 legacy prompt 路径）
	control: false,
	// 控制 API 不完整（模拟旧 host 只桥了部分方法）：列出的方法不暴露
	controlOmit: [] as string[],
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
			? Object.fromEntries(
					Object.entries({
						submitMessage: mocks.submitMessage,
						getMessageControl: mocks.getMessageControl,
						stopMessageControl: mocks.stopMessageControl,
						changePendingMessage: mocks.changePendingMessage,
						recoverPendingMessage: mocks.recoverPendingMessage,
					}).filter(([key]) => !mocks.controlOmit.includes(key)),
				)
			: {}),
	}),
}));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../stores/sessions", () => ({
	useSessionsStore: { getState: () => ({ activeSessionId: mocks.activeSessionId }) },
}));
vi.mock("../../stores/settings", () => ({ useSettingsStore: { getState: () => ({ openWith: vi.fn() }) } }));
vi.mock("../../stores/toasts", () => ({ pushToast: mocks.toast }));

import { buildChatRows, controlSendErrorCardId, isAgentWorking, type PromptAck } from "@percho/shared";
import { type DraftEntry, useDraftStore } from "../../stores/drafts";
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
		mocks.controlOmit.length = 0;
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
		mocks.controlOmit.length = 0;
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
		"取回后的普通草稿按本次 requestId 认领：message_start %s submit ACK 都只剩一条用户消息",
		async (order) => {
			useTranscriptStore.getState().setControlSnapshot("s1", snap());
			useDraftStore.getState().updateDraft("s1", () => ({
				text: "编辑后重发",
				images: [],
				slashCommand: null,
				attachments: [],
				quotes: [],
			}));
			const gate = deferred<ReturnType<typeof ok>>();
			mocks.submitMessage.mockReturnValue(gate.promise);
			const pendingSend = useComposerSend(
				makeOptions({ text: "编辑后重发", slashCommand: null }),
			).handleSend();
			await vi.waitFor(() => expect(mocks.submitMessage).toHaveBeenCalledTimes(1));
			const request = mocks.submitMessage.mock.calls[0]![0];
			const requestId = request.requestId;
			// 取回即出队：编辑后的草稿就是新消息，信封里没有旧实体关联
			expect(request.recovery).toBeUndefined();
			expect(entry()?.messages[0]).toMatchObject({
				kind: "user",
				pending: true,
				controlMessageId: requestId,
			});
			const applyStart = () => {
				useTranscriptStore.getState().applyEvent("s1", {
					type: "message_start",
					controlMessageId: requestId,
					message: { role: "user", content: [{ type: "text", text: "编辑后重发" }] },
				} as never);
			};
			if (order === "before") {
				applyStart();
				gate.resolve(ok({ requestId, messageId: requestId, disposition: "started" }));
				await pendingSend;
			} else {
				gate.resolve(ok({ requestId, messageId: requestId, disposition: "started" }));
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

	it("await 中的新编辑与切换会话不被迟到成功回执清除", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		useDraftStore.getState().updateDraft("s1", () => ({
			text: "original",
			images: [],
			slashCommand: null,
			attachments: ["a.ts"],
			quotes: [],
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
		}));
		gate.resolve(ok({ requestId: "r", messageId: "r", disposition: "queued" }));
		await pending;
		expect(useDraftStore.getState().bySession.s1).toMatchObject({
			text: "new input",
			slashCommand: "template:new",
			attachments: ["b.ts"],
			quotes: ["new quote"],
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

	it("出队未确认时点发送：先核对补完出队且本次不发送，确认后再次发送按新消息提交", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ revision: 9 }));
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
		// 真实可达场景：discard 已执行、响应丢失，QueueBar 项已消失，权威快照也确认它不在
		mocks.getMessageControl.mockResolvedValue(ok(snap({ revision: 10, items: [] })));
		mocks.recoverPendingMessage.mockResolvedValue(fail("already_committed"));
		const send = useComposerSend(makeOptions({ text: "编辑后重发", slashCommand: null }));
		await send.handleSend();
		expect(mocks.recoverPendingMessage).toHaveBeenCalledTimes(1);
		// 这一击只核对/补完出队，不直接发送
		expect(mocks.submitMessage).not.toHaveBeenCalled();
		expect(mocks.prompt).not.toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledWith("info", "composer.recoverReadyToSend");
		// 标记已清、内容原样留给用户确认
		expect(useDraftStore.getState().bySession.s1).toMatchObject({ text: "编辑后重发" });
		expect(useDraftStore.getState().bySession.s1?.recovery).toBeUndefined();
		// 第二次发送才是真正提交：普通新消息，新 messageId
		await send.handleSend();
		expect(mocks.submitMessage).toHaveBeenCalledTimes(1);
		const request = mocks.submitMessage.mock.calls[0]?.[0];
		expect(request?.payload.text).toBe("编辑后重发");
		expect(request?.requestId).not.toBe("m-9");
		expect(request?.recovery).toBeUndefined();
	});

	it("空草稿仍可通过发送入口核对并解除残留出队标记", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ items: [] }));
		useDraftStore.getState().updateDraft("s1", (draft) => ({
			...draft,
			recovery: { messageId: "m1", expectedRevision: 8 },
		}));
		mocks.recoverPendingMessage.mockResolvedValueOnce(fail("already_committed"));
		mocks.getMessageControl.mockResolvedValueOnce(ok(snap({ revision: 9, items: [] })));

		await useComposerSend(makeOptions({ text: "", slashCommand: null })).handleSend();

		expect(mocks.recoverPendingMessage).toHaveBeenCalledTimes(1);
		expect(mocks.submitMessage).not.toHaveBeenCalled();
		expect(useDraftStore.getState().bySession.s1).toBeUndefined();
		expect(mocks.toast).toHaveBeenCalledWith("info", "composer.recoverReadyToSend");
	});

	it("出队未确认且核对失败时发送仍被拦下：保留标记与内容、不提交", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ revision: 9 }));
		const draft = {
			text: "编辑后重发",
			images: [],
			slashCommand: null,
			attachments: [],
			quotes: [],
			recovery: { messageId: "m-9", expectedRevision: 6 },
		};
		useDraftStore.setState({ bySession: { s1: draft } });
		// 权威快照里原项还在：出队没生效，不能解除标记
		mocks.getMessageControl.mockResolvedValue(
			ok(snap({ revision: 10, items: [{ messageId: "m-9", state: "recovering" }] })),
		);
		mocks.recoverPendingMessage.mockResolvedValue(fail("already_committed"));
		const send = useComposerSend(makeOptions({ text: "编辑后重发", slashCommand: null }));
		await send.handleSend();
		expect(mocks.submitMessage).not.toHaveBeenCalled();
		expect(mocks.prompt).not.toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledWith("warning", "composer.recoverReleaseRequired");
		expect(useDraftStore.getState().bySession.s1).toEqual(draft);
	});

	it("取回后清空再重写：控制版本已变化也按普通新消息发送", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		mocks.recoverPendingMessage.mockResolvedValue(
			ok({
				messageId: "m1",
				snapshot: snap({ revision: 8 }),
				payload: { text: "original" },
			}),
		);
		expect(
			await useComposerSend(makeOptions({ slashCommand: null })).recoverPending({ messageId: "m1" }),
		).toBe(true);
		// 出队已确认：普通草稿，没有旧实体关联
		expect(useDraftStore.getState().bySession.s1?.recovery).toBeUndefined();
		useDraftStore.getState().updateDraft("s1", (draft) => ({ ...draft, text: "" }));
		useDraftStore.getState().updateDraft("s1", (draft) => ({ ...draft, text: "replacement" }));
		await useComposerSend(makeOptions({ text: "replacement", slashCommand: null })).handleSend();
		expect(mocks.submitMessage).toHaveBeenCalledTimes(1);
		const request = mocks.submitMessage.mock.calls[0]![0];
		expect(request.payload.text).toBe("replacement");
		expect(request.recovery).toBeUndefined();
		expect(request.requestId).not.toBe("m1");
		expect(useDraftStore.getState().bySession.s1).toBeUndefined();
	});

	it("发送等待 ACK 期间继续编辑：保留新内容（新草稿保护）", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		useDraftStore.getState().updateDraft("s1", (draft) => ({ ...draft, text: "sent" }));
		const gate = deferred<ReturnType<typeof ok>>();
		mocks.submitMessage.mockReturnValue(gate.promise);
		const pending = useComposerSend(makeOptions({ text: "sent", slashCommand: null })).handleSend();
		await vi.waitFor(() => expect(mocks.submitMessage).toHaveBeenCalledTimes(1));
		useDraftStore.getState().updateDraft("s1", (draft) => ({ ...draft, text: "new edit" }));
		gate.resolve(ok({ requestId: "r", messageId: "r", disposition: "queued" }));
		await pending;
		expect(useDraftStore.getState().bySession.s1?.text).toBe("new edit");
	});

	it("旧发送 ACK 不清除后来带出队保护标记的同内容草稿", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		useDraftStore.getState().updateDraft("s1", (draft) => ({ ...draft, text: "same" }));
		const gate = deferred<ReturnType<typeof ok>>();
		mocks.submitMessage.mockReturnValue(gate.promise);
		const pending = useComposerSend(makeOptions({ text: "same", slashCommand: null })).handleSend();
		await vi.waitFor(() => expect(mocks.submitMessage).toHaveBeenCalledTimes(1));
		const recovery = { messageId: "another", expectedRevision: 8 };
		useDraftStore.getState().updateDraft("s1", (draft) => ({ ...draft, recovery }));
		gate.resolve(ok({ requestId: "r", messageId: "r", disposition: "queued" }));
		await pending;
		expect(useDraftStore.getState().bySession.s1).toMatchObject({ text: "same", recovery });
	});

	it("取消排队成功释放匹配保护标记但保留编辑内容", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		useDraftStore.getState().updateDraft("s1", (draft) => ({
			...draft,
			text: "keep edit",
			recovery: { messageId: "m1", expectedRevision: 7 },
		}));
		expect(await useComposerSend(makeOptions({})).changePending({ messageId: "m1" }, "discard")).toBe(true);
		expect(useDraftStore.getState().bySession.s1?.text).toBe("keep edit");
		expect(useDraftStore.getState().bySession.s1?.recovery).toBeUndefined();
	});

	it("取消失败保留保护标记；取消其他实体不影响当前草稿", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		const recovery = { messageId: "m1", expectedRevision: 7 };
		useDraftStore.getState().updateDraft("s1", (draft) => ({ ...draft, text: "keep", recovery }));
		mocks.changePendingMessage.mockResolvedValueOnce(fail("busy"));
		const send = useComposerSend(makeOptions({}));
		expect(await send.changePending({ messageId: "m1" }, "discard")).toBe(false);
		expect(useDraftStore.getState().bySession.s1?.recovery).toEqual(recovery);
		expect(await send.changePending({ messageId: "other" }, "discard")).toBe(true);
		expect(useDraftStore.getState().bySession.s1?.recovery).toEqual(recovery);
	});

	it("再次取回同一实体（上次出队未确认）：补完出队但不覆盖已编辑内容", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		useDraftStore.getState().updateDraft("s1", (draft) => ({
			...draft,
			text: "edited",
			recovery: { messageId: "m1", expectedRevision: 7 },
		}));
		mocks.recoverPendingMessage.mockResolvedValue(
			ok({
				messageId: "m1",
				snapshot: snap({ revision: 8 }),
				payload: { text: "old backend payload" },
			}),
		);
		expect(await useComposerSend(makeOptions({})).recoverPending({ messageId: "m1" })).toBe(true);
		expect(mocks.recoverPendingMessage).toHaveBeenCalledTimes(1);
		// 出队用取回快照的 runtime + 版本做 CAS
		expect(mocks.changePendingMessage).toHaveBeenCalledWith({
			sessionId: "s1",
			runtimeId: "rt1",
			requestId: expect.any(String),
			messageId: "m1",
			expectedRevision: 8,
			action: "discard",
		});
		expect(mocks.toast).not.toHaveBeenCalled();
		expect(useDraftStore.getState().bySession.s1).toMatchObject({ text: "edited" });
		expect(useDraftStore.getState().bySession.s1?.recovery).toBeUndefined();
	});

	it("同实体版本过期后明确取回：用最新版本补完出队，仍不覆盖编辑内容", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ revision: 9 }));
		useDraftStore.getState().updateDraft("s1", (draft) => ({
			...draft,
			text: "edited",
			recovery: { messageId: "m1", expectedRevision: 7 },
		}));
		mocks.recoverPendingMessage.mockResolvedValue(
			ok({
				messageId: "m1",
				snapshot: snap({ revision: 10 }),
				payload: { text: "old backend payload" },
			}),
		);
		expect(await useComposerSend(makeOptions({})).recoverPending({ messageId: "m1" })).toBe(true);
		expect(mocks.recoverPendingMessage).toHaveBeenCalledWith({
			sessionId: "s1",
			runtimeId: "rt1",
			requestId: expect.any(String),
			messageId: "m1",
			expectedRevision: 9,
		});
		expect(mocks.changePendingMessage).toHaveBeenCalledWith(
			expect.objectContaining({ messageId: "m1", expectedRevision: 10, action: "discard" }),
		);
		expect(useDraftStore.getState().bySession.s1).toMatchObject({ text: "edited" });
		expect(useDraftStore.getState().bySession.s1?.recovery).toBeUndefined();
	});

	it("取消排队成功后不再阻塞发送：新消息不带旧 recovery 信封", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		useDraftStore.getState().updateDraft("s1", (draft) => ({
			...draft,
			text: "retry",
			recovery: { messageId: "m1", expectedRevision: 7 },
		}));
		const send = useComposerSend(makeOptions({ text: "retry", slashCommand: null }));
		expect(await send.changePending({ messageId: "m1" }, "discard")).toBe(true);
		expect(useDraftStore.getState().bySession.s1?.recovery).toBeUndefined();
		await send.handleSend();
		expect(mocks.submitMessage).toHaveBeenCalledTimes(1);
		expect(mocks.submitMessage.mock.calls[0]![0].recovery).toBeUndefined();
		expect(useDraftStore.getState().bySession.s1).toBeUndefined();
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

	it("recoverPending：空草稿取回完整载荷；出队确认前挂临时保护标记，确认后清除", async () => {
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
		const gate = deferred<ReturnType<typeof ok>>();
		mocks.changePendingMessage.mockReturnValue(gate.promise);
		const pending = useComposerSend(makeOptions({})).recoverPending({ messageId: "m1", preview: "x" });
		await vi.waitFor(() => expect(mocks.changePendingMessage).toHaveBeenCalledTimes(1));
		expect(mocks.recoverPendingMessage).toHaveBeenCalledWith({
			sessionId: "s1",
			runtimeId: "rt1",
			requestId: expect.any(String),
			messageId: "m1",
			expectedRevision: 7,
		});
		// 出队未确认前：内容已回填 + 临时保护标记（阻止这段内容被当成新消息发出）
		const midflight = useDraftStore.getState().bySession.s1;
		expect(midflight).toMatchObject({
			text: "原始文本",
			attachments: ["a.ts"],
			quotes: ["q"],
			recovery: { messageId: "m1", expectedRevision: 8 },
		});
		expect(midflight?.images).toEqual([{ data: "AAAA", mimeType: "image/png", name: "p.png" }]);
		gate.resolve(ok({ snapshot: snap({ revision: 9, items: [] }) }));
		expect(await pending).toBe(true);
		// 出队确认：只清标记，内容原样留给输入框
		const draft = useDraftStore.getState().bySession.s1;
		expect(draft?.recovery).toBeUndefined();
		expect(draft).toMatchObject({ text: "原始文本", attachments: ["a.ts"], quotes: ["q"] });
	});

	it("完整取回成功后立即取消排队：草稿保留完整载荷且不留 recovery 关联", async () => {
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
		mocks.changePendingMessage.mockResolvedValue(ok({ snapshot: snap({ revision: 9, items: [] }) }));

		expect(await useComposerSend(makeOptions({})).recoverPending({ messageId: "m1", preview: "x" })).toBe(
			true,
		);
		// 取回即出队：确认用取回快照的 runtime + revision 做 CAS
		expect(mocks.changePendingMessage).toHaveBeenCalledWith({
			sessionId: "s1",
			runtimeId: "rt1",
			requestId: expect.any(String),
			messageId: "m1",
			expectedRevision: 8,
			action: "discard",
		});
		// 出队成功后才留普通草稿：完整载荷在，recovery 保护标记已清
		const draft = useDraftStore.getState().bySession.s1;
		expect(draft).toMatchObject({ text: "原始文本", attachments: ["a.ts"], quotes: ["q"] });
		expect(draft?.images).toEqual([{ data: "AAAA", mimeType: "image/png", name: "p.png" }]);
		expect(draft?.recovery).toBeUndefined();
		// 出队后的普通草稿发送时不再携带旧 recovery 信封
		await useComposerSend(makeOptions({ text: "原始文本", slashCommand: null })).handleSend();
		expect(mocks.submitMessage).toHaveBeenCalledTimes(1);
		expect(mocks.submitMessage.mock.calls[0]?.[0].recovery).toBeUndefined();
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
		// 冻结项保留（不 discard），下次点击可补完出队
		expect(mocks.changePendingMessage).not.toHaveBeenCalled();
	});

	it("recoverPending：已有未保存草稿时拒绝覆盖，且不发任何请求", async () => {
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

	it.each<[string, Partial<DraftEntry>]>([
		["正文", { text: "draft" }],
		["纯空格正文", { text: "   " }],
		["图片", { images: [{ data: "AAAA", mimeType: "image/png" }] }],
		["附件", { attachments: ["a.ts"] }],
		["引用", { quotes: ["q"] }],
		["斜杠命令", { slashCommand: "compact" }],
	])("输入框已有%s时拒绝取回且不发请求", async (_label, content) => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		const draft: DraftEntry = {
			text: "",
			images: [],
			slashCommand: null,
			attachments: [],
			quotes: [],
			...content,
		};
		useDraftStore.setState({ bySession: { s1: draft } });
		expect(await useComposerSend(makeOptions({})).recoverPending({ messageId: "m1" })).toBe(false);
		expect(mocks.recoverPendingMessage).not.toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledWith("warning", "composer.recoverDraftConflict");
		expect(useDraftStore.getState().bySession.s1).toEqual(draft);
	});

	it("重复/并发取回同一会话只发一次请求", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ phase: "idle" }));
		const gate = deferred<ReturnType<typeof ok>>();
		mocks.recoverPendingMessage.mockReturnValue(gate.promise);
		const first = useComposerSend(makeOptions({})).recoverPending({ messageId: "m1" });
		// 另一个实例（重挂载/分栏）同时点取回：不应再发一次请求
		const second = await useComposerSend(makeOptions({})).recoverPending({ messageId: "m1" });
		expect(second).toBe(false);
		await vi.waitFor(() => expect(mocks.recoverPendingMessage).toHaveBeenCalledTimes(1));
		gate.resolve(ok({ messageId: "m1", snapshot: snap({ revision: 8 }), payload: { text: "x" } }));
		expect(await first).toBe(true);
		expect(mocks.recoverPendingMessage).toHaveBeenCalledTimes(1);
	});

	it("取回在途时拒绝发送：不把内容当新消息插进队列", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ phase: "idle" }));
		const gate = deferred<ReturnType<typeof ok>>();
		mocks.recoverPendingMessage.mockReturnValue(gate.promise);
		const pending = useComposerSend(makeOptions({})).recoverPending({ messageId: "m1" });
		await useComposerSend(makeOptions({ text: "急着发", slashCommand: null })).handleSend();
		expect(mocks.submitMessage).not.toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledWith("warning", "composer.recoverReleaseRequired");
		gate.resolve(ok({ messageId: "m1", snapshot: snap({ revision: 8 }), payload: { text: "x" } }));
		await pending;
	});

	it("取回只写自己的会话草稿，不串到其他会话", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ phase: "idle" }));
		const other = { text: "s2 的草稿", images: [], slashCommand: null, attachments: [], quotes: [] };
		useDraftStore.setState({ bySession: { s2: other } });
		mocks.recoverPendingMessage.mockResolvedValue(
			ok({ messageId: "m1", snapshot: snap({ revision: 8 }), payload: { text: "s1 的内容" } }),
		);
		expect(await useComposerSend(makeOptions({})).recoverPending({ messageId: "m1" })).toBe(true);
		expect(useDraftStore.getState().bySession.s2).toEqual(other);
		expect(useDraftStore.getState().bySession.s1).toMatchObject({ text: "s1 的内容" });
	});

	it("取消排队失败：保草稿与保护标记可重试，不落回旧 recovery 提交", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ phase: "idle" }));
		mocks.recoverPendingMessage.mockResolvedValue(
			ok({ messageId: "m1", snapshot: snap({ revision: 8 }), payload: { text: "取回内容" } }),
		);
		// 回执失败但权威快照里原项还在：不能当成已出队
		mocks.getMessageControl.mockResolvedValue(
			ok(snap({ revision: 9, items: [{ messageId: "m1", state: "recovering" }] })),
		);
		mocks.changePendingMessage.mockResolvedValueOnce(fail("busy"));
		const send = useComposerSend(makeOptions({}));
		expect(await send.recoverPending({ messageId: "m1" })).toBe(false);
		expect(mocks.toast).toHaveBeenCalledWith("warning", "composer.retrieveIncomplete");
		expect(useDraftStore.getState().bySession.s1).toMatchObject({
			text: "取回内容",
			recovery: { messageId: "m1", expectedRevision: 8 },
		});
		// 重试只补完出队：不再用后端回传载荷覆盖用户内容
		mocks.recoverPendingMessage.mockResolvedValue(
			ok({ messageId: "m1", snapshot: snap({ revision: 10 }), payload: { text: "别覆盖我" } }),
		);
		expect(await send.recoverPending({ messageId: "m1" })).toBe(true);
		expect(useDraftStore.getState().bySession.s1).toMatchObject({ text: "取回内容" });
		expect(useDraftStore.getState().bySession.s1?.recovery).toBeUndefined();
		// 出队已确认：再点发送就是普通新消息，不再碰旧实体
		await useComposerSend(makeOptions({ text: "取回内容", slashCommand: null })).handleSend();
		expect(mocks.submitMessage).toHaveBeenCalledTimes(1);
		expect(mocks.submitMessage.mock.calls[0]?.[0].recovery).toBeUndefined();
	});

	it("取消排队回执丢失但权威快照证明原项已不在：解除标记按成功处理", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ phase: "idle" }));
		mocks.recoverPendingMessage.mockResolvedValue(
			ok({ messageId: "m1", snapshot: snap({ revision: 8 }), payload: { text: "取回内容" } }),
		);
		mocks.changePendingMessage.mockRejectedValueOnce(new Error("ipc lost"));
		mocks.getMessageControl.mockResolvedValue(ok(snap({ revision: 9, items: [] })));
		expect(await useComposerSend(makeOptions({})).recoverPending({ messageId: "m1" })).toBe(true);
		expect(mocks.toast).not.toHaveBeenCalled();
		expect(useDraftStore.getState().bySession.s1).toMatchObject({ text: "取回内容" });
		expect(useDraftStore.getState().bySession.s1?.recovery).toBeUndefined();
	});

	it("取消排队回执丢失且快照已换 runtime：不假成功，保留标记等重试", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ phase: "idle" }));
		mocks.recoverPendingMessage.mockResolvedValue(
			ok({ messageId: "m1", snapshot: snap({ revision: 8 }), payload: { text: "取回内容" } }),
		);
		mocks.changePendingMessage.mockRejectedValueOnce(new Error("ipc lost"));
		// 换了 runtime：旧实体去向不可知，不能据此解除保护
		mocks.getMessageControl.mockResolvedValue(ok(snap({ runtimeId: "rt2", items: [] })));
		expect(await useComposerSend(makeOptions({})).recoverPending({ messageId: "m1" })).toBe(false);
		expect(mocks.toast).toHaveBeenCalledWith("warning", "composer.controlActionFailed");
		expect(useDraftStore.getState().bySession.s1).toMatchObject({
			text: "取回内容",
			recovery: { messageId: "m1", expectedRevision: 8 },
		});
	});

	it("出队 stale_revision：保留标记与内容，刷新快照并提示重试", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ phase: "idle" }));
		mocks.recoverPendingMessage.mockResolvedValue(
			ok({ messageId: "m1", snapshot: snap({ revision: 8 }), payload: { text: "取回内容" } }),
		);
		mocks.changePendingMessage.mockResolvedValueOnce(fail("stale_revision"));
		mocks.getMessageControl.mockResolvedValue(
			ok(snap({ revision: 11, items: [{ messageId: "m1", state: "recovering" }] })),
		);
		expect(await useComposerSend(makeOptions({})).recoverPending({ messageId: "m1" })).toBe(false);
		expect(mocks.toast).toHaveBeenCalledWith("warning", "composer.controlStale");
		expect(entry()?.control?.revision).toBe(11);
		expect(useDraftStore.getState().bySession.s1).toMatchObject({
			text: "取回内容",
			recovery: { messageId: "m1", expectedRevision: 8 },
		});
	});

	it("首次取回就 already_committed 且队列已空：不因 items 空而假成功（不回填、不挂标记）", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ revision: 9 }));
		mocks.getMessageControl.mockResolvedValue(ok(snap({ revision: 10, items: [] })));
		mocks.recoverPendingMessage.mockResolvedValue(fail("already_committed"));
		expect(await useComposerSend(makeOptions({})).recoverPending({ messageId: "m1" })).toBe(false);
		expect(mocks.toast).toHaveBeenCalledWith("warning", "composer.recoverReleaseRequired");
		expect(mocks.changePendingMessage).not.toHaveBeenCalled();
		// 从未回填过载荷：不能留下看似取回成功的草稿
		expect(useDraftStore.getState().bySession.s1).toBeUndefined();
	});

	it("首次取回传输异常且队列看起来为空：不当成取回完成", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ revision: 9 }));
		mocks.getMessageControl.mockResolvedValue(ok(snap({ revision: 10, items: [] })));
		mocks.recoverPendingMessage.mockRejectedValue(new Error("ipc lost"));
		expect(await useComposerSend(makeOptions({})).recoverPending({ messageId: "m1" })).toBe(false);
		expect(mocks.toast).toHaveBeenCalledWith("warning", "composer.controlActionFailed");
		expect(mocks.changePendingMessage).not.toHaveBeenCalled();
		expect(useDraftStore.getState().bySession.s1).toBeUndefined();
	});

	it("再次取回同项时标记在等待期间消失：不补标记、不出队、不覆盖", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ revision: 9 }));
		useDraftStore.getState().updateDraft("s1", (draft) => ({
			...draft,
			text: "edited",
			recovery: { messageId: "m1", expectedRevision: 7 },
		}));
		const gate = deferred<ReturnType<typeof ok>>();
		mocks.recoverPendingMessage.mockReturnValue(gate.promise);
		const pending = useComposerSend(makeOptions({})).recoverPending({ messageId: "m1" });
		await vi.waitFor(() => expect(mocks.recoverPendingMessage).toHaveBeenCalledTimes(1));
		// 等待期间标记被别处清掉（另一入口已确认出队）
		useDraftStore.getState().updateDraft("s1", (draft) => ({ ...draft, recovery: undefined }));
		gate.resolve(ok({ messageId: "m1", snapshot: snap({ revision: 10 }), payload: { text: "别覆盖我" } }));
		expect(await pending).toBe(false);
		expect(mocks.toast).toHaveBeenCalledWith("warning", "composer.controlActionFailed");
		expect(mocks.changePendingMessage).not.toHaveBeenCalled();
		expect(useDraftStore.getState().bySession.s1).toMatchObject({ text: "edited" });
		expect(useDraftStore.getState().bySession.s1?.recovery).toBeUndefined();
	});

	it("再次取回同项时标记换成另一实体：不补标记、不出队、不覆盖", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ revision: 9 }));
		useDraftStore.getState().updateDraft("s1", (draft) => ({
			...draft,
			text: "edited",
			recovery: { messageId: "m1", expectedRevision: 7 },
		}));
		const gate = deferred<ReturnType<typeof ok>>();
		mocks.recoverPendingMessage.mockReturnValue(gate.promise);
		const pending = useComposerSend(makeOptions({})).recoverPending({ messageId: "m1" });
		await vi.waitFor(() => expect(mocks.recoverPendingMessage).toHaveBeenCalledTimes(1));
		useDraftStore
			.getState()
			.updateDraft("s1", (draft) => ({ ...draft, recovery: { messageId: "m2", expectedRevision: 11 } }));
		gate.resolve(ok({ messageId: "m1", snapshot: snap({ revision: 10 }), payload: { text: "别覆盖我" } }));
		expect(await pending).toBe(false);
		expect(mocks.toast).toHaveBeenCalledWith("warning", "composer.controlActionFailed");
		expect(mocks.changePendingMessage).not.toHaveBeenCalled();
		expect(useDraftStore.getState().bySession.s1).toMatchObject({
			text: "edited",
			recovery: { messageId: "m2", expectedRevision: 11 },
		});
	});

	it("首次取回等待期间草稿挂上其它实体的标记：按冲突拒绝，不出队不覆盖", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ revision: 9 }));
		const gate = deferred<ReturnType<typeof ok>>();
		mocks.recoverPendingMessage.mockReturnValue(gate.promise);
		const pending = useComposerSend(makeOptions({})).recoverPending({ messageId: "m1" });
		await vi.waitFor(() => expect(mocks.recoverPendingMessage).toHaveBeenCalledTimes(1));
		useDraftStore.getState().updateDraft("s1", () => ({
			text: "",
			images: [],
			slashCommand: null,
			attachments: [],
			quotes: [],
			recovery: { messageId: "m2", expectedRevision: 3 },
		}));
		gate.resolve(ok({ messageId: "m1", snapshot: snap({ revision: 10 }), payload: { text: "取回内容" } }));
		expect(await pending).toBe(false);
		expect(mocks.toast).toHaveBeenCalledWith("warning", "composer.recoverDraftConflict");
		expect(mocks.changePendingMessage).not.toHaveBeenCalled();
		expect(useDraftStore.getState().bySession.s1).toMatchObject({
			text: "",
			recovery: { messageId: "m2", expectedRevision: 3 },
		});
	});

	it("旧标记指向的实体已不在队列：权威确认后才允许新的取回", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ phase: "idle" }));
		useDraftStore.setState({
			bySession: {
				s1: {
					text: "",
					images: [],
					slashCommand: null,
					attachments: [],
					quotes: [],
					recovery: { messageId: "ghost", expectedRevision: 3 },
				},
			},
		});
		mocks.getMessageControl.mockResolvedValue(ok(snap({ revision: 9, items: [] })));
		mocks.recoverPendingMessage.mockResolvedValue(
			ok({ messageId: "m2", snapshot: snap({ revision: 10 }), payload: { text: "新内容" } }),
		);
		expect(await useComposerSend(makeOptions({})).recoverPending({ messageId: "m2" })).toBe(true);
		expect(useDraftStore.getState().bySession.s1).toMatchObject({ text: "新内容" });
		expect(useDraftStore.getState().bySession.s1?.recovery).toBeUndefined();
	});
});

describe("useComposerSend 压缩语义（manual 保守拒绝 / auto 放行三态）", () => {
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
	const draftOf = (text: string) => ({
		text,
		images: [],
		slashCommand: null,
		attachments: [],
		quotes: [],
	});

	beforeEach(() => {
		useTranscriptStore.setState({ bySession: {} });
		useDraftStore.setState({ bySession: {} });
		mocks.states.length = 0;
		mocks.control = true;
		mocks.controlOmit.length = 0;
		mocks.prompt.mockReset();
		mocks.toast.mockReset();
		mocks.submitMessage
			.mockReset()
			.mockResolvedValue(ok({ requestId: "x", messageId: "x", disposition: "queued" }));
		mocks.getMessageControl.mockReset().mockResolvedValue(ok(snap()));
		mocks.stopMessageControl
			.mockReset()
			.mockResolvedValue(ok({ operationId: "op1", snapshot: snap({ phase: "interrupting" }) }));
		mocks.changePendingMessage.mockReset().mockResolvedValue(ok({ snapshot: snap({ revision: 8 }) }));
		mocks.recoverPendingMessage.mockReset();
	});

	it.each([
		["queue", false],
		["steer", false],
		["interrupt", false],
		["queue", true],
		["steer", true],
		["interrupt", true],
	] as const)(
		"manual 压缩中 %s（渲染侧 compacting=%s）一律拒绝，草稿无损",
		async (mode, optionCompacting) => {
			useTranscriptStore
				.getState()
				.setControlSnapshot("s1", snap({ phase: "compacting", compactionKind: "manual" }));
			const draft = draftOf("手动压缩中的草稿");
			useDraftStore.getState().updateDraft("s1", () => draft);
			const options = makeOptions({
				text: "手动压缩中的草稿",
				slashCommand: null,
				compacting: optionCompacting,
			});
			await useComposerSend(options).handleSend(mode);
			expect(mocks.submitMessage).not.toHaveBeenCalled();
			expect(mocks.prompt).not.toHaveBeenCalled();
			expect(options.setText).not.toHaveBeenCalled();
			expect(useDraftStore.getState().bySession.s1).toEqual(draft);
			expect(mocks.states[2]?.at(-1)).toEqual({ message: "composer.compacting", tone: "warn" });
		},
	);

	it.each(["queue", "steer", "interrupt"] as const)(
		"auto 压缩中 %s 允许提交（API 完整 + 快照 compactionKind=auto），受理后清草稿",
		async (mode) => {
			useTranscriptStore.getState().applyEvent("s1", { type: "agent_start" } as never);
			useTranscriptStore
				.getState()
				.setControlSnapshot("s1", snap({ phase: "compacting", compactionKind: "auto" }));
			useDraftStore.getState().updateDraft("s1", () => draftOf("自动压缩中的草稿"));
			const options = makeOptions({
				text: "自动压缩中的草稿",
				slashCommand: null,
				compacting: true,
				agentActive: true,
			});
			await useComposerSend(options).handleSend(mode);
			expect(mocks.submitMessage).toHaveBeenCalledTimes(1);
			const req = mocks.submitMessage.mock.calls[0]![0];
			expect(req.mode).toBe(mode);
			expect(req.payload.text).toBe("自动压缩中的草稿");
			expect(useDraftStore.getState().bySession.s1).toBeUndefined();
			// 放行不等于静默成功：没有 warn 反馈，但仍保留可见压缩指示由 UI 呈现
			expect(mocks.states[2]?.at(-1)).toBeNull();
		},
	);

	it("auto 压缩中被后端拒绝时草稿原样保留（不因放行而预先清理）", async () => {
		useTranscriptStore
			.getState()
			.setControlSnapshot("s1", snap({ phase: "compacting", compactionKind: "auto" }));
		useDraftStore.getState().updateDraft("s1", () => draftOf("被拒的草稿"));
		mocks.submitMessage.mockResolvedValue(fail("queue_full"));
		await useComposerSend(
			makeOptions({ text: "被拒的草稿", slashCommand: null, compacting: true }),
		).handleSend();
		expect(mocks.submitMessage).toHaveBeenCalledTimes(1);
		expect(useDraftStore.getState().bySession.s1).toMatchObject({ text: "被拒的草稿" });
	});

	it.each([
		["compactionKind 缺失", () => {}],
		[
			"控制 API 不完整（缺 stop/recover）",
			() => {
				mocks.controlOmit = ["stopMessageControl", "recoverPendingMessage"];
			},
		],
	] as const)("auto 压缩但 %s：保守拒绝，不猜 auto", async (_label, arrange) => {
		arrange();
		useTranscriptStore.getState().setControlSnapshot("s1", snap({ phase: "compacting" }));
		useDraftStore.getState().updateDraft("s1", () => draftOf("保守拒绝的草稿"));
		const options = makeOptions({ text: "保守拒绝的草稿", slashCommand: null, compacting: true });
		await useComposerSend(options).handleSend();
		expect(mocks.submitMessage).not.toHaveBeenCalled();
		expect(mocks.prompt).not.toHaveBeenCalled();
		expect(options.setText).not.toHaveBeenCalled();
		expect(useDraftStore.getState().bySession.s1).toMatchObject({ text: "保守拒绝的草稿" });
	});

	it("legacy（无控制 API）压缩中仍拒绝，不落到 prompt", async () => {
		mocks.control = false;
		// 真实 legacy 场景：事件态确实在压缩，但宿主没有控制通道可证明是 auto
		useTranscriptStore.getState().applyEvent("s1", {
			type: "compaction_start",
			reason: "auto",
		} as never);
		useDraftStore.getState().updateDraft("s1", () => draftOf("旧宿主的草稿"));
		const options = makeOptions({ text: "旧宿主的草稿", slashCommand: null, compacting: true });
		await useComposerSend(options).handleSend();
		expect(mocks.prompt).not.toHaveBeenCalled();
		expect(options.setText).not.toHaveBeenCalled();
		expect(useDraftStore.getState().bySession.s1).toMatchObject({ text: "旧宿主的草稿" });
	});

	it("渲染闭包还认为压缩中、但发送时快照已 idle：照常发送（不卡过期状态）", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", snap());
		const options = makeOptions({ text: "压缩已结束", slashCommand: null, compacting: true });
		await useComposerSend(options).handleSend();
		expect(mocks.submitMessage).toHaveBeenCalledTimes(1);
	});

	it("渲染闭包未被重渲染（compacting=false）、store 事件态压缩中且无快照：保守拒绝", async () => {
		useTranscriptStore.getState().applyEvent("s1", {
			type: "compaction_start",
			reason: "auto",
		} as never);
		useDraftStore.getState().updateDraft("s1", () => draftOf("事件态压缩中"));
		const options = makeOptions({ text: "事件态压缩中", slashCommand: null, compacting: false });
		await useComposerSend(options).handleSend();
		expect(mocks.submitMessage).not.toHaveBeenCalled();
		expect(useDraftStore.getState().bySession.s1).toMatchObject({ text: "事件态压缩中" });
	});
});

describe("useComposerSend 投递失败反馈（receipt / preflight_failed 共用投影）", () => {
	const controlSnapshot = (over: Record<string, unknown> = {}) => ({
		runtimeId: "rt1",
		revision: 5,
		phase: "running" as const,
		autoDispatchPaused: false,
		items: [],
		...over,
	});
	const heldItem = (messageId: string) => ({
		messageId,
		source: "user" as const,
		mode: "queue" as const,
		state: "held" as const,
		preview: "hi",
		imageCount: 0,
	});
	const ok = <T>(value: T) => ({ ok: true as const, value });
	const failWithSnapshot = (code: string, message: string, snapshot: unknown) => ({
		ok: false as const,
		error: { code, message, snapshot },
	});
	const draftOf = (text: string) => ({
		text,
		images: [],
		slashCommand: null,
		attachments: [],
		quotes: [],
	});
	const cards = () =>
		(useTranscriptStore.getState().bySession.s1?.messages ?? []).filter((m) => m.kind === "error");

	beforeEach(() => {
		useTranscriptStore.setState({ bySession: {} });
		useDraftStore.setState({ bySession: {} });
		mocks.states.length = 0;
		mocks.control = true;
		mocks.controlOmit.length = 0;
		mocks.activeSessionId = "s1";
		mocks.prompt.mockReset();
		mocks.toast.mockReset();
		mocks.submitMessage.mockReset();
		mocks.getMessageControl.mockReset().mockResolvedValue(ok(controlSnapshot()));
		mocks.changePendingMessage.mockReset().mockResolvedValue(ok({ snapshot: controlSnapshot() }));
		mocks.recoverPendingMessage.mockReset();
	});

	it("preflight_failed 响应先到：一张卡（无 retry/compact）、摘精确气泡、不设内联、草稿保留", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", controlSnapshot({ phase: "idle" }) as never);
		const draft = draftOf("会失败的草稿");
		useDraftStore.getState().updateDraft("s1", () => draft);
		let submittedId = "";
		mocks.submitMessage.mockImplementation(async (req: { requestId: string }) => {
			submittedId = req.requestId;
			return failWithSnapshot(
				"preflight_failed",
				"401: Invalid API key",
				controlSnapshot({ revision: 6, items: [heldItem(req.requestId)] }),
			);
		});
		const options = makeOptions({ text: "会失败的草稿", slashCommand: null });
		await useComposerSend(options).handleSend();
		const entry = useTranscriptStore.getState().bySession.s1;
		expect(entry?.messages.filter((m) => m.kind === "user" && m.pending)).toHaveLength(0);
		const found = cards();
		expect(found).toHaveLength(1);
		const card = found[0];
		if (card?.kind !== "error") return;
		expect(card.id).toBe(controlSendErrorCardId("rt1", submittedId, submittedId));
		expect(card.error).toMatchObject({
			source: "llm",
			titleKey: "error.title.llmAuth",
			detail: "401: Invalid API key",
		});
		expect(card.error.actions).toEqual(["openSettings", "copyDetail"]);
		expect(card.error.actions).not.toContain("retry");
		expect(card.error.actions).not.toContain("compact");
		// 已处理：不再走内联错误条
		expect(mocks.states[1]?.at(-1)).toBeNull();
		expect(useDraftStore.getState().bySession.s1).toMatchObject(draft);
		expect(options.setText).not.toHaveBeenCalled();
	});

	it("failed 回执先到、preflight_failed 响应后到（更旧 revision）：只一张卡、无内联重复、保留当前快照不刷新", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", controlSnapshot({ phase: "idle" }) as never);
		let submittedId = "";
		const gate = deferred<ReturnType<typeof failWithSnapshot>>();
		mocks.submitMessage.mockImplementation((req: { requestId: string }) => {
			submittedId = req.requestId;
			return gate.promise;
		});
		const pending = useComposerSend(makeOptions({ text: "顺序", slashCommand: null })).handleSend();
		await vi.waitFor(() => expect(mocks.submitMessage).toHaveBeenCalledTimes(1));
		useTranscriptStore.getState().applyEvent("s1", {
			type: "message_control_update",
			snapshot: controlSnapshot({ revision: 6, items: [heldItem(submittedId)] }),
			receipt: {
				messageId: submittedId,
				requestId: submittedId,
				status: "failed",
				error: "401: Invalid API key",
			},
		} as never);
		expect(cards()).toHaveLength(1);
		gate.resolve(
			failWithSnapshot(
				"preflight_failed",
				"401: Invalid API key",
				controlSnapshot({ revision: 5, items: [heldItem(submittedId)] }),
			),
		);
		await pending;
		expect(cards()).toHaveLength(1);
		expect(mocks.states[1]?.at(-1)).toBeNull();
		// stale 只忽略：当前快照（revision 6）已是权威，不刷新也不回钉旧快照
		expect(mocks.getMessageControl).not.toHaveBeenCalled();
		expect(useTranscriptStore.getState().bySession.s1?.control?.revision).toBe(6);
	});

	it.each([
		{
			label: "刷新在途时同 runtime 事件已推进到 rt1:7",
			advance: () => {
				useTranscriptStore.getState().applyEvent("s1", {
					type: "message_control_update",
					snapshot: controlSnapshot({ revision: 7 }),
				} as never);
			},
			expected: { runtimeId: "rt1", revision: 7 },
		},
		{
			label: "刷新在途时已显式 load 新 runtime rt2:1",
			advance: () => {
				useTranscriptStore
					.getState()
					.setControlSnapshot("s1", controlSnapshot({ runtimeId: "rt2", revision: 1 }) as never);
			},
			expected: { runtimeId: "rt2", revision: 1 },
		},
	])(
		"preflight_failed 迟到响应判 stale：不发起刷新，迟到刷新不得覆盖新权威（$label）",
		async ({ advance, expected }) => {
			useTranscriptStore.getState().setControlSnapshot("s1", controlSnapshot({ phase: "idle" }) as never);
			let submittedId = "";
			const submitGate = deferred<ReturnType<typeof failWithSnapshot>>();
			mocks.submitMessage.mockImplementation((req: { requestId: string }) => {
				submittedId = req.requestId;
				return submitGate.promise;
			});
			const pending = useComposerSend(makeOptions({ text: "迟到", slashCommand: null })).handleSend();
			await vi.waitFor(() => expect(mocks.submitMessage).toHaveBeenCalledTimes(1));
			// 当前权威：failed 回执已把快照推进到 rt1:6 并产卡
			useTranscriptStore.getState().applyEvent("s1", {
				type: "message_control_update",
				snapshot: controlSnapshot({ revision: 6, items: [heldItem(submittedId)] }),
				receipt: {
					messageId: submittedId,
					requestId: submittedId,
					status: "failed",
					error: "401: Invalid API key",
				},
			} as never);
			expect(cards()).toHaveLength(1);
			expect(useTranscriptStore.getState().bySession.s1?.control?.revision).toBe(6);
			// 刷新若被错误发起会挂在这里：迟到的 rt1:6 响应由本用例决定何时放行
			const lateRefresh = deferred<{ ok: true; value: unknown }>();
			mocks.getMessageControl.mockImplementation(() => lateRefresh.promise);
			submitGate.resolve(
				failWithSnapshot(
					"preflight_failed",
					"401: Invalid API key",
					controlSnapshot({ revision: 5, items: [heldItem(submittedId)] }),
				),
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
			// 刷新仍在途：新权威先到（事件推进 / 显式 load 新 runtime）
			advance();
			// 放行迟到的旧 rt1:6 响应
			lateRefresh.resolve(ok(controlSnapshot({ revision: 6 })));
			await pending;
			// 旧响应被静默忽略：没有新增刷新，也没有把旧 rt1:6 钉回去
			expect(mocks.getMessageControl).not.toHaveBeenCalled();
			expect(useTranscriptStore.getState().bySession.s1?.control).toMatchObject(expected);
			expect(cards()).toHaveLength(1);
			if (expected.runtimeId === "rt2") {
				// 新 runtime 未被旧快照解钉：后续 rt2 事件照常接收
				useTranscriptStore.getState().applyEvent("s1", {
					type: "message_control_update",
					snapshot: controlSnapshot({ runtimeId: "rt2", revision: 2 }),
				} as never);
				expect(useTranscriptStore.getState().bySession.s1?.control).toMatchObject({
					runtimeId: "rt2",
					revision: 2,
				});
			}
		},
	);

	it("queued ACK 后释放同步锁并清草稿；随后失败回执产卡且不覆盖等待期间的新编辑", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", controlSnapshot({ phase: "idle" }) as never);
		useDraftStore.getState().updateDraft("s1", () => draftOf("第一句"));
		mocks.submitMessage.mockResolvedValue(ok({ requestId: "r1", messageId: "r1", disposition: "queued" }));
		const options = makeOptions({ text: "第一句", slashCommand: null });
		const send = useComposerSend(options);
		await send.handleSend();
		expect(useDraftStore.getState().bySession.s1).toBeUndefined();
		expect(options.setText).toHaveBeenCalledWith("");
		// ACK 已释放锁：新内容可立即再提交
		await send.handleSend();
		expect(mocks.submitMessage).toHaveBeenCalledTimes(2);
		const [firstId, secondId] = mocks.submitMessage.mock.calls.map(
			(c) => (c[0] as { requestId: string }).requestId,
		);
		expect(secondId).not.toBe(firstId);
		// 等待期间用户新编辑
		useDraftStore.getState().updateDraft("s1", () => draftOf("第二句"));
		useTranscriptStore.getState().applyEvent("s1", {
			type: "message_control_update",
			snapshot: controlSnapshot({ revision: 6, items: [heldItem(firstId as string)] }),
			receipt: {
				messageId: firstId,
				requestId: firstId,
				status: "failed",
				error: "Host paused: threshold",
			},
		} as never);
		expect(useDraftStore.getState().bySession.s1).toMatchObject({ text: "第二句" });
		expect(cards()).toHaveLength(1);
		// 精确删除：只摘第一条请求的气泡，第二条请求的仍等 message_start
		const pendingUsers = useTranscriptStore
			.getState()
			.bySession.s1?.messages.filter((m) => m.kind === "user" && m.pending);
		expect(pendingUsers).toHaveLength(1);
		expect(pendingUsers?.[0]).toMatchObject({ controlMessageId: secondId });
	});

	it("preflight_failed 精确取消文案：不产卡、不内联，仍摘气泡并保草稿", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", controlSnapshot({ phase: "idle" }) as never);
		useDraftStore.getState().updateDraft("s1", () => draftOf("取消的草稿"));
		mocks.submitMessage.mockImplementation(async (req: { requestId: string }) =>
			failWithSnapshot(
				"preflight_failed",
				"Message preparation was cancelled",
				controlSnapshot({ revision: 6, items: [heldItem(req.requestId)] }),
			),
		);
		const options = makeOptions({ text: "取消的草稿", slashCommand: null });
		await useComposerSend(options).handleSend();
		expect(cards()).toHaveLength(0);
		expect(mocks.states[1]?.at(-1)).toBeNull();
		expect(
			useTranscriptStore.getState().bySession.s1?.messages.filter((m) => m.kind === "user" && m.pending),
		).toHaveLength(0);
		expect(useDraftStore.getState().bySession.s1).toMatchObject({ text: "取消的草稿" });
		expect(useTranscriptStore.getState().bySession.s1?.control?.revision).toBe(6);
	});

	it("preflight_failed 无法关联（快照无 held 实体）：无卡，保留现有内联兜底", async () => {
		useTranscriptStore.getState().setControlSnapshot("s1", controlSnapshot({ phase: "idle" }) as never);
		mocks.submitMessage.mockResolvedValue(
			failWithSnapshot("preflight_failed", "No such entity", controlSnapshot({ revision: 6, items: [] })),
		);
		await useComposerSend(makeOptions({ text: "无法关联", slashCommand: null })).handleSend();
		expect(cards()).toHaveLength(0);
		const inline = mocks.states[1]?.at(-1) as { titleKey?: string } | null;
		expect(inline?.titleKey).toBe("error.title.sendFailed");
		expect(useTranscriptStore.getState().bySession.s1?.control?.revision).toBe(6);
	});
});
