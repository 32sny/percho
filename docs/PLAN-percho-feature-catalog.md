---
类型: 决策清单
状态: P1随v0.7.6发布；上游同步路线已重评，P2–P8未实施；WIN-LINK-01已登记待实现
创建: 2026-11-03
更新: 2026-11-15
适用: Percho fork（32sny/percho）后续功能与交互取舍
---

# Percho 能加什么、哪些对你有用：一份去掉噪音的取舍清单

> 本文记录后续功能取舍、依赖顺序和实施边界。
>
> **当前状态（2026-11-15）**：P1（SDK 1.5.1）已随v0.7.6发布，tag指向`4794b98`，四架构CI与三平台Release通过。固定上游0.6.6–0.6.8的路线级重评见§十一；P2–P8未实施，各项仍须在开工前完成本方冲突/依赖/测试清单，不把提交级盘点说成逐项实施方案完成。Windows文件链接缺陷`WIN-LINK-01`见文件树计划“已登记缺陷”，可独立于完整P4修复。
>
> **以下事实基线为发布前历史评估**，其中HEAD、验收中、远端未执行等状态由本段覆盖；具体差异判断仍须实施时重核。
> 事实基线（2026-11-15修订）：本仓库 HEAD `1b92149`（v0.7.5 线），dev 依赖已按 P1 切换至 SDK 1.5.1（固定上游 v0.6.8=`87476fa1f884d3590e58400b4099212593a5a047`，验收中，见 [升级计划§19.13](PLAN-sdk-1.5.1-upgrade.md)）。旧“领先 36 / 落后 34”属旧快照 `1145c7a` 的历史记录，不是当前状态。**P1为唯一已执行阶段，P2–P8未执行；P8（数据目录迁移等高风险项）≠发布阶段 G8，两套编号不同不可混用。**
> **本文是全局阶段顺序的唯一真源。** `docs/PLAN-percho-follow-up-roadmap.md` 只保留功能契约、依赖、文件范围与测试细节，不再维护第二套批次号。各阶段详细方案只维护自身实施细节：`PLAN-sdk-1.5.1-upgrade.md`、`PLAN-session-split-panes.md`、`PLAN-project-file-tree-readonly.md`、`PLAN-global-search.md`、`PLAN-turn-checkpoint-undo.md`。

## 一、结论先行

你现在的"乱"，是因为把三类完全不同的事混成了一条队列：

1. **上游已经做完、你只要同步就能拿到的**（长会话渲染、系统通知、自定义 Provider 拉模型……）；
2. **上游没有、别人也没有、只有你这个 fork 才该做的**（分屏、按轮撤销、项目文件树、Git 工作流增强）；
3. **看着很酷但对你当前使用方式几乎无用、还要背长期维护债的**（终端、operator、定时任务、SSH、Inbox）。

**建议：把 80% 的精力放在第 1 类和第 2 类的前三项，第 3 类整体搁置。**

而且第 1 类有个残酷事实：**当前唯一已执行的是 P1（SDK 1.5.1，验收中）**，P2–P8（含长会话渲染、通知、Provider拉模型等第1类功能）均未执行。你自建的新功能越多，将来同步越痛；**顺序仍是先 SDK 后自建，本清单只调整表述不改变该顺序。**

> **同步风险说明**：“复用上游”只表示不从零开发，不代表零冲突或直接合并即可使用。UI、输入框、插件契约、存储和SDK都需按本方实现核对。GC宿主租约已在P1定向复现修复；其他功能仍在P2–P8范围。

> **当前状态摘要**：P1已随v0.7.6发布；P2–P8未执行。固定ref评估决定同步路线，不能替代P2各模块开工前的详细适配方案。

## 二、事实纠正（上一轮讨论里有几处说法不准）

