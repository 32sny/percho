import { create } from "zustand";

/** chip → 侧栏跳转目标（nonce 保证重复跳同文件也重触发） */
export interface DiffFocus {
	/** 目标文件卡的首个 section key（TurnFileChange.sections[0].toolCallKey） */
	sectionKey: string;
	nonce: number;
}

interface UiStore {
	/** todo 面板展开态（按会话，切换会话互不影响；不含持久化） */
	todoExpanded: Record<string, boolean>;
	toggleTodoExpanded: (sessionId: string) => void;
	/** diff 侧栏开关（内存态，不持久化——重启统一关闭，用户已定） */
	diffSidebarOpen: boolean;
	setDiffSidebarOpen: (open: boolean) => void;
	toggleDiffSidebar: () => void;
	/** Git 透镜侧栏开关（内存态） */
	gitLensOpen: boolean;
	setGitLensOpen: (open: boolean) => void;
	toggleGitLens: () => void;
	/** 产物与文件预览工作台侧栏开关（内存态） */
	artifactsOpen: boolean;
	setArtifactsOpen: (open: boolean) => void;
	toggleArtifacts: () => void;
	/** chip 跳转侧栏的聚焦目标（侧栏消费后清除） */
	diffFocus: DiffFocus | null;
	setDiffFocus: (sectionKey: string) => void;
	clearDiffFocus: () => void;
}

/** 界面态里只放「不跨会话、不落盘」的瞬时开关；持久化偏好一律走 ui-preferences */
export const useUiStore = create<UiStore>((set) => ({
	todoExpanded: {},
	toggleTodoExpanded: (sessionId) =>
		set((state) => ({
			todoExpanded: { ...state.todoExpanded, [sessionId]: !state.todoExpanded[sessionId] },
		})),
	diffSidebarOpen: false,
	setDiffSidebarOpen: (open) =>
		set({
			diffSidebarOpen: open,
			...(open ? { gitLensOpen: false, artifactsOpen: false } : {}),
		}),
	toggleDiffSidebar: () =>
		set((state) => {
			const next = !state.diffSidebarOpen;
			return {
				diffSidebarOpen: next,
				...(next ? { gitLensOpen: false, artifactsOpen: false } : {}),
			};
		}),
	gitLensOpen: false,
	setGitLensOpen: (open) =>
		set({
			gitLensOpen: open,
			...(open ? { diffSidebarOpen: false, artifactsOpen: false } : {}),
		}),
	toggleGitLens: () =>
		set((state) => {
			const next = !state.gitLensOpen;
			return {
				gitLensOpen: next,
				...(next ? { diffSidebarOpen: false, artifactsOpen: false } : {}),
			};
		}),
	artifactsOpen: false,
	setArtifactsOpen: (open) =>
		set({
			artifactsOpen: open,
			...(open ? { diffSidebarOpen: false, gitLensOpen: false } : {}),
		}),
	toggleArtifacts: () =>
		set((state) => {
			const next = !state.artifactsOpen;
			return {
				artifactsOpen: next,
				...(next ? { diffSidebarOpen: false, gitLensOpen: false } : {}),
			};
		}),
	diffFocus: null,
	setDiffFocus: (sectionKey) =>
		set((state) => ({ diffFocus: { sectionKey, nonce: (state.diffFocus?.nonce ?? 0) + 1 } })),
	clearDiffFocus: () => set({ diffFocus: null }),
}));
