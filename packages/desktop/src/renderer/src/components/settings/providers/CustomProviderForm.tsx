import { type CustomProviderInput, KNOWN_APIS, type ProviderInfo } from "@percho/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getPi } from "../../../api";
import { useT } from "../../../i18n";
import { useSettingsStore } from "../../../stores/settings";
import { Tooltip } from "../../ui/Tooltip";
import { EMPTY_DISCOVERY, type ModelDiscoveryState } from "./ModelIdPicker";
import { ModelRowsEditor } from "./ModelRowsEditor";
import {
	adoptDiscoveredLimits,
	applyDiscoveredModel,
	type DiscoveredLimitNotice,
	EMPTY_MODEL_ROW,
	type ModelRow,
	modelsToRows,
	rowsToModelInputs,
	rowsValid,
} from "./model-rows";

interface ProviderFormState {
	id: string;
	name: string;
	baseUrl: string;
	api: string;
	/** 逐模型行（id/上下文/输出/思考/图像），提交时经 rowsToModelInputs 转换 */
	models: ModelRow[];
	apiKey: string;
}

const EMPTY_FORM: ProviderFormState = {
	id: "",
	name: "",
	baseUrl: "",
	api: "openai-completions",
	models: [{ ...EMPTY_MODEL_ROW }],
	apiKey: "",
};

function toInput(form: ProviderFormState): CustomProviderInput {
	return {
		id: form.id,
		name: form.name || undefined,
		baseUrl: form.baseUrl,
		api: form.api,
		models: rowsToModelInputs(form.models),
		apiKey: form.apiKey || undefined,
	};
}

const inputClass =
	"w-full rounded-lg border border-border px-2.5 py-1.5 text-ui-12 outline-none focus:border-ink-faint disabled:cursor-not-allowed disabled:text-ink-faint";

/** 自定义 provider 配置表单（添加/编辑共用）：id/baseUrl/api/模型列表/Key。根节点无外边距，由调用方控制间距 */
function ProviderConfigForm({
	title,
	initial,
	lockId,
	providerId,
	onSubmit,
	onCancel,
}: {
	title: string;
	initial: ProviderFormState;
	/** 编辑模式锁定 ID：它是 models.json/auth.json/会话模型引用的主键，不可改 */
	lockId?: boolean;
	/** 编辑模式的 provider ID：发现时用它读取已存凭证（新填 key 优先） */
	providerId?: string;
	onSubmit: (form: ProviderFormState) => Promise<void>;
	onCancel: () => void;
}) {
	const t = useT();
	const [form, setForm] = useState(initial);
	const [submitting, setSubmitting] = useState(false);
	const [discovery, setDiscovery] = useState<ModelDiscoveryState>(EMPTY_DISCOVERY);
	/** 刚选中但没能自动填上限的那一行（冲突/矛盾时给原因与一键采用） */
	const [limitNotice, setLimitNotice] = useState<{
		rowIndex: number;
		modelId: string;
		notice: DiscoveredLimitNotice;
	} | null>(null);
	/** 进行中的发现请求 ID：改写地址/重取/卸载时用旧 ID 发取消，并通过比对丢弃过期结果 */
	const requestRef = useRef<string | null>(null);

	const cancelDiscovery = useCallback(() => {
		const requestId = requestRef.current;
		requestRef.current = null;
		if (requestId) void getPi().cancelProviderModelDiscovery({ requestId });
	}, []);

	// baseUrl/api 变了旧清单即作废（Plan 要求：旧请求不得覆盖新表单）
	const discoveryKey = `${form.baseUrl.trim()}\u0000${form.api.trim()}`;
	const lastKeyRef = useRef(discoveryKey);
	useEffect(() => {
		if (lastKeyRef.current === discoveryKey) return;
		lastKeyRef.current = discoveryKey;
		cancelDiscovery();
		setDiscovery(EMPTY_DISCOVERY);
		setLimitNotice(null);
	}, [discoveryKey, cancelDiscovery]);

	// 卸载/收起时取消在途请求，避免后台白跑
	useEffect(() => cancelDiscovery, [cancelDiscovery]);

	const canDiscover = form.baseUrl.trim().length > 0 && form.api.trim().length > 0;

	const discover = async () => {
		if (!canDiscover) return;
		cancelDiscovery();
		const requestId = crypto.randomUUID();
		requestRef.current = requestId;
		setDiscovery({ status: "loading", models: [] });
		setLimitNotice(null);
		try {
			const result = await getPi().discoverProviderModels({
				requestId,
				providerId,
				baseUrl: form.baseUrl.trim(),
				api: form.api.trim(),
				apiKey: form.apiKey.trim() || undefined,
			});
			if (requestRef.current !== requestId) return;
			requestRef.current = null;
			setDiscovery(
				result.ok
					? { status: "ready", models: result.models, path: result.path, tried: result.tried }
					: { status: "error", models: [], reason: result.reason, tried: result.tried },
			);
		} catch {
			if (requestRef.current !== requestId) return;
			requestRef.current = null;
			setDiscovery({ status: "error", models: [], reason: "network" });
		}
	};

	const pickModel = (index: number, model: Parameters<typeof applyDiscoveredModel>[1]) => {
		const picked = applyDiscoveredModel(form.models[index] ?? { ...EMPTY_MODEL_ROW }, model);
		setForm((f) => ({
			...f,
			models: f.models.map((row, i) => (i === index ? picked.row : row)),
		}));
		// 自相矛盾/多值冲突的上限不自动填，提示原因并给一键采用
		setLimitNotice(picked.notice ? { rowIndex: index, modelId: model.id, notice: picked.notice } : null);
	};

	const adoptLimits = () => {
		if (!limitNotice) return;
		const { rowIndex, notice } = limitNotice;
		setForm((f) => ({
			...f,
			models: f.models.map((row, i) => (i === rowIndex ? adoptDiscoveredLimits(row, notice) : row)),
		}));
		setLimitNotice(null);
	};

	const set = (field: keyof ProviderFormState) => (e: { target: { value: string } }) =>
		setForm((f) => ({ ...f, [field]: e.target.value }));

	const submit = async () => {
		setSubmitting(true);
		try {
			await onSubmit(form);
		} catch {
			// 错误已写入 store.error，表单保持打开
		} finally {
			setSubmitting(false);
		}
	};

	// models.json 里的 api 理论上必是 KnownApiId；防御性兜底，不在表内也照常显示当前值
	const apiOptions = (KNOWN_APIS as readonly string[]).includes(form.api)
		? KNOWN_APIS
		: [form.api, ...KNOWN_APIS];

	const idInput = (
		<input
			className={inputClass}
			placeholder={t("settings.providers.customId")}
			value={form.id}
			onChange={set("id")}
			disabled={lockId}
		/>
	);

	return (
		<div className="rounded-xl border border-border p-3">
			<h3 className="text-ui-13 font-medium text-ink">{title}</h3>
			<div className="mt-2 grid grid-cols-2 gap-2">
				{lockId ? (
					<Tooltip label={t("settings.providers.customIdLocked")} className="w-full">
						{idInput}
					</Tooltip>
				) : (
					idInput
				)}
				<input
					className={inputClass}
					placeholder={t("settings.providers.customName")}
					value={form.name}
					onChange={set("name")}
				/>
				<input
					className={`${inputClass} col-span-2`}
					placeholder={t("settings.providers.customBaseUrl")}
					value={form.baseUrl}
					onChange={set("baseUrl")}
				/>
				<select className={inputClass} value={form.api} onChange={set("api")}>
					{apiOptions.map((api) => (
						<option key={api} value={api}>
							{api}
						</option>
					))}
				</select>
				<input
					className={inputClass}
					placeholder={lockId ? t("settings.providers.customKeyKeep") : t("settings.providers.customKey")}
					type="password"
					value={form.apiKey}
					onChange={set("apiKey")}
				/>
				<ModelRowsEditor
					rows={form.models}
					onChange={(models) => setForm((f) => ({ ...f, models }))}
					discovery={discovery}
					canDiscover={canDiscover}
					onDiscover={() => void discover()}
					onPickModel={pickModel}
					limitNotice={limitNotice && { modelId: limitNotice.modelId, notice: limitNotice.notice }}
					onAdoptLimits={adoptLimits}
				/>
			</div>
			<div className="mt-2 flex justify-end gap-2">
				<button
					type="button"
					className="rounded-lg px-3 py-1.5 text-ui-12 text-ink-dim transition-colors hover:bg-hover"
					onClick={onCancel}
				>
					{t("common.cancel")}
				</button>
				<button
					type="button"
					className="rounded-lg bg-ink px-3 py-1.5 text-ui-12 font-medium text-on-ink transition-colors hover:bg-ink-2 disabled:opacity-40"
					onClick={() => void submit()}
					disabled={submitting || !form.id.trim() || !form.baseUrl.trim() || !rowsValid(form.models)}
				>
					{submitting ? t("settings.providers.submitting") : t("common.save")}
				</button>
			</div>
		</div>
	);
}

