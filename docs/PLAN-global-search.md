---
类型: 技术方案
状态: 方案已定稿待批准
创建: 2026-10-31
更新: 2026-11-12
适用: Percho — ⌘K 全局搜索（会话内容 / 文件 / 项目）
---

# ⌘K 全局搜索：一个框搜会话内容、文件与项目

> **创建日期**：2026-10-31
> **状态**：方案已定稿待批准
> **关联版本**：v0.7.x（下一功能版本）
> **任务真源**：竞品分析结论——Percho 左栏搜索只过滤会话标题（`SidebarHeader` → `projects.setSearch`），找不到「记得内容但忘了在哪条会话」的东西；MonoCode 的 ⌘K 是一个框三域（会话 / 文件 / 项目）

---

## 一、目标与阶段边界

### 1.1 交付契约

1. **⌘K / Ctrl+K 唤起命令面板**，一个输入框搜四个域：**当前项目的文件**、**会话标题**、**会话正文内容**、**项目名**。
2. **渐进可用的结果分层**：标题/文件/项目在 50ms 内出结果（纯内存 + 目录缓存）；正文命中随后补齐，面板就地刷新，不打断用户已经开始的 ↑↓ 选择。
3. **命中可跳转**：Enter 在焦点 pane 打开；⌘Enter 在右侧 pane 打开（依赖 `PLAN-session-split-panes.md`，未实施时降级为普通打开）。会话正文命中直接跳到该会话并高亮定位到命中消息。
4. **诚实的能力边界**：单次搜索有硬上限（扫描会话数 / 字节预算 / 时间预算），超限时**明确显示**「已扫描 N/M 个会话，按最近活动优先」，绝不假装搜过全部。
5. **可取消、不卡 UI**：连续输入用 latest-wins 丢弃旧请求（复用 `projects.ts` 的 `loadSeq` 纪律），后端收到新 requestId 即中止旧扫描。

### 1.2 非目标（Out of Scope）

- 不做持久化倒排索引 / SQLite FTS（二期再评估，见 §八 R2）。首版是「按需有界扫描 + 内存缓存」。
- 不做正则 / 大小写敏感 / 全词匹配等高级语法（只做大小写不敏感的普通子串 + 文件路径 fuzzy）。
- 不搜工具输出正文（只搜 user / assistant 的文本，理由见 §三 D3）。
- 不搜 subagent 产物会话（`isSubagentSessionPath` 的只读会话），与左栏导航口径保持一致。
- 不做搜索历史 / 收藏 / 最近查询持久化（首版只在内存里保留本次会话的最近 5 条查询）。
- 不做替换、批量操作、跨设备搜索。

---

## 二、现有实现定位

### 2.1 可复用能力（已核实存在）

| 能力 | 位置 | 复用方式 |
|---|---|---|
| 全量会话枚举（含 cwd / messageCount / 时间戳，来自 SDK） | `pi-backend.ts:788` `listAllSessions()` → `SessionManager.listAll()` | 会话标题/项目域直接用；也是正文扫描的**文件清单来源**（`SessionInfo.path`） |
| 单会话「不打开也能读历史」的有界读法 | `backend/src/session/hover-history.ts`（`HISTORY_BYTES = 8MB`、`FIRST_LINE_BYTES = 128KB`、`checkMemoryBudget`） | 正文扫描照抄这套「字节预算 + 超限即停」的纪律 |
| 项目文件树（递归、排除 node_modules 等、5000 条上限、30s TTL 缓存） | `backend/src/project/files.ts` `walkProjectFiles()` | 文件域直接调用，不重写 |
| 文件域 IPC 已有 | `shared/src/ipc-channels.ts:221` `listProjectFiles` | 面板若要「先出结果」，前端可直接用它做首屏 |
| 左栏搜索（会话标题过滤） | `renderer/src/stores/projects.ts` `search` / `setSearch` | **保留不动**（它是过滤，不是搜索），⌘K 是另一个入口 |
| latest-wins 请求纪律 | 同上 `loadSeq` 模块级序号 | 搜索请求照抄 |
| 浮层基础设施 | `components/ui/ContextMenu`、`place-menu.ts`、`Tooltip`、`createPortal` 约定（`docs/ui.md`） | 面板用同一套浮层规范 |
| 会话跳转 + 定位 | `stores/projects.ts` `openSession`、`stores/ui.ts` `diffFocus`（nonce 复用重触发模式） | 新增 `messageFocus: {sessionId, messageKey, nonce}` 供高亮定位 |
| IME 安全输入先例 | `components/composer/Composer.tsx`、`lib/` 既有组合态处理 | 中文输入必须 `isComposing` 期间不触发搜索 |

