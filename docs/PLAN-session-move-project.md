---
类型: 技术方案
状态: 方案已定稿待批准
创建: 2026-11-05
更新: 2026-11-05
适用: Percho（32sny/percho）— 会话跨项目移动功能
---

# 会话跨项目移动 + 会话拖入输入栏：左栏右键「移动到项目…」与会话胶囊引用

> **创建日期**：2026-11-05
> **状态**：方案已定稿待批准
> **关联版本**：v0.7.x（下一功能版本）
> **任务真源**：用户需求——① 把 test 项目里的 0922 会话移到 Percho 项目，做成界面功能；② 把历史会话拖入输入栏生成胶囊，让当前会话了解之前的信息（保留右键复制诊断）

## 〇、需求 ②：会话拖入输入栏生成胶囊（2026-11-05 补充）

**交互**：左栏会话行可拖拽 → 拖到输入栏松手 → 出现会话胶囊（与 MD/图片胶囊同区）→ 发送时以 `@路径` 注入，agent 按需读取，**惰性加载不撑上下文**。右键「复制诊断信息」保留不动。

**胶囊内容选型（已定）**：
- **方案 B（采纳）**：drop 时后端把会话转成**可读 Markdown 转录**写到临时文件（角色前缀 + 正文，工具调用一行带过，超长截断并标注），胶囊挂该 md 路径。数据源复用 `peekSessionMessages`（未打开会话零副作用纯解析）。优点：agent 读到的干净、token 省、不含 base64 噪音。
- 方案 A（否决）：直接 `@jsonl 原文件`。零后端改动，但 jsonl 含工具输出/base64/元数据，脏且可能巨大。

**机制要点**：
- 拖拽数据：会话行 `draggable` + `dataTransfer.setData("application/x-percho-session", JSON.stringify({sessionId, sessionFile, name}))`；
- Composer 的 window 级 drop 处理增branch：识别该 MIME → 调后端 `exportSessionTranscript` 拿临时 md 路径 → 走既有 `appendAttachments`（胶囊 UI、发送拼 `@路径` 全复用，AttachmentChip 零改动）；
- 活跃/未打开会话都支持（peek 已兼容两态）；0 消息会话无文件，拖拽置灰。

**新增接口**：

```ts
// packages/shared/src/ipc-channels.ts
exportSessionTranscript: ch("session:exportTranscript")<
  { sessionId: string; sessionFile?: string; cwd?: string },
  { path: string } // 临时 md 路径（os.tmpdir()/percho-transcripts/<sessionId>-<名称>.md）
>();
```

**后端契约**：活跃会话走 registry，未打开走 `readSessionMessagesFromContent`（同 peek）；转录格式：`## 用户` / `## 助手` 分节，工具调用一行摘要，单条消息超 2000 字截断加注；同 session 重复拖拽覆盖同名临时文件。

## 一、目标与阶段边界

**核心目标**：在左侧栏会话行的右键菜单新增「移动到项目…」：弹出目标项目选择对话框，确认后把该会话的 `.jsonl` 文件搬到目标项目的会话目录、改写文件头 `cwd`，左栏列表即时归位到新项目分组。

**交付契约**：
- 移动后 `SessionMeta.cwd` / `sessionFile` 指向新位置，sessionId 不变（置顶、权限模式、工作区、子代理箭头等按 sessionId 记录的状态全部无损保留）；
- 移动后重新打开会话，agent 在**新项目目录**下干活（加载新项目的 AGENTS.md / 信任 / 权限）；
- 失败 fail-closed：文件缺失、目标目录无效、流式进行中 → 报错且**不产生半搬状态**。

**非目标（Out of Scope）**：
- 顶栏会话胶囊右键菜单不加移动项（左栏先行，后续可复用同一 actions 扩展）；
- 不做批量移动、不做拖拽移动（**左栏行拖入输入栏是需求②，与移动无关**）；
- 不改 pi SDK（`@earendil-works/pi-coding-agent` 为外部依赖）；
- 0 消息会话（尚无磁盘文件）不支持移动（菜单项置灰不弹）。

## 〇·二、需求 ② 受影响文件（并入第五节总表）

## 二、现有实现定位