| 旧说法 | 核实结果 |
| --- | --- |
| "上游删掉了 `ToolCallCard` 插件槽位" | **成立**。`HEAD` 的 `packages/shared/src/ui-plugins.ts` 有 `ToolCallCard`，`upstream/main` 只剩 `SubagentCard` + `TodoPanel`。同步后任何用该槽位的自建插件会被 manifest 校验拒载 |
| "桌面系统通知要自己做（A6）" | **不成立**。上游 `packages/desktop/src/main/native-notifications.ts`、`task-notification-observer.ts` 已实现；`HEAD` 的 `packages/desktop/src/main` 里一颗 `Notification` 都没有。这条属于白拿，不该自建 |
| "自定义 Provider 手动填模型能力" | 上游 `packages/backend/src/settings/upstream-models.ts` 已做 `/models` 拉取 + 能力补全 + `/v1` 探测。自建是重复劳动 |
| "长会话渲染要自己优化" | 上游 `ac5f545` 已做有界双窗渲染 + 行位置索引 + 会话 minimap（含 5000 行改动与 6 个新纯函数模块）。自建等于重写一遍 |
| "子代理卡是纯 UI 精简" | 上游 `d506a98` 同时改了 `SubagentRunUi` 契约（新增 `queued`/`aborted`/`summary`/`index`），是你自定义插件与本地卡片改动的**契约级冲突点**，不是纯样式 |
| "`~/.pi/agent` 可以一直用" | 上游 `952aedc` 已迁到 `~/.percho/agent` 并带首启迁移。继续写 `~/.pi/agent` 会与 CLI 共享、与上游分叉；已决定跟随上游，但**迁移不可逆**，仍在 P8 单独批准执行 |

## 三、第一档：白拿（同步上游即得，零自研）

| 能力 | 上游提交 | 对你的实际价值 | 备注 |
| --- | --- | --- | --- |
| 长会话有界渲染 + 会话 minimap | `ac5f545`、`8a4f43b`、`4ac1dff` | **最高**。你有大量长会话，这是纯性能与可读性收益，且不改变你的交互习惯 | 改动集中在 `MessageList.tsx`，与你本地悬停卡/子代理记录**不同域**，冲突可控 |
| 桌面任务完成系统通知 | `7e198a9` | 高。后台跑长任务时不必盯屏幕 | 与本地 `voice-alerts` 声音插件**功能重叠**，同步后要决定留一个还是两个都留（建议：系统通知 + 声音都留，但加统一去重） |
| 自定义 Provider 拉模型 + `/v1` 探测 | `c93b140`、`a688fd1` | 高（你在用中转站）。省掉手填能力与"Stream ended without finish_reason"排查 | 核心表单文件你几乎没改，冲突最小 |
| Pi SDK 1.5.1（含1.4.0） | `fa94709`→`87476fa` | 高，但**最痛**。P1已按固定 v0.6.8/87476fa 执行并验收中，自研 SDK patch 已重移植 | 已执行，见 [升级计划§19.13](PLAN-sdk-1.5.1-upgrade.md) |
| Code Mode 默认开 + grep/find/ls 默认开 | `915353a` | 中。工具调用成本与速度收益 | 与你的工具偏好设置要对账 |
| 输入框粘贴文件走原生路径 | `1781acc` | 中。你重度使用附件 | 小改动，顺手拿 |
| 折叠引用消息、代码块复制按钮修复、Markdown 表格修复 | `526da85`、`6c0607f`、`ee93957` | 中。日常手感 | 低冲突 |
| 子代理开发能力升级（worker/policy/deny） | `d506a98` | 中，但**契约破坏** | 会动你的 `scout` 与卡片结构，需要逐处裁决"保留本方版本" |

**同步排序已调整（2026-11-15用户确认，仅规划）：**

- P1已发布；P2优先顺序为：模型自动提取首批（A1–A3）→ 输入层解耦 → Lexical与句中引用 → 其余上游同步。模型提取B（自动协议回退）仍单独定案，不成为编辑器迁移的必需前置。
- Lexical从P8长期延后项移入P2独立迁移批次，两个验收关口见§七。不要与模型提取、长会话渲染或其他大改并行实施；SSH继续独立延后。
- 句中引用直接服务长提示与多文件/技能编辑；先保持textarea行为完成职责拆分，再切编辑器，不在旧textarea上增加长期复杂兼容层。
- 每合一批就 `git diff` 对账一次，别攒成一次性 645 文件的大合并。
- 同步前先冻结当前状态（分支 + tag），别在没有回退点的 dirty 工作区上开合并。

## 四、第二档：值得自建（上游没有，且你有真实使用场景）

按"日常体感收益 ÷ 风险"排序，**建议只做前四项**：