### 2.2 不能直接复用 / 需打破的旧假设

1. **没有「会话正文」的读取通道**：`getSessionHoverPreview` 只给悬停卡用（裁剪到最近若干条、结构为卡片而设计），没有 keyword 搜索能力；正文扫描是新模块。
2. **`SessionMeta` 里没有正文文本**：`name` 与 `messageCount` 之外没有 preview 字段，所以正文搜索必须读 jsonl 文件。
3. **会话文件很大**：`2026-10-31` 样本观察为 `~/.pi/agent/sessions` 约 **439 个 jsonl、1.2GB**；这是样本快照，不是当前容量承诺。任何"全量读一遍"的实现都不可接受 —— 这仍是本方案最硬的约束。
4. **`walkProjectFiles` 有 5000 条截断**：超大项目里文件域结果会不全，必须在结果里标注（不能静默截断）。
5. **会话文件可能被外部改/删**（同时用 CLI）：读失败必须静默跳过，不能让一次搜索整体失败。

---

## 三、架构决策

### D1：三域分工 —— 两域纯前端，一域回后端

| 域 | 数据源 | 位置 | 首帧延迟 |
|---|---|---|---|
| 项目名 | `projects.ts` 的 `allSessions` + `addedProjects`（已在内存） | **纯渲染层** | 0ms |
| 会话标题 | 同上（`SessionMeta.name`） | **纯渲染层** | 0ms |
| 文件名 | `allSessions` 里当前项目的 cwd → `listProjectFiles(cwd)`（后端已缓存 30s） | **渲染层调既有 IPC** | ~1 帧（缓存命中）/ 首次数百 ms |
| 会话正文 | 会话 jsonl 磁盘扫描 | **后端新模块** | 200ms – 1.5s |

理由：能不进后端的就不进后端。只有正文必须碰磁盘，所以只有它需要新 IPC。

### D2：正文搜索 = 有界、按最近活动优先、可中止的扫描

不建索引（首版），走「有界扫描」：

- **文件清单**：`listAllSessions()` 的 `path`，按 `modified` 倒序。**先扫最近改过的**（用户想找的几乎总在最近的会话里）。
- **每文件预算**：最多读 **1MB**，且**头部 768KB + 尾部 256KB**（会话开头的需求描述 + 结尾的结论最容易命中；中间大段工具输出价值低）。
- **总预算**：软超时 **1500ms**、最多扫描 **200 个文件**；任一到达即停，返回 `truncated: true` + 实际 `scanned`/`total`。
- **同一查询缓存**：`Map<absPath, {mtimeMs, size, digestTextLen, hits: number[]}>`，只缓存"该死文件在本次查询下是否命中 + 命中偏移"，最多 200 条 LRU。同一查询重复输入（多打一个字）只重扫**未命中过**的文件 → 打字过程中的增量成本接近 0。

### D3：只搜 user / assistant 文本，不搜工具输出

理由：
1. 工具输出是字节大户（1.2GB 里绝大部分），且几乎不含用户想找的自然语言。
2. 命中了也没有好的"跳转定位"体验（工具卡是折叠的）。
3. 与 `docs/ui.md` 的克制原则一致：不给用户一个「搜到 200 条 base64」的结果页。

边界要在 UI 里说明（面板底部署名行：「只搜对话文本，不搜工具输出」）。

### D4：单次请求 + 硬上限，不做流式推送（首版）

候选：

| 方案 | 成本 | 缺点 |
|---|---|---|
| A. **单次请求 + 硬上限** | 低 | 上限内要等（≤1.5s） |
| B. 流式进度事件（`search:progress` 分批推） | 中 | 需要事件生命周期管理、跨 IPC 的取消语义、面板要处理增量合并与顺序 |
| C. 后台常驻索引 | 高 | 1.2GB 建索引时间与 IO 代价不可接受（首版） |

