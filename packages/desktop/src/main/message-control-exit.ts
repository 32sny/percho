export interface ExitControlSnapshot {
	runtimeId?: string;
	revision?: number;
	phase: string;
	items: readonly { messageId: string; source: string; state: string }[];
	operation?: { messageId?: string; sendAfterStop: boolean };
}

export function pendingMessageCount(snapshots: readonly ExitControlSnapshot[]): number {
	const pendingIds = new Set<string>();
	for (const snapshot of snapshots) {
		for (const item of snapshot.items) pendingIds.add(item.messageId);
		if (snapshot.operation?.sendAfterStop && snapshot.operation.messageId) {
			pendingIds.add(snapshot.operation.messageId);
		}
	}
	return pendingIds.size;
}

export function samePendingSnapshot(
	before: readonly ExitControlSnapshot[],
	after: readonly ExitControlSnapshot[],
): boolean {
	const ids = (snapshots: readonly ExitControlSnapshot[]) =>
		snapshots
			.map((snapshot) => ({
				runtimeId: snapshot.runtimeId,
				revision: snapshot.revision,
				ids: [
					...new Set([
						...snapshot.items.map((item) => item.messageId),
						...(snapshot.operation?.sendAfterStop && snapshot.operation.messageId
							? [snapshot.operation.messageId]
							: []),
					]),
				].sort(),
			}))
			.sort((a, b) => String(a.runtimeId).localeCompare(String(b.runtimeId)));
	const left = JSON.stringify(ids(before));
	const right = JSON.stringify(ids(after));
	return left === right;
}

export function createQuitConfirmationRequest(options: {
	getSnapshots: () => readonly ExitControlSnapshot[];
	confirm: (count: number) => Promise<boolean>;
	quit: () => void;
}) {
	let inFlight: Promise<void> | null = null;
	return (): Promise<void> => {
		if (inFlight) return inFlight;
		inFlight = (async () => {
			let snapshot = options.getSnapshots();
			while (shouldConfirmQuitWithPendingMessages(snapshot)) {
				if (!(await options.confirm(pendingMessageCount(snapshot)))) return;
				const latest = options.getSnapshots();
				if (!samePendingSnapshot(snapshot, latest)) {
					snapshot = latest;
					continue;
				}
				break;
			}
			options.quit();
		})().finally(() => {
			inFlight = null;
		});
		return inFlight;
	};
}

export function shouldConfirmQuitWithPendingMessages(snapshots: readonly ExitControlSnapshot[]): boolean {
	return pendingMessageCount(snapshots) > 0;
}
