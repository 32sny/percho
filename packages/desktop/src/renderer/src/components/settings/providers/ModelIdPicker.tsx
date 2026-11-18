import type { DiscoveredModelSummary, ModelDiscoveryErrorReason } from "@percho/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type MessageKey, useT } from "../../../i18n";
import { ChevronDownIcon } from "../../icons";
import { anchorOfElement, placeMenu } from "../../ui/place-menu";
import { filterDiscoveredModels, formatTokenCount } from "./model-rows";

/** 发现失败的机器原因 → 文案键：显式映射，缺键在编译期暴露，不做动态拼串 */
export const DISCOVERY_REASON_KEYS: Record<ModelDiscoveryErrorReason, MessageKey> = {
	"invalid-url": "settings.providers.discoverReasons.invalidUrl",
	"not-found": "settings.providers.discoverReasons.notFound",
	auth: "settings.providers.discoverReasons.auth",
	"rate-limited": "settings.providers.discoverReasons.rateLimited",
	http: "settings.providers.discoverReasons.http",
	server: "settings.providers.discoverReasons.server",
	redirect: "settings.providers.discoverReasons.redirect",
	html: "settings.providers.discoverReasons.html",
	shape: "settings.providers.discoverReasons.shape",
	"too-large": "settings.providers.discoverReasons.tooLarge",
	timeout: "settings.providers.discoverReasons.timeout",
	aborted: "settings.providers.discoverReasons.aborted",
	network: "settings.providers.discoverReasons.network",
};

/** 表单内的发现结果（内存态，不落盘；改 baseUrl/api 即作废） */
export interface ModelDiscoveryState {
	status: "idle" | "loading" | "ready" | "error";
	models: DiscoveredModelSummary[];
	path?: string;
	reason?: ModelDiscoveryErrorReason;
	tried?: { path: string; reason: string }[];
}

export const EMPTY_DISCOVERY: ModelDiscoveryState = { status: "idle", models: [] };

/** 候选右侧的上限摘要：`128k / 16k`；缺值显示破折号，冲突时先用固定来源展示真实数字，并标出冲突 */
function limitSummary(model: DiscoveredModelSummary, conflictLabel: string): string {
	const uniqueValue = (list: { value: number }[] | undefined) => {
		const values = new Set((list ?? []).map((source) => source.value));
		return values.size === 1 ? [...values][0] : undefined;
	};
	const part = (value: number | undefined) => (value === undefined ? "—" : formatTokenCount(value));
	const contextWindow = model.contextWindow ?? uniqueValue(model.sources?.contextWindow);
	const maxTokens = model.maxTokens ?? uniqueValue(model.sources?.maxTokens);
	const text = `${part(contextWindow)} / ${part(maxTokens)}`;
	const conflicted = model.warnings.some(
		(warning) => warning.endsWith(":conflict") || warning.endsWith(":inconsistent"),
	);
	return conflicted ? `${conflictLabel} · ${text}` : text;
}

/** 发现结果状态行：成功报命中的路径与数量，失败报原因与已试路径（不含响应体） */
export function ModelDiscoveryStatus({ discovery }: { discovery: ModelDiscoveryState }) {
	const t = useT();
	if (discovery.status === "ready") {
		return (
			<p className="mt-1 text-ui-11 leading-relaxed text-ink-faint">
				{t("settings.providers.discoverResult", {
					path: discovery.path ?? "",
					count: discovery.models.length,
				})}
				{discovery.tried && discovery.tried.length > 0
					? ` · ${discovery.tried.map((entry) => entry.path).join(" → ")}`
					: ""}
				{discovery.models.length > 0 ? ` · ${t("settings.providers.discoverPickHint")}` : ""}
			</p>
		);
	}
	if (discovery.status === "error" && discovery.reason) {
		return (
			<p className="mt-1 text-ui-11 leading-relaxed text-ink-faint">
				{t(DISCOVERY_REASON_KEYS[discovery.reason])}
				{discovery.tried && discovery.tried.length > 0
					? ` · ${discovery.tried.map((entry) => entry.path).join(" → ")}`
					: ""}
			</p>
		);
	}
	return null;
}

/**
 * 模型 ID 输入框 + 发现候选下拉（A1）。
 *
 * 只喂候选、不批量导入：选中某一项才写该行的 id 与上限。
 * 从未获取过时展开只显示提示，不偷偷发请求。浮层走 Portal + placeMenu，
 * 避免被设置面板的滚动容器裁切。
 */
