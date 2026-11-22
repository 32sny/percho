---
类型: 技术方案
状态: 方案已定稿待批准（只读规划完成，未修改源码）
创建: 2026-11-22
更新: 2026-11-22
适用: Percho 子代理并行状态、只读查看、回父会话与后台异步派工（Phase 1 + Phase 2）
---

# 子代理并行状态、只读查看、回父会话与后台异步派工方案

> **创建日期**：2026-11-22
> **状态**：方案已定稿待批准
> **关联版本**：Percho `main`（`HEAD 2753f6d` / Pi SDK `1.5.1`）
> **任务真源**：上游 `d506a98` / `a94df83` / `b4e12a5` 差异同步 + 用户确认的「Phase 1 + Phase 2 分批实施 + 折中版卡片」

---

## 一、目标与阶段边界

### 1.1 核心目标
1. **Phase 1（上游差异补齐 + 折中版卡片）**：
   - 补齐运行中子代理的**实时内存分支读取、按需事件推流（仅查看时转发）与只读基线加载**，解决点进运行中子代理漏消息、跑完重看仍是旧快照、未查看时白白推流的问题。
   - 补齐子代理状态与摘要契约（`queued` / `aborted`、`index`、`summary`）及子代理边界策略（`policy.ts`：只读 git 白名单、Percho 状态目录保护、`deny` 规则、`permissionMode` 继承）。
   - 落地**折中版 `SubagentRunCard`**：保留真实 Agent 名（如 `Explore` / `Oracle` / `fixer` / `scout`）与关键元信息（思考档位 / 模型 / token），状态指示升级为上游 `b4e12a5` 的 **80×22 跳动三点胶囊 → 终态从右向左收成 6px 绿/红/灰圆点**。
2. **Phase 2（内置 `subagent` 后台异步派工 + 跑完自动汇报）**：
   - 为内置 `subagent` 工具增加可选 `run_in_background?: boolean`（默认 `false`，保持现有同步分头并行行为不变），并配套 `subagent_status` / `subagent_wait` / `subagent_stop`。
   - 派出后台子代理后立即返回 `runId` 与 `sessionFile`（卡片立刻可点进只读查看 + `←` 回父会话），父代理可继续执行其他工具或先回复用户；子代理跑完后通过 SDK `sendCustomMessage(..., { triggerTurn: true, deliverAs: "followUp" })` 自动送回父会话触发汇报，且不产生假用户气泡。

### 1.2 明确非目标（Out of Scope）
- **不照搬上游 `d506a98` 的 `worker` 替换**：保留本方内置 `BUILTIN_SCOUT`、用户/项目自定义 agent 体系、`agent` 必填与 `cwd` 可选参数。
- **不照搬上游 `b4e12a5` 的 `Worker N` 匿名化**：卡片不隐藏真实 agent 名称、模型与思考档位。
- **不关闭 `subagentPreferBuiltin`、不卸载 `@tintinweb/pi-subagents` 或 `PiFlow`**：保持现有执行器互斥策略。
- **Phase 2 首版不做 git worktree 自动隔离与自动合并**：Windows 下 worktree 开销大且看不到未提交改动；并发写风险通过工具契约提示与只读/分目录约束控制。
- **不修改 `docs/INDEX.md` 以外的无关规划文档**；本方案获批前不修改任何业务源码。

---

## 二、现有实现定位

