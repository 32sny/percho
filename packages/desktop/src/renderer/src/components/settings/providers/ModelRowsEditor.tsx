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

/** 上下文窗口 / 最大输出的常用值：点一下填入，仍可直接手打（1024000 这类非整千值） */
const WINDOW_PRESETS = ["128k", "256k", "512k", "1M"] as const;
const OUTPUT_PRESETS = ["4k", "8k", "16k", "32k"] as const;
/** 可直接选的思考档位（off 用「关闭」单独表达，因为它控制的是能不能关思考） */
const THINKING_LEVEL_OPTIONS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 模型行编辑器：一个模型一张卡；ctx/out 留空跟随 SDK 默认（128k/16k），非法值红框且禁止保存 */
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

	/** 开关型 chip（能力、档位）：选中填实色，未选中只留文字 */
	const chip = (active: boolean, label: string, onClick: () => void) => (
		<button
			type="button"
			aria-pressed={active}
			className={`rounded-md px-1.5 py-0.5 text-ui-10 leading-tight transition-colors ${
				active ? "bg-ink text-surface" : "text-ink-dim hover:bg-hover hover:text-ink"
			}`}
			onClick={onClick}
		>
			{label}
		</button>
	);

	/** 常用值 chip：比开关 chip 弱一档，避免和「能力/档位」抢视线 */
	const presetChip = (active: boolean, label: string, onClick: () => void) => (
		<button
			type="button"
			aria-pressed={active}
			className={`rounded-md border px-1.5 py-0.5 text-ui-10 leading-tight transition-colors ${
				active
					? "border-ink-faint bg-hover text-ink"
					: "border-border text-ink-faint hover:border-ink-faint hover:text-ink-dim"
			}`}
			onClick={onClick}
		>
			{label}
		</button>
	);

	const isPreset = (text: string, preset: string) => {
		const value = parseTokenCount(text);
		return value !== null && value === parseTokenCount(preset);
	};

	/** 一个数值字段：标签 + 输入 + 常用值 */
	const field = (
		label: string,
		tooltip: string,
		value: string,
		placeholder: string,
		presets: readonly string[],
		onValue: (value: string) => void,
	) => {
		const invalid = value.trim() !== "" && parseTokenCount(value) === null;
		return (
			<div className="min-w-0">
				<div className="flex items-center gap-1.5">
					<Tooltip label={tooltip} className="w-8 shrink-0">
						<span className="text-ui-10 text-ink-faint">{label}</span>
					</Tooltip>
					<input
						className={`${inputClass} ${invalid ? "border-red-400" : ""}`}
						aria-invalid={invalid}
						placeholder={placeholder}
						value={value}
						onChange={(e) => onValue(e.target.value)}
					/>
				</div>
				<div className="mt-1 flex flex-wrap items-center gap-0.5">
					{presets.map((preset) => presetChip(isPreset(value, preset), preset, () => onValue(preset)))}
				</div>
			</div>
		);
	};

	return (
		<div className="col-span-2">
			{rows.map((row, i) => {
				const { levels } = parseThinkingLevels(row.thinkingLevels);
				const toggleLevel = (level: string) =>
					setRow(i, {
						thinkingLevels: (levels.includes(level)
							? levels.filter((item) => item !== level)
							: [...levels, level]
						).join(", "),
					});
				return (
					// 行随增删变化，无稳定 id，用序号做 key（局部编辑器，重排场景不存在）
					// biome-ignore lint/suspicious/noArrayIndexKey: 行编辑器无稳定标识
					<div key={i} className="mb-2 rounded-xl border border-border p-3">
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
							<button
								type="button"
								aria-label={t("settings.providers.removeModelRow")}
								className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-hover hover:text-ink-dim"
								onClick={() => removeRow(i)}
							>
								<CloseIcon size={9} />
							</button>
						</div>

						<div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2">
							{field(
								t("settings.providers.presetWindow"),
								t("settings.providers.customModelCtx"),
								row.contextWindow,
								"128k",
								WINDOW_PRESETS,
								(value) => setRow(i, { contextWindow: value }),
							)}
							{field(
								t("settings.providers.presetOutput"),
								t("settings.providers.customModelOut"),
								row.maxTokens,
								"16k",
								OUTPUT_PRESETS,
								(value) => setRow(i, { maxTokens: value }),
							)}
						</div>

						<div className="mt-2.5 flex items-center gap-1.5">
							<span className="w-8 shrink-0 text-ui-10 text-ink-faint">
								{t("settings.providers.presetsAbility")}
							</span>
							<div className="flex flex-wrap items-center gap-1">
								{chip(row.reasoning, t("settings.providers.customModelReasoning"), () =>
									setRow(i, { reasoning: !row.reasoning }),
								)}
								{chip(row.imageInput, t("settings.providers.customModelImage"), () =>
									setRow(i, { imageInput: !row.imageInput }),
								)}
							</div>
						</div>

						{row.reasoning && (
							<div className="mt-2 flex items-center gap-1.5">
								<Tooltip label={t("settings.providers.thinkingLevelsHint")} className="w-8 shrink-0">
									<span className="text-ui-10 text-ink-faint">{t("settings.providers.thinkingLevels")}</span>
								</Tooltip>
								<div className="flex flex-wrap items-center gap-1">
									{chip(row.allowThinkingOff, t("settings.providers.thinkingOff"), () =>
										setRow(i, { allowThinkingOff: !row.allowThinkingOff }),
									)}
									{THINKING_LEVEL_OPTIONS.map((level) =>
										chip(levels.includes(level), level, () => toggleLevel(level)),
									)}
									{levels.length === 0 && (
										<span className="ml-1 text-ui-10 text-ink-faint">
											{t("settings.providers.thinkingLevelsEmpty")}
										</span>
									)}
								</div>
							</div>
						)}
					</div>
				);
			})}

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
