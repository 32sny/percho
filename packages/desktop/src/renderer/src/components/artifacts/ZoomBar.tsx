import { memo, useState } from "react";

export interface ZoomBarProps {
	zoom: number;
	onZoomChange: (z: number) => void;
	onReset: () => void;
}

export const ZoomBar = memo(function ZoomBar({ zoom, onZoomChange, onReset }: ZoomBarProps) {
	const [presetOpen, setPresetOpen] = useState(false);
	const PRESETS = [50, 75, 100, 125, 150, 200];

	const handleStep = (delta: number) => {
		const next = Math.max(30, Math.min(300, zoom + delta));
		onZoomChange(next);
	};

	return (
		<footer className="art-zoombar">
			<div className="art-zoombar-left">
				<span className="art-zoombar-pill">{zoom}% 缩放</span>
			</div>

			<div className="art-zoombar-right">
				<button
					type="button"
					className="art-zoom-btn"
					onClick={() => handleStep(-10)}
					title="缩小 (Zoom Out)"
				>
					－
				</button>

				<div style={{ position: "relative" }}>
					<button
						type="button"
						className="art-zoom-btn"
						style={{ minWidth: 44, fontWeight: 600 }}
						onClick={() => setPresetOpen(!presetOpen)}
						title="快捷比例切换"
					>
						{zoom}%
					</button>

					{presetOpen && (
						<>
							<button
								type="button"
								className="art-dropdown-backdrop"
								aria-label="关闭预设比例菜单"
								onClick={() => setPresetOpen(false)}
								onKeyDown={(e) => {
									if (e.key === "Escape") setPresetOpen(false);
								}}
							/>
							<div className="art-preset-menu">
								{PRESETS.map((p) => (
									<button
										key={p}
										type="button"
										className={`art-preset-item ${zoom === p ? "active" : ""}`}
										onClick={() => {
											onZoomChange(p);
											setPresetOpen(false);
										}}
									>
										{p}%
									</button>
								))}
							</div>
						</>
					)}
				</div>

				<button type="button" className="art-zoom-btn" onClick={() => handleStep(10)} title="放大 (Zoom In)">
					＋
				</button>

				<button
					type="button"
					className="art-zoom-btn"
					onClick={onReset}
					title="还原 100%"
					style={{ fontSize: 11, padding: "0 6px" }}
				>
					1:1
				</button>
			</div>
		</footer>
	);
});
