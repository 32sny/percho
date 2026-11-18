---
类型: 技术方案
状态: 方案已定稿待批准
创建: 2026-10-31
更新: 2026-11-12
适用: Percho（32sny/percho）— 文档治理与多 Agent 协作基建
---

# 文档治理升级：把 dsh 的 Agent Note / 渐进式披露 / 防腐化 / Worktree 炼化进 Percho

> **创建日期**：2026-10-31
> **状态**：方案已定稿待批准
> **关联版本**：不回退、不绑定版本（纯文档与只读门禁，不触及产品代码）
> **任务真源**：用户要求——参考 DSH（`deepseek-ai/deepseek-harness`）的 Agent Note 规则、AGENTS.md 渐进式披露、文档防腐化机制与多 Worktree 并行开发机制，评估如何应用到 Percho

---

## 一、目标与阶段边界

### 1.1 目标

把 Percho 现有的文档资产（`AGENTS.md`、`docs/INDEX.md`、`docs/Memory.md`、`docs/PITFALLS.md`、`docs/PLAN-*.md`、`HANDOVER.md`、`.local/agent-work/`）**按 DSH 的四条机制重排分层**，使 Agent 在每次会话中：

1. 只加载当前任务真正需要的规则（而不是全部或零）；
2. 能从「决策理由」而非只从「代码现状」推断边界；
3. 不再靠人工记忆维持文档不腐化；
4. 具备并行开发互不干扰的落地纪律。

### 1.2 明确的非目标（Out of Scope）

- ❌ **不改 Percho 产品代码**：不修改 `packages/*` 任何源码、不新增产品功能、不改 Percho 对 Pi 运行时的封装。
- ❌ **不改 Pi 运行时的上下文加载逻辑**：不在 Percho 内实现 dsh 的 `fs` 触碰式注入插件。
- ❌ **不搬迁 `docs/Memory.md` 的 15 条正文**：历史经验是资产，批量搬迁有信息损失风险（见 §3.4 决策 D3）。
- ❌ **不引入 dsh 作为依赖**：只炼化思想与格式，不 npm install dsh。
- ❌ **不重写 Git 历史、不改既有 PLAN 正文**。

### 1.3 成功判据

| 判据 | 可验证证据 |
|---|---|
| 根 `AGENTS.md` 只剩站立命令 + 指针 | 行数 ≤ 30，每条 ≤ 3 行，无正文复述 |
| Agent Note 有可机械校验的形态 | `npm run verify:docs` 能对缺 Status / 路径非法 / 死链的 note 报红 |
| 文档膨胀在 CI 被拦住 | `verify-doc-budgets` 在超额时 exit 1 |
| 至少 2 篇真实 Agent Note 落地 | `docs/notes/implemented/**` 下有实际内容，且被 `docs/INDEX.md` 索引 |

---

## 二、现有实现定位

### 2.1 可复用能力（已在，不必重建）

| 现有资产 | 实际承担的角色 | 对应 dsh 的哪一层 |
|---|---|---|
| 根 `AGENTS.md`（34 行） | 项目规则（Git 约定、发版约定、UI 约束） | 根 `AGENTS.md` = 站立命令 |
| `docs/INDEX.md`（69 行） | 「按任务查入口」的导航表 | 手工版渐进式披露 + 代码入口地图 |
| `docs/Memory.md`（123 行，15 条） | 现象 / 根因 / 下次怎么做 / 验证依据 / 退出方式 | **同时混合了 Agent Note + postmortem + 流程纪律 + 验证证据** |
| `docs/PITFALLS.md`（27 行） | 按症状分流 | postmortem 的入口面 / cookbook 口袋 |
| `docs/PLAN-*.md` × 14（4,701 行，2026-11-12 快照） | 功能方案（已定稿待批准 / 已实施） | `proposed/` + `implemented/` 的混合体，**但无 lifecycle 标记、无归档** |
| `HANDOVER.md`（**显式 ignore**） | 跨会话交接与候选事项 | 保留根目录；2026-11-12 已定案写入 `.gitignore`，不迁 `.local/` |
| `.local/agent-work/{spec,plan,channel}` | 临时 spec / plan / 跨会话频道 | 不入库的草稿层（定位正确） |
| CI：lint / typecheck / test / build / packaging | 代码门禁 | **文档零门禁**（缺口） |

