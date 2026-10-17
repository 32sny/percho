import { memo, useState, useCallback } from "react";
import type { ArtifactItem } from "./useArtifacts";
import { CloseIcon } from "../icons";

export interface TopBarProps {
	artifacts: ArtifactItem[];
	activeArtifact: ArtifactItem | null;
	viewMode: "preview" | "code";
	onSelectArtifact: (id: string) => void;
	onToggleViewMode: (mode: "preview" | "code") => void;
	onToggleExpand: () => void;
	isExpanded: boolean;
	onClose: () => void;
}

export const TopBar = memo(function TopBar({
	artifacts,
	activeArtifact,
	viewMode,
	onSelectArtifact,
	onToggleViewMode,
	onToggleExpand,
	isExpanded,
	onClose,
}: TopBarProps) {
	const [dropdownOpen, setDropdownOpen] = useState(false);
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(() => {
		if (!activeArtifact?.content) return;
		navigator.clipboard.writeText(activeArtifact.content).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		});
	}, [activeArtifact]);

	const handleOpenExternal = useCallback(() => {
		if (!activeArtifact?.content) return;
		try {
			const mime = activeArtifact.fileType === "svg" ? "image/svg+xml" : "text/html";
			const blob = new Blob([activeArtifact.content], { type: mime });
			const url = URL.createObjectURL(blob);
			if (url.startsWith("blob:")) {
				window.open(url, "_blank", "noopener,noreferrer");
			}
		} catch (err) {
			console.error("[artifacts-drawer] open external failed:", err);
		}
	}, [activeArtifact]);

	const canPreview = activeArtifact?.previewable ?? false;

	return (
		<header className="art-topbar">
			{/* 左侧：文件名与产物选择下拉菜单 */}
			<div className="art-topbar-left">
				<span className="art-file-badge">📄</span>

				<div style={{ position: "relative" }}>
					<button
						type="button"
						className="art-file-selector-btn"
						onClick={() => setDropdownOpen(!dropdownOpen)}
						title="点击切换产物文件"
					>
						<span className="art-file-name">
							{activeArtifact ? activeArtifact.fileName : "暂无产物"}
						</span>
						{artifacts.length > 1 && (
							<span className="art-badge-count">{artifacts.length}</span>
						)}
						<span style={{ fontSize: 10, opacity: 0.6 }}>▼</span>
					</button>

					{dropdownOpen && (
						<>
							<button
								type="button"
								className="art-dropdown-backdrop"
								aria-label="关闭下拉菜单"
								onClick={() => setDropdownOpen(false)}
								onKeyDown={(e) => {
									if (e.key === "Escape") setDropdownOpen(false);
								}}
							/>
							<div className="art-dropdown-menu">
								<div className="art-dropdown-header">
									<span>本次会话生成的文件</span>
									<span>{artifacts.length} 个</span>
								</div>
								<div className="art-dropdown-list">
									{artifacts.map((item) => (
										<button
											key={item.id}
											type="button"
											className={`art-dropdown-item ${item.id === activeArtifact?.id ? "active" : ""}`}
											onClick={() => {
												onSelectArtifact(item.id);
												setDropdownOpen(false);
											}}
										>
											<div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1, textAlign: "left" }}>
												<span style={{ fontSize: 13 }}>
													{item.fileType === "html" ? "🌐" : item.fileType === "svg" ? "🎨" : "📄"}
												</span>
												<div style={{ minWidth: 0, flex: 1 }}>
													<div className="art-dropdown-item-name">{item.fileName}</div>
													<div className="art-dropdown-item-path">{item.path}</div>
												</div>
											</div>
											{item.previewable && (
												<span className="art-badge-previewable">可预览</span>
											)}
										</button>
									))}
								</div>
							</div>
						</>
					)}
				</div>
			</div>

			{/* 右侧：模式切换与动作按钮 */}
			<div className="art-topbar-right">
				{canPreview && (
					<div className="art-mode-segmented">
						<button
							type="button"
							className={`art-mode-btn ${viewMode === "preview" ? "active" : ""}`}
							onClick={() => onToggleViewMode("preview")}
						>
							预览
						</button>
						<button
							type="button"
							className={`art-mode-btn ${viewMode === "code" ? "active" : ""}`}
							onClick={() => onToggleViewMode("code")}
						>
							源码
						</button>
					</div>
				)}

				<button
					type="button"
					className="art-icon-action-btn"
					onClick={handleCopy}
					title={copied ? "已复制！" : "复制代码"}
				>
					{copied ? "✓" : "📋"}
				</button>

				{canPreview && (
					<button
						type="button"
						className="art-icon-action-btn"
						onClick={handleOpenExternal}
						title="在浏览器独立标签打开"
					>
						↗
					</button>
				)}

				<button
					type="button"
					className="art-icon-action-btn"
					onClick={onToggleExpand}
					title={isExpanded ? "还原宽度" : "最大化铺满"}
				>
					{isExpanded ? "⤓" : "⤢"}
				</button>

				<button
					type="button"
					className="art-icon-action-btn"
					onClick={onClose}
					title="关闭工作台"
				>
					<CloseIcon />
				</button>
			</div>
		</header>
	);
});
