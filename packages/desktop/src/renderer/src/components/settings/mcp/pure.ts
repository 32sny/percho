import type { McpServerView, McpToolView } from "@percho/shared";

/** 行的状态（设计稿 §3 状态矩阵）—— 只用一枚 7px 圆点表达，不叠色块 */
export type ServerState = NonNullable<McpServerView["state"]> | "idle" | "error";

/**
 * 状态判定（面板的核心语义，纯函数便于单测）：
 * - **连接状态只看显式 `state`**，不再从工具数量推断（deferred 未激活也报告 not-started/unknown）；
 * - 旧配置夹具缺 `state` 时兼容 `enabled` / `needsAuth` / `error`，再否则 "idle"。
 */
export function serverState(
	server: Pick<McpServerView, "enabled" | "tools" | "error" | "needsAuth" | "state">,
): ServerState {
	if (server.state) return server.state;
	if (!server.enabled) return "disabled";
	if (server.needsAuth) return "needs-auth";
	if (server.error) return "error";
	return "idle";
}

/** 工具摘要：「N 个工具 · 只读 M 个」；无工具给 null（交给状态词） */
export function toolsSummary(tools: readonly McpToolView[]): { count: number; readOnly: number } | null {
	if (tools.length === 0) return null;
	return { count: tools.length, readOnly: tools.filter((tool) => tool.readOnly === true).length };
}

/** 传输方式一行摘要（stdio: command args / 远程: url；不完整给空串） */
export function transportSummary(server: McpServerView): string {
	if (server.transport.kind === "stdio") {
		return [server.transport.command, ...(server.transport.args ?? [])].join(" ");
	}
	if (server.transport.kind === "url") return server.transport.url;
	return "";
}

/** 暴露档位的简短解释（编辑器里当前档位下方那一行） */
export function exposureKey(exposure: string): string {
	return `settings.mcp.exposureExplain.${exposure}`;
}

/** 排序：停用垫底，其余按名称（设计稿 §3：停用排组内最后） */
export function sortServers(servers: McpServerView[]): McpServerView[] {
	return [...servers].sort((a, b) => {
		const disabled = Number(!a.enabled) - Number(!b.enabled);
		if (disabled !== 0) return disabled;
		return a.name.localeCompare(b.name);
	});
}

/** 过滤（搜索框只在服务器 > 8 个时出现；匹配名称/描述/命令） */
export function filterServers(servers: McpServerView[], query: string): McpServerView[] {
	const q = query.trim().toLowerCase();
	if (!q) return servers;
	return servers.filter((server) =>
		[server.name, server.description ?? "", transportSummary(server)].some((text) =>
			text.toLowerCase().includes(q),
		),
	);
}

export const SEARCH_THRESHOLD = 8;

/** 是否需要显示搜索框 */
export function showSearch(servers: McpServerView[]): boolean {
	return servers.length > SEARCH_THRESHOLD;
}