| 优先 | 能力 | 为什么对你有用 | 风险/前置 | 已有方案 |
| --- | --- | --- | --- | --- |
| 1 | **会话左右分屏** | 你实际就是在多会话之间来回切（跑长任务 + 问问题 + 看 diff）。这是最大的结构性缺口，且不依赖任何上游能力 | GC 保护、`session-page-slide` 过渡、13 个组件作用域改造；需先做纯重构批次 | `PLAN-session-split-panes.md` |
| 2 | **项目文件树 + 只读打开 + 统一跳转** | 现在"agent 说创建了 `index.html`，你却要自己去翻目录"。这条链路一打通，`ArtifactsDrawer` 才真正好用 | 路径安全（realpath/junction）、sandbox 不放宽 | `PLAN-project-file-tree-readonly.md` |
| 3 | **⌘K / Ctrl+K 全局搜索** | 439 个会话、1.2GB。找不到旧结论是真实痛点 | 必须双重有界 + 如实显示"已扫描 N/M"，否则会假装搜全 | `PLAN-global-search.md` |
| 4 | **按轮 Keep / Undo** | 唯一能防住"agent 改坏一片、你手工还原"的能力。也是你自己最常做的动作 | **必须先做 20 行 spike** 验证 `tool_execution_start` 早于写盘；失败则降级为"仅支持 edit 撤销" | `PLAN-turn-checkpoint-undo.md` |
| 5 | Changes 面板增强（逐文件暂存 + 生成提交文案） | 你已在用 GitLens；后端 `gitCommit` 已支持 `stage` 数组与 amend，缺的只是 UI 与文案生成 | 模型调用成本、大 diff 截断 | 本文 §五 |
| 6 | 会话行信息密度（模型/耗时/改动量/分支） | 扫一眼知道哪条会话动了什么 | 31px 行高是硬约定，加字段要克制；未加载会话不能伪造数据 | 本文 §五 |
| 7 | 额度提示 UI | `quota` 服务 + IPC + `useQuota` 都已存在，只差展示。属于"捡现成" | 区分"无订阅"与"拉取失败" | 本文 §五 |
| 8 | 会话文件夹 + 状态过滤 | 会话变多后需要组织 | 状态是运行时派生，不能只读 transcript，否则历史会话全变 idle | 本文 §五 |
| 9 | 模型生成标题 | 比"首条消息前 20 字"好读 | 要先确认 SDK 模型调用入口；用户改名后必须锁定 | 本文 §五 |

## 五、高性价比的"小交互"清单（不需要新功能，改动小、体感强）

这些是比新功能更容易被忽略、但**每天都会碰到**的：

1. **Diff 文件名可点击** → 打开对应文件并定位行（依赖第二档第 2 项）。
2. **聊天里的 `src/foo.ts:120` 可点击** → 同一个 `openProjectFile` 路由，不猜路径、解析失败就当普通文本。
3. **工具卡里的路径可点击** → 同上。

   **已登记 WIN-LINK-01**：Windows `C:/…`、`E:/…` 聊天链接被误当未知协议而静默忽略。用户要求后续实现；先恢复现有系统打开功能，再按P4统一内嵌预览，详细范围与验收见 `PLAN-project-file-tree-readonly.md` 的“已登记缺陷”小节。本轮仅登记。
4. **通知点击回到对应会话**（同步上游即有，但要确认跨环境切换正确）。
5. **审批 Dock 自动获焦**，审批完焦点回到输入框（现在需要手动点）。
6. **会话行 hover 卡补"本会话累计改动 + 本会话模型 + fork 关系"**（卡已存在，只补字段）。
7. **Ctrl/Cmd+Enter 与 Esc 的一致性**：发送/停止/关闭浮层三个动作在所有输入框里保持同一套键。
8. **Todo 面板与轮次联动**：点某条 todo 跳到产生它的那一轮。
9. **ArtifactsDrawer 记住上次选中的文件与缩放**（现在每次都要重新选）。
10. **窗口失焦时的轻量提示**（标题栏/胶囊上加一个极小的完成 glyph，而不是系统弹窗）。

## 六、第三档：现在不建议做（不是不能做，是排不到你前面）

