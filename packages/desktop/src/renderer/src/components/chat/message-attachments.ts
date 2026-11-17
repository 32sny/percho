/**
 * 已发送气泡里的 `@路径` 引用切分（纯函数，可单测）。
 *
 * 发送时附件胶囊会拼回 `@<path>` 文本（见 composer/use-composer-send：
 * `attachments.map(p => "@" + p).join(" ")`，多条会连成**同一行**，正文另起一行），
 * 用户气泡原本直接显示这串机器路径。这里切成 text / reference 片段，交给
 * `MessageAttachmentChip` 渲染成语义芯片；原文不变（复制、撤回仍用 message.text）。
 *
 * 切分规则（按 `@` 逐个判，遇到下一个 `@` 或换行即结束该段）：
 * 1. 段内带路径分隔符，且整段以扩展名结尾 → 整段就是一条路径（文件名可含空格与 `·`）。
 * 2. 否则只取到第一个空白的那截 token，只要它含分隔符也认（无扩展名 = 文件夹/被空格截断的目录）。
 * 3. 都不满足（`@昵称`、邮箱、纯词）→ 留在文本里，绝不猜。
 *
 * 不做跨行匹配：正文另起一行，所以不会被后面的正文吞进路径。
 */
export type MessageSegment = { type: "text"; text: string } | { type: "reference"; path: string };

const HAS_SEPARATOR = /[\\/]/;
/** 段首到最后一个 `.扩展名` 边界（贪婪）：用来把带空格的文件名整段吃掉，尾部正文不受影响 */
const WHOLE_RUN_PATH = /^(.*[\\/].*\.[A-Za-z0-9]+)(?=\s|$)/;
/** 句读：段里出现这些基本说明已经混进正文，不再当整段路径 */
const SENTENCE_PUNCTUATION = /[。！？，、；：]/;

function isPathLike(value: string): boolean {
	return HAS_SEPARATOR.test(value);
}

/** 段 → 路径（见文件头规则 1/2）；判断不了返回 null */
function resolveRunPath(run: string): string | null {
	const trimmed = run.trim();
	if (!trimmed) return null;
	if (!SENTENCE_PUNCTUATION.test(trimmed)) {
		// 贪婪到最后一个 `.ext`：`C:\a\Claude opus 4.7 破甲.txt 看下` 只吃前段，不吞正文
		const whole = WHOLE_RUN_PATH.exec(trimmed)?.[1];
		if (whole) return whole;
	}
	const token = trimmed.split(/\s+/)[0] ?? "";
	return isPathLike(token) ? token : null;
}

/** 文本 → 片段序列；没有命中引用时原样返回单段文本（调用方按段渲染） */
export function splitMessageReferences(text: string): MessageSegment[] {
	const segments: MessageSegment[] = [];
	let cursor = 0;
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== "@") continue;
		// 只认行首或空白后的 `@`：邮箱 a@b.com、词中 @ 都不算
		const prev = index === 0 ? "" : text[index - 1];
		if (prev && !/\s/.test(prev)) continue;
		let end = index + 1;
		while (end < text.length && text[end] !== "@" && text[end] !== "\n") end += 1;
		const path = resolveRunPath(text.slice(index + 1, end));
		if (!path) continue;
		if (index > cursor) segments.push({ type: "text", text: text.slice(cursor, index) });
		segments.push({ type: "reference", path });
		// 段内剩下的（被空格截断的尾巴）留给后续循环按普通文本继续扫
		const run = text.slice(index + 1, end);
		const offset = Math.max(0, run.indexOf(path));
		const consumed = index + 1 + offset + path.length;
		cursor = consumed;
		index = consumed - 1;
	}
	if (cursor < text.length) segments.push({ type: "text", text: text.slice(cursor) });
	if (segments.length === 0) segments.push({ type: "text", text });
	return segments;
}
