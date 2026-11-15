---
类型: 修复方案
状态: 本地修复包已交付，待退出后安装与历史恢复
创建: 2026-10-30
更新: 2026-10-30
适用: Percho v0.7.5 会话悬浮关系、codemode 嵌套子代理及历史恢复
---

# 嵌套子代理关系修复：记录真实执行关系，而非依赖外层工具回执

> **创建日期**：2026-10-30
> **状态**：2026-10-30 用户批准实施及本地打包安装准备；修复安装包和双击脚本已交付，实际安装与真实历史 apply 尚未执行
> **关联版本**：v0.7.5 / HEAD bde45fa；后续版本号不在本方案预定
> **任务真源**：用户反馈正式版 1029 会话悬浮子代理缺失，并询问如何修复；前置诊断见 `.local/agent-work/probe/hover-1029/replay-results.json`。本文的代码实施、本地打包安装准备已获批准；不包含公开发版。用户退出宿主后通过交付脚本安装，并确认本次扫描清单后恢复历史。

## 一、目标与阶段边界

### 目标

1. 内置 `subagent` 经 `codemode` 调用后，父会话悬浮卡能显示真实子会话、任务及终态，并沿用原有打开入口；正常完成后重启、父会话未加载时仍可查询。
2. 同时兼容经 SDK 嵌套调用的插件 `Agent`：保留完整派工身份，复用现有插件目录与身份校验，不假装其结果自带 sessionFile。
3. 对 1029 历史记录提供一次性、证据驱动的恢复工具；只有明确调用 ID、真实事件回执和有效子文件相互吻合才生成恢复记录。
4. 直接 `subagent`、直接 `Agent`、六条分页、隐藏数量、撤回、缓存和安全路径校验不退化。

### 非目标及授权边界

- 不改 SDK、codemode 沙箱、第三方插件或模型调用策略；不新增数据库、全局关系索引和常驻扫描服务。
- 不要求模型绕开 codemode；临时直接调用只能作为缓解，不作为验收通过条件。
- 不将未知 PiFlow `run_agent/run_workflow` 当作已有适配；另需实际协议证据。
- 不改聊天卡视觉；本次修父悬浮发现关系，不扩大到所有子代理 UI。
- 不新增内置子会话的冷启动反向父指针。由父悬浮进入子会话后的现有返回路径保留，内置子会话独立重启后反查父会话另案处理。
- 持久化以子工具完成事件为准；进程在完成事件前被强杀不承诺恢复未完成关系，进行态继续使用现有实时事件。
- 已批准开发、测试、恢复只读报告及本地修复包和安装脚本准备；**真实历史写入仍需用户确认当次清单，并关闭所有读取目标 agentDir 的 Percho/CLI 会话**。不自动 commit/push/tag 或公开发版，不在当前宿主运行时替换安装文件。

## 二、现有实现定位

### 2.1 可复用能力

| 能力 | 定位与事实 |
|---|---|
| 当前分支及有界读取 | `packages/backend/src/session/hover-history.ts`；内存与文件共用树校验，8 MiB 历史预算 |
| 子结果提取 | `packages/shared/src/subagent.ts::extractSubagentRuns`；内置 results / completions 与插件扁平 details |
| 关系合并、安全打开、分页 | `hover-relations.ts`、`subagent-paths.ts`；内置与普通 sessions 目录分别校验 |
| 插件身份关联 | `pi-subagent-relations.ts`；派工完整 ID、父路径、初始命名、时间窗、唯一性联合校验 |
| 内联扩展接线 | `pi-backend.ts::buildExtensionFactories`，参考 `tools/todo-reminder.ts` |
| 非模型上下文持久化 | SDK `pi.appendEntry(customType,data)`；会话 JSONL 的 custom entry 随当前分支保存 |
| 嵌套执行事件 | SDK `dist/core/nested-tool-calls.js`：start/update/end 带 parentToolCallId；end.result.details 保留真实子结果 |
| 旧日志 | `session/trace.ts`、`event-slim.ts`；trace 保留 details，但有轮转、截断及丢失边界 |
| 缓存 | `stores/session-hover-preview.ts` 与 `SessionHoverProvider.tsx`；既有 transcript 变化失效、30 秒成功 TTL |