| 能力 | 不建议的理由 |
| --- | --- |
| 终端 dock（B7） | 需要 PTY/ConPTY + 输出限流 + 权限；Windows 风险高，且你的 agent 已经能跑命令，收益边际低 |
| operator / 宿主操作（B8） | 让 agent 操作 GUI 的收益远小于风险（权限绕过、递归编排、审计），除非你明确要做"AI 操作 Percho 自己" |
| 会话 worktree（B1） | 只有在"多 agent 同时改同一仓库"成为常态时才值得；现在属于空转基建，且 Windows 锁/磁盘泄漏坑多 |
| 定时/周期任务（B10） | 与你现在的"手动发起 + 频道协作"用法重叠；Electron 退出补偿、权限弹窗、重复触发都是长期债 |
| Notes + `@note`（B4） | 你已经用仓库内 Markdown + `@` 文件引用覆盖了大部分场景，再建一套笔记系统会分裂真源 |
| 编排文件冲突调度（B9） | 需要 agent 先能声明读写集；在还没有稳定编排模型时做锁，等于给还没建好的房子装门禁 |
| SSH 远程开发 | 上游有（`fe8f06d`），但属架构级改造；你有 LAN 看板已覆盖"远程看进度" |
| issue Inbox / 多 provider 适配 | MonoCode 的平台化路线，与"Pi 深度定制 GUI"的定位相反 |
| 完整 Monaco IDE | 先把"能打开、能跳转"做稳，再谈编辑；否则会变成一次性大重构 |

## 七、执行阶段（唯一顺序）

本节是全局阶段顺序的唯一真源。后续文档只引用 P0-P8，不再另立批次号。

| 阶段 | 内容 | 完成边界 | 详细方案 / 来源 |
| --- | --- | --- | --- |
| **P0** | 文档与事实收口 | 计划真源、链接、基线和决策记录一致；不改源码 | 本文、`INDEX.md`、`HANDOVER.md` |
| **P1** | Pi SDK 1.5.1 升级与补丁重移植（已随v0.7.6发布） | SDK 与 `message-control` 补丁完成迁移和验证；不混入分屏、搜索、文件树 | `PLAN-sdk-1.5.1-upgrade.md` §19.13 |
| **P2** | 上游功能同步（含提前的独立输入迁移批次） | 先模型提取A1–A3，再输入层解耦、Lexical与句中引用，分批验收；后续长会话同步保留 `4ac1dff → 8a4f43b → ac5f545` 依赖链，槽位与SubagentRunUi适配同相关批次 | 本节P2内部顺序、§九；roadmap契约细节 |
| **P3** | 会话左右分屏 | 第一批仅做 pane 作用域纯重构，零行为变化；之后才接可见渲染、GC 和入口 | `PLAN-session-split-panes.md` |
| **P4** | 项目文件树只读 + 统一打开路由 | 首版只读，复用预览台；不接 Monaco。Diff、聊天、工具卡共用打开路由 | `PLAN-project-file-tree-readonly.md` |
| **P5** | 全局搜索 | 先落本地项目名 / 会话标题 / 文件名三域，再接收有界正文扫描；正文搜索与 `⌘Enter` 右侧打开依赖 P3 | `PLAN-global-search.md` |
| **P6** | 按轮 Checkpoint / Undo | 先做 20 行 `tool_execution_start` 时序 Spike；通过后再实现采集、回滚和 Diff 集成 | `PLAN-turn-checkpoint-undo.md` |
| **P7** | 低风险体验增强 | Changes 增强、会话行信息密度、额度提示、文件夹与过滤等项目；逐项独立验收 | roadmap §五 |
| **P8** | 高风险或明确延后 | 数据目录迁移、worktree、终端、operator、定时任务、Notes、完整 Monaco IDE（Lexical已提前至P2） | 本文 §九、roadmap §五 |

### P2内部顺序与输入迁移验收关口（2026-11-15已确认）

仅细分P2，不新增全局阶段编号，P3–P8编号不变。用户批准的是规划调整，不是源码实施。

| 次序 | 独立批次 | 进入/退出条件 |
| --- | --- | --- |
| 1 | 模型自动提取A1–A3 | 按模型发现方案完成提取、字段/档位/显式协议配置及保存读回；不夹带编辑器改造；B回退另议 |
| 2 | 输入层解耦 | 保留现有textarea与可见行为，拆清编辑状态、不可变发送快照、草稿恢复和消息控制职责；现有发送/恢复回归通过后才进入下一批 |
| 3 | Lexical与句中引用 | 在已解耦边界接结构化编辑、文件/技能句中引用和粘贴；保持发送顺序/身份与恢复，真实中文输入法及光标验证；稳定后移除旧输入实现，不长期维护双编辑器 |
| 4 | 其余上游同步 | 长历史分页/有界渲染/minimap、通知、子代理等按原依赖核对；不与上述输入迁移大改并行 |

输入迁移必须保护：ACK前草稿不清、等待期间新编辑不丢、请求幂等、queue/steer/interrupt、手动压缩保护与自动压缩行为、撤回/取回后的文字/引用顺序、多图/附件/斜杠命令、IME与快捷键。不得为换编辑器顺手重写SDK消息控制协议。

