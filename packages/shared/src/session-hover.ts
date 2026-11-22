import type { SessionHoverLiveRun } from "./session";
import { parseSessionTranscriptReference } from "./session-transcript-reference";
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

/** 一行是不是「纯 @附件行」：拖入会话/文件后，附件路径被拼在正文前单独一行 */
function isAttachmentLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.startsWith("@")) return false;
	// 必须带路径分隔符才算附件；`@昵称` 这类不当作附件行
	return /[\\/]/.test(trimmed);
}

/** 附件行 → 短名（末段文件名/会话名，去扩展名与 `-8位id` 后缀）；不返回任何路径成分 */
function attachmentShortNames(line: string): string[] {
	return line
		.split(/\s+@/)
		.map((chunk) => chunk.replace(/^@/, "").trim())
		.filter(Boolean)
		.map((raw) => {
			const reference = parseSessionTranscriptReference(raw);
			if (reference) return reference.name;
			const base =
				raw
					.replace(/[/\\]+$/, "")
					.split(/[/\\]/)
					.pop() ?? "";
			return base
				.replace(/\.[A-Za-z0-9]+$/, "")
				.replace(/-[0-9a-f]{8}$/i, "")
				.trim();
		})
		.filter(Boolean);
}

/** 多条短名拼接：去重、限长，避免标题被一堆文件名撑爆 */
function joinShortNames(names: string[]): string {
	const unique = [...new Set(names)];
	const joined = unique.slice(0, 3).join(" · ");
	const text = unique.length > 3 ? `${joined} · …` : joined;
	return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

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
	// 逐行找第一条**不是 @附件**的正文行：拖入附件后正文常在下一行，
	// 旧实现只取第一行，会把 `@C:\Users\…` 这样裸路径当成会话标题（实测污染顶栏/左栏）。
	const lines = projected.trim().split("\n");
	const bodyLine = lines.map((line) => line.trim()).find((line) => line && !isAttachmentLine(line));
	if (bodyLine) return { status: "ok", text: bodyLine };
	// 整条消息只有附件：给短文件名/会话名，绝不可回退成绝对路径
	const shortNames = joinShortNames(lines.filter(Boolean).flatMap(attachmentShortNames));
	if (shortNames) return { status: "ok", text: shortNames };
	const firstLine = (lines[0] ?? "").trim();
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
		const rawStatus = run.status;
		const status = rawStatus === "queued" ? "running" : rawStatus === "aborted" ? "error" : rawStatus;
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
