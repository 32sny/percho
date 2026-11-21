import { type ComposerDocument, composerDocumentText, type ImageInput } from "@percho/shared";
import { create } from "zustand";

/**
 * 新会话页（`activeSessionId === null`）的草稿 key。
 * 单例 draft：全局只有这一份新会话内容，新建/再点「＋」/promotion 前后都不换 key。
 */
export const NEW_SESSION_DRAFT_KEY = "__new__";

/** 请求聚焦输入框的窗口事件名（撤回回填草稿后由 store 派发，Composer 监听聚焦 textarea） */
export const COMPOSER_FOCUS_EVENT = "pi:composer-focus";

/** 成功卸载会话后释放对应 Lexical editor host。 */
export const COMPOSER_EDITOR_RELEASE_EVENT = "pi:composer-editor-release";

/** 一份会话草稿：文本 + 图片附件 + slash 命令胶囊 + @ 文件引用胶囊 + 选中引用胶囊 */
export type DraftImage = ImageInput & { name?: string };

export interface DraftEntry {
	text: string;
	/** Stage 2 Lexical document；缺省表示从既有 text/attachments 即时构造兼容文档。 */
	document?: ComposerDocument;
	images: DraftImage[];
	slashCommand: string | null;
	/** @ 文件引用（项目相对路径）；发送时拼回 @path 列表置于正文前 */
	attachments: string[];
	/** 选中引用（对话区选中内容弹菜单添加）；发送时逐条转 blockquote 段落置于最前 */
	quotes: string[];
	/**
	 * 出队尚未确认的保护标记，只用于两种情况：
	 * 1) 取回已完成冻结与回填、但确认 discard 还失败/无回执（防止把内容当成新消息发出去，也防丢标记）；
	 * 2) 兼容旧版本草稿残留的取回关联（需明确取回一次补完出队）。
	 * 出队确认后即清除；它**不**参与提交，也不再携带旧实体提交。仅元数据，不参与 isEmpty 判定。
	 */
	recovery?: { messageId: string; expectedRevision: number };
}

/** 模块级共享空态（selector 缺省返回，引用稳定防重渲染循环） */
export const EMPTY_DRAFT: DraftEntry = {
	text: "",
	images: [],
	slashCommand: null,
	attachments: [],
	quotes: [],
};

/**
 * 输入框草稿按会话保存。Composer 会在空态（EmptyState 内）与列表态（底部）之间切换实例，
 * 本地 useState 会丢草稿；且不同会话的草稿应各自独立（A 的不串到 B）。无内容且无恢复关联的条目不入表。
 */
interface DraftStore {
	bySession: Record<string, DraftEntry>;
	/** 更新某会话草稿；仅无内容且无出队保护标记时删除，避免丢掉未确认的出队状态。 */
	updateDraft: (key: string, updater: (entry: DraftEntry) => DraftEntry) => void;
}

let draftVersionSequence = 0;
const draftVersions = new WeakMap<DraftEntry, number>();

export function getDraftVersion(entry: DraftEntry): number {
	return draftVersions.get(entry) ?? 0;
}

/** 草稿是否有用户内容（recovery 元数据不算内容） */
export function isDraftEmpty(entry: DraftEntry): boolean {
	return isEmpty(entry);
}

function isEmpty(entry: DraftEntry): boolean {
	return (
		!entry.text &&
		(!entry.document || entry.document.parts.length === 0) &&
		entry.images.length === 0 &&
		!entry.slashCommand &&
		entry.attachments.length === 0 &&
		entry.quotes.length === 0
	);
}

export const useDraftStore = create<DraftStore>((set) => ({
	bySession: {},
	updateDraft: (key, updater) =>
		set((state) => {
			const prev = state.bySession[key] ?? EMPTY_DRAFT;
			const rawNext = updater(prev);
			let next = rawNext;
			if (rawNext.document !== prev.document) {
				if (rawNext.document) {
					const plainText = composerDocumentText(rawNext.document);
					if (rawNext.text !== plainText) next = { ...rawNext, text: plainText };
				}
			} else if (rawNext.text !== prev.text && rawNext.document !== undefined) {
				const { document: _, ...rest } = rawNext;
				next = rest;
			}
			draftVersionSequence += 1;
			if (isEmpty(next) && !next.recovery) {
				if (!(key in state.bySession)) return state;
				const rest = { ...state.bySession };
				delete rest[key];
				return { bySession: rest };
			}
			draftVersions.set(next, draftVersionSequence);
			return { bySession: { ...state.bySession, [key]: next } };
		}),
}));
