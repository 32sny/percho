import type { ComposerDocument } from "@percho/shared";
import { Fragment } from "react";
import "../composer/composer-editor.css";

function displayName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	return (trimmed || path).split(/[\\/]/).at(-1) || path;
}

export function ReferenceText({ document }: { document: ComposerDocument }) {
	return (
		<>
			{document.parts.map((part, index) => {
				if (part.type === "text") {
					// biome-ignore lint/suspicious/noArrayIndexKey: 片段由不可变 ComposerDocument 派生
					return <Fragment key={index}>{part.text}</Fragment>;
				}
				if (part.type === "skill") {
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: 同上
						<span key={index} className="composer-reference composer-reference-skill">
							{part.label}
						</span>
					);
				}
				const className =
					part.kind === "directory"
						? "composer-reference composer-reference-file composer-reference-directory"
						: "composer-reference composer-reference-file";
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: 同上
					<span key={index} className={className}>
						@{part.label ?? displayName(part.path)}
					</span>
				);
			})}
		</>
	);
}
