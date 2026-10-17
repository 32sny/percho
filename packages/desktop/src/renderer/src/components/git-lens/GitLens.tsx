import type {
	GitBlameLine,
	GitBranchItem,
	GitCommitRecord,
	GitShowResult,
	GitStatusResult,
} from "@percho/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getPi } from "../../api";
import { selectActiveCwd } from "../../lib/active-cwd";
import { useSessionsStore } from "../../stores/sessions";
import { useUiStore } from "../../stores/ui";
import { CloseIcon, RefreshIcon } from "../icons";
import "./GitLens.css";

type TabKey = "overview" | "history" | "diff" | "branches" | "blame";

interface SheetState {
	type: "commit" | "diff";
	title: string;
	sha?: string;
	path?: string;
	data?: any;
}

export function GitLens() {
	const isOpen = useUiStore((s) => s.gitLensOpen);
	const setOpen = useUiStore((s) => s.setGitLensOpen);
	const cwd = useSessionsStore(selectActiveCwd);

	const [activeTab, setActiveTab] = useState<TabKey>("overview");
	const [status, setStatus] = useState<GitStatusResult | null>(null);
	const [commits, setCommits] = useState<GitCommitRecord[]>([]);
	const [branches, setBranches] = useState<{ current: string | null; list: GitBranchItem[] }>({ current: null, list: [] });
	const [loading, setLoading] = useState(false);
	const [sheet, setSheet] = useState<SheetState | null>(null);

	// History Filters
	const [historyQuery, setHistoryQuery] = useState("");
	const [historyPath, setHistoryPath] = useState("");

	// Blame State
	const [blamePath, setBlamePath] = useState("");
	const [blameLines, setBlameLines] = useState<GitBlameLine[]>([]);

	// Commit Box State
	const [commitMsg, setCommitMsg] = useState("");

	// 宽度拖拽状态（支持本地存储记忆）
	const [width, setWidth] = useState(() => {
		const saved = localStorage.getItem("percho_gitlens_width");
		return saved ? Math.max(320, Math.min(1200, Number(saved))) : 440;
	});
	const [resizing, setResizing] = useState(false);
	const draggingRef = useRef(false);
	const startXRef = useRef(0);
	const startWidthRef = useRef(0);
	const handleRef = useRef<HTMLDivElement | null>(null);
	const pointerIdRef = useRef<number | null>(null);

	const finishResize = useCallback(() => {
		if (!draggingRef.current) return;
		draggingRef.current = false;
		document.body.style.cursor = "";
		setResizing(false);
		const pointerId = pointerIdRef.current;
		pointerIdRef.current = null;
		if (handleRef.current && pointerId !== null && handleRef.current.hasPointerCapture(pointerId)) {
			handleRef.current.releasePointerCapture(pointerId);
		}
	}, []);

	useEffect(() => {
		const onBlurOrHide = () => finishResize();
		window.addEventListener("blur", onBlurOrHide);
		document.addEventListener("visibilitychange", onBlurOrHide);
		return () => {
			window.removeEventListener("blur", onBlurOrHide);
			document.removeEventListener("visibilitychange", onBlurOrHide);
		};
	}, [finishResize]);

	const onPointerDownResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		draggingRef.current = true;
		handleRef.current = e.currentTarget;
		pointerIdRef.current = e.pointerId;
		startXRef.current = e.clientX;
		startWidthRef.current = width;
		e.currentTarget.setPointerCapture(e.pointerId);
		document.body.style.cursor = "col-resize";
		setResizing(true);
		e.preventDefault();
	}, [width]);

	const onPointerMoveResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		if (!draggingRef.current) return;
		if (e.buttons === 0) {
			finishResize();
			return;
		}
		const delta = startXRef.current - e.clientX;
		const maxWidth = Math.round(window.innerWidth * 0.85);
		const nextWidth = Math.max(320, Math.min(maxWidth, startWidthRef.current + delta));
		setWidth(nextWidth);
		localStorage.setItem("percho_gitlens_width", String(nextWidth));
	}, [finishResize]);

	const loadStatus = useCallback(async () => {
		if (!cwd) return;
		try {
			const res = await getPi().gitStatus({ cwd });
			setStatus(res);
		} catch {
			setStatus(null);
		}
	}, [cwd]);

	const loadCommits = useCallback(async (query = "", path = "") => {
		if (!cwd) return;
		try {
			const res = await getPi().gitLog({ cwd, count: 50, query: query || undefined, path: path || undefined });
			setCommits(res.commits);
		} catch {
			setCommits([]);
		}
	}, [cwd]);

	const loadBranches = useCallback(async () => {
		if (!cwd) return;
		try {
			const res = await getPi().gitBranch({ cwd, action: "list" });
			setBranches({ current: res.current, list: res.branches });
		} catch {
			setBranches({ current: null, list: [] });
		}
	}, [cwd]);

	const refreshAll = useCallback(async () => {
		setLoading(true);
		await Promise.allSettled([
			loadStatus(),
			loadCommits(historyQuery, historyPath),
			loadBranches(),
		]);
		setLoading(false);
	}, [loadStatus, loadCommits, loadBranches, historyQuery, historyPath]);

	useEffect(() => {
		if (isOpen && cwd) {
			void refreshAll();
		}
	}, [isOpen, cwd, refreshAll]);

	// Esc 键关闭
	useEffect(() => {
		if (!isOpen) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [isOpen, setOpen]);

	const openCommitDetail = async (sha: string) => {
		if (!cwd) return;
		try {
			const show = await getPi().gitShow({ cwd, ref: sha, patch: true, stat: true });
			setSheet({
				type: "commit",
				title: `Commit ${show.commit?.shortSha || sha.slice(0, 7)}`,
				sha,
				data: show,
			});
		} catch (e: any) {
			console.error("Failed to load commit detail:", e);
		}
	};

	const openFileDiff = async (filePath: string) => {
		if (!cwd) return;
		try {
			const diff = await getPi().gitDiff({ cwd, path: filePath, patch: true, stat: true });
			setSheet({
				type: "diff",
				title: `Diff: ${filePath}`,
				path: filePath,
				data: diff,
			});
		} catch (e: any) {
			console.error("Failed to load file diff:", e);
		}
	};

	const handleSwitchBranch = async (branchName: string) => {
		if (!cwd) return;
		try {
			await getPi().gitBranch({ cwd, action: "switch", name: branchName });
			await refreshAll();
		} catch (e: any) {
			alert(`Switch branch failed: ${e.message}`);
		}
	};

	const handleCommit = async () => {
		if (!cwd || !commitMsg.trim()) return;
		try {
			await getPi().gitCommit({ cwd, message: commitMsg.trim(), stage: "all" });
			setCommitMsg("");
			await refreshAll();
		} catch (e: any) {
			alert(`Commit failed: ${e.message}`);
		}
	};

	const handleBlame = async () => {
		if (!cwd || !blamePath.trim()) return;
		try {
			const res = await getPi().gitBlame({ cwd, path: blamePath.trim() });
			setBlameLines(res.lines);
		} catch (e: any) {
			alert(`Blame failed: ${e.message}`);
			setBlameLines([]);
		}
	};

	const repoName = status?.repo ? status.repo.split(/[\\/]/).pop() : "Repository";
	const currentBranch = status?.branch || branches.current || "detached";

	return (
		<aside
			className={`gl-panel ${isOpen ? "gl-open" : ""} ${resizing ? "is-resizing" : ""}`}
			style={{ width: `${width}px` }}
			aria-label="Git Lens"
		>
			{/* 拖拽改变宽度把手：透明无色，简洁纯粹 */}
			<div
				className="gl-resize-handle"
				onPointerDown={onPointerDownResize}
				onPointerMove={onPointerMoveResize}
				onPointerUp={finishResize}
				onPointerCancel={finishResize}
				onLostPointerCapture={finishResize}
			/>
			<header className="gl-header">
				<div className="gl-status-line">
					<div className="gl-status-info">
						<span className="gl-status-title">Git 透镜</span>
						<span className="gl-status-branch">⎇ {currentBranch}</span>
						<span className="gl-status-meta" title={status?.repo || ""}>
							{repoName}
						</span>
					</div>
					<div className="gl-head-actions">
						<button
							type="button"
							className="gl-icon-btn"
							title="刷新"
							onClick={refreshAll}
							disabled={loading}
						>
							<RefreshIcon />
						</button>
						<button
							type="button"
							className="gl-icon-btn"
							title="关闭 (Esc)"
							onClick={() => setOpen(false)}
							aria-label="关闭"
						>
							<CloseIcon />
						</button>
					</div>
				</div>

				<nav className="gl-segmented">
					<button
						type="button"
						className={`gl-segment-btn ${activeTab === "overview" ? "active" : ""}`}
						onClick={() => { setActiveTab("overview"); setSheet(null); }}
					>
						概览
					</button>
					<button
						type="button"
						className={`gl-segment-btn ${activeTab === "history" ? "active" : ""}`}
						onClick={() => { setActiveTab("history"); setSheet(null); }}
					>
						历史
					</button>
					<button
						type="button"
						className={`gl-segment-btn ${activeTab === "diff" ? "active" : ""}`}
						onClick={() => { setActiveTab("diff"); setSheet(null); }}
					>
						改动
					</button>
					<button
						type="button"
						className={`gl-segment-btn ${activeTab === "branches" ? "active" : ""}`}
						onClick={() => { setActiveTab("branches"); setSheet(null); }}
					>
						分支
					</button>
					<button
						type="button"
						className={`gl-segment-btn ${activeTab === "blame" ? "active" : ""}`}
						onClick={() => { setActiveTab("blame"); setSheet(null); }}
					>
						追溯
					</button>
				</nav>
			</header>

			<main className="gl-content">
				{/* OVERVIEW TAB */}
				{activeTab === "overview" && (
					<div>
						<div className="gl-metrics">
							<div className="gl-metric-card">
								<div className={`gl-metric-num ${status?.staged.length ? "has-items" : ""}`}>
									{status?.staged.length || 0}
								</div>
								<div className="gl-metric-label">已暂存</div>
							</div>
							<div className="gl-metric-card">
								<div className={`gl-metric-num ${status?.unstaged.length ? "has-items" : ""}`}>
									{status?.unstaged.length || 0}
								</div>
								<div className="gl-metric-label">未暂存</div>
							</div>
							<div className="gl-metric-card">
								<div className={`gl-metric-num ${status?.untracked.length ? "has-items" : ""}`}>
									{status?.untracked.length || 0}
								</div>
								<div className="gl-metric-label">未跟踪</div>
							</div>
							<div className="gl-metric-card">
								<div className={`gl-metric-num ${status?.conflicts.length ? "conflict" : ""}`}>
									{status?.conflicts.length || 0}
								</div>
								<div className="gl-metric-label">冲突</div>
							</div>
						</div>

						<div className="gl-section-title">
							<span>最近提交</span>
							<span>{commits.slice(0, 10).length}</span>
						</div>

						<div className="gl-commit-list">
							{commits.slice(0, 10).map((c) => (
								<button
									key={c.sha}
									type="button"
									className="gl-commit-item"
									onClick={() => openCommitDetail(c.sha)}
								>
									<div className="gl-commit-subject">{c.subject}</div>
									<div className="gl-commit-meta">
										<span className="gl-commit-hash">{c.shortSha}</span>
										<span>·</span>
										<span>{c.author}</span>
										<span>·</span>
										<span>{c.authorDate ? c.authorDate.slice(0, 16).replace("T", " ") : ""}</span>
									</div>
								</button>
							))}
							{commits.length === 0 && <div className="gl-empty">暂无提交记录</div>}
						</div>
					</div>
				)}

				{/* HISTORY TAB */}
				{activeTab === "history" && (
					<div>
						<div className="gl-search-bar">
							<input
								className="gl-input"
								placeholder="搜索提交..."
								value={historyQuery}
								onChange={(e) => {
									setHistoryQuery(e.target.value);
									void loadCommits(e.target.value, historyPath);
								}}
							/>
							<input
								className="gl-input"
								placeholder="路径（可选）"
								value={historyPath}
								onChange={(e) => {
									setHistoryPath(e.target.value);
									void loadCommits(historyQuery, e.target.value);
								}}
							/>
						</div>

						<div className="gl-commit-list">
							{commits.map((c) => (
								<button
									key={c.sha}
									type="button"
									className="gl-commit-item"
									onClick={() => openCommitDetail(c.sha)}
								>
									<div className="gl-commit-subject">{c.subject}</div>
									<div className="gl-commit-meta">
										<span className="gl-commit-hash">{c.shortSha}</span>
										<span>·</span>
										<span>{c.author}</span>
										<span>·</span>
										<span>{c.authorDate ? c.authorDate.slice(0, 16).replace("T", " ") : ""}</span>
									</div>
								</button>
							))}
							{commits.length === 0 && <div className="gl-empty">未匹配到提交</div>}
						</div>
					</div>
				)}

				{/* CHANGES / DIFF TAB */}
				{activeTab === "diff" && (
					<div>
						{/* Quick Commit Box */}
						<div style={{ marginBottom: 14 }}>
							<input
								className="gl-input"
								placeholder="输入提交信息 (Commit message)..."
								value={commitMsg}
								onChange={(e) => setCommitMsg(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
										void handleCommit();
									}
								}}
							/>
							<div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
								<button
									type="button"
									className="gl-back-btn"
									style={{ background: "var(--text-accent, #38bdf8)", color: "#000", fontWeight: 600 }}
									onClick={handleCommit}
									disabled={!commitMsg.trim()}
								>
									暂存并提交 (Commit)
								</button>
							</div>
						</div>

						{/* Staged */}
						{!!status?.staged.length && (
							<div className="gl-file-group">
								<div className="gl-section-title">
									<span>已暂存 ({status.staged.length})</span>
								</div>
								{status.staged.map((f) => (
									<button key={f.path} type="button" className="gl-file-item" onClick={() => openFileDiff(f.path)}>
										<span className={`gl-file-status ${f.x}`}>{f.x}</span>
										<span className="gl-file-path">{f.path}</span>
									</button>
								))}
							</div>
						)}

						{/* Unstaged */}
						{!!status?.unstaged.length && (
							<div className="gl-file-group">
								<div className="gl-section-title">
									<span>未暂存 ({status.unstaged.length})</span>
								</div>
								{status.unstaged.map((f) => (
									<button key={f.path} type="button" className="gl-file-item" onClick={() => openFileDiff(f.path)}>
										<span className={`gl-file-status ${f.y}`}>{f.y}</span>
										<span className="gl-file-path">{f.path}</span>
									</button>
								))}
							</div>
						)}

						{/* Untracked */}
						{!!status?.untracked.length && (
							<div className="gl-file-group">
								<div className="gl-section-title">
									<span>未跟踪 ({status.untracked.length})</span>
								</div>
								{status.untracked.map((f) => (
									<button key={f.path} type="button" className="gl-file-item" onClick={() => openFileDiff(f.path)}>
										<span className="gl-file-status Q">?</span>
										<span className="gl-file-path">{f.path}</span>
									</button>
								))}
							</div>
						)}

						{!status?.staged.length && !status?.unstaged.length && !status?.untracked.length && (
							<div className="gl-empty">工作区是干净的，没有改动文件</div>
						)}
					</div>
				)}

				{/* BRANCHES TAB */}
				{activeTab === "branches" && (
					<div>
						<div className="gl-section-title">
							<span>本地分支 ({branches.list.length})</span>
						</div>
						<div className="gl-commit-list">
							{branches.list.map((b) => {
								const isCurrent = b.name === branches.current;
								return (
									<div
										key={b.name}
										className="gl-commit-item"
										style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
									>
										<div>
											<div style={{ fontWeight: 600, color: isCurrent ? "var(--text-accent, #38bdf8)" : undefined }}>
												{isCurrent ? "● " : "○ "}
												{b.name}
											</div>
											{b.upstream && (
												<div style={{ fontSize: 11, color: "var(--text-ink-dim)" }}>
													↑↓ {b.upstream}
												</div>
											)}
										</div>
										{!isCurrent && (
											<button
												type="button"
												className="gl-back-btn"
												onClick={() => handleSwitchBranch(b.name)}
											>
												切换
											</button>
										)}
									</div>
								);
							})}
						</div>
					</div>
				)}

				{/* BLAME TAB */}
				{activeTab === "blame" && (
					<div>
						<div className="gl-search-bar">
							<div style={{ display: "flex", gap: 6 }}>
								<input
									className="gl-input"
									placeholder="输入文件相对路径 (如 src/App.tsx)..."
									value={blamePath}
									onChange={(e) => setBlamePath(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") void handleBlame();
									}}
								/>
								<button type="button" className="gl-back-btn" onClick={handleBlame}>
									追溯
								</button>
							</div>
						</div>

						{blameLines.length > 0 ? (
							<div className="gl-patch-box">
								{blameLines.map((line) => (
									<div key={`${line.sha}-${line.finalLine}`} style={{ display: "flex", gap: 8, padding: "2px 0" }}>
										<span style={{ color: "var(--text-accent, #60a5fa)", width: 55, flexShrink: 0 }}>
											{line.sha.slice(0, 7)}
										</span>
										<span style={{ color: "var(--text-ink-dim)", width: 80, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
											{line.author}
										</span>
										<span style={{ width: 35, textAlign: "right", color: "var(--text-ink-dim)", flexShrink: 0 }}>
											{line.finalLine}
										</span>
										<span style={{ flex: 1, whiteSpace: "pre" }}>{line.content}</span>
									</div>
								))}
							</div>
						) : (
							<div className="gl-empty">请输入文件路径并点击追溯</div>
						)}
					</div>
				)}

				{/* DETAIL SHEET OVERLAY */}
				{sheet && (
					<div className="gl-sheet">
						<div className="gl-sheet-header">
							<button type="button" className="gl-back-btn" onClick={() => setSheet(null)}>
								← 返回
							</button>
							<span style={{ fontWeight: 600, fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
								{sheet.title}
							</span>
						</div>

						{sheet.type === "commit" && (
							<div>
								{sheet.data?.commit && (
									<div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid var(--border-border)" }}>
										<div style={{ fontWeight: 600, marginBottom: 4 }}>{sheet.data.commit.subject}</div>
										{sheet.data.commit.body && (
											<div style={{ fontSize: 12, color: "var(--text-ink-dim)", whiteSpace: "pre-wrap", marginBottom: 6 }}>
												{sheet.data.commit.body}
											</div>
										)}
										<div style={{ fontSize: 11, color: "var(--text-ink-dim)" }}>
											{sheet.data.commit.author} · {sheet.data.commit.authorDate?.slice(0, 16).replace("T", " ")}
										</div>
									</div>
								)}

								<div className="gl-section-title">变更文件 ({sheet.data?.files?.length || 0})</div>
								<div style={{ marginBottom: 14 }}>
									{sheet.data?.files?.map((f: any) => (
										<div key={f.path} className="gl-file-item">
											<span className={`gl-file-status ${f.status}`}>{f.status}</span>
											<span className="gl-file-path">{f.path}</span>
										</div>
									))}
								</div>

								{sheet.data?.patch && (
									<div>
										<div className="gl-section-title">完整补丁 (Patch)</div>
										<pre className="gl-patch-box">{sheet.data.patch}</pre>
									</div>
								)}
							</div>
						)}

						{sheet.type === "diff" && (
							<div>
								{sheet.data?.patch ? (
									<pre className="gl-patch-box">{sheet.data.patch}</pre>
								) : (
									<div className="gl-empty">该文件没有文本差异</div>
								)}
							</div>
						)}
					</div>
				)}
			</main>
		</aside>
	);
}
