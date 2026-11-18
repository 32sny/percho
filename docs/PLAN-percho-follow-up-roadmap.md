---
类型: 技术方案
状态: 后续契约待实施前复核；P1随v0.7.6发布，P2–P8未实施；WIN-LINK-01已登记
创建: 2026-11-03
更新: 2026-11-17
适用: Percho 后续功能路线：MonoCode 借鉴项、项目文件树、内置编辑器与 AgentTeam 能力
---

# Percho 后续功能完整路线图：从并行会话到轻量开发工作台

> 本文是实施前审查方案，不代表已经开始修改源码、配置或执行器开关。
>
> **发布后状态（2026-11-15）**：SDK 1.5.1已随v0.7.6发布（`4794b98`），四架构CI及三平台Release通过；下文0.7.5/1b92149与“P1验收中”是历史取证背景，不再表示当前状态。上游0.6.6–0.6.8已做路线级重评，具体功能开工前仍须核对适配与冲突；P2–P8尚未实施。
> **排序已修订**：全局阶段顺序以 [功能取舍清单](PLAN-percho-feature-catalog.md) 为准；本文只维护功能契约、依赖、文件范围与测试细节，不维护第二套批次号。
> 当前基线（2026-11-15修订）：Percho `0.7.5`，HEAD `1b92149`；dev 依赖已按 P1 切换至 SDK 1.5.1（固定上游 v0.6.8=`87476fa1f884d3590e58400b4099212593a5a047`，验收中，见 [升级计划§19.13](PLAN-sdk-1.5.1-upgrade.md)）。旧“本地 `upstream/main` 快照 `1145c7a`（领先 36 / 落后 34）”属旧快照历史记录，不是当前状态；P2–P8 未执行，GC宿主租约缺口已定向验证并最小修复（见升级计划§19.14）。
> 关联资料：`docs/PLAN-percho-feature-catalog.md`、`docs/PLAN-sdk-1.5.1-upgrade.md`、`docs/PLAN-session-split-panes.md`、`docs/PLAN-project-file-tree-readonly.md`、`docs/PLAN-global-search.md`、`docs/PLAN-turn-checkpoint-undo.md`，以及 `HANDOVER.md`。

## 一、结论与覆盖状态

### 1.1 结论

全局阶段顺序已由 `docs/PLAN-percho-feature-catalog.md` 统一收口。本文不重复排期，只回答每个功能“依赖什么、改哪些文件、怎么验证、失败时怎么收敛”。

当前覆盖状态：

