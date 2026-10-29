---
类型: 修复方案
状态: 代码与自动化验证通过，桌面验收待执行
创建: 2026-10-29
更新: 2026-10-29
适用: Percho 0.7.4 桌面端扩展命令的发送回执与乐观忙碌状态
---

# session-command-activity：只撤销本次发送拥有的乐观忙碌状态

> **创建日期**：2026-10-29
>
> **状态**：已获批准实施；代码与自动化验证通过，桌面验收待执行
>
> **关联版本**：仓库及本机安装包 0.7.4（本轮未替换安装包）
>
> **任务真源**：用户反馈 `/session-name-refresh` 改名后持续显示“思考中”，要求明确不干扰其他功能的修法；2026-10-29 用户明确回复“批准执行”。

## 一、目标与阶段边界

- 空闲会话执行仅处理命令、不启动主会话的扩展命令后，退出本次发送产生的假忙。
- 保留普通消息、图片预处理、skill/模板展开、followUp 排队、工具循环、自动重试的现有执行语义。
- 扩展命令本身可以发起新的主会话任务；不能将 `handled` 理解成“整个会话当前必定空闲”。真实生命周期事件优先于旧请求回执。
- 不调用 abort、不清队列、不伪造 agent_end/agent_settled、不改会话文件或标题算法。
- 不改全局 pi-session-namer、SDK、app.asar、界面样式、LAN HTTP 响应结构；不 commit/push/tag，不自动安装或重启当前应用。
- 不承诺未经验证的“零回归”。通过所有权约束、定向测试、类型检查与桌面验收控制风险。

## 二、现有实现定位

### 2.1 可复用能力

- SDK 1.0.4 `AgentSession.prompt` 已提供 `handled | queued | started` 三种 preflight disposition。
- `packages/backend/src/pi-backend.ts` 已实现“受理即返回”，无需等待整轮模型执行；保留此设计。
- `packages/desktop/src/main/ipc/sessions.ts` 直接返回 backend.prompt；IPC 类型从 shared 通道推导，无需新增通道。
- `stores/transcript.ts` 是桌面端集中更新会话状态的入口，可在此维护临时标记的所有权。
- shared reducer 已处理真实 agent_start/agent_end/agent_settled；chat-rows 根据 agentActive 派生工作中行，不需要修改它们的业务语义。
- `removeOptimisticUser` 只删除尚未被权威消息认领的临时气泡，适合处理普通输入被扩展 input handler 消费的情况。

### 2.2 不能直接复用/需重构的部分

- `use-composer-send.ts` 在未知斜杠命令落回 prompt 路径后，无条件 `markAgentActive(true)`；成功路径只清 sending。
- 后端及 shared IPC 的 prompt 返回类型为 void，三种受理状态被抹平。
- catch 直接恢复发送前捕获的 wasActive，不能区分原任务在等待期间已经结束或新任务已经开始。
- 当前布尔型 agentActive 没有“谁有权撤销这次乐观写入”的信息；不能单凭 phase、当前值或发送前快照清零。
- 既有 prompt-ack 测试仅检查回执及时返回，未覆盖前端状态收敛。

**已有证据**：本机 app.asar 0.7.4 的发送与后端代码包含同一缺口；内存隔离复现通过 6 个契约检查（4 个重现假忙、2 个对照）；既有 prompt-ack 测试 7/7 通过。复现替代了 React/IPC/模型依赖，未做桌面点击式端到端验证。

## 三、架构决策

### 3.1 选择通用回执修复，不硬编码命令名

| 路径 | 取舍 |
| --- | --- |
| 只给 session-name-refresh 特判 | 改动表面小，但 status/lock/unlock 等同类命令继续出错；不采用 |
| 所有 `/` 开头的发送都跳过忙碌 | 混淆扩展命令与正常启动模型的 skill/模板，丢失预处理反馈；不采用 |
| **保留回执 + 乐观状态所有权** | 范围覆盖通用发送链，按事实处理，不改命令/模型执行；采用 |

### 3.2 IPC 契约

在 `packages/shared/src/session.ts` 导出：

```ts
export interface PromptAck {
  disposition: "handled" | "queued" | "started" | "unknown";
}
```