**关键结论：Percho 不是「缺机制」，而是「四种内容混装在 `Memory.md` 一个文件里」，且缺机械门禁。** 这与 DSH 文档标准里 "one home per fact" 的失败模式完全一致。

### 2.2 不能直接照搬的部分（硬约束）

#### 2.2.1 运行时不同：Percho 的 Agent 运行时是 **Pi**，不是 dsh

这是全案最重要的技术判断，直接决定能不能抄。

| 维度 | DSH | Pi（Percho 实际运行时） |
|---|---|---|
| 基线加载 | 首个请求前加载 `$DSH_HOME/AGENTS.md` → 项目根 base → local overlay → 根到 cwd 逐级 | agent 目录 → **cwd 及其父目录链** 的 `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` |
| 嵌套发现 | **按 fs 触碰惰性注入**：一次成功的 `read`/`write`/`edit` 触达更深的路径后，才把该子树规则增量投递进会话 | **按 cwd 祖先链**加载；`AGENTS.override.md` 只覆盖**同目录** |
| 无 watcher | 外部改动要靠 fs 触碰 / resume / 压缩后恢复才可见 | 同上，无 watcher |
| 独有能力 | 同目录字节相同内容去重、`maxBytes` 预算、按 scope 的版本对账 | 无 dedup 预算机制 |

**推论（决定方案形态）**：

- ✅ Pi 的子树 `AGENTS.md` **确实是惰性的**——只有当 cwd 落在该目录或其下才加载。所以「建子树 AGENTS.md」在 Pi 上是**真·渐进式披露**，成本低、收益真实。
- ⚠️ 但 Pi **没有** dsh 的「一次会话内触碰别的子树就增量注入」。所以：**不要指望在一个 session 里横跨全仓时自动拿到子目录规则**——该场景仍必须靠 `docs/INDEX.md` 指针。
- ❌ 因此**不能**照搬 dsh 的多级（4~5 层）AGENTS.md 体系：Pi 每层都是直接拼进上下文、无字节预算，层级越多越臃肿。**本方案把层级硬限为 2 层**（根 + 单层子树）。

#### 2.2.2 dsh 的文档防腐化依赖大量自研脚本，Percho 只有 4 类门禁