已完整核对当前 SDK 的 `docs/codemode.md`、`docs/extensions.md`、`docs/sdk.md`、`docs/session-format.md` 及相关执行源码、内联扩展示例。SDK 明确：嵌套结果不写 transcript；`nestedCalls` 只记录名称、参数、状态等，**不记录结果**。

### 2.2 不能直接复用/需重构的部分

- 外层 `codemode` 的 `details.calls` 不是子会话关系；简单递归解析无法找回从未保存的路径。
- `projectHoverRelations` 只遍历 message/toolResult；须增加一个明确版本的 custom 来源，而不是扫描任意 JSON 字段。
- `extractClaims` 只认顶层 Agent 调用和回执；须允许同等严格的嵌套派工声明输入，不能放宽原身份规则。
- 内置 runner 未写父指针，不能从旧子文件名或创建时间推断唯一父关系。
- 不在每次悬浮时读取大体积 trace。trace 只供显式离线恢复，不成为正常 UI 查询依赖。

### 已取得的历史恢复线索（不是已写入或最终验收）

2026-10-30 只读扫描当前分支调用 ID 与同父 trace 的完成事件；下表仅为回执引用及文件存在性检查，正式 dry-run 还须执行真实路径、文件身份及冲突验证。

| 1029 会话 | 当前分支 subagent 调用 | 匹配完成事件 | 回执引用的现存子文件 |
|---|---:|---:|---:|
| 悬浮关系方案 | 13 | 10 | 13 |
| 上下文压缩对比 | 3 | 3 | 4 |
| 改名后持续思考修复 | 4 | 4 | 4 |
| 消息插队打断（用户截图） | 12 | 12 | 15 |
| v0.7.5 封板构建 | 6 | 6 | 6 |

共找到 42 个会话内子文件引用；一次调用可并行创建多个子会话。长会话最早 3 次调用没有找到完成事件，不作时间/名称猜配。trace 中有 gap 标记，不能宣称完整日志或覆盖全部历史。

## 三、架构决策

### 3.1 推荐：一条会话内的最小关系记录

采用内联扩展在真实 `tool_execution_end` 事件中记录**嵌套** subagent / Agent 关系。直接调用继续消费原始 toolResult，避免双写。不等待外层 codemode 成功；外层后续抛错不会抹掉已完成子派工。

不采用“临时收集后塞入外层 details”作为唯一真源：它增加对外层结算路径的依赖，历史恢复仍需要额外记录。新旧统一使用下面的 custom 协议更小、更一致。

记录类型：`percho.subagent-relation.v1`。逻辑字段：

```ts
type RelationRecordV1 = {
  version: 1;
  origin: 'runtime' | 'trace-recovery';
  parentSessionId: string;
  parentSessionFile: string;
  anchorEntryId: string;     // 根 assistant 消息的 entry ID
  rootToolCallId: string;    // transcript 中真实存在的外层调用 ID
  toolCallId: string;        // 嵌套调用 ID
  parentToolCallId: string;  // SDK 明确提供的直接调用者 ID
  toolName: 'subagent' | 'Agent';
  startedAt: number;
  finishedAt: number;
  // toolName=subagent：只保留最小子项数组，不保存完整 result/content/usage。
  runs?: Array<{ agent: string; taskFirstLine?: string; sessionFile: string; exitCode?: number }>;
  // toolName=Agent：与 runs 互斥，保存已验证的派工声明，不伪造 sessionFile。
  claim?: { agentId: string; subagentType: string; description: string; status: string };
};
```

- `runs` 与 `claim` 必须与工具名对应；畸形、未知版本、矛盾记录不认领。
- Agent 的 `resume` 非新建，不记为新关系；新建须有开始时的 subagent_type 与结果 subagentType 一致，以及现有校验认可的完整 agentId。
- 内置任务首行复用现有安全投影；单文本字段上限 4 KiB UTF-8，超限省略描述不截成伪完整任务。ID/路径字段上限 4 KiB，超限拒绝该记录；每条最多 8 个内置子项、记录总计最多 64 KiB。
- 不复制子代理输出、prompt、usage、工具清单或任意 details；避免 JSONL、IPC 和日志重复膨胀。
- 相同 `(parentSessionId, anchorEntryId, rootToolCallId, toolCallId)` 幂等。相同身份而引用互相冲突时拒绝，不能任取最后一条。

