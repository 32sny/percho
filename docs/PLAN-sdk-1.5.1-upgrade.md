---
类型: 技术方案
状态: §19.14为当前真源：GC宿主租约竞态已定向复现并最小修复（独立PASS；目标65/65、backend1102/1102、desktop1412/1412、3strict/typecheck/lint过）；G7平台与发布收口未完成，旧G1/G6证据不含GC修复不能冒最新候选，非完整发版通过
创建: 2026-11-03
更新: 2026-11-15
适用: Percho fork（32sny/percho）——Pi SDK 1.5.1 隔离验证/有条件切换；1.4目标为历史快照
---

# Pi SDK 1.5.1 升级与 message-control 补丁迁移

> **当前结论（2026-11-15）：SDK 1.5.1 已在开发工作区运行，迁移核心及列明的 Windows 场景已通过；完整升级验收尚未结束，不是只剩编译。** §19.13.4 的宿主 GC 租约竞态已定向复现并最小修复（见 §19.14，独立PASS）；尚需重冻结候选并在 GitHub 运行三平台 CI（旧G1/G6证据不含GC修复）；安装/更新与发布另按门槛处理。
>
> 本文已从旧名更名为 `PLAN-sdk-1.5.1-upgrade.md`，当前文档引用同步更新，仓库外历史证据不改名。§一至九保留最初 1.4.0 方案与当时授权，§十记录转向 1.5.1，§十九记录后续实施结果；**历史待办和授权不能当成当前状态，最新真源为 §19.14**。
>
> **本文与其他文档的关系（先看这段）**
>
> | 文档 | 角色 | 是否需要你现在批准 |
> | --- | --- | --- |
> | **本文** `PLAN-sdk-1.5.1-upgrade.md` | **SDK 工作流唯一实施方案（不等于全局唯一已批准事项）** | 已获准迁移；新增风险按定向核验处理，Git/发布另授权 |
> | `PLAN-session-message-control.md` | queue / steer / interrupt 三态的**已验收行为契约**；本文不得改变其语义 | 否（只做约束） |
> | `PLAN-percho-feature-catalog.md` | 全局取舍与先后（背景） | 否 |
> | 分屏 / 撤销 / 搜索 / 文件树 / 其余各步 | 各有或暂无方案，**均不在本文范围** | 否 |
>
> 本文是 P1 的完整方案；功能取舍的全局顺序见 [功能取舍清单](PLAN-percho-feature-catalog.md)。
> 历史取证基线：HEAD `1b92149`、上游快照 `1145c7a`（当时领先 36 / 落后 34）。2026-11-13 本地复核 HEAD 未变，`upstream/main` 已为 `87476fa1`（SDK 1.5.1）；本轮未 fetch，不宣称远端最新。
> **2026-11-15 上游固定ref重评（git本地核，见§19.13.1）：** 本地v0.6.6 tag（fork同名/SDK1.0.4）不能冒上游；上游v0.6.6=`b56f212`（SDK1.4.0）、v0.6.7=`8a4f43b`（SDK1.4.0）、v0.6.8=`87476fa1f884d3590e58400b4099212593a5a047`（SDK1.5.1）。旧总规划“领先36/落后34”属旧快照 `1145c7a` 的历史记录，不是当前状态。
> **历史1.4基底为 `1145c7a7d9f32ca2f3e7d7334bea89dcf4916cb2`；当前1.5.1验证固定 `87476fa1f884d3590e58400b4099212593a5a047`（v0.6.8）。** 不从浮动分支取补丁；下面§一至九保留原实施过程及行为契约，版本目标与当前验收状态以§19.14为准，§十保留路线调整记录。

## 一、目标与阶段边界（历史 1.4.0 方案；当前见 §19.13）

### 1.1 为什么这是第一步

三条事实决定了它必须先做：

1. 固定上游快照 `1145c7a` 中的长会话渲染、系统通知、Provider 拉模型、Lexical 等功能与 SDK 1.4.0 一起演进。先处理 SDK 兼容，再同步这些功能，可减少同时排查多类冲突；后续上游版本不能默认仍适用本轮基底。
2. **现有约 810 行自研 SDK 补丁**（`patches/@earendil-works+pi-coding-agent+1.0.4.patch`）提供 `message-control` 子系统。升级后不能继续沿用该版本补丁；需逐点重移植并验证，不把局部文本可应用等同兼容。
3. **早做比晚做便宜**。你在 1.0.4 上自建的功能越多，未来补丁重移植与冲突面越大。

### 1.2 交付契约

升级完成后必须同时满足：

1. 仓库依赖 `pi-coding-agent` / `pi-ai` = `1.4.0`，`npm ci` 可从零复现（`postinstall` 能应用新补丁）。
2. **排队 / 插话 / 打断三模式行为不变**：`MessageMode = queue | steer | interrupt`，`QueueBar` 五个动作（steer / interrupt / resend / recover / discard）全部可用。
3. **可靠性协议不变**：`requestId` 幂等、`MessageAck.disposition`、`held` / `recovering`、`revision` 冲突拒绝、`sendAfterStop`。
4. 原始 SDK 的 `followUp` 排队、上游补丁的压缩前宿主暂停和 `retryLastFailedTurn` 与本地协议正确协作；排队和本地重试本已存在，不将它们一概称为升级新增功能。
5. 现有测试全绿；`typecheck` / `lint` 不新增告警。

### 1.3 非目标

- 不做 data 目录迁移（`~/.percho/agent`），那是 P8，需单独批准。
- 不升级全局 Pi CLI，那是独立决策；本方案只修改仓库依赖，不替换已安装 Percho 的内置包，边界见 D5。
- **不改 `ToolCallCard` 插件槽位**。该槽位是上游 `8a4f43b`（#154 长会话渲染优化）删掉的，不属于 SDK 升级范围，归 P2 处理。
- 不接 Lexical、不分屏、不做文件树。
- 不重写 message-control 的产品语义（只做"能不能少写点"的瘦身）；`PLAN-session-message-control.md` 的三态与可靠性语义是**约束**，不是可选项。
- 不整体追平上游；本方案只处理固定基底下与 SDK 兼容直接相关的改动。

## 二、现有实现定位

### 2.1 事实基线（历史版本记录与本次复核）

CLI、安装包版本沿用原方案记录；仓库依赖版本沿用前次 P1-0 的 npm ls 报告，本次文档修订未重跑。当前本地上游引用及固定提交对象由本会话复核。

| 副本 | 版本 | 位置 |
| --- | --- | --- |
| 全局 Pi CLI | 1.2.0 | `%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent` |
| Percho 安装包内置 | 1.0.4 | `%LOCALAPPDATA%\Programs\Percho\resources\pi-package` |
| 本仓库 dev 依赖 | 1.0.4 | `node_modules`（三处 `package.json` 一致） |
| 本轮固定目标 | 1.4.0 | 固定上游提交 `1145c7a7d9f32ca2f3e7d7334bea89dcf4916cb2` |
| 当前本地上游引用 | 1.5.1 | `upstream/main` = `87476fa1`（2026-11-13 复核，未 fetch） |

**坑要记住**：在 Percho 的 agent shell 里跑 `pi --version` 会显示 `1.0.4`，因为 `PI_PACKAGE_DIR` 指向 Percho 内置包。查真实 CLI 版本要用普通终端或 `env -u PI_PACKAGE_DIR pi --version`。

### 2.2 两侧补丁结构（已核实）

| 项 | 本地（1.0.4） | 上游（1.4.0） |
| --- | --- | --- |
| 补丁文件 | `pi-coding-agent+1.0.4.patch`（810 行） | `pi-coding-agent+1.4.0.patch`（945 行）+ `pi-agent-core+1.4.0.patch` |
| 触及文件 | `agent-session.js/.d.ts`、`message-control.js/.d.ts`（新增）、`index.d.ts` | `agent-session.js/.d.ts`、`compaction/compaction.js/.d.ts`、`extensions/types.d.ts`、`index.d.ts`；core 补丁另触及 `agent.js`、`agent-loop.js`、`agent.d.ts`、`types.d.ts` |
| 核心机制 | `enableMessageControl()`、`MessageControlHandle`、`submitPublicPrompt`、`enqueuePrepared`、`clearLegacy`、`abortLegacy`、`_messageControl` 钩子 | `CompactionPause`、`CompactionRequestPolicy`、`setCompactionPolicy`、`_setHostPause`、`_notifyHostResult`、`_validateHostDispatch`、`_reconcileHostPending`、`_hostPendingContextIsCurrent` |

上表“上游”均指固定提交 `1145c7a`，不是当前分支尖端。已只读确认两个 Git blob：coding-agent 补丁 `6fee13843ef84cb54b5754d9f911c9fe8a5b88e5`；agent-core 补丁 `638b07cb813ba824900e25a13046a2e033efe3e1`。P1-3 提取后须核对对象内容；旧取证临时目录不是唯一来源。

### 2.3 为什么不能"直接换补丁"（hunk 重叠实据）

两份补丁改的是**同一批方法**，只是目的不同：

| 被改方法 | 本地补丁的意图 | 上游补丁的意图 | 结论 |
| --- | --- | --- | --- |
| `prompt()` | 分流到 `submitPublicPrompt`（受控投递） | 接入宿主暂停与未决消息校验 | **同一行区域，必须手工重放** |
| `_runAgentPrompt()` | 走 `_messageControl` 钩子 | 压缩请求前暂停 | **同上** |
| `_queueSteer` / `_queueFollowUp` | 托管入队和消息身份关联 | 插入 `_hostPolicy` 分支 | **共享修改区域，逐处合并并验证** |
| `message_start` 处理块 | 托管实体认领、控制旧队列移除 | 增加宿主策略条件 | **共享修改区域，防重复消费** |
| `sendMessage()` | custom 消息走托管入口 | 宿主策略分流 | **共享修改区域，不能旁路仲裁** |
| `clearQueue` / `abort` / `dispose` | 冻结、取消和销毁托管实体 | 未决消息 reconcile / 清理 | **逐处合并，不丢消息或重复结算** |
| `retryLastFailedTurn()` | 本地重试并带 `hasScope()` / `runAuxiliary()` 封装 | 上游也新增同名方法 | **复用重试主体须保留等价托管封装，不可整段替换** |
| 压缩期行为 | `ControlPhase.compacting` + `autoDispatchPaused` | 上游补丁的宿主暂停/恢复 | **先明确职责和验证时序，再评估精简** |

取证报告指出至少八处共享修改区域：`prompt`、`_queueSteer`、`_queueFollowUp`、`message_start` 处理块、`sendMessage`、`clearQueue`、`abort`、`dispose`；运行入口重构另需对齐。不能把旧补丁直接叠到上游补丁上当作迁移完成；应在上游基底逐点重放并重新生成。本次未执行补丁应用，不断言所有 `git apply` 尝试必然失败。

1.4.0 原始运行入口为 `_startRun` → `_prepareRun`，上游补丁另引入 `_runAgentPrompt(messages, failedResponse, onStarted)`。钩子存在仅证明有移植落点；`assertLive()` 的 await 覆盖、generation、取消、销毁和 settlement 时序仍待 P1-5/P1-6 验证。“无符号缺失型阻断”不等于消除 R2，也不证明 held 可原样迁移。

### 2.4 本地控制面清单（哪些是 Percho 独有）

| 能力 | 载体 | 能力来源（原始 SDK / 上游补丁） | 处置 |
| --- | --- | --- | --- |
| 运行中排队（followUp） | `MessageMode = "queue"` | **原始 SDK 有底层 API**（`streamingBehavior: "followUp"`、`getFollowUpMessages`） | 可复用执行载体；本地幂等、确认、容量及恢复协议先保留，不直接删入队逻辑 |
| 插话（steer） | `MessageMode = "steer"` | **原始 SDK 有底层 API**（`streamingBehavior: "steer"`）；上游补丁增加宿主策略分支 | 保留本地工具批次边界语义及消息关联；验证后才能裁剪 |
| 打断（interrupt + sendAfterStop） | `MessageMode = "interrupt"`、`operation.sendAfterStop` | 无 | **保留** |
| 幂等投递 | `requestId` + `MessageAck.disposition` | 无 | **保留** |
| 队列项状态 | `ControlledItem.state = queued / held / recovering` | 无 | **保留** |
| 取回编辑 | `recovery.expectedRevision` | 无 | **保留** |
| 压缩与调度暂停 | `ControlPhase.compacting`、`autoDispatchPaused` | **原始 SDK 无等价宿主暂停协议**；`CompactionPause` / `CompactionRequestPolicy` 来自上游 Percho 补丁 | 保留已验收的手动/自动压缩区别及 held 语义，按 §2.6 验证职责后再裁剪 |
| 压缩后重试上一轮 | 本地 `retryLastFailedTurn` | **原始 SDK 无**；同名方法来自上游 Percho 补丁 | 可复用主体，但保留 `hasScope()` / `runAuxiliary()` 等价托管控制；先验证再去重 |
| 控制快照 | `ControlSnapshot`（`runtimeId` / `revision` / `phase`） | 无 | **保留** |

**当前裁决**：不能仅凭底层 API 存在或方法同名，批准直接删除任何协议钩子。入队、重试主体和压缩暂停可在 P1-7 逐项评估复用；幂等、ack、held/recovering、revision、sendAfterStop 及取消生命周期必须保留等价行为。不以补丁行数下降为目标。证据来源和本次抽查边界见频道 `IMPL-NOTES.md`。

### 2.5 调用面（决定"改不改得动"）

`message-control` 的引用面（已核实）覆盖三层：

- shared：`message-control.ts`、`session.ts`、`ipc-channels.ts`、`transcript/types.ts`、`index.ts`
- backend：`pi-backend.ts`、`session/message-control.ts`、`session/registry.ts`
- desktop main：`main/index.ts`、`main/ipc/sessions.ts`
- desktop renderer：`stores/pending-payloads.ts`、`stores/session-loading.ts`、`components/composer/use-composer-send.ts`

含义：**这是协议级改动，不是局部改动**。任何"顺手简化 SDK 补丁"的动作都可能打断 renderer 的乐观更新与恢复路径，所以必须按阶段门走。

### 2.6 暂停职责与压缩契约（实施前必须落实）