dsh 有 `verify-doc-budgets`（manifest 化的字数上限）、`doc-typecheck`（```ts 块必须编译）、`verify-md-wrap`（一段一行）、`verify-archived-agent-notes`（归档冻结 + sidecar 哈希）等成套工具链。Percho 现有 CI 只有 lint / typecheck / test / build / packaging。**本方案只取「预算门禁 + note 形态门禁」两项最小闭环，不引入 sidecar 哈希与归档冻结这类重型机制**（Percho 没有双语文档对，收益不成立）。

#### 2.2.3 Worktree：能力已有，缺的是纪律

- 本机 harness 的 `Agent` 工具**已支持 `isolation: "worktree"`**（隔离分支，结束保留变更）；`git worktree` 手工路径也可用。
- 现状：`git worktree list` 只有主 checkout 一条；并行完全靠 `.local/agent-work/channel/` 串行沟通。
- **结论：G3（Worktree 纪律）是「写约定 + 一条 Skill」，不是「开发工具」。** 在出现真实并行需求前，它属于空转，故排在最后。

---

## 三、架构决策

### 3.1 总体形状：四层，各归其位（对齐 dsh "one home per fact"）

```
Percho/
├─ AGENTS.md                    ← 第 1 层 站立命令（1~3 行/条 + 指针，禁正文）
├─ packages/<pkg>/AGENTS.md     ← 第 2 层 子树硬约束（仅 cwd 命中时加载）※ 限 1 层
├─ docs/
│  ├─ INDEX.md                  ← 导航真源（按任务/按代码入口）
│  ├─ notes/                    ← 第 3 层 Agent Note（决策理由：why / 放弃了什么 / 验收前提）
│  │  ├─ AGENTS.md              ← 该目录的写作规则（子树规则，惰性加载）
│  │  ├─ proposed/<class>/yyyy-mm-dd-<slug>.md
│  │  ├─ implemented/<class>/yyyy-mm-dd-<slug>.md
│  │  └─ rejected/<class>/yyyy-mm-dd-<slug>.md
│  ├─ Memory.md                 ← 事故与踩坑（现象/根因/下次怎么做 + 验证证据）
│  ├─ PITFALLS.md               ← 症状分流入口
│  └─ PLAN-*.md                 ← 提案（完成后须归档或提炼为 note）
└─ HANDOVER.md                  ← 交接（显式 ignore；保留根目录）
```

**划界规则（本方案的核心交付物，比目录更重要）**：

| 内容类型 | 唯一归属 | 判据 |
|---|---|---|
| 每次会话都必须知道的硬约束 | 根 `AGENTS.md` | 违反会直接造成错误改动 |
| 「为什么这样设计、放弃了什么、什么条件下要复核」 | `docs/notes/` | **代码和测试解释不了的持久理由** |
| 「出过什么事、怎么修、怎么避免复现」 | `docs/Memory.md` | 有现象时间线、有验证证据 |
| 「看到什么症状往哪查」 | `docs/PITFALLS.md` | 纯分流，不写结论 |
| 「打算怎么做、做完了没」 | `docs/PLAN-*.md` → 完成后提炼 note | 有阶段与验收清单 |
| 「这次会话到哪了、下一步等谁点头」 | `HANDOVER.md` / `.local/agent-work/channel/` | 有明确待决项 |

### 3.2 Agent Note 形态：照 dsh 路径编码，去掉双语与哈希

**路径即状态**：`{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`

- `lifecycle` 三态：`proposed/`（未实施）、`implemented/`（已落地，须随代码事实同步路径与名称）、`rejected/`（被否决，仅当能防住重犯时保留）
- `class` 闭集（照 dsh 裁剪为 4 类，Percho 无独立测试基建层，故合入 `testing`→`bug-fix`）：

| class | 覆盖 |
|---|---|
| `feature` | 面向用户/模型的新能力 |
| `bug-fix` | 修缺陷或补 postmortem 暴露的缺口 |
| `simplification` | 删代码/行为/表面积，不加能力 |
| `architecture` | 已落地源码的结构性决策（包边界、运行时词汇） |
| `process` | 代码外围的工具/流程/门禁 |

**文件必填头部**（供 `verify-agent-notes` 机械校验）：

```markdown
Status: proposed | implemented | rejected
Class: feature | bug-fix | simplification | architecture | process
Created: YYYY-MM-DD

## 决策
## 放弃了什么（Alternatives considered）
## 验收前提 / 复核条件（Required verification）
## 关联（链接到 PLAN / Memory 条目 / 源码路径）
```

> **不引入**：中英双语对、sidecar 哈希、归档冻结清单、`INDEX.md` 自动生成。理由：Percho 无双语文档、无归档冻结需求，这些在 Percho 是纯开销。

### 3.3 防腐化门禁：先在现状上跑红，再冻结基线

**原则：门禁若不能对现状报红，它就没有被验证过。** 因此顺序必须是「先红 → 冻结基线 → 再绿」。

1. `scripts/verify-doc-budgets.mjs` + `docs/doc-budgets.json`
   - 每份常驻文档一条上限（行数或词数）。
   - 基线算法：**取现状 +5% headroom 冻结**（dsh 原文口径：「At or below target, retain at least 5% headroom」）。
   - 超额 exit 1，提示三选一：**Relocate（移去该去的层）→ Condense（压缩）→ Raise（改 manifest 并在提交信息里说明理由）**。
   - **当前快照（2026-11-12，文档收口后）**：`docs/PLAN-*.md` 共 14 份、4,701 行；`docs/*.md` 共 26 份、5,587 行；PLAN 约占 docs 文档行的 84.1%。PLAN 是提案，不该成为最大常驻文档。
   - `docs/doc-budgets.json` 必须由脚本读取收口时的实时文件清单与行数生成，不硬编码快照数字；本方案中的快照只用于说明问题规模。
2. `scripts/verify-agent-notes.mjs`
   - 路径三段合法（lifecycle ∈ 三态、class ∈ 闭集、文件名 `yyyy-mm-dd-` 前缀）；
   - 必填头部四项齐全；
   - 正文内相对 Markdown 链接目标存在（防死链）。
3. 接入点：根 `package.json` 加 `"verify:docs": "node scripts/verify-doc-budgets.mjs && node scripts/verify-agent-notes.mjs"`；`.github/workflows/ci.yml` 的 `check` job 在 `npm run lint` 后加一步 `npm run verify:docs`。

### 3.4 三个待批决策点

| ID | 决策 | 选项 | 推荐 | 理由 |
|---|---|---|---|---|
| **D1** | 实施范围 | A. 只做 G1（纯文档重排）<br>B. G1 + G2（加门禁）<br>C. G1 + G2 + G3（加 worktree 纪律） | **B** | 只做 G1 会在 1~2 个月内回退到混装状态（`Memory.md` 已经是证据）；G3 在没有真实并行需求前是空转。 |
| **D2** | Agent Note 放哪 | A. `docs/notes/`（在 docs 内，被 INDEX 索引）<br>B. `.agents/notes/`（与 dsh 同构） | **A** | `.agents/` 在 Pi 里**没有特殊语义**（Pi 用 `.pi/`）；Percho 的导航真源是 `docs/INDEX.md`，note 放 docs 外会让索引断裂。放 `docs/notes/` 后 `docs/notes/AGENTS.md` 恰好能作为子树规则惰性生效。 |
| **D3** | `Memory.md` 怎么办 | A. 保持不动，只加「它管事故、不管决策理由」的边界声明<br>B. 把 15 条拆成 note + postmortem 两处 | **A（先试点 2 篇再定）** | 15 条里有验证证据与退出条件，搬迁易丢信息；先用 2 篇真实 note 验证形态是否好用，再决定是否拆。 |

---

## 四、执行状态机

```
G1 分层重组（纯文档，零代码，可 git revert）
 1. 现状快照：记录各文档行数作为预算基线原始值
 2. 根 AGENTS.md 收窄：保留硬约束，其余改为指针（不删信息，移层）
 3. 建 docs/notes/ + docs/notes/AGENTS.md（写作规则）
 4. 试点 2 篇 note（选题见 §7 步骤）
 5. docs/INDEX.md 增「决策记录」分区；Memory.md 加边界声明
 6. 停手验收 → 人工确认形态可用
──────────────────────────────────────────────
G2 防腐化门禁（纯新增脚本，先红后绿）
 1. 写 verify-doc-budgets.mjs，对现状跑 → 期望：能报出 PLAN 超额
 2. 生成 doc-budgets.json 基线（现状 +5%）
 3. 写 verify-agent-notes.mjs，对缺头部的假 note 跑 → 期望 exit 1
 4. 接 package.json + ci.yml
 5. 全绿验收
──────────────────────────────────────────────
G3 Worktree 纪律（约定 + 1 条 Skill，按需启用）
 1. 写触发条件清单（§5.2）
 2. 与 .local/agent-work/channel/ 对齐：一 feature = 一 worktree = 一频道
 3. 清理约定（保留分支 → 审阅 → 合并 → 显式删除）
```

**止损点**：每一步结束都可以停。G1 停 → 只得到分层文档；G2 停 → 只得到文档门禁；均不影响产品发版。

---

## 五、受影响文件与变更策略

### 5.1 G1 / G2 文件表

| 模块 / 逻辑 ID | 目标文件路径 | 变更类型 | 核心策略 |
|---|---|---|---|
| 站立命令 | `AGENTS.md` | **修改** | 收窄到 ≤30 行；只留「违反会直接造成错误改动」的规则 + 指针；发版版式正文已在 `docs/release-notes.md`，此处只留一行指针 |
| 写作规则 | `docs/notes/AGENTS.md` | **新增** | 定义三态、五 class、必填头部、何时该写（照 dsh「只在代码/测试/既有文档解释不了的持久理由时写」）；同时声明「机械性改动豁免」 |
| note 目录 | `docs/notes/{proposed,implemented,rejected}/<class>/` | **新增** | 空目录放 `.gitkeep` 或首篇 note 占位 |
| 导航真源 | `docs/INDEX.md` | **修改** | 新增「决策记录」分区（指向 notes 三态）与「文档治理」（指向两个门禁脚本） |
| 事故边界 | `docs/Memory.md` | **修改** | 头部加一段边界声明：本文件管「出过什么事 + 怎么避免」，**决策理由去 `docs/notes/`**；15 条正文不动 |
| 预算门禁 | `scripts/verify-doc-budgets.mjs` | **新增** | 读 manifest、按行数校验、超额 exit 1 并给出 Relocate/Condense/Raise 三选一提示 |
| 预算基线 | `docs/doc-budgets.json` | **新增** | 现状 +5% 冻结；`PLAN-*.md` 单独设更紧的 ceiling |
| note 门禁 | `scripts/verify-agent-notes.mjs` | **新增** | 路径三段 + 头部四项 + 相对链接可达 |
| 脚本入口 | `package.json` | **修改** | 加 `verify:docs` |
| CI | `.github/workflows/ci.yml` | **修改** | `check` job 在 lint 后加 `npm run verify:docs` |
| 交接跟踪 | `HANDOVER.md` | **已定案（2026-11-12）** | 保留根目录并显式 ignore；不改路径、不迁 `.local/`，避免失效现有链接与交接习惯 |

### 5.2 G3 Worktree 触发条件（约定草案）

**必须开 worktree 的任务**：
- 触及 `packages/desktop/src/renderer/**` 且需要跑全量 UI 验收的；
- 会执行全量 `npm test` / `npx electron-builder --dir` 的；
- 与另一并行任务在 `package-lock.json`、`packages/desktop/package.json` 上有交集的。

**不需要**：单文件文档改动、`docs/` 内改动、纯 note 维护。

**命名与清理**：`../percho-<slug>`（或 Agent 工具 `isolation: "worktree"` 自动分支）；合并后显式 `git worktree remove` + 删分支。**不引入自动清理**——dsh 自己的 worktree 也明确「leaving a worktree keeps its branch and files」，清理属于使用者。

---

## 六、测试设计与验证（TDD 契约）

### 6.1 最窄验证命令

```bash
# G2 脚本单测（先红）
node scripts/verify-doc-budgets.mjs --fail-on-missing   # 期望：先报 PLAN-*.md 超额
node scripts/verify-agent-notes.mjs                     # 期望：对无 Status 头的假 note exit 1

# 全量文档门禁
npm run verify:docs

# 回归（不改产品代码，期望全绿不变）
npm run lint && npm run typecheck
```

### 6.2 RED 阶段预期失败断言

| 脚本 | RED 时的预期输出 |
|---|---|
| `verify-doc-budgets` | 至少 1 份 `docs/PLAN-*.md` 超 ceiling，退出码 1，列出文件名 + 实际值 + 上限 + 三选一提示 |
| `verify-agent-notes` | 对故意写坏的夹具（缺 `Status:` / class 不在闭集 / 死链）分别 exit 1，各给出**具体违规类型**而非笼统失败 |

### 6.3 GREEN 阶段验收标准

- `npm run verify:docs` exit 0；
- 删掉任一 note 的 `Status:` 行后**必须重新报红**（证明门禁不是空转）；
- `npm run lint && npm run typecheck && npm run test` 与改动前一致；
- `docs/notes/` 下至少 2 篇真实 note，且 `docs/INDEX.md` 能索引到。

---

## 七、实施步骤与验收清单

### G1 分层重组

- [ ] **1.1** 快照基线：记录 `AGENTS.md` / 入库的 `docs/*.md` 行数（供 §6 的 `doc-budgets.json` 用）；`HANDOVER.md` 已显式 ignore，不计入仓库文档预算
- [ ] **1.2** 收窄根 `AGENTS.md`：仅保留「Git 中文提交约定指针」「upstream 合并时 GitLens 中文化需保留」「发版走 release-notes.md」「规范真源在中枢」四条 + 指向 `docs/INDEX.md` 与 `docs/notes/` 的一行
- [ ] **1.3** 新建 `docs/notes/AGENTS.md`（写作规则：三态、五 class、必填头部、何时写、机械性改动豁免）
- [ ] **1.4** 试点 note A —— `docs/notes/implemented/process/2026-10-20-app-asar-patch-migrated-to-source.md`：把 `Memory.md` 条目 8 的**决策理由**抽出（为什么"有 fork 后必须把补丁迁回源码"、放弃了什么、什么条件下复核）
- [ ] **1.5** 试点 note B —— `docs/notes/implemented/process/2026-10-21-channel-collaboration-discipline.md`：把 `Memory.md` 条目 13 的**协议设计理由**抽出（为什么卡点必须停手留言、为什么 review 方要独立复跑）
- [ ] **1.6** 在 `docs/Memory.md` 头部加边界声明（只管事故与复现，决策理由去 notes）
- [ ] **1.7** `docs/INDEX.md` 增「决策记录」与「文档治理」两个分区
- [ ] **1.8** 停手，人工验收形态

### G2 防腐化门禁

- [ ] **2.1** 写 `scripts/verify-doc-budgets.mjs`（读 manifest / 行数校验 / 三选一提示）
- [ ] **2.2** 对现状跑一次，确认能报出 PLAN 超额（**RED 证据留存**）
- [ ] **2.3** 生成 `docs/doc-budgets.json`（现状 +5% headroom；PLAN 类紧一档）
- [ ] **2.4** 写 `scripts/verify-agent-notes.mjs`（路径三段 + 头部四项 + 链接可达）
- [ ] **2.5** 造 3 个坏夹具验证能报红，验证后删除夹具
- [ ] **2.6** `package.json` 加 `verify:docs`；`ci.yml` 加调用步
- [ ] **2.7** 全绿：`npm run verify:docs && npm run lint && npm run typecheck`
- [x] **2.8** `HANDOVER.md` 跟踪态定案：保留根目录并显式 ignore（2026-11-12）

### G3 Worktree 纪律（可选，按需）

- [ ] **3.1** 写触发条件清单（§5.2）到 `docs/notes/implemented/process/` 或 `docs/PITFALLS.md` 邻近位置
- [ ] **3.2** 与 `.local/agent-work/channel/` 协议对齐（一 feature = 一 worktree = 一频道）
- [ ] **3.3** 首次真实并行任务时试跑，记录实际耗时与冲突情况后再决定是否固化

---

## 附录：与 dsh 原文的对应关系（供评审核对）

| 本方案的判断 | dsh 中的依据 |
|---|---|
| 「一个事实一个家」的分层 | `docs/AGENTS.md` 的 tier taxonomy 表：Root AGENTS.md 只放 standing orders（1~3 行/条 + 链接），"Stories, worked examples, situational procedures" 明令不在根 |
| Agent Note 三态与五 class | `.agents/notes/README.md`：`proposed/` `implemented/` `rejected/` + `feature/bug-fix/simplification/architecture/process/testing` 闭集 |
| 「只在解释不了的持久理由时写」 | 同上："Add or update an Agent Note … only for lasting decision rationale that code, tests, and existing documentation do not explain" |
| 「机械性改动豁免」 | 同上："Mechanical or local edits, including local UI presentation and interaction changes, are exempt" |
| 预算先冻结再收紧、留 5% headroom | `docs/AGENTS.md` Wordcount Budgets："At or below target, retain at least 5% headroom; above target, freeze the ceiling" |
| 超额三选一 Relocate → Condense → Raise | 同上，同段落三条顺序 |
| 渐进式披露的真实机制 | `packages/context/agent-instructions/src/index.ts` 文件头：baseline before first request；成功的 fs 触碰才把 nested/changed/removed 投递进 inbox |
| Pi 与 dsh 的加载差异 | dsh handbook `agents-md-scope.md`（"Nested discovery is tool-driven"、shell `cd` 不触发）vs Pi `docs/configuration.md`（"loads them from the agent directory, the working directory, and its parent directories"） |
| worktree 保留分支与文件、清理归使用者 | `packages/experimental/worktree/README.md`："Leaving the checkout retains its files and branch"、"checkout removal and branch deletion belong to the user or another consumer" |
