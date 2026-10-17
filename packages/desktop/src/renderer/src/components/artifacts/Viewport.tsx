import { memo, useMemo } from "react";
import type { ArtifactItem } from "./useArtifacts";

export interface ViewportProps {
	artifact: ArtifactItem | null;
	viewMode: "preview" | "code";
	zoom: number;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function renderSimpleMarkdown(md: string, isDark: boolean): string {
	const lines = md.split("\n");
	const html: string[] = [];
	let inCodeBlock = false;
	let codeBlockLang = "";
	let codeBlockLines: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();

		// Code block
		if (trimmed.startsWith("```")) {
			if (inCodeBlock) {
				html.push(
					`<pre class="art-md-pre"><code class="language-${codeBlockLang}">${escapeHtml(
						codeBlockLines.join("\n"),
					)}</code></pre>`,
				);
				inCodeBlock = false;
				codeBlockLines = [];
			} else {
				inCodeBlock = true;
				codeBlockLang = trimmed.slice(3).trim();
			}
			continue;
		}

		if (inCodeBlock) {
			codeBlockLines.push(line);
			continue;
		}

		// Headers
		if (trimmed.startsWith("### ")) {
			html.push(`<h3 class="art-md-h3">${escapeHtml(trimmed.slice(4))}</h3>`);
			continue;
		}
		if (trimmed.startsWith("## ")) {
			html.push(`<h2 class="art-md-h2">${escapeHtml(trimmed.slice(3))}</h2>`);
			continue;
		}
		if (trimmed.startsWith("# ")) {
			html.push(`<h1 class="art-md-h1">${escapeHtml(trimmed.slice(2))}</h1>`);
			continue;
		}

		// Lists
		if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
			html.push(`<li class="art-md-li">${escapeHtml(trimmed.slice(2))}</li>`);
			continue;
		}

		// Blockquote
		if (trimmed.startsWith("> ")) {
			html.push(`<blockquote class="art-md-quote">${escapeHtml(trimmed.slice(2))}</blockquote>`);
			continue;
		}

		// Paragraph
		if (trimmed) {
			html.push(`<p class="art-md-p">${escapeHtml(trimmed)}</p>`);
		}
	}

	const bg = isDark ? "#0d1117" : "#ffffff";
	const fg = isDark ? "#e6edf3" : "#1f2328";
	const border = isDark ? "#30363d" : "#d0d7de";
	const codeBg = isDark ? "#161b22" : "#f6f8fa";
	const quoteBorder = isDark ? "#3b82f6" : "#0969da";
	const quoteFg = isDark ? "#8b949e" : "#57606a";

	return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
		body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 24px; color: ${fg}; background: ${bg}; line-height: 1.6; }
		.art-md-h1 { border-bottom: 1px solid ${border}; padding-bottom: 8px; margin-top: 24px; color: ${fg}; }
		.art-md-h2 { border-bottom: 1px solid ${border}; padding-bottom: 6px; margin-top: 20px; color: ${fg}; }
		.art-md-h3 { margin-top: 16px; color: ${fg}; }
		.art-md-pre { background: ${codeBg}; border: 1px solid ${border}; border-radius: 6px; padding: 12px; overflow-x: auto; font-family: monospace; font-size: 13px; color: ${fg}; }
		.art-md-quote { border-left: 4px solid ${quoteBorder}; margin: 12px 0; padding-left: 12px; color: ${quoteFg}; }
		.art-md-p { margin: 8px 0; color: ${fg}; }
		.art-md-li { margin: 4px 0; margin-left: 20px; color: ${fg}; }
	</style></head><body>${html.join("\n")}</body></html>`;
}

export const Viewport = memo(function Viewport({
	artifact,
	viewMode,
	zoom,
}: ViewportProps) {
	const isDark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");

	const srcDoc = useMemo(() => {
		if (!artifact?.content) return "";
		if (artifact.fileType === "markdown") {
			return renderSimpleMarkdown(artifact.content, isDark);
		}
		if (artifact.fileType === "svg") {
			const svgBg = isDark ? "#0d1117" : "#ffffff";
			const svgFg = isDark ? "#e6edf3" : "#1f2328";
			return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:${svgBg};color:${svgFg};}svg{max-width:90vw;max-height:90vh;}</style></head><body>${artifact.content}</body></html>`;
		}
		return artifact.content;
	}, [artifact, isDark]);

	const codeLines = useMemo(() => {
		if (!artifact?.content) return [];
		return artifact.content.split("\n").map((line, index) => ({
			id: `line-${index + 1}`,
			lineNo: index + 1,
			text: line,
		}));
	}, [artifact?.content]);

	if (!artifact) {
		return (
			<div className="art-empty-viewport">
				<div style={{ fontSize: 32, marginBottom: 8 }}>🎨</div>
				<div style={{ fontWeight: 600, marginBottom: 4 }}>暂无可预览的产物</div>
				<div style={{ fontSize: 12, opacity: 0.6 }}>
					在与 Agent 对话时生成 HTML/SVG/Markdown 文件，这里将自动呈现其实时渲染
				</div>
			</div>
		);
	}

	const zoomScale = zoom / 100;

	return (
		<main className="art-viewport-container">
			{viewMode === "preview" ? (
				<div className="art-preview-wrapper">
					<div
						className="art-preview-canvas"
						style={{
							transform: `scale(${zoomScale})`,
							transformOrigin: "top left",
							width: `${100 / zoomScale}%`,
							height: `${100 / zoomScale}%`,
						}}
					>
						<iframe
							title={`Preview: ${artifact.fileName}`}
							className="art-preview-iframe"
							srcDoc={srcDoc}
							sandbox="allow-scripts allow-modals"
						/>
					</div>
				</div>
			) : (
				<div className="art-code-wrapper">
					<div className="art-code-viewer">
						{codeLines.map((item) => (
							<div key={item.id} className="art-code-line">
								<span className="art-code-lineno">{item.lineNo}</span>
								<span className="art-code-text">{item.text}</span>
							</div>
						))}
					</div>
				</div>
			)}
		</main>
	);
});