### 2.1 可复用能力
- **只读检视与写守卫**：`packages/backend/src/session/subagent-paths.ts`（`isSubagentSessionPath`、`validateSubagentSessionFile`）、`packages/backend/src/pi-backend.ts`（`readOnly` 标记与写操作守卫）、`packages/desktop/src/renderer/src/components/composer/Composer.tsx`（`readOnly` 禁用输入并显示「子代理会话为只读检视，不可继续对话」）。
- **回父会话与页面过渡**：`packages/desktop/src/renderer/src/components/chat/SubagentBackButton.tsx`、`packages/desktop/src/renderer/src/stores/subagent-return.ts`、`packages/desktop/src/renderer/src/stores/sessions.ts`（`openSubagentSessionFrom`、`returnToParent`、`withSessionSlide`）。
- **子代理卡片与插件契约**：`packages/desktop/src/renderer/src/components/chat/SubagentRunCard.tsx`、`packages/shared/src/subagent.ts`（`extractSubagentRuns`）、`packages/shared/src/transcript/reducer.ts`、`packages/desktop/src/lan-web/src/components/SubagentCard.tsx`、`packages/desktop/resources/ui-plugins/percho-ui.d.ts`（本机 `orchestrator-badge` 插件已提前兼容 `queued`/`aborted`/`summary`/`index`）。
- **后台通知与唤醒原语**：
  - `packages/shared/src/subagent-notification.ts`、`packages/backend/src/session/messages.ts`（`toSessionMessages` 拦截 `custom` 通知更新更早运行中卡片而不产气泡）、`packages/shared/src/transcript/reducer.ts`（`applySubagentNotificationToState`）。
  - Pi SDK `1.5.1` `AgentSession.sendCustomMessage(msg, { triggerTurn: true, deliverAs: "followUp" })`（经 `_idleAsync` 与 `messageControl.submitCustom` 排队/唤醒，且 `convertToLlm` 原生将 `custom` 消息转为 LLM 可见上下文）。
- **悬停关系与 GC 保护**：`packages/backend/src/session/hover-relations.ts`、`packages/shared/src/session-hover.ts`、`packages/desktop/src/renderer/src/lib/session-gc.ts`、`packages/backend/src/pi-backend.ts`（`closeSession` 的 `tryAcquireIdleLease`）。

### 2.2 不能直接复用 / 需重构或补齐的部分
1. **事件转发与快照读取脱节**：
   - `packages/backend/src/pi-backend.ts:551` 当前无条件转发所有子代理事件；`getSessionHistoryWindow`（1921 行）、`getSessionNavigation`、`getSessionMessages`（1992 行）直接读 `entry.session.sessionManager.getBranch()`，对 `readOnly` 子会话拿到的是 `openSession` 时的静态快照，既看不到运行中内存增量，跑完重看也仍是旧快照。
   - `packages/desktop/src/renderer/src/stores/session-loading.ts` 的 `skipHistory` 仅判断 `agentActive === true`，未对 `readOnly` 子会话强制拉取基线，也未在切换离开/进入时调用 `setViewedSubagent`。
   - `packages/desktop/src/renderer/src/stores/transcript.ts` 的 `loadHistory` 会把 `streaming` 置 `null`、`agentActive` 置 `false`：若先开推流再拉历史窗口，窗口请求期间到达的实时事件会被 `loadHistory` 抹掉，且运行中子代理在等待首 token 时会误显 `idle`。
2. **子代理文件首帧落盘窗口**：
   - `packages/backend/src/tools/subagent/runner.ts` 中 `SessionManager.create` 分配了 `sessionFile`，但 SDK `_persist` 直到 `_hasConversation()` 为真（首条 `user` 消息写入）才写盘；若用户在刚派工瞬间点击卡片，`validateSubagentSessionFile` 可能因文件尚未落盘而报 `ENOENT`。
3. **状态枚举与悬停/LAN 契约未对齐**：
   - `SubagentRunUi.status` 仅有 `"running" | "done" | "error"`，缺少 `"queued"` / `"aborted"`、`summary`、`index`。
   - `packages/backend/src/session/hover-relations.ts:57` 与 `packages/shared/src/session.ts` 的 `SessionHoverLiveRun` 仅接受 `"running" | "done" | "error"`，若不扩展会丢弃 `queued` / `aborted` 项。
4. **上游 `policy.ts` / `prompt.ts` / `b4e12a5` 的本地适配缺口**：
   - 上游 `policy.ts` 用 `text.includes(policy.agentDir)` 拦截状态目录，在 Windows 正反斜杠或盘符大小写混用时会漏判。
   - 上游 `prompt.ts` 默认假设所有子代理都有 `edit`/`write`/`bash`，对本方只读 `scout` / `Explore` 会注入误导性编辑指令。
   - 上游 `b4e12a5` CSS 未给 `data-state="queued"` 单独定义静止态，且 `.tsx` 中若直接写 hex/任意值会违反 `ui-spec.json`（`scan-hardcoded.py`）。
