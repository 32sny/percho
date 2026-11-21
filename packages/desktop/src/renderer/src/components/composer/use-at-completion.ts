import { type RefObject, useEffect, useState } from "react";
import { getPi } from "../../api";
import { type AtToken, extractAtToken, filterFiles } from "./at-files";
import type { ComposerEditorHandle } from "./editor-document";

export interface UseAtCompletionOptions {
	cwd: string | null;
	draftKey: string;
	text: string;
	attachments: string[];
	slashOpen: boolean;
	setAttachments: (updater: string[] | ((prev: string[]) => string[])) => void;
	editorRef: RefObject<ComposerEditorHandle | null>;
}

/**
 * @ 文件补全域：光标前 @ token 探测 + 项目文件列表拉取（每 cwd 一次）+
 * 选中插入句中 file token / 目录续钻 + 兼容旧附件移除 + 键盘导航。
 */
export function useAtCompletion(options: UseAtCompletionOptions) {
	const { cwd, draftKey, text, attachments, slashOpen } = options;
	const [atToken, setAtToken] = useState<AtToken | null>(null);
	const [tokenOwner, setTokenOwner] = useState<{
		draftKey: string;
		cwd: string | null;
	} | null>(null);
	const [atFiles, setAtFiles] = useState<string[]>([]);
	const [atFilesCwd, setAtFilesCwd] = useState<string | null>(null);
	const [atSelected, setAtSelected] = useState(0);
	const [atDismissed, setAtDismissed] = useState(false);

	// This reset intentionally follows the draft owner even though the values only invalidate local state.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset token state when draft or cwd changes
	useEffect(() => {
		setAtToken(null);
		setTokenOwner(null);
		setAtDismissed(false);
	}, [draftKey, cwd]);

	/** @ 菜单：token 仍与当前文本及归属草稿/目录一致才有效，slash 打开时不竞争 */
	const atOpen =
		atToken !== null &&
		tokenOwner?.draftKey === draftKey &&
		tokenOwner?.cwd === cwd &&
		text.slice(atToken.start, atToken.end) === `@${atToken.query}` &&
		!atDismissed &&
		!slashOpen;
	const atFiltered = atOpen && atToken ? filterFiles(atFiles, atToken.query) : [];

	// @ token 出现时拉取项目文件列表（每 cwd 一次，backend TTL 缓存）
	useEffect(() => {
		if (!atToken || !cwd || atFilesCwd === cwd) return;
		let cancelled = false;
		void getPi()
			.listProjectFiles({ cwd })
			.then((list) => {
				if (cancelled) return;
				setAtFiles(list);
				setAtFilesCwd(cwd);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [atToken, cwd, atFilesCwd]);

	// The selected index belongs to the current query; the dependency is intentionally a derived optional value.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when the query changes
	useEffect(() => {
		setAtSelected(0);
	}, [atToken?.query]);

	/** 文本变化后探测光标前 @ token（由 Composer 的 onChange 调用，传入 completionText） */
	const updateToken = (value: string, cursor: number) => {
		const next = extractAtToken(value, cursor);
		setAtToken(next);
		setTokenOwner(next ? { draftKey, cwd } : null);
	};

	/** 选中文件/目录：文件 → 句中 file token；目录续钻（菜单保持，query 变为目录路径） */
	const handleAtPick = (path: string) => {
		if (!atToken || !cwd) return;
		const isDir = path.endsWith("/");
		if (!isDir) {
			const absolute = `${cwd.replace(/[\\/]+$/, "")}/${path}`;
			options.editorRef.current?.replaceRangeWithReference(atToken.start, atToken.end, {
				type: "file",
				path: absolute,
				label: path,
			});
			setAtToken(null);
			setTokenOwner(null);
			setAtDismissed(true);
			return;
		}
		const insert = `@${path}`;
		options.editorRef.current?.replaceRange(atToken.start, atToken.end, insert);
		const cursor = atToken.start + insert.length;
		setAtToken({ start: atToken.start, end: cursor, query: path });
		setTokenOwner({ draftKey, cwd });
		requestAnimationFrame(() => {
			const el = options.editorRef.current;
			if (el) {
				el.focus();
				el.setSelectionRange(cursor, cursor);
			}
		});
	};

	/** 移除旧附件胶囊：只移除附件，不把完整路径重新灌回输入框。 */
	const handleAttachmentRemove = (index: number) => {
		if (!attachments[index]) return;
		options.setAttachments((prev) => prev.filter((_, i) => i !== index));
		requestAnimationFrame(() => options.editorRef.current?.focus());
	};

	/** @ 菜单键盘导航：↑↓ 移动，Enter/Tab 选中，Esc 折叠（保留文本）；消费事件返回 true */
	const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>): boolean => {
		if (!atOpen || !atToken) return false;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setAtSelected((s) => s + 1);
			return true;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setAtSelected((s) => s - 1);
			return true;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			setAtDismissed(true);
			return true;
		}
		if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)) {
			e.preventDefault();
			const path = atFiltered[Math.min(atSelected, atFiltered.length - 1)];
			if (path) handleAtPick(path);
			return true;
		}
		return false;
	};

	return {
		atToken,
		atOpen,
		atFiltered,
		atSelected,
		setAtSelected,
		setAtDismissed,
		updateToken,
		handleAtPick,
		handleAttachmentRemove,
		handleKeyDown,
	};
}
