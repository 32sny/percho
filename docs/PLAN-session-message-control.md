---
类型: 方案设计
状态: 约定功能验收通过（含用户真机补验）
创建: 2026-10-29
更新: 2026-10-29
适用: Percho 0.7.4 / git 201737c；SDK @earendil-works/pi-coding-agent 1.0.4（已有 patch-package 补丁）
---

# session-message-control：会话消息三态控制（queue / steer / interrupt）方案

> **创建日期**：2026-10-29
>
> **状态**：代码、自动化、助手真实测试及用户真机补验通过；更多工具/执行器的兼容性边界仍按第七章保留
>
> **关联版本**：Percho 0.7.4；源码基线 `201737c`；SDK 1.0.4
>
> **任务真源**：本会话用户认可“B 增强版”，随后明确回复“批准执行”。实施不含 Git 提交、发布或替换安装包。
>
> 下文是获批实施契约；各项完成情况以第七章实际验证记录为准，不因开始实施即视为已完成。不得自动替换安装包或提交 Git。
>
> 已完成源码实现、问题修正、自动化验证、独立开发预览中的核心真实模型验收，以及用户对退出取消、删除取消、最终消息取回的真机补验。第二章保留实施前基线；§7.3 为首轮自动化证据，§7.4 为助手真实测试，§7.5 为用户补验。当前安装包未替换；验收通过不等于提交或发布，也不外推至未覆盖的工具和执行器。

---

## 一、目标与阶段边界

### 1.1 产品目标

同一会话内提供三种明确的消息投递语义，替代当前"运行中一律 followUp 排队"的单一行为：

| 模式 | 触发方式 | 语义 |
| --- | --- | --- |
| **queue**（排队） | Enter / 默认发送 | 任务自然完成后按 FIFO 投递（维持现状） |
| **steer**（插话） | 菜单显式选择 | 当前 assistant 回复及工具批次（含结果 hook）结束后、**下一模型请求前**注入 |
| **interrupt**（打断并发送） | 菜单显式选择 | 取消当前执行（含准备期），停稳后新消息优先开始 |

补充规则（本版方案约定，后续变更须先更新方案）：

- **空闲时三者等价**：都是普通发送，不区分模式。
- **独立停止按钮**：运行中始终可见（有草稿也可点），与菜单发送解耦。
- **菜单是"一次性选择"**：不改变 Enter 默认行为（恒为 queue）；**不新增**默认发送偏好设置项。
- 快捷键：Shift+Enter 仍为换行；Ctrl+Enter = "打断并发送"，仅在输入焦点、无 IME 合成、无弹窗时生效；**Esc 先关闭菜单/弹窗，不绑定取消**（避免与现有 Esc 行为冲突）。
- 运行中非空草稿可走菜单；已有排队项可执行**优先插话、打断并发送、取回编辑**。
- 多图、引用、附件、草稿文本在排队/取回全链路**保留完整**。
- 菜单**不得**默默合并多个排队消息，也**不得**把旧队列排到新紧急消息之前。
- 运行中发送不插乐观气泡（现状保持，见 2.2）。
- **受理前不清草稿**：成功回执后，仅当固定草稿 key 下的内容、图片、附件、引用、slash 与 recovery 关联仍是本次快照才清理；失败保留输入。用户在等待期间编辑的新内容或切换后的其他会话不会被迟到回执覆盖。

### 1.2 本阶段边界（明确不做）

- **不做**跨进程队列持久化：同后端进程内切会话、渲染重载可恢复；退出/关闭带待发项的会话需**明确确认**并提示"未发送消息不会出现在对话历史"；异常崩溃恢复**不承诺**。
- **不做**副作用回滚：不把旧任务自动转后台，不保证停止独立后台 Agent / PiFlow / MCP 外部工作。
- **不改**执行器开关、权限策略、发布版本；**不发版、不改 app.asar**。
- **保持**现有"每会话一条普通用户 followUp"上限；新增一条待 steer 槽和一条 interrupt 提交槽。上限由**后端强制**；held/恢复中的项**占原槽**；满了给出明确提示（取回或放弃），**不覆盖**。
- 系统/扩展消息**不套**用户 1 条限制，保持来源标记。
- 停止/interrupt 会把旧的用户待发送项变为 **held（待恢复）**，不自动继续；用户可取回 / 明确重发 / 明确放弃，**不静默清空**。

---

## 二、现有实现定位

### 2.1 可复用能力（现状已验证）

| 位置 | 现状 | 复用方式 |
| --- | --- | --- |
| `packages/backend/src/pi-backend.ts` ≈ L1001 `prompt()` | 固定 `streamingBehavior: "followUp"`，preflight 即返回 `PromptAck`（`handled/queued/started/unknown`） | "受理即返回"的 IPC 形态保留；把固定 followUp 改为按模式路由 |
| `pi-backend.ts` ≈ L1041 `abort()` | 调 `session.abort()` | interrupt/stop 的取消底层动作 |
| `pi-backend.ts` ≈ L1057 `clearQueue()` | 仅返回 `string[]`（`{ steering, followUp }`） | 保留旧 SDK/IPC 回执形状；托管模式改为冻结完整实体，不作不可恢复删除 |
| `use-composer-send.ts` | `sendGuard` 同步锁、草稿失败恢复（图片/附件/引用/text）、图片协议字段还原、compacting 拦截、`handleStop`（clearQueue → 还原文本 → abort）、`handleRestoreQueue` | 同步锁与草稿保全机制整体保留，改发送路由 |
| `shared/session.ts` ≈ L323 `PromptAck`、≈L383 `QueuedMessages` | 回执/队列 DTO | 作为旧契约兼容层基础，新 DTO 独立新建（见 3.4） |
| `docs/PLAN-session-command-activity.md` | `optimisticActivityToken` 乐观忙碌所有权、preflight 三态映射 | **必须保护**该修复语义：新 input handler `handled` 不得误标 idle（见 6.1 测试项） |
| `packages/backend/src/session/extension-dialog-host.ts` | 已有 signal/timeout 及“诚实取消值” | 权限/对话框绑定 run signal 的取消结算复用该模式 |
| `packages/desktop/src/renderer/src/stores/drafts.ts` | 已有按会话隔离的文本、图片、引用及附件草稿 | 扩充恢复关联 ID，复用现有 store，不另建草稿权威 |
| `patches/@earendil-works+pi-coding-agent+1.0.4.patch` | 已有 patch-package 补丁（含 retry 修复） | 在同一补丁上**追加**托管消息控制，不覆盖既有内容 |
| SDK `AgentSession` 内部队列 | followUp/steer 队列作为执行载体 | 保留为底层执行载体（见 3.2） |

