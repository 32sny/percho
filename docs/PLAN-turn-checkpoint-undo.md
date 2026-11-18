---
类型: 技术方案
状态: 方案已定稿待批准
创建: 2026-10-31
更新: 2026-11-12
适用: Percho — 按轮次撤销 agent 改动的文件（turn checkpoint / undo）
---

# 按轮次撤销文件改动：把「能看 diff」补成「能退回去」

> **创建日期**：2026-10-31
> **状态**：方案已定稿待批准
> **关联版本**：v0.7.x（下一功能版本）
> **任务真源**：竞品分析结论——Percho 的 `DiffSidebar` / `TurnDiffChip` 只解决「看得到 agent 改了什么」，没有「一键退回这一轮之前」；MonoCode 每轮带 checkpoint，聊天流末尾直接给 `Undo All / Keep All`，且带 `undoable` 判定（外部改过的文件不许回退）

---

## 一、目标与阶段边界

### 1.1 交付契约

1. **每一轮（turn）结束即可撤销该轮对文件造成的改动**：`DiffSidebar` 每轮分组头出现「撤销本轮」幽灵按钮。
2. **撤销是原子的**：整轮要么全部回退，要么完全不动。任一文件不可安全回退 → 整轮拒绝并给出逐文件原因。
3. **不许覆盖用户在 agent 之外做的修改**：撤销前校验磁盘当前内容与该轮结束时的内容一致；不一致 = 不可撤销（fail-closed）。
4. **撤销不碰对话**：transcript、消息、轮次统计照旧；与既有「撤回消息（回退对话）」是两个动作，文案必须区分。
5. **保留策略可控**：默认保留最近 20 轮且不超过 7 天；被裁剪的轮显示「已过保留期」。

### 1.2 非目标（Out of Scope）

- **不追踪 bash 造成的文件改动**。`bash` 里跑 `rm`/`sed`/`git checkout` 不入账。首版只在 UI 明示这一点，不做 shell 级沙箱或全仓库快照。
- 不做 hunk 级（部分行）接受/拒绝 —— 只做整轮。
- 不做「跨会话回滚」或「回滚到任意历史时刻」（MonoCode 的 checkpoint 也只到轮级）。
- 不做自动提交 / 自动 stash / 与 git 工作区联动（`GitLens` 保持只读）。
- 不做远端（LAN/手机端）触发撤销。

---

## 二、现有实现定位

### 2.1 可复用能力（已核实存在）

| 能力 | 位置 | 复用方式 |
|---|---|---|
| 轮次边界的**唯一口径**（user 消息为界） | `packages/shared/src/transcript/turn-files.ts` `deriveTurnChanges` | 后端也 `import` 同一纯函数/同规则，保证前后端 turnIndex 不会漂移 |
| 每轮文件清单 + 每段 patch（edit 的 SDK `details.patch`、write 的 `args.content`） | 同上 `TurnFileChange` / `DiffSection` | 作为「这一轮动了哪些文件」的**声明来源**；实际磁盘状态另取（见 D2） |
| 内联扩展注册模式（`pi.on("tool_execution_start"/"tool_execution_end")`） | `packages/backend/src/tools/subagent-relations.ts` `makeSubagentRelationsExtension()` | 完全照抄这个骨架新建 checkpoint 扩展；注册点在 `pi-backend.ts:470` 的 `factories` 数组 |
| 已有的 end 事件处理与 `ctx.sessionManager` 取会话分支 | 同上 + `tools/todo-reminder.ts` | 取 `ctx.sessionManager.getSessionId()/getSessionFile()/getBranch()` |
| 会话目录 / agent 目录 | `getAgentDir()`（见 `antigravity-prewarm.ts:39`）、`session/session-paths.ts` | checkpoint 数据落 `<agentDir>/percho/checkpoints/` |
| 路径逃逸校验 | `session/session-paths.ts` `isSessionPathDescendant` | 拒绝 cwd 之外的目标路径 |
| diff 渲染 | `components/diff/DiffFileCard.tsx`、`DiffSidebar.tsx` | 只加按钮与状态标签，不改渲染内核 |
| fail-closed 的既有先例 | `composer/send-guard.ts`、`session/stream-guard.ts` | 沿用同样的「宁可拒绝也不半途」纪律 |

### 2.2 不能直接复用 / 需打破的旧假设