### 3.2 分支、并发与失败规则

1. 开始事件建立每会话的调用归属链；根调用必须从当前分支 assistant.content 中精确找到，不执行/解析 codemode 源码，也不仅靠 ID 字符串截断猜父。
2. 嵌套中间层只保存 ID 与根锚点映射；结束移除活动状态。最多 512 个活动映射、最大深度 16；超限告警并不记录该链，不无界增长。
3. subagent/Agent 保存必要的开始元信息；不保留整份任务参数。完成事件使用真实 result.details。失败结果若仍含有效子文件，应保留为失败关系；无文件不得制造可点击入口。
4. append 前再次确认同一父会话、根 assistant 与根工具仍在当前分支。最终校验到同步 append 之间不得 await；会话切换/锚点撤回则跳过并告警。
5. 查询同时要求 custom entry 本身与锚点均在当前分支，父 id/file 与查询身份一致。恢复记录追加在末尾也不能复活已撤回的原始派工。
6. reload、session_shutdown、agent_settled 清理瞬态映射；不得在 settled 写入。记录失败只发明确日志，不改变已经执行过的工具成功/失败状态，更不能重跑子代理。
7. 磁盘与内存解析共用一份校验；合并后沿用安全文件检查、去重和分页。内部排序锚定原始外层 toolResult 的分支位置（尚无结果时用根 assistant 位置），同根按 finishedAt、toolCallId 稳定排序；恢复追加顺序不能把旧派工变成最新。

### 3.3 插件路径与既有行为

- 将 `pi-subagent-relations.ts` 的直接 Agent 声明提取与“声明→文件解析”分离，嵌套记录提供同等字段；依然检查 parentSession、初始命名、ID、目录、时间窗和唯一性。
- 继续使用同分支 `subagents:record` 的明确终态扩展后台时间窗；没有证据的后台关系不硬配。
- 外层/内层 ID 不得当 session UUID；不放宽普通 sessions 与 sessions-subagents 白名单。
- 不增加悬浮 DTO 或 IPC。完成事件先经过扩展写记录，再转发现有事件供 transcript/悬浮缓存失效；须用集成测试确认这一时序。若现有 transcript 失效判定漏掉嵌套完成，针对该事件补判定，不新增定时扫描。

### 3.4 旧数据恢复：显式离线、备份、可撤销

恢复工具仅接受明确父文件清单；默认只读。阶段一只实现内置 subagent 的历史恢复，插件历史仍走原协议，不把无完整 agentId 的记录强行迁移。

- 按父目录的 `traces/trace-<完整父ID>[.<归档时间>].jsonl` 精确选择文件；最多活动文件加 5 个归档、总计 160 MiB，逐行读取，单行上限 2 MiB；超限/坏行/gap 必须写进报告，不能当全覆盖。
- 以当前分支根工具 ID、父结果中记录的内部调用 ID及工具名，对照 trace 的 parentToolCallId/toolCallId；不能仅靠 task、角色或时间相似度。
- 同调用重复回执须一致；同 childFile 被不同父/调用冲突认领时列为冲突，不自动修复。
- 对候选执行真实路径白名单、jsonl 普通文件、header.id 与文件名一致、有效 cwd/时间和回执来源检查。子 cwd 可与父不同（工具允许指定 cwd），应与可靠调用输入一致；没有完整输入时仅据路径存在不能升级为已验证。
- 报告包含：父文件 hash/leaf、trace 文件 hash、候选引用、证据行定位、遗漏/拒绝/冲突、可应用数量和拟追加记录；输出不是修改授权。
- `--apply <已审查报告>` 前必须关闭目标数据目录的全部宿主；重新验证全部 hash、leaf、路径和候选。任何变化拒绝该父文件，重新生成报告，不用旧清单覆盖新内容。
- 每父文件先保存原始字节备份和校验清单，再同目录临时文件写入“原文件原样 + 新 custom 行”，校验完整树后原子替换；保留旧正文及条目 ID。各父文件独立事务，部分失败明确列出，不宣称全部成功。
- 幂等记录存在时不重复追加。恢复后分别验证原始消息内容及数量未变、悬浮结果可见；回滚仅在修复后未产生新会话写入且 hash 匹配时恢复备份，否则停止人工处理。