### 2.2 需重构 / 需新增的部分

| 位置 | 现状缺口 | 方案 |
| --- | --- | --- |
| `pi-backend.ts` prompt | 模式单一（恒 followUp）；steering 语义未暴露 | 新增 `submitMessage` 等 IPC，内部统一路由 |
| `use-composer-send.ts` `handleStop` | `clearQueue` → 拼文本还原 → abort；只处理 `followUp: string[]` | 改走 `stopMessageControl`，按 item 取回完整载荷；恢复逻辑按 requestId/messageId 定位 |
| `Composer.tsx` | 停止按钮仅 `isStreaming && !hasContent` 才显示 | 改为运行中**始终可见**（有草稿也可点） |
| 队列事件 reducer | 只消费 followUp 型 `queue_update` | 扩展为消费新 snapshot/item 事件 |
| SDK `dist/core/agent-session.js` | `prompt`（≈L1555）前置的 input/auth/extension/image await **不计** `_isAgentRunActive`，`_runAgentPrompt`（≈L1376）才占用；`abort`（≈L1947）**不能取消在途 preflight**——本会话已用实际方法 + 桩复现"abort 返回后旧 prompt 继续启动"；`clearQueue`（≈L1920）**抛弃图片**（实际方法桩验证） | 通过补丁新增 `enableMessageControl()` 托管层（见 3.2/3.3）；准备期登记 generation + AbortController |
| `_emitAgentSettled`（≈L681） | 有 deferred 动作；`channel-watch/extension.ts` ≈L87 直接 `sendUserMessage(followUp)` **绕过 backend** | 托管模式下所有新 run 入口经同一仲裁；频道唤醒接线验证（不改频道协议） |
| `permissions/gate.ts` confirm | **没有 signal** | 确认绑定 run signal，confirm 按 `false`、其他对话框按各自取消值结算并广播撤卡 |
| busy 判定 | 现有 `isIdle` / `agent_end` / 单次 `agent_settled` 不足以覆盖准备期、权限/对话框、结算 deferred | 新增 quiescence 定义（见 3.3） |

**未验证项（实施期必须重新核验）**：真模型下图片归一化延迟窗口、第三方工具取消行为、全套现有测试基线。

---

## 三、架构决策

### 3.1 已拒绝的备选方案

| 被拒方案 | 拒绝理由 |
| --- | --- |
| UI 侧拼 `clearQueue` + `abort` + `prompt` 模拟三态 | 竞态窗口大（abort 不能取消在途 preflight，已实证）；图片丢失；无法表达 held 语义 |
| 前后端两套可独立消费的队列 | 双权威必然分叉：谁消费、何时消费无法收敛 |
| 绕过公开 API 直接操作 `session.agent` | 归为**不支持的旁路**（见 3.6） |

### 3.2 采纳：SDK 会话层是唯一可执行队列权威

- SDK `AgentSession`（保留其既有内部队列作为执行载体）是**唯一**的可执行队列权威；backend 不得额外保存独立可消费副本，只做生命周期绑定、协议校验、草稿载荷转换和 UI 投影适配。规范输入及恢复元数据都归同一消息实体管理；底层队列与 UI 快照不是第二个可独立消费的来源。
- 通过既有 `patches/@earendil-works+pi-coding-agent+1.0.4.patch` 扩展 **opt-in** 托管消息控制，不覆盖既有 retry 补丁。
- 兼容范围：普通未启用托管控制的 SDK/CLI 使用方维持旧行为；**Percho 主会话**在扩展 bind / 频道唤醒开放前启用托管。
- 拟新增 SDK 契约：`session.enableMessageControl(): MessageControlHandle`（**拟新增，非现有 API**）。句柄方法：`submit / getSnapshot / changePending / recover / stop / subscribe / dispose`；生命周期由 `session.dispose` 释放。
- 受同一仲裁覆盖的入口：公开的 `prompt / steer / followUp / sendUserMessage / sendMessage(triggerTurn)`、settled-deferred 的新 run 入口。内部 auto-retry / compaction 续体受 **run generation 取消检查**。
- **不允许**用 prompt options 中的客户端字段绕过仲裁。
- 扩展产生的**不触发 run** 的 append/display 消息按原样保存，但不得借其绕过"暂停启动模型"。

### 3.3 取消、busy 与排序的核心机制

- **准备期可取消**：在任何 await 前登记 operation / run generation 与 `AbortController`；所有 await 之后核对 signal / generation / 会话实例。不能取消的 auth / image / hook **仍等待完成再丢弃旧结果**，不用 `Promise.race` 假装释放；**禁止**旧准备在新任务之后启动。
- **quiescence（旧执行已收束）**：旧 generation 的准备阶段、模型流、工具批次、权限/对话框及结算 hooks 全部结束，且旧 deferred 续体不能再启动执行。持有但未执行的消息不算 busy；`autoDispatchPaused` 与 phase 是两项独立状态。
- **跨层消息关联**：新用户消息默认 `messageId = requestId`；编辑恢复项时保留 messageId、另生成 requestId。SDK 队列及 commit 事件保留该关联，用户 `message_start` 在事件侧附带 `controlMessageId`，供乐观气泡精确认领；ID 不进入模型文本。既有 `queue_update` 只作兼容投影，新 UI 不与新快照重复消费。
- **消息身份**：按 `requestId` / `messageId` 识别，**绝不按文本匹配**。`runtimeId` 标记当前会话实例；`revision` 单调递增；旧实例 / 旧 revision 操作拒绝；连续相同文本也是两条独立消息。同 requestId + 同载荷的重复提交返回**同一回执**（幂等）；不同载荷拒绝。
- **同步占位**：单次同步状态转换内完成占位，**不持有跨整轮 / 跨 await 的 mutex**；`stop` 必须随时可抢入。
- **interrupt 时序**（定稿）：