**采纳 A**。1.5s 内单次返回 + 前端在等待期间显示已有的三域结果（见 §1.1 第 2 条），体感上不是"卡住"。B 列为二期增强，接口预留 `requestId` 以便升级。

### D5：结果合并与排序（纯函数，可单测）

打分规则（同一域内排序，跨域按固定分组顺序展示）：

- 会话标题命中：`+100`（前缀命中 `+20`）
- 项目名命中：`+60`
- 正文命中：`+40` +（命中次数 ≤5 加成）+（最近 7 天内 `+15`）
- 文件名 fuzzy：按 `at-files.ts` 现有 fuzzy 打分（复用同一实现，避免两套模糊匹配手感不一）

同一会话既有标题命中又有正文命中 → **合并成一条**，副行同时显示「标题命中」与「N 处正文命中」，展开后列出命中片段。

### D6：跳转与高亮定位

新增 `stores/ui.ts` 的 `messageFocus: { sessionId, messageKey, nonce }`（照抄 `diffFocus` 的 nonce 重触发模式）。`MessageList` 消费：滚到该 key 并加一次 1.2s 的闪烁高亮（复用 `jump-flash` 的既有动画）。若目标消息不在当前挂载窗口内 —— 先 `expandWindowStart` 到该消息所在块再滚（`mount-window.ts` 已支持只增不减的补挂）。

### 错误处理契约（Fail-closed）

| 情形 | 行为 |
|---|---|
| 单个 jsonl 读失败 / 权限不足 / 文件已删 | 跳过该文件，累加 `skipped` 计数，结果里如实显示（不报错弹窗） |
| 文件是二进制 / 非 utf8 | 跳过，不抛 |
| 查询为空串 | 不发起后台扫描，只显示「最近打开的会话」+「最近改动的文件」（体验加分项，见 §七 步骤 4） |
| 查询长度 > 200 字符 | 截断到 200 再发（防病态查询打满 CPU） |
| 前端请求被新请求覆盖 | 旧结果直接丢弃（latest-wins），不 merge |
| 后端上一次扫描未结束又来新请求 | 中止旧 AbortController，新请求立即开始 |
| 项目没有 cwd / 非 git 目录 | 文件域显示「当前没有可搜索的项目目录」 |

---

## 四、核心状态机 / 时序

### 4.1 唤起与首帧

```
⌘K / Ctrl+K
  → openPalette()（焦点锁在输入框；Esc / 点外部关闭）
  → 立即渲染：
       - 空查询态：「最近打开的会话」（allSessions 按 modified 倒序取 5）
       - 输入区、域分组骨架
  → 用户输入（isComposing 期间不触发）
       → 本地三域（项目/标题）同步算 → 立即渲染
       → 若有 cwd：调用既有 listProjectFiles（缓存命中则同帧）
       → 若跨过 150ms debounce：发起 search:global（正文域）
```

### 4.2 正文搜索（后端）

```
search:global({ requestId, query, cwd, limit, budget })
  1. sessions = await SessionManager.listAll() → 按 modified 倒序
  2. 遍历：读 path 的 [0,768KB) 与 [size-256KB, size)（重叠则只读一次）
        → 按行切分（\n）→ 只保留能解析成 message entry 且 role ∈ {user, assistant} 的行
        → 抽取 text content（跳过 thinking / toolCall / image）
        → 子串匹配（预编译 lower-case haystack，避免每行 toLowerCase）
        → 命中：记录 {sessionPath, entryTimestamp, snippet(±80 字符，去代码围栏), score}
  3. 每扫完一个文件检查：elapsed > 1500ms || scanned >= 200 || hits >= limit → break（并置 truncated）
  4. 返回 { hits, scanned, total, truncated, elapsedMs, skipped }
  并发：文件读取并行度 8（`Promise` 池），单一文件内串行
  中止：读循环每轮检查 AbortSignal
```

### 4.3 跳转

```
Enter（焦点在「会话 · 正文命中」项）
  → projects.openSession(meta)     // 既有：装载 + 切焦点
  → ui.setMessageFocus({sessionId, messageKey, nonce})
  → MessageList effect：必要时补挂窗口 → scrollIntoView（局部 scrollTop，绝不用全局 scrollIntoView）→ jump-flash
⌘Enter
  → 存在分屏（PLAN-session-split-panes 已实施）→ panes.openSecondary(sessionId)
  → 否则等同 Enter
```