5. **内置 `subagent` 缺少后台生命周期管理**：
   - `packages/backend/src/tools/subagent/tool.ts` 仅支持同步 `await withConcurrency(...)`，且 `buildCustomTools` 未绑定父会话上下文与后台管理器；父会话空闲后若后台子代理仍在跑，现有 GC 策略会误卸载父会话。

---

## 三、架构决策

### 3.1 Phase 1 决策：按需推流 + 同步分支读取 + 折中版卡片

1. **IPC 与基线防竞态契约**：
   - `SESSION_CHANNELS` 新增 `setViewedSubagent: ch("session:setViewedSubagent")<{ sessionId?: string }, void>()`。
   - `SessionHistoryWindow` 新增可选字段 `live?: { agentActive: boolean }`。
   - `PiBackend` 新增 `runningSubagents: Map<string, SubagentRunHandle>`（同时支持按 `sessionFile` 查找）与 `viewedSubagentId?: string`。
   - `sessionBranch(entry)` **必须保持全链路同步**（不引入 `await`），以守住 `packages/backend/src/lan/server.ts:274` 的 `seq` 原子边界：
     - 命中 `runningSubagents.get(sessionId)` → 返回 `handle.getBranch()`；
     - 否则若 `entry.readOnly && entry.session.sessionFile && existsSync(entry.session.sessionFile)` → 返回 `SessionManager.open(entry.session.sessionFile).getBranch()`；
     - 否则 → 返回 `entry.session.sessionManager.getBranch()`。
   - `openSessionOnce(filePath)` 对 `isSubagentSessionPath(filePath)` 的路径：先做 `validateSubagentSessionFile(filePath)`；若文件尚未落盘但 `runningSubagents` 中存在同路径活跃句柄（且父目录 realpath 校验通过），允许基于活跃句柄的 `sessionId` / `cwd` / `sessionFile` 构造只读 `SessionMeta` 并注册只读条目，避免刚派工点击报 `ENOENT`。
   - **防竞态加载**：打开/切入 `readOnly` 会话时，先调用 `setViewedSubagent({ sessionId })`，同时在 `session-loading.ts` 为该 `sessionId` 开启临时事件缓冲；`requestSessionHistoryWindow` 返回并执行 `loadHistory`（若 `history.live?.agentActive` 为 `true` 则置 `agentActive: true`）后，按序重放缓冲期间到达的事件并关闭缓冲。

2. **状态、摘要与策略契约（Fail-closed）**：
   - `SubagentRunStatus = "running" | "queued" | "done" | "error" | "aborted"`。
   - `SubagentRunSummary`：
     ```ts
     interface SubagentRunSummary {
       changedFiles: Array<{ path: string; added: number; removed: number }>;
       commands: Array<{ command: string; isError: boolean }>;
       failedCommands: number;
       durationMs: number;
     }
     ```
   - `policy.ts`：
     - `permissionMode` 仅接受 `"default" | "fullAccess"`（默认 `"default"`）；`deny` 规则解析失败时记录 `denyWarnings` 并忽略该条，不阻断 agent 发现。
     - `isProtectedPerchoPath` 在 Windows 上统一做 `path.resolve` + 斜杠归一化（`/`）+ 小写比较，拦截对 `agentDir`（含 `model-prefs.json`、`auth.json`、`sessions/`、`subagents/`）的读写与 bash 篡改。
     - `isReadOnlyGitCommand` 仅放行白名单只读 git 子命令（`status`、`diff`、`log`、`show`、`rev-parse`、`branch --list` 等），拒绝带写参数（如 `-c`、`--exec`、重定向写文件）。
   - `prompt.ts`：根据 `safeTools` 是否包含 `edit` / `write` / `bash` 分别拼接只读或可写核心指引，不向只读 agent 注入编辑/测试指令。