- shared prompt 通道结果改为 PromptAck，backend.prompt 返回 Promise<PromptAck>。
- preflight 原样映射三种已知 disposition，仍立即 resolve。
- SDK prompt 正常返回但没有 preflight 时返回 `unknown`，**不得猜作 handled**。SDK 在 agent_settled 派发期间可能延迟真正的 prompt，这条保险路径并不证明不会再开跑。
- preflight 前拒绝仍 reject；受理之后的 run 错误仍由事件流呈现，保持现状。
- 渲染端只对明确的 handled 执行条件清理；运行时遇到缺失回执/未知值按 unknown 保守处理，不凭空清掉状态。
- LAN server 当前忽略 backend 返回值并自行返回 `{ ok: true }`，保持原协议；以既有 LAN 测试回归保护。

### 3.3 乐观状态所有权

只在桌面 `SessionEntry` 增加可选 `optimisticActivityToken`（内存字符串，不持久化、不发送 IPC、不进入 shared transcript）。使用不会在 reset/loadHistory 后重用的唯一 token。

新增 store 方法：

```ts
beginPromptActivity(sessionId: string): string | null;
settlePromptActivity(sessionId: string, token: string | null, rollback: boolean): void;
```

契约：

1. begin 在单次同步 store 更新中读取实时状态，不能依赖 hook 渲染时的 wasActive。
2. 已有 agentActive=true 时不取得所有权、返回 null，不修改真实任务的忙碌状态。
3. 空闲时取得 token，并置 agentActive=true；不存在 entry 时按 EMPTY_ENTRY 创建，支持首条命令。清除未读行为保持既有乐观开工语义。
4. settle 只在目标 session 仍存在且 token 严格匹配时生效。rollback=true 撤销临时 agentActive；false 只放弃 token，不改 agentActive。
5. agent_start、agent_end（包括 willRetry=true）、agent_settled 到达 store 时无条件作废 token，随后保留真实 reducer 的状态结果。turn_start 也作废 token，避免后续回执覆盖已进入执行的轮次。
6. 现有 markAgentActive 的其他调用（如失败轮重试）也作废旧 token，防止互相覆盖；不改变其余调用方的执行方式。
7. loadHistory/resetSession 不保留 token，迟到回执无权修改重建后的状态；其他非生命周期事件必须显式保留 token，不依赖对象展开的偶然行为。
8. 撤销临时忙碌不伪造完成，不更新 runEndedAt、不制造完成未读、不修改 streaming/队列/工具状态。

所有权解决两类关键竞态：**旧命令不能结束新任务；旧快照不能把已结束的任务重新标成忙碌。** 若命令回执之后扩展才真正启动新任务，正常 agent_start 仍接管状态；该清理只影响 UI 临时标记，绝不取消实际执行。

## 四、执行状态机 / 核心业务时序

1. 保持内置 `/name`、`/compact`、`/export`、`/settings` 的早返回分支不变。
2. 正常 prompt 路径开始时调用 beginPromptActivity 并保存 token；sending、防双击锁、图片和草稿处理保持原有顺序与契约。
3. 等待 prompt 受理回执，而不是等待整轮回复。
4. 根据结果处理：

| 结果 | 乐观忙碌 | 乐观用户气泡 | 其他状态 |
| --- | --- | --- | --- |
| handled | 有本次 token 且未被真实事件接管才 rollback | 如本次有未认领气泡，使用 removeOptimisticUser 撤回 | 不 abort、不清队列 |
| started | 释放匹配 token，不清忙碌 | 保留等待 message_start 认领 | 真实事件继续驱动 |
| queued | 释放匹配 token，不清忙碌 | 维持现有排队不插气泡策略 | queue_update 驱动队列 |
| unknown / 旧 void | 释放匹配 token，不清忙碌 | 保持现状 | 不根据不充分信息清理 |
| reject | 仅 rollback 匹配 token，不恢复旧 wasActive | 维持现有失败撤回 | 保留现有错误提示与草稿恢复 |

5. finally 仍只清 sending；禁止无条件 markAgentActive(false)。
6. 捕获原 sessionId，异步回执永不使用“当前选中的会话”决定清理目标。

## 五、受影响文件与变更策略