```text
同步占位 gate + 新消息 accepted 持有
→ 冻结旧用户 queue/steer 项为 held；外部新投递转 deferred
→ cancel generation / preflight / LLM / tool / retry / auto-compaction / 权限
→ 等待所有旧任务 quiescent
→ 新消息优先 preflight；真正 commit 后才解除 gate
→ 旧用户 held 不自动恢复；系统/扩展项保留按原 FIFO，降级为 followUp 排在新消息之后
```

- 不能重放已执行的工具；完整历史保留；旧任务的部分输出标记"已中断"，**不是**错误、不触发重试。
- `handled` 仅表示输入被扩展消费，**不能推断全会话空闲**。普通发送继续保护既有 `optimisticActivityToken` 逻辑。interrupt 的替代输入被消费且尚无该替代输入的用户消息 commit 时，保持自动投递暂停；该 handler 发起的嵌套输入暂存，不允许绕过 gate 自动新开轮次。新 prompt preflight 失败同样保留为 held，并保持暂停。
- 扩展在 input / before-agent / settled handler 内重入公开投递入口时，托管层先登记为待投递并返回受理结果，不等待它未来的整轮执行，避免“handler 等消息、消息等 handler”死锁。非暂停状态下按既有边界继续投递；暂停状态必须等真人明确发送。
- **普通 stop**：冻结用户队列 → 取消并等待 → `autoDispatchPaused = true`，**不**自动消费 queued 消息；外部通知可记录但不唤醒，下一次真人显式发送才恢复（旧 held 用户消息仍需单独重发）。
- 显示与超时：5s 显示"仍在停止"；30s 把 interrupt 新消息的"自动发送承诺"取消为 held（控制态 `blocked` + `sendAfterStop=false`），仍等待旧执行，**不放开并发**；旧任务迟到结束后转 `idle/paused`，必须用户明确重发。
- 再次 stop：取消待自动发送的新消息，且**幂等**。同一时间第二个 interrupt（不同 requestId）返回 `busy`，草稿不清。
- 所有结果按 `runtimeId / operationId / revision` 定位；**切会话不回填到别的会话的草稿**。

### 3.4 拟新增 DTO：`shared/src/message-control.ts`

```ts
// 拟新增契约；ImageInput 复用 shared/session.ts。
type MessageMode = "queue" | "steer" | "interrupt";
type ControlPhase = "idle" | "preparing" | "running" | "compacting" | "interrupting" | "blocked";

interface MessagePayload {
  text: string; // 最终待投递文本；引用/附件的渲染拼接只有一个执行点
  images?: ImageInput[];
  draft?: {
    text: string; // 未拼接的原始输入，用于恢复
    attachments: string[];
    quotes: string[];
    slashCommand: string | null;
    imageNames?: string[]; // 与 images 对齐，仅恢复显示，不送模型
  };
}

interface MessageSubmitRequest {
  sessionId: string;
  runtimeId: string;
  requestId: string;
  mode: MessageMode;
  payload: MessagePayload;
  recovery?: { messageId: string; expectedRevision: number };
}

interface MessageAck {
  requestId: string;
  messageId: string;
  operationId?: string;
  disposition: "started" | "queued" | "handled" | "interrupting" | "held";
}

interface ControlledItem {
  messageId: string;
  source: "user" | "extension" | "system";
  mode: MessageMode;
  state: "queued" | "held" | "recovering";
  preview: string;
  imageCount: number;
}

interface ControlSnapshot {
  runtimeId: string;
  revision: number;
  runId?: string;
  phase: ControlPhase;
  compactionKind?: "manual" | "auto";
  autoDispatchPaused: boolean;
  operation?: { operationId: string; messageId?: string; sendAfterStop: boolean };
  items: ControlledItem[];
}

type ControlErrorCode = "not_found" | "read_only" | "stale_runtime" | "stale_revision"
  | "invalid_payload" | "image_unsupported" | "queue_full" | "busy"
  | "compacting" | "command_mode_unsupported" | "already_committed"
  | "request_id_conflict" | "preflight_failed";
type ControlResult<T> = { ok: true; value: T } | {
  ok: false;
  error: { code: ControlErrorCode; message: string; snapshot?: ControlSnapshot };
};
```

- 频繁事件只广播投影（含 imageCount），不广播 base64；完整载荷只在初次提交和明确取回时传输。恢复字段不进入模型上下文或队列预览日志。
- 新 SDK 控制句柄的订阅由 backend 转成 `SessionEvent` 的 `message_control_update` 事件；含 snapshot 与可选的消息受理/commit/失败关联信息。初始状态通过 get 接口拉取，不依赖某一次广播恰好被监听。
- 来源由宿主入口推导，renderer 不得自报 `system/extension` 来绕过用户容量。队列控制的 ID 与 requestId 幂等记录存活于当前 runtime，实例销毁后失效。
- 模板和 input handler 处理后的执行载荷与原始 draft 分开保存；变模式不得再次展开，只有编辑后明确重发才作为新的输入处理。

### 3.5 IPC 契约

- **新增 IPC**（均返回 `ControlResult<T>`）：