---

## 五、受影响文件与变更策略

| 模块 / 逻辑 ID | 目标文件路径 | 变更类型 | 核心策略说明 |
|---|---|---|---|
| 搜索 DTO | `packages/shared/src/search.ts` | 新增 | `GlobalSearchRequest/Result`、`SearchHit`（含 `kind`、`score`、`snippet`、`messageKey`） |
| 结果合并与打分 | `packages/shared/src/search-rank.ts` | 新增 | 纯函数：合并「标题 + 正文」同会话命中、跨域排序、fuzzy 文件名打分（复用 `at-files.ts` 的算法） |
| IPC 通道 | `packages/shared/src/ipc-channels.ts` | 修改 | `search:global`（`ch(...)` 风格，`:221` 附近） |
| 后端搜索模块 | `packages/backend/src/search/global-search.ts` | 新增 | 有界扫描 + 并行池 + AbortSignal + 每查询缓存；不 import React、不碰渲染层 |
| 文本抽取 | `packages/backend/src/search/extract.ts` | 新增 | jsonl 行 → 文本；跳过 thinking/toolCall/image/工具结果；纯函数单测 |
| 后端路由 | `packages/backend/src/pi-backend.ts` | 修改 | 挂 handler；维护 `Map<requestId, AbortController>`，新请求先 abort 旧的 |
| 导出 | `packages/backend/src/index.ts` | 修改 | 导出纯函数供测试 |
| 渲染层 store | `renderer/src/stores/global-search.ts` | 新增 | 查询状态机（idle/searching/done）、debounce 150ms、latest-wins `requestSeq`、域结果分槽 |
| 面板 UI | `renderer/src/components/search/CommandPalette.tsx` | 新增 | `createPortal` 到 body；`shadow-pop` 无边框；`text-ui-*` 字号；键盘导航；`isComposing` 守卫 |
| 分组与项 | `renderer/src/components/search/PaletteSection.tsx`、`PaletteRow.tsx` | 新增 | 四域分组、命中片段高亮（`<mark>` 用语义 token，不写死色值） |
| 高亮定位 | `renderer/src/stores/ui.ts` | 修改 | 新增 `messageFocus` + setter/clear（照 `diffFocus`） |
| 消息流定位 | `renderer/src/components/chat/MessageList.tsx` | 修改 | 消费 `messageFocus`：补挂窗口 → 局部滚动 → `jump-flash` |
| 会话行 | `renderer/src/components/sidebar/*` | **不改** | 左栏搜索保持现状（过滤 ≠ 搜索） |
| 快捷键挂载 | `renderer/src/App.tsx` | 修改 | 全局 keydown 监听 ⌘K/Ctrl+K（`prefers-reduced-motion` 无关），防与输入框内 ⌘K 冲突 |
| 文案 | `renderer/src/i18n/zh.ts`、`i18n/en.ts` | 修改 | 约 14 条：分组标题、空态、「已扫描 N/M」「只搜对话文本」「Enter/⌘Enter」提示 |
| 样式 | `renderer/src/styles/globals.css` | 修改 | `.palette-*`、`mark` 高亮、`prefers-reduced-motion` 降级 |
| 文档 | `docs/INDEX.md`、`docs/ui.md` | 修改 | INDEX 增「全局搜索（⌘K）」入口；ui.md 记面板的浮层/键盘/Esc 约定 |

---

## 六、测试设计与验证（TDD 契约）

### 6.1 纯函数单测（先 RED）

`packages/shared/src/search-rank.test.ts`：
- 同一会话标题 + 正文双命中 → 合并为 1 条，`badges` 同时含两者
- 前缀命中排在子串命中前
- 7 天内加权生效、边界（刚好 7 天）明确
- 文件名 fuzzy 与 `at-files.ts` 对同一输入给出相同顺序（防两套手感）

`packages/backend/src/search/extract.test.ts`：
- 只抽 user/assistant 的 text part；thinking / toolCall / image / toolResult 全部剔除
- 非法 JSON 行 → 跳过，不抛
- 超长单行（>1MB）→ 截断且不 OOM