3. **折中版 `SubagentRunCard` 视觉契约（对齐 `docs/ui.md` 与 `ui-spec.json`）**：
   - **保留**：真实 Agent 名（`displayName(run.agent)`，多任务时附 `#${run.index}`）、`thinkingLevel`、`model`、`tokens`（使用 `text-ui-11` / `text-ui-12` 与 `text-ink-2` / `text-ink-faint`）。
   - **升级**：右侧状态区采用 `.subagent-slot` / `.subagent-cap` / `.subagent-dots`：
     - `running`：80×22 胶囊内三点跳动动画；
     - `queued`：80×22 胶囊内三点静止半透明（`opacity: 0.45`，无跳动），与 `running` 明确区分；
     - `done` / `error` / `aborted`：从右向左收拢为 6px 圆点，颜色使用 `globals.css` 语义 token（`--color-subagent-ok` / `--color-subagent-err` / `--color-ink-faint`）。
   - **硬约束**：`.tsx` 中禁止出现任何 hex 色值、字号 px 或 Tailwind 任意值（`w-[80px]` 等），全部尺寸与颜色定义在 `packages/desktop/src/renderer/src/styles/globals.css`。

### 3.2 Phase 2 决策：内置 `subagent` 后台异步派工 + 自动汇报

1. **工具接口扩展**：
   - `subagent` 参数新增 `run_in_background?: boolean`（默认 `false`）。
   - 新增 3 个配套内置工具（仅在内置 `subagent` 启用时注册；子代理 `safeTools` 过滤 `subagent` 与 `subagent_*`）：
     - `subagent_status({ runId?: string })`：返回指定或全部后台批次的实时状态、各子任务 `status` / `sessionFile` / 已耗时 / 摘要。
     - `subagent_wait({ runId: string, timeoutMs?: number })`：可选显式等待指定后台批次完成（默认超时 120000ms，超时返回当前状态而非报错）。
     - `subagent_stop({ runId: string })`：中止指定后台批次（触发其独立 `AbortController` 并等待清理）。

2. **后台通知与自动唤醒 DTO**：
   - 新增 `packages/shared/src/percho-subagent-notification.ts`（或扩展 `subagent-notification.ts`），定义 `PERCHO_SUBAGENT_NOTIFICATION_TYPE = "percho-subagent-notification"`：
     ```ts
     interface PerchoSubagentNotificationDetails {
       runId: string;
       mode: "single" | "parallel";
       status: "done" | "error" | "aborted";
       runs: Array<{
         key: string; // `${toolCallId}:${index}`
         agent: string;
         index?: number;
         status: "done" | "error" | "aborted";
         sessionFile?: string;
         exitCode?: number;
         error?: string;
         tokens?: number;
         summary?: SubagentRunSummary;
       }>;
     }
     ```
   - 通知正文（`content`）为结构化文本（含 `runId`、各子任务状态、摘要、截断输出与 `sessionFile`），`display: false`。
   - 投递方式：调用父会话 `session.sendCustomMessage({ customType: PERCHO_SUBAGENT_NOTIFICATION_TYPE, content, display: false, details }, { triggerTurn: true, deliverAs: "followUp" })`。
   - **Fail-closed 投递守卫**：
     - 若父会话已进入 `dispose` / `deleteSession` → 跳过投递并记录日志，不抛未捕获异常；
     - 若父会话正在手动压缩或 `sendCustomMessage` 因瞬态拒绝 → 挂起等待当前操作结算后重试一次，仍失败则记录错误日志并保留磁盘结果供 `subagent_status` 查询。