1. **现有 diff 全部来自 transcript，不是磁盘**。`deriveTurnChanges` 只读工具调用的 `args`/`diff`，所以它表达的是「agent 声称它写了什么」。撤销必须引入**真实磁盘前后镜像**，这是本方案的核心新增物。
2. **后端当前没有「文件写入前」的快照点**。`subagent-relations.ts` 证明 `tool_execution_start` 可以订阅，但**事件与工具真正执行之间的先后顺序必须实测确认**（见 §八 风险 R1 与 §七 的一次性 spike）。
3. **`write` 工具没有改前内容**：`args.content` 是全文新内容，删除/覆盖前的旧内容只能靠快照拿，无法从参数反推。
4. **会话可被 GC 卸载**：撤销请求必须能作用于「当前不在内存里」的会话（直接从磁盘快照 + 磁盘文件操作），不能依赖活跃会话对象。
5. **`DiffSidebar` 的内容在撤销后不会自动变**（transcript 不变）。需要一份「已撤销轮次」的旁路状态给 UI 打标，否则用户会看到「撤销了但侧栏还显示改动」的错乱。

---

## 三、架构决策

### D1：用「内容寻址的 blob 快照」，不用 shadow git 仓库

候选对比：

| 方案 | 成本 | 缺点 |
|---|---|---|
| A. 会话绑定 shadow git 仓库（`--git-dir` 指到状态目录、`--work-tree` 指项目） | 中 | 大仓库首次 `git add -A` 极慢；会与用户自己的 git 操作竞争 index 锁；Windows 上 `.git` 目录权限/杀软扫描问题多 |
| B. **只快照 edit/write 触及的文件（内容寻址 blob）** | 低 | 覆盖面受限于两个工具（已在 §1.2 明示） |
| C. 全项目目录 copy-on-write 快照 | 高 | 磁盘爆炸、跨平台无稳定 API |

**采纳 B**。理由：覆盖面正好等于 Percho 现有 diff 的覆盖面（`FILE_TOOL_NAMES = {edit, write}`），不改变用户对「diff 显示什么」的心智；实现小、可测、Windows 友好。

### D2：双来源 —— 声明来自 transcript，真值来自磁盘

- **哪些文件属于这一轮**：沿用 `deriveTurnChanges` 的口径（前端展示与后端判定必须一致）。
- **能不能撤销**：只看磁盘真值 —— 当前 hash vs 该轮记录下来的 after hash。
- 二者不一致（例如 agent 声称改了但工具最终失败）→ 该文件从 checkpoint 里剔除，不算错误。

### D3：数据布局（内容寻址 + per-session manifest）

```
<agentDir>/percho/checkpoints/
  <sessionPathKey>/                 # 用 backendSessionPathKey(sessionFile) 做键，路径无关、Windows 大小写归一
    manifest.json                   # 轮次索引（下面给出 DTO）
    blobs/<sha256>                  # 文件内容（全局去重：同一份内容只存一次）
    journal/<txid>/                 # 撤销事务的中途回滚备份（成功后立即删）
```

`manifest.json` 结构：

```ts
export interface CheckpointFileRecord {
  /** 会话内看到的相对/原始路径（用于 UI 展示，与 TurnFileChange.path 同口径） */
  path: string;
  /** 解析后的绝对路径 */
  absPath: string;
  /** 该轮开始前：null = 文件当时不存在（撤销时应删除该文件） */
  before: { blob: string; size: number } | null;
  /** 该轮结束后：null = 文件被删除了（会被判为不可撤销） */
  after: { blob: string; size: number } | null;
  /** 超过大小上限或读失败 → 无快照，不可撤销，带原因 */
  skipped?: "too_large" | "binary" | "unreadable" | "outside_cwd";
}

export interface CheckpointTurnRecord {
  turnIndex: number;
  /** 该轮的 user 消息文本前 120 字（UI 折叠态消歧用） */
  userPreview: string;
  createdAt: number;
  files: CheckpointFileRecord[];
  /** 用户点了「保留」或已撤销 → 不再提供撤销，blob 可回收 */
  state: "live" | "kept" | "reverted" | "expired";
  /** 该轮是否调用过 bash（UI 提示「撤销可能不完整」） */
  sawBash: boolean;
}
```

### D4：撤销是整轮原子事务（带 journal 回滚）

顺序：**校验 → 备份当前 → 逐个写 → 收尾**。任一步失败都用 journal 逆序还原，最终结果只有两种：全撤销成功，或完全没动。

### D5：`retention` 在 manifest 层做，`blobs` 靠引用计数回收

- 保留：最近 20 轮 且 `createdAt` 在 7 天内（超出 → `state: "expired"`，UI 显示不可撤销）。
- blob GC：manifest 剪完之后扫 `blobs/`，删除不再被任何 record 引用的文件。由扩展在 `session_start` / `turn_end` 时低频触发（每次最多 1 次，带 30s 节流）。
- 上限：单文件 5MB（超过 → `skipped: "too_large"`）；单轮最多 200 个文件（超出部分 skip 并记日志）。