| 模块 / 逻辑 ID | 目标文件路径 | 变更类型 | 核心策略说明 |
| --- | --- | --- | --- |
| ACK 类型 | packages/shared/src/session.ts | 修改 | 导出 PromptAck |
| IPC 类型 | packages/shared/src/ipc-channels.ts | 修改 | prompt 结果由 void 改为 PromptAck |
| ACK 转发 | packages/backend/src/pi-backend.ts | 修改 | 返回 disposition，保留提前回执和拒绝语义，补 unknown 保险路径 |
| 所有权 | packages/desktop/src/renderer/src/stores/transcript.ts | 修改 | token、begin/settle、生命周期失效、保守清理 |
| 发送消费 | packages/desktop/src/renderer/src/components/composer/use-composer-send.ts | 修改 | 消费 ACK，替代无所有权的乐观写入与旧快照回滚 |
| 后端测试 | packages/backend/test/prompt-ack.test.ts | 修改 | 三态/unknown、提前返回、异常不变 |
| 状态测试 | packages/desktop/src/renderer/src/stores/transcript.test.ts | 修改 | 所有权/事件/重建/跨会话竞态 |
| 发送集成测试 | packages/desktop/src/renderer/src/components/composer/use-composer-send.test.ts | 新增 | mock API 和必要 hook 依赖，执行实际 handleSend，不复制被测实现 |
| LAN 类型适配 | packages/backend/src/lan/server.ts | 仅修改接口类型 | LanObserverBackend.prompt 对齐 PromptAck，HTTP 处理逻辑不变 |
| LAN 协议回归 | packages/backend/test/lan-server.test.ts | 修改 | mock 返回 handled，断言 HTTP 响应仍严格等于 `{ ok: true }` |

main IPC 转发、preload、shared reducer、chat-rows 与 pi-session-namer 原则上只核查，不修改。若类型检查发现 mock 显式声明 Promise<void>，仅按新 DTO 适配 mock 并报告，不扩展业务范围。

## 六、测试设计与验证（TDD 契约）

### RED：先补能稳定重现当前缺陷的测试

- 空闲会话命令返回 handled 后，sending=false、agentActive=false、chat-rows 无 working 占位。
- 改名成功、无变化、锁定、命令内部捕获模型错误后返回，均收敛；status 路径无需模型也能收敛。
- 普通文本被 input handler 消费且返回 handled：不遗留临时忙碌或未认领气泡。

### GREEN：必须保护的回归矩阵

- 普通消息、图片预处理、skill/模板返回 started：保持忙碌直到真实结束事件。
- 运行中发送 followUp 得到 queued：原任务持续运行、排队状态不变。
- 原任务运行中执行命令后返回 handled：命令无所有权，不清原任务。
- 命令等待期间出现 agent_start/turn_start，再返回 handled/reject：不清新任务。
- 发送前原任务运行中，等待期间 agent_end/agent_settled，再返回 handled/reject：不恢复过期 wasActive=true。
- agent_end(willRetry=true) 后迟到 handled/reject：保留自动重试忙碌。
- started ACK 早于 agent_start、agent_start 早于 handled ACK：两种时序均覆盖，用 deferred Promise 手动控制，不靠 sleep。
- reset/loadHistory/新发送后旧回执迟到：旧 token 无效；切换会话不能修改另一会话。
- unknown/旧 void 不误清状态；preflight 前 reject 正确恢复原草稿。
- 内置命令仍早返回；失败轮重试与真实完成未读逻辑保持既有测试。
- LAN HTTP 成功响应继续为 `{ ok: true }`。

### 验证命令与人工验收

先对修改的 TS 文件运行 `lens_diagnostics(source=lsp, scope=paths)`；空缓存不代表通过。随后：

```bash
npm exec --workspace packages/backend -- vitest run test/prompt-ack.test.ts test/lan-server.test.ts test/manual-retry.test.ts test/slash-commands.test.ts
npm exec --workspace packages/desktop -- vitest run src/renderer/src/stores/transcript.test.ts src/renderer/src/components/composer/use-composer-send.test.ts src/renderer/src/components/composer/send-guard.test.ts src/renderer/src/components/chat/chat-rows.test.ts
npm run typecheck
npm test
```