- `message-control` 继续拥有用户实体的 held/recovering、幂等、revision、stop/interrupt 后的调度决策；上游宿主暂停负责压缩请求与宿主结果协调。不能让两侧各自独立消费或释放同一消息。
- P1-5/P1-6 必须明确并验证：暂停由谁置位、谁恢复、恢复条件、cancel/dispose/retry 如何结算；一侧恢复不能自动释放另一侧仍持有的用户项，也不能相互等待导致永久暂停。
- 以 `PLAN-session-message-control.md` §4.1/§6.1 为约束：**手动压缩期间三模式拒绝并保留草稿；自动压缩中 queue 保留、steer 按模型请求边界生效、interrupt 取消并等待停稳**。不能统一改成“所有压缩期提交都变 held”。
- stop/interrupt 已冻结的旧用户 held 不因压缩完成、重试或迟到 settled 自动恢复；明确恢复应保持实体身份与 revision。
- 同时测试托管与未启用托管路径、宿主策略启用/未启用路径。仅保留两套标志并不等于安全；职责无法对齐即停止，不靠开关绕过。

## 三、架构决策

### D1：以上游补丁为基底，本地补丁只保留"Percho 协议"独有的钩子

不做"两份补丁合并"，也不做"本地补丁覆盖上游"。做法：先让仓库跑在上游 1.4.0 补丁上（功能可能短暂退化），再把本地 `_messageControl` 钩子逐个重放回上游已改过的方法。

理由：复用已取证的上游基底，减少重复维护；本地保留当前没有等价实现的协议行为。此为选定路径，不宣称是唯一技术可行路径；固定 1.4.0 补丁也不代表上游继续维护该旧版本。

### D2：补丁只能"改源码 → 重新生成"，不能手改 patch 文件

`patch-package` 的产物是 `node_modules` 的 diff。先按 §4.1 在 P1-3 切换活动补丁并正常安装 1.4.0；到 P1-6 再修改 `node_modules/@earendil-works/pi-coding-agent/dist/`，使用 `npx patch-package @earendil-works/pi-coding-agent` 重新生成包含上游基底及本地钩子的完整补丁。旧 1.0.4 补丁的外部备份继续保留。

理由：重构改变了上下文及语义落点；禁止手写 patch 猜测冲突。基底补丁从固定 Git 对象原样提取，重移植后的自研补丁通过 `patch-package` 生成，并用启用生命周期脚本的 `npm ci` 验证可复现。

### D3：先"能跑"，再"功能对齐"（两段式）

- 阶段 A：升级依赖 + 上游补丁，验证可安装性，并记录 typecheck / 测试 / 隔离冷启动的实际结果。本地协议 API 暂缺可能导致测试或启动失败，须逐项归因，不能伪报全绿或移除调用绕过。仅在用户批准 P1-3 时接受开发基底的暂时功能缺失；**不允许数据损坏或替换正式安装包**。
- 阶段 B：重放 message-control 钩子，恢复全部三模式与可靠性协议。

理由：一次性做完会因为"补丁不对 + 业务代码不对"两个错误源叠加而无法定位。分段后每段都有独立可判定的通过标准。

### D4：能力对齐以"用户可见行为"为判据，不以"代码结构相同"为判据

判定"插话是否还在"的方式是真机跑一次：运行中发 `steer` 消息，观察是否注入当前 run；发 `interrupt` 观察是否停止并投递。不看 diff 是否与旧实现相似。

### D5：CLI 与 Percho 内置包版本一致性，本方案只管仓库侧

仓库升到 1.4.0 后，Percho 安装包内置的 `pi-package` 仍会是旧版本（除非重新打包）。本方案**不承诺**安装包同步，只在验收清单里记一条"打包后复核内置包版本"。全局 CLI 是否升级由独立决策。

### 错误处理契约（Fail-closed）

| 场景 | 必须的行为 |
| --- | --- |
| 新补丁应用失败（`npm ci` 后 `patch-package` 报错） | 构建失败并中止，不允许"跳过 postinstall 继续跑" |
| SDK 内部符号缺失（本地钩子依赖的私有方法在 1.4.0 被改名/删除） | 立即停手，回到 ①-1 重新核对，不在业务侧加 try/catch 掩盖 |
| `MessageAck` 超时/不返回 | 保持现状语义：UI 显示未确认，不自动重投 |
| `revision` 冲突 | 拒绝覆盖并提示刷新，不静默重发 |
| 压缩期收到投递 | 按 §2.6 区分手动/自动压缩；已 held 的旧用户项不自动解冻，不丢草稿或载荷 |
| 升级后会话打开异常 | 停下排查，不回退到"删除会话文件"这类破坏性操作 |

## 四、执行状态机

步骤编号与 §七 完全一致；两步之间都要停手报告，不自动推进。

| 步骤 | 动作 | 出口（可判定） | 停止条件 |
| --- | --- | --- | --- |
| **①-0** | 基线核对（只读，含补丁现状） | HEAD、上游引用、版本、工作树、异常记录 | 前次报告已提交；本次补记上游引用变化，非远端复核 |
| **①-1** | 1.4.0 真实源码与固定补丁对照 | 区分原始 SDK / 上游补丁 / 本地协议，记录不确定项 | 前次报告有条件采纳；文档已纠错，不等于运行验收 |
| **①-2** | 建立回退点：完整工作区保护 + 经明确授权的本地 tag | 已提交基线、未提交文件及旧补丁均有可核验恢复来源 | 未批准 Git 操作、备份漏项或校验失败 → 停 |
| **①-3** | 按 §4.1 先准备匹配补丁，再更新依赖并验证 `npm ci` | 安装生命周期正常执行、两份新补丁和保留补丁应用成功 | 安装/补丁不可复现，或锁文件出现不明变化 → 停 |
| **①-4** | 上游基底验证：`typecheck` + 现有测试 + 隔离环境冷启动 | 逐项记录结果；对照升级前日志，区分协议暂缺、原有失败及升级引入 | 无法归因即停；不得以“无关错误 ≤ 20”视为通过，也不为跑通而静默降级 |
| **①-5（修订待批）** | 按 §4.2/§6.5 准备真实 SDK 测试、契约与缺口清单，不恢复生产接口 | 可运行测试有实际结果；接口缺失标 BLOCKED_MISSING_API，不冒充 RED | 不得用假控制器、跳过或预期缺失来制造通过；完成后停手 |
| **①-6（修订待批）** | 按 §4.2 逐片恢复真实实现，测试先于该片改动，生成补丁后复验 | 已恢复入口的行为测试通过；真实 RED→GREEN 或已有契约回归通过均如实记录 | 私有方法或暂停生命周期无法对齐即停；每片报告，不自动跨片 |
| **①-7** | 逐项复用裁决：原始 SDK 或上游补丁提供等价行为才裁剪 | 每项有等价证据，测试全绿；允许保留全部必要钩子 | 行为出现任何回归 → 回退该单项，保留本地实现 |
| **①-8** | 真机验收 §6.4 七条 | 七条全过 | 任一条不过 → 停手，不“带病继续” |
| **①-9** | 文档同步 `docs/sdk.md`、`docs/architecture.md`、本文状态 | 记录补丁职责、降级项、版本基线 | —— |
| **①-10** | 报告 `Passed / Inspected / Not run` + 提交建议 | 三分齐全，未跑的写明原因 | 不自动 commit |

### 4.1 P1-3 安装与补丁切换顺序（已执行，证据见频道）

根 `package.json` 的 `postinstall` 为 `patch-package`。因此不能先把依赖升到 1.4.0，再让安装生命周期碰到旧 1.0.4 补丁。

1. P1-2 已验收后，记录 Node/npm 版本与升级前 typecheck / 测试 / lint 基线；测试须隔离用户数据。发现失败先记录并归因，不借机修复其他问题。
2. 从固定提交 `1145c7a7d9f32ca2f3e7d7334bea89dcf4916cb2` 原样提取两份 1.4.0 补丁，核对 §2.2 blob；保留 `thinking-orbs` 等无关补丁。
3. 核验旧补丁备份后，把旧 1.0.4 补丁移出活动 `patches/` 目录（备份保留到验收及用户确认之后），放入两份匹配 1.4.0 的补丁；这是生成工具产物的切换，不手改其内容。
4. 同步修改三处 `package.json` 的目标版本，再执行正常 `npm install`，由包管理器生成锁文件并正常运行生命周期脚本。若失败，保留日志、立即停止，不用 `--ignore-scripts` 或手改锁文件掩盖失败。
5. 核对依赖树和锁文件 diff：coding-agent / pi-ai 为 1.4.0，打补丁的 agent-core 实际为 1.4.0；包重复实例、意外版本或额外依赖升级均须解释，否则停止。
6. 执行正常 `npm ci`，确认 postinstall 可复现、全部适用补丁成功。最终 P1-8 再在带有明确变更集的独立干净验证目录执行一次，不通过清理用户工作树制造“干净”。
7. 报告安装与补丁证据后停手。P1-3 只代表基底可安装，不代表本地消息控制已恢复；P1-4 即使无法冷启动，也应如实报告缺失 API，而不是临时关闭仲裁器绕过。

### 4.2 最小可测性安排（2026-11-13 提案，待单独批准）

**问题不是测试数量不够，而是执行入口整体缺失。** 当前 `message-control-sdk.test.ts` 有18项展开用例：17项在调用 `enableMessageControl()` 时失败，未托管路径1项通过（P1-4结果）。旧补丁的 MessageControl 本体同时依赖 `submitPublicPrompt`、准备/运行钩子、实体关联与生命周期；只恢复空接口或在测试里模拟控制器不能证明迁移兼容。现有backend适配器测试使用mock handle，只证明透传，不算SDK状态机覆盖。

#### P1-5：仅测试准备，不安装接口

- 允许修改 `packages/backend/test/message-control-sdk.test.ts` 及必要的同目录测试辅助文件；按 §6.5 补充缺口、修正误导标题和失败清理。必要的同runtime恢复检查可补在既有renderer测试中，不新增产品层。
- 保留全部现有契约断言；fixture 只负责真实SDK会话、内存模型流、门闩工具和临时目录。可以替换外部I/O或用可控gate暂停准备hook，**不得重写控制器、覆写队列消费/仲裁方法以模拟正确实现**。
- 不新增空 `enableMessageControl()`、mock handle、测试专属运行入口或代理控制器；不改 node_modules、patches、业务源码、依赖或产品开关。
- 用例名称/编号映射到 §6.5；执行接口前的就绪性检查只提供明确诊断。不得把“应缺少接口”写成期望断言，不用 skip/todo/expected-failure 把缺失包装成通过。保持非零退出并在报告中分类。
- 测试清理统一用 finally 释放门闩、恢复临时替换、dispose会话，fake timers必须复原；用有界waitFor等确定性事件，不能靠无限等待或宽泛超时充当RED。
- 出口：新增/保留用例和依赖钩子清单、实际运行记录、BLOCKED/RED/GREEN分类及缺口；不要求接口缺失时所有行为先红。P1-5完成后停手，另批P1-6-S1。

#### 结果分类（P1-5/P1-6 共用）

| 分类 | 判据 | 不得推导 |
| --- | --- | --- |
| BLOCKED_MISSING_API | 导入/接口/类型未恢复，目标行为尚未执行 | 不算行为RED，不能宣布测试覆盖已验证 |
| RED_BEHAVIOR | 真实SDK路径已抵达目标行为断言，实际状态/事件顺序不符 | 不把不受控的挂起或外部环境错误算行为失败 |
| GREEN_REGRESSION | 真实执行到断言且通过 | 只证明该用例；无需故意删除钩子制造RED |
| INFRA_FAILURE | fixture、隔离、依赖或测试执行器自身故障 | 先修测试设施并重跑，不改业务掩盖 |

#### P1-6：真实生产实现的四个切片（每片独立批准）

| 切片 | 最小完整范围 | 出口与禁止事项 |
| --- | --- | --- |
| S1 托管核心与普通投递 | 恢复真实 MessageControl 本体及声明/导出；连接 enableMessageControl、公开prompt/steer/followUp/custom路由、enqueuePrepared、message_start身份关联、基础运行入口和dispose清理；保留未托管路径 | 这是可运行闭环，不是无功能壳。先跑idle/幂等/revision/queue/steer/custom/未托管组；同时跑全SDK控制测试并分类失败。不得在S1删减既有stop/recover能力，只是尚未验证的改动不算通过 |
| S2 准备取消与结算 | 对齐 `_prepareRun` / `_runAgentPrompt` 前后的generation检查、各await、interrupt/stop、迟到续体、权限signal、dispose与重入处理 | 证明旧准备不能迟到启动、非合作工具停稳后才发送、30秒blocked不放开并发、二次stop取消sendAfterStop；无并行新run或重复commit |
| S3 压缩与宿主暂停 | 按真实manual/auto压缩入口对齐本地调度与 `_hostPolicy` / `_hostPause`，验证stop/interrupt、取消/失败与显式恢复 | 不通过永久禁用宿主策略逃避冲突；手动三模式拒绝、自动分模式语义、旧held不解冻及无永久等待都须实测 |
| S4 重试与恢复闭环 | 保留上游retry主体及本地hasScope/runAuxiliary等价作用域；验证失败/取消/paused重试、recovering同runtime再次取回和全入口生命周期 | 跑全部SDK控制/后端/renderer相关回归与完整typecheck/test/lint；正常npm ci后再次验证，不把局部通过当最终验收 |

每片流程：先记录固定输入/测试及改动前结果 → 恢复真实钩子 → 跑目标组及完整SDK控制测试 → 用patch-package生成完整补丁 → 正常npm ci → 重跑该片目标组/完整SDK控制测试并保存结果。行为已通过则标GREEN_REGRESSION；实现后才可达的用例不能倒填“实现前已RED”。若接口恢复和语义修复不可再细分，接受有来源的契约回归证据，不造假TDD历史。

S1可能恢复旧控制器的多个能力，不代表S2–S4验收自动通过。任何需要修改核心agent补丁或backend产品代码才能推进的事项，先给出必要性与具体范围再批准，不能按“兼容”无限扩张。阶段中间态仅用于隔离验证，不提供正式用户会话。

## 五、受影响文件与变更策略