| 通道方法 | 输入 | 成功返回 |
| --- | --- | --- |
| `submitMessage` | `MessageSubmitRequest` | `MessageAck`；受理返回，不等待整轮 |
| `getMessageControl` | `sessionId` | `ControlSnapshot`，供会话首次加载/重载 |
| `changePendingMessage` | sessionId、runtimeId、requestId、messageId、expectedRevision、action=`steer\|interrupt\|resend\|discard` | `MessageAck` 或更新后 snapshot；resend 保留原模式，discard 为明确放弃 |
| `recoverPendingMessage` | sessionId、runtimeId、requestId、messageId、expectedRevision | 完整 payload、messageId、更新后 snapshot |
| `stopMessageControl` | sessionId、runtimeId、requestId | operationId 与 snapshot；立即受理，是否停稳走事件 |

- **旧通道兼容适配**：`prompt` / `abort` / `clearQueue` / `getFollowUpMessages` 保留原回执形状。旧 clearQueue 在托管模式冻结实体并返回文本，恢复实体仍可由新接口取回；新 UI 不再使用 clearQueue 恢复。旧 abort 仍等待收束才返回，新 stop 使用独立的受理回执。
- 当前 LAN HTTP 只调用 backend.prompt / abort，**没有 clearQueue HTTP 端点**。保持其请求与响应形状，不向 LAN 开放新三态；停止后的暂停语义仍由共享仲裁器保证。LAN 文本来源视为用户，不冒充扩展。
- preload 走自动 CHANNEL_TABLE，一般无需手写 preload 方法。
- `changePendingMessage` 以 ID + revision 做 **CAS**；已 commit 或旧 revision 拒绝并回传最新快照，**不**制造第二条消息、**不**重复展开模板。跨槽移动先检查目标槽，不先释放原槽；interrupt 已排队项复用原 messageId。
- 状态变更失败返回稳定错误码并保留输入；已受理 interrupt 的后续 preflight 失败通过控制事件报告，不能事后把已返回的 IPC 伪装成 reject。槽容量和幂等检查均以 SDK 权威状态为准，由后端验证入口调用同一操作。

### 3.6 旁路与边界

- 绕过公开 API 直接操作 `session.agent` 或自建进程的扩展**不承诺**控制，标记为不支持的旁路（文档与日志标注，不做运行时阻止）。
- `recover` 只把 item 冻结为 `recovering` 并返回全载荷；草稿按 sessionId 保存；恢复后的消息携带原 messageId 走"编辑重发"，**受理成功后才替换旧实体**；放弃是显式操作。目的：避免响应丢失导致"队列已删、草稿没到"的双失。
- slash 规则：slashCommand（或去掉引用包装后正文首命令）以 `/` 开头**仅走普通路径**；steer / interrupt 模式下**禁用**并提示"先停止再发命令"；不允许把扩展命令当用户普通插话造成同时执行。
- 所有新增入口在后端先做 `requireWritable`、载荷/图片检查、容量校验，**然后**才执行取消。

### 3.7 竞品证据（仅作参考，不构成实施依据）

**已验证（可复核来源）：**

