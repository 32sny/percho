import type { ImageInput } from "./session";

export type MessageMode = "queue" | "steer" | "interrupt";
export type ControlPhase = "idle" | "preparing" | "running" | "compacting" | "interrupting" | "blocked";
export interface MessagePayload {
	text: string;
	images?: ImageInput[];
	draft?: {
		text: string;
		attachments: string[];
		quotes: string[];
		slashCommand: string | null;
		imageNames?: string[];
	};
}
export interface ControlIdentity {
	sessionId: string;
	runtimeId: string;
	requestId: string;
}
export interface MessageSubmitRequest extends ControlIdentity {
	mode: MessageMode;
	payload: MessagePayload;
	recovery?: { messageId: string; expectedRevision: number };
}
export interface MessageAck {
	requestId: string;
	messageId: string;
	operationId?: string;
	disposition: "started" | "queued" | "handled" | "interrupting" | "held";
}
export interface ControlledItem {
	messageId: string;
	source: "user" | "extension" | "system";
	mode: MessageMode;
	state: "queued" | "held" | "recovering";
	preview: string;
	imageCount: number;
}
export interface ControlSnapshot {
	runtimeId: string;
	revision: number;
	runId?: string;
	phase: ControlPhase;
	compactionKind?: "manual" | "auto";
	autoDispatchPaused: boolean;
	operation?: {
		operationId: string;
		messageId?: string;
		sendAfterStop: boolean;
		startedAt: number;
		slow?: boolean;
	};
	items: ControlledItem[];
}
export type ControlErrorCode =
	| "not_found"
	| "read_only"
	| "stale_runtime"
	| "stale_revision"
	| "invalid_payload"
	| "image_unsupported"
	| "queue_full"
	| "busy"
	| "compacting"
	| "command_mode_unsupported"
	| "already_committed"
	| "request_id_conflict"
	| "preflight_failed";
export type ControlResult<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			error: { code: ControlErrorCode; message: string; snapshot?: ControlSnapshot };
	  };
export interface PendingMessageRequest extends ControlIdentity {
	messageId: string;
	expectedRevision: number;
}
export interface ChangePendingMessageRequest extends PendingMessageRequest {
	action: "steer" | "interrupt" | "resend" | "discard";
}
export interface ChangePendingMessageResult {
	snapshot: ControlSnapshot;
	ack?: MessageAck;
}
export interface RecoverPendingMessageResult {
	payload: MessagePayload;
	messageId: string;
	snapshot: ControlSnapshot;
}
export interface StopMessageControlResult {
	operationId: string;
	snapshot: ControlSnapshot;
}
export interface MessageControlUpdate {
	snapshot: ControlSnapshot;
	receipt?: {
		messageId: string;
		requestId: string;
		status: "committed" | "handled" | "failed";
		error?: string;
	};
}
export interface MessageControlUpdateEvent extends MessageControlUpdate {
	type: "message_control_update";
}
