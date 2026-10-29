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
	/** 压缩进行中（禁发：SDK 拒绝压缩中的 prompt） */
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

	const clearSentDraft = (
		draftKey: string,
		sent: {
			text: string;
			images: ImageInput[];
			attachments: string[];
			quotes: string[];
			slashCommand: string | null;
		},
		recovery?: { messageId: string; expectedRevision: number },
	) => {
		const current = useDraftStore.getState().bySession[draftKey];
		if (
			current?.recovery?.messageId !== recovery?.messageId ||
			current?.recovery?.expectedRevision !== recovery?.expectedRevision
		)
			return;
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
			...(recovery &&
			draft.recovery?.messageId === recovery.messageId &&
			draft.recovery.expectedRevision === recovery.expectedRevision
				? { recovery: undefined }
				: {}),
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
		recovery?: { messageId: string; expectedRevision: number };
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
		const { content, text, images, attachments, quotes, wasActive, slashCommand, recovery } = sent;
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
			clearSentDraft(draftKey, { text, images, attachments, quotes, slashCommand }, recovery);
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

	/** 托管控制发送路径：三态路由 + requestId 幂等 + recovery 编辑重发 */
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
		const { content, text, images, attachments, quotes, wasActive, mode, slashCommand, recovery } = sent;
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
			...(recovery ? { recovery } : {}),
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
						controlMessageId: requestId,
					});
		try {
			const res = await api.submitMessage({ ...requestBase, requestId });
			if (!res.ok) {
				pendingTx.current = null;
				if (optimisticId) useTranscriptStore.getState().removeOptimisticUser(sessionId, optimisticId);
				useTranscriptStore.getState().settlePromptActivity(sessionId, activityToken, true);
				// 拒绝回执自带最新快照时直接钉住（revision 前进，旧事件不回流）
				if (res.error.snapshot)
					useTranscriptStore.getState().setControlSnapshot(sessionId, res.error.snapshot);
				const code = res.error.code;
				if (code === "stale_revision" || code === "stale_runtime") {
					// 恢复实体已被外部更新：刷新快照并提示，绝不暗自重发
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
			// 成功回执后才消费草稿；与快照不一致时保留用户编辑及 recovery 关联。
			pendingTx.current = null;
			clearSentDraft(draftKey, { text, images, attachments, quotes, slashCommand }, recovery);
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
		const { text, images, attachments, quotes, slashCommand, followUpQueue, compacting, agentActive } =
			options;
		// 引用胶囊逐条转 blockquote 段落；@ 引用胶囊拼回文本。引用置最前（先给上下文），正文在后
		const quoteBlock = buildQuoteBlock(quotes);
		const atText = attachments.map((p) => `@${p}`).join(" ");
		const body = [atText, text.trim()].filter(Boolean).join("\n");
		const content = [quoteBlock, slashCommand ? `/${slashCommand}${body ? ` ${body}` : ""}` : body]
			.filter(Boolean)
			.join("\n\n");
		// 运行中（streaming）不拦截：prompt 走 followUp 排队；仅防双击重发（sending）
		if ((!content && images.length === 0) || sending) return;
		// 压缩中禁发：SDK 拒绝压缩中的 prompt，提前拦截保住草稿
		if (compacting) {
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
		const draftKey = options.activeSessionId ?? NEW_SESSION_DRAFT_KEY;
		const sent: SentPayload = {
			content,
			text,
			images: images.map((image) => ({ ...image })),
			attachments: [...attachments],
			quotes: [...quotes],
			slashCommand,
			recovery: useDraftStore.getState().bySession[draftKey]?.recovery,
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

	/** 队列项操作（steer/interrupt/resend/discard）：带 SDK revision 的 CAS；拒绝刷新快照并反馈 */
	const changePending = async (
		item: { messageId: string; preview?: string },
		action: "steer" | "interrupt" | "resend" | "discard",
	): Promise<boolean> => {
		const { activeSessionId } = options;
		if (!activeSessionId) return false;
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
	 * 取回（recover）：冻结实体换完整载荷写回本会话草稿（文本/图片/附件/引用/slash 原样恢复），
	 * 草稿携带 recovery 元数据，重发时更新 SDK 原实体（受理成功才替换）。
	 * 有未保存草稿时拒绝覆盖——避免「队列已删、草稿没到」的双失与静默合并。
	 */
	const recoverPending = async (item: { messageId: string; preview?: string }): Promise<boolean> => {
		const { activeSessionId } = options;
		if (!activeSessionId) return false;
		const draftKey = activeSessionId;
		const existing = useDraftStore.getState().bySession[draftKey];
		if (existing && !isDraftEmpty(existing)) {
			pushToast("warning", "composer.recoverDraftConflict");
			return false;
		}
		const api = controlApi();
		const control = currentControl(activeSessionId);
		if (!api || !control || typeof api.recoverPendingMessage !== "function") {
			pushToast("warning", "composer.controlActionFailed");
			return false;
		}
		try {
			const res = await api.recoverPendingMessage({
				sessionId: activeSessionId,
				runtimeId: control.runtimeId,
				requestId: newRequestId(),
				messageId: item.messageId,
				expectedRevision: control.revision,
			});
			if (!res.ok) {
				if (res.error.snapshot)
					useTranscriptStore.getState().setControlSnapshot(activeSessionId, res.error.snapshot);
				if (res.error.code === "stale_revision" || res.error.code === "stale_runtime") {
					await refreshControl(api, activeSessionId);
					pushToast("warning", "composer.controlStale");
				} else {
					pushToast("warning", "composer.controlActionFailed");
				}
				return false;
			}
			useTranscriptStore.getState().setControlSnapshot(activeSessionId, res.value.snapshot);
			const latestDraft = useDraftStore.getState().bySession[draftKey];
			if (latestDraft && !isDraftEmpty(latestDraft)) {
				pushToast("warning", "composer.recoverDraftConflict");
				return false;
			}
			const { payload } = res.value;
			useDraftStore.getState().updateDraft(draftKey, () => ({
				text: payload.draft?.text ?? payload.text,
				images: (payload.images ?? []).map((img, index) => ({
					...img,
					...(payload.draft?.imageNames?.[index] ? { name: payload.draft.imageNames[index] } : {}),
				})),
				slashCommand: payload.draft?.slashCommand ?? null,
				attachments: payload.draft?.attachments ?? [],
				quotes: payload.draft?.quotes ?? [],
				recovery: { messageId: res.value.messageId, expectedRevision: res.value.snapshot.revision },
			}));
			if (typeof window !== "undefined") {
				window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT));
			}
			return true;
		} catch {
			pushToast("warning", "composer.controlActionFailed");
			return false;
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