### D6：UI 侧「已撤销」是旁路状态，不回写 transcript

新增 `renderer/src/stores/checkpoints.ts`：`Map<sessionFile, Record<turnIndex, "live"|"kept"|"reverted"|"expired">>`，来源 `checkpoints:list`。`DiffSidebar` 渲染时据此给轮次分组头加标签、把卡片降透明度。transcript 与 `TurnDiffChip` 保持历史事实不变（它们回答的是「这一轮 agent 改了什么」，不是「磁盘现在是什么」）。

### 错误处理契约（Fail-closed）

| 情形 | 行为 |
|---|---|
| 该轮正在运行 / agent 正在流式 | 拒绝，按钮 disabled + tooltip「等本轮结束」 |
| 任一文件 `skipped` | 整轮不可撤销，列出原因（不提供「部分撤销」） |
| 磁盘内容 ≠ 记录的 after | 整轮不可撤销，reason `modified_outside`，UI 文案：「这些文件在 agent 之外被改过，为免覆盖你的修改已拒绝撤销」 |
| 该轮用过 `bash` | 允许撤销，但确认框里追加警示（可能残留 shell 改动） |
| manifest 丢失 / 版本未知 | 视为不可撤销，不猜 |
| 撤销中途写失败 | journal 逆序还原后返回 `error`，UI 弹错误卡（复用 `ErrorNote` 风格），不静默 |
| 目标路径逃出 cwd | `skipped: "outside_cwd"`；**绝不**写 cwd 之外的文件 |

---

## 四、核心时序

### 4.1 采集（每轮自动）

```
tool_execution_start(toolName ∈ {edit, write}, args.path)
  → 解析绝对路径；isSessionPathDescendant(cwd, abs) 否则 skipped=outside_cwd
  → 若本轮该路径已有 before 记录 → 跳过（一轮内多次改同一文件只记第一次的 before）
  → 同步 readFileSync(abs)：
        成功 → 算 sha256 → 若 blob 不存在则落盘 → before = {blob, size}
        不存在 → before = null
        超 5MB / 非 utf8 → skipped 标记
  → 记下 (turnIndex, path) 到内存 pending

tool_execution_end(toolCallId 对应同一 toolCall)
  → 再读一次 abs → after = {blob|size} | null
  → 写入 pending 记录

turn_end
  → 把 pending 记录合成 CheckpointTurnRecord 追加进 manifest（原子写：临时文件 + rename）
  → 触发 retention 剪枝（节流）
```

`turnIndex` 计算：与前端同规则 —— **该分支内 user 消息的序号（从 0 计）**。后端在 `session_start` 时用 `ctx.sessionManager.getBranch()` 里已有的 user 消息数初始化计数器，此后每条 user `message_start` 自增。**必须与 `deriveTurnChanges` 的 `turnIndex` 完全一致**，否则 UI 的「第 N 轮」会指向错的记录（这条写进单测）。

### 4.2 撤销（用户动作）

```
用户点「撤销本轮」(sessionFile, turnIndex)
  → 主进程 IPC checkpoints:undo
  → 后端：
     1. 校验会话 idle（registry 查 isStreaming）
     2. 读 manifest[turnIndex]；state !== "live" → {status:"unavailable", reason}
     3. 逐文件校验：
          after=null（当时就不存在）→ 需当前仍不存在，否则 modified_outside
          否则 → 当前 sha256 === after.blob ？不一致 → modified_outside
          任一失败 → {status:"not_undoable", reasons:[{path, reason}]}   // fail-closed
     4. 开事务：journal/<txid>/ 备份每个文件的当前内容（或标记 absent）
     5. 逐个应用：
          before=null → 删除文件（若存在）
          否则      → 写 blobs/<before.blob> 到 absPath（先写 .tmp 再 rename，保留原文件 mode）
     6. 全部成功 → state="reverted"，删 journal，blob GC，返回 {status:"ok", restored[], deleted[]}
        任一步失败 → journal 逆序还原 → 删 journal → {status:"error", message}
```

### 4.3 保留（用户动作 / 自动）

`checkpoints:keep(sessionFile, turnIndex)` → `state="kept"` → blob GC。用途：用户确认这一轮改得好、不需要撤销 → 立刻释放磁盘。

---

## 五、受影响文件与变更策略