桌面验收在不干扰当前真实任务的测试会话中执行：空闲改名、status、普通提问、回复中改名、followUp 排队、停止、切换会话。若实际模型或浏览器自动化条件不可用，明确报告未验收，不将内存测试标成端到端通过。

## 七、实施步骤与验收清单（Checklist）

- [x] 用户明确批准实施；复查工作区，不覆盖已有 HANDOVER.md。
- [x] 先添加 RED 测试，确认当前代码在状态清理断言上失败（Fixer 首轮执行记录：实际 handleSend 收到 handled 后 agentActive 仍为 true）。
- [x] 实现 PromptAck DTO、后端转发及 unknown 保守分支。
- [x] 实现桌面 store 的 token 所有权与事件失效。
- [x] 接入发送成功/拒绝路径；删除此处按 wasActive 盲目回滚，不改其他草稿/排队逻辑。
- [x] 检查实际 diff；执行 LSP、定向测试、typecheck 与全量测试，结果见下。
- [ ] 在测试会话执行桌面交互验收：**未执行**，无可直接使用的隔离浏览器；未获单独创建浏览器或替换/重启安装包授权。
- [x] 汇总改动文件、测试结果与剩余风险。安装包构建/替换、应用重启、Git 提交与发布另行确认。

### 7.1 实施调整与复核记录

1. 首轮全工作区 typecheck 发现 `LanObserverBackend.prompt` 仍为 Promise<void>，与新 PiBackend 不兼容。补充仅类型层面的 PromptAck 对齐与 mock 适配；`handleWrite` 不变，增加 HTTP 响应精确断言。复验 typecheck 通过。
2. 独立 Verifier 初轮审查核心行为给出 PASS，同时指出 followUp、willRetry、loadHistory、跨会话等测试覆盖不足。随后补齐测试；父代理进一步核对实际 diff，修正“事件在发送真正进入 prompt 前触发”的弱时序，改为等待 API mock 的 entered 信号，断言已取得 token 后才注入事件。
3. 父代理修正 working 行检查为实际 `metaGroup && working`，并为内置 `/name` 提供真实可用的 API mock、验证成功调用，避免把命令抛错早返回误当作成功。这些是测试修正，不扩展业务行为。
4. `prompt-ack.test.ts` 的旧 registry stub 缺 gate/dialogs/modeRef，LSP 检查提示类型不足；补齐当前声明所需字段，不改变被测 prompt 行为。
5. 运行态 token 使用模块级单调序号，reset/loadHistory 不重置序号；不写入会话文件或 IPC。

### 7.2 实际验证结果（2026-10-29）

| 检查 | 结果 / 边界 |
| --- | --- |
| 初轮定向回归基线 | LAN、manual-retry、slash-commands：34/34 通过 |
| 增补后的桌面定向测试 | store 76、hook 25、send-guard 4、chat-rows 18，共 123/123 通过 |
| 独立核心代码审查 | 初轮 PASS；不把当时有限测试覆盖等同最终完整验收，后续由父代理补查 |
| `npm run typecheck` | 后端、桌面 main/renderer、shared 全部通过 |
| `npm test` | 后端 91 文件 / 922 项通过；桌面 100 文件 / 1304 项通过；共 191 文件 / 2226 项，无失败 |
| 本次 10 个 TS 文件 Biome 检查 | 通过；未全仓批量格式化 |
| `git diff --check` | 通过 |
| 主动 LSP | 已运行；最后 4 文件探测无错误但服务器为 silent-on-clean，返回 inconclusive，不标记“LSP 全绿”；最终以项目 tsc 成功作为类型验证 |
| 桌面点击 / 真实模型命名调用 | **未执行**。hook 测试模拟 React/IPC 依赖，调用实际 handleSend/store/chat-rows，不冒充真实桌面或插件模型端到端测试 |
| 安装与 Git | 未构建安装包、未替换 app.asar、未重启当前应用；未 commit/push/tag |

全量测试日志：`%LOCALAPPDATA%/Temp/percho-session-command-tests.log`。源码修复不会自动进入当前已安装的 0.7.4；安装与真实界面验收仍是下一步。