/** 添加自定义 provider：折叠按钮 + 展开表单（取消/保存后收起即重置） */
export function CustomProviderForm() {
	const t = useT();
	const addCustom = useSettingsStore((s) => s.addCustom);
	const [show, setShow] = useState(false);

	if (!show) {
		return (
			<button
				type="button"
				className="mt-3 w-full rounded-lg border border-dashed border-border py-2 text-ui-13 text-ink-dim transition-colors hover:border-border-strong hover:bg-hover"
				onClick={() => setShow(true)}
			>
				{t("settings.providers.addCustom")}
			</button>
		);
	}

	return (
		<div className="mt-3">
			<ProviderConfigForm
				title={t("settings.providers.customTitle")}
				initial={EMPTY_FORM}
				onSubmit={async (form) => {
					await addCustom(toInput(form));
					setShow(false);
				}}
				onCancel={() => setShow(false)}
			/>
		</div>
	);
}

/** 编辑已添加的自定义 provider（ProviderRow 行内展开）：全字段可改，ID 锁定，Key 留空保持不变 */
export function CustomProviderEditForm({ provider, onDone }: { provider: ProviderInfo; onDone: () => void }) {
	const t = useT();
	const updateCustom = useSettingsStore((s) => s.updateCustom);

	return (
		<ProviderConfigForm
			title={t("settings.providers.editCustomTitle")}
			initial={{
				...EMPTY_FORM,
				id: provider.id,
				// ProviderInfo.name 缺省回落为 id；无显示名时保持空，让 placeholder 生效
				name: provider.name !== provider.id ? provider.name : "",
				baseUrl: provider.baseUrl ?? "",
				api: provider.api ?? "openai-completions",
				// 只预填已落盘的自定义模型定义（避免把 runtime 全量内置模型写回 models.json）
				models: modelsToRows(provider.customModels ?? []),
			}}
			lockId
			providerId={provider.id}
			onSubmit={async (form) => {
				await updateCustom(toInput(form));
				onDone();
			}}
			onCancel={onDone}
		/>
	);
}