| 模块 / 逻辑 ID | 目标路径 | 变更类型 | 核心策略 |
| --- | --- | --- | --- |
| 依赖版本 | `packages/backend/package.json`、`packages/desktop/package.json`、`packages/shared/package.json` | 修改 | `pi-coding-agent` / `pi-ai` → `1.4.0`（三处同步） |
| 锁文件 | `package-lock.json` | 修改 | 只接受 `npm install` 生成，不手改 |
| 旧补丁 | `patches/@earendil-works+pi-coding-agent+1.0.4.patch` | 移出活动补丁目录 | 切换前逐字节备份并校验；备份不会因活动文件移除而删除，tag 不代替工作区备份 |
| 新补丁 | `patches/@earendil-works+pi-coding-agent+1.4.0.patch`、`patches/@earendil-works+pi-agent-core+1.4.0.patch` | 新增 | 取上游版本为基底，再叠加本地钩子后重新生成 |
| SDK 会话适配 | `packages/backend/src/pi-backend.ts`、`packages/backend/src/session/message-control.ts` | 修改 | 只改与 1.4.0 签名不一致处；不重写协议 |
| 会话注册/生命周期 | `packages/backend/src/session/registry.ts`、`packages/backend/src/session/shutdown.ts` | 修改 | 跟随上游 `shutdown` 变更（上游 `fa94709` 已改此文件） |
| 子代理执行器 | `packages/backend/src/tools/subagent/runner.ts` | 修改 | 上游 1.4.0 改了此处 2 行，跟随 |
| IPC 契约 | `packages/shared/src/message-control.ts`、`packages/shared/src/ipc-channels.ts` | 修改（仅必要处） | 保持 DTO 对外语义不变，避免 renderer 大面积改 |
| renderer 恢复链 | `packages/desktop/src/renderer/src/stores/pending-payloads.ts`、`stores/session-loading.ts`、`components/composer/use-composer-send.ts` | 可能修改 | 仅当 backend 契约变化时才动，优先不改 |
| 文档 | `docs/sdk.md`、`docs/architecture.md` | 修改 | 记录 1.4.0 行为变化与补丁职责划分 |

## 六、测试设计与验证（TDD 契约）

### 6.1 现有可复用的守护测试（已存在，必须全绿）

**首要行为契约**：`docs/PLAN-session-message-control.md`（状态：已验收通过，含用户真机补验）定义了 queue / steer / interrupt 三态与幂等、held、recovering、revision 语义。**本文任何改动不得让其验收结论失效**；升级后应能逐条复述该方案第七章的验收项并仍然成立。

| 测试 | 守护的行为 |
| --- | --- |
| `packages/backend/test/message-control-sdk.test.ts`、`packages/backend/test/message-control.test.ts` | SDK 真实循环时序、取消、消息仲裁及后端适配 |
| `packages/desktop/src/main/ipc/sessions.test.ts` | 会话 IPC 契约 |
| `packages/desktop/src/main/message-control-exit.test.ts` | 退出时的控制面清理 |
| `packages/desktop/src/renderer/src/stores/pending-payloads.test.ts` | 乐观投递与恢复 |
| `packages/desktop/src/renderer/src/stores/session-loading.test.ts` | 装载时控制快照替换 |
| `packages/desktop/src/renderer/src/components/composer/use-composer-send.test.ts` | 发送/排队/守卫 |
| `packages/desktop/src/main/ui-plugins/contract-baseline.test.ts` | 插件契约（防顺手改坏） |

### 6.2 必须覆盖的行为契约（测试先准备，结果按 §4.2 分类）

1. **模式分流**：`queue` → 不打断当前 run；`steer` → 注入当前 run；`interrupt` → 停止后投递。
2. **幂等**：同 `requestId` 重复提交只产生一条实体。
3. **revision 冲突**：`recovery.expectedRevision` 过期 → 拒绝并返回可判定错误。
4. **暂停与压缩**：手动压缩三模式拒绝并保留草稿；自动压缩 queue/steer/interrupt 按既有契约执行；stop/interrupt 形成的旧 held 不因压缩完成或重试自动解冻。覆盖 §2.6 两侧暂停的释放、取消和失败分支。
5. **`recovering` 恢复**：保持同一后端 runtime，renderer 重载后仍能再次取回完整未确认项；不承诺跨进程/崩溃恢复。

已有用例能覆盖则复用或补充，不机械重复新增。补充准备期各 await 后取消/dispose、retry 的托管作用域、迟到 settled 与重复 message_start 的定向断言。RED 必须命中目标行为；仅因导出缺失、导入失败或测试无法启动不算行为 RED。

### 6.3 命令（以实际脚本为准）

```bash
npm run typecheck
npm test -w @percho/desktop -- <test-path>
npm test -w @percho/backend -- <test-path>
npm run lint
node scripts/smoke-backend.mts        # 存在则必须先跑通
node scripts/smoke-subagent.mts       # 触达 runner 改动时必跑
```

### 6.4 真机验收（不能用单测替代）

1. 长任务运行中发普通消息 → 排队，在任务自然结束边界按 FIFO 投递，不等待最终 `agent_settled` 才消费；
2. 运行中「插话」→ 当前 assistant 回复及工具批次（含结果 hook）完成后、下一模型请求前注入；
3. 运行中「打断」→ 停止当前 run 并投递新消息；
4. 队列项「取回编辑」→ 编辑后重发成功，旧实体被替换而非新增；
5. 分别验手动压缩拒绝并保留草稿、自动压缩的 queue/steer/interrupt；另验旧 held 不因压缩完成自动恢复，宿主暂停不造成永久阻塞；
6. 同一后端 runtime 内重载 renderer → recovering 项仍可再次取回，文字/图片/附件完整；不以强杀进程后恢复作为本轮承诺；
7. `git status` 在会话中保持正常（补丁不应影响权限与 Git 工具）。

### 6.5 测试到真实钩子的覆盖表（待执行）

| 契约/现有用例组 | 真实生产落点 | 当前证据与补足要求 |
| --- | --- | --- |
| idle提交、幂等、runtime/revision、容量 | enableMessageControl / submit / snapshot / remember / recover | 旧17项均阻塞在接口，先保留。backend mock handle透传测试不可替代本组 |
| queue/steer工具批次、模式切换、同文本不同ID、custom只commit一次 | enqueuePrepared、_queueSteer/_queueFollowUp、message_start、trackMessage、sendMessage | 现有工具gate和模型请求事件可复用；补公开prompt/steer/followUp/custom nextTurn路径，断言不重复消费与身份不进入模型正文 |
| interrupt、stop、二次stop、30秒blocked | generation、abortLegacy、run settlement、operation.sendAfterStop | 现有真实非合作工具用例可复用；门闩必须finally释放，不把cleanup挂起算RED |
| 准备期取消/dispose | prompt中的extension/input/auth/checkCompaction、_prepareRun中的before-agent/images以及运行入口交接 | 现有仅图片归一化gate；按实际await列表逐项暂停，再stop/interrupt/dispose，释放后断言旧输入未进入模型。新增门闩不能替代被测仲裁逻辑 |
| 手动压缩 | 实际session.compact()、受控摘要流、compactionKind/manual | 原“manual…auto…”用例仅设置私有_compactionAbortController，只是局部守卫测试。保留但改名，不再声称自动覆盖；新增真实compact调用并在摘要请求门闩内检验三模式拒绝和载荷保留 |
| 自动压缩与双暂停 | 真实threshold/overflow压缩、setCompactionPolicy、host结果/恢复、托管stop | 用内存模型构造阈值/溢出且完整usage的历史，通过正常prompt触发；分别覆盖宿主策略开/关、取消/失败/显式恢复。不能仅手改私有flag宣称端到端通过 |
| retry作用域 | retryLastFailedTurn、hasScope/runAuxiliary、_runAgentPrompt | 原控制测试无覆盖；准备真实失败响应ref，断言不重发原用户、busy/paused下不启动、准备期取消不迟到重试、结算后可继续，不重放已执行工具 |
| recovering与renderer重载 | recover、getSnapshot、subscribe、同runtime后端与renderer投影 | 现有stop+recover只验证一次完整载荷，session-loading验证快照替换；补重复取回、载荷/ID不丢、旧revision拒绝与显式编辑重发。不得把第二个SDK会话冒充同runtime重载；真实页面重载保留P1-8人工验收 |
| 未托管SDK | 不启用enableMessageControl的公开prompt | 现有1项通过，后续每片都必须保留通过，防迁移污染普通SDK调用 |

统计禁止将标题当覆盖事实；本表为待执行断言设计，不是新增用例已实现或已通过的声明。

## 七、实施步骤与验收清单

- [x] **①-1 取证报告已提交**：前次会话报告取得原始 1.4.0 源码并对照固定上游补丁；本次有条件采纳及抽查，非独立全量复验，见频道记录。
- [x] **①-2** 回退tag与787文件备份/解压校验已完成，详见频道。
- [x] **①-3** 固定补丁+正常install/ci通过；不代表功能通过。
- [ ] **①-4 功能门未通过**：检查已执行、有限测试适配后typecheck和46项定向通过；17项控制器入口缺失未解决，全量未重跑。
- [ ] **①-5** 批准§4.2门禁修订后，仅测试准备及BLOCKED/RED/GREEN分类；完成后停手。
- [ ] **①-6** 另行逐片批准S1–S4：真实实现闭环、运行与补丁复现证据；不人为制造RED。
- [ ] **①-7** 对原始 SDK / 上游补丁的等价行为逐项裁剪并回归；允许保留所有必要本地钩子，不设行数目标。
- [ ] **①-8** 真机跑 §6.4 七条
- [ ] **①-9** 更新 `docs/sdk.md` / `docs/architecture.md`，记录补丁职责与降级项
- [ ] **①-10** 报告：`Passed / Inspected / Not run` 三分，并给提交建议（不自动 commit）

### 回退方案

- P1-2 先记录 HEAD、index/worktree 状态及文件清单；备份所有已修改、暂存和未跟踪的用户文件，以及根 `HANDOVER.md`、频道记录和已知相关忽略文档。备份放仓库外，逐文件校验哈希；排除 `node_modules`、构建缓存与用户凭证。不能遗漏 P0 文档或默认删除 `_p1_compare.py` / `_p1_probe.py` 等未知归属文件。
- 本地 tag（如 `pre-sdk-1.4`）仅在用户明确允许后创建，若同名已存在则停下确认，禁止强制覆盖。tag 只记录 HEAD，不保护未提交内容；不能代替文件备份。
- 保留三处 manifest、锁文件、旧补丁及后续 P1 改动清单。失败时先停手报告并获确认，核对文件有无并发修改，再按清单定点恢复本轮文件；恢复旧依赖与活动补丁组合后运行正常 `npm ci`。清单外的 P0 和用户改动不覆盖。
- **禁止 `git reset --hard`、`git clean`、`git checkout -- .` 或整目录覆盖。** 备份/恢复验证不得删除用户数据或正式会话。
- 旧补丁可以在 P1-3 移出活动目录，但外部备份保留至 P1-8 通过且用户同意清理；当前临时取证目录也不自动清理。

## 八、风险与对策

| # | 风险 | 等级 | 对策 |
| --- | --- | --- | --- |
| R1 | 两份补丁改同一批方法，重放顺序错导致 run 卡死 | **高** | 分两段式（D3）；基底阶段记录缺失与失败，恢复后跑完整三模式时序和真机验收 |
| R2 | 私有方法缺失、重命名或生命周期/await 时序变化 | **高** | 已有落点不等于语义兼容；P1-5/P1-6 验取消、generation、scope 与 settlement，不用 try/catch 掩盖 |
| R3 | `patch-package` 生成的补丁不可复现（行号漂移） | 中 | 只用 `npm ci` 验证；提交前在干净目录重装一次 |
| R4 | 本地调度暂停与上游宿主暂停冲突 → 消息丢失或永久阻塞 | **高** | 按 §2.6 明确职责并测试；优先已验收契约，不能仅以“两套都保留”当兼容证据 |
| R5 | 浮动上游已升 1.5.1，误引新补丁或其他功能 | **高** | 只用固定 `1145c7a` 的 1.4.0 补丁，按文件移植必要兼容项；不 merge/cherry-pick，未经授权不改历史 |
| R6 | 安装包内置 `pi-package` 与仓库版本不一致 | 中 | 验收清单加"打包后复核内置版本" |
| R7 | 全局 CLI 仍 1.2.0，与 1.4.0 在迁移前共写 `~/.pi/agent` | 中 | 本方案不动 CLI；数据目录迁移方向已定但仍在 P8 单独执行，迁移前避免并发写同一会话（见功能清单 §十） |

## 九、审查清单与当前授权

- [x] 用户批准本轮仅修正升级计划和频道记录；不安装、不改源码/依赖/补丁，不创建分支、commit、push 或 tag。
- [x] 本轮目标保持 SDK 1.4.0，基底固定为 `1145c7a`；不追随当前 `upstream/main` 的 1.5.1。
- [x] P1-0/P1-1 的前次取证报告已登记来源与边界；本次未重复联网取证，未把历史报告改写成本次实测。
- [x] P1-2/P1-3已分别批准并执行，P1-4已执行检查与有限测试适配；接受开发基底暂时功能缺失，不替换正式安装包。
- [ ] 批准§4.2的门禁修订及P1-5测试准备：接受接口缺失记BLOCKED，不要求假行为RED；不得改生产接口。
- [ ] P1-5报告后，单独批准P1-6-S1真实托管核心闭环；S2–S4仍分别报告放行。
- [ ] P1-4缺失项的功能验收在真实控制恢复后补齐；修订流程不降低最终全部行为通过的要求。

**行为正确性优先，P1-7 不要求强行瘦身。全局 CLI、发布、数据目录迁移不在本轮范围。历史授权截至上列记录；当前变更与执行边界以下节为准。**

## 十、1.5.1 路线调整与隔离验证（已批准执行）

### 10.1 目标、非目标与当前检查点

用户原文：“可以，按你的建议，调整方案后执行”。保留本fork及自研交互，以固定v0.6.8的SDK1.5.1两份补丁为基底，验证并在通过门槛后将开发依赖切至1.5.1。不在1.4继续S3/S4，也不重建为上游源码树。

1.4成果快照：`C:/Users/Administrator/percho-backups/sdk-140-checkpoint-20261113-150221/`，795文件ZIP逐文件SHA256已核验，包含未提交补丁/测试/P0文档及频道；ZIP SHA256 `eeb08bf34138dceb2faede66aab5e32c7629dad62f75d7a17e9659299650ac50`。`pre-sdk-1.4` tag仍仅指升级前HEAD，不能代替当前快照。旧日志保留在此前备份目录。

独立验证副本：`C:/Users/Administrator/percho-validation/sdk-151-20261113-150221/`，由当前工作区快照逐字节复制，不是新fork、无Git历史操作、不共享node_modules/用户数据。初始文件校验与快照一致。

不合入v0.6.8的Lexical、归档/分页存储、远程访问、UI/插件槽位、目录迁移等独立功能。不发布、不替换正式安装包、不升级CLI、不commit/push/tag/清理原工作区。真实模型请求和正式用户数据不用于验证。

### 10.2 可复用与必须重核的能力