**已确认 SESSION-HOVER-01（仅登记，待下次与其他功能一起开工）**：采用用户拍板的 `D:/Project/Percho/功能/会话悬停详情功能/redesign-preview.html`（方向 C 定稿版：标题 + `状态·模型·目录` 单行锚点 + 灰底圆角 `首问` 胶囊 + 全量角色计数胶囊与 `最新` 1 条子代理直达 + 点击 `全部 N ▾` 原地展开紧凑单行列表 + 底部创建/活动时间），彻底对齐 `docs/ui.md` 无边框浮层规范（`rounded-xl bg-surface shadow-pop`、`.fade-rule`、`.edge-fade`、`Tooltip`）。详细契约见 roadmap“已确认交互待办：会话悬停预览卡（SESSION-HOVER-01）”。本轮仅登记，不改代码。

**已确认 COMPOSER-SEND-01（仅登记，待下次输入框修复一并处理）**：采用用户指定 `D:/Project/Percho/功能/输入框界面/redesign-preview.html` 的子母胶囊，替代文字大黑按钮和三项菜单。空闲有草稿只留↑；运行有草稿用浅灰底座包左⌄右↑，旁边独立浅灰停止■；运行无草稿只留高对比停止。菜单仅“优先插话／打断并发送”两项，↑和Enter负责queue；不记默认偏好、不发送停止时的草稿。详细契约、来源hash和生产适配要求见roadmap“已确认交互待办：组合发送控件”。安排在输入层解耦后的可见交互批次，不混入零行为变化关口；本轮不实施。

实施前还须补齐输入层接口、结构化引用如何无损转换为payload/draft及历史恢复的详细设计；本次排序调整不宣称已完成这些设计。若出现确证紧急长会话性能问题，可另讨论优先级，不自动恢复旧的Lexical延后安排。

关键依赖：

1. P1 必须早于 P2，否则上游同步会同时承担 SDK 生命周期与本地补丁重移植的双重风险。
2. P3 的第一批必须是零行为变化的重构；它同时是 P4 文件 pane 与 P5 右侧打开的地基。
3. P4 首版只读，先把路径安全、真实项目文件枚举、统一打开路由和预览台做稳。
4. P6 的时序 Spike 不通过时，降级为只支持 edit 撤销，不假装拥有完整 checkpoint。
5. P8 不进入默认承诺队列；必须单独立项、单独批准。

P1已按固定 v0.6.8/SDK1.5.1 执行并验收中，P2–P8 未执行。P2-P5 都会改 `App.tsx`、`MessageList.tsx`、`session-loading.ts`、`i18n`，这些正是上游改动最密集的文件；先自建再同步，冲突会翻倍。

## 八、给"哪些对我有用"的直白回答

- **一定有用**：长会话渲染、系统通知、Provider 拉模型、分屏、文件树跳转、⌘K 搜索、按轮撤销。
- **大概率有用**：Changes 逐文件暂存 + 生成提交文案、会话行信息密度、额度提示、Diff/聊天路径可点击。
- **看你用法**：Quick Composer（你若常"临时起一条会话"就有用）、会话文件夹（会话过百才有用）、模型生成标题（好看但不影响效率）。
- **对现在的你基本没用**：终端 dock、operator、worktree、定时任务、Notes、SSH、Inbox、完整 IDE。

## 九、三项决策与落地结论（2026-11-12 定案）

### 事实补充：SDK 版本与本地补丁的真实关系（历史快照，当前状态见§十一）

| 项 | 本仓库 HEAD | upstream/main |
| --- | --- | --- |
| `pi-coding-agent` / `pi-ai` | ~~`1.0.4`~~ → **`1.5.1`**（P1已切换） | `1.5.1`（v0.6.8=87476fa） |
| patches | `pi-coding-agent+1.5.1.patch` + `pi-agent-core+1.5.1.patch`（含 message-control 重移植）、`thinking-orbs`；旧 `pi-coding-agent+1.0.4.patch`（810行，新增 `message-control.js` + 改 `agent-session.js`）已外置备份 | 上游两份1.5.1原始patch；历史 `pi-agent-core+1.4.0.patch`、`pi-coding-agent+1.4.0.patch`（945行，改 compaction + extensions + agent-session） |
| message-control 相关文件 | `shared/message-control.ts` 等 20+ 处引用 | **不存在**（上游补丁里 0 处） |