## 四、执行状态机 / 核心业务时序

### 新派工

`根调用已在当前分支 → 记录嵌套归属/开始信息 → 子工具真实执行 → 完成事件提取最小关系 → 同步复核分支 → append custom → 现有事件转发/缓存失效 → 悬浮解析并校验文件 → 分页/打开`

外层失败不会回滚已写关系。锚点撤回后关系不可见；历史读取不以旧 realtime/transcript 复活旁支。

### 旧历史

`用户选父文件 → 只读扫描/精确交叉验证 → 报告 → 用户确认写入清单并关闭宿主 → hash 复核 → 备份 → 追加 custom 原子替换 → 消息不变验证 + 悬浮重放 → 用户重开正式版验收`

应用前状态变化、预算不足或证据歧义均停在报告，不猜测补全。

## 五、受影响文件与变更策略

| 模块 / 逻辑 ID | 目标文件路径 | 变更类型 | 核心策略说明 |
|---|---|---|---|
| 关系协议 | `packages/backend/src/session/subagent-relation-records.ts` | 新增 | 版本化有界解析、锚点与幂等校验，运行与恢复共用 |
| 事件记录 | `packages/backend/src/tools/subagent-relations.ts` | 新增 | 每会话内联扩展，仅捕获支持的嵌套派工 |
| 接线 | `packages/backend/src/pi-backend.ts` | 修改 | buildExtensionFactories 注册，不改执行器选择 |
| 悬浮投影 | `packages/backend/src/session/hover-relations.ts` | 修改 | 新旧来源统一归属、排序、校验、去重 |
| 插件识别 | `packages/backend/src/session/pi-subagent-relations.ts` | 修改 | 分离声明提取，接受可信嵌套声明；保留安全约束 |
| 缓存失效 | `packages/desktop/src/renderer/src/components/sidebar/SessionHoverProvider.tsx` | 必要时修改 | 只补嵌套完成的失效判定，不换 UI/缓存机制 |
| 恢复核心 | `packages/backend/src/session/subagent-relation-recovery.ts` | 新增 | 流式 trace 检查、报告、hash/备份/幂等/事务 |
| 离线入口 | `scripts/recover-session-subagent-relations.mjs` | 新增 | 默认 dry-run；复用 esbuild 临时打包后端恢复模块，显式 apply，不依赖全局 TS 运行器 |
| 回归 | `packages/backend/test/subagent-relation-records.test.ts`、`subagent-relations-extension.test.ts`、`subagent-relation-recovery.test.ts` | 新增 | 单测、真实 SDK 嵌套事件集成、恢复 fixture |
| 现有回归 | `session-hover-relations.test.ts`、`pi-subagent-relations.test.ts`、相关 renderer hover tests | 修改 | 混合来源、分支、分页、安全、缓存断言 |

## 六、测试设计与验证（TDD 契约）

### RED

- 真实 SDK codemode 执行确定性测试子工具：子结果有 sessionFile，外层 details 无该路径；旧后端查询应无关系，新断言失败。
- 不调用付费模型即可测试 SDK 调用链；临时子 JSONL 必须合法，不能只 mock 最终悬浮 DTO。
- 历史 fixture 含主 JSONL 和 trace 完成事件，旧解析无关系，恢复报告应找到唯一候选；重复回执、旁支、坏路径则不应命中。

### GREEN 必测矩阵

1. 直接与 codemode 内置派工、单次并行、多外层工具并发、多层 SDK 嵌套；归属不串、重复不多计。
2. codemode 内层完成后外层抛错/取消，已完成关系仍在；失败但文件存在可打开，无文件拒绝。
3. 撤回、重新发消息、压缩、关闭重开、父未加载；新旧同源，旁支不复活。
4. 嵌套 Agent 完整声明与现有插件真实协议；resume、缺字段、名称冲突、后台终态边界保持保守。
5. 真实路径/符号链接越界、header/file ID 错、畸形字段、未知版本、每条及历史预算、映射清理和记录失败。
6. 6+3 分页、旧直接调用与新记录混合、导入顺序不改变原派工顺序、缓存失效与在途旧响应不覆盖新关系。
7. 恢复 dry-run 零写入、trace 轮转/缺失/gap、主文件或 trace 变化拒绝 apply、备份校验、幂等、原子失败、消息原样保留与受限回滚。

