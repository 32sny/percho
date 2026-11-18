import type { DiscoveredModelSummary } from "@percho/shared";
import { useT } from "../../../i18n";
import { CloseIcon } from "../../icons";
import { Tooltip } from "../../ui/Tooltip";
import { type ModelDiscoveryState, ModelDiscoveryStatus, ModelIdPicker } from "./ModelIdPicker";
import {
	type DiscoveredLimitNotice,
	EMPTY_MODEL_ROW,
	formatTokenCount,
	type ModelRow,
	parseThinkingLevels,
	parseTokenCount,
	splitPastedModelIds,
} from "./model-rows";

const inputClass =
	"w-full rounded-lg border border-border px-2.5 py-1.5 text-ui-12 outline-none focus:border-ink-faint disabled:cursor-not-allowed disabled:text-ink-faint";

/** 模型行编辑器：每行一个模型；ctx/out 留空跟随 SDK 默认（128k/16k），非法值红框且禁止保存 */
export function ModelRowsEditor({
	rows,
	onChange,
	discovery,
	canDiscover = false,
	onDiscover,
	onPickModel,
	limitNotice,
	onAdoptLimits,
}: {
	rows: ModelRow[];
	onChange: (rows: ModelRow[]) => void;
	/** 清单发现结果（A1）；不传则隐藏「自动获取」入口 */
	discovery?: ModelDiscoveryState;
	/** baseUrl/api 已就绪才允许发起发现（禁用而不隐藏，入口可寻） */
	canDiscover?: boolean;
	onDiscover?: () => void;
	/** 选中候选后未自动填入的上限（一键采用提示）；不传则不渲染 */
	limitNotice?: { modelId: string; notice: DiscoveredLimitNotice } | null;
	onAdoptLimits?: () => void;
	onPickModel?: (index: number, model: DiscoveredModelSummary) => void;
}) {
	const t = useT();

	const setRow = (index: number, patch: Partial<ModelRow>) =>
		onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

	const removeRow = (index: number) => {
		const next = rows.filter((_, i) => i !== index);
		onChange(next.length > 0 ? next : [{ ...EMPTY_MODEL_ROW }]);
	};

	/** 中转站文档常是模型列表，粘贴逗号/换行分隔文本时自动拆成多行 */
	const onIdPaste = (index: number) => (e: React.ClipboardEvent<HTMLInputElement>) => {
		const ids = splitPastedModelIds(e.clipboardData.getData("text"));
		if (!ids) return;
		e.preventDefault();
		const next = [...rows];
		const current = next[index];
		if (!current) return;
		if (current.id.trim()) {
			next.splice(index + 1, 0, ...ids.map((id) => ({ ...EMPTY_MODEL_ROW, id })));
		} else {
			next[index] = { ...current, id: ids[0] };
			next.splice(index + 1, 0, ...ids.slice(1).map((id) => ({ ...EMPTY_MODEL_ROW, id })));
		}
		onChange(next);
	};

	const numberField = (value: string, placeholder: string, onValue: (v: string) => void, tooltip: string) => {
		const invalid = value.trim() !== "" && parseTokenCount(value) === null;
		return (
			<Tooltip label={tooltip} className="w-[4.5rem] shrink-0">
				<input
					className={`${inputClass} text-center ${invalid ? "border-red-400" : ""}`}
					placeholder={placeholder}
					value={value}
					onChange={(e) => onValue(e.target.value)}
				/>
			</Tooltip>
		);
	};

	/**
	 * 勾了「思考」才出现的档位行：文本可留空（= 不写映射、跟随 SDK 默认）；
	 * 写入的值只认 pi 的档位名，认不出的标红且禁止保存。
	 */
	const thinkingRow = (row: ModelRow, index: number) => {
		const { unknown } = parseThinkingLevels(row.thinkingLevels);
		return (
			<div className="mt-1 flex items-center gap-1.5 pl-1">
				<Tooltip label={t("settings.providers.thinkingLevelsHint")} className="shrink-0">
					<span className="text-ui-10 text-ink-faint">{t("settings.providers.thinkingLevels")}</span>
				</Tooltip>
				<input
					className={`${inputClass} min-w-0 flex-1 ${unknown.length > 0 ? "border-red-400" : ""}`}
					aria-invalid={unknown.length > 0}
					placeholder={t("settings.providers.thinkingLevelsPlaceholder")}
					value={row.thinkingLevels}
					onChange={(e) => setRow(index, { thinkingLevels: e.target.value })}
				/>
				{toggle(row.allowThinkingOff, t("settings.providers.allowThinkingOff"), () =>
					setRow(index, { allowThinkingOff: !row.allowThinkingOff }),
				)}
			</div>
		);
	};

	const toggle = (active: boolean, label: string, onToggle: () => void) => (
		<button
			type="button"
			aria-pressed={active}
			className={`shrink-0 rounded-md border px-1.5 py-1 text-ui-10 transition-colors ${
				active ? "border-ink-faint bg-hover text-ink" : "border-border text-ink-faint hover:text-ink-dim"
			}`}
			onClick={onToggle}
		>
			{label}
		</button>
	);

	return (
		<div className="col-span-2">
			{rows.map((row, i) => (
				// 行随增删变化，无稳定 id，用序号做 key（局部编辑器，重排场景不存在）
				// biome-ignore lint/suspicious/noArrayIndexKey: 行编辑器无稳定标识
				<div key={i} className="mb-1.5">
					<div className="flex items-center gap-1.5">
						<ModelIdPicker
							className={`${inputClass} min-w-0`}
							placeholder={t("settings.providers.customModelId")}
							value={row.id}
							onValue={(value) => setRow(i, { id: value })}
							onPaste={onIdPaste(i)}
							onPick={(model) => onPickModel?.(i, model)}
							candidates={discovery?.models ?? []}
							status={discovery?.status ?? "idle"}
							reason={discovery?.reason}
						/>
						{numberField(
							row.contextWindow,
							"ctx 128k",
							(v) => setRow(i, { contextWindow: v }),
							t("settings.providers.customModelCtx"),
						)}
						{numberField(
							row.maxTokens,
							"out 16k",
							(v) => setRow(i, { maxTokens: v }),
							t("settings.providers.customModelOut"),
						)}
						{toggle(row.reasoning, t("settings.providers.customModelReasoning"), () =>
							setRow(i, { reasoning: !row.reasoning }),
						)}
						{toggle(row.imageInput, t("settings.providers.customModelImage"), () =>
							setRow(i, { imageInput: !row.imageInput }),
						)}
						<button
							type="button"
							aria-label={t("settings.providers.removeModelRow")}
							className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-hover hover:text-ink-dim"
							onClick={() => removeRow(i)}
						>
							<CloseIcon size={9} />
						</button>
					</div>
					{row.reasoning && thinkingRow(row, i)}
				</div>
			))}
			<div className="flex items-center gap-3">
				<button
					type="button"
					className="rounded-md px-1.5 py-1 text-ui-11 text-ink-dim transition-colors hover:bg-hover"
					onClick={() => onChange([...rows, { ...EMPTY_MODEL_ROW }])}
				>
					{t("settings.providers.addModelRow")}
				</button>
				{rows.some((row) => row.id.trim()) && (
					<button
						type="button"
						className="rounded-md px-1.5 py-1 text-ui-11 text-ink-dim transition-colors hover:bg-hover"
						onClick={() => onChange([{ ...EMPTY_MODEL_ROW }])}
					>
						{t("settings.providers.clearModelRows")}
					</button>
				)}
				{discovery && (
					<Tooltip
						label={
							canDiscover
								? t("settings.providers.discoverModels")
								: t("settings.providers.discoverNotFetched")
						}
					>
						<button
							type="button"
							className="rounded-md px-1.5 py-1 text-ui-11 text-ink-dim transition-colors hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent"
							disabled={!canDiscover || discovery.status === "loading"}
							onClick={onDiscover}
						>
							{discovery.status === "loading"
								? t("settings.providers.discovering")
								: t("settings.providers.discoverModels")}
						</button>
					</Tooltip>
				)}
			</div>
			{discovery && <ModelDiscoveryStatus discovery={discovery} />}
			{limitNotice && (
				<p className="mt-1 flex flex-wrap items-center gap-2 text-ui-11 leading-relaxed text-ink-faint">
					<span>
						{limitNotice.notice.ambiguousContext
							? t("settings.providers.discoverLimitAmbiguous", { modelId: limitNotice.modelId })
							: t("settings.providers.discoverLimitSkipped", {
									modelId: limitNotice.modelId,
									contextWindow:
										limitNotice.notice.contextWindow !== undefined
											? formatTokenCount(limitNotice.notice.contextWindow)
											: "—",
									maxTokens:
										limitNotice.notice.maxTokens !== undefined
											? formatTokenCount(limitNotice.notice.maxTokens)
											: "—",
								})}
					</span>
					{!limitNotice.notice.ambiguousContext && onAdoptLimits && (
						<button
							type="button"
							className="rounded-md px-1.5 py-0.5 text-ui-11 text-ink-dim transition-colors hover:bg-hover"
							onClick={onAdoptLimits}
						>
							{t("settings.providers.discoverAdopt")}
						</button>
					)}
				</p>
			)}
			<p className="mt-1 text-ui-10 leading-relaxed text-ink-faint">
				{t("settings.providers.customModelsHint")}
			</p>
			{rows.every((row) => !row.id.trim()) && (
				<p className="mt-1 text-ui-10 leading-relaxed text-ink-dim">
					{t("settings.providers.customModelsEmptyHint")}
				</p>
			)}
		</div>
	);
}