> 以下为 1.0.4→1.4.0 时代的历史取证快照，P1已按 SDK 1.5.1 重移植并验收中；关键发现保留作背景。

**关键发现**：SDK 1.4.0 **原生已有** `streamingBehavior: "followUp"`、`steer`、`getFollowUpMessages`、`followUpMode`、清空队列（见上游 `pi-backend.ts:1647-1736`）。但本地 `MessageMode = queue | steer | interrupt` 与 `ControlSnapshot`（`runtimeId`/`revision`/`phase`/`compactionKind`/`autoDispatchPaused`/`recovery`）是一层**幂等投递 + 压缩期暂停 + 停止后发送 + 失败恢复协议**，SDK 原生没有等价物。

结论：810 行补丁**不能直接丢弃，但大概率能瘦身**。值得做一个只读 spike——逐条比对 `shared/message-control.ts` 的 12 个能力点与 SDK 1.4 原生 API，能落在 SDK 上的删掉，只保留 Percho 侧协议。这是把「822 行补丁冲突」这个最大合并风险压小的唯一办法。

### D1 `~/.percho/agent` 迁移：已决定「跟随上游，P8 单独批准执行」

- 上游迁移动机成立：agent 目录与 Pi CLI 共享，Percho 专属数据（未来的 checkpoints / notes / scheduler）不该写进 CLI 目录，模型设置同步也不该反向污染 CLI。
- 已确认**不需要**在 Pi CLI 中打开 Percho 会话，也不需要与 CLI 共用扩展和 agent 定义。共享 agent frontmatter 不再作为保留 `~/.pi/agent` 的理由。
- 结论：跟随上游迁移到 `~/.percho/agent`，让 Percho 专属数据（checkpoints / notes / scheduler）与 CLI 数据彻底分开。
- 风险控制：迁移**不可逆**（旧版 Percho 读不到新目录），所以先只在 `-dev` 隔离环境验证迁移脚本行为，再切主环境；切换前完整备份 `~/.pi/agent`。
- **仍在 P8 单独批准后执行**：方向已定，但不随 P1 / P2 顺手迁移；迁移脚本、回滚与数据核对必须有独立验收。

### D2 Lexical 输入框：已决定提前至P2「先模型提取，先解耦后接入」

- 上游 0.6.6 之后所有 composer 改动都建立在 Lexical 上（`ComposerEditor.tsx`、`editor-document.ts`、`editor-host.ts`、`ReferenceNode.ts`、`paste-files.ts`、`transfer-files.ts`，新增 `lexical@0.52` 五个包）。不跟进 = 以后每个输入框修复都要手工移植，债会滚雪球。
- 你现在的冲突**不在功能层，在实现层**：排队插话的 UI（`QueueBar`）与发送协议挂在旧 `Composer` 的 textarea 状态机上。`Composer.tsx` 两侧差 490 行、`use-composer-send.ts` 差 730 行，本质是上游把逻辑搬进了 editor-host。
- 正确姿势：**先把「输入层」与「消息控制层」解耦**——Composer 只负责产出 `MessagePayload`，队列/中断/恢复全部由 `shared/message-control.ts` 的协议承担（这个 DTO 已经是独立的，方向是对的）。解耦后可本地先合并、零行为变化，再吃 Lexical。
- 明确不做：不为保住旧 textarea 新建长期兼容层。解耦完成、消息控制测试稳定后再接 Lexical；若上游 editor-host 当时仍有阻塞，再按证据延后，但不改变最终跟随方向。

### D3 `ToolCallCard` 槽位：已决定「放弃槽位，P2 同批迁移 `orchestrator-badge`」

实际使用面很小（已核实）：

- `packages/desktop/resources/ui-plugins/examples/terminal-tool-card/`（上游自带示例，会随同步被替换）；
- `~/.percho/ui-plugins/orchestrator-badge/`（**你自己唯一的插件**）。

- 保留槽位 = 永久维护一个上游已删除的公开契约，且每次同步要在 manifest 校验、`SPEC.md`、`env.d.ts`、`build.ts` shim、`contract-baseline.test.ts` 五处打补丁。这才是真正的长期成本。
- 插件现有 `src/index.tsx` 约 1,500 行；本次改造只涉及 manifest 槽位声明与移除工具卡导出，region 徽章主体保留，不需要重写插件。
- **注意合并时机**：上游同时改了 `SubagentRunUi` 契约（`status` 增 `queued`/`aborted`，新增 `summary`/`index`）。你的插件若依赖旧三态，必须**一次改完**，不要分两次。
- 已确认该插件真正需要的是全局状态徽章，继续保留 `chat.corner.top-right` region；删除工具卡槽位覆盖，工具卡恢复 Percho 默认实现。

