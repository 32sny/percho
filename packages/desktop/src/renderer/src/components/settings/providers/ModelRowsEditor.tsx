import type { DiscoveredModelSummary } from "@percho/shared";
import { useT } from "../../../i18n";
import { InfoIcon, PlusIcon, RefreshIcon, TrashIcon } from "../../icons";
import { Switch } from "../../ui/Switch";
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

const modelIdInputClass =
	"h-7 w-full min-w-0 rounded-lg bg-transparent font-mono text-ui-13 font-medium text-ink-2 outline-none transition-colors hover:bg-hover focus:bg-hover";
const tokenInputClass =
	"h-7 min-w-0 rounded-lg bg-hover px-2 font-mono text-ui-12 font-medium text-ink-2 outline-none transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-strong";
const ghostButtonClass =
	"rounded-lg px-2.5 py-1.5 text-ui-12 text-ink-faint transition-colors hover:bg-hover hover:text-ink-2";

/** 上下文窗口 / 最大输出的常用值：点一下填入，仍可直接手打（1024000 这类非整千值） */
const WINDOW_PRESETS = ["128k", "256k", "512k", "1M"] as const;
const OUTPUT_PRESETS = ["4k", "8k", "16k", "32k"] as const;
/** 可直接选的思考档位（off 用「关闭」单独表达，因为它控制的是能不能关思考） */
const THINKING_LEVEL_OPTIONS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 安静的多选 chip：常态仅文字，hover / 选中才出现胶囊底。 */
function ChoiceChip({
	active,
	label,
	onClick,
	surfaceActive = false,
}: {
	active: boolean;
	label: string;
	onClick: () => void;
	/** 灰色设置带内用 surface 托起选中项，普通卡片上沿用 hover。 */
	surfaceActive?: boolean;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			className={`rounded-full px-1 py-1 font-mono text-ui-11 leading-tight transition-colors ${
				active
					? `${surfaceActive ? "bg-surface" : "bg-hover"} font-medium text-ink-2`
					: "text-ink-faint hover:bg-hover hover:text-ink-2"
			}`}
			onClick={onClick}
		>
			{label}
		</button>
	);
}

function isPreset(text: string, preset: string) {
	const value = parseTokenCount(text);
	return value !== null && value === parseTokenCount(preset);
}

/** B 版数值字段：标签、可编辑值和快捷值共享一条基线，窄处仅在字段内部换行。 */
function TokenField({
	label,
	tooltip,
	value,
	placeholder,
	presets,
	onValue,
}: {
	label: string;
	tooltip: string;
	value: string;
	placeholder: string;
	presets: readonly string[];
	onValue: (value: string) => void;
}) {
	const invalid = value.trim() !== "" && parseTokenCount(value) === null;
	return (
		<div className="min-w-0">
			<div className="flex min-w-0 items-center gap-1">
				<Tooltip label={tooltip} align="start" className="w-8 shrink-0">
					<span className="text-ui-12 text-ink-dim">{label}</span>
				</Tooltip>
				<input
					className={`${tokenInputClass} w-28 shrink-0 ${invalid ? "text-err" : ""}`}
					aria-label={tooltip}
					aria-invalid={invalid}
					placeholder={placeholder}
					value={value}
					onChange={(e) => onValue(e.target.value)}
				/>
				<fieldset aria-label={label} className="flex min-w-0 flex-1 flex-wrap items-center gap-0">
					{presets.map((preset) => (
						<ChoiceChip
							key={preset}
							active={isPreset(value, preset)}
							label={preset}
							onClick={() => onValue(preset)}
						/>
					))}
				</fieldset>
			</div>
		</div>
	);
}

