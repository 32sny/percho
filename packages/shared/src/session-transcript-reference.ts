/** 转录引用的文件名契约；旧引用只有短前缀，不能当作唯一会话 ID。 */
export interface SessionTranscriptReference {
	sessionId: string;
	name: string;
	legacy: boolean;
}

const FULL_ID = /^(?:(.+)-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i;
const LEGACY_ID = /^(.+)-([0-9a-f]{8})\.md$/i;

/** 只解析转录目录中的文件，先完整 UUID（具名/无名），再兼容旧八位前缀。 */
export function parseSessionTranscriptReference(path: string): SessionTranscriptReference | null {
	const fileName = /(?:^|[\\/])percho-transcripts[\\/]([^\\/]+)$/i.exec(path)?.[1];
	if (!fileName) return null;
	const full = FULL_ID.exec(fileName);
	if (full?.[2]) return { sessionId: full[2], name: full[1] || full[2], legacy: false };
	const legacy = LEGACY_ID.exec(fileName);
	return legacy?.[1] && legacy[2] ? { sessionId: legacy[2], name: legacy[1], legacy: true } : null;
}
