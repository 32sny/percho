import type { SlashCommandInfo } from "@percho/shared";
import { type RefObject, useEffect, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import type { ComposerEditorHandle } from "./editor-document";
import { extractSlashToken, filterCommands, type SlashToken } from "./slash-filter";

export interface UseSlashMenuOptions {
	activeSessionId: string | null;
	cwd: string | null;
	/** 信任决策应答后递增：按新决策（信任与否）重拉命令 */
	trustVersion: number;
	text: string;
	slashCommand: string | null;
	setSlashCommand: (command: string | null) => void;
	editorRef: RefObject<ComposerEditorHandle | null>;
	ensureSession: () => Promise<string | null>;
	runSlashCommand: (content: string, sessionId: string) => Promise<boolean>;
	handleSend: () => Promise<void>;
	showFeedback: (message: string, tone?: "info" | "warn") => void;
	setError: (error: string | null) => void;
}

const SKILL_PREFIX = "skill:";

/**
 * 斜杠菜单域：命令清单拉取 + 光标前 token 探测 + skill 句中引用 / 胶囊回填 + 键盘导航（↑↓/Tab/Esc）。
 * - skill 命令：在光标处插入句中 skill token
 * - 整条文本恰为无参内置命令（compact/settings）：立即执行
 * - 其余命令（template/extension/带参内置）：命令转胶囊，触发 token 原地移除
 */
export function useSlashMenu(options: UseSlashMenuOptions) {
	const t = useT();
	const [slashSelected, setSlashSelected] = useState(0);
	const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
	const [loadedTarget, setLoadedTarget] = useState<string | null>(null);
	/** 点击面板外部后隐藏菜单（保留文本，再次输入时恢复） */
	const [slashDismissed, setSlashDismissed] = useState(false);
	/** 光标前 / token（Composer 在 onChange/onSelect 时喂入 completionText） */
	const [slashToken, setSlashToken] = useState<SlashToken | null>(null);

	const { activeSessionId, cwd, trustVersion, text } = options;
	const target = activeSessionId ? `session:${activeSessionId}` : cwd ? `cwd:${cwd}` : null;

	/** 胶囊已存在时不再探测（发送拼装只支持单命令，args 里打 / 不开菜单） */
	const updateToken = (value: string, cursor: number) => {
		setSlashToken(options.slashCommand ? null : extractSlashToken(value, cursor));
	};

	/** token 与当前文本及目标会话/目录一致才有效；胶囊模式下不生效 */
	const slashOpen =
		slashToken !== null &&
		!options.slashCommand &&
		loadedTarget === target &&
		text.slice(slashToken.start, slashToken.end) === `/${slashToken.query}` &&
		!slashDismissed;
	const slashQuery = slashOpen ? slashToken.query : "";

	// Session trust changes invalidate the command catalog even though the effect only resets/fetches state.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reload commands when session trust changes
	useEffect(() => {
		setSlashToken(null);
		setSlashDismissed(false);
		const request = activeSessionId
			? getPi().listSlashCommands({ sessionId: activeSessionId })
			: cwd
				? getPi().listSlashCommandsForCwd({ cwd })
				: null;
		if (!request) {
			setSlashCommands([]);
			setLoadedTarget(null);
			return;
		}
		let cancelled = false;
		void request
			.then((list) => {
				if (cancelled) return;
				setSlashCommands(list);
				setLoadedTarget(target);
			})
			.catch(() => {
				if (cancelled) return;
				setSlashCommands([]);
				setLoadedTarget(null);
			});
		return () => {
			cancelled = true;
		};
	}, [activeSessionId, cwd, trustVersion, target]);

	// The selected index belongs to the current query; keep this reset tied to the derived query.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when the query changes
	useEffect(() => {
		setSlashSelected(0);
	}, [slashQuery]);

	const confirmCommand = async (command: SlashCommandInfo, { allowInline = true } = {}) => {
		if (!command.supported) return;
		const token = slashToken;
		const standaloneInline =
			allowInline &&
			token !== null &&
			token.start === 0 &&
			text.slice(token.end).trim() === "" &&
			command.source === "builtin" &&
			new Set(["compact", "settings"]).has(command.name);
		if (standaloneInline) {
			const sessionId = await options.ensureSession();
			if (!sessionId) {
				options.showFeedback(t("slash.feedback.noSession"), "warn");
				return;
			}
			if (token) options.editorRef.current?.replaceRange(token.start, token.end, "");
			setSlashToken(null);
			try {
				await options.runSlashCommand(`/${command.name}`, sessionId);
			} catch (err) {
				options.setError(err instanceof Error ? err.message : String(err));
			}
			return;
		}
		if (command.source === "skill") {
			if (!token || !command.skillId) return;
			const label = command.name.startsWith(SKILL_PREFIX)
				? command.name.slice(SKILL_PREFIX.length)
				: command.name;
			options.editorRef.current?.replaceRangeWithReference(token.start, token.end, {
				type: "skill",
				id: command.skillId,
				label,
			});
			setSlashToken(null);
			setSlashDismissed(true);
			return;
		}
		options.setSlashCommand(command.name);
		setSlashToken(null);
		if (token) {
			const removeEnd = text[token.end] === " " ? token.end + 1 : token.end;
			options.editorRef.current?.replaceRange(token.start, removeEnd, "");
		}
		setSlashDismissed(true);
		requestAnimationFrame(() => {
			options.editorRef.current?.focus();
		});
	};

	/** 按下标选中菜单项（无匹配时落回正常发送） */
	const handleSlashPickByIndex = (index: number) => {
		const flat = filterCommands(slashCommands, slashQuery, t);
		const command = flat[Math.min(index, flat.length - 1)] ?? undefined;
		if (command) {
			void confirmCommand(command);
		} else {
			void options.handleSend();
		}
	};

	/** Tab 补全：确认选中命令（不触发内置立即执行），菜单随之关闭 */
	const handleSlashTabComplete = () => {
		const flat = filterCommands(slashCommands, slashQuery, t);
		const command = flat[Math.min(slashSelected, flat.length - 1)] ?? flat[0];
		if (!command) return;
		void confirmCommand(command, { allowInline: false });
	};

	/** 胶囊弹回文本（空文本 Backspace/Delete，或 Esc）：命令以 "/cmd " 拼回开头，等待继续编辑 */
	const restoreSlashPill = (e: React.KeyboardEvent<HTMLElement>) => {
		e.preventDefault();
		const cmd = options.slashCommand;
		options.setSlashCommand(null);
		if (cmd) options.editorRef.current?.replaceRange(0, 0, `/${cmd} `);
		setSlashToken(null);
		setSlashDismissed(true);
		requestAnimationFrame(() => {
			const el = options.editorRef.current;
			if (el) {
				el.focus();
				const len = el.value.length;
				el.setSelectionRange(len, len);
			}
		});
	};

	/** 斜杠菜单键盘导航；消费事件返回 true */
	const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>): boolean => {
		if (!slashOpen) return false;
		if (e.key === "Tab") {
			e.preventDefault();
			handleSlashTabComplete();
			return true;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setSlashSelected((s) => s + 1);
			return true;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setSlashSelected((s) => s - 1);
			return true;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			setSlashDismissed(true);
			return true;
		}
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			handleSlashPickByIndex(slashSelected);
			return true;
		}
		return false;
	};

	return {
		slashCommands,
		slashSelected,
		setSlashSelected,
		slashOpen,
		slashQuery,
		slashDismissed,
		setSlashDismissed,
		updateToken,
		handleSlashPick: (command: SlashCommandInfo) => confirmCommand(command),
		handleSlashPickByIndex,
		restoreSlashPill,
		handleKeyDown,
	};
}
