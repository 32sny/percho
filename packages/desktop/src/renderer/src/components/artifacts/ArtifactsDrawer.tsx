import { useState, useCallback, useRef, useEffect } from "react";
import { useUiStore } from "../../stores/ui";
import { useArtifacts } from "./useArtifacts";
import { TopBar } from "./TopBar";
import { Viewport } from "./Viewport";
import { ZoomBar } from "./ZoomBar";
import "./ArtifactsDrawer.css";

export function ArtifactsDrawer() {
	const isOpen = useUiStore((s) => s.artifactsOpen);
	const toggleOpen = useUiStore((s) => s.toggleArtifacts);
	const setOpen = useUiStore((s) => s.setArtifactsOpen);

	const { artifacts, activeArtifact, setActiveArtifactId } = useArtifacts();
	const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
	const [zoom, setZoom] = useState(100);
	const [isExpanded, setIsExpanded] = useState(false);

	// 宽度拖拽改变（支持本地记忆）
	const [width, setWidth] = useState(() => {
		const saved = localStorage.getItem("percho_artifacts_drawer_width");
		return saved ? Math.max(360, Math.min(1400, Number(saved))) : 520;
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

	// ESC 键关闭
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && isOpen) {
				setOpen(false);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [isOpen, setOpen]);

	const onPointerDownResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0 || isExpanded) return;
		draggingRef.current = true;
		handleRef.current = e.currentTarget;
		pointerIdRef.current = e.pointerId;
		startXRef.current = e.clientX;
		startWidthRef.current = width;
		e.currentTarget.setPointerCapture(e.pointerId);
		document.body.style.cursor = "col-resize";
		setResizing(true);
		e.preventDefault();
	}, [width, isExpanded]);

	const onPointerMoveResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		if (!draggingRef.current) return;
		if (e.buttons === 0) {
			finishResize();
			return;
		}
		const delta = startXRef.current - e.clientX;
		const maxWidth = Math.round(window.innerWidth * 0.9);
		const nextWidth = Math.max(360, Math.min(maxWidth, startWidthRef.current + delta));
		setWidth(nextWidth);
		localStorage.setItem("percho_artifacts_drawer_width", String(nextWidth));
	}, [finishResize]);

	const toggleExpand = useCallback(() => {
		setIsExpanded((prev) => !prev);
	}, []);

	const actualWidth = isExpanded ? "min(92vw, 1600px)" : `${width}px`;

	return (
		<aside
			className={`art-panel ${isOpen ? "art-open" : ""} ${resizing ? "is-resizing" : ""}`}
			style={{ width: actualWidth }}
			aria-label="产物与文件预览工作台"
		>
			{/* 左边缘拖拽把手：透明无色，简洁纯粹 */}
			{!isExpanded && (
				<div
					className="art-resize-handle"
					onPointerDown={onPointerDownResize}
					onPointerMove={onPointerMoveResize}
					onPointerUp={finishResize}
					onPointerCancel={finishResize}
					onLostPointerCapture={finishResize}
				/>
			)}

			<TopBar
				artifacts={artifacts}
				activeArtifact={activeArtifact}
				viewMode={viewMode}
				onSelectArtifact={setActiveArtifactId}
				onToggleViewMode={setViewMode}
				onToggleExpand={toggleExpand}
				isExpanded={isExpanded}
				onClose={() => setOpen(false)}
			/>

			<Viewport
				artifact={activeArtifact}
				viewMode={viewMode}
				zoom={zoom}
			/>

			{activeArtifact?.previewable && viewMode === "preview" && (
				<ZoomBar
					zoom={zoom}
					onZoomChange={setZoom}
					onReset={() => setZoom(100)}
				/>
			)}
		</aside>
	);
}