### 2.1 可复用能力

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 会话即文件范式 | `packages/backend/src/pi-backend.ts` `deleteSession`（L876） | pi 无删除 API，直接操作磁盘 jsonl；移动同理，且已有「活跃会话先 dispose」的成熟路径 |
| 目标目录计算 | SDK `getDefaultSessionDir(cwd)`（已从 `@earendil-works/pi-coding-agent` 导出） | 由 cwd 得到编码目录名（如 `--C--Users-Administrator-Desktop-Percho--`） |
| 文件头 cwd 读取 | SDK `SessionManager.open(path)` 无 override 时读 header cwd；`openSessionOnce`（L569）以 `sessionManager.getCwd()` 决定恢复后的工作目录 | **只需改写文件头首行的 `cwd` 字段**，恢复行为即正确 |
| 右键菜单框架 | `renderer/src/components/sidebar/SessionMenu.tsx` + 共享 `components/session/session-menu.tsx` `sessionMenuItems` | 菜单→气泡→确认对话框三层状态机现成，加一项即可 |
| 确认对话框 | `renderer/src/components/ui/ConfirmDialog.tsx`、`ContextMenu.tsx` | ContextMenu 不支持子菜单（已核实），故目标选择用独立对话框 |
| 项目清单 | `renderer/src/stores/projects.ts` `deriveProjects`（L247） | 从 `allSessions` + `addedProjects` 派生 `ProjectEntry[]`（cwd/name/sessionCount），对话框数据源直接用 |
| IPC 通道范式 | `packages/shared/src/ipc-channels.ts` `ch("session:xxx")` + `main/ipc/sessions.ts` 转发 | 加一条通道三处接线即可 |
| 活跃/流式判定 | `pi-backend.ts` L754、L1210 `entry.session.isStreaming` | 移动前的安全闸 |

### 2.2 不能直接复用/需重构的部分

- **无现成 move API**：SDK 的 `SessionManager` 没有 move/rename；文件头 `cwd` 改写需自行实现（读首行 JSON → 改 `cwd` → 原子写回）。
- **活跃会话的文件句柄**：Windows 下运行中会话持有 jsonl 句柄，直接 move 会 EBUSY；必须先 dispose（复用 `disposeSession`，L810）。
- **`deleteSession` 的强制删除语义不可照搬**：删除绕开了 `isStreaming` 拒绝（L880 注释），但移动是可逆操作、不应掐掉正在跑的一轮——流式中须**拒绝**而非强拆。

## 三、架构决策

**决策 1：移动 = 「文件搬家 + 头部 cwd 改写」单后端方法**（而非 fork/复制）。fork 会生成新 sessionId、丢置顶等状态；移动必须保 id。选磁盘直操作，与 deleteSession 同范式。

**决策 2：活跃会话先关后搬，搬完自动重开**。若会话在顶栏打开中：流式中拒绝；空闲则 dispose → 搬 → renderer 用新 meta 走既有 `openSession` 重开（标签页无感归位）。备选「直接拒绝要求手动关」被否：多一步无意义操作。

**决策 3：UI 入口 = 左栏右键菜单项 + 独立项目选择对话框**。ContextMenu 无子菜单能力（已核实），对话框列出可选项目（排除当前项目与 daily 目录），点选即执行，无需二次确认（非危险操作）。

**核心接口定义**：

```ts
// packages/shared/src/ipc-channels.ts
moveSession: ch("session:move")<
  { sessionId: string; sessionFile?: string; targetCwd: string },
  SessionMeta // 返回移动后的 meta（cwd/sessionFile 已更新）
>();
```

```ts
// packages/backend/src/pi-backend.ts
async moveSession(sessionId: string, targetCwd: string, sessionFile?: string): Promise<SessionMeta>
```

**后端执行契约（fail-closed）**：
1. 活跃会话：`isStreaming || isCompacting` → throw（不中断运行）；否则 `disposeSession`；
2. 解析源文件（`sessionFile` 参数优先，同 deleteSession），不存在 → throw；
3. 校验 `targetCwd` 是存在的目录 → 否则 throw；
4. 读文件按行拆分，首行须为 `type:"session"` → 改其 `cwd` 字段为 targetCwd（其余行不动）；
5. 目标目录 `getDefaultSessionDir(targetCwd)`，`mkdirSync recursive`；同名文件已存在 → throw（不覆盖）；
6. 原子落盘：写 `<目标>/<原名>.tmp` → `renameSync` 到目标名 → 删源文件（rename 跨设备失败时降级 copy+verify+delete；同盘下不触发）；
7. 任一步失败即抛错，源文件保证未动（第 6 步前源文件只读不写）。

## 四、执行状态机 / 核心业务时序

```text
renderer: 右键 → 「移动到项目…」 → MoveSessionDialog 选目标 → projectsStore.moveSession()
  → ipc moveSession
    backend:
      1. registry 查活跃 → streaming? 拒绝 : dispose
      2. 定位源 jsonl → 改写首行 cwd（内存中完成）
      3. mkdir 目标编码目录 → tmp 写入 → rename 落位 → 删源
      4. 返回新 SessionMeta
  renderer:
    5. 更新 allSessions 中该条（cwd/sessionFile 替换）
    6. 若会话原本在顶栏打开 → closeSession（已在后端 dispose，走既有对账）→ openSession(newMeta) 重开
    7. deriveProjects 重算 → 左栏分组自动归位
```

回滚：第 6 步 rename 失败时源文件仍在原位（tmp 残留清理），UI 报错即可；sessionId 不变，无状态残留。

## 五、受影响文件与变更策略