export function ModelIdPicker({
	value,
	onValue,
	onPick,
	candidates,
	status,
	reason,
	className,
	placeholder,
	onPaste,
}: {
	value: string;
	onValue: (value: string) => void;
	onPick: (model: DiscoveredModelSummary) => void;
	candidates: DiscoveredModelSummary[];
	status: ModelDiscoveryState["status"];
	reason?: ModelDiscoveryErrorReason;
	className: string;
	placeholder: string;
	/** 透传粘贴：中转站文档常直接粘一列 ID，由行编辑器拆成多行 */
	onPaste?: (e: React.ClipboardEvent<HTMLInputElement>) => void;
}) {
	const t = useT();
	const anchorRef = useRef<HTMLDivElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<{ x: number; y: number; width: number } | null>(null);
	/** 打开后的输入：null = 尚未输入。不能用输入框里已填的 ID 当查询，否则清单会把自己筛掉 */
	const [typed, setTyped] = useState<string | null>(null);

	const filtered = filterDiscoveredModels(candidates, typed ?? "");
	const conflictLabel = t("settings.providers.discoverLimitConflict");

	useLayoutEffect(() => {
		if (!open) {
			setPos(null);
			return;
		}
		const anchor = anchorRef.current;
		if (!anchor) return;
		const rect = anchorOfElement(anchor);
		const width = Math.min(Math.max(rect.width, 260), Math.max(window.innerWidth - 24, 240));
		const height = Math.min(288, Math.max(window.innerHeight - (rect.top + rect.height) - 24, 120));
		const placed = placeMenu(
			rect,
			{ width, height },
			{
				width: window.innerWidth,
				height: window.innerHeight,
			},
		);
		setPos({ x: placed.x, y: placed.y, width });
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
			setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				setOpen(false);
			}
		};
		const onResize = () => setOpen(false);
		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("resize", onResize);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("resize", onResize);
		};
	}, [open]);

	const pick = (model: DiscoveredModelSummary) => {
		onPick(model);
		setOpen(false);
		setTyped(null);
	};

	const hasCandidates = filtered.length > 0;
	const hint =
		status === "loading"
			? t("settings.providers.discovering")
			: status === "error" && reason
				? t(DISCOVERY_REASON_KEYS[reason])
				: status === "ready" && candidates.length === 0
					? t("settings.providers.discoverEmptyList")
					: t("settings.providers.discoverNotFetched");

	const panel = (
		<div
			ref={panelRef}
			role="listbox"
			aria-label={t("settings.providers.customModelId")}
			className="fixed z-50 max-h-72 overflow-y-auto rounded-xl bg-surface p-1 shadow-pop"
			style={{
				left: pos?.x ?? 0,
				top: pos?.y ?? 0,
				width: pos?.width ?? 280,
				visibility: pos ? "visible" : "hidden",
			}}
		>
			{hasCandidates ? (
				filtered.map((model) => (
					<button
						key={model.id}
						type="button"
						role="option"
						aria-selected={model.id === value}
						className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
						onClick={() => pick(model)}
					>
						<span className="min-w-0 flex-1 truncate text-ui-12 text-ink-2">{model.id}</span>
						{model.name && (
							<span className="max-w-40 shrink-0 truncate text-ui-11 text-ink-faint">{model.name}</span>
						)}
						<span className="shrink-0 text-ui-11 font-mono text-ink-faint">
							{limitSummary(model, conflictLabel)}
						</span>
					</button>
				))
			) : (
				<p className="px-2 py-1.5 text-ui-11 leading-relaxed text-ink-faint">{hint}</p>
			)}
		</div>
	);

	return (
		<div ref={anchorRef} className="relative min-w-0 flex-1">
			<input
				className={`${className} pr-7`}
				placeholder={placeholder}
				value={value}
				onChange={(e) => {
					onValue(e.target.value);
					if (open) setTyped(e.target.value);
				}}
				onPaste={onPaste}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown" && !open) {
						e.preventDefault();
						setTyped(null);
						setOpen(true);
					}
				}}
			/>
			<button
				type="button"
				aria-label={t("settings.providers.discoverModels")}
				aria-expanded={open}
				className="absolute top-1/2 right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-hover hover:text-ink-dim"
				onClick={() => {
					setOpen((v) => !v);
					setTyped(null);
				}}
			>
				<ChevronDownIcon />
			</button>
			{open && typeof document !== "undefined" && createPortal(panel, document.body)}
		</div>
	);
}
