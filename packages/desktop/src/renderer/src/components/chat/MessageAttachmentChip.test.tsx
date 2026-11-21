// @vitest-environment happy-dom
import type { SessionMeta } from "@percho/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
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
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

async function clickReference(path: string): Promise<void> {
	await act(() => root.render(<MessageAttachmentChip path={path} />));
	const button = host.querySelector("button");
	if (!button) throw new Error("reference did not render a button");
	await act(() => button.click());
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
		await clickReference(transcript(`设计讨论-${second.sessionId}`));
		await expectActive(second);
	});

	it("无名会话的完整 UUID 文件名也能打开", async () => {
		await clickReference(transcript(second.sessionId));
		await expectActive(second);
	});

	it("已加载的完整 ID 会话直接切换，不重复后端 open", async () => {
		useSessionsStore.setState({ sessions: [current, second] });
		await clickReference(transcript(`设计讨论-${second.sessionId}`));
		await expectActive(second);
		expect(pi.openSession).not.toHaveBeenCalled();
	});

	it("旧 8 位引用只有一个候选时继续可用", async () => {
		pi.listAllSessions.mockResolvedValue([current, second]);
		await clickReference(transcript("设计讨论-01a18ad2"));
		await expectActive(second);
	});

	it("旧 8 位引用有多个候选时明确报歧义，不打开任何一个", async () => {
		await clickReference(transcript("设计讨论-01a18ad2"));
		await vi.waitFor(() =>
			expect(useToastsStore.getState().toasts[0]?.titleKey).toBe("message.openSessionAmbiguous"),
		);
		expect(useSessionsStore.getState().activeSessionId).toBe(current.sessionId);
		expect(pi.openSession).not.toHaveBeenCalled();
	});

	it("完整 ID 已删除时不回退到相同前缀的其他会话", async () => {
		pi.listAllSessions.mockResolvedValue([current, first]);
		await clickReference(transcript(`设计讨论-${second.sessionId}`));
		await vi.waitFor(() =>
			expect(useToastsStore.getState().toasts[0]?.titleKey).toBe("message.openSessionFailed"),
		);
		expect(useSessionsStore.getState().activeSessionId).toBe(current.sessionId);
		expect(pi.openSession).not.toHaveBeenCalled();
	});
});