| 模块 | 目标文件 | 变更类型 | 核心策略 |
| --- | --- | --- | --- |
| IPC 通道 | `packages/shared/src/ipc-channels.ts` | 修改 | 新增 `moveSession` 通道定义 |
| 后端 | `packages/backend/src/pi-backend.ts` | 修改 | 新增 `moveSession` 方法（约 60 行，含头部改写工具函数） |
| IPC 转发 | `packages/desktop/src/main/ipc/sessions.ts` | 修改 | 注册 `session:move` → `backend.moveSession` |
| 菜单项 | `packages/desktop/src/renderer/src/components/session/session-menu.tsx` | 修改 | `sessionMenuItems` 增加可选 `onMove`，项位：改名/置顶之后、删除之前 |
| 菜单状态机 | `packages/desktop/src/renderer/src/components/sidebar/SessionMenu.tsx` | 修改 | 新增 `moving` 状态 + 挂 `MoveSessionDialog` |
| 选择对话框 | `packages/desktop/src/renderer/src/components/session/MoveSessionDialog.tsx` | 新增 | 项目列表（`deriveProjects` 过滤当前 cwd 与 daily），点选执行 |
| store | `packages/desktop/src/renderer/src/stores/projects.ts` | 修改 | 新增 `moveSession(session, targetCwd)` action（第四章 5-7 步） |
| i18n | `packages/desktop/src/renderer/src/i18n.ts` | 修改 | `sessionMenu.move*` 中英文案 |
| 转录导出 | `packages/backend/src/pi-backend.ts` | 修改 | 新增 `exportSessionTranscript`（复用 peek 解析，写临时 md） |
| 转录通道 | `packages/shared/src/ipc-channels.ts` | 修改 | 新增 `exportSessionTranscript` 通道；`main/ipc/sessions.ts` 加转发 |
| 行拖拽 | `packages/desktop/src/renderer/src/components/sidebar/SidebarSessionList.tsx`（及行组件） | 修改 | 会话行 `draggable` + dragstart 写自定义 MIME；0 消息会话 dragstart 阻止 |
| 拖放接线 | `packages/desktop/src/renderer/src/components/composer/Composer.tsx` | 修改 | window drop 处理识别 `application/x-percho-session` → 转录 → `appendAttachments` |

## 六、测试设计与验证（TDD 契约）

**最窄命令**：`npm test -w @percho/backend -- moveSession`；renderer 侧 `npm test -w desktop -- projects`（沿用现有 vitest 布局）。

**RED 阶段预期失败断言**（backend 新测试文件，仿 deleteSession 既有测试风格）：
1. 移动后目标目录出现同名 jsonl、源文件消失、首行 `cwd === targetCwd`；
2. 源文件不存在 → reject；
3. `targetCwd` 不存在 → reject 且源文件原封不动；
4. 流式中的活跃会话 → reject；
5. 目标同名文件已存在 → reject 不覆盖。

**GREEN 验收**（手工 + store 单测）：
- 左栏 test 项目 0922 会话右键 → 移动到 Percho → 列表即时归位；重开会话后 `pwd` 类操作落在 Percho 目录、加载 Percho 的 AGENTS.md；
- 置顶/改名人状态保留；移动打开中的会话，标签页无感切换到新项目。

**需求 ② 测试**：
- backend RED：`exportSessionTranscript` 对未打开会话返回存在的临时 md，内容含用户/助手分节；不存在 sessionId → reject；
- renderer：drop 事件带自定义 MIME → attachments 增加 md 路径（仿 `drop-files.test.ts`）；无该 MIME 的拖放行为不变；
- 手工验收：拖 0922 会话入输入栏 → 出现胶囊 → 发送「总结这个会话做了什么」→ agent 读转录文件给出正确总结；右键「复制诊断信息」不受影响。

## 七、实施步骤与验收清单（Checklist）

- [x] 1. shared：新增 `moveSession` IPC 通道
- [x] 2. backend：`moveSession` 方法 + 头部 cwd 改写工具函数（先写 RED 测试再实现）
- [x] 3. main：`sessions.ts` 注册转发
- [x] 4. renderer：`session-menu.tsx` 加菜单项（`onMove` 可选参数）
- [x] 5. renderer：`MoveSessionDialog.tsx` 新组件
- [x] 6. renderer：`projects.ts` store `moveSession` action（含打开中会话的关+重开）
- [x] 7. renderer：`SessionMenu.tsx` 接线 + i18n 文案
- [x] 8. 跑测试 + 手工验收第六节 GREEN 两条（自动化验证通过；真实会话拖拽/移动待用户界面验收）
- [x] 9. 需求②：backend `exportSessionTranscript` + IPC 通道与转发（先写 RED 测试）
- [x] 10. 需求②：会话行 draggable + Composer drop 接线（含 0 消息会话置灰）
- [x] 11. 需求②：手工验收拖拽胶囊 + 更新 `docs/INDEX.md` 索引
