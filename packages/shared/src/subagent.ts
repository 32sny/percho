/**
 * 子代理运行数据提取（跨进程共用）：从 subagent 工具结果的 details 结构检测运行组。
 * 从 session.ts 拆出（session.ts 回归纯类型 + 消息 union 定义）。
 */
/** 子代理运行结果（扩展 subagent 工具 details 提取，独立消息展示用） */
export interface SubagentRunData {
	/** 子代理名（如 reviewer / scout） */
	agent: string;
	task?: string;
	status: "running" | "done" | "error";
	model?: string;
	/** pi-subagents 的 agent id（后台派工返回的 Agent ID；完成通知按它回填状态） */
	agentId?: string;
	/** 子会话实际生效的思考档位（单次运行元信息） */
	thinkingLevel?: string;
	/** 子代理消耗的 token 数 */
	tokens?: number;
	/** 非 0 表示子代理执行出错 */
	exitCode?: number;
	/** 产物目录 */
	artifactsDir?: string;
	/** 子代理会话文件路径（点击可打开完整对话） */
	sessionFile?: string;
}

/**
 * subagent 家族工具名判定（互斥/接管 badge 的单一来源）：
 * 内置同名工具 `subagent` + 第三方家族配套 `subagent_*`（wait/status 等）。
 */
export function isSubagentToolName(name: string): boolean {
	return name === "subagent" || name.startsWith("subagent_");
}

/**
 * pi-subagents 的 `Agent` 工具把 token 数做成显示字符串（"208.1k token" / "1.2M token"），
 * 卡片要数字，这里按 k/M 还原；解析不出来就不显示，不猜。
 */
function parseCompactTokens(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string") return undefined;
	const match = /^([\d.]+)\s*([kKmM]?)/.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1] ?? "");
	if (!Number.isFinite(amount)) return undefined;
	const unit = (match[2] ?? "").toLowerCase();
	return Math.round(amount * (unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1));
}

/**
 * 从工具结果 details 提取子代理运行数据。
 * 结构检测（不依赖工具名）：details.results 数组且至少一项带 agent/sessionFile → 返回运行组，否则 null。
 * 兼容 pi-subagents 及遵循同约定的社区扩展：
 * - 同步/foreground：details.results[]（agent/task/exitCode/usage/model/artifactPaths.jsonlPath）
 * - 后台并行：subagent_wait 的 details.completions[].results[]（agent/success/artifactPaths.outputPath 可能是子会话 jsonl）
 */
