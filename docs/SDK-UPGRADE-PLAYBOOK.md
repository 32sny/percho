---
类型: 操作手册
状态: 有效
创建: 2026-11-13
更新: 2026-11-15
适用: Percho SDK升级与自研补丁迁移
---

# Percho SDK 升级迁移与验收手册

> ⚠️ **【重要警示 / 避坑要点 / 免责声明】**
> 本手册沉淀自 Percho 从 pi SDK **1.0.4 → 1.4.0 → 1.5.1** 的实际迁移实践，面向下一次 SDK 1.6.x 及后续升级。它是一套**可执行的迁移与验收框架**，不是复盘散文。文中涉及的当前版本号、文件路径与行为断言在执行时应重新核实，不得当作永久 API 保证。
>
> **编号区分**:本手册的 **P0-P6 是通用升级阶段门模板**;与 Percho 功能计划中的 **P0-P8 / G1-G8 编号体系无对应关系**,不得混用。本轮升级的完整过程与授权记录见 [PLAN-sdk-1.5.1-upgrade.md](PLAN-sdk-1.5.1-upgrade.md)（当前状态以其 §19.14 为准）。

---

## 目录

1. [适用范围和核心原则](#1-适用范围和核心原则)
2. [升级前资产盘点](#2-升级前资产盘点)
3. [回退与隔离](#3-回退与隔离)
4. [标准阶段门 P0–P6](#4-标准阶段门-p0p6)
5. [测试分类与红线](#5-测试分类与红线)
6. [1.0.4 → 1.5.1 已验证教训](#6-104--151-已验证教训)
7. [真实环境验收](#7-真实环境验收)
8. [命令模板与证据目录](#8-命令模板与证据目录)
9. [切换判定](#9-切换判定)
10. [最终报告模板](#10-最终报告模板)

---

## 1. 适用范围和核心原则

### 1.1 分层：两类升级不要混淆

| 层 | 内容 | 升级触发方 | 变更对象 |
|---|---|---|---|
| **上游 SDK 升级** | `@earendil-works/pi-*` 版本号变化 | 上游发版 | `package.json` 依赖、`patches/`、SDK 行为适配 |
| **Percho 本地协议迁移** | `shared/` IPC 契约、backend 内部结构 | 自身需求 | 产品源码、消息通道、renderer stores |

两者分开评估、分开验收。SDK 升级阶段**不夹带**本地协议重构；本地协议重构阶段不换 SDK 版本。混在一起做会让失败归因失效。

### 1.2 核心原则

1. **不把 `npm install` + `typecheck` 通过当成行为兼容**。类型层面兼容不代表运行时事件形状、生命周期时序、持久化时机未变。每次升级必须跑真实 message-control 分片与真实模型验收。
2. **固定上游 commit**。升级目标锁定到具体版本号与（如可得）具体 commit/`integrity`，禁止用 `^`/`~` 浮动解析后"看装到了什么"。
3. **补丁只由 dist 源码生成**。`patches/` 下的补丁文件必须通过 `patch-package` 对 node_modules 内实际产物 diff 生成；**严禁手改 `.patch` 文件**。改需求就改 node_modules 里的源码再重新生成补丁。
4. **不直接重建 fork**。升级是"新基底 + 重新移植自研补丁与本地协议"，不是删库重来；历史验证资产、测试、证据保留。
5. **不自动引入上游新增的 UI 存储功能**。上游 SDK 可能携带新的 UI/状态能力（如内部 UI store），Percho 有自己的 renderer 状态体系；默认不接入，逐项评估后再决定。

---

## 2. 升级前资产盘点

动手前先完成盘点并写入升级工作频道的 HANDOFF，未盘点完整不得进入 P0。

### 2.1 盘点清单

| 资产类别 | 具体项 | 核实方式 |
|---|---|---|
| 依赖 | 各 workspace `package.json` 中 `@earendil-works/pi-*` 声明与实际解析版本 | `npm ls @earendil-works/pi-ai @earendil-works/pi-coding-agent`（或对应包名）；注意 `PI_PACKAGE_DIR` 可影响 SDK 导出的 VERSION，不能据它判断 node_modules 实际版本 |
| Lockfile | `package-lock.json` 中相关条目与 integrity | 锁定目标版本后 diff |
| 补丁 | `patches/` 全部 `.patch` 文件及其用途 | 逐个读文件头注释与 diff；当前已知补丁提供 `retryLastFailedTurn` 等 |
| 产品源码边界 | `packages/backend/src/pi-backend.ts`、`packages/backend/src/session/`（含 `message-control.ts`）、`packages/shared`（`message-control.ts` / `session.ts` / `ipc-channels.ts` / `transcript/`）、renderer 会话相关 stores | 确认哪些文件直接依赖 SDK 导出符号 |
| 测试 | `packages/backend/test/` 下与 SDK 行为相关的分片（`message-control-sdk*`、`core-abort` 等，入口 tsc 配置见 §8） | 列出升级中必须保持绿的用例 |
| 正式包边界 | 用户已安装版本、正式会话目录、凭证位置 | 只读盘点；升级验证**不得触碰**正式数据 |

### 2.2 私有 API / 运行依赖清单

逐项记录当前版本对以下能力的依赖，升级时逐项核对目标版本是否仍存在、语义是否变化：

- **私有/半私有 API**：任何通过补丁引入或依赖 SDK 内部结构的入口（如 `retryLastFailedTurn` 的补丁实现）。
- **运行入口**：backend 启动链路、`pi-backend.ts` 门面、`builtin-extensions.ts` 扩展接入。
- **host pause**：宿主侧暂停语义（双暂停见 §6.2）。
- **idle lease / GC**：会话空闲租约与自动卸载对 SDK 事件时序的假设。
- **retry**：手动重试依赖的 SDK 恢复生命周期（不重发用户任务、不只调底层 continue）。
- **compaction**：压缩事件形状、来源标记、触发路径（compaction-guard 的假设）。

> 💡 **【核心结论 / 决策要点】** 盘点产物是一张"依赖点 → 验证方式"对照表。任何一个依赖点没有对应验证方式，就不允许进入 P4。

---

## 3. 回退与隔离

### 3.1 升级前快照（进入 P0 前完成）

1. **仓库外文件快照**：把 `package.json`、`package-lock.json`、`patches/` 目录复制到仓库外目录（示例如 `$SNAPSHOT_HOME`），并对每个文件计算 SHA256 记录在案：

   ```powershell
   Get-FileHash <file> -Algorithm SHA256
   ```

2. **Git 权限确认**：记录当前 `HEAD` commit；确认工作分支干净。若工作区有未提交文件，先与用户确认去留，**不得**为"干净"而丢弃。
3. **node_modules 快照**：可选但推荐——在独立目录保留一份当前版本的 `node_modules`（或至少保留 lockfile + 缓存），保证旧版本可即时重建。

### 3.2 禁止操作（硬红线）

| 禁止 | 理由 |
|---|---|
| `git reset --hard` | 会无差别丢弃未提交工作 |
| `git clean -fd` | 会删除未跟踪的实验文件与本地配置 |
| `git checkout -- .` | 静默覆盖被误改的文件，失去取证机会 |
| 直接删除 `patches/` 后手写 | 破坏补丁可复现性 |

任何"看起来乱了想恢复"的冲动，改为：停止操作 → 记录现状 → 走回退流程（§3.3）。

### 3.3 隔离边界

- **正式会话数据**：升级验证一律使用独立验证目录，绝不指向用户的正式 agent/userData 目录。
- **凭证**：验证环境不自动使用用户真实凭证；含真实网络/凭证的脚本先读文件头确认前提，再经用户同意执行。
- **验证环境**：建立独立验证目录（下文以 `$VALIDATION_HOME` 指代）与独立的 `HOME`/agent 目录/userData，以隔离方式降低 P4–P5 冷启动与真实会话对正式数据的污染风险；实际隔离效果以各阶段证据为准，不宣称无条件保证。

---

## 4. 标准阶段门 P0–P6

每个阶段定义：**入口条件 / 允许改动 / 核心命令 / 出口条件 / 必须停手条件**。任何"必须停手"命中即停止，写报告归因，不跳门。

### P0 基线

- **入口**：§2 盘点完成，§3 快照完成。
- **允许改动**：无（只读 + 快照）。
- **核心命令**：旧版本下全量 `npm ci` → `typecheck` → `test` → `lint`，记录全绿基线与耗时。
- **出口**：基线记录在案（版本、命令、结果、证据路径）。
- **停手**：基线本身不绿——先修旧基线，不带着红基线升级。

### P1 固定依赖 + 上游补丁重生成

> ⚠️ **【重要警示 / 避坑要点 / 免责声明】** `@earendil-works/pi-ai` / `pi-coding-agent` 的依赖声明在 **workspace 内**（`packages/backend/package.json`、`packages/desktop/package.json`），不在根 `package.json`。依赖变更后必须核对**所有** workspace 的现有声明，不要自动往根加依赖。补丁目标包是 `@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-agent-core`，`patch-package` 必须显式写包名（根 `postinstall` 会隐式应用全部补丁）。

- **入口**：P0 出口达成；目标版本与 commit 已确定。
- **允许改动**：各 workspace `package.json`（精确版本）、`package-lock.json`、`patches/`（仅由 patch-package 重新生成）。
- **核心命令**：

  ```powershell
  # 精确固定版本（不用 ^ ~），落在 workspace 内；所有 workspace 的 pi 声明逐个更新
  npm install -w @percho/backend --save-exact @earendil-works/pi-coding-agent@<目标精确版本>
  npm install -w @percho/backend --save-exact @earendil-works/pi-ai@<目标精确版本>
  npm install -w @percho/desktop --save-exact @earendil-works/pi-coding-agent@<目标精确版本>
  npm install -w @percho/desktop --save-exact @earendil-works/pi-ai@<目标精确版本>
  # 依赖变更后核对全部 workspace 现有声明，确认 package.json/package-lock diff 后再继续
  npm ci
  # 对 node_modules 内实际源码改动后重新生成补丁（显式包名；禁止手改 .patch）
  npx patch-package @earendil-works/pi-coding-agent
  npx patch-package @earendil-works/pi-agent-core
  npm run typecheck
  ```

- **出口**：依赖固定、补丁全部由工具重新生成且可幂等应用（删 node_modules 重装 + `patch-package` 显式包名成功）、typecheck 通过。
- **停手**：补丁上下文对不上且无法在 dist 源码中找到等价落点——说明上游结构变化超出预期，需先做适配方案评审。

### P2 上游基底验收

- **入口**：P1 出口达成。
- **允许改动**：仅"让 SDK 自身能跑起来"的最小适配（backend 启动链路、事件形状对接点）。
- **核心命令**：SDK 冒烟脚本（按目标版本更新口径）、backend 冒烟、全量 `test`。
- **出口**：SDK 在 Percho 的 backend 进程内可创建会话、收发一轮基础消息。
- **停手**：核心事件（message 流、session 生命周期）形状断裂且短期无对齐方案。

### P3 测试准备

- **入口**：P2 出口达成。
- **允许改动**：`packages/backend/test/` 新增/调整分片测试（见 §4.1 分片与 §5 分类），不改产品逻辑。
- **核心命令**：`npm test -w @percho/backend -- <新增测试文件>`。
- **出口**：分片测试就位，状态分类明确（哪些 RED、哪些 BLOCKED）。
- **停手**：无法为某个关键依赖点设计出验证测试（回到 §2.2 对照表）。

### P4 真实 message-control 分片

- **入口**：P3 出口达成。
- **允许改动**：仅 `packages/backend` 的 adapter（`packages/backend/src/session/message-control.ts` 及直接相关 backend 适配）。确需改 SDK 行为时，在授权范围内改 `node_modules/@earendil-works/pi-*` 的 dist 源码，再用 `patch-package @earendil-works/pi-coding-agent`（或 `pi-agent-core`）显式重新生成；不 renderer 产品逻辑，不改本地协议语义（以 `PLAN-session-message-control.md` 为约束）。
- **核心命令**：分片测试 + backend 冒烟（`maxWorkers=2`，见 §8）。
- **出口**：S1–S4 分片（§4.1）全部达到可判定状态，无 BLOCKED_MISSING_API 遗留。
- **停手**：出现 BLOCKED_MISSING_API 且无替代方案——回到上游提需求或重新评估版本选择。

### P5 真实 UI / 真实模型

- **入口**：P4 出口达成。
- **允许改动**：renderer 适配点（仅因 SDK 行为变化被迫的）。
- **核心命令**：Electron 开发模式冷启动 + CDP 截图/交互验收（§7）。
- **出口**：§7 全部场景通过，证据落盘。
- **停手**：真实模型行为与假模型验收结论冲突且无法归因。

### P6 跨平台 / 发布准备

- **入口**：P5 出口达成。
- **允许改动**：构建配置层面（如需）。
- **核心命令**：GitHub 原生各平台 `npm ci` 构建正式资产（不本机跨 build 替代）、`scripts/check-packaged-runtime.mjs`（只读 IPC / no provider）、验包（见 [构建发布](build-release.md)）。
- **出口**：CI 全绿、随包资源核对完成。
- **停手**：平台差异暴露出未预期的事件/路径差异。

### 4.1 可复用分片定义

分片 = 对某条真实链路的最小可验证切片。以下四个分片在 1.4.0/1.5.1 迁移中已验证可复用，升级时按当前代码路径适配断言：

| 分片 | 名称 | 验证内容 |
|---|---|---|
| **S1** | 核心路由 | backend 冷启动 → 创建会话 → 发送 → 收流式增量与完成事件 → 历史回放一致。覆盖 message-control 主链路与事件瘦身 |
| **S2** | 取消结算 | 流式中触发取消 → 后续事件不泄漏到新轮次 → 状态结算（busy 清除、pending 清理）正确 |
| **S3** | 双暂停 | host pause 与用户侧暂停并发/嵌套时，恢复顺序与事件顺序正确，无重复投递或卡死 |
| **S4** | 重试恢复 | 失败轮次 → 手动重试走 SDK 恢复生命周期 → 不重发用户任务、身份与定位一致、revision 正确递增 |

> 💡 **【核心结论 / 决策要点】** 当前仓库对应分片为 `packages/backend/test/tsconfig.message-control-sdk.json`（含 compaction / retry / lifecycle / lease / g5 / image）、`tsconfig.core-abort.json` 与 `tsconfig.session-gc-lease.json`（Host GC租约组）；升级时按新文件名适配断言，不按旧编号硬套。

> ✅ **【推荐最佳实践】** 分片测试写成独立可跑的 vitest 文件，命名带分片号（如 `test/sdk16-s1-core-routing.test.ts`），断言针对行为而非实现细节，便于跨版本复用。

---

## 5. 测试分类与红线

每个测试必须落到以下四类之一，并在报告与测试文件头标注：

| 分类 | 含义 | 处理 |
|---|---|---|
| **BLOCKED_MISSING_API** | 目标 SDK 缺失本版本依赖的接口，无法编写有效测试 | 停手归因，评估替代方案或上游诉求；**不得伪装通过** |
| **RED_BEHAVIOR** | 接口存在但行为与旧版本不一致，测试真实失败 | 记录 diff，判断是上游语义变化还是回归，逐项适配 |
| **GREEN_REGRESSION** | 实现完成后直接通过的回归验证 | 明确记录"实现后验证"，**不伪造先红后绿的 TDD 历史** |
| **INFRA_FAILURE** | 环境/基建问题（网络、端口、路径、凭证）导致的失败 | 与行为失败分开归因，修环境后重跑，不计入行为结论 |

> ⚠️ **【重要警示 / 避坑要点 / 免责声明】** 严禁通过造 stub、skip、`test.expected` failure 把 BLOCKED_MISSING_API 变绿。接口缺失就是缺失，"绿"的测试必须验证了真实行为。同样，实现后直接通过就是 GREEN_REGRESSION，不要为了"流程好看"补造先红记录。

---

## 6. 1.0.4 → 1.5.1 已验证教训

以下为本次迁移中**已实际验证**的行为结论。复用原则：**验证方法可复用，具体断言必须按当前版本重核**；patch 内容与断言不能原样搬运。

### 6.1 升级操作层

- **1.5.1 切换不是改文件名**：切换涉及包解析路径、补丁上下文与 dist 产物的整体对齐，只改版本号/文件名会导致补丁静默失配。用"删 node_modules 重装 + 幂等应用补丁"验证切换真实生效。
- **补丁可移植性**：patch 的 hunk 依赖上游 dist 精确上下文，跨版本**不能原样搬**；必须在目标版本 dist 源码中重新定位落点并重新生成。
- **测试断言可移植性**：S1–S4 的验证方法可复用，但事件字段、时序断言需按目标版本重核。

### 6.2 行为层（本次踩过并解决）

| 教训 | 结论 | 资产类型 |
|---|---|---|
| 取消闸 | 取消后须有闸门覆盖后续事件不泄漏进新轮次（以 S2 验证范围为准，不宣称任意场景"零事件"）；验证方式 = S2 | 可复用验证方法 |
| 双暂停 | host pause 与用户暂停的恢复顺序敏感；验证方式 = S3 | 可复用验证方法 |
| queue_full 无损恢复 | 队列满时的恢复路径必须无损（不丢消息、状态可结算） | 可复用验证方法 |
| prompt grant 泄漏 | 权限授予（grant）在轮次切换/取消后可能泄漏到后续轮次，需显式结算 | 行为适配点，断言需重核 |
| hostAwaitingUser 微任务活锁 | host 等待用户状态下可能形成微任务循环，表现为看似卡死；需识别该状态并打破循环 | 行为适配点 |
| source 保护 | 事件来源标记在压缩/恢复链路上需保护，防止来源被错误覆盖 | 断言需按当前版本重核 |
| prepared 一次性授权 | prepared 请求/授权是一次性语义，不可重复消费；重试与恢复路径需重新授权 | 行为适配点 |

> 💡 **【核心结论 / 决策要点】** 判别"可复用资产"的标准：验证方法（怎么测）可复用；断言（测出什么值）与 patch hunk（怎么改上游）不可盲搬。每次升级对 §6.2 表格逐行重验。

### 6.3 1.5.1 迁移新增经验（工程与环境层）

| 教训 | 结论 |
|---|---|
| ACK 受理 ≠ commit | 消息受理（ACK）不等于提交完成；preprompt 的 auto / 手动 / postrun 三类入口行为不同；early queued 需 postpublish 存活复核，并配套 async receipt 失败卡、去重与 stale 保护 |
| idle-lease 单测 ≠ 宿主 GC | SDK idle-lease 单测不代宿主 GC；GC 预检与 `await shutdown` 之间须核原子互锁。本方竞态已定向复现并确证修复（§19.14）：`closeSession` 仅 `intent="gc"` 在首个 await 前同步 `tryAcquireIdleLease()`，无租约 `closed:false`，有则 try/finally 包 dispose 释放；`user`/`delete` 不取租约 | 已验证修复（断言需按新版本重核） |
| 宿主GC fixture 经验 | 验证宿主 GC 竞态用真实 PiBackend + 真实 `AgentSession`，以真实扩展 `session_shutdown` 门闩把 GC 停在 await 上，再从外部提交观察是否 `busy`；预热场景用公开配置（`cacheWarming:"idle"` + 模型 `promptCache` TTL）驱动真实 CacheWarmer，观察公开 `cacheWarmingStatus`，模型流用内存 stub，不伪造私有字段；预热 pending 期间 GC 会被延后（`closed:false`），off 后可 GC | 可复用验证方法 |
| 测试不在产品 typecheck 内 | 产品 tsconfig 只 include `src`，`test/*.ts` 不在根 typecheck 内；宿主 GC 等新测试组需按仓库先例新增专用 strict 入口（如 `test/tsconfig.session-gc-lease.json`）由 CI 显式调用，stub 缺失会让用例抛 TypeError，不许 `?.` 绕过 | 工程约束 |
| 版本来源固定 | 上游版本固定用 origin/tag 来源（如 `87476fa1` = v0.6.8，SDK 1.5.1）；fork 同名 tag（如本地 v0.6.6）不同，不能冒充上游 |
| 候选 hash ≠ Git 提交 | 候选 hash / 源码 ZIP 不是 Git 提交，不能混入无关 Plan 的取证链 |
| 源 auth 变化归因 | 源 auth 变化无 PID 不能归因到别的会话或 OAuth；改后 baseline 不消历史异常 |
| 环境白名单 | 独立 HOME / agent / userData / TEMP + 白名单；权限测试中 TMP 父目录碰 HOME 祖先可能得到精确路径提示，不能借机削弱权限 |
| packaged NODE_OPTIONS | packaged 环境不保证 NODE_OPTIONS 生效；Node hook 不是 OS 沙箱 |
| asar 读取 | `@electron/asar` 的 JS API `extractFile` 返回 Buffer，优于 CLI 的 cwd 写出；避免覆盖根 `package.json` |
| 打包构建归属 | GitHub 原生各平台 `npm ci` 构建正式资产；不本机跨 build 替代。`--dir` 正常缺更新配置不当 installer PASS；`--prepackaged` 缺 `app-update.yml` 可能是探针，逐项归因 |
| packaged 运行时验收 | `scripts/check-packaged-runtime.mjs` 只读 IPC / no provider；Win 18/18 通过，Linux/mac 待远端 |

> ⚠️ **【重要警示 / 避坑要点 / 免责声明】** 上表为 1.5.1 迁移中的经验记录，复用前逐项按当前版本重核；未标注"已修"的项不写已修，只写风险状态。

---

## 7. 真实环境验收

P5 阶段的验收清单。每一项通过的证据（CDP 截图、trace、日志）落 `$EVIDENCE`。

### 7.1 backend 冷启动与契约

- **backend 冷启动 ControlResult 契约**：冷启动后第一轮消息的 ControlResult 形状（字段、状态码、错误通道）与 shared 契约一致。
- **Electron 开发 host 固定 `127.0.0.1`**：开发环境 host 必须固定 `127.0.0.1`（避免 IPv6 `::1`/localhost 解析不一致导致 backend 连不上）。若连接失败，先核对 host 绑定与端口探针，不要先怀疑 SDK。
- **真实模型与假模型的边界**：分片测试允许用假模型/回放验证确定性；**轮次结算、错误分类、压缩触发**等时序敏感行为必须以真实模型验收为准。假模型通过 ≠ 真实通过，反之亦然——两类结论分开记录。

### 7.2 功能场景清单

| 场景 | 验证点 |
|---|---|
| queue / steer / interrupt | 排队消息、转向注入、打断的结算与顺序 |
| 压缩 | 自动/手动压缩触发、来源标记、压缩后历史回放 |
| held / recover / resend | 挂起消息、恢复、重发的状态机 |
| revision / retry | 版本号递增、手动重试走恢复生命周期 |

### 7.3 证据采集

- CDP 交互验收与截图：`scripts/cdp-eval.mjs`、`scripts/cdp-shot.mjs`（参数以脚本文件头为准）。
- 每个场景记录：时间、命令、结果、证据文件相对路径。

---

## 8. 命令模板与证据目录

> ⚠️ **【重要警示 / 避坑要点 / 免责声明】** 以下 `$EVIDENCE`、`$VALIDATION_HOME`、`$SNAPSHOT_HOME` 均为变量示例，**禁止把任何本次迁移用过的临时目录写成本手册的永久路径**。每次升级自建目录并在 HANDOFF 记录实际路径。

### 8.1 Windows PowerShell 命令模板

> ⚠️ **【重要警示 / 避坑要点 / 免责声明】** 以下命令均按当前仓库 scripts（`npm ci` / `npm run typecheck` / `npm run lint` / `npm test -w <workspace>`）写，不使用 vitest `--project` 参数（本仓 vitest 不是 project 入口）。依赖变更后核对全部 workspace 声明，不要自动往根加依赖。

```powershell
# 环境变量示例（每次升级自定实际路径）
$env:EVIDENCE        = "<仓库外证据目录>"
$env:VALIDATION_HOME = "<仓库外独立验证目录>"
$env:SNAPSHOT_HOME   = "<仓库外快照目录>"

# P0/P1：workspace 内精确固定依赖（不用 ^ ~），逐个更新
npm install -w @percho/backend --save-exact @earendil-works/pi-coding-agent@<目标精确版本>
npm install -w @percho/backend --save-exact @earendil-works/pi-ai@<目标精确版本>
npm install -w @percho/desktop --save-exact @earendil-works/pi-coding-agent@<目标精确版本>
npm install -w @percho/desktop --save-exact @earendil-works/pi-ai@<目标精确版本>
# shared 也声明 SDK：按其现有 dependencies/devDependencies 归属更新，不遗漏，不另加根依赖
# 依赖变更后核对全部 workspace 现有声明，确认 package.json/package-lock diff 后再继续
npm ci
# 对 node_modules 内实际源码改动后重新生成补丁（显式包名；禁止手改 .patch）
npx patch-package @earendil-works/pi-coding-agent
npx patch-package @earendil-works/pi-agent-core

# 专用 tsc 检查（不跑整仓构建链；workspace 相对路径）
npm exec -w @percho/backend -- tsc -p test/tsconfig.message-control-sdk.json
npm exec -w @percho/backend -- tsc -p test/tsconfig.core-abort.json
npm exec -w @percho/backend -- tsc -p test/tsconfig.session-gc-lease.json

# 全量静态检查（全部 workspace）
npm run typecheck
npm run lint

# backend 测试：限制并发，避免多进程 SDK 会话互扰
npm test -w @percho/backend -- --maxWorkers=2

# desktop 测试
npm test -w @percho/desktop -- --maxWorkers=2
```

### 8.2 冷启动探针原则

任何"启动即探活"的脚本遵循：**独立 HOME/agent 目录 → 固定 `127.0.0.1` → 探针超时即失败并输出进程日志 → 不复用正式会话数据**。探针失败先归因 INFRA_FAILURE 还是 RED_BEHAVIOR（行为失败），再决定下一步。

### 8.3 证据目录规范

```text
$EVIDENCE/
  00-snapshot/          # §3 快照清单与 SHA256
  p0-baseline/          # 基线命令输出
  p4-shards/            # S1–S4 测试输出
  p5-real/              # 真实模型 + CDP 截图
  p6-ci/                # CI 日志
  report.md             # 最终报告（§10 模板）
```

目录内文件命名 `YYYYMMDD-<阶段>-<主题>.<ext>`；报告中的证据引用写相对路径。

---

## 9. 切换判定

### 9.1 开发主工作区切换（经用户批准后可先于发布完成）

> 💡 **【核心结论 / 决策要点】** 开发主工作区切换与正式发布是两道闸，门槛不同：开发切换经用户批准 + 隔离验证后即可做；正式发布需**全部平台证据**齐备。

- **门槛**：P0–P5 出口达成（无 BLOCKED_MISSING_API 遗留）、RED_BEHAVIOR 全部归因并解决或经评审接受、独立 verifier（未参与本升级实现的 Agent/工程师）复核报告与证据、隔离验证目录内结论与主工作区一致。
- **经用户批准**：切换主工作区开发依赖是授权动作，不是验证完成后的自动结果；切换后重跑全量 CI（typecheck / lint / test），不复用验证目录结果。
- **注意**：开发主工作区切换**不等同于正式发布**；跨平台/打包证据不是开发切换门槛，但必须在发布前补齐。

### 9.2 正式发布门槛（全部平台证据齐备）

1. P6 全部出口达成：GitHub 原生各平台 `npm ci` 构建正式资产，不本机跨 build 替代；
2. 三平台打包验收通过（`scripts/check-packaged-runtime.mjs` / [build-release.md](build-release.md) 口径）；`--dir` 正常缺更新配置不当 installer PASS；`--prepackaged` 缺 `app-update.yml` 可能只是探针，逐项归因；
3. 真实模型验收（§7.2）全通过，假模型结论不替代；
4. CI 严格模式（strict3，含 Host GC lease 入口）、macIntel+ARM 矩阵与“成功发布闸”仅静态通过时，不算三平台 PASS——发布闸以真实平台证据为准。

### 9.3 失败归因

任何阶段失败，报告中必须给出唯一归因分类：

| 归因 | 处置 |
|---|---|
| 上游语义变化（需适配） | 写适配方案，回到对应阶段 |
| 上游能力缺失（BLOCKED_MISSING_API） | 上游诉求或回退版本选择 |
| 自身回归 | 修复后重跑该阶段 |
| INFRA_FAILURE | 修环境，重跑，不计入行为结论 |

### 9.4 切换动作与回退

- **通过（开发切换）**：在主工作区以条件切换方式合入（保留旧版本 lockfile/补丁快照以便回退）；切换后**重跑 CI 全量**（不是复用验证目录结果）。
- **通过（发布）**：仅 §9.2 门槛全部满足后，按用户明确指令走发版流程。
- **不通过**：保留旧基线不动，仓库恢复到快照状态（用 §3.1 的 SHA256 核对），验证成果留在验证目录归档。
- **禁止自动 `commit` / `push` / `release`**：切换与发版均需用户明确指令，遵循项目 Git 与发版约定。

---

## 10. 最终报告模板

升级完成（或中止）时，按下表落 `$EVIDENCE/report.md`：

```markdown
## SDK 升级报告：<旧版本> → <新版本>

- 日期 / 执行者 / 目标 commit：
- 验证目录 / 证据目录：

| 阶段 | 结果 | 出口证据 |
|---|---|---|
| P0 基线 | ✅/❌ | |
| P1 固定依赖+补丁 | ✅/❌ | |
| P2 上游基底 | ✅/❌ | |
| P3 测试准备 | ✅/❌ | |
| P4 分片 S1–S4 | ✅/❌ | |
| P5 真实 UI/模型 | ✅/❌ | |
| P6 跨平台/发布 | ✅/❌ | |

### 基线对比
- 旧版本基线：typecheck/test/lint 结果
- 新版本结果：

### 改动清单
- package.json / lockfile：…
- patches/（全部由 patch-package 生成）：…
- backend 适配：…（逐文件）
- renderer 适配：…（逐文件）

### 测试统计
- Passed（GREEN_REGRESSION / 回归通过）：N
- Inspected（人工检视项）：N，清单：
- Not run（未覆盖项，含原因）：N

### 阻塞与风险
- BLOCKED_MISSING_API：无 / 列表
- 接受的 RED_BEHAVIOR 及评审结论：
- 遗留风险：

### 下一步
- [ ] 切换主工作区 / 保留旧基线
- [ ] 切换后重跑 CI
- [ ] 用户确认后 commit / release
```

---

## 关联文档

- SDK 行为与已知反直觉结论：[sdk.md](sdk.md)
- 生产适配边界：[architecture.md](architecture.md)
- 构建与验包：[build-release.md](build-release.md)
- 历史方案：`docs/PLAN-sdk-1.5.1-upgrade.md`