### 命令与实机门

```bash
npm exec --workspace packages/backend -- vitest run test/subagent-relation-records.test.ts test/subagent-relations-extension.test.ts test/subagent-relation-recovery.test.ts test/session-hover-relations.test.ts test/pi-subagent-relations.test.ts
npm run typecheck --workspaces
npm run test --workspaces --if-present
npm run build -w packages/desktop
```

- 修改 TypeScript 后做 changed-path LSP；无覆盖不当作 clean，用 tsc 补足。
- 开发版实机：真实只读 subagent 经 codemode 派工，核对父悬浮、点击、失败场景、重启后悬浮；不得只验演示直接调用。
- 如后续另获打包/安装授权，再核对包内逻辑与安装版真实会话。构建通过不等于正式安装版已验收。
- 本轮方案阶段未运行这些新增测试，也没有执行恢复写入；前轮既有两个测试文件 22 项通过不代表新功能通过。

## 七、实施步骤与验收清单（Checklist）

- [x] 用户明确批准本方案后开工，保留未跟踪 HANDOVER.md；不混入无关改动。
- [x] 用实际 SDK 嵌套事件建立回归，确认 append 先于嵌套及外层完成事件；测试隔离使用确定性模型流，不调用付费服务。
- [x] 实现有界关系协议、事件扩展、当前分支锚点验证及两条既有解析链的接入。
- [x] 运行最窄测试、独立验证、LSP/tsc、全量回归和开发构建；详见下文验证边界。
- [x] 完成真实 codemode 派工的失败路径、悬浮/只读跳转/返回、父卸载和开发进程重启后验收；成功路径由真实 SDK 确定性集成测试覆盖。
- [x] 实现离线恢复工具，对上述五个父会话输出 dry-run，报告确切可恢复数与缺失项。
- [ ] 用户确认历史写入清单、关闭目标宿主后，另行执行备份和 apply；完成后校验原消息与恢复关系。
- [x] 获得本地打包安装准备授权，交付修复安装器、默认只读扫描/确认恢复脚本及操作说明。
- [ ] 用户退出宿主后安装修复包，完成安装后真实悬浮验收；公开发布仍须另获授权。

## 八、实施验证记录（2026-10-30）

### 已验证

- **全量回归**：backend 96 个文件、989 项；desktop 103 个文件、1362 项；共 **2351 项通过**。完整输出：`.local/agent-work/probe/hover-1029/full-tests.log`。
- **首轮类型/构建**：`npm run typecheck --workspaces` 与 `npm run build -w packages/desktop` 通过；当时只生成开发产物。构建日志：`.local/agent-work/probe/hover-1029/build.log`；后续本地安装包见 §九。
- **静态检查**：`git diff --check` 通过；定向 Biome 格式整理无错误，仍有提示/警告，不标为零告警。主动 LSP 检查 6 个变更源码路径，1 个确认 clean、5 个 inconclusive、0 个诊断；后者由已通过的 tsc 补证，不能伪称全部 LSP clean。
- **独立验证**：最终 verifier 返回 PASS，覆盖恢复协议、fixture apply/rollback 与真实 reducer 缓存断言。前一轮“嵌套 Agent 不更新 subagentRuns”审查结论经真实 reducer 测试证伪，最终复验已撤回。
- **恢复 dry-run**：`.local/agent-work/probe/hover-1029/recovery-report-v2.json`；35 条调用记录、42 个已核验子文件，分会话为 13 / 4 / 4 / 15 / 6；缺最早 3 次调用的 start/end，12 个 trace gap 已逐条列示。原先 `recovery-report.json` 是初版工具的过时报告，不用于 apply。
- **真实开发宿主**：新父会话 `01a18ad2-e4fa-72a4-802e-b634ac9ccc52` 位于 agent-dev，不是 1029 原文件；真实调用 codemode → 内置 scout，生成真实子 JSONL 和 relation custom entry。悬浮显示、点击内置只读子会话、正确返回父会话、父卸载后磁盘查询及返回均通过；正常退出开发进程后重启，六项再次通过。
- **实机证据**：`.local/agent-work/probe/hover-1029/runtime-parent.json`、`runtime-preview.json`、`runtime-ui-checks.json`、`runtime-hover.png`；检查脚本为同目录 `dispatch-real.mjs`、`verify-runtime-ui.mjs`、`start-dev.mjs`。

