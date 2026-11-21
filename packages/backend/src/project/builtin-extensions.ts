import type { InlineExtension, McpRuntimeSnapshot } from "@earendil-works/pi-coding-agent";
import {
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { readCodemodeConfig } from "../settings/codemode";

/**
 * 官方内置扩展（照抄 CLI 侧元数据，spec §4.1）—— 不要自己发明字段：
 * - `builtin: true` → 扩展路径记为 `builtin:<name>`，不进启动 Extensions 列表；
 * - `replaceable: true` → 同名扩展可被用户/项目扩展替换（`omitReplacedExtensions`）；
 * - `llama.cpp` 暂不接（CLI 侧是 `builtInExtensions` 里的条件项，且 `core/extensions/builtin.js`
 *   被 package.json exports map 拦，实测 ERR_PACKAGE_PATH_NOT_EXPORTED），本批不接；
 *   官方一旦导出 `builtInExtensions`，在这里补一行即可（spec §4.4）。
 */
export function builtinExtensions(deps: {
	openUrl?: (url: string) => void | Promise<void>;
	agentDir?: string;
	mcpObserver?: () => (snapshot: McpRuntimeSnapshot) => void;
}): InlineExtension[] {
	return [
		{
			name: "codemode",
			factory: createCodemodeExtension({
				mode: readCodemodeConfig(deps.agentDir ?? getAgentDir()).only ? "only" : "on",
			}),
			builtin: true,
			replaceable: true,
		},
		{ name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
		// openUrl：MCP OAuth 授权页交给 Electron 打开（缺省则扩展回落到平台默认浏览器）
		{
			name: "mcp",
			factory: (pi) => createMcpExtension({ openUrl: deps.openUrl, onStatus: deps.mcpObserver?.() })(pi),
			builtin: true,
			replaceable: true,
		},
	];
}