3. **卡片与历史回放一致性**：
   - `subagent({ run_in_background: true })` 返回的 `details` 携带 `mode: "background"`、`runId` 与初始 `results`（`status: "running" | "queued"`、`artifactPaths: { jsonlPath }`）。
   - `extractSubagentRuns` 识别 `mode: "background"`，在父消息上渲染可点击的 `SubagentRunCard`（状态为 `running` / `queued`）。
   - `packages/shared/src/transcript/reducer.ts` 与 `packages/backend/src/session/messages.ts` 拦截 `customType === "percho-subagent-notification"`：
     - **不生成聊天气泡**；
     - 按 `details.runs[].key`（或 `runId`）把更早那条 `SubagentRunUi` / `SessionSubagentMessage` 原地更新为终态（`done` / `error` / `aborted`、`summary`、`tokens`、`sessionFile`）。
   - `packages/backend/src/session/hover-relations.ts` 同步消费 `percho-subagent-notification` 更新子代理终态，保证左侧悬停卡与主消息流一致。

4. **GC、关闭与权限边界**：
   - `PiBackend.hasRunningBackgroundSubagents(parentSessionId)`：
     - `closeSession(sessionId, "gc")`：存在运行中后台子代理时返回 `{ closed: false }`；
     - `closeSession(sessionId, "user")`：与 `isStreaming` 一致，拒绝关闭（防止误关丢失自动汇报）；
     - `deleteSession` / `PiBackend.dispose()`：先中止并等待该父会话名下所有后台子代理退出，再销毁父会话。
   - `packages/desktop/src/renderer/src/lib/session-gc.ts`：保护条件新增「存在 `status === "running" || status === "queued"` 的后台子代理」的会话。
   - `runner.ts`：`childGateConfirm` 透传子代理自身的 `abortSignal` 给 `deps.gate.confirm(...)`，确保 `subagent_stop` 或父会话销毁时同步取消挂起的权限弹窗。

---

## 四、执行状态机 / 核心业务时序

### 4.1 Phase 1：点击运行中子代理卡片 → 只读查看 → 返回父会话
1. **派工阶段**：父会话调用 `subagent` → `runner.ts` 创建子会话并注册 `SubagentRunHandle` 到 `PiBackend.runningSubagents` → `traces.record` 始终落盘；`emitSubagentEvent` 仅当 `viewedSubagentId === childId` 时向渲染层推流。
2. **点击进入**：用户点击 `SubagentRunCard` → `openSubagentSession(filePath)` → `openSession` 校验路径（磁盘文件或 `runningSubagents` 活跃句柄）并返回 `meta`（`readOnly: true`）→ 记录 `subagent-return` 父子关系。
3. **订阅与基线防竞态**：
   - `useSessionsStore.subscribe` / `ensureOpenSession` 检测到进入 `readOnly` 会话 → 先开启该 `childId` 的渲染层事件缓冲 → 调用 `setViewedSubagent({ sessionId: childId })` → 调用 `getSessionHistoryWindow(childId)` + `getSessionNavigation(childId)`（后端同步调用 `sessionBranch(entry)` 读取 `runningSubagents` 实时内存分支，并附带 `live: { agentActive }`）。
   - 渲染层执行 `loadHistory`（按 `live.agentActive` 恢复忙碌态）→ 按序重放缓冲期间到达的实时事件 → 关闭缓冲。
4. **离开 / 返回父会话**：用户点击 `SubagentBackButton`（`←`）或切到其他会话 → `useSessionsStore.subscribe` 检测到离开旧 `readOnly` 会话 → 调用 `clearSessionHistory(previous)` + `setViewedSubagent({})` 停止推流 → 切回父会话（若父会话已被 GC 卸载则按 `parentFile` 重开）。

### 4.2 Phase 2：后台异步派工 → 父代理继续干活 → 跑完自动汇报
1. **派工**：父代理调用 `subagent({ ..., run_in_background: true })` → 同步校验 agent 定义、`confirmProjectAgents` 与参数合法性 → `BackgroundSubagentManager` 分配 `runId` 与独立 `AbortController`（不绑定父回合 `signal`）→ 预创建子会话 `SessionManager` 并注册到 `runningSubagents` → 异步启动 `withConcurrency` 执行队列 → **立即返回** `runId`、`sessionFile` 与初始 `running`/`queued` 状态。
2. **并行推进**：
   - 父代理拿到派工回执后，可在同一回合继续调用其他工具，或先向用户输出阶段性答复并结束当前回合；
   - 用户可随时点击卡片进入只读查看（走 4.1 时序），或由父代理调用 `subagent_status` / `subagent_stop`。