1. SDK、分屏、文件树、全局搜索、checkpoint 均已有仓库内单项方案。
2. 上游同步以 catalog P2 为准：路线级重评已完成，具体模块的适配、冲突处理与回归清单仍须在开工前核对；P1（SDK 1.5.1）已随v0.7.6发布。
3. Windows聊天文件链接无响应已登记为 `WIN-LINK-01`，详细范围见[文件树计划的已登记缺陷](PLAN-project-file-tree-readonly.md#13-已登记缺陷windows-聊天文件链接无响应win-link-01)：先修现有系统打开链路，再接P4项目内预览；当前只记待办，不实施。
4. A2、A5、A6、A7 与 B1-B11 保留在本文作为契约池；是否进入当前阶段只看 catalog。

### 截图补充范围（2026-11-15）

上游发布27张截图与当前能力/计划的对照见 [截图覆盖审查](PLAN-upstream-screenshot-review.md)，阶段排序仍由catalog维护。新发现的规划缺口为：归档管理、截图整理恢复、迁移引导的失败/恢复边界，以及折叠默认和回合速度定义；本方已有MCP/Code Mode、子代理只读与外观设置应先核差异，不重复实现。

[模型自动提取方案](PLAN-provider-model-discovery.md)已由用户选为规划基线，明确暂不实施。用户已确认Lexical从P8提前至P2独立迁移批次，模型提取A1–A3之后先输入层解耦、再接Lexical和句中引用；只调整规划，不与其他大改并行。归档pending保护、折叠默认和媒体维护方式仍待讨论，不连带批准。

### 1.2 功能覆盖矩阵

| ID | 功能 | 当前实现事实 | 现有计划状态 | 本文处理 | 依赖阶段 |
|---|---|---|---|---|---|
| A1 | 会话左右二分 | 有会话工作区胶囊，无并排 pane | 详细方案：`docs/PLAN-session-split-panes.md` | 已覆盖，需审查依赖和事实 | P3 |
| A2 | 会话行信息密度 | 行本体无模型/耗时/diff/分支汇总；悬停卡已有部分元信息 | 无完整方案 | 本文给出实施契约 | P7 |
| A3 | 按轮 Keep/Undo | Diff 可看，无磁盘回退闭环 | 详细方案：`docs/PLAN-turn-checkpoint-undo.md` | 已覆盖，必须先过 spike | P6 |
| A4 | `Ctrl/Cmd+K` 全局搜索 | 左栏仅过滤标题；文件枚举已有 | 详细方案：`docs/PLAN-global-search.md` | 已覆盖，需审查扫描边界 | P5 |
| A5 | 命令面板与可改快捷键 | 未发现统一注册表和改键 UI | 无完整方案 | 本文给出实施契约 | P7 |
| A6 | 桌面通知、未读、提醒 | 未读已有，声音插件已有；OS 通知随上游同步 | 无完整方案 | 本文给出实施契约 | P2 / P7 |
| A7 | Quick Composer | 草稿系统已有，无全局快捷键浮窗 | 无完整方案 | 本文给出实施契约 | P7 |
| A8 | 项目文件树与内置编辑器 | ArtifactsDrawer 只从 transcript 产物生成；项目文件枚举已有，无通用读取/编辑链 | 详细方案：`docs/PLAN-project-file-tree-readonly.md` | 只读首版归 P4，编辑器延后 | P4 / P8 |
| B1 | 每会话 Git worktree | Percho 原生未实现；外部执行器不算 | 无完整方案 | 本文给出高风险预研与实现契约 | P8 |
| B2 | Changes、提交文案 | Git status/diff/commit 已有；UI 主要 stage all；AI 文案/逐文件暂存缺失 | 无完整方案 | 本文纠正事实并给出增量方案 | P7 |
| B3 | 会话文件夹与状态过滤 | 有项目分组、pin、状态 hook；无文件夹/跨 GC 稳定状态过滤 | 无完整方案 | 本文给出实施契约 | P7 |
| B4 | Notes 与 `@note` | 未发现 Notes store/UI/IPC | 无完整方案 | 本文给出实施契约 | P8 |
| B5 | 模型生成会话标题 | 当前 `autoNameSession` 使用首条用户文本，不是模型生成 | 无完整方案 | 本文给出 opt-in 方案和 SDK spike 门 | P7 |
| B6 | 额度提示 | quota service、IPC、`useQuota` 已有；未发现消费它的 UI | 无完整方案 | 本文给出 UI 增量方案 | P7 |
| B7 | 终端 dock | 未实现，未发现 pty/xterm 接线 | 无完整方案 | 本文只规划预研和安全边界 | P8 |
| B8 | `/operator` 宿主操作 | 无 operator；已有 UI context、扩展对话框和子代理关系记录 | 无完整方案 | 本文给出最小安全子集，不复制全套 CLI | P8 |
| B9 | 编排文件冲突串行化 | 有 channel-watch，无文件范围锁/调度 | 无完整方案 | 本文给出 scheduler 契约 | P8 |
| B10 | 定时/周期任务 | 无产品调度器；更新检查的 schedule 不算 | 无完整方案 | 本文给出持久调度契约 | P8 |
| B11 | 工具 diff 内嵌聊天流 | 已有工具卡和 DiffSidebar，是否内嵌需统一打开协议 | 无完整方案 | 本文给出低风险增量方案 | P4 |

### 1.3 明确不纳入本路线

以下仍保持 `HANDOVER.md` 的决定，不因本路线改变：

- 不切换或关闭 `subagentPreferBuiltin`。
- 不卸载 pi-subagents、PiFlow 或修改外部执行器定义。
- 不把外部 Agent 的 `worktree`、`schedule`、workflow 能力描述成 Percho 原生已实现。
- 不引入 MonoCode 的多 provider/harness 适配、Mono 常驻 agent、远程 SSH、手机原生 App 或 issue Inbox。
- 不在本轮实施任何源码、配置、依赖、数据库、Git 提交或发布动作。

## 二、现有实现定位

### 2.1 可复用能力

| 能力 | 真实位置 | 复用边界 |
|---|---|---|
| typed IPC 单一事实源 | `packages/shared/src/ipc-channels.ts` | 新 invoke 必须先入域表，再接 main handler；不手写旁路通道 |
| 项目文件枚举 | `packages/backend/src/project/files.ts:walkProjectFiles` | 有排除目录、5000 条上限、30s TTL；不能把它当懒加载目录树或安全读取 API |
| Artifacts 产物提取 | `packages/desktop/src/renderer/src/components/artifacts/useArtifacts.ts` | 只适合从当前 transcript 的 edit/write 推导产物；不作为项目文件真值 |
| Artifacts 预览 | `components/artifacts/ArtifactsDrawer.tsx`、`Viewport.tsx` | 可复用 HTML/SVG/Markdown 预览和 code view；需先补安全的项目文件输入协议 |
| 会话工作区 | `stores/session-workspace.ts`、`shared/src/session.ts` | `files/activeFile` 是会话文件胶囊状态，不得直接改作源码文件状态 |
| 会话加载/GC | `stores/session-loading.ts`、`lib/session-gc.ts` | 分屏必须按可见 pane 保护；文件工作区不得依赖单一 `activeSessionId` |
| diff 事实 | `shared/src/transcript/turn-files.ts`、`components/diff/` | 现有 diff 是 transcript 声明，不是磁盘快照；checkpoint 需另建磁盘真值 |
| Git 能力 | `packages/shared/src/git.ts`、`desktop/src/main/git.ts`、`components/git-lens/GitLens.tsx` | `gitCommit` 已支持 `all`、`tracked`、路径数组和 amend；新计划只补 UI/生成文案，不重复造提交 API |
| 额度链路 | `backend/src/settings/quota.ts`、`SESSION_CHANNELS.getQuota`、`renderer/src/hooks/use-quota.ts` | 已有取数与缓存，缺展示和错误/无订阅状态设计 |
| 未读与声音提醒 | `components/session/session-status.ts`、`resources/ui-plugins/builtin/voice-alerts` | OS 通知需复用事件边沿，不能另造一套完成判定 |
| 草稿 | `renderer/src/stores/drafts.ts`、`App.tsx` | Quick Composer 复用草稿/附件/发送协议，不复制 Composer 状态机 |
| 项目信任与权限 | `ensureProjectTrust`、权限/扩展对话框体系 | 文件读写、定时触发、operator 都不能绕过既有安全门 |
| 文档与 UI 规则 | `docs/ui.md`、`docs/architecture.md`、`AGENTS.md` | UI 必须 token 化、双语、无硬编码色值；新文档必须带 YAML frontmatter |

### 2.2 不能直接复用或必须先修正的假设

1. **ArtifactsDrawer 不是项目文件浏览器。** 它从工具调用参数重建内容，文件可能已被后续工具或用户改变；项目文件必须读取真实磁盘。
2. **`session-workspace.activeFile` 不是当前源码文件。** 文件树要新增独立 `workspace-files` 状态，或将来挂到 pane 作用域，不能污染会话工作区快照。
3. **`walkProjectFiles` 不是安全读取契约。** 首版需要 `projectId + relativePath`，后端再次规范化、realpath 校验和根目录边界检查。
4. **`gitCommit` 已经存在。** 未来方案应补 Changes UI、逐文件 stage、生成文案和错误交互，不要新增重复 `git:commit` 通道。
5. **未读不等于 OS 通知。** `unseenCompletion` 是 renderer 内存状态；系统通知需要窗口聚焦、用户设置、去重和生命周期持久化。
6. **GC 会卸载会话。** 会话文件夹的状态过滤不能只读取当前 transcript，否则历史/未加载会话会被错误显示为 idle。
7. **分屏不能简单复制整个 App。** pane 作用域必须通过 `usePaneSessionId()` 和可见集合保护实现；全局浮层、插件槽位、草稿和权限 dock 要逐项决定作用域。
8. **checkpoint 的 turnIndex 不能凭感觉复用。** 需要先验证 SDK 事件顺序，并用同一纯函数规则对齐 `deriveTurnChanges`。

## 三、总体架构决策

### 3.1 推荐总体形态

采用“聊天优先、文件工作区独立、全局能力通过 typed contract 接入”的结构：

```text
App
├─ SessionWorkspace / SessionPane       会话与分屏
├─ ProjectExplorer + FileSurface        项目文件树与只读/编辑表面
├─ ArtifactsDrawer                      本轮 agent 产物预览
├─ Diff/GitLens                         代码审阅和 Git 操作
└─ CommandPalette / NotificationCenter  全局导航和状态反馈
```

### 3.2 状态归属

| 状态 | 真源 | 生命周期 |
|---|---|---|
| 焦点会话 | `sessions.activeSessionId` | 当前 renderer 进程 |
| 会话胶囊 | `session-workspace` | UI 偏好持久化 |
| 分屏次 pane | 新增 `panes`，最终并入工作区快照 | UI 偏好持久化 |
| 当前项目文件 | 新增 `workspace-files` | 项目 + 工作区，可恢复 |
| 文件内容 | 磁盘；renderer 只保留有界 buffer/hash | 文件打开期间 |
| agent 产物 | transcript 派生 + Artifacts state | 会话/轮次 |
| checkpoint | backend manifest + blob | 会话文件生命周期 |
| 通知去重 | main `notification-state` | userData |
| Notes | userData 下 Percho 专属目录 | 全局用户数据 |
| 定时任务 | main scheduler store | userData |

### 3.3 失败契约

所有新增能力遵循 fail-closed：

- 路径、项目、会话、权限、版本校验失败时拒绝操作，不猜测、不半成功。
- IPC 返回可判定的错误码或结构化失败结果，不把绝对路径、凭据和完整工具输出写入日志。
- 异步结果在落地前检查 request/session/pane 代次，迟到结果不能抢焦点或复活已删除对象。
- 文件保存、会话移动、checkpoint undo、worktree 创建采用临时文件/事务 journal/回滚策略。

## 四、依赖阶段

全局顺序只看 [catalog](PLAN-percho-feature-catalog.md) 的 P0-P8。本节只说明各契约在什么前置条件下可以进入实施，不再另立批次号。

### P2：模型提取后的输入迁移

执行排序以catalog“P2内部顺序与输入迁移验收关口”为唯一真源，本文只规定两道关口的契约：

- **输入层解耦**：保留现有textarea、可见交互和发送行为，只拆清编辑状态/发送快照/草稿恢复与消息控制职责；现有回归通过后才切换编辑器。
- **Lexical与句中引用**：在上述边界接入编辑器，引用位置与顺序在发送、取回和撤回编辑后保持；验证IME、光标、复制粘贴、快捷键、多图/附件/斜杠命令。保持ACK前保草稿、等待中新编辑保护、请求幂等与三模式、手动/自动压缩语义。
- 不重写SDK消息控制协议；过渡期保留textarea只为迁移验证，Lexical稳定后移除旧输入实现，不长期维护双编辑器。
- 开工前需补齐编辑文档、payload/draft无损转换和恢复接口设计；当前为规划排序与验收边界，非实施方案已全部定稿。

### 已确认交互待办：组合发送控件（COMPOSER-SEND-01）

用户在升级0.7.6后的讨论中确认采用组合发送控件，要求记录并在下次输入框修复时一并处理。随后明确选定 `D:/Project/Percho/功能/输入框界面/redesign-preview.html` 的“子母胶囊”方案，取代之前的文字大黑胶囊与三项菜单建议。**2026-11-17 已在独立可见交互批次实施并验证**，未并入零行为变化的输入层解耦关口；无需等待 Lexical 迁移。

**设计来源**：上述HTML（901行），已记录SHA-256 `277e21f7ebf23a9193b03d71cc4186d4ed8eda1b221a17032b87ddb6cc7fb4fc`。原型为视觉参考；生产实现已转为项目语义 token、真实 button / Tooltip 和 Portal / `placeMenu` 定位。

| 状态 | 展示与操作 |
| --- | --- |
| 空闲、有可发送草稿 | 只显示普通发送主按钮（↑），隐藏发送方式下拉；Enter普通发送 |
| 运行中、有可发送草稿 | 浅灰胶囊底座包住左侧⌄与右侧↑主圆钮；↑一键queue，不常驻“排队发送”文字、不加内部竖线。旁边保留独立浅灰次级停止圆钮■ |
| 运行中、无可发送草稿 | 不显示发送组，只显示高对比停止圆钮■；普通运行态占位文案提示“输入消息排队发送…” |
| 运行中、展开菜单 | 在发送组合上方右对齐显示无边框阴影菜单，仅“优先插话／打断并发送”两项及解释；不重复列出排队 |
| 空闲、无可发送草稿 | 不显示可触发的发送组和停止按钮 |

- 下拉选项为一次性动作，选中即执行对应模式；不改变或记忆默认模式，Enter始终普通发送/queue。保留Ctrl/Cmd+Enter的既有打断快捷键、Shift+Enter换行与IME保护。
- 保留readonly、sending同步防重、slash命令、队列容量与手动压缩禁发守卫；明确auto压缩按现有控制快照支持三模式。状态判定必须结合control而非只看流式输出，不能在准备/自动压缩期间错判为空闲。
- 不删除普通发送能力、不将停止与发送合并；组合只解决入口割裂和模式含义不清，不修改SDK/后端消息控制协议。
- **选定视觉**：主圆钮保持32×32参考尺寸，胶囊向左容纳约24宽下拉触区，沿用单行底栏；有草稿时停止钮降为浅灰次级，无草稿时作为高对比唯一动作。停止hover只使用项目错误色语义token，不写死红色。深色主题用相同语义token自动适配，不照抄原型的固定色值。
- 运行中的↑提供“排队发送”Tooltip和aria-label，空闲时为“发送”；⌄标识“发送方式”，■标识“停止”。菜单支持键盘、外部点击与Esc关闭，关闭不提交、不停止。图片-only草稿也算可发送内容；手动压缩等特殊状态的解释优先于普通排队占位文案。
- **原型转生产边界**：HTML的对比卡、说明条、固定1360画布、模型名称和“完全访问”只是展示素材，不纳入产品默认值。原型含硬编码字号/色值及示例div按钮，不能直接复制进renderer；正式实现使用text-ui-*、globals.css语义token、真实button和既有Tooltip，浮层按项目要求portal/定位。原型“底栏无跳变”未实测，窄窗口、长模型名和状态切换必须验证。
- 验收：空闲隐藏下拉；菜单恰好两项，↑/Enter触发queue、两项菜单分别触发steer/interrupt且每次仅提交一次；独立停止不发送且保草稿；IME/多图预处理/ACK前后草稿保护不回归；readonly、手动压缩、准备期与auto压缩组合逐项验证。增加浅/深主题、窄窗口/长模型名、浮层裁切/点击命中、Tooltip与键盘可达性验收。
- **已实施范围**：`Composer.tsx`、`ModelPicker.tsx`、`SendModeMenu.tsx`、菜单契约测试、中英文 i18n 与本 `docs/ui.md` 配方。↑与 Enter 默认 queue；菜单各自一次性 steer / interrupt；独立停止不发送草稿。菜单通过 Portal、`placeMenu` 视口夹紧，支持外部点击、Escape、方向键、Home/End、Tab 关闭和 Escape 焦点归还。图片预处理等待增加同步锁，并校验等待期间切会话不会改发另一份草稿。
- **验证证据**：桌面 typecheck、6实现文件 Biome 通过；相关6个测试文件122项通过（发送 ACK、同步防重、压缩门禁、菜单契约与字号守卫）；隔离 Electron 真实组件实测空闲/忙碌/只读状态、深色菜单两项与视口边界/点击命中、首项/方向键焦点与Escape归还、queue/steer/interrupt各单次、Enter默认queue、停止保非空草稿、手动压缩禁菜单/自动压缩放行、preparing占位、464px窄窗长模型名无横向溢出；延迟图片时切会话不发送新会话且保留原图片，同会话重复触发只提交一次完整带图信封。日志 `.local/tmp/composer-send/ui-final.log`，独立复核PASS。未执行真实模型、安装或实机IME；Cmd+Enter实际源码原有仅Ctrl判断，本次未扩展快捷键。全仓样式守护仍有LAN等既存命中，本次无新增硬编码字号/色值。
- MCP `fetch: MCP connection closed` 是独立连接问题，根因未核实；本条不承诺靠上游MCP同步解决，不授权修改MCP配置。

### 已确认交互待办：会话悬停预览卡（SESSION-HOVER-01）

用户确认采用 `D:/Project/Percho/功能/会话悬停详情功能/redesign-preview.html`（同副本 `.local/design/session-hover/design-demos/variant-c-minimal.html`，预览图 `D:/Project/Percho/功能/会话悬停详情功能/session-hover-final.png`）作为 `SessionHoverCard` 的定稿方案，要求记录下来，下次与其他功能一起开工。本轮仅记录，不修改生产代码。

**设计来源**：上述 HTML，本次写入 SHA-256 为 `d1456193d9dbb73fd73b935adb4418700439b959065baefc9411a6e0db15ab70`，完整规范见 `.local/design/session-hover/spec.md`。

| 层级 / 状态 | 展示与交互契约 |
| --- | --- |
| 浮层容器 | `w-[348px] rounded-xl bg-surface p-3.5 shadow-pop`；移除外框 `border-line`、内部卡片 `1px` 实线框与右上角 `×` 按钮；悬停移出自动消散 |
| 第 1 行：完整标题 + 复制 | `text-ui-13 font-medium text-ink` 完整换行展示；右上角幽灵复制图标钮（默认 `text-ink-faint`，复用 `components/ui/Tooltip`，废除原生 `title`） |
| 第 2 行：状态·模型·目录 | `○ 状态 · modelId · ~/缩写目录`（`text-ui-11 text-ink-faint` + `font-mono` 单行内联；未加载会话可在 `title-preview.ts` 读取首问时顺带提取最后 model） |
| 第 3 行：灰底首问胶囊 | `rounded-lg bg-surface-2 px-2 py-1.5`，左 `首问` 标签（`text-ui-11 text-ink-faint`），右单行摘要或缩写路径（`@…/父目录/文件名`，文件名 `text-ink-2 font-medium` 突出） |
| 关系区（默认收起态） | 上方 `.fade-rule` 分隔；若有父会话显示紧凑单行 `父会话 <标题> ↗`；子会话顶栏左侧展示全量角色统计胶囊（`● Oracle ×1` `● Verifier ×1` `● Fixer ×50`），右侧为 `全部 N ▾` 按钮；下方默认只展示最新 1 条子代理浅灰直达卡（`最新 Fixer <单行摘要> ↗`） |
| 关系区（点击 `全部 N ▾` 展开态） | 按钮变为 `收起 ▴`，下方展开为 24px 单行三列对齐列表（`[● Agent 64px | 单行摘要 truncate | ↗]`），滚动容器挂载 `useEdgeFade` + `.edge-fade`（`max-h-[144px]`），底部左侧保留 `显示更多 (剩余数) ▾` 分页加载 |
| 底部时间栏 | 左 `创建 YYYY/MM/DD HH:mm` · 右 `最后活动 MM/DD HH:mm`（展开态下时间居右与左侧 `显示更多` 同行，`text-ui-11 font-mono text-ink-faint`） |

- **后端全量角色统计扩展**：在 `packages/backend/src/session/hover-relations.ts`（`projectHoverRelations`）对 `valid` 全量有效子会话数组执行 `slice` 分页前，聚合产出 `roleCounts: Array<{ label: string; count: number; statusDot: ... }>` 并随 `SessionHoverRelations`（`packages/shared/src/session-hover.ts`）返回，零额外磁盘 I/O。
- **关联文件**：`packages/desktop/src/renderer/src/components/sidebar/SessionHoverCard.tsx`、`useSessionHoverPages.ts`、`packages/shared/src/session-hover.ts`、`packages/backend/src/session/hover-relations.ts`、`packages/backend/src/session/title-preview.ts`、`i18n/zh.ts` 与 `en.ts`。

### 跨阶段 Spike

只读审查通过后，未来实施首先做以下小实验，失败即停，不继续扩展：

1. 分屏：确认 `session-page-slide`、GC、权限 dock、UI 插件槽位在双 pane 下的作用域。
2. checkpoint：验证 `tool_execution_start` 位于 edit/write 实际写入之前；若不成立，按单项方案的备选路径重写设计。
3. 文件树：确认现有项目注册表能稳定给出 `projectId -> cwd`，并验证 Windows junction/symlink 的 realpath 边界。
4. 标题生成：只读确认当前 Pi SDK 可用的模型调用入口、失败回退和成本标识；不触发正式用户请求。
5. 终端：确认 node-pty/ConPTY 的 Electron 43、Windows 构建与退出清理可行性；不先安装依赖。

### P3 / P4：并行会话与文件只读闭环

实施顺序：

1. 分屏单项方案首批的 pane 作用域纯重构。
2. 分屏可见渲染、GC 保护、快照恢复和入口。
3. catalog P4 文件树：单目录懒加载、只读读取、统一打开路由、复用 Artifacts 预览。
4. B11 工具 diff 文件名到文件 surface 的跳转。
5. P6 checkpoint 只在 Spike 通过后进入采集，不与文件树混做一个提交。

阶段出口：能同时看两个会话，能从聊天/diff/文件树打开真实项目文件，产物预览不回归。P3 第一批仍必须是零行为变化的重构。

### P2 / P5 / P7：搜索、审阅与可见状态

1. P5 全局搜索按既有方案实施：本地标题/项目/文件首帧，后端正文有界扫描，明确截断；正文搜索与右侧打开依赖 P3。
2. P7 A2 会话行信息密度：先加入稳定、低成本的模型、相对时间、会话级 diff 汇总和分支摘要；分支字段缺失时不伪造。
3. P7 B2 Changes UI：逐文件 stage、生成提交文案、commit 状态和错误展示；保留既有 GitLens commit API。
4. P7 B6 quota indicator：只消费既有 `useQuota`，区分无订阅、网络错误、正常和 rate-limited。
5. P2 / P7 A6 OS 通知：系统通知主体随 P2 上游同步；P7 只处理点击回会话、聚焦/勿扰/去重等本地适配。

### P7 / P8：个人生产力

1. P7 命令注册表、命令面板、Ctrl/Cmd 适配和可改快捷键。
2. P7 Quick Composer 独立 BrowserWindow + globalShortcut，复用 draft 和发送链路。
3. P7 会话文件夹、过滤器、状态快照和持久化。
4. P7 模型生成标题：先手动入口，再 opt-in 自动生成；用户改名后锁定。
5. P8 文件树第二阶段 Monaco 编辑器、保存、dirty、外部修改冲突。

### P8：隔离与自动化

1. P8 worktree 预研通过后，按项目创建/绑定会话 worktree。
2. P8 Notes 与 `@note` 引用。
3. P8 文件范围 lease 和编排冲突串行化。
4. P8 持久定时任务、启动补偿、运行历史和权限门。

### P8：高风险能力

1. P8 终端 dock：PTY、resize、输出限流、权限与清理。
2. P8 operator：只做显式批准、可审计、有限 allowlist 的宿主操作；不直接开放任意 IPC。
3. 以上能力都必须独立评审，不因 MonoCode 有对应功能就自动进入开发；也不因 catalog 已编号而视为已批准。

## 五、功能实施契约与具体文件改动点

### 5.1 A2 会话行信息密度

**目标**：左栏一眼判断会话模型、最近活动、agent 本轮改动量和项目分支；不让 30px 行高变成拥挤仪表盘。

**数据策略**：

- 模型：复用 `SessionMeta.model` / `modelLabel`。
- 时间：复用 `createdAt` / `modifiedAt`，不使用文件 birthtime。
- diff：从已有 transcript 的 `deriveTurnChanges` 做当前会话聚合；未加载会话显示 `—`，不偷偷打开会话。
- 分支：先显示会话 fork/父子关系摘要；Git branch 必须通过项目级 `getGitBranch`/缓存取得，不能假定 `SessionMeta` 已有 branch。

**文件表**：

| 路径 | 变更 |
|---|---|
| `renderer/src/components/sidebar/SessionRow.tsx` | 增加第二信息层；保持 tooltip 和窄宽降级 |
| `renderer/src/components/sidebar/SessionHoverCard.tsx` | 复用现有 model/cwd/time，补 diff 与 fork 摘要 |
| `renderer/src/components/session/session-status.ts` | 统一工作中/审批/未读/完成 glyph，不新增色块 |
| `renderer/src/lib/session-summary.ts` | 新增纯函数，聚合 meta、turn changes、relation、branch snapshot |
| `shared/src/session.ts` | 仅在确有跨层需要时增加可选 summary DTO，不把运行态字段塞进 `SessionMeta` |
| `renderer/src/i18n/zh.ts`、`en.ts`、`docs/ui.md` | 文案和紧凑行规范 |

**风险**：旧行高和左栏宽度是硬约定；聚合 transcript 可能被 GC 卸载；Git 分支请求不能每行触发。解决：缓存、未加载占位、按项目批量请求。

**测试**：`lib/sidebar-groups.test.ts`、`components/session/session-status.test.ts`、新增 `session-summary.test.ts`；手工验证窄窗口、未加载、流式、分支为空。

### 5.2 A5 命令面板与可改快捷键

**目标**：统一注册命令、显示当前绑定、支持 Ctrl/Cmd 归一化和冲突检测；第一版不允许任意 JS 命令。

**核心 DTO**：

```ts
type CommandDefinition = {
  id: string;
  labelKey: string;
  category: string;
  defaultBinding?: string;
  availability?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => Promise<void> | void;
};
type KeybindingOverride = { commandId: string; binding: string | null };
```

**文件表**：

| 路径 | 变更 |
|---|---|
| `renderer/src/lib/commands.ts` | 命令闭集、上下文和执行器 |
| `renderer/src/lib/keybindings.ts` | 平台修饰键归一化、冲突检测、匹配 |
| `renderer/src/stores/keybindings.ts` | 读取/保存用户覆盖；默认值只读 |
| `renderer/src/components/command/CommandPalette.tsx` | 搜索、分组、键盘导航、Esc/focus restore |
| `renderer/src/components/settings/KeybindingsPage.tsx` | 搜索、重绑、恢复默认、冲突提示 |
| `packages/shared/src/ipc-channels.ts`、`desktop/src/main/ipc/ui-state.ts` | 只在现有 UI state 通道不够时增加 typed 持久化 |
| `renderer/src/App.tsx` | 单一全局监听入口，避免组件各自抢快捷键 |

**契约**：输入框编辑/IME 期间不抢快捷键；冲突时不保存；未知命令不执行；鼠标点击和快捷键走同一个 command id。

**风险**：现有局部 keydown 监听冲突；Windows/Linux Ctrl 文案；插件快捷键不一定可重绑。第一版只管理 Percho 内置命令，插件保留声明只读。

**测试**：纯函数平台归一化/冲突/优先级；CommandPalette 键盘导航；IME；设置持久化 round-trip；旧快捷键行为回归。

### 5.3 A6 桌面通知、未读、提醒

**现状修正**：未读 `unseenCompletion` 和声音提醒已有；计划只新增 OS notification 和持久提醒。

**文件表**：

| 路径 | 变更 |
|---|---|
| `packages/desktop/src/main/notifications.ts` | Electron Notification 适配、去重、点击回传 session id |
| `packages/shared/src/notifications.ts` | 通知类型、reason、dedupe key |
| `packages/shared/src/ipc-channels.ts`、`desktop/src/main/ipc/notifications.ts` | 通知偏好和 reminders typed channels |
| `renderer/src/stores/notifications.ts` | 聚焦、勿扰、已读和提醒状态 |
| `renderer/src/components/settings/NotificationsPage.tsx` | 完成/审批/声音/桌面/勿扰开关 |
| `renderer/src/components/session/SessionReminders.tsx` | 新增/编辑/取消提醒；不把 reminder 混成未读 |
| `backend/src/session/` 或 `desktop/src/main/` | 事件边沿接线，复用现有 `onEvent`/settled 判定 |

**时序**：agent settled/permission requested → 判断窗口是否聚焦、通知偏好、dedupe → OS 通知 → 点击发送 session target → renderer 激活会话。提醒使用 main 持久化时间戳，启动时补偿过期任务一次。

**风险**：Windows 通知权限、应用关闭、重复事件、声音插件重复提醒。必须与 voice-alerts 共享 reason/dedupe 语义。

**测试**：通知纯函数、dedupe、窗口聚焦分支、提醒过期补偿；真实 Windows 手工验收必做。

### 5.4 A7 Quick Composer

**目标**：全局快捷键唤起轻量输入窗，不复制主窗口，不在关闭主窗口时丢草稿。

**文件表**：

| 路径 | 变更 |
|---|---|
| `packages/desktop/src/main/quick-composer-window.ts` | BrowserWindow 创建、定位、复用/销毁、主窗关闭边界 |
| `packages/desktop/src/main/quick-composer-shortcut.ts` | globalShortcut 注册、冲突和失败提示 |
| `packages/desktop/src/renderer/quick-composer/` | 最小输入 UI，复用 draft/attachment 数据契约 |
| `packages/shared/src/ipc-channels.ts`、`desktop/src/main/ipc/quick-composer.ts` | 获取当前项目、提交、关闭、失败回传 |
| `renderer/src/stores/drafts.ts`、`components/composer/` | 抽共享发送准备逻辑，不复制发送 guard |
| `docs/ui.md`、i18n | 浮窗焦点、快捷键、reduced-motion 约定 |

**契约**：只能在已登记项目或 daily cwd 创建会话；无项目时显示选择/明确失败；提交走既有 `createSession`/`prompt`；globalShortcut 注册失败不吞错；快捷键配置进入 A5 后再开放改绑。

**风险**：多窗口 session ownership、主窗退出、全局快捷键被其他应用占用、Windows DPI/多屏定位。

**测试**：main window 生命周期 mock、shortcut register/unregister、草稿提交；手工多屏和主窗最小化验收。

### 5.5 A8 项目文件树、只读查看与内置编辑器

**产品边界**：ArtifactsDrawer 继续是 agent 本轮产物；新增 `ProjectExplorer` 管项目目录。两者共享打开协议，不合并成一个无限膨胀组件。

**只读阶段（catalog P4，进入本路线）**：

- 当前项目根目录、单目录懒加载；
- `projectId + relativePath` 读取项目内文本；
- HTML/SVG/图片/Markdown 复用安全预览；TS/JSON/MD 只读源码；
- 大文件、二进制、权限和外部修改提示；
- 聊天文件路径、Diff 文件名可统一跳转；
- 不写盘、不新建/删除/重命名。

**编辑器阶段（catalog P8，本路线只规划）**：Monaco、dirty、保存、外部修改冲突、保存前版本 hash、HTML 预览刷新。

**文件表**：

| 路径 | 变更 |
|---|---|
| `packages/shared/src/project-files.ts` | `ProjectFileNode`、read/list result、错误码、打开来源 |
| `packages/shared/src/ipc-channels.ts` | `listProjectDirectory`、`readProjectFile` typed channels |
| `packages/backend/src/project/files.ts` | 从全量列表扩展为按目录列举、读取、UTF-8/大小限制、realpath 边界校验 |
| `packages/desktop/src/main/ipc/project-files.ts` | handler 注册、错误映射、项目根解析 |
| `renderer/src/stores/workspace-files.ts` | 展开目录、当前文件、内容 hash、加载世代；不修改 `session-workspace` 语义 |
| `renderer/src/components/project/ProjectExplorer.tsx` | 树、懒加载、刷新、错误和选中态 |
| `renderer/src/components/project/FileViewer.tsx` | 只读源码、行号、截断/二进制空态 |
| `renderer/src/components/project/FileSurface.tsx` | 文件类型路由，接 Artifacts 预览而非复制 iframe 逻辑 |
| `renderer/src/components/artifacts/` | 增加“打开项目文件”输入适配；保留 transcript 产物路径 |
| `renderer/src/components/diff/`、聊天文件链接组件 | 统一 `openProjectFile` 跳转 |
| P8 `renderer/src/components/project/FileEditor.tsx` | Monaco、dirty、保存冲突；`monaco-editor` 已在 desktop 依赖中，但尚未接入本功能 |

**安全契约**：禁止前端传绝对路径；拒绝 `..`、盘符、UNC；realpath 后必须位于已登记项目根；符号链接/junction 越界拒绝；默认排除 `.git/node_modules/out/dist`；不把项目内容写入日志。

**测试**：backend 临时目录覆盖正常、穿越、绝对路径、UNC、symlink/junction、二进制、超大文件；renderer 覆盖懒加载、路由和错误；Windows 真机验证路径。

### 5.6 A1 分屏与 A3 checkpoint

这两项已有独立详细方案，本总路线只固定依赖和审查门：

- A1 必须先完成 pane 作用域纯重构，再接 UI；新增 `pinnedSessionIds`/visible set 保护 GC；`activeSessionId` 继续表示焦点会话。
- A3 必须先做 `tool_execution_start` 时序 spike；checkpoint 数据只快照 edit/write，bash 不入账；撤销要 after hash 校验和 journal 原子回滚。
- 两项都不能把会话 transcript、模型上下文和磁盘文件真值混为一体。

### 5.7 A4 全局搜索

沿用已有详细方案，但审查时确认：

- 当前仓库规模和会话目录预算仍以真实扫描为准；
- 结果要显示 scanned/total/truncated；
- 只搜 user/assistant 文本，不把工具输出和 base64 作为普通命中；
- `Ctrl/Cmd+K` 与 A5 命令注册表共享入口，不能各自注册全局监听；
- 搜索跳转到会话消息时，必须处理 GC 未加载和历史窗口补挂。

### 5.8 B1 会话 worktree

**定位**：高风险隔离能力，不能和普通 cwd 混用，也不能把第三方 Agent worktree 算作已实现。

**推荐契约**：

```ts
type SessionWorktree = {
  sessionId: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  state: 'creating' | 'ready' | 'dirty' | 'removing' | 'error';
};
```

**文件表**：`backend/src/project/worktrees.ts`、`shared/src/worktrees.ts`、`shared/src/ipc-channels.ts`、`desktop/src/main/ipc/worktrees.ts`、`renderer/src/stores/worktrees.ts`、设置/会话创建 UI、`GitLens.tsx`。

**流程**：确认 repo root → 创建唯一 branch/path → `git worktree add` → session cwd 指向 worktree → 运行结束按用户策略保留/清理；任何失败不得创建“看起来已隔离但实际仍写主仓”的会话。

**风险**：Windows 锁、磁盘泄漏、分支冲突、主仓与 worktree 的 GitLens 误判、会话移动/删除交叉。先只支持显式创建和手动清理，不做自动删除。

**测试**：临时 git repo、非 git 目录拒绝、重复 branch、创建中断清理、cwd 归属、重启恢复；人工验收后才考虑默认开关。

### 5.9 B2 Changes 与生成提交文案

**现状**：`gitCommit` 已存在，GitLens 当前主要传 `stage: "all"`。本计划只做增量。

**文件表**：`renderer/src/components/git-lens/GitLens.tsx`、新增 `components/git-lens/ChangesView.tsx`、`stores/git-changes.ts`、`shared/src/git.ts`、新增 `git:generateCommitMessage` channel 与 backend handler、i18n。

**契约**：

- 文件选择只允许传 repo-relative path，沿用 `requireRepoPath`；
- 未选文件不得调用 commit；
- 生成文案默认只读 diff，不自动提交、不自动 stage；
- 模型调用失败保留用户输入；
- amend 必须二次确认；
- stage all/tracked/path array 继续复用现有 `gitCommit`。

**风险**：模型费用/隐私、超大 diff、生成文案不符合项目提交规范。先做截断和显式生成按钮。

### 5.10 B3 文件夹与状态过滤

**推荐模型**：文件夹是持久化用户组织，状态是运行时派生过滤，二者不写进 `SessionMeta`。

**文件表**：`shared/src/session-groups.ts`、`desktop/src/main/session-groups-store.ts`、`shared/src/ipc-channels.ts`、`renderer/src/stores/session-groups.ts`、`components/sidebar/SessionGroupMenu.tsx`、`lib/sidebar-groups.ts`。

**状态来源**：运行中/审批/未读从 transcript + backend snapshot；历史未加载会话使用持久化事件摘要或安全的 `lastStatus`，不能一律 idle。

**契约**：删除文件夹不删会话；会话可在多个筛选视图但只归属一个文件夹；状态过滤无结果显示空态；文件夹数据损坏时回退空配置，不影响会话。

**风险**：GC、重启、子代理会话过滤和状态过期。首版不支持复杂规则表达式和批量操作。

### 5.11 B4 Notes

**推荐模型**：用户级 Markdown notes，按安全 slug 存在 `userData/percho/notes/`；renderer 只通过 IPC 读写，不直接访问文件系统。

**文件表**：`backend/src/notes/`、`shared/src/notes.ts`、`shared/src/ipc-channels.ts`、`desktop/src/main/ipc/notes.ts`、`renderer/src/stores/notes.ts`、`components/notes/NotesPanel.tsx`、composer `@note` 补全。

**契约**：路径不能由用户直接拼接；note id 与文件名分离；保存使用原子写；删除有确认；发送时只注入 `@note` 路径引用，不把全文自动塞进上下文；未找到 note 明确提示。

**风险**：敏感内容、并发编辑、Markdown 预览 XSS、note 与项目 cwd 的关系。首版不做云同步和协作编辑。

### 5.12 B5 模型生成标题

**当前事实**：`backend/src/session/naming.ts:autoNameSession` 是首条用户文本命名；`setSessionName` 已有。

**推荐策略**：先提供手动“生成标题”，验证成本和质量后再加用户级 opt-in 自动命名；用户手动改名后设置 `nameLocked`，自动结果不得覆盖。

**文件表**：`backend/src/session/naming.ts`、`shared/src/session.ts`（可选状态）、`shared/src/ipc-channels.ts`、`desktop/src/main/ipc/sessions.ts`、`renderer/src/components/sidebar/SessionMenu.tsx`、`stores/projects.ts`、i18n。

**流程**：取首轮有限文本 → 明确选择模型/预算 → 结构化返回 ≤ 40 字标题 → 校验空值/敏感信息/重复 → `setSessionName`；失败保留旧标题。

**前置门**：先核对当前 SDK 的模型调用入口和权限/计费链，未核实前不得写具体 import 或假设存在 `completeSimple`。

### 5.13 B6 额度提示

**现状**：`makeQuotaService`、`getQuota`、`useQuota` 已有；缺消费 UI。

**文件表**：新增 `renderer/src/components/quota/QuotaIndicator.tsx`、`QuotaPopover.tsx`，接 `Composer` 或顶栏；`settings/GeneralPanel.tsx` 增刷新/隐私说明；i18n 和 quota 测试。

**契约**：`null` = 无订阅/无 key，不显示错误红点；`error` = 获取失败，允许手动重试；窗口按 rolling/weekly/monthly 显示最高风险窗口；不把额度和上下文 `ContextRing` 混成一个百分比。

**风险**：网络/隐私、额度 API 变化、刷新频率。复用既有 5 分钟 TTL，不在 renderer 直连网络。

### 5.14 B7 终端 dock

**定位**：独立高风险项目，不进入前四批。

**推荐契约**：main 持有 PTY，renderer 只持 session id 和输出窗口；`terminal:start/write/resize/stop` invoke + `terminal:data/exit` subscription；cwd 必须来自已登记项目或会话 worktree。

**目标文件**：`desktop/src/main/terminal/`、`desktop/src/main/ipc/terminal.ts`、`shared/src/terminal.ts`/`ipc-channels.ts`、`renderer/src/components/terminal/TerminalDock.tsx`、依赖与构建配置。

**硬门**：先验证 node-pty/ConPTY 与 Electron 43 Windows 构建；输出限流、最大缓冲、退出清理、权限和主窗关闭必须有测试。不得用 `child_process.exec` 拼一个伪终端。

### 5.15 B8 operator 宿主操作

**定位**：不是把任意 UI 控制权交给 agent。只规划最小、可审计的命令闭集：启动会话、读取会话摘要、发送消息、写 note、创建 worktree（全部显式权限）。

**目标文件**：`shared/src/operator.ts`、`shared/src/ipc-channels.ts`、`backend/src/tools/operator/`、`desktop/src/main/ipc/operator.ts`、`renderer/src/stores/operator-audit.ts`。

**契约**：每次命令带 request id、来源 session、用户确认策略和审计记录；拒绝任意路径、任意 IPC channel、任意脚本；失败不重试副作用命令。

**风险**：权限绕过、递归编排、UI 竞态、外部执行器边界。必须先做威胁建模和最小命令集评审。

### 5.16 B9 编排文件冲突串行化

**推荐模型**：任务计划先声明 `readPaths/writePaths`，调度器按规范化 repo-relative path 做读写冲突判断；重叠写集串行，不重叠才并行。不能只靠 channel 消息提醒。

**目标文件**：`shared/src/orchestration.ts`、`backend/src/tools/orchestration/`、`backend/src/tools/file-leases.ts`、`renderer/src/components/orchestration/PlanReview.tsx`、测试。

**契约**：lease 有 owner、task id、createdAt、expiry；进程崩溃可回收；获得 lease 前不启动写任务；拒绝时显示冲突文件；调度状态可恢复但不自动重复副作用任务。

**风险**：路径别名、symlink、bash 绕过、跨进程锁原子性。首版只管声明的 edit/write，明示 bash 不受控。

### 5.17 B10 定时/周期任务

**推荐模型**：main 持久化任务定义和运行历史，Electron 启动补偿；触发后走既有 session/prompt/permission 链，不绕过信任。

**目标文件**：`desktop/src/main/scheduler/`、`shared/src/scheduler.ts`、`shared/src/ipc-channels.ts`、`renderer/src/stores/scheduler.ts`、`components/settings/AutomationsPage.tsx`。

**契约**：任务包含 id、schedule、cwd/session target、prompt、enabled、lastRun、nextRun；只允许已登记 cwd；退出期间错过的任务默认只补跑一次并标记原因；运行中不重复；用户可停用/查看历史。

**风险**：Electron 退出、时区/DST、权限弹窗、重复发送、敏感 prompt 落盘。首版不做任意脚本 cron 和远程调度。

### 5.18 B11 工具 diff 内嵌聊天流

**目标**：工具卡内显示可折叠 diff 摘要，点击文件/行号走统一 `openProjectFile` 或 DiffSidebar；不复制第二份 diff parser。

**目标文件**：`components/chat/ToolCallCard.tsx`（以当前实际组件为准）、`components/diff/`、`shared/src/transcript/turn-files.ts`、文件打开路由。

**契约**：工具失败不显示成功 diff；大 diff 折叠和有界渲染；路径解析失败只显示文本；当前磁盘变化时不要声称内容仍一致。

## 六、跨功能测试与验证契约

### 6.1 最窄命令

```bash
npm run typecheck
npm run test
npm run lint
npm test -w @percho/backend -- <test-path>
npm test -w @percho/desktop -- <test-path>
```

具体功能实施时优先执行包级 Vitest 文件，不把全量通过替代人工验收。当前仓库的 `package.json` 事实是 backend/desktop 使用 `vitest run`，shared 主要依靠 typecheck。

### 6.2 必须有的负向验证

- 文件树：穿越、绝对路径、UNC、junction/symlink 越界、超大文件、二进制。
- 分屏：次 pane 会话不被 GC 卸载、关闭/恢复/迟到结果不抢焦点。
- checkpoint：外部改动拒绝撤销、journal 中断完整回滚、bash 边界明示。
- 搜索：时间/文件上限显示截断、读失败跳过、旧请求结果丢弃。
- worktree：非 git 目录、创建中断、分支冲突、清理失败。
- operator/scheduler：权限拒绝、重复 request、关闭重启、过期任务。
- 通知：已聚焦/勿扰/重复事件/点击回会话。

### 6.3 UI 验收

所有 renderer 改动必须遵守 `docs/ui.md`：

- 字号只用 `text-ui-*`；颜色只用语义 token；浮层用阴影分层；
- 双语 i18n；reduced-motion；pointercancel/lostpointercapture；
- 不新增卡片套卡片和大面积色块；
- 用 CDP/真实窗口验收布局、溢出、焦点、键盘和点击命中；
- UI 插件槽位逐项决定是全局一次还是按 pane 实例化。

## 七、受影响文件总表与实施边界

| 阶段 | 主要模块 | 预计核心文件 | 依赖/停止条件 |
|---|---|---|---|
| 0 | Spike/审查 | SDK 事件、项目根、PTY、标题调用入口 | 任一关键事实不成立就停，不写大功能 |
| 1 | 分屏 | `shared/panes.ts`、`renderer/stores/panes.ts`、`SessionPane.tsx`、`session-gc.ts`、`App.tsx` | pane 作用域与 GC 测试先绿 |
| 1.5 | 文件树 | `shared/project-files.ts`、`backend/project/files.ts`、`main/ipc/project-files.ts`、`ProjectExplorer.tsx`、`FileViewer.tsx` | 路径安全和读取测试先绿 |
| 1.5 | checkpoint | `backend/tools/checkpoint/*`、`shared/checkpoints.ts`、`DiffSidebar.tsx` | 时序 spike 通过 |
| 2 | 搜索/审阅/额度/通知 | `renderer/search/*`、`backend/search/*`、`GitLens.tsx`、`quota/*`、`main/notifications.ts` | 不得重复 IPC/全局 keydown |
| 3 | 快捷键/Quick Composer/文件夹/标题/编辑器 | `lib/commands.ts`、`keybindings.ts`、main quick composer、session groups、FileEditor | 命令注册表和状态归属先定 |
| 4 | worktree/notes/调度/冲突 | backend/main scheduler/worktree/notes/orchestration | 安全、恢复和回滚测试先绿 |
| 5 | terminal/operator | main terminal/operator、shared DTO、renderer dock | 独立安全评审和 Windows 手工验收 |

## 八、实施状态机与审查门

未来每个功能按以下状态迁移，未获用户明确授权不得进入 Implementing：

```text
Proposed
  → Reviewed（范围、事实、文件、风险已确认）
  → Approved（用户明确回复“批准执行/按方案实施/确认开始”）
  → Implementing（按阶段内可独立验收的小步执行，阶段间停手）
  → Verified（自动测试、运行环境、人工场景分别有证据）
  → Accepted / Deferred / Rejected
```

阶段停手条件：

- 文件路径或 SDK 符号与当前工作树不一致；
- Spike 失败且备选方案未获确认；
- 安全/权限契约无法 fail-closed；
- 测试无法证明跨会话、跨重启或 Windows 路径行为；
- 发现需求已经扩展为 IDE、远程平台或多 provider 产品。

## 九、验收清单

### 方案审查

- [ ] 用户确认从 catalog 的哪个阶段开始批准实施。
- [ ] 已迁入仓库 `docs/` 的单项方案链接、状态与事实基线一致。
- [ ] 确认文件树首版归 P4，且明确只读不编辑。
- [ ] 确认是否暂缓 B7/B8 高风险能力，不因竞品存在而直接开工。
- [ ] 确认 UI 插件、LAN、Pi CLI 共享数据和 HANDOVER 边界继续有效。

### 实施前

- [ ] 执行对应阶段要求的 Spike 并记录 `Passed/Inspected/Not run`。
- [ ] 为目标阶段建立独立实施分支或 worktree（如触及 renderer 多文件）。
- [ ] 先写 RED 测试，再写最小实现；不把长计划清单当作验收证据。
- [ ] 每个阶段更新对应 PLAN 状态，不在未验证时标“已完成”。

### 明确不做

- [ ] 当前会话不修改任何 `packages/*` 源码。
- [ ] 当前会话不安装依赖、不改配置、不切执行器、不提交 Git。
- [ ] 当前会话不把外部 AgentTeam 方法论文档当作 Percho 功能已实现证明。

## 十、审查结论模板

```markdown
## 评审结论

- 结论：批准 / 有条件批准 / 退回补充 / 暂缓
- 允许进入的阶段：
- 暂缓的阶段：
- 必须先补的事实：
- 必须先通过的 Spike：
- 允许修改的范围：
- 明确禁止修改的范围：
```

**本文只提供契约细节；是否进入某阶段、先做哪一项，以 `docs/PLAN-percho-feature-catalog.md` 的 P0-P8 为准。**
