import type { SessionMeta } from "@percho/shared";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pi = vi.hoisted(() => ({
	listAllSessions: vi.fn(),
	openSession: vi.fn(),
	getSessionMessages: vi.fn(async () => []),
	getFollowUpMessages: vi.fn(async () => []),
	getTodos: vi.fn(async () => []),
	getPermissionMode: vi.fn(async () => "default"),
	markSessionHistoryReady: vi.fn(async () => {}),
	saveUiState: vi.fn(async () => {}),
}));
vi.mock("../../api", () => ({ getPi: () => pi }));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));

import { useProjectsStore } from "../../stores/projects";
import { useSessionWorkspaceStore } from "../../stores/session-workspace";
import { useSessionsStore } from "../../stores/sessions";
import { useToastsStore } from "../../stores/toasts";
import { useTranscriptStore } from "../../stores/transcript";
import { MessageAttachmentChip } from "./MessageAttachmentChip";

const meta = (sessionId: string): SessionMeta => ({
	sessionId,
	name: "设计讨论",
	cwd: "C:/fixture",
	sessionFile: `C:/fixture/${sessionId}.jsonl`,
	active: false,
	createdAt: 1,
	messageCount: 1,
});
const current = meta("ffffffff-1111-7111-8111-111111111111");
const first = meta("01a18ad2-e4fa-72a4-802e-b634ac9ccc52");
const second = meta("01a18ad2-e4fb-72a4-802e-b634ac9ccc53");
const transcript = (name: string) => `C:/tmp/percho-transcripts/${name}.md`;
let click: (() => void) | undefined;

beforeEach(() => {
	vi.clearAllMocks();
	click = undefined;
	// SSR 只用于取得产品按钮的事件入口；导航、工作区和消息装载均走真实 store。
	vi.stubGlobal("React", {
		...React,
		createElement: (
			type: unknown,
			props: { onClick?: () => void } | null,
			...children: React.ReactNode[]
		) => {
			if (type === "button" && props?.onClick && !click) click = props.onClick;
			return React.createElement(type as React.ElementType, props, ...children);
		},
	});
	useSessionsStore.setState({ sessions: [current], activeSessionId: current.sessionId });
	useSessionWorkspaceStore.setState({ members: [], activeFile: null });
	useProjectsStore.setState({ allSessions: [] });
	useTranscriptStore.setState({ bySession: {} });
	useToastsStore.setState({ toasts: [] });
	pi.listAllSessions.mockResolvedValue([current, first, second]);
	pi.openSession.mockImplementation(async ({ filePath }: { filePath: string }) => {
		const session = [first, second].find((item) => item.sessionFile === filePath);
		if (!session) throw new Error("fixture session missing");
		return session;
	});
});
afterEach(() => vi.unstubAllGlobals());

function clickReference(path: string): void {
	renderToStaticMarkup(React.createElement(MessageAttachmentChip, { path }));
	expect(click).toBeTypeOf("function");
	click?.();
}

async function expectActive(target: SessionMeta): Promise<void> {
	await vi.waitFor(() => {
		expect(useSessionsStore.getState().activeSessionId).toBe(target.sessionId);
		expect(useSessionWorkspaceStore.getState().activeFile).toBe(target.sessionFile);
	});
	expect(useToastsStore.getState().toasts).toHaveLength(0);
}

describe("会话引用点击导航", () => {
	it("完整 ID 精确打开第二条同前缀会话，更新激活态与工作区", async () => {
		clickReference(transcript(`设计讨论-${second.sessionId}`));
		await expectActive(second);
	});

	it("无名会话的完整 UUID 文件名也能打开", async () => {
		clickReference(transcript(second.sessionId));
		await expectActive(second);
	});

	it("已加载的完整 ID 会话直接切换，不重复后端 open", async () => {
		useSessionsStore.setState({ sessions: [current, second] });
		clickReference(transcript(`设计讨论-${second.sessionId}`));
		await expectActive(second);
		expect(pi.openSession).not.toHaveBeenCalled();
	});

	it("旧 8 位引用只有一个候选时继续可用", async () => {
		pi.listAllSessions.mockResolvedValue([current, second]);
		clickReference(transcript("设计讨论-01a18ad2"));
		await expectActive(second);
	});

	it("旧 8 位引用有多个候选时明确报歧义，不打开任何一个", async () => {
		clickReference(transcript("设计讨论-01a18ad2"));
		await vi.waitFor(() =>
			expect(useToastsStore.getState().toasts[0]?.titleKey).toBe("message.openSessionAmbiguous"),
		);
		expect(useSessionsStore.getState().activeSessionId).toBe(current.sessionId);
		expect(pi.openSession).not.toHaveBeenCalled();
	});

	it("完整 ID 已删除时不回退到相同前缀的其他会话", async () => {
		pi.listAllSessions.mockResolvedValue([current, first]);
		clickReference(transcript(`设计讨论-${second.sessionId}`));
		await vi.waitFor(() =>
			expect(useToastsStore.getState().toasts[0]?.titleKey).toBe("message.openSessionFailed"),
		);
		expect(useSessionsStore.getState().activeSessionId).toBe(current.sessionId);
		expect(pi.openSession).not.toHaveBeenCalled();
	});
});