复用当前54项真实SDK测试、S1/S2真实MessageControl逻辑、三处取消/销毁修复及core取消闸的契约。两份1.4 patch不能改名复用；必须在1.5.1真实dist重放并由patch-package生成。_startRun/_prepareRun/_runAgentPrompt、_idleAsync/tryAcquireIdleLease、宿主策略、retry/abort/dispose逐项核查。上游新SDK能力不自动视为本地协议等价。

基底固定两文件：`patches/@earendil-works+pi-coding-agent+1.5.1.patch`、`patches/@earendil-works+pi-agent-core+1.5.1.patch`，从87476fa原样提取并记录Git blob/hash。原thinking-orbs保留。若补丁所需SDK私有接口缺失、不能复现或需要改变协议/引入整套上游产品架构，停止切换并报告，不用空实现或禁用功能绕过。

### 10.3 执行与变更范围

1. 冻结与调整方案（已执行）：保存快照、工作区/index记录，不改HEAD；明确当前授权覆盖本节四个步骤可连续执行。
2. 隔离基底：副本中先移出1.4活动补丁，提取固定1.5.1补丁，修改三处manifest既有SDK版本为精确1.5.1，正常npm install生成锁文件；不ignore-scripts、不手改lock/patch。
3. 隔离重移植：只改副本node_modules中两SDK的dist并生成新补丁，接当前控制器到真实运行链，保留上游生命周期与未托管路径；测试设施仅按已证实1.5.1契约作最小适配，不删断言或跳过失败。产品TS若仅公开SDK签名兼容可小幅调整并逐项记录；若涉及架构、IPC协议或数据格式，停止升级切换。
4. 有条件切换：全部10.4检查通过且独立审查无确认缺陷后，先比较主工作区与快照的并发变化，再仅复制manifest/包管理器生成锁文件/两份已验证补丁及经审查的必要适配文件；移出1.4活动补丁到备份保留；正常npm ci并复验目标测试、strict及typecheck。此条件不满足则主工作区继续1.4，不破坏隔离证据。

### 10.4 判定门槛与验证

- 正常npm install/ci及postinstall全部补丁成功；锁file ci前后hash不变，core/coding-agent/pi-ai实际1.5.1；全部传递依赖差异有来源解释，无无关包升级。
- 54项消息控制/核心取消测试、两专用strict类型检查、工作区typecheck通过；如需新增测试则总数变化留记录。保留未托管正常循环、身份/幂等/recovery和取消语义。
- 隔离目录运行完整backend/desktop测试及lint，失败与先前基线逐项归因。确认新增回归须修复兼容原因或停止切换，不通过减测试/加skip/放宽重要断言达标。计数增加的lint告警要归因，不笼统标绿。
- 验证跨SDK取消/销毁修复仍存在；独立verifier复查实际源码、补丁范围和测试证据，不能只看执行者总结。
- 冷启动如适合使用无凭证后端探针验证init/create/control/close；不用需要真实prompt的smoke代替。真实UI、多平台/网络与S3双暂停/S4完整retry仍是未完成项，升级切换成功不等于最终功能验收。

### 10.5 结果、回退和后续

通过门槛则将目标正式定为1.5.1并在其上另行完成S3/S4，不再双轨实现1.4。无法通过则保留当前主工作区1.4及隔离结果，报告具体阻断和变更清单后停手。主工作区切换失败先记录，不reset/clean；按本轮清单和快照定点恢复须保护并发文件，不全目录覆盖。

最终报告区分：冻结成果、1.5.1实际通过项、主工作区是否切换、未验收场景。本轮终点是可复现1.5.1开发基底或有证据的阻断，均不自动进入S3/S4或发布。

### 10.6 执行结果（2026-11-13）

已先在独立副本迁入真实MessageControl、S1/S2修复和core取消闸，保留1.5.1的_idleAsync/_idleBody_*与tryAcquireIdleLease；新增4项真实租约互锁测试。原54项+4项=58全部通过，两次以上正常npm ci可复现。未引入v0.6.8产品代码/归档/存储/UI，产品TS零变更。

首轮全量发现A6②测试阈值40%接近1.5.1估算边界，尚未达到阈值而失败；不是已证实护栏失效。只将测试阈值改为30%，保留关闭SDK自动压缩、自研bound/降级/estimate断言，产品默认80%不改。另对已有S2测试做格式修正。桌面路径断言失败由隔离HOME正斜杠引起，使用Windows原生路径后全过，未改path-target代码。默认并发两项5秒超时，workers=2时全量通过；仅有并发敏感证据，不声称全部平台/负载均无flake。

独立审查初判HOLD；补齐全量通过证据后CONDITIONAL（报告陈旧/注释/并发记录需收口），已更正文档与报告。主工作区与快照比较仅预期路线文档差异后，按10项文件清单复制候选并移出旧活动补丁。

主工作区现为精确1.5.1，正常npm ci三补丁成功；锁SHA256 `19fd292787b317fde75821d191db9750b3b2c1b2a9a6dffdd8dbc3ec83af0ab1` 不变。重装后backend1029/1029、desktop1362/1362（均maxWorkers=2）、两专用strict、workspace typecheck、lint exit0；lint原有89警告不代表零告警。依赖树三核心包1.5.1无旧版本重复。

当前1.4活动补丁移至检查点validation-151/old-140-patches，完整当前成果仍在795文件ZIP中。日志与最终报告：检查点validation-151/FINAL-SWITCH-REPORT-151.json及main-*.log；早期FINAL-REPORT-151.json已标过时，不作为最终门槛结论。

**未验收**：1.5.1独立冷启动探针、Electron/真实模型、跨平台、S3宿主双暂停和S4完整重试。保持现有fork，下一步只在1.5.1上继续S3/S4，须单独放行；不再双轨维护1.4。

## 十一、S3 显式无损恢复方案（已批准实施，结果见11.8）

### 11.1 目标与边界

解决宿主暂停后已有用户实体占用同模式槽位，resend/recovery被queue_full阻断的问题；保留原messageId与完整payload，不要求discard，不扩大普通用户输入容量。不增加IPC字段、UI按钮、持久化格式或第二套队列；不进入S4重试。当前24项压缩测试中22通过/2条resend RED仍保持，本文不标其已修复。

### 11.2 现状与可复用事实

- `message-control.js` 的submit recovery已排除原实体，但capacity仍会看见另一条同模式用户项。changePending(resend)同样如此。活动输入在queued期间原本不占待发槽，随后host暂停使其变held，便可能与此前合法接受的待发项同时存在；不能据此倒推所有重叠都是enqueue绕过容量校验。
- changePending当前先解除autoDispatchPaused再publish/kick；kick优先steer，不保证选择用户指定目标。launch中只有prepared项走_startRunPrepared，未prepared项经_promptUncontrolled；后者有交互式_hostResumeBatch授权，前者没有。两条现有RED停在capacity，尚不能证明之后的具体分支失败，需补行为测试。
- 可复用identity/revision/previous/remember、generation、原始payload与prepared对象分离、message_start身份关联、beginStop、host结果对账及现有SDK请求准备/策略机制。
- 既有queued与held/recovering不能混淆：宿主交互式恢复可合批已queued传输项，不得把其他held/recovering项混入。原requestId指纹规则保持：完全相同请求幂等；同ID修改revision或payload仍为冲突，不改成messageId/payload去重。

### 11.3 决策：已有实体的零新增直接执行

选择窄域直接执行，而非全面移除capacity、增加槽位、先删其他消息或新增独立resume API。恢复的是已被系统持有的实体，不是受理额外排队输入；同模式实体总数不增加，其他实体的状态与载荷不被覆盖。

**准入必须同时满足：**

1. 用户显式 `changePending(action=resend)` 或 `submit(recovery=...)`，目标在当前runtime存在、未commit/consume，source仍为user；恢复提交不得利用source参数改变原实体来源。
2. 身份、原requestId幂等、revision、payload/模式/图片支持、手动压缩拒绝等现有检查先全部通过；有idleLease/disposed/停止operation则拒绝。
3. controller无active、tasks、处理中invocation且SDK isIdle；确认没有运行中压缩。处于本地调度暂停或宿主pause/awaitingUser，需要一次明确恢复。
4. 保留原模式：resend天然满足；recovery必须request.mode与原mode相同。跨模式移动及所有新实体照旧capacity检查；忙碌时不得以恢复名义突破容量。
5. 此时仅允许绕过“其他同模式项占槽”的检查，以同一ID进入一个立即执行的目标；不是把它再插进普通等待队列。准入期间不能释放同模式容量给新增user请求，直到目标commit/handled或失败收束。

此规则是旧容量实现的**明确、有限例外提案**，不声称原规范已逐字授权；实施批准同时确认该例外。正常一queue/一steer及held占槽限制不变。重复恢复无效，不允许批量隐式恢复其他held。

### 11.4 目标保留、宿主恢复与失败时序

1. 校验成功后、任何publish/可重入调用前，同步登记私有恢复意图（目标ID、epoch、原模式及本次requestId），设置唯一执行预留。changePending需先remember稳定结果/在途promise，再触发launch；避免监听器重入取得第二次执行权。
2. 显式指定目标直接launch，不通过kick选择另一个steer。全局autoDispatchPaused保持到该目标实际message_start commit（或现有明确handled规则）才允许恢复自动调度；不能靠“开始准备”或ack=started就放开。新请求/模式操作在目标预留期间返回现有busy或capacity错误，不改变其他实体。
3. 未prepared目标沿正常prompt准备；编辑后recovery清除旧prepared按新payload准备。prepared resend保留执行载荷，不重新展开模板/input handler；只补等价的宿主交互恢复授权。
4. 宿主授权通过AgentSession内部、受scope/epoch/目标身份检查的恢复意图接入现有resume准备路径，覆盖prepared及非prepared入口。不把_startRunPrepared全局改成自动resume，不直接在controller清空_hostPause/_hostAwaitingUser，不让普通kick/扩展通知获得授权；它们不能替代用户明确恢复。
5. SDK继续负责pause清理、policy重估、pending lease和消息批次提交；controller维持本地执行预留，防止宿主提前清pause后第二个任务进入。允许原本queued传输项按既有orderPendingMessages合批，不另承诺目标在batch内排第一；保证目标是启动恢复的唯一触发者，所有消息只commit一次。held/recovering不得存在于运输候选中。
6. 目标commit：按message_start身份清目标预留，正常处理queued；其他held/recovering保持。若目标handled、准备失败、再次host失败/nothing/contextChanged、取消或dispose：不得commit旧目标或自动发其他held，按既有失败路径保留原ID/载荷并收束为暂停；当前意图作废，等待新的显式操作。handled不等于全会话空闲，也不得自动发嵌套投递。
7. stop/interrupt/dispose必须撤销意图（epoch失效），迟到await/host result/settled不能恢复它。再次失败不自动循环。释放/回滚只影响此次目标与预留，不删除其他实体或静默变更模式。

内部实现可以复用既有scope/active，若需要额外私有字段仅保留目标级恢复意图；不得建立另一队列。宿主resume标志是已有SDK语义，本地预留才是避免提前放行的保障。若无法在当前SDK钩子满足上述时序，保留RED并停手，不自由扩展agent-core或IPC。

### 11.5 允许文件与实施范围（批准后）

| 路径 | 变更 |
| --- | --- |
| coding-agent `dist/core/message-control.js` | 同模式直接执行准入、目标预留、幂等与取消收束 |
| coding-agent `dist/core/agent-session.js/.d.ts` | 仅必要的私有显式恢复接线；保留host策略主体与idle lease语义 |
| `patches/@earendil-works+pi-coding-agent+1.5.1.patch` | 只由patch-package从dist重新生成，不手改 |
| `packages/backend/test/message-control-sdk-compaction.test.ts`及必要harness/测试tsconfig | 保留两RED，补恢复/容量/重入/失败断言 |

不改agent-core补丁、manifest/lock、产品src/DTO/UI、正式数据、已验收契约文档或其他规划。若确需改变已验收产品语义超过上述窄例外，先报告，不以升级兼容为由绕开。

### 11.6 测试与可判定出口

- 原两RED：user queue/steer占槽时分别resend初始held与prepared队列项，均无需discard完成选中实体投递；其他held不自动发送，queued按真实既有顺序一次消费；原实体ID保留、队列最终可收束。
- 同模式recovery完整文本/图片/draft返回与重发；跨模式recovery仍queue_full；新的普通user请求仍受容量限制，其他source不得冒充user恢复授权。
- 目标预留时同步publish重入、两不同requestId双击、相同requestId重试/改payload冲突、旧revision/stale runtime，不能第二次启动或二次改写载荷。
- 原先steer优先的kick不能抢目标启动权；prepared模板/input handler不重复，edited recovery重新准备一次；host policy off/on均验证。
- 恢复再次failed/nothing-to-compact/contextChanged/handled，及准备期间stop/dispose：载荷不丢、旧意图不复活、不自动发held/嵌套输入；成功后新的正常输入可运行，lease不被永久阻塞。
- 图片自动缩放目前仅局部false已验证，本阶段不得宣称默认缩放覆盖；如新增默认缩放用例单列结果。
- 执行顺序：保存基线与真实RED→最小实现→目标/全部SDK控制测试及两strict→生成补丁→正常npm ci→重跑上述与backend全量(maxWorkers2)、desktop受影响面、typecheck/lint；确认锁/core不变。独立复核不能只看汇报；有确认缺陷不标完成。

### 11.7 实施清单与授权

- [x] 只读取证并形成本文，无新增代码/测试执行。
- [ ] 用户明确批准本节窄例外与实现范围。
- [ ] 先补实际执行顺序/重入测试，再修两RED与准备分支。
- [ ] 正常重装与独立审查，记录Passed/Failed/Not run。
- [ ] 完成后停手；不自动进入S4或发布。

以上为设计时的约束和基线；本节实施已由用户明确批准，后续结果如下，不以历史两条RED描述覆盖当前状态。

### 11.8 实施结果与证据边界

已实现目标级显式恢复、普通容量不变、prepared一次性host授权和run结束清理。原两条queue_full RED已恢复通过；其他held/recovering保持不动。独立审查发现的跨模式空槽误拒绝、user来源改写、extension经UI编辑误拒绝均已补RED修正：跨模式走普通capacity，记录来源永远保留，user实体不得由非user恢复绕槽；用户编辑extension实体仅获得普通交互握手，不获得user同模式容量例外。

最终正常npm ci后SDK目标86/86、backend1057/1057（workers2）、desktop受影响84/84、两strict及工作区typecheck通过；lint0error、89warnings/18infos。独立verifier最终PASS，实跑compaction37/37及SDK strict，核对实际补丁/源码及日志hash。仅coding-agent补丁与compaction测试变化，core/manifest/lock/产品src不变。

