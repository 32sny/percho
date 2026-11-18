import type { ControlResult, ControlSnapshot, ImageInput, MessageMode, UiError } from "@percho/shared";
import { useEffect, useRef, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import {
	COMPOSER_FOCUS_EVENT,
	isDraftEmpty,
	NEW_SESSION_DRAFT_KEY,
	useDraftStore,
} from "../../stores/drafts";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { pushToast } from "../../stores/toasts";
import { useTranscriptStore } from "../../stores/transcript";
import { type CompactionSendPolicy, resolveCompactionSendPolicy } from "./compaction-gate";
import { buildQuoteBlock } from "./quote";
import { buildSendUiError } from "./send-error";
import { createSendGuard } from "./send-guard";

export interface UseComposerSendOptions {
	activeSessionId: string | null;
	text: string;
	images: ImageInput[];
	attachments: string[];
	quotes: string[];
	slashCommand: string | null;
	followUpQueue: string[];
	/**
	 * 压缩进行中（会话事件态 `transcript.compacting` 的渲染投影）。
	 * 仅作**可见指示/渲染期兜底**：发不发得出去由压缩策略按发送时刻的快照判定，
	 * 不能拿这个旧布尔值一刀切禁发（见 compaction-gate.ts）。
	 */
	compacting: boolean;
	/** 当前模型是否支持图片输入（fail-open：未知按支持）；false 且草稿有图时拦截发送 */
	imagesSupported: boolean;
	/** 发送前会话是否已在运行（排队失败不回滚工作中状态） */
	agentActive: boolean;
	setText: (updater: string | ((prev: string) => string)) => void;
	setImages: (updater: ImageInput[] | ((prev: ImageInput[]) => ImageInput[])) => void;
	setAttachments: (updater: string[] | ((prev: string[]) => string[])) => void;
	setQuotes: (updater: string[] | ((prev: string[]) => string[])) => void;
	setSlashCommand: (command: string | null) => void;
}

/** requestId 生成：新消息即 messageId（= requestId）；同一次传输重试复用（见 pendingTx） */
let requestSeq = 0;
function newRequestId(): string {
	const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
	if (c?.randomUUID) return c.randomUUID();
	requestSeq += 1;
	return `req-${Date.now()}-${requestSeq}`;
}

/** 控制通道是否可用（backend 未就绪时不暴露 → 整体回退 legacy prompt 路径） */
function controlApi() {
	// SAFETY: preload 从 CHANNEL_TABLE 成组生成控制方法；此处仅将旧桥接中可能缺失的方法视为可选。
	const pi = getPi() as unknown as {
		submitMessage?: (req: unknown) => Promise<ControlResult<import("@percho/shared").MessageAck>>;
		getMessageControl?: (req: { sessionId: string }) => Promise<ControlResult<ControlSnapshot>>;
		stopMessageControl?: (
			req: unknown,
		) => Promise<ControlResult<import("@percho/shared").StopMessageControlResult>>;
		changePendingMessage?: (
			req: unknown,
		) => Promise<ControlResult<import("@percho/shared").ChangePendingMessageResult>>;
		recoverPendingMessage?: (
			req: unknown,
		) => Promise<ControlResult<import("@percho/shared").RecoverPendingMessageResult>>;
	};
	if (
		typeof pi.submitMessage !== "function" &&
		typeof pi.getMessageControl !== "function" &&
		typeof pi.stopMessageControl !== "function" &&
		typeof pi.changePendingMessage !== "function" &&
		typeof pi.recoverPendingMessage !== "function"
	)
		return null;
	return pi as Required<typeof pi>;
}

/**
 * 控制 API 是否完整可用：preload 按 `CHANNEL_TABLE` 成组生成，缺任意一个即视为旧 host，
 * 此时无法安全放行 auto 压缩下的提交（fail closed）。
 */
function controlApiComplete(api: ReturnType<typeof controlApi>): boolean {
	return (
		api != null &&
		typeof api.submitMessage === "function" &&
		typeof api.getMessageControl === "function" &&
		typeof api.stopMessageControl === "function" &&
		typeof api.changePendingMessage === "function" &&
		typeof api.recoverPendingMessage === "function"
	);
}

/** 当前会话已采纳的控制快照（无 = 未启用/未加载） */
function currentControl(sessionId: string): ControlSnapshot | null {
	return useTranscriptStore.getState().bySession[sessionId]?.control ?? null;
}

/** 拉取并钉住最新快照（stale 拒绝后的统一刷新点；失败静默，由调用方决定提示） */
async function refreshControl(api: NonNullable<ReturnType<typeof controlApi>>, sessionId: string) {
	try {
		const res = await api.getMessageControl({ sessionId });
		if (res.ok) useTranscriptStore.getState().setControlSnapshot(sessionId, res.value);
	} catch {
		// 通道失败：保持现状，下一次操作再试
	}
}

/**
 * 取回（冻结 → 回填 → 确认出队）按会话的模块级互斥锁。
 *
 * 取回同时要写草稿和改动队列，且要跨多个 await：Composer 重挂载、空态/列表态切换、
 * 分栏多实例都会各自持有一份 hook 实例。用组件 ref 挡不住这些并发，所以锁必须按 session
 * 存在模块级 Map 里；调用方用 try/finally 释放（异常路径也要放开，不能留下永久锁）。
 * 它只覆盖同一个会话，别的会话的发送/取回互不影响（草稿不串台）。
 */
const retrievingSessions = new Map<string, symbol>();

function tryAcquireRetrieveLock(sessionId: string): symbol | null {
	if (retrievingSessions.has(sessionId)) return null;
	const token = Symbol(sessionId);
	retrievingSessions.set(sessionId, token);
	return token;
}

function releaseRetrieveLock(sessionId: string, token: symbol): void {
	if (retrievingSessions.get(sessionId) === token) retrievingSessions.delete(sessionId);
}

/** 该会话是否正在取回（取回期间不允许发送/改派，避免与原实体抢同一份队列容量） */
function isRetrieving(sessionId: string): boolean {
	return retrievingSessions.has(sessionId);
}

/**
 * 发送域：会话确保/建链、发送（queue/steer/interrupt 三态路由 + 斜杠命令分发）、停止、排队项操作。
 * sending/error/feedback 状态也在此（与发送动作同生命周期）。
 */
export function useComposerSend(options: UseComposerSendOptions) {
	const t = useT();
	const [sending, setSending] = useState(false);
	const [error, setErrorState] = useState<UiError | null>(null);
	const [feedback, setFeedback] = useState<{ message: string; tone: "info" | "warn" } | null>(null);
	const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** 发送的同步锁（见 send-guard.ts：state 挡不住 await 窗口里的重复触发） */
	const sendGuard = useRef(createSendGuard());
	/**
	 * 同一次传输的重试身份：失败保住草稿后，内容没变的重试必须复用同一 requestId（幂等），
	 * 不得暗自 generate 新 id 造成同一条消息发两次；内容变了就是新消息（新 id）。
	 */
	const pendingTx = useRef<{ requestId: string; fingerprint: string } | null>(null);
	/**
	 * 渲染期压缩策略：只用于 UI 可用性（发送方式菜单是否禁用）。
	 * 真正的发送门禁在 `handleSend` 里按**发送时刻**的快照重算（见那里的注释）。
	 */
	const compactionPolicy: CompactionSendPolicy = resolveCompactionSendPolicy({
		transcriptCompacting: options.compacting,
		control: options.activeSessionId ? currentControl(options.activeSessionId) : null,
		controlReady: controlApiComplete(controlApi()),
	});

	/** 统一信封：发送失败也走 UiError（内联条 + 与消息流错误卡同语言）；传 null 清除 */
	const setError = (message: string | null) => setErrorState(message ? buildSendUiError(message) : null);

	const showFeedback = (message: string, tone: "info" | "warn" = "info") => {
		setFeedback({ message, tone });
		if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
		feedbackTimer.current = setTimeout(() => setFeedback(null), 2500);
	};

	/** 确保有活跃会话（新会话页则把那唯一一份 draft 转正），返回 sessionId */
	const ensureSession = async (): Promise<string | null> => {
		const current = useSessionsStore.getState().activeSessionId;
		if (current) return current;
		// draft 页：promotion 用 draft 快照建真实会话（模型/思考/权限都从 `newSessionDraft` 取，
		// 调用方不再自己拼 cwd/权限）。无 draft 的防御态（调用顺序异常）先建一份再转正。
		if (!useSessionsStore.getState().newSessionDraft) {
			useSessionsStore.getState().activateNewSessionDraft();
		}
		// 用返回值定位新会话，不读 activeSessionId：创建期间用户可能已切走，
		// 此时新会话仍在后台存在（latest-wins 不让它抢焦点），读 active 会把消息发到别人身上
		return useSessionsStore.getState().createSession();
	};

	/** 执行内置命令（发送以 / 开头文本时的分发；未匹配则透传给 SDK 原生处理模板/skill/扩展命令） */
	const runSlashCommandStatus = async (
		content: string,
		sessionId: string,
	): Promise<"handled" | "failed" | "passthrough"> => {
		const [name, ...rest] = content.slice(1).split(/\s+/);
		const arg = rest.join(" ").trim();
		const pi = getPi();
		switch (name) {
			case "compact":
				await pi.compact({ sessionId, customInstructions: arg || undefined });
				return "handled";
			case "name":
				if (arg) {
					await pi.setSessionName({ sessionId, name: arg });
					showFeedback(t("slash.feedback.renamed", { name: arg }));
					return "handled";
				}
				showFeedback(t("slash.feedback.noName"), "warn");
				return "failed";
			case "export": {
				const format = arg === "html" ? "html" : arg === "jsonl" ? "jsonl" : "jsonl";
				const contentOut = await pi.exportSession({ sessionId, format });
				const path = await pi.saveFileDialog({
					defaultName: `pi-session-${Date.now()}.${format}`,
					content: contentOut,
				});
				showFeedback(path ? t("slash.feedback.exported", { path }) : t("slash.feedback.exportCancelled"));
				return "handled";
			}
			case "settings":
				useSettingsStore.getState().openWith();
				return "handled";
			default:
				// 模板/skill/扩展命令由 SDK 原生处理，原样透传
				return "passthrough";
		}
	};

	const runSlashCommand = async (content: string, sessionId: string): Promise<boolean> =>
		(await runSlashCommandStatus(content, sessionId)) === "handled";

	const samePayload = (
		a: {
			text: string;
			images: ImageInput[];
			attachments: string[];
			quotes: string[];
			slashCommand: string | null;
		},
		b: typeof a,
	) => JSON.stringify(a) === JSON.stringify(b);

	/**
	 * 受理成功后清草稿：只有当前内容仍等于本次发出的快照才清（ACK 等待期间用户新写的内容
	 * 属于下一条草稿，必须原样保留）。dequeue 保护标记不在这里处理。
	 */
	const clearSentDraft = (
		draftKey: string,
		sent: {
			text: string;
			images: ImageInput[];
			attachments: string[];
			quotes: string[];
			slashCommand: string | null;
		},
	) => {
		const current = useDraftStore.getState().bySession[draftKey];
		// 等待旧发送 ACK 时可能取回了另一项，即使内容碰巧相同也不能清掉新取回稿。
		if (current?.recovery) return;
		const currentPayload = {
			text: current?.text ?? "",
			images: current?.images ?? [],
			attachments: current?.attachments ?? [],
			quotes: current?.quotes ?? [],
			slashCommand: current?.slashCommand ?? null,
		};
		if (!samePayload(currentPayload, sent)) return;
		useDraftStore.getState().updateDraft(draftKey, (draft) => ({
			...draft,
			text: "",
			images: [],
			attachments: [],
			quotes: [],
			slashCommand: null,
		}));
		if ((useSessionsStore.getState().activeSessionId ?? NEW_SESSION_DRAFT_KEY) === draftKey) {
			options.setText("");
			options.setImages([]);
			options.setAttachments([]);
			options.setQuotes([]);
			options.setSlashCommand(null);
		}
	};

	interface SentPayload {
		content: string;
		text: string;
		images: ImageInput[];
		attachments: string[];
		quotes: string[];
		imageNames: string[];
		wasActive: boolean;
		mode: MessageMode;
		slashCommand: string | null;
	}

	/**
	 * 真正的一轮发送（同步锁内）。从「确保有会话」到 prompt 落地都可能 await，
	 * 调用方必须先抢 `sendGuard` 再进来（见 handleSend 尾部的注释）。
	 */
	const sendNow = async (sent: SentPayload, draftKey: string): Promise<void> => {
		const { content, text, images, attachments, quotes, mode, slashCommand } = sent;
		let sessionId = options.activeSessionId;
		if (content.startsWith("/") && images.length === 0) {
			sessionId = await ensureSession();
			if (!sessionId) {
				showFeedback(t("slash.feedback.noSession"), "warn");
				return;
			}
			try {
				const result = await runSlashCommandStatus(content, sessionId);
				if (result === "handled") {
					clearSentDraft(draftKey, { text, images, attachments, quotes, slashCommand });
					return;
				}
				if (result === "failed") return;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return;
			}
			// 未匹配的内置命令：落回正常发送（SDK 原生处理模板/技能/扩展命令）
		} else if (!sessionId) {
			// 新会话页（没有 active）：先把 draft 转正成真实会话再发
			sessionId = await ensureSession();
			if (!sessionId) {
				// v10 启动纯空：开机就是新会话页，没选项目目录时 ensureSession 返回 null。
				// 以前这里静默 return（当时启动都带 cwd，现在这是开机第一步，必须给反馈
				showFeedback(t("slash.feedback.noSession"), "warn");
				return;
			}
		}

		setSending(true);
		setError(null);
		// ImageInput.name 仅供输入栏展示，发送到 SDK 前还原为协议字段，避免 UI 元数据进入会话。
		const imageNames = images.map((image) => (image as { name?: string }).name ?? "");

		// 仅完全没有控制 API 的旧 host 可走 legacy queue；其余情况必须 fail closed。
		const api = controlApi();
		if (api && (typeof api.submitMessage !== "function" || typeof api.getMessageControl !== "function")) {
			setSending(false);
			pushToast("warning", "composer.controlActionFailed");
			return;
		}
		if (!api && mode !== "queue") {
			setSending(false);
			pushToast("warning", "composer.controlActionFailed");
			return;
		}
		let runtimeId: string | null = null;
		if (api) {
			const existing = currentControl(sessionId);
			if (existing) {
				runtimeId = existing.runtimeId;
			} else {
				// 首次发送（含 ensureSession 刚建的新会话）：先拉快照钉住 runtime，
				// sendGuard 同步锁覆盖整个 await，不存在双发窗口
				try {
					const res = await api.getMessageControl({ sessionId });
					if (res.ok) {
						useTranscriptStore.getState().setControlSnapshot(sessionId, res.value);
						runtimeId = res.value.runtimeId;
					}
				} catch {
					runtimeId = null;
				}
			}
			if (!runtimeId) {
				setSending(false);
				pushToast("warning", "composer.controlActionFailed");
				return;
			}
		}

		if (api && runtimeId) {
			await sendControlled(api, {
				sessionId,
				draftKey,
				runtimeId,
				sent: { ...sent, images, imageNames },
			});
			return;
		}
		await sendLegacy({
			sessionId,
			draftKey,
			sent: { ...sent, images, imageNames },
		});
	};

	/** legacy 发送路径（backend 控制未就绪）：行为与既有实现一致 */
	const sendLegacy = async ({
		sessionId,
		draftKey,
		sent,
	}: {
		sessionId: string;
		draftKey: string;
		sent: SentPayload;
	}): Promise<void> => {
		const { content, text, images, attachments, quotes, wasActive, slashCommand } = sent;
		// 仅在 store 确认为 idle 时取得本次乐观忙碌状态的所有权。
		const activityToken = useTranscriptStore.getState().beginPromptActivity(sessionId);
		// 乐观回显用户气泡：带图发送时 SDK 在构造用户消息**之前**先做图片归一化
		// （Photon 缩放，全屏截图 ~1s/张，见 docs/PITFALLS.md「附件图片延迟」），
		// 那段时间气泡只能空着等——先本地插一条，权威 message_start 到达时原位认领。
		// 跳过斜杠命令（本地命令可能根本不产生用户消息，气泡会赖着不走）与排队发送
		// （运行中发送走 SDK 队列，QueueBar 已在显式排队，再插气泡就重复了）。
		const optimisticId =
			wasActive || content.startsWith("/")
				? null
				: useTranscriptStore.getState().appendOptimisticUser(sessionId, { text: content, images });
		try {
			const ack = await getPi().prompt({
				sessionId,
				text: content,
				images: images.length > 0 ? images.map(({ data, mimeType }) => ({ data, mimeType })) : undefined,
			});
			const handled = ack?.disposition === "handled";
			clearSentDraft(draftKey, { text, images, attachments, quotes, slashCommand });
			useTranscriptStore.getState().settlePromptActivity(sessionId, activityToken, handled);
			if (handled && optimisticId)
				useTranscriptStore.getState().removeOptimisticUser(sessionId, optimisticId);
		} catch (err) {
			if (optimisticId) useTranscriptStore.getState().removeOptimisticUser(sessionId, optimisticId);
			useTranscriptStore.getState().settlePromptActivity(sessionId, activityToken, true);
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSending(false);
		}
	};

	/**
	 * 托管控制发送路径：三态路由 + requestId 幂等。
	 * 这里**不再携带 recovery 信封**：取回即出队（原实体已在取回时取消排队），
	 * 编辑后的草稿就是普通草稿，发送就是一个新 messageId。
	 */
	const sendControlled = async (
		api: NonNullable<ReturnType<typeof controlApi>>,
		{
			sessionId,
			draftKey,
			runtimeId,
			sent,
		}: {
			sessionId: string;
			draftKey: string;
			runtimeId: string;
			sent: SentPayload;
		},
	): Promise<void> => {
		const { content, text, images, attachments, quotes, wasActive, mode, slashCommand } = sent;
		const wireImages = images.map(({ data, mimeType }) => ({ data, mimeType }));
		const payload = {
			text: content,
			...(wireImages.length > 0 ? { images: wireImages } : {}),
			draft: {
				text,
				attachments,
				quotes,
				slashCommand,
				...(sent.imageNames.some(Boolean) ? { imageNames: sent.imageNames } : {}),
			},
		};
		const requestBase = {
			sessionId,
			runtimeId,
			mode,
			payload,
		};
		// 指纹与提交共用同一份完整 payload，避免同图片数不同内容误复用 requestId。
		const fingerprint = JSON.stringify(requestBase);
		const requestId =
			pendingTx.current?.fingerprint === fingerprint ? pendingTx.current.requestId : newRequestId();
		pendingTx.current = { requestId, fingerprint };

		// 保守忙碌并集：真实事件态（agentActive）与控制快照相位任一忙即忙——两份真源不互相覆盖
		const control = currentControl(sessionId);
		const controlBusy = control != null && control.phase !== "idle";
		const busy = wasActive || controlBusy;
		const activityToken = useTranscriptStore.getState().beginPromptActivity(sessionId);
		// 乐观气泡仅空闲发送（运行中由 QueueBar 显示排队/held 项）；带 controlMessageId 精确认领
		const optimisticId =
			busy || content.startsWith("/") || mode !== "queue"
				? null
				: useTranscriptStore.getState().appendOptimisticUser(sessionId, {
						text: content,
						images: wireImages,
						// 草稿（含取回后编辑的）都是新消息：气泡只等本次 requestId 的 message_start 认领。
						controlMessageId: requestId,
					});
		try {
			const res = await api.submitMessage({ ...requestBase, requestId });
			if (!res.ok) {
				pendingTx.current = null;
				if (optimisticId) useTranscriptStore.getState().removeOptimisticUser(sessionId, optimisticId);
				useTranscriptStore.getState().settlePromptActivity(sessionId, activityToken, true);
				const code = res.error.code;
				if (code === "preflight_failed") {
					// 准备失败与 failed receipt 共用同一纯投影（稳定卡身份 + 精确摘气泡 + 快照同步）。
					// 必须先投影再考虑钉快照：若先 setControlSnapshot，会把响应里的旧 runtime 当权威，
					// 随后失败投影就只能被判 stale，错误卡永远出不来。
					const outcome = res.error.snapshot
						? useTranscriptStore.getState().applyControlSendFailure(sessionId, {
								snapshot: res.error.snapshot,
								// 原请求身份就是本次 requestId（取回后的草稿也是新消息），不生成新 id
								messageId: requestId,
								requestId,
								error: res.error.message,
							})
						: "unmatched";
					// handled/stale 都不再给内联重复提示；stale 只表示响应来自旧状态，
					// 当前快照早已被事件/load 更新为权威，主动刷新只会让迟到的旧响应覆盖新 revision/runtime。
					if (outcome === "unmatched") setError(res.error.message);
					return;
				}
				// 拒绝回执自带最新快照时直接钉住（revision 前进，旧事件不回流）
				if (res.error.snapshot)
					useTranscriptStore.getState().setControlSnapshot(sessionId, res.error.snapshot);
				if (code === "stale_revision" || code === "stale_runtime") {
					// 队列已被外部更新：刷新快照并提示，绝不暗自重发
					await refreshControl(api, sessionId);
					pushToast("warning", "composer.controlStale");
				} else if (code === "queue_full") {
					showFeedback(t("composer.queueFull"), "warn");
				} else if (code === "busy") {
					showFeedback(t("composer.controlBusy"), "warn");
				} else if (code === "compacting") {
					showFeedback(t("composer.compacting"), "warn");
				} else if (code === "command_mode_unsupported") {
					showFeedback(t("composer.slashModeBlocked"), "warn");
				} else {
					setError(res.error.message);
				}
				return;
			}
			// 成功回执后才消费草稿；ACK 期间用户改了内容则保留新输入。
			pendingTx.current = null;
			clearSentDraft(draftKey, { text, images, attachments, quotes, slashCommand });
			const ack = res.value;
			// handled 只表示输入被扩展消费，不能推断全会话空闲（保护 optimisticActivityToken 修复语义）：
			// 仅回滚本次乐观所有权；queued/held 未开工同样回滚；started/interrupting 保持等真实事件。
			const passive =
				ack.disposition === "handled" || ack.disposition === "queued" || ack.disposition === "held";
			useTranscriptStore.getState().settlePromptActivity(sessionId, activityToken, passive);
			if (ack.disposition === "handled" && optimisticId)
				useTranscriptStore.getState().removeOptimisticUser(sessionId, optimisticId);
		} catch (err) {
			if (optimisticId) useTranscriptStore.getState().removeOptimisticUser(sessionId, optimisticId);
			useTranscriptStore.getState().settlePromptActivity(sessionId, activityToken, true);
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			// interrupting 受理即返回：sending 立即释放，不等旧 run 收束（独立停止按钮保持可用）
			setSending(false);
		}
	};

	const handleSend = async (mode: MessageMode = "queue") => {
		const { text, images, attachments, quotes, slashCommand, followUpQueue, agentActive } = options;
		const draftKey = options.activeSessionId ?? NEW_SESSION_DRAFT_KEY;
		// 出队未确认的标记必须先于空草稿 / 压缩等发送门禁处理；即使用户清空了回填内容，
		// 仍须允许通过明确发送操作核对并解除残留保护，否则 QueueBar 消失后会永久卡住。
		const retrieving = options.activeSessionId ? isRetrieving(options.activeSessionId) : false;
		if (retrieving) {
			pushToast("warning", "composer.recoverReleaseRequired");
			return;
		}
		const blockingRecovery = useDraftStore.getState().bySession[draftKey]?.recovery;
		if (blockingRecovery) {
			const released = await recoverPending({ messageId: blockingRecovery.messageId });
			if (released) pushToast("info", "composer.recoverReadyToSend");
			return;
		}
		// 引用胶囊逐条转 blockquote 段落；@ 引用胶囊拼回文本。引用置最前（先给上下文），正文在后
		const quoteBlock = buildQuoteBlock(quotes);
		const atText = attachments.map((p) => `@${p}`).join(" ");
		const body = [atText, text.trim()].filter(Boolean).join("\n");
		const content = [quoteBlock, slashCommand ? `/${slashCommand}${body ? ` ${body}` : ""}` : body]
			.filter(Boolean)
			.join("\n\n");
		// 运行中（streaming）不拦截：prompt 走 followUp 排队；仅防双击重发（sending）
		if ((!content && images.length === 0) || sending) return;
		// 压缩门禁：手动压缩拒绝一切提交（保草稿）；自动压缩且控制通道完整时放行 queue/steer/interrupt。
		// 必须按发送时刻的事件态 + 最新快照重算，不能信任渲染闭包里的旧 compacting（防「渲染后已结束」被卡）。
		const sendSessionId = options.activeSessionId;
		const sendCompaction = resolveCompactionSendPolicy({
			transcriptCompacting: sendSessionId
				? (useTranscriptStore.getState().bySession[sendSessionId]?.compacting ?? false)
				: false,
			control: sendSessionId ? currentControl(sendSessionId) : null,
			controlReady: controlApiComplete(controlApi()),
		});
		if (sendCompaction.blocked) {
			showFeedback(t("composer.compacting"), "warn");
			return;
		}
		// 图片门控：草稿残留图 + 当前模型不支持（如多模态切纯文本后）→ toast 提醒不发送，保住草稿
		if (images.length > 0 && !options.imagesSupported) {
			pushToast("warning", "composer.imageUnsupported");
			return;
		}
		// slash 命令仅走普通路径：steer/interrupt 会把扩展命令当用户插话造成同时执行，先停再发
		if (mode !== "queue" && content.startsWith("/")) {
			showFeedback(t("composer.slashModeBlocked"), "warn");
			return;
		}
		// 单条排队上限（legacy 路径的客户端预拦截）：控制路径容量以后端权威错误为准，
		// 且 steer/interrupt 不受旧 followUp 上限妨碍
		if (!controlApi() && followUpQueue.length >= 1 && !content.startsWith("/")) {
			showFeedback(t("composer.queueFull"), "warn");
			return;
		}
		// 同步锁：`sending` 下一帧才生效，挡不住「draft 页要先 await 转正」这个窗口里的第二次触发
		// （两次 Enter 会共享同一次 createSession，然后各自 prompt 一遍 = 同一句话发两次）
		if (!sendGuard.current.tryAcquire()) return;
		const sent: SentPayload = {
			content,
			text,
			images: images.map((image) => ({ ...image })),
			attachments: [...attachments],
			quotes: [...quotes],
			slashCommand,
			imageNames: images.map((image) => (image as { name?: string }).name ?? ""),
			wasActive: agentActive,
			mode,
		};
		try {
			await sendNow(sent, draftKey);
		} finally {
			sendGuard.current.release();
		}
	};

	/** 停止：控制路径走 stopMessageControl（held 项保留在快照里，由用户取回/重发/放弃）；
	 *  无控制快照时回退 legacy（先清排队还原草稿，再中止） */
	const handleStop = async () => {
		const { activeSessionId, setText } = options;
		if (!activeSessionId) return;
		const api = controlApi();
		if (api) {
			try {
				let control = currentControl(activeSessionId);
				if (!control && typeof api.getMessageControl === "function") {
					const snapshot = await api.getMessageControl({ sessionId: activeSessionId });
					if (snapshot.ok) {
						control = snapshot.value;
						useTranscriptStore.getState().setControlSnapshot(activeSessionId, snapshot.value);
					}
				}
				if (!control || typeof api.stopMessageControl !== "function") throw new Error("Control unavailable");
				const res = await api.stopMessageControl({
					sessionId: activeSessionId,
					runtimeId: control.runtimeId,
					requestId: newRequestId(),
				});
				if (res.ok) {
					useTranscriptStore.getState().setControlSnapshot(activeSessionId, res.value.snapshot);
					return;
				}
			} catch {
				// 控制 API 存在时失败必须保留 held 关联，不回退清队列。
			}
			pushToast("warning", "composer.controlActionFailed");
			return;
		}
		useTranscriptStore.getState().setFollowUpQueue(activeSessionId, []); // 乐观清面板
		const cleared = await getPi().clearQueue({ sessionId: activeSessionId });
		if (cleared.followUp.length > 0) {
			const restored = cleared.followUp.join("\n");
			setText((prev) => (prev ? `${prev}\n${restored}` : restored));
		}
		await getPi().abort({ sessionId: activeSessionId });
	};

	/** 取回排队消息（legacy 路径）：清队列（SDK 侧 queue_update 随后对齐），内容放回输入框继续编辑 */
	const handleRestoreQueue = async (focus: () => void) => {
		const { activeSessionId, setText } = options;
		if (!activeSessionId) return;
		useTranscriptStore.getState().setFollowUpQueue(activeSessionId, []); // 乐观清面板
		const cleared = await getPi().clearQueue({ sessionId: activeSessionId });
		const restored = cleared.followUp[0];
		if (restored) setText((prev) => (prev ? `${prev}\n${restored}` : restored));
		requestAnimationFrame(focus);
	};

	/**
	 * 队列项操作（steer/interrupt/resend/discard）：带 SDK runtime + revision 的 CAS；
	 * 拒绝刷新快照并反馈。取回在途时直接忽略，避免与「冻结→出队」抢同一个实体。
	 */
	const changePending = async (
		item: { messageId: string; preview?: string },
		action: "steer" | "interrupt" | "resend" | "discard",
	): Promise<boolean> => {
		const { activeSessionId } = options;
		if (!activeSessionId || isRetrieving(activeSessionId)) return false;
		const api = controlApi();
		const control = currentControl(activeSessionId);
		if (!api || !control || typeof api.changePendingMessage !== "function") {
			pushToast("warning", "composer.controlActionFailed");
			return false;
		}
		try {
			const res = await api.changePendingMessage({
				sessionId: activeSessionId,
				runtimeId: control.runtimeId,
				requestId: newRequestId(),
				messageId: item.messageId,
				expectedRevision: control.revision,
				action,
			});
			if (res.ok) {
				useTranscriptStore.getState().setControlSnapshot(activeSessionId, res.value.snapshot);
				if (action === "discard") {
					// 后端确认取消排队后才释放该实体的保护关联；用户新写的内容、图片等仍归输入框所有。
					// 只清指向本实体（item.messageId）的标记，不影响其他草稿。
					useDraftStore
						.getState()
						.updateDraft(activeSessionId, (draft) =>
							draft.recovery?.messageId === item.messageId ? { ...draft, recovery: undefined } : draft,
						);
				}
				return true;
			}
			if (res.error.snapshot)
				useTranscriptStore.getState().setControlSnapshot(activeSessionId, res.error.snapshot);
			if (res.error.code === "stale_revision" || res.error.code === "stale_runtime") {
				await refreshControl(api, activeSessionId);
				pushToast("warning", "composer.controlStale");
			} else {
				pushToast("warning", "composer.controlActionFailed");
			}
			return false;
		} catch {
			pushToast("warning", "composer.controlActionFailed");
			return false;
		}
	};

	/**
	 * 取回 = 冻结原项 → 同步回填完整载荷 → 确认取消排队（出队），成功后只留下普通草稿。
	 *
	 * `recovery` 字段只剩「出队尚未确认」的保护标记作用（含旧版本草稿兼容）：它不再用来
	 * 提交旧实体——出队成功后标记即清，草稿就是普通草稿，重发走新 messageId。
	 */
	const recoverPending = async (item: { messageId: string; preview?: string }): Promise<boolean> => {
		const { activeSessionId } = options;
		if (!activeSessionId) return false;
		const draftKey = activeSessionId;
		const api = controlApi();
		if (
			!api ||
			typeof api.recoverPendingMessage !== "function" ||
			typeof api.changePendingMessage !== "function" ||
			typeof api.getMessageControl !== "function"
		) {
			pushToast("warning", "composer.controlActionFailed");
			return false;
		}
		const token = tryAcquireRetrieveLock(draftKey);
		// 已在取回中（重复点击 / 另一实例 / 重挂载）：不再发第二次请求，也不动草稿
		if (!token) return false;
		let runtimeId: string | null = null;
		let messageId = item.messageId;
		/**
		 * 本次取回是否已经把完整载荷安全落在草稿里（或确认改动内容本就属于同项且未被覆盖）。
		 * 「队列里没有这个实体」本身**不等于**取回成功：首次取回失败/异常时 items 也可能空，
		 * 那只是原项去向未知，任何 finish 分支都必须先有这份证据。
		 */
		let draftSecured = false;
		/** 出队确认后的收尾：只清指向本实体的保护标记，绝不改用户内容 */
		const finish = () => {
			useDraftStore
				.getState()
				.updateDraft(draftKey, (draft) =>
					draft.recovery?.messageId === messageId ? { ...draft, recovery: undefined } : draft,
				);
			// 仅在用户仍停留在这个会话时才抢焦点（切走后的取回不该把人拽回去）
			if (useSessionsStore.getState().activeSessionId === activeSessionId && typeof window !== "undefined") {
				window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT));
			}
		};
		/**
		 * 权威核对：只有当前快照（必要时要求同 runtime）里确实没有这个实体，才能判断它已经不
		 * 在待发集合里。绝不凭失败回执或旧快照假装成功。
		 */
		const itemGone = async (id: string, expectedRuntimeId?: string | null): Promise<boolean> => {
			try {
				const res = await api.getMessageControl({ sessionId: activeSessionId });
				if (!res.ok) return false;
				useTranscriptStore.getState().setControlSnapshot(activeSessionId, res.value);
				if (expectedRuntimeId && res.value.runtimeId !== expectedRuntimeId) return false;
				return !res.value.items.some((entry) => entry.messageId === id);
			} catch {
				return false;
			}
		};
		try {
			const existing = useDraftStore.getState().bySession[draftKey];
			// 兼容「同一实体上次取回未完成」的保护标记：允许明确再次取回，只补完出队，保留用户修改
			const editingSame = existing?.recovery?.messageId === item.messageId;
			if (!editingSame && existing?.recovery) {
				// 别的实体还挂着保护标记：草稿有内容就先按冲突拒绝（不发请求，不覆盖内容）
				if (!isDraftEmpty(existing)) {
					pushToast("warning", "composer.recoverDraftConflict");
					return false;
				}
				// 草稿本身是空的：标记可能指着一个早就不在队列里的实体（旧版本残留/已被受理）。
				// 权威快照确认它确实不在时才清掉，否则旧标记会把整份草稿永久锁死。
				if (!(await itemGone(existing.recovery.messageId))) {
					pushToast("warning", "composer.recoverDraftConflict");
					return false;
				}
				useDraftStore
					.getState()
					.updateDraft(draftKey, (draft) =>
						draft.recovery?.messageId === existing.recovery?.messageId
							? { ...draft, recovery: undefined }
							: draft,
					);
			}
			// 取回会占用输入框：正文/图片/附件/引用/slash 任一有内容都拒绝，且不发任何请求
			const claimed = useDraftStore.getState().bySession[draftKey];
			if (!editingSame && claimed && !isDraftEmpty(claimed)) {
				pushToast("warning", "composer.recoverDraftConflict");
				return false;
			}
			let control = currentControl(activeSessionId);
			if (!control) {
				// 重载后本地无快照（recovering 项仍在 items 里，取回入口可用）：先取权威快照
				const fresh = await api.getMessageControl({ sessionId: activeSessionId });
				if (fresh.ok) control = fresh.value;
			}
			if (!control) {
				pushToast("warning", "composer.controlActionFailed");
				return false;
			}
			runtimeId = control.runtimeId;
			// 冻结：SDK 侧立刻摘出实体并回传完整载荷，此后它不会再被派发
			const recovered = await api.recoverPendingMessage({
				sessionId: activeSessionId,
				runtimeId,
				requestId: newRequestId(),
				messageId: item.messageId,
				expectedRevision: control.revision,
			});
			// 等待期间草稿会被别处改写（用户清空、切换会话、另一实例取回）：必须重新读标记，
			// 不能拿 await 之前的快照当依据去补标记/出队。
			const afterRecover = useDraftStore.getState().bySession[draftKey];
			if (editingSame) {
				// 同一实体上次已回填过完整载荷：只要标记还在同一项，内容就是安全的
				if (afterRecover?.recovery?.messageId !== item.messageId) {
					// 标记已消失或换成另一个实体：不补标记、不出队、不覆盖内容
					pushToast("warning", "composer.controlActionFailed");
					return false;
				}
				draftSecured = true;
			}
			if (!recovered.ok) {
				if (recovered.error.snapshot)
					useTranscriptStore.getState().setControlSnapshot(activeSessionId, recovered.error.snapshot);
				if (recovered.error.code === "stale_revision" || recovered.error.code === "stale_runtime") {
					// 版本变了：草稿与标记都保留，刷新最新快照，用户再点一次即可用最新版本重试
					await refreshControl(api, activeSessionId);
					pushToast("warning", "composer.controlStale");
					return false;
				}
				if (recovered.error.code === "already_committed" || recovered.error.code === "not_found") {
					// 原项已不在待发集合：但「不在队列」不等于「内容已取回」。首次取回就走到这儿时
					// 从来没回填过载荷，不得因 items 为空就报成功；只有 draftSecured（标记同项已确认
					// 稳妥保留着内容）才允许权威核对后解除保护标记。
					if (!draftSecured) {
						// 原项去向未知且内容没回填过：提示「可能还在队列」并保留一切，等用户重试
						pushToast("warning", "composer.recoverReleaseRequired");
						return false;
					}
					if (await itemGone(messageId, runtimeId)) {
						finish();
						return true;
					}
					pushToast("warning", "composer.recoverReleaseRequired");
					return false;
				}
				pushToast("warning", "composer.controlActionFailed");
				return false;
			}
			useTranscriptStore.getState().setControlSnapshot(activeSessionId, recovered.value.snapshot);
			messageId = recovered.value.messageId;
			const { snapshot, payload } = recovered.value;
			if (editingSame) {
				// 已取回过：只把标记对齐到最新版本，绝不覆盖用户的修改
				useDraftStore.getState().updateDraft(draftKey, (draft) => ({
					...draft,
					recovery: { messageId, expectedRevision: snapshot.revision },
				}));
			} else {
				const latest = useDraftStore.getState().bySession[draftKey];
				if (latest?.recovery || (latest && !isDraftEmpty(latest))) {
					// 冻结等待期间草稿有了内容或挂了指向别的实体的标记：保现有草稿 + 保冻结项，
					// 不 discard、不覆盖（下次点击再补完）
					pushToast("warning", "composer.recoverDraftConflict");
					return false;
				}
				// 同步回填完整载荷（正文/图片/附件/引用/slash），并挂上临时保护标记直到出队确认
				useDraftStore.getState().updateDraft(draftKey, () => ({
					text: payload.draft?.text ?? payload.text,
					images: (payload.images ?? []).map((img, index) => ({
						...img,
						...(payload.draft?.imageNames?.[index] ? { name: payload.draft.imageNames[index] } : {}),
					})),
					slashCommand: payload.draft?.slashCommand ?? null,
					attachments: payload.draft?.attachments ?? [],
					quotes: payload.draft?.quotes ?? [],
					recovery: { messageId, expectedRevision: snapshot.revision },
				}));
			}
			// 到这里内容已安全落位（完整回填，或同项标记确认后的用户改动），出队只剩删队列
			draftSecured = true;
			// 确认出队：用取回快照的 runtime + revision 做 CAS，真正把原项从队列删掉
			const discarded = await api.changePendingMessage({
				sessionId: activeSessionId,
				runtimeId: snapshot.runtimeId,
				requestId: newRequestId(),
				messageId,
				expectedRevision: snapshot.revision,
				action: "discard",
			});
			if (discarded.ok) {
				useTranscriptStore.getState().setControlSnapshot(activeSessionId, discarded.value.snapshot);
				finish();
				return true;
			}
			if (discarded.error.snapshot)
				useTranscriptStore.getState().setControlSnapshot(activeSessionId, discarded.error.snapshot);
			if (discarded.error.code === "stale_revision" || discarded.error.code === "stale_runtime") {
				await refreshControl(api, activeSessionId);
				pushToast("warning", "composer.controlStale");
				return false;
			}
			// 其余拒绝可能是「其实已出队、回执丢了」：用权威快照核对，否则保留标记等用户重试
			if (draftSecured && (await itemGone(messageId, snapshot.runtimeId))) {
				finish();
				return true;
			}
			pushToast("warning", "composer.retrieveIncomplete");
			return false;
		} catch {
			// 传输异常（含 discard 已执行但响应丢失）：草稿与标记都保留，只有「本次已把载荷安全
			// 落在草稿里」且「冻结/出队发生在同一 runtime」且权威快照确认原项不在时才算成功；
			// 首次取回就异常（draftSecured=false）时 items 为空也不能算取回完成。
			if (runtimeId && draftSecured && (await itemGone(messageId, runtimeId))) {
				finish();
				return true;
			}
			pushToast("warning", "composer.controlActionFailed");
			return false;
		} finally {
			releaseRetrieveLock(draftKey, token);
		}
	};

	// 卸载时清反馈计时器，防 setState on unmounted
	useEffect(() => {
		return () => {
			if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
		};
	}, []);

	return {
		sending,
		error,
		setError,
		feedback,
		showFeedback,
		/** 渲染期压缩策略（发送门禁与 UI 菜单共用同一规则，真源见 compaction-gate.ts） */
		compactionPolicy,
		ensureSession,
		runSlashCommand,
		handleSend,
		handleStop,
		handleRestoreQueue,
		changePending,
		recoverPending,
	};
}

export { NEW_SESSION_DRAFT_KEY };
