import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { deriveProjects, useProjectsStore } from "../../stores/projects";

/**
 * 「移动到项目…」目标选择对话框（spec PLAN-session-move-project §三 决策 3）：
 * ContextMenu 无子菜单能力，目标选择用独立对话框。列出可选项目（排除当前项目与
 * 日常空间，deriveProjects 已滤 daily），点选即执行（非危险操作，无二次确认）。
 * 层级 z-[60] 与 ConfirmDialog 同层：要压过 z-50 的右键菜单。
 */
export function MoveSessionDialog({
	currentCwd,
	onPick,
	onCancel,
}: {
	/** 会话当前所属项目（排除自己） */
	currentCwd: string | undefined;
	onPick: (targetCwd: string) => void;
	onCancel: () => void;
}) {
	const t = useT();
	const ref = useRef<HTMLDivElement>(null);
	const allSessions = useProjectsStore((s) => s.allSessions);
	const addedProjects = useProjectsStore((s) => s.addedProjects);
	const projects = useMemo(
		() => deriveProjects({ allSessions, addedProjects }).filter((p) => p.cwd !== currentCwd),
		[allSessions, addedProjects, currentCwd],
	);

	useEffect(() => {
		const onPointerDown = (e: PointerEvent) => {
			if (ref.current?.contains(e.target as Node)) return;
			onCancel();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onCancel();
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [onCancel]);

	return createPortal(
		<div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/6" role="presentation">
			<div
				ref={ref}
				role="dialog"
				aria-modal="true"
				aria-label={t("sessionMenu.moveTitle")}
				className="relative w-[392px] rounded-2xl bg-surface px-[22px] pt-5 pb-4 shadow-dialog"
			>
				<h2 className="text-ui-19 font-bold tracking-[-0.01em] text-ink">{t("sessionMenu.moveTitle")}</h2>
				<p className="mt-2 text-ui-13 leading-[1.7] text-ink-dim">{t("sessionMenu.moveDesc")}</p>
				{projects.length === 0 ? (
					<p className="mt-4 text-ui-13 text-ink-faint">{t("sessionMenu.moveEmpty")}</p>
				) : (
					<div className="mt-3 max-h-[280px] overflow-y-auto">
						{projects.map((project) => (
							<button
								key={project.cwd}
								type="button"
								className="flex h-[34px] w-full items-center gap-2 rounded-[7px] px-2 text-left text-ui-135 text-ink-2 hover:bg-hover hover:text-ink"
								onClick={() => onPick(project.cwd)}
							>
								{project.name}
								<span className="ml-auto text-ui-12 text-ink-faint">{project.sessionCount}</span>
							</button>
						))}
					</div>
				)}
			</div>
		</div>,
		document.body,
	);
}
