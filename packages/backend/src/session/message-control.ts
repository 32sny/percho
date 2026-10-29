import type {
	ChangePendingMessageRequest,
	ChangePendingMessageResult,
	ControlResult,
	ControlSnapshot,
	MessageAck,
	MessagePayload,
	MessageSubmitRequest,
	PendingMessageRequest,
	RecoverPendingMessageResult,
	StopMessageControlResult,
} from "@percho/shared";

export interface MessageControlHandle {
	submit(
		request: MessageSubmitRequest,
		source?: "user" | "extension" | "system",
	): Promise<ControlResult<MessageAck>>;
	getSnapshot(): ControlSnapshot;
	changePending(request: ChangePendingMessageRequest): Promise<ControlResult<ChangePendingMessageResult>>;
	recover(request: PendingMessageRequest): ControlResult<RecoverPendingMessageResult>;
	stop(request: {
		sessionId: string;
		runtimeId: string;
		requestId: string;
	}): ControlResult<StopMessageControlResult>;
	subscribe(
		update: (event: {
			snapshot: ControlSnapshot;
			receipt?: {
				messageId: string;
				requestId: string;
				status: "committed" | "handled" | "failed";
				error?: string;
			};
		}) => void,
	): () => void;
	readonly signal: AbortSignal | undefined;
	waitForIdle(): Promise<void>;
	dispose(): void;
}

export interface MessageControlAdapter {
	submit(request: MessageSubmitRequest): Promise<ControlResult<MessageAck>>;
	getSnapshot(): ControlResult<ControlSnapshot>;
	changePending(request: ChangePendingMessageRequest): Promise<ControlResult<ChangePendingMessageResult>>;
	recover(request: PendingMessageRequest): ControlResult<RecoverPendingMessageResult>;
	stop(request: {
		sessionId: string;
		runtimeId: string;
		requestId: string;
	}): ControlResult<StopMessageControlResult>;
	subscribe: MessageControlHandle["subscribe"];
	signal: AbortSignal | undefined;
	waitForIdle(): Promise<void>;
	dispose(): void;
}

export function createMessageControlAdapter(handle: MessageControlHandle): MessageControlAdapter {
	return {
		submit: (request) => handle.submit(request, "user"),
		getSnapshot: () => ({ ok: true as const, value: handle.getSnapshot() }),
		changePending: async (request: ChangePendingMessageRequest) => handle.changePending(request),
		recover: (request: PendingMessageRequest) => handle.recover(request),
		stop: (request: { sessionId: string; runtimeId: string; requestId: string }) => handle.stop(request),
		subscribe: handle.subscribe.bind(handle),
		get signal() {
			return handle.signal;
		},
		waitForIdle: () => handle.waitForIdle(),
		dispose: () => handle.dispose(),
	};
}

export function validateControlledPayload(payload: MessagePayload): ControlResult<MessagePayload> {
	if (!payload || typeof payload.text !== "string" || payload.text.length > 2_000_000) {
		return failure("invalid_payload", "Message text is invalid or too large");
	}
	if (
		payload.images !== undefined &&
		(!Array.isArray(payload.images) ||
			payload.images.some(
				(image) =>
					!image ||
					typeof image.data !== "string" ||
					!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data) ||
					typeof image.mimeType !== "string" ||
					!/^image\/[\w.+-]+$/i.test(image.mimeType),
			))
	) {
		return failure("invalid_payload", "Image payload is invalid");
	}
	if (
		payload.draft &&
		(typeof payload.draft.text !== "string" ||
			!Array.isArray(payload.draft.attachments) ||
			!payload.draft.attachments.every((item) => typeof item === "string") ||
			!Array.isArray(payload.draft.quotes) ||
			!payload.draft.quotes.every((item) => typeof item === "string") ||
			!(payload.draft.slashCommand === null || typeof payload.draft.slashCommand === "string"))
	) {
		return failure("invalid_payload", "Draft recovery data is invalid");
	}
	return { ok: true, value: payload };
}

export function failure<T>(
	code: import("@percho/shared").ControlErrorCode,
	message: string,
	snapshot?: ControlSnapshot,
): ControlResult<T> {
	return { ok: false, error: { code, message, ...(snapshot ? { snapshot } : {}) } };
}