/** 模型行编辑器：一个模型一张白底阴影卡；ctx/out 留空跟随 SDK 默认，非法值禁止保存。 */
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

	return (
		<div className="col-span-2">
			<div className="@container space-y-1">
				{rows.map((row, i) => {
					const { levels } = parseThinkingLevels(row.thinkingLevels);
					const toggleLevel = (level: string) =>
						setRow(i, {
							thinkingLevels: (levels.includes(level)
								? levels.filter((item) => item !== level)
								: [...levels, level]
							).join(", "),
						});
					const discovered = discovery?.models.some((model) => model.id === row.id) ?? false;
					return (
						// 行随增删变化，无稳定 id，用序号做 key（局部编辑器，重排场景不存在）
						<article
							// biome-ignore lint/suspicious/noArrayIndexKey: 行编辑器无稳定标识
							key={i}
							aria-label={row.id || t("settings.providers.customModelId")}
							className="rounded-xl bg-surface px-3 py-2 shadow-soft"
						>
							<header className="flex min-w-0 items-center gap-2">
								<span aria-hidden="true" className="w-7 shrink-0 font-mono text-ui-11 text-ink-faint">
									{String(i + 1).padStart(2, "0")}
								</span>
								<ModelIdPicker
									className={modelIdInputClass}
									placeholder={t("settings.providers.customModelId")}
									value={row.id}
									onValue={(value) => setRow(i, { id: value })}
									onPaste={onIdPaste(i)}
									onPick={(model) => onPickModel?.(i, model)}
									candidates={discovery?.models ?? []}
									status={discovery?.status ?? "idle"}
									reason={discovery?.reason}
								/>
								{discovered && (
									<span className="shrink-0 text-ui-11 text-ink-faint">
										{t("settings.providers.customModelAutoSource")}
									</span>
								)}
								<Tooltip label={t("settings.providers.removeModelRow")} align="end">
									<button
										type="button"
										aria-label={t("settings.providers.removeModelRow")}
										className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-hover hover:text-ink-2"
										onClick={() => removeRow(i)}
									>
										<TrashIcon size={13} />
									</button>
								</Tooltip>
							</header>

							<div className="mt-1 grid grid-cols-1 gap-1.5 @lg:grid-cols-2 @lg:gap-3">
								<TokenField
									label={t("settings.providers.presetWindow")}
									tooltip={t("settings.providers.customModelCtx")}
									value={row.contextWindow}
									placeholder="128k"
									presets={WINDOW_PRESETS}
									onValue={(value) => setRow(i, { contextWindow: value })}
								/>
								<TokenField
									label={t("settings.providers.presetOutput")}
									tooltip={t("settings.providers.customModelOut")}
									value={row.maxTokens}
									placeholder="16k"
									presets={OUTPUT_PRESETS}
									onValue={(value) => setRow(i, { maxTokens: value })}
								/>
							</div>

							<div className="fade-rule mt-1" />
							<div className="mt-1 grid grid-cols-12 items-center gap-x-1.5 gap-y-0 rounded-lg bg-hover px-2 py-1">
								<div className="col-span-2 text-ui-11 text-ink-faint">
									{t("settings.providers.presetsAbility")}
								</div>
								<div className="col-span-10 flex min-w-0 items-center gap-3">
									<span className="flex items-center gap-1.5 whitespace-nowrap text-ui-12 text-ink-2">
										<Switch
											compact
											checked={row.reasoning}
											aria-label={t("settings.providers.customModelReasoning")}
											onCheckedChange={(reasoning) => setRow(i, { reasoning })}
										/>
										{t("settings.providers.customModelReasoning")}
									</span>
									<span className="flex items-center gap-1.5 whitespace-nowrap text-ui-12 text-ink-2">
										<Switch
											compact
											checked={row.imageInput}
											aria-label={t("settings.providers.customModelImage")}
											onCheckedChange={(imageInput) => setRow(i, { imageInput })}
										/>
										{t("settings.providers.customModelImage")}
									</span>
								</div>

								{row.reasoning && (
									<>
										<div className="col-span-2 text-ui-11 text-ink-faint">
											{t("settings.providers.thinkingLevels")}
										</div>
										<div className="col-span-10 flex min-w-0 items-center justify-between gap-1">
											<fieldset
												aria-label={t("settings.providers.thinkingLevels")}
												className="flex min-w-0 items-center gap-0"
											>
												<ChoiceChip
													surfaceActive
													active={row.allowThinkingOff}
													label={t("settings.providers.thinkingOff")}
													onClick={() => setRow(i, { allowThinkingOff: !row.allowThinkingOff })}
												/>
												{THINKING_LEVEL_OPTIONS.map((level) => (
													<ChoiceChip
														key={level}
														surfaceActive
														active={levels.includes(level)}
														label={level}
														onClick={() => toggleLevel(level)}
													/>
												))}
											</fieldset>
											{levels.length === 0 && (
												<span className="shrink-0 whitespace-nowrap text-ui-11 text-ink-faint">
													{t("settings.providers.thinkingLevelsEmpty")}
												</span>
											)}
										</div>
									</>
								)}
							</div>
						</article>
					);
				})}
			</div>

			<div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-hover px-2 py-1">
				<div className="flex flex-wrap items-center gap-1">
					<button
						type="button"
						className={`${ghostButtonClass} inline-flex items-center gap-1.5 font-medium text-ink-2`}
						onClick={() => onChange([...rows, { ...EMPTY_MODEL_ROW }])}
					>
						<PlusIcon size={14} />
						{t("settings.providers.addModelRow")}
					</button>
					{rows.some((row) => row.id.trim()) && (
						<button
							type="button"
							className={ghostButtonClass}
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
								className={`${ghostButtonClass} inline-flex items-center gap-1.5 disabled:opacity-40 disabled:hover:bg-transparent`}
								disabled={!canDiscover || discovery.status === "loading"}
								onClick={onDiscover}
							>
								<RefreshIcon size={13} />
								{discovery.status === "loading"
									? t("settings.providers.discovering")
									: t("settings.providers.discoverModels")}
							</button>
						</Tooltip>
					)}
				</div>
				{discovery && (
					<div className="min-w-0 text-right">
						<ModelDiscoveryStatus discovery={discovery} />
					</div>
				)}
			</div>
			{limitNotice && (
				<p className="mt-2 flex flex-wrap items-center gap-2 text-ui-11 leading-relaxed text-ink-faint">
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
							className="rounded-lg px-2 py-1 text-ui-11 text-ink-dim transition-colors hover:bg-hover"
							onClick={onAdoptLimits}
						>
							{t("settings.providers.discoverAdopt")}
						</button>
					)}
				</p>
			)}
			<div className="mt-1 flex items-center justify-end">
				<Tooltip label={t("settings.providers.customModelsDetails")} align="end">
					<button
						type="button"
						aria-label={t("settings.providers.customModelsHelpInfo")}
						className="flex shrink-0 items-center rounded-full text-ink-faint transition-colors hover:text-ink-dim"
					>
						<InfoIcon size={13} />
					</button>
				</Tooltip>
			</div>
			{rows.every((row) => !row.id.trim()) && (
				<p className="mt-2 text-ui-11 leading-relaxed text-ink-dim">
					{t("settings.providers.customModelsEmptyHint")}
				</p>
			)}
		</div>
	);
}