| 产品 | 证据 | 来源 |
| --- | --- | --- |
| OpenAI Codex（源码 `3535c22b43e5d7a67322f6e85b267ef65577c227`） | 正常可转向状态下 Enter = steer / Tab = queue；待 steer 在工具/结果边界生效；另有 interrupt 后重发路径，不是工具瞬时强停保证 | [队列预览语义](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/tui/src/bottom_pane/pending_input_preview.rs#L14-L22)、[中断重发入口](https://github.com/openai/codex/blob/3535c22b43e5d7a67322f6e85b267ef65577c227/codex-rs/tui/src/chatwidget/interaction.rs#L272-L286) |
| Codex App 设置 | Follow-up behavior 可选 steer / next run；已核对文档，但不据此断言全部安装版本的默认值 | [官方设置](https://developers.openai.com/codex/app/settings) |
| Claude Code 交互模式 | Enter 排队后 Claude 在工具之后同一 turn 读取队列 | https://code.claude.com/docs/en/interactive-mode#when-claude-code-sends-what-you-queued |
| Claude Code 快捷键 | v2.1.275 Ctrl+Enter = sendNow；v2.1.281 起可后台化继续执行；Esc 会送出已排队消息 | https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md（交叉核对） |
| Claude Desktop | Enter 纠正不取消当前动作；stop 另设按钮 | https://code.claude.com/docs/en/desktop#use-the-prompt-box |

**未验证 / 不能引申的：**

- Codex / Claude 的桌面安装版本、不同设置组合及真实工具取消未做端到端实测；线上文档与源码不能当作所有版本的产品保证。
- 本方案借鉴其"意图与投递分离"思路，**不照搬**后台化继续执行、**不照搬** Esc 自动发送旧队列。
- 当前 SDK 已具备的队列/steer 内部能力，**不代表** Percho 新功能已实现。

---

## 四、执行状态机 / 核心业务时序

### 4.1 phase 状态机

`phase` 表示执行状态，`autoDispatchPaused` 表示调度开关，二者不可混为一项：

| 当前状态 / 事件 | 后续状态 | 自动发送规则 |
| --- | --- | --- |
| idle，合法显式发送 | preparing → running | 明确用户输入可以解除调度暂停；旧 held 不恢复 |
| preparing，普通发送前置失败 | idle | 原草稿/恢复实体保留；不伪造运行 |
| running，正常结束且允许调度 | preparing 或 idle | SDK 仲裁下一个可运行项；无消息则 idle |
| preparing/running/自动压缩，stop 或 interrupt | interrupting | 立即关闭旧投递入口；必须等待旧 generation 收束 |
| interrupting，30s 内旧执行已收束，sendAfterStop=true | preparing → running | 仅被指定的新消息先行 |
| interrupting，普通 stop 完成 | idle + paused | 不发送旧队列或通知 |
| interrupting，30s 尚未收束 | blocked + paused | sendAfterStop=false，新消息 held；禁止启动其他任务 |
| blocked，旧执行终于收束 | idle + paused | **不能因迟到结束自动发送**；待用户再确认 |
| blocked，用户再发普通或紧急消息 | blocked | 返回 busy，保留草稿；不得靠新消息“解锁”旧工具 |
| interrupt 替代消息被 handled 或前置失败 | idle + paused（须已收束） | 保留剩余项；不自动消费 handler 的嵌套投递 |

要点：

- `preparing`（含 input/auth/extension/image await）在托管模式下**计入 busy**（区别于 SDK 现状 `_isAgentRunActive` 只覆盖 `_runAgentPrompt` 起）。
- 手动压缩期间 queue/steer/interrupt **都拒绝**并保留草稿；独立停止按钮可取消压缩。
- 自动压缩发生在 run 内：排队保留；steer 到下次模型请求前生效；interrupt 取消压缩并等停稳。

### 4.2 关键时序

**idle 三发送**：三者等价，直接走普通 preflight → started。

**运行中 queue**：受理回执 `queued` → 当前任务达到无待执行工具/steer 的自然结束边界 → SDK 按 FIFO 继续投递（`autoDispatchPaused=false` 时）。**不能等待最终 `agent_settled` 才启动消费**：现有 SDK 会把 followUp 继续执行也纳入同一次 run，最终 settled 常在队列全部消费后才发出。

**运行中 steer**：受理回执 `queued`（模式 steer）→ 当前 assistant 回复 + 工具批次（含结果 hook）结束 → **下一模型请求前**注入。

**运行中 interrupt**：见 3.3 时序块。要点重申：gate 在新消息真正 commit 前不解；旧用户项 held 不自动恢复；系统/扩展项降级 followUp 排在新消息之后。

**普通 stop**：冻结用户队列 → cancel + 等待 quiescent → `autoDispatchPaused=true`。5s 提示"仍在停止"；不自动吃 queued。

**取回（recover）**：`recoverPendingMessage` → item 冻结 `recovering` → 返回完整载荷（text/images/attachments/quotes/slashCommand）→ 渲染端写入该会话草稿 → 用户编辑后携 messageId 重发 → 受理成功才替换旧实体 → 失败则实体仍在原位。

---

## 五、受影响文件与变更策略

| 文件 | 操作 | 内容 |
| --- | --- | --- |
| `packages/shared/src/message-control.ts` | **新增** | §3.4 DTO（mode/request/ack/snapshot/items） |
| `packages/shared/src/session.ts` | 修改 | 扩展 SessionEvent 控制快照/用户事件 ID；旧 DTO 保留 |
| `packages/shared/src/ipc-channels.ts` | 修改 | 新增 5 个通道常量 |
| `packages/shared/src/index.ts` | 修改 | 导出新 DTO |
| `packages/shared/src/transcript/types.ts`、`reducer.ts` | 修改 | snapshot/item 事件消费、队列面板数据结构 |
| `packages/backend/src/pi-backend.ts` | 修改 | submit/getSnapshot/changePending/recover/stop 实现；旧通道适配 |
| `packages/backend/src/session/message-control.ts` | **新增** | 后端侧仲裁适配层 |
| `packages/backend/src/session/registry.ts` | 修改 | 会话生命周期与托管句柄绑定 |
| `packages/backend/src/permissions/gate.ts`、`extension.ts` | 修改 | confirm 绑定 run signal，取消结算与撤卡广播 |
| `packages/backend/src/session/ui-context.ts` | 修改 | 为既有 ExtensionDialogHost 合并 run signal 与扩展 signal，取消后移除监听；无需改 host 原有结算实现 |
| `packages/backend/src/tools/channel-watch/extension.ts` | 验证复用，未修改 | 公开 sendUserMessage 由 SDK 统一接管；频道协议保持原样 |
| `packages/desktop/src/main/ipc/sessions.ts` | 修改 | 新 5 通道 IPC 透传 |
| `packages/desktop/src/renderer/src/components/composer/Composer.tsx` | 修改 | 停止按钮常显（运行中）；Ctrl+Enter |
| `packages/desktop/src/renderer/src/components/composer/use-composer-send.ts` | 修改 | 发送路由三态、handleStop 改造、草稿保全 |
| `packages/desktop/src/renderer/src/components/composer/SendModeMenu.tsx` | **新增** | 菜单（queue/steer/interrupt、排队项操作） |
| `packages/desktop/src/renderer/src/components/composer/QueueBar.tsx` | 修改 | held/queued/recovering 展示与操作 |
| `packages/desktop/src/renderer/src/stores/transcript.ts`、`session-loading.ts`、`drafts.ts` | 修改 | snapshot 重载、复用草稿 store、增加恢复关联信息 |
| `packages/desktop/src/main/index.ts`、`window.ts`、相关 renderer 会话关闭入口 | 修改 | 退出/销毁带未发送项的实例前确认；只隐藏窗口或切标签不清队列 |
| `packages/desktop/src/renderer/src/i18n/zh.ts`、`en.ts` | 修改 | 新文案 |
| `patches/@earendil-works+pi-coding-agent+1.0.4.patch` | 修改 | 追加托管控制及运行时类型/导出；测试放项目 test 中，不依赖改 node_modules 后的未记录状态 |
| `packages/backend/test/message-control.test.ts`、`message-control-sdk.test.ts` | 新增 | 适配器与已打补丁 SDK 的内存测试 |
| `packages/backend/test/prompt-ack.test.ts`、权限/频道/LAN 对应测试 | 修改 | 既有回执、权限与外部投递回归 |
| `packages/desktop/src/renderer/src/components/composer/SendModeMenu.test.tsx`、`QueueBar.test.tsx` | 新增 | 模式入口、队列状态、取回与容量提示 |
| `packages/desktop/src/renderer/src/components/composer/use-composer-send.test.ts`、`stores/transcript.test.ts`、`packages/desktop/src/main/ipc/sessions.test.ts` | 修改 | 草稿/事件/IPC 回归；shared reducer 沿用现有对应测试 |

其他约定：新 UI 不是插件，**不修改** `~/.percho`；preload 一般无需手写。

---

## 六、测试设计与验证（TDD 契约）

### 6.1 必须覆盖的测试项（≥20 条）

| # | 测试项 | 关键断言 |
| --- | --- | --- |
| 1 | idle 三态 | idle 下 queue/steer/interrupt 都是普通发送 |
| 2 | queue 不抢跑 | 运行中 queue 不打断当前任务，到自然结束边界后 FIFO 投递；不能因等待最终 settled 而死锁 |
| 3 | steer 工具批次边界 | steer 在工具批次（含结果 hook）结束后、下一模型请求前生效 |
| 4 | interrupt 取消流 | 取消 generation/LLM/tool/retry，等 quiescent 后新消息优先 |
| 5 | 非合作工具阻塞 | 工具不响应取消时 abort 等待；30s 转 blocked 不放开并发 |
| 6 | 准备期 abort | auth/input/hook/image await 中取消：旧结果完成即丢弃，不启动旧 run |
| 7 | 旧 settled 续体撞取消 | deferred 新 run 入口受 generation 取消检查 |
| 8 | 频道唤醒撞取消 | channel-watch sendUserMessage 入仲裁，取消后不新开 run |
| 9 | 权限取消 | run 取消 → confirm=false，其他对话框按约定取消值结算并撤卡；不伪造允许、不清白名单 |
| 10 | 待发图片恢复 | recover 返回完整 payload（含 images），受理成功才替换旧实体 |
| 11 | 同文本不同 ID | 连续相同文本是两条独立消息，不合并 |
| 12 | 重试同 requestId | 同 requestId + 同载荷幂等，返回同一回执 |
| 13 | 不同载荷重试拒绝 | 同 requestId + 不同载荷拒绝 |
| 14 | 双 interrupt | 第二个 interrupt 返回 busy，草稿不清 |
| 15 | 30s 迟到不自动发 | 超时后 sendAfterStop=false，旧任务迟到结束转 idle/paused |
| 16 | 停止不自动 queue | stop 后 autoDispatchPaused=true，queued 不被消费 |
| 17 | 草稿切会话恢复 | snapshot + 草稿按 sessionId 恢复，切会话不串 |
| 18 | 旧 runtime / 旧 revision | 拒绝并回传最新快照 |
| 19 | handled 不误标 idle | 保护 `optimisticActivityToken` 现有修复（PLAN-session-command-activity） |
| 20 | interrupt 的新 input 被 handled | handler 可有副作用或嵌套投递；不能推断 idle；按控制 gate 保持暂停 |
| 21 | slash 禁用 | steer/interrupt 下 `/` 命令禁用并提示 |
| 22 | 手动/自动压缩区别 | 手动压缩三态全拒；自动压缩 queue 保留/steer 下轮/interrupt 取消 |
| 23 | LAN 与旧队列 IPC 兼容 | LAN prompt/abort 形状不变；旧 clearQueue IPC 后仍可取回完整实体 |
| 24 | 第三方后台边界 | 后台 Agent/PiFlow/MCP 外部工作不承诺停止（行为文档化） |
| 25 | 关闭待发确认 | 关闭带待发项会话弹确认，提示不进历史 |
| 26 | 无授权不清 payload | recover 响应丢失时完整队列项仍可取回 |
| 27 | handler 重入投递 | 返回 queued/accepted，不等待尚不能运行的新轮次，无死锁 |
| 28 | snapshot 重载与旧事件 | getSnapshot + revision 去重，旧 runtime 不覆盖当前状态 |
| 29 | 普通/steer/interrupt 容量 | held 占原槽、跨槽 CAS、用户容量不能由客户端 source 绕过 |
| 30 | 活动期再次停止 | stop 取消 sendAfterStop；待发新消息保留；迟到 settle 不抢跑 |
| 31 | 空间与销毁边界 | 切标签/隐藏不销毁；close/delete/quit 确认后才释放未发送载荷 |

### 6.2 验证流程与纪律

- **TDD 纪律**：先写失败测试 → 改实现 → 再独立验证。**在任何测试实际通过之前，不声称"已通过"**。
- 拟新增测试命令（实施期才执行，路径以实际为准）：

```bash
npm test -w packages/backend -- test/message-control.test.ts test/message-control-sdk.test.ts test/prompt-ack.test.ts
npm test -w packages/desktop -- src/renderer/src/components/composer/use-composer-send.test.ts src/main/ipc/sessions.test.ts
npm run typecheck
npm test
npm run build
```

- `npm run build` 成功 ≠ 安装/发布；build 产物不替换现有安装。
- SDK 补丁层增加托管控制与队列关联的单元测试（内存模拟，非桌面 E2E）。
- **发布前必须完成**：桌面真模型验收 + 不同 Windows 工具的取消行为验证。**没验不发布。**
- 每阶段完成后核验，**不自动 commit / push / tag**。

---

## 七、实施步骤与验收清单

### 7.1 分阶段实施步骤

> 用户已明确批准执行。按以下阶段实施，逐项验证；未通过项目不得勾选。

| 阶段 | 内容 | 完成标准 |
| --- | --- | --- |
| P0 契约与测试先行 | 新增 `shared/message-control.ts` DTO + IPC 通道常量；补丁内新增 SDK 托管接口骨架 + §6.1 失败测试 | 测试按预期失败；typecheck 通过 |
| P1 SDK 托管层 | `enableMessageControl()` + 仲裁/generation/quiescence + cancel 语义；同 requestId 幂等、revision CAS | SDK 层测试（含时序/取消/幂等组）通过 |
| P2 后端仲裁适配 | `backend/session/message-control.ts` + pi-backend 五通道 + 旧通道适配 + requireWritable/容量校验前置 | 后端测试通过；旧 LAN 回归不破 |
| P3 权限/对话框/频道接线 | gate.confirm 绑 signal；dialog-host 对齐；channel-watch 入仲裁 | 对应测试通过；频道协议无 diff |
| P4 渲染端 | Composer 停止常显 + Ctrl+Enter；SendModeMenu；QueueBar；use-composer-send 路由与 stop 改造；stores/i18n | 桌面测试通过 |
| P5 集成验证 | typecheck / 全量 test / build；桌面真模型验收；Windows 多工具取消验证 | §7.2 清单全勾 |

### 7.2 验收清单

已勾项须按所列证据区分自动化、助手实际操作与用户真机补验；未覆盖的兼容性范围不因用户补验通过而自动勾选。

- [x] 用户已明确回复“批准执行”，本轮未 commit / push / tag / 发版
- [x] idle 下三态等价；Enter 默认 queue；无新增默认偏好设置
- [x] queue / steer 边界、interrupt 停稳后新消息先行、旧用户项 held
- [x] 停止按钮独立；5s 提示及 30s blocked 不放开并发（时序测试覆盖）
- [x] held 项可取回完整载荷、重发或明确放弃；关闭/删除前专项确认
- [x] SDK 权威容量与后端身份/模式/图片校验；系统/扩展不套用户槽位
- [x] 草稿、图片、附件、引用保留；只在受理后条件清理草稿
- [x] requestId 幂等、载荷冲突及 runtime/revision 拒绝；control ID 不进入模型内容
- [x] 权限与扩展对话框绑定取消信号；按拒绝/取消值结算，不清已有授权白名单
- [x] 保护 optimisticActivityToken；新 API 失败不得悄悄退回旧发送/清队列路径
- [x] LAN 请求/响应形状保持；旧 clearQueue 保留可恢复实体
- [x] slash 模式和手动压缩拒绝保护；自动压缩沿用受控 run 取消路径
- [x] 退出/单会话/项目删除专项确认、确认后新增项复核、Windows 关窗保护
- [x] 最终 `npm run typecheck` / `npm test` / `npm run build` 通过
- [x] 最终独立 verifier 在限定静态和定向自动化范围返回 PASS
- [x] 开发预览内真实模型与 Windows 前台等待命令的 queue / steer / interrupt / stop 验收（见 §7.4）
- [x] 图片完整取回、真实页面重载后再次取回；修复恢复入口缺失
- [x] 原生退出取消后窗口/消息保留、删除会话取消、删除项目取消（用户真机补验通过，见 §7.5）
- [x] 取消操作后最终取回 `PENDING_KEEP_验收消息不要丢`，内容完整（用户回报及截图）
- [ ] 更多实际 Windows 工具及第三方执行器边界（本次只覆盖前台 PowerShell 等待命令）

### 7.3 首轮实施与自动化验证记录（2026-10-29）

| 项目 | 结果 | 证据 / 边界 |
| --- | --- | --- |
| SDK 真实 Agent/AgentSession 内存时序 | 18/18 通过 | `packages/backend/test/message-control-sdk.test.ts`；模型及工具为受控测试替身，无真实外部 API |
| Composer 提交与草稿生命周期 | 48/48 通过 | `use-composer-send.test.ts`；受理后清理、API 失败拒绝降级、恢复与切会话保护 |
| 最终全量后端测试 | 93 个文件，944 项通过 | `.local/validation/message-control-tests.log` |
| 最终全量桌面侧测试 | 103 个文件，1356 项通过 | 同一日志；合计 **196 个文件、2300 项测试** |
| 全工作区类型检查 | 通过 | `.local/validation/message-control-typecheck.log` |
| 构建 | 通过 | `.local/validation/message-control-build.log`；不是安装或发版 |
| SDK 补丁固化与内容一致性 | 通过 | `patch-package` 重新生成；`git apply --check --reverse` 校验当前依赖可逆匹配；`.local/validation/message-control-patch.log` |
| 独立复验 | PASS，限定范围 | SDK 18 项及桌面侧 93 项定向测试；静态复核 SDK、删除/退出、草稿与 IPC 接线，不包含真实桌面任务 |
| 局部 Biome / diff 检查 | 无阻断错误 | 本次 TS/TSX 格式与导入已整理，仍有测试代码 non-null assertion 等 lint 警告；`git diff --check` 通过 |
| LSP 主动探测 | 部分可确认 | 曾对 3 个路径探测，1 个可确认 clean、2 个 silent-on-clean 不确定；最终以全工作区 TypeScript 检查补足，未把空缓存当通过 |

#### 审查发现与修正

1. SDK 首轮实现未达到取消要求：重写为单一队列权威、异步作用域 generation、真实工具/准备期收束；补充真实 SDK 循环测试，而非只验控制器 stub。
2. 自定义 `triggerTurn` 消息未被用户消息专属 commit 分支认领，可能重复执行：改为所有 `message_start` 统一认领，新增有界回归测试。
3. 删除项目绕过待发专项确认、确认后新增消息被纳入 discard：确认逻辑集中于待发载荷守卫，先捕获 IDs、确认后复核，取消向项目删除上传播。
4. Windows 关窗及重复退出确认：加入窗口销毁前拦截、single-flight 退出确认和确认后快照复核；macOS 普通关窗隐藏语义保留。
5. 新 API 失败退回旧发送及错误复用 requestId：失败保持草稿，不退回不同发送语义；幂等指纹覆盖完整载荷及实例，传输失败与明确拒绝分别处理。
6. 受理前清草稿会使迟到失败覆盖用户编辑：改为受理后按固定 key 和完整快照条件清理，不引入第二个自动消费队列。

#### 未执行项与交付边界

- 本节记录时尚未启动真实模型任务；后续已补验的范围见 §7.4。仍未覆盖所有第三方工具或独立后台工作流；停止是协作式，不保证瞬时强杀或回滚副作用。
- 未替换本机 Percho 安装包、未重启用户应用、未发布版本；源码与构建产物不代表当前打开的软件已更新。
- 未 commit / push / tag。仓库原有未跟踪 `HANDOVER.md` 未修改。
- SDK 控制使用固定 1.0.4 内部队列及生命周期结构；升级依赖必须重新验补丁和时序测试，不可仅改版本号。
- `.local/validation/` 是本地验证日志，不是业务数据或自动恢复队列；跨进程/异常崩溃恢复仍不承诺。

### 7.4 开发预览真实验收与修复（2026-10-29）

**执行环境**：本地构建的 Electron 开发预览（非已安装正式版）；临时工作区 `percho-message-e2e-*`；独立 `user-data-dev` 与 agent 配置；真实模型 `WB / cn:glm-5.3-flash`。通过真实输入框、Enter/Ctrl+Enter、发送菜单、停止按钮、图片文件输入与取回按钮操作；会话建立和观测使用真实 store/IPC，不伪造模型或后端回执。

**统一测试动作**：模型调用前台 `powershell.exe -NoProfile -Command "Start-Sleep -Seconds 20"`。以下时间是工具开始到完成/取消事件之间的观测值，不是未来性能承诺，也不是整个模型回答时延。

| 用例 | 结果 | 观测与证据 |
| --- | --- | --- |
| 模型连通 | PASS | 真实模型回复 `E2E_READY` |
| 默认 Enter 排队 | PASS | 工具持续 20,954ms；先 `A_DONE`，随后才投递新用户消息并回复 `Q_DONE` |
| 菜单优先插话 | PASS | 工具持续 20,960ms，没有取消；工具结果结束后插入新要求，回复 `S_DONE` |
| Ctrl+Enter 打断并发送 | PASS | 工具开始后 176ms 结束；工具取消事件在新消息投递之前，随后回复 `I_DONE` |
| 独立停止 | PASS | 首次工具持续 237ms；旧排队消息转 held，保持自动调度暂停，没有自行回复 `HOLD_DONE` |
| 图片排队 → 停止 → 取回 | PASS | 文字恢复一致；打开真实图片预览后，比对 PNG base64 字节完全一致 |
| 真正页面重载后再次取回 | 初次 FAIL，修复后 PASS | 后台消息存在，但前端恢复入口缺失；修复后同一会话、同一后台实体再次取回，文字和图片字节一致 |
| 系统退出取消与窗口保留 | 当时 INCONCLUSIVE | 观察到原生退出确认框；助手未形成可靠的取消后保留结果。后续用户补验通过，单独记录于 §7.5，不改写当时自动探针结论 |
| 删除取消 | 当时 NOT RUN | 助手未完成该真实 UI 路径；后续由用户补验会话和项目两类取消，见 §7.5 |

#### 真实验收发现的缺陷

- `QueueBar.queueItemActions()` 原先为 `recovering` 返回空操作集。页面重载会清空 renderer 的内存草稿，SDK 仍保留完整消息，但该项显示“取回中”且用户无法再次取回。
- 修复：`recovering` 保留“取回编辑”操作，不提供自动重发；`recoverPending` 已有草稿冲突检查，防止再次取回覆盖当前输入。
- 变更文件：`packages/desktop/src/renderer/src/components/composer/QueueBar.tsx`、`SendModeMenu.test.tsx`。
- 先新增断言复现 RED，再修复至 GREEN：菜单/队列与发送 hook 定向 **57/57**；随后完整回归 **944 + 1357 = 2301 项通过**，类型检查及构建通过。
- 图片首次探针误以为图片胶囊会直接渲染 `<img>`；调整为打开真实预览后再比对数据。该探针修正与上面的真实恢复入口缺陷分开记录，不混为产品故障。

#### 证据、清理及未覆盖项

- 总表：`.local/validation/message-control-e2e/summary.json`；各模式的 `*-result.json` 保留事件顺序、工具时间和会话 ID。
- 截图：`steer-menu.png`、`queue-after.png`、`interrupt-after.png`、`restore-after.png`、`reload-before-fix.png`、`reload-after-fix.png`。
- 重载缺陷状态：`reload-before-fix.json`、`reload-after-fix.json`；`Page.reload` 后已核对 navigation 类型为 reload，未将被导航策略阻止的 `location.reload()` 当作刷新成功。
- 回归日志：`reload-red.log`、`reload-green.log`、`reload-typecheck.log`、`reload-build.log`、`final-tests.log`，均位于上述证据目录。
- 清理：测试实例和 9235/9236 调试端口已关闭；临时工作区已移除；测试 `auth.json` / `models.json` 凭证副本已删除，保留无凭证的验收记录与截图。正式 Percho 进程仍在运行，未重启、未替换安装包。
- 本次助手测试只证明上述单一真实模型及前台等待命令路径；不外推为全部模型、MCP、后台子代理、网络断连等场景均通过。原生退出/删除取消的后续人工证据见 §7.5。未 commit / push / tag / 发布。

### 7.5 用户真机补验确认（2026-10-29）

**证据来源**：本会话用户按约定验收步骤操作后，明确回报以下四项全部通过，并提供过程及结果截图。此处登记为**用户真机验收**，不是助手重新执行或自动探针转为 PASS；原始截图保留在会话附件中，未声称已另存为项目文件。

| 补验项 | 用户结果 | 验收含义 |
| --- | --- | --- |
| 退出取消 | PASS | 取消退出后，开发窗口、会话及未发送消息保留 |
| 删除会话取消 | PASS | 在未发送消息专项确认中取消，测试会话及消息未被删除 |
| 删除项目取消 | PASS | 在专项确认中取消，临时项目、会话及消息保留 |
| 最后取回消息 | 完整 | `PENDING_KEEP_验收消息不要丢` 完整回到输入框；截图可见“取回中”与回填文本 |

用户原话确认：“你让我验证的，全部通过。”截图包含临时项目的移除确认、未发送消息专项确认及最终取回状态，与回报一致。

**结论**：此前留给用户的两类待验（退出取消、删除取消）已关闭；本次约定的 B 增强版核心功能与用户补验通过。§7.2 中更多实际工具/第三方执行器的兼容性范围仍未覆盖，不把这次确认扩大为全平台、全模型或全部后台任务都能取消的保证。

本次补验登记仅更新文档及待办，没有修改业务代码、重跑测试、提交 Git、发布版本或替换正式安装包。
