import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
/**
 * 核心循环取消闸回归：非合作工具结束后已 abort，不得再进入下一次 provider-stream。
 *
 * 只用真实 `Agent`（无 host 钩子）与真实 `AgentSession`（`abort()` 公开入口）、
 * 真实 `AssistantMessageEventStream`（harness `response()`）和受控工具门闩；
 * 不替换核心循环、队列或仲裁方法，也不联网。
 */
import {
	assistantTurn,
	cleanupSdkTest,
	type Gate,
	gate,
	MODEL,
	response,
	type SdkFixture,
	sdkFixture,
	textTurn,
	withTimeout,
} from "./message-control-sdk-harness";

afterEach(async () => {
	await cleanupSdkTest();
});

function toolTurn(callId: string, name: string): AssistantMessage {
	return assistantTurn([{ type: "toolCall", id: callId, name, arguments: {} }], "toolUse", MODEL);
}

function abortedTurn(): AssistantMessage {
	return assistantTurn([], "aborted", MODEL);
}

interface GatedTool {
	tool: AgentTool;
	log: string[];
	entered: Gate<void>;
	release: Gate<void>;
}

/** 真实非合作工具：忽略 abort，只在门闩释放后返回。 */
function gatedTool(): GatedTool {
	const entered = gate(),
		release = gate();
	const log: string[] = [];
	const tool: AgentTool = {
		name: "core_gate",
		label: "core gate",
		description: "memory-only gated test tool",
		parameters: Type.Object({}),
		execute: async (_id, _args, signal) => {
			log.push("tool:start");
			signal?.addEventListener("abort", () => log.push("tool:abort"), { once: true });
			entered.resolve();
			await release.promise;
			log.push("tool:end");
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
	return { tool, log, entered, release };
}

const texts = (message: { content: unknown }) => JSON.stringify(message.content);

interface CoreHarness extends GatedTool {
	agent: Agent;
	/** 每次 stream 调用时信号是否已 aborted，按调用顺序记录。 */
	streams: string[];
	events: AgentEvent[];
}

/**
 * 真实 `Agent`，不安装 `preparePendingRequest`（unmanaged：SDK 默认路径）。
 * 第一轮给工具调用；之后按信号状态给 aborted 或正常文本，便于看出是否多开了一次 stream。
 */
function coreHarness(): CoreHarness {
	const { tool, log, entered, release } = gatedTool();
	const streams: string[] = [];
	const events: AgentEvent[] = [];
	let calls = 0;
	const agent = new Agent({
		initialState: { model: MODEL, tools: [tool] },
		streamFn: (_model, _context, options) => {
			const aborted = options?.signal?.aborted === true;
			streams.push(aborted ? "aborted" : "live");
			calls++;
			const turn =
				calls === 1 ? toolTurn("core-gate-1", "core_gate") : aborted ? abortedTurn() : textTurn("done");
			return response(turn);
		},
	});
	agent.subscribe((event) => {
		events.push(event);
	});
	return { tool, log, entered, release, agent, streams, events };
}

describe("core abort gate (unmanaged Agent)", () => {
	it("[abort-tool] an uncooperative tool that finishes after abort never opens another provider stream", async () => {
		const h = coreHarness();
		expect(h.agent.preparePendingRequest).toBeUndefined();
		const run = h.agent.prompt("core-abort-old");
		await withTimeout(h.entered.promise, 5_000, "gated tool entered");

		h.agent.abort();
		expect(h.agent.signal?.aborted).toBe(true);
		h.release.resolve();
		await withTimeout(run, 5_000, "aborted run settles");
		await withTimeout(h.agent.waitForIdle(), 5_000, "agent idle after abort");

		// 红线：工具结束后不得再进入 provider-stream，也不得留下空的 aborted assistant 条目。
		expect(h.streams).toEqual(["live"]);
		expect(h.log).toContain("tool:end");
		const messages = h.agent.state.messages;
		expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "toolResult"]);
		expect(
			messages.filter((message) => message.role === "assistant" && message.stopReason === "aborted"),
		).toHaveLength(0);
		expect(texts(messages[messages.length - 1] as AssistantMessage)).toContain("ok");
		expect(h.events.filter((event) => event.type === "agent_end")).toHaveLength(1);
		expect(h.events[h.events.length - 1]?.type).toBe("agent_end");
		expect(h.agent.state.isStreaming).toBe(false);
	});

	it("[abort-steer] a steering message queued during the aborted tool is delivered once and never replayed", async () => {
		const h = coreHarness();
		const run = h.agent.prompt("core-steer-old");
		await withTimeout(h.entered.promise, 5_000, "gated tool entered");

		h.agent.steer({
			role: "user",
			content: [{ type: "text", text: "core-steer-queued" }],
			timestamp: Date.now(),
		});
		expect(h.agent.hasQueuedMessages()).toBe(true);
		h.agent.abort();
		h.release.resolve();
		await withTimeout(run, 5_000, "aborted run settles");
		await withTimeout(h.agent.waitForIdle(), 5_000, "agent idle after abort");

		const occurrences = () =>
			h.agent.state.messages.filter(
				(message) => message.role === "user" && texts(message).includes("core-steer-queued"),
			).length;
		// 待发消息已进入同一 run 的转录（推送而非丢失），也不会在取消后被重复排队。
		expect(occurrences()).toBe(1);
		expect(h.streams).toEqual(["live"]);
		expect(h.agent.hasQueuedMessages()).toBe(false);

		// 下一次真实输入不得重放已交付的那条消息。
		await withTimeout(h.agent.prompt("core-steer-next"), 5_000, "follow-up run settles");
		await withTimeout(h.agent.waitForIdle(), 5_000, "agent idle after follow-up");
		expect(occurrences()).toBe(1);
		expect(h.streams).toHaveLength(2);
	});

	it("[no-abort] the ordinary tool loop still continues into the next provider stream", async () => {
		const h = coreHarness();
		const run = h.agent.prompt("core-normal");
		await withTimeout(h.entered.promise, 5_000, "gated tool entered");
		h.release.resolve();
		await withTimeout(run, 5_000, "normal run settles");
		await withTimeout(h.agent.waitForIdle(), 5_000, "agent idle after normal run");

		expect(h.streams).toEqual(["live", "live"]);
		const messages = h.agent.state.messages;
		expect(messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		const last = messages[messages.length - 1] as AssistantMessage;
		expect(last.stopReason).toBe("stop");
		expect(texts(last)).toContain("done");
		expect(h.events.filter((event) => event.type === "turn_end")).toHaveLength(2);
		expect(h.events.filter((event) => event.type === "agent_end")).toHaveLength(1);
	});
});

interface SdkAbortHarness extends GatedTool {
	fixture: SdkFixture;
	streams: string[];
	events: string[];
}

/**
 * 真实 `AgentSession` 且不启用消息控制（unmanaged）：`preparePendingRequest` 保持未定义，
 * 取消只经公开 `session.abort()` 与真实工具信号。
 */
async function sdkAbortHarness(options: { hostLease?: boolean } = {}): Promise<SdkAbortHarness> {
	const { tool, log, entered, release } = gatedTool();
	const fixture = await sdkFixture({ tools: [tool] });
	// 真实公开 API：装上 host 请求策略后，SDK 自己会给 agent 挂 preparePendingRequest（host 租约）。
	if (options.hostLease)
		fixture.session.setCompactionPolicy({
			enabled: () => false,
			evaluate: () => ({ trigger: false, thresholdTokens: 0 }),
			onResult: () => null,
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
		});
	const streams: string[] = [];
	const events: string[] = [];
	let calls = 0;
	fixture.session.agent.streamFunction = (_model, _context, options) => {
		const aborted = options?.signal?.aborted === true;
		streams.push(aborted ? "aborted" : "live");
		calls++;
		const turn =
			calls === 1 ? toolTurn("sdk-gate-1", "core_gate") : aborted ? abortedTurn() : textTurn("done");
		return response(turn);
	};
	fixture.session.subscribe((event) => {
		events.push(event.type);
	});
	return { tool, log, entered, release, fixture, streams, events };
}

describe("core abort gate (host lease via real setCompactionPolicy)", () => {
	it("[host-tool-stop] host lease keeps its queue semantics and still never opens a second stream", async () => {
		const h = await sdkAbortHarness({ hostLease: true });
		const { session } = h.fixture;
		expect(typeof session.agent.preparePendingRequest).toBe("function");
		const run = session.prompt("host-abort-old");
		await withTimeout(h.entered.promise, 5_000, "gated tool entered");

		// 真实主机侧待发输入：host 分支在租约内排队，取消后按 retain 语义保留。
		session.agent.steer({
			role: "user",
			content: [{ type: "text", text: "host-queued" }],
			timestamp: Date.now(),
		});
		expect(session.agent.hasQueuedMessages()).toBe(true);

		const stopping = session.abort();
		h.release.resolve();
		await withTimeout(stopping, 5_000, "session.abort settles");
		await withTimeout(run, 5_000, "aborted host run settles");
		await withTimeout(session.waitForIdle(), 5_000, "session idle after host abort");

		// 取消闸与 host 租约共存：不再开第二次 stream，也不留空 aborted assistant。
		expect(h.streams).toEqual(["live"]);
		expect(
			session.messages.filter(
				(message) => message.role === "assistant" && (message as AssistantMessage).stopReason === "aborted",
			),
		).toHaveLength(0);
		expect(session.isIdle).toBe(true);

		// retain 语义：排队输入没有被丢，也没有被这次已取消的 run 消费掉。
		const queued = () =>
			session.agent
				.getQueuedMessages()
				.filter((message) => message.role === "user" && texts(message).includes("host-queued"));
		expect(queued()).toHaveLength(1);
		expect(
			session.messages.filter((message) => message.role === "user" && texts(message).includes("host-queued")),
		).toHaveLength(0);
	});
});

describe("core abort gate (unmanaged AgentSession)", () => {
	it("[session-abort-tool] session.abort() during an uncooperative tool ends the run without a second stream", async () => {
		const h = await sdkAbortHarness();
		expect(h.fixture.session.agent.preparePendingRequest).toBeUndefined();
		const run = h.fixture.session.prompt("sdk-abort-old");
		await withTimeout(h.entered.promise, 5_000, "gated tool entered");

		const stopping = h.fixture.session.abort();
		h.release.resolve();
		await withTimeout(stopping, 5_000, "session.abort settles");
		await withTimeout(run, 5_000, "aborted session run settles");
		await withTimeout(h.fixture.session.waitForIdle(), 5_000, "session idle after abort");

		expect(h.streams).toEqual(["live"]);
		expect(h.log).toContain("tool:end");
		const abortedAssistants = h.fixture.session.messages.filter(
			(message) => message.role === "assistant" && (message as AssistantMessage).stopReason === "aborted",
		);
		expect(abortedAssistants).toHaveLength(0);
		expect(h.fixture.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(h.fixture.session.isIdle).toBe(true);
		expect(h.events.filter((type) => type === "agent_end")).toHaveLength(1);
	});
});
