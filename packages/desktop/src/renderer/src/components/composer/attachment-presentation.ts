import { parseSessionTranscriptReference } from "@percho/shared";

const CODE_EXTENSIONS = new Set([
	"c",
	"cc",
	"cfg",
	"cjs",
	"conf",
	"cpp",
	"cs",
	"css",
	"go",
	"h",
	"html",
	"ini",
	"java",
	"js",
	"json",
	"jsx",
	"kt",
	"lua",
	"mjs",
	"php",
	"properties",
	"py",
	"rb",
	"rs",
	"scss",
	"sh",
	"sql",
	"swift",
	"toml",
	"ts",
	"tsx",
	"vue",
	"xml",
	"yaml",
	"yml",
]);

const CODE_FILENAMES = new Set([
	".dockerignore",
	".env",
	".gitignore",
	".npmrc",
	"dockerfile",
	"gemfile",
	"makefile",
	"rakefile",
]);

export type AttachmentKind = "session" | "folder" | "markdown" | "code" | "file";

/** 仅派生展示语义；原始路径仍由草稿保存并用于发送。 */
export function attachmentPresentation(path: string): { kind: AttachmentKind; name: string; suffix: string } {
	const isFolderPath = /[/\\]$/.test(path);
	const fileName =
		path
			.replace(/[/\\]+$/, "")
			.split(/[/\\]/)
			.pop() || path;
	if (/(?:^|[\\/])percho-transcripts(?:[\\/]|$)/i.test(path)) {
		return { kind: "session", name: parseSessionTranscriptReference(path)?.name ?? fileName, suffix: "" };
	}
	const dotIndex = fileName.lastIndexOf(".");
	const extension = dotIndex > 0 ? fileName.slice(dotIndex + 1) : "";
	if (isFolderPath || !extension) {
		if (CODE_FILENAMES.has(fileName.toLowerCase())) {
			return { kind: "code", name: fileName, suffix: "" };
		}
		return { kind: "folder", name: fileName, suffix: "/" };
	}
	const name = fileName.slice(0, dotIndex);
	const suffix = `.${extension}`;
	if (extension.toLowerCase() === "md" || extension.toLowerCase() === "mdx") {
		return { kind: "markdown", name, suffix };
	}
	if (CODE_EXTENSIONS.has(extension.toLowerCase()) || CODE_FILENAMES.has(fileName.toLowerCase())) {
		return { kind: "code", name, suffix };
	}
	return { kind: "file", name, suffix };
}