### 决策与阶段对应

阶段顺序只以上文 P0-P8 为准。本节只说明三项既有决策落在哪个阶段，不另列执行序列：

| 决策 | 结论 | 阶段 |
| --- | --- | --- |
| D1 数据目录迁移 | 已确认不与 Pi CLI 共享；跟随 `~/.percho/agent`，迁移不可逆，dev 先验并完整备份 | P8 |
| D2 Lexical | 模型提取首批之后独立推进，先解耦并守住原行为，再接Lexical/句中引用；不建旧textarea长期兼容层 | P2独立迁移批次（原P8归属已撤销） |
| D3 `ToolCallCard` 槽位 | 放弃槽位；删除工具卡覆盖，保留 region 徽章，与 `SubagentRunUi` 契约变更同批 | P2 |

P2中的长会话同步链有依赖，不是三个独立 cherry-pick（不代表整个P2只有这三项）：`4ac1dff`（#142 历史分页 + 图片按需）→ `8a4f43b`（#154 有界渲染，同时删槽位）→ `ac5f545`（#161 minimap）。必须同批处理插件破坏性变更。

## 十、版本策略：Pi CLI 要不要先升

### 实测现状（历史快照，当前状态见§十一）

| 副本 | 版本 | 位置 |
| --- | --- | --- |
| 全局 Pi CLI | **1.2.0** | `%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent`（2026-10-15） |
| Percho 安装包内置 | **1.0.4** | `%LOCALAPPDATA%\Programs\Percho\resources\pi-package` |
| 本仓库 dev 依赖 | ~~**1.0.4**~~ → **1.5.1**（P1已切换） | `node_modules` |
| 上游目标 | ~~**1.4.0**~~ → **1.5.1**（v0.6.8=87476fa，P1固定基底） | `upstream/main` |

**陷阱**：在 Percho 的 agent shell 里跑 `pi --version` 会返回 `1.0.4`，因为环境变量 `PI_PACKAGE_DIR` 指向 Percho 内置包。真实全局 CLI 版本要在普通终端或 `env -u PI_PACKAGE_DIR pi --version` 下查。

### 结论

- **不建议现在单独升级 CLI。** 单独升只会扩大“CLI 2.x 写、Percho 1.0.4 读”的不一致窗口，而你拿不到多少收益。
- **当前目标是：Percho SDK → 1.4.0；CLI 不再需要与 Percho 共用会话或扩展。** 在 D1 迁移完成前，两边仍可能写同一个 `~/.pi/agent`，应避免两个版本并发写同一会话。
- 现有 CLI 1.2.0 vs Percho 1.0.4 的不一致**已经存在**且尚未爆问题，说明 1.2.0 对 1.0.4 的会话格式没有破坏性改变；不要把这个巧合当保证。
- 例外：若你在终端里重度使用 CLI（长任务、脚本、非 Percho 场景），才值得单独跟进 CLI，且此时更应先升 Percho。

### 额外收益（与 D1 联动）

迁到 `~/.percho/agent` 后这个耦合**自动消失**：Percho 用自己的目录，CLI 用 `~/.pi/agent`，各自升级互不影响。既然已确认不需要共享，迁移应沿上游完成，但仍在 P8 单独验收。

### 动手前的最小取证

1. 在**普通终端**确认 `pi --version`（不要在 Percho 里查）；2. 抽查最近 CLI 写过的会话能否在 Percho 里完整打开；3. 扫 `~/.pi/agent/sessions` 最新几个 jsonl 的 entry type 是否有 Percho 1.0.4 不认识的值。

## 十一、2026-11-15 上游固定ref重评与三类状态分类

### 11.1 固定ref重评表（git本地核）

| 版本 | ref | SDK | 备注 |
| --- | --- | --- | --- |
| 本地v0.6.6 | `0825d43034ae82f30e07046fdcf46401386d675c` | 1.0.4 | fork同名tag，不能冒上游 |
| 上游v0.6.6 | `b56f2121782f78211e5e02b7fa1c8999feaddbf6` | 1.4.0 | 初scout经GitHub refs确认，主本地对象存在 |
| 上游v0.6.7 | `8a4f43b5429471ec045dfc2cf6314ec458c50a` | 1.4.0 | 0.6.6..0.6.7共12 commits（4ac1dff分页/8a4f43b渲染、d506a98子代理契约、1781acc粘贴、a688fd1 provider、915353a工具默认） |
| 上游v0.6.8 | `87476fa1f884d3590e58400b4099212593a5a047` | 1.5.1 | 0.6.7..0.6.8共14 commits（87476fa SDK+perf、b4bd233 GC重开事件UI恢复、50ebd70归档catalog、ac5f545 minimap、526da85/78c02ed折叠/tokenspeed、aa538c8文件管理器）；P1固定基底 |