未验收：S4、UI/真实模型/跨平台、默认图片缩放、still-over-threshold显式恢复独立用例；普通_preparePrompt非本次grant路径的hostResumeBatch潜在残留尚无复现，不宣称已修。完整自动化日志不替代这些出口。

证据：`C:/Users/Administrator/percho-backups/sdk-140-checkpoint-20261113-150221/s3-explicit-resume-20261113-182800/` 的red/green、review-fix、final-boundaries及final-scope。原失败、审查FAIL与整改顺序保留；当前阶段停手，下一步须单独批准S4或相关最小复现，不自动推进。

## 十二、S4 重试与恢复结果（已批准实施，限定通过）

先复现并修复了普通交互 prompt 的宿主恢复授权泄漏：认证/准备失败后，原 `_hostResumeBatch` 不再遗留给后续普通 prepared run。授权改为对象级、按 prompt 调用归属回收；显式 prepared recovery 领取自己的授权，不被普通 prompt finally 误清。另修复 hostAwaitingUser 下普通未提交 prepared 记录反复重投的微任务活锁，收束为 held 并暂停自动投递。

新增真实重试/恢复用例后，最终 SDK 目标 **96/96**，后端全量 **1067/1067**（maxWorkers=2），桌面受影响 **96/96**；两套专用 strict、workspace typecheck、lint 和正常 `npm ci` 均通过。独立 verifier 实跑 retry 目标 **14/14**，确认 S4 补丁只改 coding-agent 及 retry 测试，agent-core、manifest、lock、产品 src/DTO/UI 未改。

S4 未覆盖：prompt grant 与 prepared recovery 并发交错；grant 消费后 context-change/snapshot 失效且宿主策略不 pause；awaitingUser 跨模式 resend；Electron/真实模型/跨平台。上述是剩余风险，不将 96 项通过扩展为最终产品验收。

证据：`C:/Users/Administrator/percho-backups/sdk-140-checkpoint-20261113-195300/s4-validation-20261113-195300/`，保留中止断点、真实 RED、活锁超时、final 快照和 post-ci 日志。当前 S4 限定验证完成，下一步仅剩最终冷启动/真机/跨平台验收及发布决策，不自动发布。

## 十三、最终验收第1项：隔离 backend 冷启动

2026-11-13 已执行仓库外无凭证探针：SDK 1.5.1 backend `init`、`createSession`、`getMessageControl` ControlResult、`closeSession`、`dispose` 全部成功；快照为 idle、无待发项、未暂停。没有发送 prompt 或真实模型请求，session 文件位于隔离 `final-cold-home-2/agent-dev`。

首次探针失败是把 `getMessageControl()` 的 ControlResult 误当作 handle 的探针错误，修正后重跑通过；首次错误和最终结果均保留。跨平台、Electron/真实模型和正式用户目录仍未验收。证据位于 `C:/Users/Administrator/percho-backups/sdk-140-checkpoint-20261113-150221/final-cold-start-result.json`、`final-cold-start-2.log` 及探针脚本。

## 十九、最终验收矩阵与发布门槛（2026-11-14，当前决策真源）

### 19.1 结论、候选范围与证据口径

**当前可继续开发及受控内测，不放行正式发布。** 已通过的SDK与真实UI核心验证有效，但不是安装包及所有平台验收。用户本轮授权为整理矩阵、检查可用跨平台条件及发布前评估；不包含commit/push/tag、安装WSL/Docker、触发远端workflow或打包发布。发布目标尚未限定为Windows，不替用户缩小支持平台。

候选HEAD仍为`1b9214901ec639522afdcb6819994128cc53fbf2`，实际候选含大量未提交/未跟踪文件，HEAD不能单独识别本次变更。只读记录在`C:/Users/Administrator/percho-backups/release-readiness-20261114-113546/`：778个Git可见文件SHA256、status.txt、platform-probe.json。此为评估时刻清单，不是含全部忽略文件的回退备份；最终封版需重记候选文件清单，运行证据必须对应同一候选。

本节覆盖前文阶段性“下一步仅剩……”的过度概括。完成一条用例不推导整类通过；已有单元/集成测试、Electron开发态、真实provider、安装包和平台各自计证。候选后续有代码/补丁/lock变更，只使受影响证据失效，重跑相关集合，不无条件推倒全部验收。

### 19.2 已有证据矩阵

| 项目 | 当前证据 | 状态与限制 |
| --- | --- | --- |
| SDK1.5.1安装与两补丁 | 正常install/ci、postinstall、锁稳定、reverse-check，多轮迁移证据 | 阶段通过；最终候选仍须统一复验 |
| 控制核心、取消、双暂停、重试 | S1–S4及显式恢复真实SDK测试；S4目标96项 | 阶段通过；不等价所有事件交错/所有provider |
| 最后后端改动 | 目录恢复修复后backend1076/1076（workers2）、9项真实安全路径测试 | 通过；TOCTOU沿用边界，不承诺OS级原子路径锁 |
| renderer自动测试 | 最新恢复目标324项；较早desktop全量1362通过 | 目标通过；最终安全修复后的desktop全量尚未重跑 |
| 类型与lint | 当前改动后workspace typecheck；两测试专用strict有各阶段证据；lint0error | 89warnings/18infos属既有基线，不称零告警；最终一并复验 |
| backend冷启动 | 无凭证init/create/control/close/dispose | 通过；空会话sessionFile只是计划路径，不证明已落盘 |
| Electron真实基本交互 | CDP实际页面、Input点击、截图、隔离路径与退出 | 通过；不是生产file://或安装包验证 |
| 未落盘会话恢复 | 同backend的held/recovering刷新与再次取回全文；同session/runtime/messageId | 通过；不承诺跨进程/崩溃恢复 |
| 真实普通发送/queue/steer/interrupt | Systalyze GLM-5.3-Flash、真实工具与IPC/trace/session互证 | 限定单provider通过；源配置只读、临时凭证删除 |
| stop→held→recover→resend | 真实UI原实体恢复、回复一次、队列清空 | 通过当前场景；默认图片resize未验 |
| 真实手动压缩 | 2次compaction、3个真实摘要请求及非空持久摘要 | 通过测试keepRecentTokens=256，不推导默认水位/自动触发 |
| 手动压缩发送保护 | 延迟窗口内普通发送拒绝、草稿保留、无commit | 普通发送通过；steer/interrupt UI组合未验 |
| 失败轮retry | 本地一次503→错误卡retry→真实provider200；无新user/tool | 受控故障链通过，不是自然provider故障或自动retry覆盖 |
| 真实自动压缩及其三模式 | SDK集成用例有证据，真实provider验收禁用了auto | 真实UI/请求链未验，仍是关键门槛 |
| 默认图片缩放 | SDK恢复用例局部autoResize=false | 默认路径未验，不能称附件验收通过 |
| 生产打包/file://资源 | 只有开发态构建/运行 | 未验；无当前候选安装包/随包SDK证据 |
| Linux/macOS | workflow静态存在，当前候选无对应运行记录 | 未验，不能采信上游版本或旧HEAD的CI替代 |

证据入口：§十至十八及频道REVIEW/IMPL-NOTES；真实会话`real-provider-ui-20261114-105734/`，压缩/故障恢复`compact-retry-ui-20261114-111721/`，目录恢复`ui-reload-recovery-20261114/`。历史S4日志真实路径为`.../sdk-140-checkpoint-20261113-150221/s4-validation-20261113-195300/`，前文误写父目录195300不可作为定位依据。临时目录本机证据需在正式交付时选取脱敏报告归档，不能假定另一台机器具备这些路径。

### 19.3 发布必过项（有限集合）

| 门 | 最小补证内容与出口 | 当前状态 |
| --- | --- | --- |
| G1 候选统一复验 | 冻结文件清单；正常npm ci；两strict、typecheck、lint、backend及desktop全量。一次记录全部退出码/版本/并发/锁hash；新失败必须归因，不能拼接旧候选数字 | **PASS（限定：当前Windows冻结候选）**：G1最终统一复验已实际执行，见§19.12；783文件冻结、8命令exit0、backend1087/desktop1412、lint90w/18i；证据与限制见§19.12，不外推其他环境，非发布PASS |
| G2 自动压缩核心边界 | 用隔离测试参数使真实小会话可达自动threshold；分别queue/steer/interrupt，每项对照草稿、一次commit、事件顺序、最终idle/held。至少一次真实摘要完成、一次取消；不为触发堆巨量token | **功能限定通过，配置异常未闭环**：§19.8 ACK窄化已实施，真实UI健康preprompt下queue/steer/interrupt功能限定PASS（独立证据review）；但本轮auth.json全轮hash变化且写入者归因未证，配置隔离INCONCLUSIVE，非发布通过，详见19.9 |
| G3 手动压缩剩余保护 | 在可证manual compacting窗口分别点steer/interrupt发送，确认契约要求的拒绝与草稿保留，无隐式工具/模型请求 | PASS限定真实UI窗口，三模式均拒绝、草稿完整，真实摘要成功 |
| G4 默认附件路径 | 一张安全测试图片经默认autoResize发送，确认UI回显、SDK可消费及恢复载荷/身份不丢；若发布声明支持图片，该项不能以关闭resize用例替代 | PASS分层：真实UI上传/模型读图、默认SDK缩放与取消恢复单测，非同一条E2E覆盖全部恢复 |
| G5 已知grant交错风险 | 对S4保留的prompt/prepared grant交错、消费后context-change且policy不pause各一个有界真实SDK复现；可达则修复并回归，不可达须记录API条件/反例证据。禁止只因未写用例就判不存在 | PASS限定公共API条件：交错受busy串行化、失效清理可达用例通过；未证明任意内部并发 |
| G6 产物验包 | 先正常生产build，再仅对目标平台no-publish打包/解包，核1.5.1资源与补丁运行代码、preload CJS、file://renderer、资源/原生二进制及隔离启动。不得直接在正式用户目录运行测试包 | **功能限定PASS（Windows目录包）**：生产build+electron-builder --dir --publish never成功，随包SDK/补丁/preload/资源核实，隔离runtime 38/40（2项FAIL为打包内NODE_OPTIONS审计钩子未加载，非全绿）；node审计INCONCLUSIVE；NSIS/ZIP/安装卸载/签名/升级未测，详见§19.12 |
| G7 平台与CI | 对拟发布的平台运行同一候选的安装/检查/构建与包启动；至少Linux现有CI必须对应当前变更。多平台Release须逐平台记录，缺平台只能停或由用户明确缩小发布范围 | 未执行：无Linux/macOS证据，未触发远端CI；环境探测见19.4 |
| G8 发布闸和收口 | 确认发布job不会在所需build失败后放行；补测试专用strict到实际CI验证命令或独立同候选记录；更新SDK/架构/版本/发布文档并明确Git/版本/资产授权 | **本地条件完成**：ci/release两workflow必要修订已实施并通过独立静态审查（ci两strict、pack --publish never；release upload if-no-files-found:error、publish needs.build success门）；未远端运行，发布收口未完成，详见§19.12 |

G1受控并发建议maxWorkers=2，保留此前默认并发2项5秒超时记录。若将其定为CI策略，单独修改并验证，不把曾经重跑成功写成flake已修复。

### 19.4 本机跨平台检查结果与执行方案

2026-11-14只读实际探测：`wsl --list --verbose` exit1（返回安装帮助），`wsl --status` exit50，`wsl -e uname -s` exit1；Docker/gh不在PATH。只能判当前没有可执行的Linux验证路径，不能断言特定WSL故障根因，也不宣称Linux测试已运行。本轮未安装系统功能/容器、未联网触发远端任务。

现有`.github/workflows/ci.yml`在PR/push main执行Ubuntu Node22的ci/lint/typecheck/test/build/packaging smoke；另有Windows NSIS检查。没有workflow_dispatch，也没有两套专用tsconfig检查。现有release.yml三平台build后publish使用`if: always()`，可能在部分构建失败时尝试发布；这是静态风险，未实际触发，不用打tag来试。

推荐后续路径：用户明确授权Git收口/远端分支后，对当前候选开PR触发既有CI，并先批准仅CI验证与发布条件的必要修订；或者提供已有Linux runner，在独立源码副本运行。不要上传auth、测试凭证、生产会话；不复制Windows node_modules到Linux，也不在共享工作树上跨平台npm ci覆盖当前环境。gh缺失本身不等于远端不可用，但当前没有被授权发布候选ref，不偷用旧远端HEAD当本轮证据。

Linux验收命令模板（在独立候选工作区、已隔离HOME/agent且无正式凭证）：

```bash
node --version
npm --version
npm ci
npm exec -w @percho/backend -- tsc -p test/tsconfig.message-control-sdk.json
npm exec -w @percho/backend -- tsc -p test/tsconfig.core-abort.json
npm run typecheck
npm run lint
npm test -w @percho/backend -- --maxWorkers=2
npm test -w @percho/desktop -- --maxWorkers=2
npm run build
# 仅在另获验包授权后，desktop工作区执行：
# npx electron-builder --dir --publish never
```

这是待执行命令，不是本轮运行结果。Linux不等macOS；macOS原生模块/签名/包启动需该平台证据。

### 19.5 可接受限制候选（尚未由用户接受）

以下可以缩小测试范围，不把NOT_RUN改写为PASS；仅记录候选，发布前由用户决定是否接受：

- 单个获准provider完成核心真实请求，不穷举所有模型/所有自然网络错误；保留其他协议未验，受控503不冒充服务商事故。
- 未落盘pending只承诺同backend runtime重载，进程退出/崩溃恢复是原非目标，不新增承诺。
- 已有89warnings/18infos在没有新增严重诊断且逐阶段基线明确时可保留，不为了全零扩大改动。
- 自动压缩各mode测试固定有限场景，不穷举每个contextWindow和全输入组合；G2/G3/G4/G5本身不能以此豁免。
- 路径安全沿用检查时realpath，不声称抵御校验后恶意并发换链；现有真实symlink/junction测试不得删除。
- 不承诺所有provider取消后零网络；以本轮契约的停止结算、无旧消息重发和数据不丢为主。跨平台未验只能缩小对外发布平台，不能标多平台通过。

### 19.6 收口规则与下一步

当前结论：**Windows开发态核心链路有实证；正式发布NO-GO**。原因集中为G1–G8中的明确未完成项，不是要求无限测试。新增阻塞必须满足“可复现回归、既有承诺未覆盖、当前构建/发布实际失败”之一；泛化猜测记风险，不自动扩大实施。

