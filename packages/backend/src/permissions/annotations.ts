import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { PermissionAction, PermissionRules } from "./pattern";

/**
 * 非内置工具的权限默认动作（spec §3.1-7 / §4.5，pi 1.0.4 的 `ToolAnnotations`）：
 *
 * - **受信内置**（SDK 自带 + Percho 自研）走既有硬编码分类，不看 annotations；
 * - **非内置**（用户装的 MCP server 工具、第三方盘上扩展的工具）默认动作 =
 *   `annotations.readOnlyHint === true` ? allow : ask。
 *
 * 立场（spec 原文）：annotations 是**工具作者声明**、官方明确**未验证**，不能当放行依据；
 * 信任边界本就在「用户自己装了这台 server」上，声明只用来把「只读 vs 会改动」分开以降低打扰。
 * 所以：声明缺失 / 声明为写 → 一律 ask；声明只读 → 才免打扰。
 *
 * ⚠️ Percho 自研工具声明了 annotations（task 15），但**对本门控不生效** —— 它们在
 * `isTrustedBuiltinTool` 里被短路成内置（走既有硬编码分类）。声明是给展示/未来消费者/一致性的，
 * 改自研工具的 annotations 不会改变本机弹窗行为（要改行为请改这里的判定或 permissions.json 规则）。
 */

/** SDK 自带工具名（`builtin:<name>`）：命中即走硬编码分类，不受声明层影响。
 *  名单先于 sourceInfo 判定 —— 元数据缺失时内置工具也不会误弹窗。
 *  `tool_search` 只检索工具元数据并激活声明，不执行外部操作；激活后的 MCP 工具调用时仍走声明层检查。 */
const SDK_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"tool_search",
]);

/** SDK 内置 MCP 扩展的 sourceInfo path（该扩展注册的工具都来自**用户装的外部 server**） */
const MCP_EXTENSION_PATH = "builtin:mcp";
/** 内置扩展/基础工具的 sourceInfo 前缀（`builtin:<name>`） */
const BUILTIN_SOURCE_PREFIX = "builtin:";
/** MCP 工具名格式：`mcp__<server>__<tool>`（官方 `extensions/mcp/tools.js`） */
const MCP_TOOL_PREFIX = "mcp__";

/**
 * 受信内置判定：SDK 自带（名单 / `builtin:<name>`）+ 宿主注册的 `<sdk:…>`（Percho 自研 customTools）
 * 与 `<inline:…>`（Percho 的 inline 扩展；第三方 inline 扩展不存在，inline 工厂只由宿主提供）。
 * MCP 工具虽然也由内置扩展注册（path `builtin:mcp`），但内容是外部 server 的工具 → 不受信。
 */
export function isTrustedBuiltinTool(toolName: string, info: ToolInfo | undefined): boolean {
	const path = info?.sourceInfo?.path ?? "";
	if (SDK_BUILTIN_TOOL_NAMES.has(toolName)) {
		// 名单里的名字必须来源也是内置实现才免声明层：内置扩展标了 `replaceable`，同名第三方
		// 扩展可以顶掉它并注册同名工具；只认名字等于让第三方工具借名字跳过确认。
		// 元数据缺失（如基础工具未进 getAllTools）维持原行为，不误弹内置工具。
		return path === "" || path.startsWith(BUILTIN_SOURCE_PREFIX);
	}
	if (toolName.startsWith(MCP_TOOL_PREFIX)) return false;
	if (path === MCP_EXTENSION_PATH) return false;
	return path.startsWith("<");
}

/**
 * 声明层求值：**只会把 allow 收紧为 ask**，不会放松任何判定。
 * - 规则已给出 ask/deny：原样返回（不动）；
 * - 该工具有**显式规则**（用户/项目在 permissions.json 里写过的工具名级条目）：规则优先，声明层让位；
 * - 受信内置：原样返回（硬编码分类）；
 * - 其余：`readOnlyHint === true` ? allow : ask（含「工具查不到」「没有 annotations」）。
 */
export function applyToolAnnotationsRule(
	rules: PermissionRules,
	toolName: string,
	action: PermissionAction,
	findTool: (name: string) => ToolInfo | undefined,
): PermissionAction {
	if (action !== "allow") return action;
	if (Object.hasOwn(rules, toolName)) return action;
	// 名单内的名字也要查来源：同名第三方扩展可顶掉内置实现（builtin 扩展标了 replaceable），
	// 只认名字会直接跳过声明层。查不到时 isTrustedBuiltinTool 仍按名单放行，不误弹内置工具。
	const info = findTool(toolName);
	if (isTrustedBuiltinTool(toolName, info)) return action;
	return info?.annotations?.readOnlyHint === true ? "allow" : "ask";
}