### 11.2 已采纳SDK vs 延后产品 vs GC缺口（已收）

| 类别 | 范围 | 状态 |
| --- | --- | --- |
| **已采纳SDK（P1）** | SDK 1.5.1；本地三模式/手动压缩/真实preprompt ACK/G3/G4/G5；G1复验（Win最终1087/1412、strict2、typecheck、lint90warn18info，证据 `g1-final-corrected-20261114-222951`）；GC宿主租约竞态修复（§19.14：目标65/65、backend1102/1102、desktop1412/1412、3strict/typecheck/lint过，独立PASS，证据 `gc-lease-20261115-111535`） | 通过历史证据限定当前Win冻结，验收中；旧G1/G6不含GC修复，后续候选需重冻结并经 GitHub fresh CI 取证 |
| **延后产品（P2–P8）** | 长会话渲染、归档catalog、minimap、文件管理器、折叠/tokenspeed、通知、Provider拉模型、Lexical、数据目录迁移等 | 未执行，未授权 |
| **GC缺口（已收）** | GC宿主租约竞态已定向复现并最小修复：仅 `intent="gc"` 在首个 await 前同步取租约，`user`/`delete` 保持；预热 pending 会延后 GC，off 后可 GC（模型流为内存stub，无真实provider） | 缺口已收，见升级计划§19.14 |

> **发布后覆盖**：上表SDK/GC的阶段证据已由后续完整验证覆盖：最终main `4794b98`的CI `43683085900`六项成功，v0.7.6 Release `43684005317`三平台build与publish成功。P2–P8仍未实施，不能把SDK发版等同于同步了上游全部功能。

## 十二、发布视频截图补充评估（2026-11-15）

用户提供27张上游发布截图并明确仅做规划，覆盖审查见 [上游截图对照](PLAN-upstream-screenshot-review.md)。本节不改变P0–P8顺序，不授权实施。

- 现有Plan已覆盖长会话渲染/分页/minimap、Provider发现、子代理契约、Lexical与独立数据目录方向；截图不代表这些均已移植。
- **补充规划缺口**：归档管理的pending/订阅/恢复契约、截图整理恢复的备份/事务/中断恢复、首次迁移引导、长消息折叠默认与回合速度口径。
- MCP发现/组合工具、子代理只读查看、图片/字号/侧栏设置本方已有部分基础；先比差异，不重新造执行器。
- **模型自动提取**：以 [模型发现审查方案](PLAN-provider-model-discovery.md) 为规划基线，优先字段/档位/保存闭环；efforts不推断adaptive，协议自动回退单独定案。用户明确暂不实施。
- **已确认的排序调整**：Lexical提前为P2独立迁移批次，置于模型提取首批之后，先解耦再接入，不与其他大改并行；仅批准规划。
- **仍待讨论**：折叠默认是否按偏好记忆、归档pending保护、截图整理方式、权限变化与迁移细节。本次Lexical决定不连带批准其他推荐项。
- Windows本地链接缺陷`WIN-LINK-01`保留独立入口，不必等待完整文件树/预览实现。

## 十三、审查清单

- [ ] 确认按 P0 → P8 推进，且 P1 与 P2 不并行开工。
- [x] 数据目录方向已定：不与 Pi CLI 共享，跟随 `~/.percho/agent`，P8 单独批准并按不可逆操作验收。
- [x] `ToolCallCard` 槽位已定：放弃槽位，P2 同批迁移自建插件并适配 `SubagentRunUi`。
- [x] Lexical方向与时机已定：从P8提前至P2独立批次，模型提取A1–A3之后先解耦再接入；不长期保留双编辑器，仅调整规划、未授权实施。
- [ ] 确认第二档只做前 4 项，其余延后。
- [ ] 确认 P8 高风险能力整体搁置，不因已编号而视为已批准。

**本文记录取舍结论与阶段归属；本轮未修改任何功能源码、依赖或执行器开关。**