建议下一批仅批准G2/G3/G4/G5的有限补验与确证最小修复，之后冻结候选跑G1；G6打包以及G7/G8远端CI/发布条件分别明确授权。上述建议不是本轮已批准实施，也不改为自动commit/push/tag。

本轮仅矩阵与环境探测，现有凭证已清理，本轮未重新调用provider。最终验收按矩阵更新单一状态，不再逐轮用“只剩最后一步”替代完整门槛。

### 19.7 G2–G5 有限补验结果（2026-11-14，历史结论；G2最新状态以§19.9为准）

用户批准本批有限补验及确证最小修复。总结果：G3/G4/G5限定通过，**G2仍失败**，不进入候选封版/发布。证据根`C:/Users/Administrator/percho-backups/g2-g5-validation-20261114-114451/`。

G5新增两真实SDK用例：公共API下prompt持有执行权时另一prepared恢复被busy序列化，释放后合法重试，未宣称内部任意并发已覆盖；另一contextChanged但policy不pause用例验证旧授权被清理。G4新增默认autoResize两用例，2400×1600 PNG实际SDK缩为2000×1333 JPEG，取消恢复原payload/ID不丢。4项新增、SDK目标100/100、两strict和backend类型/相关Biome通过；本部分没有修改SDK补丁。

真实G2首次三项FAIL，截图/快照证明自动压缩期间composer以泛compacting统一拒发。最小UI修复：新增单一compaction-gate判定；明确auto+控制API完整才允许发送，manual/unknown/legacy仍拒；发送时重读权威snapshot避免旧闭包误判；保持压缩占位提示与原样式。新增RED9条后composer140、关联762、desktop全量1389通过，桌面/shared类型检查通过。新增helper与测试入口在composer目录，未改SDK/依赖/CI。

修复后仍有第二阻塞：首条发送在pre-prompt auto compaction内等待ACK，`sending`/sendGuard同步锁禁止三模式；第一次产品改动未引入它，但未满足原三模式契约。post-run场景通过代理拒绝前置摘要401进入窗口：queue/steer实际提交，interrupt取消后新消息一次；该操作是故障干预，不代表正常pre-prompt链路。interrupt后的再压缩另被本地预算429拒，不能算完整成功压缩收束。因此real-ui-postfix中局部PASS只能作为窗口内mode证据，不能覆盖G2 FAIL。

G3真实manual窗口中queue/steer/interrupt三模式拒绝且草稿完整、无marker提交，摘要成功；UI自动放行修复后再复验仍通过。G4真实UI选择无敏感图片，通过默认附件管线进入Systalyze并正确回答蓝底/红色矩形；proxy记录输入JPEG2000×1333、JSONL单图片用户项与UI回显。真实图恢复未重复模型调用，恢复保障来自默认SDK取消回归，报告分层。

独立verifier只读审查给出G2 FAIL、G3/G4/G5限定PASS，未重跑真实网络。初轮真实转发15/18，修复后12/12（9最终case+3诊断），两轮独立计，不混作原预算；代理前置401/预算429均非provider天然故障。所有临时auth/models已删，原auth/models/settings哈希未变，key字面扫描无命中，5173/9224/18590关闭，无残留测试进程。

下一步需先定案ACK/在途事务边界：候选A后端接受后先回执、最终失败用receipt结算；候选B前端每payload独立事务允许压缩中并发操作。**两者都不能简单提前清草稿或删除sendGuard**，需要保留requestId幂等、revision、pendingTx重试身份与原失败恢复规则。当前只记录候选，不批准架构扩大或擅自改协议。保留partial UI修复、全部红绿/真实失败证据；用户决定后单独实施G2剩余问题。

### 19.8 G2 剩余阻塞实施方案：自动压缩受理 ACK 与失败反馈

> 创建/更新：2026-11-14。状态：**已批准并实施**（结果、证据与限制见§19.9）。关联版本：SDK 1.5.1，HEAD `1b92149` 与当前未提交工作区。任务真源：§19.7、用户提供的前次转录末段和本次接手授权。本节补完原会话正在讨论的边界，不将接手或静态审查写成代码实施/验收通过。

#### 一、目标与阶段边界

让首笔输入触发请求前自动压缩时，后端及时确认已接管输入，前端可继续按 queue/steer/interrupt 契约操作；受理后准备失败必须有可见反馈和完整载荷恢复入口。

保留 `sending/sendGuard`、`pendingTx`、草稿快照清理、requestId 幂等、revision/runtime 防迟到及每模式容量。无需新增 IPC/DTO、并发发送事务队列或持久化格式。不改 agent-core、依赖版本、宿主恢复授权、默认压缩参数、手动压缩保护；不混入打包、平台、CI、Git 提交或发布。

#### 二、现有实现定位

**2.1 可复用能力**

- SDK `dist/core/message-control.js`：submit 在执行前已 clone payload、登记 records/requests；`ack()` 只结算一次；active queued 项已从待发槽容量计算中排除。launch 的失败/hostHold 路径已有 held 和 failed receipt。
- SDK `agent-session.js`：`_runAutoCompaction` 设置 `_autoCompactionAbortController` 后同步发 `compaction_start`（threshold/overflow）；手动路径用独立 controller 和 reason。`_prepareRun` 在摘要后仍有扩展及图片处理 await。
- Composer：成功 ACK 后按原草稿快照清理，finally 释放锁；IPC 异常保留 pendingTx 身份。QueueBar 可展示 held 并按原 messageId 取回/重发。
- shared reducer：已有 runtime/revision 校验和按 controlMessageId 移除失败乐观气泡；现有 `kind: error` 卡可复用，文案沿用现有错误字典。

**2.2 必须修正的假设**

- 当前首笔 ACK 等待 preflight started，而自动压缩发生在其前，导致首笔仍占发送锁。
- failed receipt 当前只删除乐观气泡，注释假定发送 Promise 总能报错。提前 ACK 后这个假设不成立。
- Promise 拒绝响应与事件是两条通路，任一可先到；仅检查“已有错误卡才不显示内联”不能双向去重。

#### 三、架构决策

选定窄化的后端受理方案，不引入前端多事务管理。`queued` 仅表示后端持有输入，不表示模型已收到或执行成功；最终提交仍以 message_start/committed receipt 为准。

**ACK 判定**：仅在真实 `compaction_start` 且 reason 为 threshold/overflow、自动 controller 存在且未取消、手动 controller 不存在时考虑提前结算。捕获 AsyncLocalStorage scope，要求 owner 为本控制器、与 active 为同一对象、startRun 为 true、内部 phase 为 preparing；record 为 source=user、仍是 records 中同一对象、processing 且 state=queued、未 committed/consumed/acked；scope 与 record 的 generation/epoch 有效，scope signal 未取消，控制器未 disposed、无停止 operation。先 publish 压缩快照，再复核同一 scope/record/controller 和全部存活条件，最后 `ack(record, "queued")`。不改 phase，不 kick，不复制运输队列，不额外开运行权。

本边界只改变尚未 ACK 的用户准备路径。prepared 恢复、辅助重试、post-run 压缩及已 ACK 路径不重复结算；扩展消息维持现有语义。同步 publish 监听器 stop/dispose 时不得回成功 ACK；稍后其他 session listener 在 ACK 后 stop，则按“已经受理后被停止”结算 held，不能承诺整个事件广播原子化。

**错误反馈**：shared 层用同一纯投影处理 failed receipt 和 `preflight_failed` 响应快照。有效 runtime/revision 且快照含对应 source=user、state=held 实体时，移除准确乐观气泡并生成现有错误卡；不修改草稿、执行状态或 held 载荷。响应分支用原 requestId 和 `recovery.messageId ?? requestId` 定位，不生成新请求身份。

- 卡 ID 使用 `control-send-error:` 加 JSON 编码的 `[runtimeId, messageId, requestId]`，避免分隔符碰撞。两通路任意顺序、同 receipt 重复不得追加第二张卡；相同 ID 的后续具体失败更新原卡详情。changePending resend 当前复用原 record.requestId，因此不承诺每次重发独立卡。
- 将现有 `buildSendUiError` 移入 shared errors 并保留 Composer 原模块 re-export，维持现有内联行为；控制投递失败卡复用其标题/详情，但 actions 仅保留 copyDetail 及原分类已有的 openSettings，不提供 retryLastFailedTurn 或 compact。恢复仍走 QueueBar。
- 精确的 `Message preparation was cancelled` 与 `Host paused: awaiting-user` 不产故障卡，但仍同步快照/移除乐观气泡。不得按包含 cancelled/abort 的宽泛字符串隐藏真实 provider 故障。其他 `Host paused: ...` 可产兜底卡；已有同 ID 具体错误时不得被泛化 hostHold 覆盖，后续具体错误可覆盖兜底。
- `preflight_failed` 响应进入同一投影后，返回“已处理/旧状态忽略/无法关联”结果。前两种不再产生内联重复提示；无法关联则保留现有内联兜底。仅在运行时允许钉住或匹配 runtime 时处理，旧 revision 不覆盖新状态。IPC throw 仍保留草稿及 pendingTx，不伪造成后端最终失败。
- 不保存新的无界 receipt 表；用现有 transcript 中的稳定卡身份去重。错误卡为当前 renderer 内存反馈，同runtime重载的恢复保证来自后端 held 快照，不新增错误卡跨重启持久化承诺。

#### 四、核心业务时序

1. submit 校验并记住完整输入及幂等 Promise，按原逻辑 launch preparing；在进入自动压缩以前仍保持旧 ACK 规则。
2. 真实自动压缩 start → publish → 存活复核 → queued ACK。前端按原快照清草稿并释放锁，等待时新编辑的内容保留。
3. 后续 queue/steer 进入原容量与调度；interrupt 取消摘要并等待旧运行停稳，旧用户项 held，新项一次投递。
4. 摘要与后续准备成功：message_start 精确认领，committed 一次；不得因早 ACK 提前从 records 删除或伪造用户历史。
5. ACK 后准备失败：后台 settled/held 与 failed receipt，错误卡可见，原载荷可取回；当前新草稿不被异步错误覆盖。摘要失败若 SDK 按原策略继续，则以实际后续提交结果为准，不强制转成输入失败。
6. 同 requestId IPC 重试复用原结果，不再启动摘要/模型；stop/dispose、取消后迟到结果不能解冻 held 或启动旧请求。

#### 五、受影响文件与变更策略

| 模块 | 文件 | 策略 |
| --- | --- | --- |
| SDK ACK | `node_modules/@earendil-works/pi-coding-agent/dist/core/message-control.js` | 修改事件回调及必要私有 helper；从真实 dist 生成补丁，不手改 patch |
| 可复现补丁 | `patches/@earendil-works+pi-coding-agent+1.5.1.patch` | patch-package 重新生成，其他补丁/manifest/lock 保持不变 |
| 真实SDK用例 | `packages/backend/test/message-control-sdk-compaction.test.ts`、必要 harness | 新增前置摘要 gate、ACK/取消/后续准备失败；保持真实控制器 |
| 错误投影 | `packages/shared/src/transcript/control-errors.ts`（新增）、`reducer.ts`、`index.ts` | 共用有 runtime/revision 守卫的纯投影，导出给响应路径；不新增协议字段 |
| 错误构造 | `packages/shared/src/errors.ts`、Composer `send-error.ts` | 原 builder 移入 shared，原路径 re-export；卡动作单独收窄 |
| 前端响应 | `packages/desktop/src/renderer/src/stores/transcript.ts`、Composer `use-composer-send.ts` | 暴露窄的失败响应投影方法，统一 preflight_failed 反馈；保持锁与草稿机制 |
| 回归 | Composer `use-composer-send.test.ts`、stores `transcript.test.ts` / `transcript-errors.test.ts` | 覆盖双通路先后顺序、去重、草稿及旧状态拒收 |

实现若发现必须新增 DTO、扩大容量或改 core 执行顺序，本节不能作为该扩大授权；先报告具体阻断。复用现有 UI 卡片与字典，不新增视觉形态。

#### 六、测试设计与验证

**真实行为 RED**：摘要 gate 未释放时首笔 submit 应已 queued ACK（当前会超时）；此时前端应能提交下一条三模式输入。不能通过手改 compacting flag、删除锁或故障注入前置摘要来替代这一复现。

必须覆盖的有限集合：

- 前置自动摘要 gate 中 ACK 已返回、无首笔 user commit；正常释放后每条用户 marker 只提交一次。queue、steer 分别符合既有模型请求边界；interrupt 确实取消摘要，旧输入 held、新输入一次。
- ACK 前 publish 同步 stop/dispose 不回成功；ACK 后 stop、迟到摘要结果不得复活旧输入。重复 requestId 不增加摘要/模型次数；冲突 payload 仍拒绝。
- 自动摘要后扩展准备失败（真实 before_agent_start hook 抛错）可达：ACK 已返回、最终 failed+held、无用户 commit、recover 完整载荷和原 ID。不要伪造 transport 失败替代准备失败。
- 未进入自动压缩的准备路径、manual 三模式拒绝、post-run、辅助重试、prepared恢复、未托管路径维持已有断言。
- renderer：ACK 前草稿不清/同 tick 双击仍拦；queued ACK 后释放锁；等待中编辑不丢；IPC throw 同内容重试沿用 requestId。
- receipt/拒绝响应两种顺序、相同回执重复、后续具体错误更新、泛化 hostHold 不覆盖具体原因、旧 runtime/revision、主动取消、扩展来源不误报、精确乐观气泡删除；卡上无 retry/compact，当前新草稿不动。

最窄命令：`npm test -w @percho/backend -- test/message-control-sdk-compaction.test.ts --maxWorkers=2`；`npm test -w @percho/desktop -- src/renderer/src/components/composer/use-composer-send.test.ts src/renderer/src/components/composer/send-error.test.ts src/renderer/src/stores/transcript.test.ts src/renderer/src/stores/transcript-errors.test.ts --maxWorkers=2`。执行时隔离 HOME/agent，不读正式凭证。

绿后重生成补丁、正常 `npm ci`，再跑 SDK 控制组、两套 strict、workspace typecheck/lint、后端和桌面全量（maxWorkers=2），记录锁及其他补丁 hash。不将此局部候选结果自动替代最终 G1。

真实 G2 复验沿用获准 Systalyze/GLM-5.3-Flash 与隔离配置：分别通过实际 UI 输入/点击进入健康 pre-prompt threshold 窗口，只延迟摘要转发以观察，禁止前置401绕路。至少一次摘要成功及一次 interrupt 取消；新消息、草稿、receipt、JSONL互相核对。每轮代理总转发上限18，达到后停止，预算拒绝不能当通过；若环境导致不可达报告原因，不自动追加真实请求预算。完成后清理本轮进程、临时凭证并核对源配置 hash。