export function extractSubagentRuns(details: unknown): SubagentRunData[] | null {
	const d = details as
		| {
				results?: unknown[];
				completions?: unknown[];
				artifacts?: { dir?: unknown };
		  }
		| null
		| undefined;
	if (!d) return null;
	const runs: SubagentRunData[] = [];
	const artifactsDir = typeof d.artifacts?.dir === "string" ? d.artifacts.dir : undefined;

	const pushRun = (
		agent: unknown,
		rest: {
			task?: unknown;
			model?: unknown;
			thinkingLevel?: unknown;
			exitCode?: unknown;
			error?: unknown;
			sessionFile?: unknown;
			tokens?: unknown;
		},
	) => {
		if (typeof agent !== "string") return;
		const sessionFile = typeof rest.sessionFile === "string" ? rest.sessionFile : undefined;
		const task = typeof rest.task === "string" && rest.task.length > 0 ? rest.task : undefined;
		const exitCode = typeof rest.exitCode === "number" ? rest.exitCode : undefined;
		const error = typeof rest.error === "string" && rest.error.length > 0 ? rest.error : undefined;
		runs.push({
			agent,
			task,
			status: exitCode != null && exitCode !== 0 ? "error" : error ? "error" : "done",
			model: typeof rest.model === "string" ? rest.model : undefined,
			thinkingLevel: typeof rest.thinkingLevel === "string" ? rest.thinkingLevel : undefined,
			tokens: typeof rest.tokens === "number" ? rest.tokens : undefined,
			exitCode,
			artifactsDir,
			sessionFile,
		});
	};

	// 后台并行完成：subagent_wait 的 completions（子代理会话文件可能在 artifactPaths.outputPath，须以 .jsonl 结尾）
	const completions = Array.isArray(d.completions) ? d.completions : [];
	for (const rawCompletion of completions) {
		const completion = rawCompletion as
			| { agent?: unknown; success?: unknown; results?: unknown[] }
			| undefined;
		if (!completion || !Array.isArray(completion.results)) continue;
		for (const rawChild of completion.results) {
			const child = rawChild as
				| {
						agent?: unknown;
						success?: unknown;
						error?: unknown;
						artifactPaths?: { jsonlPath?: unknown; outputPath?: unknown };
				  }
				| undefined;
			if (!child) continue;
			const outputPath =
				typeof child.artifactPaths?.outputPath === "string" ? child.artifactPaths.outputPath : undefined;
			const jsonlPath =
				typeof child.artifactPaths?.jsonlPath === "string" ? child.artifactPaths.jsonlPath : undefined;
			const sessionFile = jsonlPath ?? (outputPath?.endsWith(".jsonl") ? outputPath : undefined);
			pushRun(child.agent, {
				error: child.error,
				sessionFile,
				exitCode: child.success === false ? 1 : undefined,
			});
		}
	}

	// 同步/foreground：details.results[]（会话文件在 artifactPaths.jsonlPath）
	const results = Array.isArray(d.results) ? d.results : [];
	for (const raw of results) {
		const r = raw as Record<string, unknown>;
		const agent = typeof r.agent === "string" ? r.agent : undefined;
		const sessionFile = typeof r.sessionFile === "string" ? r.sessionFile : undefined;
		if (!agent && !sessionFile) continue;
		const artifactPaths = r.artifactPaths as { jsonlPath?: unknown } | undefined;
		const usage = r.usage as
			| { totalTokens?: { tokens?: unknown }; tokens?: unknown; input?: unknown; output?: unknown }
			| undefined;
		const progress = r.progressSummary as { tokens?: unknown } | undefined;
		const totalTokens = r.totalTokens as { tokens?: unknown } | undefined;
		const tokenValue =
			usage?.totalTokens?.tokens ??
			usage?.tokens ??
			(typeof usage?.input === "number" && typeof usage?.output === "number"
				? usage.input + usage.output
				: undefined) ??
			progress?.tokens ??
			totalTokens?.tokens;
		const exitCode = typeof r.exitCode === "number" ? r.exitCode : undefined;
		const error = typeof r.error === "string" && r.error.length > 0 ? r.error : undefined;
		pushRun(agent ?? sessionFile ?? "subagent", {
			task: r.task,
			model: r.model,
			thinkingLevel: r.thinkingLevel,
			exitCode,
			error,
			sessionFile:
				sessionFile ?? (typeof artifactPaths?.jsonlPath === "string" ? artifactPaths.jsonlPath : undefined),
			tokens: tokenValue,
		});
	}

	// pi-subagents 的 `Agent` 工具（前台/后台派工）：details 是扁平的 AgentDetails
	// （subagentType/description/toolUses/tokens 字符串/status/modelName/tags），没有 results[]。
	// 只在上面两种形状都没命中时兜底，不影响既有 subagent 家族。
	if (runs.length === 0) {
		// SAFETY: details 是工具结果（unknown），这里只做"形状探测"：先按 AgentDetails 的字段名取值，
		// 每个字段取用前都再过一次 typeof/Array.isArray，断言只负责给字段名，不给字段类型。
		const flat = d as unknown as {
			subagentType?: unknown;
			description?: unknown;
			status?: unknown;
			modelName?: unknown;
			tags?: unknown;
			tokens?: unknown;
			sessionFile?: unknown;
			agentId?: unknown;
		};
		const status = typeof flat.status === "string" ? flat.status : undefined;
		// 三种进行态（running/queued/background）也出行：后台派工一次性返回、之后不再更新工具结果，
		// 行先在派工瞬间立起来（status=running），完成时由 `subagent-notification` 按 tool-use-id 回填。
		const pending = status === "running" || status === "queued" || status === "background";
		if (typeof flat.subagentType === "string" && status) {
			const tags = Array.isArray(flat.tags)
				? flat.tags.filter((tag): tag is string => typeof tag === "string")
				: [];
			const thinkingTag = tags.find((tag) => tag.startsWith("thinking:"));
			runs.push({
				agent: flat.subagentType,
				task:
					typeof flat.description === "string" && flat.description.length > 0 ? flat.description : undefined,
				status: pending ? "running" : status === "error" ? "error" : "done",
				model: typeof flat.modelName === "string" ? flat.modelName : undefined,
				agentId: typeof flat.agentId === "string" ? flat.agentId : undefined,
				thinkingLevel: thinkingTag ? thinkingTag.slice("thinking:".length).trim() : undefined,
				tokens: parseCompactTokens(flat.tokens),
				exitCode: !pending && status === "error" ? 1 : undefined,
				artifactsDir,
				// 上游 AgentDetails 目前不带会话路径；等 pi-subagents 补上（或本地 fork 加）后，
				// 这一行会自动让卡片可点开，不需要再改这里。
				sessionFile: typeof flat.sessionFile === "string" ? flat.sessionFile : undefined,
			});
		}
	}
	return runs.length > 0 ? runs : null;
}