3. **完成收口与自动唤醒**：
   - 后台批次全部任务结算（`done` / `error` / `aborted`）→ `BackgroundSubagentManager` 汇总 `summary` 与截断结果 → 检查父会话仍存活且未销毁 → 调用父会话 `sendCustomMessage`（`customType: "percho-subagent-notification"`，`display: false`，`triggerTurn: true`，`deliverAs: "followUp"`）。
   - 若父会话正在跑其他工具 → 通知在当前回合末尾投递；若父会话已空闲 → 立即触发新一轮 LLM 回合，父代理自动向用户汇报结果。
   - 渲染层 `reducer.ts` 与历史回放 `messages.ts` 消费该 `custom` 消息，将原卡片从 `running`/`queued` 原地更新为终态，不产生多余气泡。

---

## 五、受影响文件与变更策略

| 模块 / 逻辑 ID | 目标文件路径 | 变更类型 | 核心策略说明 |
|---|---|---|---|
| **P1-Shared-IPC** | `packages/shared/src/ipc-channels.ts` | 修改 | `SESSION_CHANNELS` 新增 `setViewedSubagent` |
| **P1-Shared-Session** | `packages/shared/src/session.ts` | 修改 | `SessionHistoryWindow` 增 `live?: { agentActive: boolean }`；`SessionHoverLiveRun` / `SessionHoverRelationChild` 兼容 `queued` / `aborted` |
| **P1-Shared-Subagent** | `packages/shared/src/subagent.ts` | 修改 | 新增 `SubagentRunStatus`、`SubagentRunSummary`、`index`；`extractSubagentRuns` 兼容新状态与摘要 |
| **P1-Shared-Transcript** | `packages/shared/src/transcript/types.ts`、`reducer.ts`、`chat-rows.ts` | 修改 | `SubagentRunUi` 扩展状态/摘要/序号；`tool_execution_start` 区分前 4 个 `running` 与后续 `queued` |
| **P1-Shared-Hover** | `packages/shared/src/session-hover.ts` | 修改 | `collectSessionHoverLiveRuns` 兼容 `queued` / `aborted` |
| **P1-Backend-Policy** | `packages/backend/src/tools/subagent/policy.ts`、`prompt.ts`、`summary.ts` | 新增 | 边界策略（含 Windows 路径归一化）、按工具集区分的提示词、机器派生摘要 |
| **P1-Backend-Agents** | `packages/backend/src/tools/subagent/agents.ts` | 修改 | 保留 `BUILTIN_SCOUT`；解析 `permissionMode` 与 `deny`（含 `denyWarnings`） |
| **P1-Backend-Runner** | `packages/backend/src/tools/subagent/runner.ts`、`tool.ts` | 修改 | 注册 `SubagentRunHandle`、内部 `traces.record`、接入 `policy`/`summary`、保留 `agent` 必填与 `cwd`、槽位保序与 `queued`/`aborted` |
| **P1-Backend-Perms** | `packages/backend/src/permissions/bash-chain.ts`、`extension.ts`、`gate.ts` | 修改 | 接入 `subagentPolicy` 钩子与 `signal` 透传 |
| **P1-Backend-Core** | `packages/backend/src/pi-backend.ts`、`packages/backend/src/session/hover-relations.ts` | 修改 | `runningSubagents`、`viewedSubagentId`、`setViewedSubagent`、`emitSubagentEvent`、同步 `sessionBranch()`、未落盘活跃子会话打开支持 |
| **P1-Desktop-IPC** | `packages/desktop/src/main/ipc/sessions.ts` | 修改 | 注册 `setViewedSubagent` handler |
| **P1-Desktop-Stores** | `packages/desktop/src/renderer/src/stores/session-loading.ts`、`sessions.ts`、`transcript.ts`、`hooks/use-session-event-bridge.ts` | 修改 | `isReadOnly` 基线加载、`setViewedSubagent` 切换订阅、事件缓冲防竞态、`live.agentActive` 恢复 |
| **P1-Desktop-UI** | `packages/desktop/src/renderer/src/components/chat/SubagentRunCard.tsx`、`styles/globals.css`、`i18n/zh.ts`、`i18n/en.ts` | 修改 | 折中版卡片（真实 Agent 名 + 元信息 + 跳动三点胶囊）、`queued` 静止态、语义 token 与文案 |
| **P1-LAN-Plugins** | `packages/desktop/src/lan-web/src/components/SubagentCard.tsx`、`packages/desktop/resources/ui-plugins/percho-ui.d.ts`、`SPEC.md` | 修改 | 同步 `SubagentRunUi` 新状态与字段契约 |
| **P2-Shared-Notify** | `packages/shared/src/subagent-notification.ts`、`subagent.ts`、`transcript/reducer.ts` | 修改 | 新增 `percho-subagent-notification` 解析与原地更新卡片终态；`extractSubagentRuns` 支持 `mode: "background"` |
| **P2-Backend-Bg** | `packages/backend/src/tools/subagent/background.ts`（新增）、`tool.ts`、`runner.ts`、`pi-backend.ts` | 新增/修改 | `BackgroundSubagentManager`、`run_in_background`、`subagent_status`/`wait`/`stop`、`sendCustomMessage` 自动唤醒、GC/关闭/销毁守卫 |
| **P2-Backend-Replay** | `packages/backend/src/session/messages.ts`、`hover-relations.ts` | 修改 | 历史回放与悬停关系消费 `percho-subagent-notification` 更新终态 |
| **P2-Desktop-GC** | `packages/desktop/src/renderer/src/lib/session-gc.ts`、`use-session-gc.ts` | 修改 | 保护存在运行中后台子代理的父会话不被 GC 卸载 |
| **P2-User-Prompt** | `C:\Users\Administrator\.pi\agent\APPEND_SYSTEM.md`（实施时确认） | 修改 | 补充内置 `subagent({ run_in_background: true })` 适用场景指引 |