#### 七、实施步骤与验收清单

- [x] 核对当前 ACK/压缩/receipt 真实调用链，完成只读独立方案审查；未执行新增测试。
- [x] 保存本轮工作区文件清单与目标文件备份，记录已有改动；新增测试先取得真实 RED（SDK RED 5failed/2passed、renderer RED 18，详见§19.9）。
- [x] 实现窄化 queued ACK 和统一失败投影，定向测试及独立审查通过（verifier首次FAIL的stale迟到覆盖缺陷已删调用并加2项RED回归，最终独立代码PASS）。
- [x] patch-package 生成补丁，正常 ci 后回归、strict/typecheck/lint；核对修改范围（三patch成功，lock/manifest/agent-core不变，dist字节一致）。
- [x] 正常真实 pre-prompt UI 三模式复验，保持 G3 手动保护（功能限定通过；配置写入归因未闭环INCONCLUSIVE，不据此宣称G2整体发布通过）。
- [x] 更新§19.3/19.7和频道记录，报告通过项、未跑项与证据，停在 G2 阶段；G1、验包、平台和发布另按既有门槛推进。

> **（历史说明）** 上文"本会话当前只修改此方案文档、未改产品/SDK、未运行测试"是实施前接手状态快照；本节已由用户批准实施，结果、证据与限制以§19.9为当前真源，该状态声明不再有效。

### 19.9 §19.8 实施结果（2026-11-14，当前真源）

用户已批准并实施§19.8。证据根`C:/Users/Administrator/percho-backups/g2-ack-20261114-153752`。本轮无Git提交、无包/CI变更；源码git status/diff保持。

#### 实现与自动化结果

| 项 | 结果 | 限制 |
| --- | --- | --- |
| SDK窄化 queued ACK | preprompt auto start存活复核后ACK；`before_agent_start` 失败用例以真实bindExtensions onError上抛复现（生产默认吞hook错误，测试边界保留） | — |
| 统一失败投影 | shared `transcript/control-errors.ts` 统一receipt与`preflight_failed`响应；主动取消不产卡、同ID去重/更新、无retry/compact动作；锁草稿容量保留 | — |
| RED→GREEN | SDK RED 5failed/2passed→7pass；compaction 44；SDK组102 | renderer RED 18中含缺符号失败，不能全称行为RED；stale RED 3failed/70pass→最终194pass |
| 独立审查 | verifier首次FAIL：stale主动refresh迟到覆盖新runtime/revision；删除该新增调用并加2项RED回归，最终独立代码PASS | — |
| 补丁与复验 | patch-package生成后正常npm ci三patch成功；lock/manifest/agent-core patch不变，dist字节一致 | — |
| 全量与类型 | final-validation/results.json实际读取确认：backend1087/桌面1412；两strict、typecheck、lint exit0 | lint为90warnings/18infos（旧文档记89）；changed-biome.log本轮TS扫描10warnings均为既有non-null行，不称零告警，也不擅自认定那1条差异来源 |
| LSP | 5paths零诊断但5项inconclusive（push-only） | 类型检查以实际tsc为准，已过 |

#### 真实UI四案（功能限定PASS，经独立证据review）

- G2健康preprompt下queue/steer/interrupt通过，无401/429绕路；G3 manual三态拒发保草稿。
- 转发15/18（含首轮脚本缺陷3）；成功摘要7次、取消1次。
- ACK wrapper installed=false；225/224/131ms是草稿清空采样，不是直接ACK延迟。ACK结论由源码+UI锁/草稿+events/trace/JSONL间接证明。
- 取消仅客户端取消，不保证服务端停计算。

> ⚠️ **【配置隔离INCONCLUSIVE——必须单列】** auth.json全轮hash变化（08:38:50.830Z），写入者归因未证；models/settings hash未变；后3case采样hash相同仅证明采样一致。"全轮配置未变"断言**FAIL**；不归因outside harness/OAuth或其他会话，不以改后baseline消掉异常。

#### 清理与边界

隔离profiles已删除、端口清空、已知父PID结束，不能保证所有后代；gitignored的out/main/preload确被dev构建。不宣称所有§19.8验收无条件通过。

#### 下一步

本段为§19.8实施结束时断点；后续配置隔离调查见§19.10。发布门槛仍按§19.3有限集合执行。

### 19.10 认证配置异常调查与受监测隔离验证（2026-11-14）

用户批准按建议核查配置写入及隔离。本轮没有修改产品代码、SDK补丁、依赖或正式凭证，没有调用真实模型、打包或Git写操作。

**历史归因仍无法确认**：08:38:50.830Z那次auth.json变化未记录写入PID，现有日志不能识别写入者。源码中的OAuth刷新可写认证文件，但机制存在不证明当时由它触发。当前源码未发现绕过显式PI_CODING_AGENT_DIR写auth的路径；AuthStorage在构造时固定路径，ModelRuntime默认通过getAgentDir构造存储，开发入口尊重显式环境变量。以上均不改写§19.9的全轮配置未变断言FAIL。

**当前隔离取得限定证据**：仓库外探针以合成凭证、显式隔离HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/agent和PI_OFFLINE运行。Node fs审计在产品import前安装，记录PID/操作/路径并阻断正式配置访问，真实AuthStorage modify/read/delete及ModelRuntime路径均在隔离目录。Electron真实main/backend读隔离auth/models；890条原审计记录含8次canary拦截，正式三配置访问尝试0。父进程只读原始字节算哈希，原轮采样前后hash/size/mtime相等。已知main及3个后代退出，既有6个Percho进程保持存活，隔离目录删除。

独立审查初判FAIL，针对探针两处断言：renderer文件存在不等于加载成功；合成凭证保留用了恒真条件。已将renderer加载成功改为**未验证**；改成删除后完整对象深比较后，仅重跑SDK探针17/17通过，正式配置hash/mtime仍相等。保留原记录与修订说明，不把复跑当原轮证据。

此为Node层路径审计，非OS沙箱，不覆盖native/Chromium IO、任意后代或预先打开的fd；网络只有PI_OFFLINE、进程参数和结束时采样，不宣称全程无网络。当前结果不等于历史真实provider验收隔离已获追溯证明，也不替代生产验包。

证据：`C:/Users/Administrator/percho-backups/auth-isolation-audit-20261114T103332Z/`，`REPORT.json`、`SDK-RECHECK.json`、`evidence.json`、`scripts/`和`logs/`。没有确证产品缺陷，故不改产品；不为历史不可归因重复消耗真实模型请求。

**推进条件**：可将当前显式隔离环境、先装审计hook、canary自检、实际访问路径和进程树清理作为后续受控验证入口，进入G1候选冻结准备。历史异常保留为未归因记录，不改成PASS。G6验包和平台/CI/Git/发布仍按既有授权边界执行；本轮未运行这些阶段。

### 19.11 G1 候选冻结准备（2026-11-14）

用户批准按§19.10建议执行候选冻结准备。候选目录为 `C:/Users/Administrator/percho-backups/sdk151-candidate-20261114-192407/`，HEAD仍为`1b9214901ec639522afdcb6819994128cc53fbf2`，Node22.23.2/npm10.9.8，实际pi-ai/pi-agent-core/pi-coding-agent均1.5.1；不创建commit/tag或修改版本。

对照§19.8最终`final-files.json`的783项文件，准备开始时仅本升级计划文档变化，无新增/删除，代码、测试、锁、补丁和构建配置哈希一致；已安装message-control.js与正常ci后的预期文件逐字节一致。因此可引用该轮统一验证：backend1087、desktop1412，两strict/typecheck/lint exit0；lint90warnings/18infos。本轮不重新执行npm ci/全量测试，不把既有日志写为新执行。文件相等支持证据复用，不保证任意环境或未来产物相等。

候选工件包含Git可见现存文件的逐项SHA-256、删除文件列表、Git状态、源码ZIP、独立解压逐项比对、既有验证日志的带hash副本和证据索引。排除node_modules、out、正式配置/凭证/会话和Git元数据；它是源码恢复快照，不是安装包或完整系统备份。快照保留工作区中其他规划与未提交临时脚本，其存在不等于获准提交或纳入SDK发布范围。未来提交必须另做差异归属审查；恢复时先检查目标目录，不覆盖后续工作。

具体结果：783个文件、源码ZIP SHA-256 `515c7242d62bbdf5e31eb0e953c401f7ed285fa460ecbd5cc16a133eddec4321`、排除Markdown后的747项输入集合SHA-256 `05017479ffcb9c32e2db7d82183c371bf3760f5a4d0227deda279a9f69c6fc32`；ZIP完整性和解压逐项SHA-256均通过。相对§19.8验证后清单仅本计划文档变化，无代码/测试/依赖/patch/构建配置变化。详细清单、报告和证据副本见候选目录 `C:/Users/Administrator/percho-backups/sdk151-candidate-20261114-192407/`。

纯说明文档变化不要求重跑代码测试；源代码/测试/依赖/patch/构建配置改变后，旧候选冻结标识失效，应更新清单并补相应验证。

当前仅完成G1准备及既有检查证据绑定，不改写“冻结后重新统一执行”的G1门槛为已执行。§19.9历史auth变化仍未归因，§19.10当前Node隔离有受限证据，不追溯洗白。下一阶段为在明确授权下做G6 Windows no-publish生产构建/验包，验证实际随包SDK、preload、file://资源与隔离启动；G7平台/CI和G8发布闸继续未完成。未运行生产build、打包、远端CI、真实模型或Git写操作。

### 19.12 G6→G1→本地CI闸执行结果（2026-11-14，当前真源）

用户按序授权 G6 → G1最终复验 → 本地CI闸。本轮**未改产品代码**，无Git提交/推送/打tag；最终仅2个workflow YAML与记录文档变化。授权过程中的脚本中止确认、授权弹窗与主会话脚本修正已留当时记录，本节不逐轮复述。

#### G6 生产打包与验包（Windows目录包，功能限定）

证据根 `C:/Users/Administrator/percho-backups/g6-sdk151-20261114-201404/`（REPORT.json）。

- `npm run build`（electron-vite 43.21s）与 `electron-builder --win --x64 --dir --publish never` 均exit 0（electron-builder 26.15.3 / Electron 43.3.0）；版本保持0.7.5未升。
- app.asar SHA-256 `97be41e7af502f98fc909944d3e212b86711fdd02c183831cbf8aab85c6dd9d1`；SDK 8包均1.5.1；补丁运行文件9项、preload CJS、esbuild、pi-package资源与extraResources通过；无凭证/userData泄漏。
- 目录包缺 `resources/app-update.yml` 已从builder源码确认为pack-only目标预期，**不判SDK缺陷**；NSIS/ZIP安装器、安装/卸载、签名/公证、升级链路均未测。

实际EXE运行证据：`C:/Users/Administrator/percho-backups/g6-iso-runtime-20261114-202733/`（runtime-evidence.json、run-main-6.log）。原脚本总判 38/40 通过（verdict FAIL），**两个FAIL均为打包app内NODE_OPTIONS环境变量不可用导致audit hook未加载，不能称全绿**。

独立复核功能限定PASS，仅限列明项：真实 `file://…/app.asar` 加载、窗口非空、preload IPC、设置页与版本0.7.5；合成provider（loopback拒绝）多行文本一次commit并出现网络错误卡（run级transport failure，非held）；renderer reload同runtime、按data-session-id重开、真实UI撤回取回全文逐字节相等。**不是held恢复，无真实provider**。node审计INCONCLUSIVE：隔离env/显式userdata与正式三配置前后hash相同，不证明未访问。已知PID树与9225端口清理完成，正式Percho进程未受影响。

#### G1 最终统一复验（PASS，限定当前Windows冻结）

证据根 `C:/Users/Administrator/percho-backups/g1-final-corrected-20261114-222951/`（REPORT.json；前置FAIL轮 `g1-final-20261114-220737` 保留）。

- 冻结783文件与旧候选清单完全一致（changed/added/removed均空）；全部输入、lock、patch前后hash相同；源码ZIP CRC与逐项hash通过。
- 8条命令全部exit 0：npm ci（三patch正常）、目标permission用例34、两strict、typecheck、lint（90warnings/18infos，既有基线）、backend1087、desktop1412（均workers=2）。
- SDK 20个patch目标文件与G6 runtime实际11项hash逐一匹配；隔离env/temp已删除。

**首轮FAIL保留归因**：`g1-final-20261114-220737` 中 permission-extension.test.ts:199 失败，因隔离布局 TEMP 与 HOME 为兄弟目录，`../../../escape` 的父目录恰为 HOME 祖先；`pattern.ts:155` 按设计对过宽父目录返回更严格的精确文件权限标题，旧测试只考虑根目录场景。**拒绝改断言通过**：仅把仓库外隔离布局改为TEMP非HOME兄弟后完整重跑；产品测试与权限逻辑未改，该断言对HOME/TEMP相对布局的敏感性仍存在，留作已知限制。

#### G8 本地CI闸（条件完成，发布收口未完成）

必要修订已实施并通过独立静态review（仅2个YAML）：`ci.yml` 补两strict、pack加 `--publish never`；`release.yml` upload加 `if-no-files-found: error`、publish job加 `if: needs.build.result == 'success'`，消除部分build失败仍尝试发布的静态风险。**未远端运行、无G7 Linux/mac证据、无commit/push**；最终product代码零变更。

#### 边界与下一步

| 项 | 状态 |
| --- | --- |
| SDK升级/补丁/产品代码 | 本轮零变更；最终代码无改 |
| G7 平台与远端CI | 未执行；无Linux/macOS证据 |
| NSIS/ZIP安装器、安装/卸载、签名、升级 | 未测 |
| Windows-only vs 多平台 | 待用户决策 |
| 发布 | 另需明确授权；**不称SDK完整发版通过** |

建议下一步：先决策发布平台范围（Windows-only或逐平台），再按序本地验证NSIS/ZIP安装器与G7平台/远端CI；实际发布收口单独授权。以上不改变"当前不放行正式发布"的既有结论。

### 19.13 2026-11-15 上游重评与GC宿主租约新风险（历史；GC风险已由§19.14定向验证并关闭，本节保留当时记录不改）

用户授权：仅文档同步，更新SDK1.5.1名称/状态、手册与Plan提交建议，不commit/push/tag/PR、不触发远端运行、不改CI/script/product。以下事实均由主会话git本地核或只读确认。