| 模块 / 逻辑 ID | 目标文件路径 | 变更类型 | 核心策略说明 |
|---|---|---|---|
| checkpoint 扩展入口 | `packages/backend/src/tools/checkpoint/index.ts` | 新增 | `makeCheckpointExtension(): InlineExtension`；照 `makeSubagentRelationsExtension` 骨架 |
| 快照采集 | `packages/backend/src/tools/checkpoint/capture.ts` | 新增 | `tool_execution_start` / `tool_execution_end` / `turn_end` 三个 handler + 大小/编码上限 |
| 磁盘存储 | `packages/backend/src/tools/checkpoint/store.ts` | 新增 | manifest 原子读写（临时文件 + rename）、blob 落盘（`fd` + fsync）、按引用回收 |
| 撤销事务 | `packages/backend/src/tools/checkpoint/undo.ts` | 新增 | 校验 → journal → 应用 → 回滚；绝不跨 cwd 写 |
| 纯逻辑 | `packages/backend/src/tools/checkpoint/pure.ts` | 新增 | turnIndex 推导、undoable 判定、retention 剪枝、ratio 无关的纯函数（全部单测） |
| 注册 | `packages/backend/src/pi-backend.ts` | 修改 | `factories.push(makeCheckpointExtension())`（紧随 `:471` 的 todo-reminder） |
| 导出 | `packages/backend/src/index.ts` | 修改 | 导出类型与纯函数供测试 |
| IPC 契约 | `packages/shared/src/checkpoints.ts` | 新增 | `CheckpointListResult` / `CheckpointUndoRequest` / `CheckpointUndoResult` 等 DTO（与 §三 D3 同形） |
| IPC 通道 | `packages/shared/src/ipc-channels.ts` | 修改 | `checkpoints:list` / `checkpoints:undo` / `checkpoints:keep`（沿用 `ch(...)` 风格，`:221` 附近） |
| 后端路由 | `packages/backend/src/pi-backend.ts`（请求分发处） | 修改 | 三个 handler；会话 idle 判定复用 registry |
| 渲染层状态 | `renderer/src/stores/checkpoints.ts` | 新增 | 按会话缓存 list 结果 + 乐观更新（undo 成功后本地置 `reverted`） |
| 侧栏 UI | `renderer/src/components/diff/DiffSidebar.tsx` | 修改 | 轮次分组头加「撤销本轮」幽灵按钮 + 状态标签（`live`/`kept`/`reverted`/`expired`） |
| 确认与原因展示 | `renderer/src/components/diff/DiffFileCard.tsx` | 修改 | 已撤销轮的卡片降透明度 + 不可撤销原因逐文件列出（用 `components/ui/Tooltip`，不用原生 title） |
| 首屏加载 | `renderer/src/components/diff/DiffSidebar.tsx`（打开时） | 修改 | 打开侧栏即拉一次 `checkpoints:list`（与 `BranchRow` 同样的 effect 模式） |
| 文案 | `renderer/src/i18n/zh.ts`、`i18n/en.ts` | 修改 | 约 12 条：撤销/保留/已撤销/已过保留期/原因文案/「不改动对话」的说明 |
| 样式 | `renderer/src/styles/globals.css` | 修改 | 撤销中 spinner、已撤销态降透明度；只用语义 token |
| 文档 | `docs/INDEX.md`、`docs/architecture.md` | 修改 | 登记 checkpoint 数据目录与「bash 不入账」边界 |

---

## 六、测试设计与验证（TDD 契约）

### 6.1 纯逻辑单测（先 RED）

`packages/backend/src/tools/checkpoint/pure.test.ts`：

- **turnIndex 一致性**：喂一条与 `deriveTurnChanges` 完全相同的消息序列 → 两侧算出的 `turnIndex` 集合相等（这是最关键的一条，防「第 3 轮」错位）
- `undoable()`：after 一致 → true；after 不一致 → `modified_outside`；`skipped` 存在 → false + 原因
- `before=null && 文件仍不存在` → 可撤销（结果=什么都不用做）；`before=null && 文件已存在` → 不冲突（会删除）
- retention：21 轮且都在 7 天内 → 最旧的 1 轮 → `expired`；8 天前但只有 3 轮 → 全部 `expired`
- 剪枝后 blob 引用集正确（不残留、不误删）

### 6.2 集成测试（临时目录，不碰真实工程）

`packages/backend/src/tools/checkpoint/*.test.ts`：