---

## 六、测试设计与验证（TDD 契约）

### 6.1 最窄测试与检查命令
- 后端子代理与权限单测：`npx vitest run packages/backend/test/subagent-*.test.ts packages/backend/test/permission-*.test.ts packages/backend/test/session-hover-relations.test.ts`
- 共享与桌面端单测：`npx vitest run packages/shared/src/*.test.ts packages/desktop/src/renderer/src/stores/subagent-return.test.ts packages/desktop/src/renderer/src/stores/transcript.test.ts packages/desktop/src/renderer/src/lib/session-gc.test.ts`
- 样式硬编码守卫：`python E:/输出项目库/Yu-AI工程/2-资产/skills/ui-spec/scripts/scan-hardcoded.py --config ui-spec.json`
- 全量类型与代码检查：`npm run typecheck && npm run lint`

### 6.2 RED → GREEN 关键断言契约
1. **Phase 1 RED → GREEN**：
   - **按需推流**：未调用 `setViewedSubagent` 时，子代理事件只写 trace 不向渲染层转发；调用 `setViewedSubagent({ sessionId })` 后立即转发，切走后停止转发。
   - **实时基线与防竞态**：运行中子代理打开时 `getSessionHistoryWindow` 返回内存实时分支与 `live.agentActive: true`；窗口请求期间到达的事件经缓冲重放不丢失；子代理结束后重开 `readOnly` 会话能读到磁盘最新完整分支。
   - **未落盘点击保护**：子代理刚创建尚未写盘时点击卡片，`openSession` 通过 `runningSubagents` 活跃句柄成功打开只读视图，不报 `ENOENT`。
   - **策略与 Windows 路径**：`policy.ts` 拦截对 `C:/Users/.../.pi/agent` 与 `C:\Users\...\.pi\agent` 的读写/bash 篡改；只读 git 白名单放行 `git status`/`git diff`，拦截 `git commit`/`git -c ...`；只读 agent 不注入编辑提示。
   - **折中版卡片与 UI 守卫**：`SubagentRunCard` 渲染真实 Agent 名（如 `Explore`）+ `.subagent-cap[data-state="running"|"queued"|"done"|"error"|"aborted"]`；`scan-hardcoded.py` 零违规。
