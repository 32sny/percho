export function thinkingViewKey(
	sourceId: string | undefined,
	group: string | undefined,
	index: number,
): string {
	return `thinking:${sourceId ?? `${group}:${index}`}`;
}
