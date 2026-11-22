# pi SDK 集成

适用于 SDK 接入、升级和生命周期/上下文问题。以下反直觉行为按当前钉住的 **1.5.1** 整理（2026-11-15 随 P1 切换，固定上游 v0.6.8=`87476fa`；1.0.4 时代条目以 P1 重核为准，见 [升级计划§19](PLAN-sdk-1.5.1-upgrade.md)），升级时必须重核，不当作永久 API 保证。生产适配边界见 [架构](architecture.md)。

## 接入与资源所有权

- `pi-backend.ts` 是门面，`project/builtin-extensions.ts` 负责官方内置扩展接入；`Model` / `ThinkingLevel` 类型从 `@earendil-works/pi-ai` 导入。
- 扩展 UI 用 `session.bindExtensions` 注入，目前主会话绑定 `mode:"rpc"`，不依赖权限门开关。实际可用能力见 [扩展 UI](extension-ui.md)，不能宣称完整 TUI 兼容。
- **`AgentSession.dispose()` 不发送 `session_shutdown`**。官方 MCP 扩展依赖该事件关连接，单独 dispose 会遗留 stdio 子进程。复用 `session/shutdown.ts` 的公开 API 桥接，先 shutdown 再 dispose。
- 普通关闭需等待清理并保留首错；退出钩子不等异步完成，必须有同步兜底；注册冲突只能拆掉新构造实例，不碰旧 holder。修改时核对 `session/registry.ts` 与现有 shutdown/dispose 回归，不依赖 app 最后退出替每个会话收尾。

## 模型与工具

- `getAvailable()` 受凭证影响，可能是空数组，不能当完整模型目录；具体查询与目录刷新复用现有 runtime/settings 入口。
- `runtime.refresh()` 默认可能联网，本地读取应显式 `allowNetwork:false`；联网刷新由宿主选择时机并约束等待，不因普通列表读取隐式触网。
- Google Vertex 不接受 API key，使用 ADC/服务账号；OAuth/登录桥接复用 `settings/login.ts`，不要向用户提供已知必败路径。
- `createAgentSession({tools:[...]})` 的数组是允许清单，可能把扩展工具过滤掉；不要把“只想补几个内置工具”误写成不完整清单。
- 同名工具有不同优先层：`replaceable` 表示让位，双方非 replaceable 时同组先注册者胜，`customTools` 又可覆盖扩展工具。不要只调整 inline 扩展注册顺序来实现“内置优先”；复用 `tools/subagent/mutex.ts` 的既有方案。
- `getAllTools()` 属于工厂闭包的 `ExtensionAPI`，不在 handler 的 `ctx` 上；权限声明读取不要猜工具来源或默认信任 MCP。
- 工具参数 schema 保持顶层单 object；顶层 Union/Intersect 可能被 provider 拒绝。

## 持久化、上下文与回放

- **`sessionFile` 是计划路径，不是已落盘证明**。SDK 可在创建时分配路径，首条会话消息后才写文件；判断磁盘存在性需实际检查。零消息会话可以在内存中合法改名，也可能不在磁盘 listSessions 结果里。
- **1.5.1 本地适配补充（2026-11-14）**：backend `listAllSessions` 合并仍在 registry 的会话，避免首发失败的 held/recovering 项在 renderer 重载后失去入口。`openSession` 仅在精确匹配已注册实例且路径可信时重接同一 runtime：存在文件继续 realpath 校验；缺失文件仅允许普通、可写、从未 flush 的会话计划且父目录受控。判定用到当前 SDK `isPersisted()` / `flushed` / `_hasConversation()`，后两项为私有实现，升级必重核。回归见 `test/session-live-catalog.test.ts`，涵盖真实 symlink/junction 和已落盘后删除；此机制不是崩溃或进程重启恢复。
- UI 完整历史从 SessionManager 当前分支读取，不能读已压缩的 `session.messages`；todo 等历史工具结果也不能从压缩上下文恢复。
- compaction entry 可按分支顺序回放，但不保存触发原因和压缩后估值，历史 UI 不伪造这些字段。
- 请求上下文由 SDK projection 重建，手写 `agent.state.messages` 不构成可靠修改；撤回中绕过 `navigateTree` 的路径需要 `session.refreshContext()`，保持公开投影一致。
- 追加宿主系统提示要用 `appendSystemPromptOverride` 合并 SDK 发现的 APPEND_SYSTEM.md，而不是覆盖文件发现。主会话与子代理保持同一信任规则，回归见 `test/append-system-prompt.test.ts`。
- `sendUserMessage` 的 followUp 可能等当前 turn 结束才投递。跨会话唤醒不能把“已排队”当“对方已处理”，频道协作以 post、持久游标和恢复屏障为准。

## 流式、附件与压缩

- SDK 流式事件可能夹带累积全量快照。backend `session/event-slim.ts` 在单点瘦身，`stream-guard.ts` 负责异常流熔断，trace 自身也有体积边界；不要把巨量快照逐事件复制到 IPC/日志。
- 带图发送时 SDK 可能在构造 user message 前先缩放图片，导致 UI 等待。发送侧用 shared `transcript/pending-user.ts` 乐观回显，并由权威事件认领；附件在 renderer `lib/image-attachment.ts` 预处理，不伪造 SDK 用户消息。
- 压缩摘要也是模型请求，**其输入本身必须有界**，不能只依赖原会话的自动触发阈值。复用 `tools/compaction-guard/` 的百分比触发、输入上限和退避，不另造只看绝对余量的触发器。
- 压缩来源标记覆盖配对的开始/结束事件，不在更早的中间事件清理，否则结束文案会把自动覆盖成手动。
- 蒸发与压缩护栏各自拥有配置与纯函数核心；调参使用 `scripts/replay-evaporation.mts` / `replay-compaction-bound.mts`，不要复制一份近似线上算法来证明线上正确。