2. **Phase 2 RED → GREEN**：
   - **后台派工即返回**：`subagent({ ..., run_in_background: true })` 在子代理完成前立即返回 `runId` 与 `sessionFile`，卡片保持 `running`/`queued` 且可点击进入只读查看。
   - **自动汇报与无假气泡**：后台子代理完成后触发 `sendCustomMessage`（`triggerTurn: true`, `deliverAs: "followUp"`）；`toSessionMessages` 与 `reducer.ts` 不生成聊天气泡，而是把原卡片更新为终态与 `summary`。
   - **GC 与销毁守卫**：父会话空闲但有后台子代理运行时，`closeSession(parentId, "gc")` 返回 `{ closed: false }`，渲染层 `selectGcCandidates` 不选中该父会话；`deleteSession` / `dispose` 会先中止并清理后台子代理。
   - **真实隔离验证**：Phase 1 与 Phase 2 完成后，分别在隔离 dev 环境（`PI_CODING_AGENT_DIR` 指向临时目录）跑通真实 Electron/CDP 交互验证（点击运行中子代理卡片 → 只读查看 → `←` 回父会话；后台派工 → 父会话继续响应 → 自动汇报更新卡片）。

---

## 七、实施步骤与验收清单（Checklist）

### 批次 A：Phase 1（上游差异补齐 + 折中版卡片）
- [ ] **步骤 1**：扩展 `packages/shared`（`ipc-channels.ts`、`session.ts`、`subagent.ts`、`session-hover.ts`、`transcript/*`）并补齐单测。
- [ ] **步骤 2**：新增 `policy.ts`、`prompt.ts`、`summary.ts`，更新 `agents.ts`、`runner.ts`、`tool.ts` 与 `permissions/*`（保留 `scout` 与 `cwd`，补 Windows 路径归一化）。
- [ ] **步骤 3**：更新 `PiBackend`（`runningSubagents`、`setViewedSubagent`、`emitSubagentEvent`、同步 `sessionBranch()`、未落盘活跃句柄打开）与 `main/ipc/sessions.ts`、`hover-relations.ts`。
- [ ] **步骤 4**：更新渲染层 `session-loading.ts`、`sessions.ts`、`transcript.ts`、`use-session-event-bridge.ts`（`readOnly` 基线加载 + 事件缓冲防竞态 + 切换清理）。
- [ ] **步骤 5**：更新折中版 `SubagentRunCard.tsx`、`globals.css`、`i18n`、`lan-web/SubagentCard.tsx` 与 `ui-plugins` 类型声明。
- [ ] **步骤 6**：运行 Phase 1 定向单测、`scan-hardcoded.py`、`typecheck`、`lint` 与隔离实机验证，确认通过后提交 Phase 1。

### 批次 B：Phase 2（内置 `subagent` 后台异步派工 + 自动汇报）
- [ ] **步骤 7**：扩展 `subagent-notification.ts`、`subagent.ts`、`transcript/reducer.ts`、`session/messages.ts`、`hover-relations.ts`，支持 `percho-subagent-notification` 原地更新卡片与历史回放。
- [ ] **步骤 8**：实现 `BackgroundSubagentManager`（`background.ts`），扩展 `subagent` 工具支持 `run_in_background` 并新增 `subagent_status` / `subagent_wait` / `subagent_stop`。
- [ ] **步骤 9**：在 `PiBackend` 接入后台管理器、`sendCustomMessage` 自动唤醒、GC/关闭/销毁守卫与权限 `signal` 透传；同步更新渲染层 `session-gc.ts`。
- [ ] **步骤 10**：运行 Phase 2 定向单测、全量 `typecheck` / `lint` 与隔离实机验证（含后台派工后继续对话 + 跑完自动汇报 + 只读查看 + 回父会话），确认后按用户指示更新 `APPEND_SYSTEM.md` 并收口。