### 实机限制与未执行事项

- 实机子模型遇到 `OAuth refresh failed for antigravity: fetch failed`，因此此轮真人模型派工是**失败路径验收**：错误状态仍能持久显示和打开。没有修改认证或模型配置，也不把这次业务执行称为成功。正常成功路径、外层失败/取消、并发、多层、插件 Agent 及重开由真实 SDK + 确定性模型流的集成测试覆盖。
- 恢复工具当前仅迁移父 codemode 回执里明确记录的一层内置 subagent；更深历史包装不猜配，运行时新关系支持最多 16 层。恢复扫描还限制保留证据 8 MiB、最多 1024 个 gap；超限在报告中明示并保守拒绝该父的恢复。
- apply / rollback **只在临时 fixture 中执行**；五个真实父文件未写入。真正 apply 前须重新生成/审查报告，确认宿主关闭并复验 hash，不能把本报告当长期有效的写入许可。
- 未 commit/push/tag、未发布、未替换安装版、未新增内置子会话冷启动反向父指针，未扩展 PiFlow 兼容。

## 九、本地安装交付（2026-10-30）

- **交付目录**：`C:/Users/Administrator/Desktop/Percho-会话关系修复-20261030`。包括 `00-只读扫描.cmd`、`01-安装修复版.cmd`、`02-扫描并恢复旧关联.cmd`、`repair.ps1`、`repair-manifest.json`、`SHA256SUMS.txt` 及 `请先阅读-安装与恢复.md`。
- **安装器**：`Percho-0.7.5-hoverfix-20261030-x64.exe`，175554926 字节。仍为版本 0.7.5，独立元数据 `perchoRepairBuild=hover-relations-20261030`；没有修改版本真源、创建 release/tag 或上传资产。
- **构建过程**：先重新 `npm run build -w packages/desktop`；首次打包因 Electron 下载连接中断失败，改用本机已验证的 `node_modules/electron/dist`（43.3.0，与构建声明一致）完成 Windows x64 NSIS 打包。参数显式 `--publish never`，输出独立目录，不覆盖以前的安装器。
- **包体核验**：asar 内修复协议、扩展 factory 和 buildId 存在；asar 主进程脚本与编译输出 SHA-256 一致。安装器和 asar 的哈希已写入交付 manifest；证据 `.local/agent-work/probe/hover-1029/package-verification.json`。
- **打包产物冒烟**：直接启动 win-unpacked 中的程序，使用独立 user-data/agent 目录，真实窗口和预加载 API 可用，随后正常退出。未调用模型；证据 `package-smoke.json`，不是安装器交互/覆盖安装验收。
- **双击脚本**：源码 `scripts/windows-repair-launcher.ps1`；Windows PowerShell 5.1 原生 Parser 通过。默认 Scan，非交互只允许只读；Install/Recover 检查未退出的宿主并拒绝强杀。Recover 额外校验安装 asar、49 个仓库依赖源文件，先扫描，再要求精确输入 `RESTORE`，写前重新复核进程、安装和源码。
- **脚本验证**：真实只读扫描 35 记录 / 42 关联通过；未退出的宿主阻断安装/恢复、无人值守写入阻断均通过；原历史 hash 未变。独立 verifier 对交付包装返回 PASS。静态工具对 `.ps1` 有与原生 Parser 矛盾的语法报告，未将其误报当作执行失败或宣称所有语言服务 clean。
- **下一步**：用户读交付说明、退出 Percho，双击 01 安装（完成页不要启动应用），再双击 02 审查清单并确认恢复。仅当前用户原安装目录保持不变。若部分失败，保留 records 和备份，不盲目重跑；安装后校验及真实历史 apply 未执行，不能写成已安装/已恢复。