- create → write → undo：文件恢复原内容，mode 保留
- 同轮两次 edit 同一文件 → 只保留第一次的 before，撤销回到最初内容（不是中间态）
- write 新建文件 → undo 后文件消失（含空目录不留残骸）
- 用户手动改了文件再 undo → `not_undoable` + `modified_outside`，**磁盘零变化**（用 mtime + hash 双断言）
- 撤销中途注入写失败（mock `fs.rename` 抛错）→ journal 回滚 → 磁盘与撤销前逐字节相同
- 路径逃逸：目标 `../outside.txt` → `outside_cwd`，不写
- 5MB+ 文件 → `too_large`，整轮不可撤销

手工命令：`npx vitest run packages/backend/src/tools/checkpoint`（先 `cd packages/backend`）。

### 6.3 手工/CDP 验收

1. 让 agent 连改 3 个文件 → 点「撤销本轮」→ 3 个文件逐字节恢复、`git status` 干净、对话不变
2. 撤销后再撤销同一轮 → 报「已撤销」而不是再回退一次
3. 撤销前手动改其中一个文件的一个字 → 拒绝，并准确指出是哪个文件
4. 该轮跑过 `bash npx prettier --write` → 确认框出现「可能残留 shell 改动」警示
5. 撤销后重启应用 → 侧栏该轮仍显示「已撤销」标签（状态落盘在 manifest 而非内存）
6. 20+ 轮后最早那轮回显示「已过保留期」，且 `blobs/` 目录大小没有无限增长

---

## 七、实施步骤与验收清单

- [ ] **步骤 1（一次性 spike，先做，决定 D1 是否成立）**：写一个 20 行的临时扩展，订阅 `tool_execution_start`，在 `write` 工具对临时文件执行前后各读一次文件内容并打日志。**验收**：start 时读到的是**旧内容**（证明事件早于实际写入）。若否 → 停手，改走 §八 R1 的备选方案后再继续。
- [ ] **步骤 2（采集，无 UI）**：`pure.ts` + `store.ts` + `capture.ts` + `makeCheckpointExtension` + 注册；单测覆盖 turnIndex 一致性与 retention。验收：跑一轮真实会话后 `manifest.json` 内容正确、blob 可读回。
- [ ] **步骤 3（撤销，无 UI）**：`undo.ts` + IPC `checkpoints:undo` + journal；集成测试（含注入失败回滚）。
- [ ] **步骤 4（UI）**：`stores/checkpoints.ts` + `DiffSidebar` 按钮与标签 + 原因展示 + i18n 双语言 + 样式。
- [ ] **步骤 5（保留与回收）**：`checkpoints:keep`、blob GC、`expired` 表现、磁盘占用实测（`du -sh` 前后对比写进验收记录）。
- [ ] 文档收尾：`docs/INDEX.md` 增「按轮撤销与 checkpoint 数据」入口行；`docs/architecture.md` 记「bash 不入账」的边界。

---

## 八、风险与对策

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| R1 | `tool_execution_start` 可能晚于工具实际写入 → before 快照变成 after 快照，撤销失效 | **高** | 步骤 1 spike 先证伪/证实。若失效 → 备选方案 B：对 `edit` 用 `details.patch` **反向应用**（patch 里含被删行的原文，可精确还原）；对 `write` 改用「`tool_call` 参数出现即快照」的更早事件（`message_update` 里出现 toolCall）并接受少量竞态；两者都不可行则降级为「只支持 edit 撤销」并在 UI 明示 |
| R2 | bash / 外部进程改了文件 → 撤销不完整 | 中 | §1.2 明示 + 该轮 `sawBash` 时确认框警示；不尝试沙箱化 |
| R3 | blob 占用磁盘（大文件 × 20 轮） | 中 | 5MB/文件、200 文件/轮、20 轮/7 天三重上限 + 引用计数回收 + `keep` 立即释放 |
| R4 | Windows 文件锁 / 只读属性导致 rename 失败 | 中 | `.tmp` + rename 前先 `chmod` 恢复可写；失败重试 3 次（50ms 间隔）再回滚 |
| R5 | turnIndex 前后端不一致 → 撤销错轮 | **高** | 前后端共用同一纯函数规则 + 专测；manifest 里额外存 `userPreview`，撤销前 UI 用它做二次确认展示 |
| R6 | 会话被 GC 卸载后仍要能撤销 | 中 | 撤销只依赖 manifest + 磁盘，不依赖活跃会话对象（架构上已保证）；单测覆盖「无活跃会话」路径 |
| R7 | 撤销与 agent 正在写并发 | 中 | 会话 idle 校验 + 同一会话的撤销排队（复用 `subagent-relations` 的 active Map 思路） |
| R8 | 用户误解「撤销本轮」会把对话也退回 | 中 | 文案写「只还原文件，不改对话」；确认框列出将恢复/删除的文件清单 |
