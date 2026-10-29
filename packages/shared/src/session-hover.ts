import type { SessionHoverLiveRun } from "./session";
import { formatSkillCommand, parseExpandedSkillInvocation } from "./skill-invocation";
import type { SessionTranscriptState, StreamingState } from "./transcript/types";

export const SESSION_HOVER_PAGE_SIZE = 6;

const LIVE_BUDGET = 8 * 1024 * 1024;
const TASK_BUDGET = 128 * 1024;

/** 与 TextEncoder 一致，孤立 surrogate 按 replacement character 的三个字节计。 */
function utf8ByteLength(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) bytes++;
		else if (code < 0x800) bytes += 2;
		else if (
			code >= 0xd800 &&
			code <= 0xdbff &&
			text.charCodeAt(i + 1) >= 0xdc00 &&
			text.charCodeAt(i + 1) <= 0xdfff
		) {
			bytes += 4;
			i++;
		} else bytes += 3;
	}
	return bytes;
}

type Projection =
	| { status: "ok"; text: string }
	| { status: "empty" | "unsafe_projection" | "invalid_history" };

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 命名和预览共用；不限制旧命名长度。关系任务另经有界 wrapper。 */
export function safeUserFirstLine(content: unknown): Projection {
	let text: string;
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		const texts: string[] = [];
		for (const part of content) {
			if (!object(part) || typeof part.type !== "string") return { status: "invalid_history" };
			if (part.type !== "text") continue;
			if (typeof part.text !== "string") return { status: "invalid_history" };
			texts.push(part.text);
		}
		text = texts.join(" ");
	} else return { status: "invalid_history" };
	const invocation = parseExpandedSkillInvocation(text);
	const skillMarker = /<\/?skill\b/i;
	if (
		(!invocation && (skillMarker.test(text) || /^\s*References are relative to /i.test(text))) ||
		(invocation && (skillMarker.test(invocation.name) || skillMarker.test(invocation.args ?? "")))
	) {
		return { status: "unsafe_projection" };
	}
	const projected = invocation ? formatSkillCommand(invocation) : text;
	const firstLine = (projected.trim().split("\n", 1)[0] ?? "").trim();
	return firstLine ? { status: "ok", text: firstLine } : { status: "empty" };
}

/** 仅隐藏导航目标，不把任务中合法的代码路径或 /skill 命令一概删除。 */
function containsSessionFile(text: string, sessionFile: string): boolean {
	if (!sessionFile) return false;
	const windows = /^[a-z]:[\\/]|^\\\\/i.test(sessionFile);
	const normalize = (value: string) => {
		const slashes = value.replace(/\\/g, "/");
		return windows ? slashes.toLowerCase() : slashes;
	};
	return normalize(text).includes(normalize(sessionFile));
}

export function projectSessionHoverAgent(agent: unknown, sessionFile: string): string {
	if (typeof agent !== "string") return "subagent";
	const name = agent.trim();
	return !name || /^(?:[a-z]:[\\/]|[\\/]|file:)/i.test(name) || containsSessionFile(name, sessionFile)
		? "subagent"
		: name;
}

export function projectSessionHoverTask(task: unknown, sessionFile: string): string | undefined {
	if (typeof task !== "string") return undefined;
	const projection = safeUserFirstLine(task);
	return projection.status === "ok" &&
		utf8ByteLength(projection.text) <= TASK_BUDGET &&
		!containsSessionFile(projection.text, sessionFile)
		? projection.text
		: undefined;
}

/** 只读窄投影；时间复杂度线性，不每加入一项就序列化整份历史。 */
export function collectSessionHoverLiveRuns(
	transcript:
		| { messages: SessionTranscriptState["messages"]; streaming: Pick<StreamingState, "subagentRuns"> | null }
		| undefined,
): SessionHoverLiveRun[] {
	if (!transcript) return [];
	const output: SessionHoverLiveRun[] = [];
	let bytes = 2; // JSON 数组方括号
	const append = (run: unknown, source: SessionHoverLiveRun["source"]): boolean => {
		if (!object(run) || typeof run.sessionFile !== "string" || !run.sessionFile.trim()) return true;
		const status = run.status;
		if (status !== "running" && status !== "done" && status !== "error") return true;
		const exitCode =
			typeof run.exitCode === "number" && Number.isFinite(run.exitCode) ? run.exitCode : undefined;
		const task = projectSessionHoverTask(run.task, run.sessionFile);
		const projected: SessionHoverLiveRun = {
			sessionFile: run.sessionFile,
			agent: projectSessionHoverAgent(run.agent, run.sessionFile),
			...(task !== undefined ? { task } : {}),
			status,
			...(exitCode !== undefined ? { exitCode } : {}),
			source,
		};
		bytes += utf8ByteLength(JSON.stringify(projected)) + (output.length ? 1 : 0);
		if (bytes > LIVE_BUDGET) return false;
		output.push(projected);
		return true;
	};
	for (const message of transcript.messages) {
		if (message.kind !== "subagent") continue;
		for (const run of message.runs) if (!append(run, "committed")) return [];
	}
	for (const run of transcript.streaming?.subagentRuns ?? []) {
		if (!append(run, "streaming")) return [];
	}
	return output;
}