`packages/backend/src/search/global-search.test.ts`（临时目录造 5 个 jsonl）：
- 命中返回 `messageKey` 可定位；snippet 去掉了 markdown 围栏
- 时间预算：mock 一个慢文件 → 返回 `truncated: true` 且 `elapsedMs` 不超预算太多
- 文件数上限：造 210 个文件 → `scanned === 200`、`total === 210`
- 读失败文件 → `skipped` 计数 +1，整体仍成功
- 同一查询第二次调用 → 缓存生效（`scanned` 明显减少 / 读文件次数被 mock 计数）

### 6.2 组件测试

- `CommandPalette`：`isComposing` 期间输入不触发查询（模拟 IME compositionstart/end）
- 连续输入三次 → 只有最后一次的结果被采纳（latest-wins）
- ↑↓ 跨分组移动、Enter 触发跳转回调、⌘Enter 触发「右侧打开」回调
- Esc 关闭后焦点回到原处（不丢焦点到 body）

### 6.3 真机验收（`scripts/cdp-eval.mjs` / `cdp-shot.mjs`）

1. 输入一个只出现在某条 3 天前会话里的词 → 1.5s 内出现该会话（正文命中），点开跳到命中消息并闪烁
2. 中文输入法正在拼字时不发请求（Network/事件日志断言）
3. 故意搜一个超高频词（如「文件」）→ 结果有上限、底部显示「已扫描 200/439」
4. 同时用 CLI 删掉一个会话文件 → 搜索不报错，`skipped` 计数 +1
5. 大项目（>5000 文件）搜文件名 → 结果标注「文件列表已截断」

---

## 七、实施步骤与验收清单

- [ ] **步骤 1（纯函数）**：`shared/search.ts` + `search-rank.ts` + `backend/search/extract.ts`，单测全绿（此时无任何 UI 与 IPC）。
- [ ] **步骤 2（后端）**：`global-search.ts` + IPC + abort/缓存；用临时目录做集成测试；导出到 `index.ts`。
- [ ] **步骤 3（面板骨架）**：`global-search.ts` store + `CommandPalette` + 本地三域（项目/标题/文件）+ 键盘导航 + i18n + 样式。**此时正文域可暂缺**，面板已可用。
- [ ] **步骤 4（正文域 + 跳转）**：接 `search:global`、`messageFocus` 高亮定位、⌘Enter 右侧打开（分屏未实施则降级）、空查询态「最近会话/最近文件」。
- [ ] **步骤 5（边界打磨）**：截断提示文案、`skipped` 展示、超长查询截断、大项目文件截断标注、reduced-motion。
- [ ] 文档收尾：`docs/INDEX.md` 增一行入口说明；`docs/ui.md` 补面板键盘与浮层约定。

---

## 八、风险与对策

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| R1 | 1.2GB 会话目录，全量扫描不可行 | **高** | 双重有界（1MB/文件、200 文件、1500ms）+ 按 `modified` 倒序 + 同查询缓存；超限**如实告知**而非静默截断 |
| R2 | 用户期望"像 Spotlight 一样秒出全部结果"，有界扫描会漏 | 中 | 结果区常驻「已扫描 N/M」+ 一键「继续搜索更早会话」（二期，需分页游标）；二期评估 SQLite FTS 增量索引（Node 22 的 `node:sqlite` 需先确认 Electron 侧可用性） |
| R3 | 中文输入法 composition 期间触发抖动 | 中 | `isComposing` 守卫 + 150ms debounce；组件测试覆盖 |
| R4 | 正文命中无法精确定位（compaction / fork 后 messageKey 不稳） | 中 | 用「entry 时间戳 + 文本前 40 字」双条件在已加载 transcript 里找；找不到则只打开会话并提示「命中点在历史较早处」 |
| R5 | 多窗口 / 多会话并发搜索打满磁盘 IO | 中 | 并行度固定 8；同 requestId 复用；新请求中止旧请求 |
| R6 | 隐私：正文搜索会读到敏感内容 | 低 | 全部在本机进程内、不落日志、不落盘缓存文本（只缓存命中偏移） |
| R7 | `walkProjectFiles` 5000 条上限让大项目「搜不到文件」 | 中 | 结果区标注截断；二期把上限提高为可配置或改用按目录懒加载 |