## MCP 运行态与 Code Mode（1.5.1 本地适配）

Percho 继续使用 SDK 1.5.1 的 `createMcpExtension`、`createCodemodeExtension` 与 `createToolSearchExtension`；它们负责发现和实际调用，宿主只做配置、权限、状态投影与 UI。后端依赖精确锁定 `@earendil-works/pi-mcp@1.5.1`，避免安装树意外漂移。

- SDK MCP observer 通过 `onStatus` 推送 `starting` / `running` / `closed` 快照，细化每台 server 的 `connecting`、`connected`、`failed`、`disconnected`、`needs-auth` 等状态、工具清单和诊断。错误回调不得破坏连接生命周期，工具库存也不能替代连接状态。
- `McpRuntimeStore` 按每次 SDK 扩展装载的 owner 绑定一个 session 实例；完整事件带 `epoch + revision + instances`，实例包含 `instanceId/sessionId/cwd`。关闭时撤销实例，忽略已失效 observer 的迟到快照。renderer 以配置文件来源路径和选定实例投影状态，不从 `mcp__...` 工具名猜 server 身份。
- MCP 配置增删改/导入只原子写入配置，不重载或中断已有会话；成功后置 `restartRequired`，需要重启 Percho 生效。需要即时恢复某台连接时，调用 SDK 对所选实例执行原生 `/mcp reconnect <name>`；不发模型请求、不重载整会话。OAuth 登录同样走 SDK `/mcp login`。
- MCP exposure 只接受 SDK 定义的 `deferred`、`codemode`、`direct`、`hidden`。非法旧值在面板保留并诊断，不静默保存为其他模式。
- Code Mode 默认启用；其权限门默认 `allow`，因为它是代码执行容器，但执行脚本内每个实际工具仍各自通过原有权限规则和项目边界。`tool_search` 默认放行只允许搜索/激活工具声明，不等价于授权调用 MCP 或其他工具。用户可独立关闭 Code Mode 或启用独占模式；这两项配置不覆盖用户已有的默认工具选择。
- SDK Patch 除原有 Percho 自研修改外，额外导出 MCP 状态快照与配置校验入口；`patches/@earendil-works+pi-coding-agent+1.5.1.patch` 是源码真源，node_modules 仅是 patch-package 生成结果。
- **重开旧会话要补激活 `codemode`**：有转录记录的会话以转录里的工具集为准（`defaultTools` 只对内置工具生效），而 `codemode` 以 `defaultActive:false` 注册，所以旧会话完全拿不到它，独占模式（靠 `prepareLoadout` 隐藏其他声明）也跟着失效。后端在装配后调用 `ensureCodemodeActive()` 校正，不靠用户重选工具。
- **`/mcp reconnect` 与 `/mcp login` 只在空闲会话执行**：忙碌时 `prompt()` 会把维护命令排进用户消息队列（污染可见历史）而调用方已报成功；后端先要求 `isIdle`，再取空闲租约确认没有并发切换。
- **同名工具的可替换性**：内置扩展标 `replaceable`，第三方可顶掉 `tool_search` 等并注册同名工具。权限声明层必须同时核对名字与 `sourceInfo.path`（`builtin:` 前缀），只认名字等于让第三方工具跳过确认。
## SDK 升级清单

> 💡 **【核心结论 / 决策要点】** 本节是升级要点速查；完整的阶段门、分片测试、命令模板与切换判定见 [SDK 升级迁移与验收手册](SDK-UPGRADE-PLAYBOOK.md)（沉淀自 1.0.4 → 1.4.0 → 1.5.1 实践）。

1. 核对依赖实际解析版本：`PI_PACKAGE_DIR` 可影响 SDK 导出的 VERSION，不能据它判断 node_modules 的版本；参考 `scripts/smoke-sdk-1.0.mts` 的 `import.meta.resolve` 检查。
2. 阅读目标版本类型与实现，重点核对扩展生命周期、工具优先级、上下文/压缩形状和持久化时机；typecheck 通过不代表行为未变。
3. 核对 `patches/`：当前 SDK 补丁提供 `retryLastFailedTurn`。升级先查官方是否已有等价入口，再评估补丁，不能悄悄丢掉能力。
4. 手动重试复用 SDK 原恢复生命周期，不重发用户任务，也不只调用底层 continue；验证失败响应身份、busy 状态与 live/replay 的定位一致性。
5. 跑 `smoke-sdk-1.0.mts`（升级后按实际版本更新口径）、全量 typecheck/test，以及相关专项冒烟；含真实网络/凭证的脚本先读文件头，不自动拿用户凭证执行。
6. 构建并核对随包 SDK 资源、preload 与原生依赖，见 [构建发布](build-release.md)。

> ✅ **【2026-11-15 更新：GC宿主租约竞态已确证修复（升级计划§19.14）】** 此前记录的竞态已定向复现并最小修复：`closeSession` 仅 `intent="gc"` 在首个 await 前同步 `tryAcquireIdleLease()`——无租约返回 `{closed:false}`，有则 `try { await disposeSession } finally { lease.release() }`；`user`/`delete` 路径不取租约、行为不变。独立PASS：目标65/65、backend1102/1102、desktop1412/1412、3套strict/typecheck/lint过。边界：`cacheWarming:"idle"` 预热 pending 期间 GC 会被延后（`closed:false`），off 后可 GC；30分钟空闲安全上限的持续重排仅源码静态确认，非长时实测；旧 G1/G6 候选与包不含此修复，后续候选需重冻结并经 GitHub fresh CI 取证。
