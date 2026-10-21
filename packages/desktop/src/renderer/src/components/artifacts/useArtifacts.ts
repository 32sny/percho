import { useMemo, useState } from "react";
import { useSessionsStore } from "../../stores/sessions";
import { useTranscriptStore } from "../../stores/transcript";
import { useUiStore } from "../../stores/ui";

export interface ArtifactItem {
	id: string;
	toolKey: string;
	path: string;
	fileName: string;
	content: string;
	diff?: string;
	fileType: "html" | "svg" | "javascript" | "typescript" | "css" | "json" | "markdown" | "other";
	previewable: boolean;
	sourceTool: "write" | "edit" | "read";
	stat?: { added: number; removed: number };
	timestamp: number;
}

function inferFileType(path: string): {
	type: ArtifactItem["fileType"];
	previewable: boolean;
} {
	const lower = path.toLowerCase();
	if (lower.endsWith(".html") || lower.endsWith(".htm")) {
		return { type: "html", previewable: true };
	}
	if (lower.endsWith(".svg")) {
		return { type: "svg", previewable: true };
	}
	if (lower.endsWith(".md")) {
		return { type: "markdown", previewable: true };
	}
	if (lower.endsWith(".ts") || lower.endsWith(".tsx")) {
		return { type: "typescript", previewable: false };
	}
	if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs")) {
		return { type: "javascript", previewable: false };
	}
	if (lower.endsWith(".css")) {
		return { type: "css", previewable: false };
	}
	if (lower.endsWith(".json")) {
		return { type: "json", previewable: false };
	}
	return { type: "other", previewable: false };
}

function parseArgsSafe(argsStr: unknown): Record<string, unknown> | null {
	if (!argsStr) return null;
	if (typeof argsStr === "object") return argsStr as Record<string, unknown>;
	if (typeof argsStr !== "string") return null;
	try {
		return JSON.parse(argsStr);
	} catch {
		return null;
	}
}

/** 稳健的应用局部编辑补丁，计算修改后的完整文件内容 */
function applyEditsSafe(baseText: string, edits: unknown): string {
	if (!baseText || !Array.isArray(edits)) return baseText;
	let current = baseText;
	for (const item of edits) {
		if (item && typeof item === "object") {
			const oldText = (item as { oldText?: unknown }).oldText;
			const newText = (item as { newText?: unknown }).newText;
			if (typeof oldText === "string" && typeof newText === "string" && oldText) {
				current = current.replace(oldText, newText);
			}
		}
	}
	return current;
}

export function useArtifacts() {
	const activeSessionId = useSessionsStore((s: any) => s.activeSessionId);
	const transcript = useTranscriptStore((s: any) => (activeSessionId ? s.bySession[activeSessionId] : null));
	const diffFocus = useUiStore((s) => s.diffFocus);

	const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);

	// 从当前会话正序提取、融合补丁并维护所有真实文件
	const artifacts = useMemo<ArtifactItem[]>(() => {
		if (!transcript?.messages) return [];

		const map = new Map<string, ArtifactItem>();

		const processTool = (tool: any, msgTimestamp?: number) => {
			const toolName = String(tool.name || "").toLowerCase();
			const parsedArgs = parseArgsSafe(tool.args);
			const timestamp = msgTimestamp || Date.now();

			const rawPath = typeof parsedArgs?.path === "string" ? parsedArgs.path.trim() : null;
			if (!rawPath) return;

			const fileName = rawPath.split(/[/\\]/).pop() || rawPath;
			const { type, previewable } = inferFileType(rawPath);
			const existing = map.get(rawPath);

			// (1) write 工具 (写入完整代码)
			if (toolName === "write") {
				const content = typeof parsedArgs?.content === "string" ? parsedArgs.content : "";
				let renderContent = content;
				if (type === "svg" && !content.includes("<!DOCTYPE html>") && !content.includes("<html")) {
					renderContent = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#0d1117;color:#e6edf3;}svg{max-width:90vw;max-height:90vh;}</style></head><body>${content}</body></html>`;
				}

				map.set(rawPath, {
					id: rawPath,
					toolKey: tool.key || rawPath,
					path: rawPath,
					fileName,
					content: renderContent,
					diff: tool.diff,
					fileType: type,
					previewable,
					sourceTool: "write",
					timestamp,
				});
			}

			// (2) edit 工具 (增量补丁合并)
			else if (toolName === "edit") {
				const edits = parsedArgs?.edits;
				const prevContent = existing ? existing.content : "";
				const updatedContent = applyEditsSafe(prevContent, edits);

				map.set(rawPath, {
					id: rawPath,
					toolKey: tool.key || rawPath,
					path: rawPath,
					fileName,
					content: updatedContent,
					diff: tool.diff || existing?.diff,
					fileType: type,
					previewable,
					sourceTool: "edit",
					timestamp,
				});
			}
		};

		// 遍历历史消息
		for (const msg of transcript.messages) {
			if (msg.tools && Array.isArray(msg.tools)) {
				for (const tool of msg.tools) {
					processTool(tool, (msg as any).timestamp);
				}
			}
		}

		// 处理正在流式的实时工具
		if (transcript.streaming?.tools && Array.isArray(transcript.streaming.tools)) {
			for (const tool of transcript.streaming.tools) {
				processTool(tool);
			}
		}

		// 按时间戳倒序排列
		return Array.from(map.values()).sort((a, b) => b.timestamp - a.timestamp);
	}, [transcript]);

	// 计算当前选中的产物
	const activeArtifact = useMemo(() => {
		if (artifacts.length === 0) return null;
		if (activeArtifactId) {
			const found = artifacts.find((a) => a.id === activeArtifactId);
			if (found) return found;
		}
		// 如果有 diffFocus 触发，优先匹配对应的文件
		if (diffFocus?.sectionKey) {
			const focusMatched = artifacts.find(
				(a) => a.toolKey === diffFocus.sectionKey || a.path.includes(diffFocus.sectionKey),
			);
			if (focusMatched) return focusMatched;
		}
		// 默认首选第一个可预览项，否则取第一个
		const firstPreviewable = artifacts.find((a) => a.previewable);
		return firstPreviewable || artifacts[0]!; // The empty-array guard above guarantees the first artifact exists.
	}, [artifacts, activeArtifactId, diffFocus]);

	return {
		artifacts,
		activeArtifact,
		setActiveArtifactId,
	};
}