#### 19.13.1 上游固定ref重评表

| 版本 | ref | SDK | 备注 |
| --- | --- | --- | --- |
| 本地v0.6.6 | `0825d43034ae82f30e07046fdcf46401386d675c` | 1.0.4 | fork同名tag，不能冒上游 |
| 上游v0.6.6 | `b56f2121782f78211e5e02b7fa1c8999feaddbf6` | 1.4.0 | 初scout经GitHub refs确认，主本地对象存在 |
| 上游v0.6.7 | `8a4f43b5429471ec045dfc2cf6314ec458c50a` | 1.4.0 | 0.6.6..0.6.7共12 commits（4ac1dff分页/8a4f43b渲染、d506a98子代理契约、1781acc粘贴、a688fd1 provider、915353a工具默认） |
| 上游v0.6.8 | `87476fa1f884d3590e58400b4099212593a5a047` | 1.5.1 | 0.6.7..0.6.8共14 commits（87476fa SDK+perf、b4bd233 GC重开事件UI恢复、50ebd70归档catalog、ac5f545 minimap、526da85/78c02ed折叠/tokenspeed、aa538c8文件管理器） |

#### 19.13.2 新三平台CI矩阵（官方确认标签）

Windows x64、Ubuntu x64、macos-15-intel x64、macos-15 arm64。**无远端运行/commit/push/PR/tag。**

#### 19.13.3 本地脚本验证与跨平台边界

新script独立复核PASS，Windows 18/18与invalidexe预期FAIL清理通过；Linux/mac esbuild bin/esbuild修复、child env whitelist。

#### 19.13.4 GC宿主租约接入遗漏（新风险，静态竞态，待定向复现）

> ⚠️ **【重要警示】** 本节为静态竞态风险，不宣称实际bug/PASS。

oracle只读确认上游87476fa：`pi-backend.closeSession(gc)` acquire `tryAcquireIdleLease` 包整个async dispose/finally release。本方pi-backend 986-1110只有streaming/control/pending/subscription预检，sessionDisposals合并与identity复查不等价：await emitSessionShutdown时新submit可进入随后dispose。

- SDK lease测试非宿主集成。
- 建议离线shutdown gate + 新输入及pending warming最小验证，无需真实provider。
- 本方无read-only-view.ts/source-snapshot.ts及类，不能把上游这两模块变化列P1直接遗漏。
- **新风险阻止“只剩编译”说法；G1过去PASS不撤销，但后续修复需重冻结复验。**

> ✅ **【2026-11-15收口】** 上方静态竞态经用户批准定向验证，确证成立并已最小修复，结果与证据见§19.14；本节历史文字不改。

#### 19.13.5 提交建议

- 其他计划文档（catalog/roadmap）可作独立docs commit记录路线，**明确未实施/不构成实施授权**，不混进SDK commit。
- 本轮仅授权文档同步，不commit。

### 19.14 GC宿主租约定向验证与最小修复（2026-11-15，当前真源）

用户批准GC定向验证并修复确证问题。本轮**无build/npm ci/真实模型/Git写操作**；SDK/patch/依赖未改。证据根 `C:/Users/Administrator/percho-backups/gc-lease-20261115-111535/`（REPORT.md + verification/REPORT.md，最终独立verdict PASS，限定范围）。

#### 一、复现与修复

| 项 | 结果 |
| --- | --- |
| RED | 最终测试文件**复原旧实现后**实跑：8 failed / 7 passed（15），不是全部先红。旧GC在 `emitSessionShutdown` await 窗口内新 `submitMessage` 返回 `ok:true`、控制器登记user输入（items=1）、关闭后user已写进会话——行为断言红，非接口缺失 |
| 修复 | `closeSession` 仅 `intent="gc"` 在**任何 await 之前同步** `entry.session.tryAcquireIdleLease()`：无租约 `{closed:false}`；有则 `try { await disposeSession } finally { lease.release() }`。既有 streaming/control/订阅预检保持在租约之前；`user`/`delete` 路径不取租约、行为未变 |
| 独立验证 | verifier最终PASS；最窄目标6文件65/65、backend1102/1102、desktop1412/1412（均 workers=2）；3套strict（新增 `test/tsconfig.session-gc-lease.json`，已接CI）、workspace typecheck、lint exit0（90warnings/18infos既有基线） |
| 测试侧 | 新增 `session-gc-lease.test.ts` 15用例；`session-close-guard`/`channel-subscriptions` 两个旧gc mock补 `tryAcquireIdleLease` stub（生产路径非可选，不许 `?.` 绕过） |
| 后续微调 | 独立检查后主会话补 held mock `dispose: no-op` 消清理告警（仅测试fixture）；此后 fixture-cleanup 15/15 与 gc strict 复过，**未再跑全量**，产品逻辑无再变 |

#### 二、预热覆盖与边界

- 预热pending用**公开真实 CacheWarmer**：`SettingsManager.inMemory({cacheWarming:"idle"})` + 模型 `promptCache.short=12`，观察公开 `cacheWarmingStatus`（scheduled→refreshing）；gate期间GC拒绝（两次 `closed:false`），`setCacheWarmingMode("off")` 后租约可取、GC `closed:true`。模型流为内存stub，**无真实provider**。
- 30分钟空闲安全上限的持续重排仅源码静态确认，非长时实测；真实provider预热成本、streaming预热未验。
- 真实集成用真实 PiBackend + 真实 `AgentSession`/`MessageControl`，真实扩展 `session_shutdown` 门闩把GC停在await上；修复后同窗新提交→busy、关闭后 `not_found`。
- verifier实跑含全量：backend1102/1102、desktop1412/1412；其后 held mock 微调（仅测试fixture）后只复跑 fixture-cleanup 15/15 与 gc strict，未再跑全量，产品逻辑无再变。本轮未commit/push/tag。

#### 三、下一步

- 可恢复SDK候选准备：旧G1/G6候选与包**不包含本GC修复**，不能冒最新候选；后续需以当前代码重冻结候选，并经 GitHub fresh ci/test/build/package 形成最新证据。
- G7平台/远端CI与发布收口仍未执行；本轮全部为文档同步，不构成实施或发布授权。

## 十八、2026-11-14 真实摘要与受控失败重试（前次结果）

用户批准补验，同一获准Systalyze/GLM-5.3-Flash，新的隔离目录只复制上一轮真实会话（28条原始JSONL是完整前缀），测试keepRecentTokens=256，不修改历史消息/产品/SDK。自动压缩和自动重试关闭，不将本轮结果外推到它们。

真实UI手动/compact两次成功，SDK压缩结束未abort、JSONL记录2条非空摘要；实际摘要请求3次（第2次分两请求）。为捕获UI窗口，本地转发器对两次首摘要请求各延迟10秒，仅监听localhost，之后正常转发到获准固定端点。第二次压缩期间点击普通发送，前后快照均manual compacting、UI提示完成后发送、草稿全文保留且未提交，保护路径通过。第1次尝试已晚于压缩结束，记为额外普通请求，不能算保护测试。

本地转发器对一条新请求注入一次503，不伪称provider自发失败。真实错误卡展开后点击重试一次，下一请求透传Systalyze并返回RETRY_REAL_OK。失败及重试请求userCount均8，原用户marker只持久一次，工具结果无新增。总真实转发5次均200，另1次本机503。

独立verifier限定PASS，交叉原会话、compaction条目、actions、proxy日志及IPC时间窗。proxy摘要分类字段因system角色假设失效，原false保留但不用于验收归因。证据`C:/Users/Administrator/percho-backups/compact-retry-ui-20261114-111721/REPORT.json`及6截图/session/actions/proxy-events。

所有验收进程及5173/9224/18591已关闭，临时auth/models删除、原配置hash不变、日志key扫描通过；778个Git可见源文件验收前后未变，无commit/push/正式包替换。

**尚未验收**：真实自动压缩及其三模式、手动压缩steer/interrupt UI、provider自然故障及其他API、默认图片缩放和跨平台。当前仅新增手动真实摘要/普通发送保护/受控失败恢复的通过证据，不标完整升级或发布通过。

## 十七、2026-11-14 真实provider UI验收（前次结果）

用户明确授权截图provider，使用Systalyze / zai-org/GLM-5.3-Flash，实际配置来源~/.pi/agent只读；独立HOME/AppData/agent，仅单provider模型，无历史会话或扩展拷贝。原配置哈希未变，验收结束临时auth/models删除，日志密钥扫描通过，进程及5173/9224已关闭。

真实Electron Input操作和backend IPC/完整trace/SessionManager JSONL相互验证：短请求成功；运行中queue等待任务结束；steer在工具结束后进入同run下一轮；interrupt旧run aborted settled后才新run；stop后held→recovering→重发同controlMessageId且仅一次提交。9用户消息、4工具结果（2成功2取消），4marker与指定回复各一次；最终idle空队列。独立verifier对上述证据限定PASS，不宣称未运行场景通过。

尝试/compact返回`Nothing to compact (session too small)`，只证明入口与错误反馈，未调用成功摘要模型；测试settings禁用自动压缩/自动重试，因此真实压缩期间三模式、失败轮retry、默认图片缩放、跨平台仍未验收。本次不为测试增加大量上下文或破坏凭证。当前仍非完整发布验收。

证据：`C:/Users/Administrator/percho-backups/real-provider-ui-20261114-105734/REPORT.json`、actions.jsonl、4张截图、真实会话/trace和cleanup.log。文档记录前778个Git可见文件哈希未变，无产品/补丁/依赖改动、无commit/push/正式包替换。

## 十六、2026-11-14 首发失败会话重载修复（前次结果）

用户批准后，最小修改后端目录与open接线：listAllSessions合并当前registry元数据并按ID/file去重，live替换保持磁盘顺序；当前实例精确规范化文件匹配可重接。存在文件仍走原realpath校验；缺失路径仅真正未flush的普通可写会话且父目录realpath位于sessions根内放行。没有向会话文件写假消息，没有改变跨进程恢复承诺。

首次独立审查发现symlink路径短路与顺序问题，先4RED后修复；真实文件symlink/目录junction/落盘后删除/顺序校验9项全过、无skip。最终backend1076/1076（workers2），安全/生命周期目标163，renderer恢复目标324，工作区typecheck/lint过（89warning/18info）；独立verifier限定PASS，最终安全整改后未重跑desktop全量。

**真实Electron复验通过**：新隔离HOME/agent，在无模型首发失败形成held后刷新仍显示原会话；取回形成recovering后再次刷新仍有原条目；再次点击取回能找回原多行文本。四次快照sessionId/runtimeId/messageId相同，截图与动作记录支持结论；不是store注入或API造状态。退出后9224/5173释放。

测试证据`C:/Users/Administrator/percho-backups/ui-reload-recovery-20261114/`（安全整改review-fix、实际UI的ui-retest/REPORT.json与4图）。当前持久化判定依赖SDK isPersisted/flushed/_hasConversation，后续版本升级须重新核验；路径校验后并发换链不属于本修复的原子保护保证。

真实provider成功请求、在途queue/steer/interrupt、真实压缩/retry、默认图片缩放与跨平台仍待验收。需要用户指定测试provider和隔离凭证使用方式；不自动读取正式auth、不打包发布。

## 十五、2026-11-14 真实UI验收（历史发现，已由§十六修复）

用户明确批准最终UI验收。本轮未改产品代码；777个Git可见文件在记录文档前逐项SHA256不变。证据目录 `C:/Users/Administrator/percho-backups/ui-acceptance-20261114-094823/`：REPORT.json、actions.jsonl、11张真实CDP截图及stdout/stderr。

**已接管真实Electron页面**：在packages/desktop目录调用electron-vite的`--remoteDebuggingPort 9224`，准确连接该端点的Percho page，而非默认浏览器about:blank。HOME/USERPROFILE/APPDATA/LOCALAPPDATA/PI_CODING_AGENT_DIR均设置为本轮新目录；启动日志确认userData也位于该目录，不沿用用户原开发配置。未复制凭证。browser-act无已配置浏览器，采用项目现有CDP方案的仓库外有界客户端。

真实Input事件与截图确认：首屏、设置模型/通用/关于页、中英文切换后恢复中文、多行草稿、发送方式菜单、项目选择及不信任选择可用。未选项目点击发送保留草稿；选择隔离日常项目后无模型发送失败进入held；点击取回得到原全文，重发后仍是同一runtime/messageId的一个held项，无重复实体。菜单展示不等于运行中queue/steer/interrupt已验。

**最终UI验收未通过**：首发无模型失败、无成功消息落盘的新会话，在Page.reload后列表显示暂无会话、activeSessionId为空，但只读IPC确认原runtime/messageId/held全文仍在backend。用户无法从当前列表进入该内存会话恢复草稿。独立只读审查与隔离目录证据支持“磁盘目录不包含未落盘会话，workspace恢复过滤了成员”的根因候选；缺少重载前catalog快照，尚不能认定SDK升级回归或定位到唯一修复点。不得称为后端消息已删除，也不得标重载恢复通过。刷新前第二次取回点击未生效，状态仍held，不是recovering刷新验收。

**未执行**：真实provider成功请求、运行中queue/steer/interrupt、真实压缩/retry、图片、跨平台。模型选择器实际显示“未发现可用provider”，设置页provider均未配置，不自动读取或复制正式凭证。

本轮实例按记录PID关闭，后续进程/端口复查9224与5173均释放。下一步先获得修复范围授权并复现首发失败会话重载问题；真实模型验收另需指定可使用的provider与隔离凭证。未commit/push/打包发布。

## 十四、最终验收第2项：Electron renderer 环境阻塞（历史）

2026-11-13 三次隔离启动确认Electron main/gpu/utility/renderer进程及main/preload/renderer构建成功，使用开发userData `@percho/desktop-dev`。本地Electron运行时缺失时运行官方install脚本恢复，未改package/lock/源码。

三次旧配置renderer均加载失败：Vite实际监听`::1:5173`，Electron请求`http://localhost:5173`得到`ERR_CONNECTION_REFUSED`。根因是开发服务器地址族不一致。已将`packages/desktop/electron.vite.config.ts` renderer server固定为`host: "127.0.0.1"`；桌面typecheck通过，修复后Vite日志明确为`http://127.0.0.1:5173/`，TCP连接成功，Electron renderer进程保持运行，backend初始化及隔离userData日志正常。修复后未通过当前CDP页面列表接管Electron窗口，未点击UI或发送真实模型；已停止开发进程。旧失败证据在`final-electron/`、`final-electron-2/`、`final-electron-3/`，修复后在`final-electron-fixed-cdp-2/`。
