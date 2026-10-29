---
类型: 实施方案
状态: 三项体验修订已实现并通过完整重启验收
创建: 2026-10-26
更新: 2026-10-29
适用: Percho 桌面端左侧会话悬停详情卡的子代理父子关系展示与跳转
---

# 会话悬停详情：子代理父子关系

> **结论：复用悬停预览 IPC；持久化分支与实时候选在后端统一校验、去重、计数后截断。renderer 只展示后端认可的六行，不直接追加未经校验的实时路径。**
>
> 用户已批准“按审查建议更新文档，然后执行”。本文是实施契约，不代表功能、测试或实机验收已经完成。实施结果另记于文末，未经授权不提交、不推送、不发版。

| 项目 | 说明 |
| --- | --- |
| 前置功能 | [会话悬停详情](PLAN-session-hover-details.md) |
| 审查基线 | 根版本 `0.7.4`，HEAD `bfcc011` |
| 原 D1（§12 替代） | 六条改为默认首屏数量，提供按需“显示更多 / 收起” |
| 已批准 D2 | 跟随当前分支；撤回派工后关系消失，不删除子文件 |
| 原 D3（§12 扩展） | 内存关系仍可复用；插件反向关系可从已保存文件安全恢复，不依赖先点父会话 |
| 本轮授权 | 先修正文档，再实施、测试；保留已有工作区改动 |

## 一、目标与边界

悬停左栏普通会话时，在首条提问与元数据之间增加“创建的子会话”和可选“父会话”。每个子行包含状态点、子代理名、安全任务首行及右侧 ↗；整行可点击，以**被悬停会话**为父打开子会话：内置仍只读，pi-subagents 保持普通会话属性与侧栏独立条目。

- 悬停不改变 activeSessionId、不创建/加载会话实例、不调用模型、不写文件。
- 不做工作流画布、消息合并、AI 摘要、停止/重试、插件槽位扩展或 LAN 界面改造。
- 不改执行器开关、模型配置、子代理命名、SDK 文件格式。
- 默认第三方兼容是“识别结果结构”；只有文件位于当前 agentDir 的 `sessions-subagents` 安全目录且实际存在时才提供入口，不承诺所有第三方执行器都会产生可导航路径。
- 不把 `done` 表述成业务验收成功。

## 二、已核实事实与审查修正

| 事实 / 缺口 | 证据与修正 |
| --- | --- |
| 父→子已持久化 | toolResult.details 中的 results/artifactPaths.jsonlPath 等可由 `extractSubagentRuns` 提取；支持 results、completions 和 Agent 扁平形态 |
| 子文件没有可靠父指针 | 复用 `stores/subagent-return.ts`，重启丢失父入口是已批准边界 |
| 预览已有 8 MiB 和当前分支校验 | `session/title-preview.ts`；同次读取/解析，不重复读取父文件、不读取子文件正文；存在性和真实路径校验仍增加元数据 IO |
| renderer 判别字段不是 role | `UIMessage.kind === "subagent"`；运行中数据还在 `streaming.subagentRuns`，路径由 tool_execution_update 回填 |
| 不能直接合并 transcript 路径到界面 | transcript 可保留已删文件或目录外路径，必须送后端校验；已提交消息只能覆盖当前分支已有关系，不新增关系 |
| 六行 + hidden 不能支持前端精确合并 | 被隐藏项的身份丢失，必须在后端完整候选集合上合并再计数截断 |
| safeUserFirstLine 不自带长度上限 | 128 KiB 原在调用方；关系任务字段必须显式检查 UTF-8 字节数，不能依赖 CSS |
| 提取器可能把路径当 agent | 缺名称但有 sessionFile 时 agent 回退为路径；关系投影改用通用名称，禁止透传该回退 |
| 原路径判定只是词法前缀 | Windows 包含校验和去重都须忽略大小写；真实文件校验需 realpath + regular-file 检查，不把词法判定当完整安全保证 |
| 导航有微任务竞态守卫 | 新入口保留 `isLatestNavigation(result.token)`，不能只看已返回的 latest |

审查时只读探针已确认：运行中 messages 可以为空但 streaming 有带路径的 running 项；safeUserFirstLine 接受 131073 字节单行；缺 agent 会回退路径；Windows 原始大小写可通过而变体被旧谓词拒绝。以上不是新功能验收。

## 三、数据流与核心决策

```text
Provider 实际打开卡片
  → 从当前目标 transcript 投影窄 liveRuns（已提交 kind=subagent + streaming.subagentRuns）
  → sessionHoverPreview.setTarget(meta + liveRuns)
  → 既有 session:hoverPreview({ sessionId, cwd, liveRuns? })
  → 后端身份/父文件预算/整树校验
  → 当前分支持久化关系 + 已加载会话的实时候选
  → 安全投影、目录/真实文件校验、统一去重、排序、计数、截断
  → relations.children ≤ 6，hidden = max(0, 总数 - 6)
  → Card 仅渲染这个结果，不再合并原始 transcript
```

仍只有一个预览 IPC 通道、一个全侧栏在途槽和一套缓存；请求增加可选 liveRuns，不新增关系查询通道。main 的对象到后端参数适配需要传递新增参数，preload/通道名不变。

### 3.1 实时来源与权限

- `collectSessionHoverLiveRuns` 读取当前目标的 `messages` 中 `kind === "subagent"` 的 runs，并读取 `streaming?.subagentRuns`。按原先后顺序，streaming 在末尾。
- **committed 候选只覆盖持久化当前分支已存在的同路径行状态，不允许补出新关系。** 因此撤回或删除不能靠旧 transcript 复活。
- **streaming 候选可补出尚未落盘的关系**，但只在父会话已注册且身份一致时采用；未加载父会话忽略实时候选。每条也必须通过同一套路径/存在性/投影校验。
- 前端只传窄字段，不传 token、工具输出、完整消息等；task 先投影成安全首行，再由后端复核。路径未回填时不发送候选、不显示可点击假行。
- 普通历史缺退出信息时仍为 unknown。实时 done 只有 exitCode 明确为 0 才升级，error/running 可依据已知实时状态；不因历史回放默认 done 而猜测成功。
- 所有实时候选随目标请求快照发送；失效、撤回、换目标后的旧响应不得发布到新卡片。

### 3.2 收集、排序与计数

1. 整树校验后沿 leaf/parentId 得当前分支；从老到新提取 toolResult 的 runs，按结构而非工具名识别。
2. 畸形 details 按条隔离，不能使其他关系或预览整体失败。无关结构跳过。
3. 使用规范化绝对路径作键，Windows 忽略大小写；同路径保留分支上最新结果。
4. 应用 committed 状态覆盖，不改变派工排序；再合并 streaming，streaming 优先且最新在前。
5. 对最终候选统一做安全文件检查，每个规范化路径每次查询只检查一次；使用有界异步并发（最多 16），避免大量 existsSync 阻塞主进程。
6. 丢弃非法/失效项后才算总数、取六条、计算 hidden。不在 renderer 再增行或重新估算 hidden。

## 四、类型与安全契约

在 `packages/shared/src/session.ts` 定义并导出：

```ts
export interface SessionHoverLiveRun {
  sessionFile: string;
  agent: string;
  task?: string; // 已安全投影的首行，后端仍复核
  status: "running" | "done" | "error";
  exitCode?: number;
  source: "committed" | "streaming";
}
export interface SessionHoverPreviewRequest {
  sessionId: string;
  cwd: string;
  liveRuns?: SessionHoverLiveRun[];
}
export interface SessionHoverRelationChild {
  sessionId?: string;
  sessionFile: string;
  agent: string;
  taskFirstLine?: string;
  status: "running" | "done" | "error" | "unknown";
  createdAt?: number;
}
export interface SessionHoverRelations {
  children: SessionHoverRelationChild[];
  hidden: number;
}
// SessionHoverPreviewResult 的三个 variant 均加 relations?: SessionHoverRelations。
```

### 4.1 投影

- 共享纯函数放 `packages/shared/src/session-hover.ts`：安全首行、任务字节上限、名称脱敏、liveRuns 窄投影。原 `safeUserFirstLine` 行为保持不变，backend 可重新导出以兼容旧调用；**关系用单独有界 wrapper**。
- task 首行大于 128 KiB、Skill 不安全、包含导航目标路径等不可安全投影情形 → 省略字段，不截断伪装成完整内容。
- agent 缺失、等于导航路径或呈绝对路径形态 → 使用 `subagent`；不得把提取器的路径回退渲染进 DOM/aria/title。
- sessionFile 仅用作内存导航目标/React key，不放 DOM 属性、title、可访问名或新增日志。既有通用打开链路日志不属于本次新增 DTO 日志，不能宣称全系统不记录路径。
- 文件名最后 `_` 后的 id 按 `/^[0-9a-fA-F-]{8,}$/` 校验，失败省略；不读取子文件正文以取 id。
- 持久化状态：exitCode=0 → done，非零 → error，缺失 → unknown。实时状态按 §3.1 处理。
- createdAt 仅接受有效 entry timestamp；不伪造时间。

### 4.2 文件安全

新增轻量路径模块，runner 复用/重新导出词法根目录与判定，避免 preview 引入整套 runner 依赖。

- 必须是子根目录的**后代文件**，不接受根本身、目录、非 jsonl、空路径或目录外路径。
- Windows 的目录包含与键比较都忽略大小写；其他平台保持大小写敏感。
- `realpath(file)` 必须仍位于 `realpath(root)` 下，stat 必须为普通文件；符号链接/junction 指向根外时拒绝。
- 查询返回规范化的可导航路径；打开链路对词法位于子根下的目标再次验证真实路径与文件类型，之后仍按子会话只读打开。防止悬停后文件被删除或链接被替换时直接跳过校验。
- 不把一次 stat/realpath 当成操作系统级防竞态沙箱；本次不重构 SDK 文件句柄打开模型。
- 普通历史文件的既有打开行为不变；不把全局 openSession 改成只接受子会话。

### 4.3 预算与失败语义

- 父文件/内存历史原 8 MiB 上限不变。liveRuns 单独按 JSON UTF-8 预算最多 8 MiB；前端投影超预算后不发送该批，后端仍复核直接 IPC 输入，超预算明确 `limit_exceeded`，不返回部分关系。
- 关系收集发生在首条提问投影前。提问 unsafe_projection 或首行超限时可保留已验证 relations；父历史超限、身份不符、坏树时不返回 relations。
- 无任何合法关系时允许省略 relations，保持旧无关系响应与既有测试兼容；Card 同等处理缺失与空 children。
- IPC 异常保留基础卡片，关系不展示。坏条目隔离，不打印原始路径或任务。

## 五、缓存与导航

### 5.1 缓存

`SessionHoverPreviewTarget` 加可选 liveRuns；缓存 key 加其稳定窄字段签名，未提供/空数组按同一值处理。缓存继续容量 100、成功/空 30 秒、失败 5 秒、单在途、绝对 TTL。

Provider 在卡片打开时订阅目标 transcript，只有关系签名变化（路径回填/状态/分支），才设置新目标，不随 token 输出逐字重读。保留现有 messages/agentActive 生命周期失效守卫。Card 必须按包含同一 liveRuns 签名的 key 取结果（可由 Provider 传入 target，不能两处使用不同键）。

删除文件不改父元数据时，至多在下一次查询/30 秒 TTL 刷新后消失；不能承诺即时文件系统推送。后端过滤后前端不再补回，关闭卡片后没有轮询。撤回重载替换当前分支与 liveRuns，并作废旧在途响应。

### 5.2 显式父目标

```ts
openSubagentSessionFrom(
  parent: { sessionId: string; sessionFile?: string },
  filePath: string,
): Promise<OpenFromHistoryResult>
```

入口同步复制父 id/file；成功、latest 为 true 且提交前 `isLatestNavigation(result.token)` 仍成立才记关系。空父 id 不写关系；不建立 child→自身。原 openSubagentSession 同步捕获 active 父后调用新入口，保留原行为与竞态测试。

```ts
onDismiss(); // 不恢复旧触发行焦点
void withSessionSlide("push", () => openSubagentSessionFrom(
  { sessionId: session.sessionId, sessionFile: session.sessionFile },
  child.sessionFile,
));
```

父入口用 `useParentTarget(childId)` 和 `withSessionSlide("pop", () => returnToParent(childId))`，同样先 dismiss。父标题从内存 sessions/项目历史查找，未知时使用本地化通用标题，不展示 parentFile。父卸载时现有 parentFile 重开；失败由统一链路 toast。

## 六、UI 与可访问性

- 顺序：标题/状态 → 首条提问 → 创建的子会话 → 父会话 → 元数据 → 键盘提示。
- children 非空才显示区块；父关系存在才显示父区块。最多六条与纯文本隐藏计数，不加内部滚动。
- 整行 button，左对齐、rounded-md、hover:bg-hover、px-1.5 py-1；名称首字母大写，长名称允许收缩换行，任务 line-clamp-2 + overflow-wrap:anywhere。
- 状态点 7px：done=bg-ok、error=bg-err、running=bg-accent，unknown=bg-ink-dim。running 使用 `motion-safe:animate-pulse`，减少动态时不呼吸。
- 右侧 ArrowUpRightIcon 14px、aria-hidden。aria-label 包含打开动作、名称和可选安全任务首行，不含路径；状态提供中性可访问说明，不只依赖颜色。
- 保留 Provider 的 capture 豁免、Tab 序、Esc 与焦点控制。新增 `onDismiss` 与原关闭按钮 `onClose` 分离，导航不恢复触发行焦点。
- zh/en 同时补 children、childrenHidden、parent、openChild、openParent 及必要中性状态/未知标题词条；不硬编码中文拼接模板。
- 沿用主题、整卡滚动、贴底翻转、600px 窗口适配与现有设置开关。不新增外部设计体系。

## 七、改动边界

| 模块 | 文件与职责 |
| --- | --- |
| shared | session.ts 类型；session-hover.ts 安全投影/live 候选；index.ts 导出 |
| backend preview | session/title-preview.ts 当前分支提取、异步校验、统一合并计数；保留原身份/预算校验 |
| backend paths | 新轻量子会话路径模块；runner.ts 仅复用/重新导出路径函数，不改执行逻辑 |
| backend 接线 | pi-backend.ts 传 liveRuns、未加载时忽略；子路径 openSession 二次安全校验 |
| desktop main | ipc/sessions.ts 传可选 liveRuns；补 IPC 透传测试；不新增通道、不改 preload 实现 |
| renderer 数据 | session-hover-preview.ts key/请求；sessions.ts 显式父入口；subagent-return.ts 只读选择器 |
| renderer UI | SessionHoverProvider.tsx target 接线；SessionHoverCard.tsx 区块/导航；icons、zh/en |
| 测试 | backend 预览/路径/打开；shared 投影/reducer 来源；renderer 缓存/导航/卡片/Provider；main IPC；`scripts/test-session-hover-dom.mjs` 独立 Electron DOM 冒烟 |
| 文档 | 本方案及 docs/INDEX.md 既有索引引用；不回改旧方案结论 |

## 八、测试与实施顺序

先写关键失败用例并运行 RED，再实现对应逻辑。不得为了“全红”强迫原已满足的安全条件失败。

### 8.1 后端与共享

- B1–B12：单条结果、根外、失效文件、最新引用去重、九条截断、非当前分支排除、非零 exitCode、completions、无关/畸形结构、unsafe 提问保留关系、父超限拒绝、内存/文件一致。
- B13：隐藏项与实时项重叠，精确计数；streaming 真新增计数加一；committed 不能新增分支不存在项。
- B14：删除后仍有 transcript 候选不能复活；目录外候选拒绝；未注册会话忽略候选。
- B15：任务 128 KiB 边界/中文 UTF-8/超限/Skill，缺 agent 只有 sessionFile 不泄漏。
- B16：Windows 包含和去重大小写一致；非 Windows 敏感；目录/非 jsonl 拒绝；根外符号链接/junction 拒绝。
- B17：打开前二次安全校验；普通文件打开不受影响；错误信息不新增路径日志。
- B18：真实 reducer 的 tool_execution_start/update/end/turn_end，messages 为空时 streaming 带路径候选；固化后无重复；缺路径不产行。
- B19：liveRuns 非法结构和超预算，失败关闭；共享窄投影不发送完整任务/输出。

### 8.2 renderer / IPC

- R1–R5：关系显示/隐藏、六行与计数、被悬停父目标、缺字段降级、DOM/title/aria 不含导航路径。
- R6：实时字段经 IPC 请求送校验，返回前不能显示原始候选；后端拒绝后始终不显示。
- R7：父关系和标题回退、先关闭再导航、不恢复旧锚点焦点。
- R8：latest=false、失败、latest=true 但 token 已变、空父、自引用都不写假关系；原卡片行为不回归。
- R9：同 meta 的 live 路径/状态变化刷新；无关 token 不改变 key；旧 live 签名响应不覆盖新签名；撤回/TTL/开关/单在途不回归。
- R10：main/preload 原请求兼容，新 liveRuns 透传；各结果 variant 的 relations 无损返回。
- R11：新增行真实 DOM Tab/Shift+Tab/Enter/Esc/外点行为，SSR 不冒充事件验证。

### 8.3 自动检查

按实际测试落点运行 backend/shared/desktop 相关 Vitest、backend/shared typecheck、desktop web/node tsc。先对改动文件做主动 LSP diagnostics；不可用不当作通过。区分基线与新增错误，不顺带改无关模块。

### 8.4 实机验收（未执行前不得勾选）

- [x] 加载本次源码的 Electron，悬停非 active 父会话，子区块与六行计数正确（真实开发版 + 明确标注的演示 JSONL）。
- [x] 点子行先关闭卡片并只读打开，使用子页已有返回按钮回到正确父会话，包括父已卸载。
- [x] 插件子会话悬停父入口在真实应用可达，普通独立侧栏条目保留（§11）。内置只读子会话仍遵循原隐藏规则。
- [ ] running 路径回填后出现，结束状态更新；撤回后消失。
- [ ] 删除文件后下次刷新消失，不能被实时候选复活。
- [ ] Tab/Shift+Tab/Enter/Esc、深浅主题、600px 窗口、贴底翻转、减少动态均可用。
- [ ] 关闭悬停设置不发请求；不使用旧安装包截图冒充新构建。

### 8.5 实施阶段

1. 更新方案（本轮已获执行授权）。
2. 后端/共享/IPC 安全数据链 + 测试；显式父入口 + 测试。
3. Provider/cache 与卡片展示接线 + 测试。
4. 独立检查实际 diff、运行验证、记录实机覆盖与缺口。
5. 仅交付本次授权改动，不 commit/push/tag/发版。

## 九、风险与回滚

- 父历史仍需有界全量解析；子路径多时元数据 IO 增加，异步并发受限、路径先去重、缓存减少重复查询。不改成仅扫描 subagent 工具名的路径，以免破坏结构兼容与当前分支语义。
- 安全检查与 SDK 打开之间仍存在文件系统竞态边界，本次不宣称提供恶意本地进程隔离。
- 第三方缺路径、根目录不同或退出信息缺失时诚实降级，不猜父关系、状态或文件位置。
- 回滚可撤下两个区块与可选 relations/liveRuns 链路；显式父入口、安全投影和路径校验可独立保留，但必须保留相应测试。

## 十、执行结果（2026-10-29）

### 10.1 已落地

- 当前分支持久化关系与实时候选经同一后端安全校验，统一去重、排序、计数后取六条。
- committed 候选不能补回被撤回关系；失效或目录外文件不会通过实时合并复活。
- 安全首行共享化，关系任务显式限制 128 KiB；路径名称回退和包含导航目标的任务不展示。
- Windows 包含/去重大小写兼容，普通文件/真实根目录检查，子路径打开前再次校验。
- 显式被悬停父目标、提交前导航 token 守卫、内存父关系与历史父标题回退。
- 关系行、隐藏计数、父入口、双语文案、状态可访问描述；导航关闭与普通关闭焦点恢复分离。
- 实时候选签名纳入缓存和 Card 相同 key，Provider 窄订阅避免无关 token 触发请求。

### 10.2 实际验证记录

| 验证 | 结果 / 边界 |
| --- | --- |
| 实施前类型基线 | backend/shared、desktop node/web 四项均通过 |
| 新增反例 RED → GREEN | 补充后端关系用例先复现排序、投影等缺口，修正后 12 项通过 |
| backend 全套 | `npm run test -w packages/backend`：89 文件、901 项通过；最后绝对路径小改后又做下行窄回归 |
| backend 最终窄回归 | 预览、关系、路径、打开幂等与 subagent-agents 共 5 文件、56 项通过 |
| renderer/main 最终回归 | 侧栏、缓存、父子导航、sessions、main IPC 共 8 文件、178 项通过 |
| shared 窄测试 | `vitest run packages/shared/src/session-hover.test.ts`：3 项通过 |
| 最终类型检查 | backend/shared/desktop node+web 全部通过 |
| 桌面构建 | `npm run build -w packages/desktop` 通过；未打安装包、未替换当前运行的安装版 |
| 格式与补丁 | 限定改动的 Biome 检查无 error，保留 informational/unsafe 建议未自动套用；`git diff --check` 通过 |
| 主动 LSP | 当时检查 7 文件，2 个确认 clean、5 个服务器无法确认，未把静默视为通过；以实际 tsc 补足类型检查 |
| 独立 verifier | 最终 PASS，未确认 P1/P2；独立复跑 backend 15 项、renderer/main 49 项及 DOM 冒烟 |

主要复验命令（仓库根执行）：

```sh
npm run test -w packages/backend
npm run test -w packages/backend -- test/session-hover-preview.test.ts test/session-hover-relations.test.ts test/session-subagent-paths.test.ts test/open-session-idempotency.test.ts test/subagent-agents.test.ts
npm run test -w packages/desktop -- src/renderer/src/components/sidebar/ src/renderer/src/stores/session-hover-preview.test.ts src/renderer/src/stores/subagent-return.test.ts src/renderer/src/stores/sessions.test.ts src/main/ipc/sessions.test.ts
./node_modules/.bin/vitest run packages/shared/src/session-hover.test.ts
npm run typecheck -w packages/backend
npm run typecheck -w packages/shared
npm run typecheck -w packages/desktop
npm run build -w packages/desktop
node scripts/test-session-hover-dom.mjs
git diff --check
```

### 10.3 Electron DOM 覆盖与未覆盖

`node scripts/test-session-hover-dom.mjs` 在独立临时 profile 的 Electron 窗口中加载**当前组件源码与实际构建 CSS**，不打开用户历史，不调用真实模型；退出后清理测试 profile。主代理与 verifier 均跑过，13 项断言通过：

- 六行与隐藏计数、历史父标题、导航路径不进入 DOM、读屏状态描述；
- 实际 CSS 两行截断、600px 视口定位；
- 原生 Tab 进入 Portal、Tab 到首按钮、Shift+Tab 返回触发行、末尾 Tab 离开；
- 原生 Enter 使用被悬停父目标导航、Esc 关闭；
- streaming 候选进入请求，无关 token 不新增请求；设置打开后浮层关闭（等待条件）。

**本节隔离 DOM 测试不是完整应用与真实 backend 的端到端验收。** fixture 的 IPC 返回与导航落点使用模拟数据/动作，不能据此声称整条实机链路通过；之后真实开发版的部分联调与新发现见 §10.4。

### 10.4 真实开发版演示与缺口（2026-10-29）

用户要求在开发版查看效果。本次另开真实 `electron-vite dev` 窗口（页面端口 9224、main inspector 9229），userData 为独立的 `.local/agent-work/probe/hover-demo/user-data-dev`，不关闭已有开发版、不替换安装版。使用 `~/.pi/agent-dev` 下新建且明确标注“演示样例”的两个普通会话、九个子会话文件；样例由 SDK 写入，**不代表真实模型派工**，不模拟 IPC/后端返回。样例保留供用户查看。

已实测：

1. 当前页面不是父会话时，悬停父行仍显示正确六条和“还有 3 个子会话未显示”。
2. 点击子行后真实后端打开子文件，meta.readOnly 为 true，composer 明示只读；内存父关系指向被悬停父而非原 active。
3. 使用子页原有“返回父会话”按钮能回到正确父；显式 GC 卸载父后再次返回，也能按父文件重新打开。
4. 实机发现 `bg-danger` 不是本项目主题 token，导致错误状态点透明；改为 `bg-err`，实测浅色背景色 `rgb(214, 53, 44)`。补充真实颜色回归后 DOM 冒烟 14 断言通过，卡片测试 29 项及 desktop node/web typecheck 通过。

**尚未完成的功能入口：** `lib/session-visibility.ts` 的 `isPrimaryNavigationSession` 和 `lib/sidebar-groups.ts` 明确过滤 `readOnly: true` 的会话，因此打开的内置子会话不会形成侧栏行。新增 Card 内“父会话”区块虽然在隔离组件测试可渲染，但在真实 Sidebar 无触发锚点，不能宣称该入口已经可用。前次审查与隔离 fixture 未覆盖这个导航投影边界，是本次实机补验发现的遗漏。

本轮没有为了截图伪造侧栏项或把 readOnly 改成 false，也没有擅自推翻既有子会话隐藏规则。需用户对齐“继续隐藏，只用子页返回”或“允许当前打开的子会话临时出现在导航中”等交互方向后再实施；现有父→子入口和子页原有返回可用。

证据（本地）：
- `.local/agent-work/probe/hover-demo/parent-hover.png`：非当前父会话悬停与六条列表。
- `.local/agent-work/probe/hover-demo/child-page.png`：真实只读子页与原有返回按钮。
- `.local/agent-work/probe/hover-demo/result.json`：真实导航与 GC 返回断言。

仍未在完整应用验证：真实运行中的模型派工状态、撤回/删除联动、深色主题人工观感及减少动态的完整流程。上述项保持未勾选。

### 10.5 pi-subagents 插件真实测试（2026-10-29）

用户要求核对内置与插件的持久化差异，并实际测试插件。本次在开发版新增独立测试会话，确认已加载 `@tintinweb/pi-subagents` **0.22.0**（开发与主环境版本相同），通过真实模型调用一次插件 `Agent`，不是内置 subagent 或模拟结果。权限选择“允许一次”，未改永久权限策略。

- 子代理：Explore，agentId=`38e86c9b-9625-4c4`；运行约 5940ms，toolUses=0，回复 `PI_SUBAGENTS_PERSIST_OK`。
- 子会话：`Explore#38e86c9b`，sessionId=`01a185ae-90f3-7273-8ab0-c49d3e766e14`，真实落在 `~/.pi/agent-dev/sessions/<cwd编码>/`，不是 `sessions-subagents`。
- header 含 `parentSession` 指向测试父文件。本次开发测试实例仍只有一个页面窗口：新增的是侧栏/顶栏中的独立会话，不是新操作系统窗口。
- 从侧栏打开后不属于 `readOnly: true` 的内置检视页，可见正常输入框；没有建立本功能的内存返回关系，也没有子页返回按钮。
- 切离子会话后执行真实 GC 卸载，再从相同文件重开，原始任务和回复均恢复。文件存在；**没有执行整个应用重启**。

**适配前确认的插件缺口（历史记录；默认目录的悬停关系已由 §11 补齐）：**

1. 本次 Agent 原始 details 包含 agentId/subagentType/status 等，但**没有 sessionFile**；聊天子代理按钮实际 disabled，父悬停查询不返回 relations。
2. 即便补回 sessionFile，普通 sessions 路径也不满足当前 `sessions-subagents` 安全白名单；不能通过无条件放宽路径或按名称猜测来修补。
3. 插件子文件虽有 parentSession，当前功能未消费它；该字段也用于正常 Fork/Clone，未来适配必须联合可靠执行来源/稳定身份，不能一刀切认作子代理。

持久化边界：内置 runner 使用 `SessionManager.create`，正常落盘文件不会因 finally 的 `session.dispose()` 或宿主 GC 自动删除；内存态的是 `subagent-return` 的返回关系，重启失去关系不等于丢失对话。插件当前源码默认顶层 Agent 持久化（rememberAgents=true），但 `persist_session`、`session_dir`、rememberAgents 与嵌套运行条件可以改变结果，本次只验证默认顶层路径。

证据：`.local/agent-work/probe/hover-demo/pi-subagents-evidence.json`，截图 `plugin-parent.png`（无子关系区块）、`plugin-child.png`（卸载重开后完整对话）。本轮未修改插件、执行器策略或放宽路径白名单。

**交付边界：** 源码和自动验证已落实；未 commit/push/tag、未发版。保留开工前已有的 `docs/INDEX.md` 改动与 `HANDOVER.md`，不将其计作本轮实现成果。

## 十一、pi-subagents 关系适配执行契约（2026-10-29 已批准）

本节扩展前述仅内置目录的关系收集规则；不推翻内置只读子会话隐藏规则，不隐藏插件的普通独立条目。用户确认的目标是：**父悬停能列出插件创建的代理、显示任务/状态并点击打开**，而不是孤立的 `Explore#…` 列表。

### 11.1 可靠关联与保守降级

插件 0.22.0 未把 sessionFile 写入 Agent details 或 subagents:record；全局 manager registry 仅第一激活者拥有，不能作为多会话关联真源。采用已核实的持久化协议交叉验证，**不是只看当前显示标题**：

1. 当前分支必须存在明确 `Agent` 工具调用及对应 toolResult（toolCallId 相同），结果中有合法完整 agentId、subagentType。没有回执或仅有相似名称不认领；显式 resume 调用不当作新建。
2. 只扫描父文件所在、位于当前 agentDir 默认 `sessions` 根下的同项目目录，不递归、不遍历所有项目，不尝试用户自定义根外 session_dir。拿不到实际 parentFile 就不猜。
3. 只读子文件的前缀：header 的 cwd、parentSession 必须与当前父身份一致；文件名必须与 header session id 一致；第一条 message 前的**最早 session_info** 必须精确符合插件创建协议 `subagentType#agentId前8位`。之后 rename 的追加条目不改变原始身份。
4. 子 header 创建时间必须落在对应父工具调用到回执的时间窗口内；后台以同分支、同 id/type 的最终 subagents:record.completedAt 扩充上界。时间证据缺失或窗口不成立就不认领。
5. 同一完整 id 重复回执去重；不同完整 id 的相同角色/前八位冲突，或多个候选子文件同时匹配时，拒绝有歧义的关联。SDK 普通 Fork/Clone 将 parentSession 指向**被复制的源文件**，不能只因继承角色名就关联到原始祖父；必须覆盖该反例。
6. 每个候选须为普通 jsonl 文件；真实路径仍在扫描的真实目录内，链接越界拒绝。内置白名单不放宽；插件走独立的已验证文件集合。

不是加密来源认证：恶意本地进程可以伪造整份 JSONL，本方案不宣称提供本地恶意写入隔离。目标是对正常插件协议唯一关联、拒绝普通分叉/重名/失效或越界文件，不靠启发式选“最像”的一条。

### 11.2 预算、状态与导航

- 新模块 `backend/src/session/pi-subagent-relations.ts`；仅检测到插件派工声明才扫描。同目录最多 2048 个 jsonl，单文件前缀最多 128 KiB，总读取预算 8 MiB；任一预算超限抛专用异常，预览明确 limit_exceeded、不返回看似完整的部分计数。
- 无关候选在读到不匹配的 header 后立即结束；匹配候选读到首条 message 即停止，不能为了 rename 而读取完整子会话正文。不存在/损坏/不匹配文件不展示。
- 插件完成/失败状态取明确 Agent status 或当前分支 subagents:record 终态；旧 background/running/queued 回执不足以证明当前还在运行，显示 unknown。前台 Agent 尚无完整 ID 回执时不猜关系。
- 插件结果回填在父分支原派工位置，与内置结果统一按最新引用去重、计数后截断六条，hidden 精确。
- 复用 `openSubagentSessionFrom`：插件子文件照旧作为普通会话打开，写入本次入口的内存父关系，因此保留侧栏条目且可悬停显示父入口；不改全局 `isPrimaryNavigationSession`。
- 打开默认普通 sessions 根中的文件时增加真实路径/普通 jsonl 检查，防止插件候选在查询后变为根外链接；不限制用户本来可打开的根外普通历史文件，不新增 IPC。
- 自定义目录、旧格式缺身份、持久化关闭、未落盘或歧义场景诚实缺失；不得退回读取任意路径或按名称前缀匹配。

### 11.3 改动与验收

- `title-preview.ts`：传实际 parentFile/cwd 给插件解析器；已加载 manager 的 getSessionFile 可选，缺失则不解析插件；文件路径直接复用已定位 file；合并所有合法关系再截断。内存/文件同源校验不变。
- `pi-backend.ts` / 路径模块：默认普通 sessions 根的二次安全打开检查；共享 DTO、缓存协议和 UI 布局不增加新的字段/通道。
- 必测：真实形状回执、同角色多子、缺/错 parentSession、普通 Fork/Clone、初始命名与后续 rename、ID 前缀冲突、多个匹配副本、时间越界、非当前分支与 resume、坏行/无文件/目录/外部链接、大小写、扫描预算、不读正文、内置与插件混合的六条/hidden、明确终态和旧回执 unknown。
- 导航回归：从非 active 父悬停点插件子会话，普通属性和独立条目保留；子悬停父入口可达、点击回到正确父，父卸载时按文件恢复。
- 开发版验收须使用真实 Agent 派工数据（可复用上一轮已完成的真实记录，并新增一次只读标记派工），不手动伪造 sessionFile 或关系。

### 11.4 实施与验收结果

**本阶段默认目录的插件关系适配已通过真实开发版验收。** 不要求修改 pi-subagents 包，不修改旧历史文件，也不把 agentId 与独立生成的 session UUID 混用。

已落实：
- 新增 `pi-subagent-relations.ts`，联合当前分支声明、完整 Agent ID、父文件指针、原始命名协议、创建时间窗口与唯一性匹配。
- 命中最早身份元数据即停止，不为了首条巨大 system/user 消息继续读取；仅匹配明确协议，保留单文件/全局/文件数量预算。
- `title-preview.ts` 在磁盘与内存路径传递真实父文件，插件结果在原派工位置与内置统一去重、排序、计数。
- 普通 sessions 根有独立真实文件校验；内置白名单不放宽。插件正常可编辑属性及独立列表保留。

| 验证 | 结果 |
| --- | --- |
| 真实旧历史 | 先前 `Explore#38e86c9b` 的未修改父/子文件已能返回关系，无历史回填 |
| 真实新增派工 | 新父会话“【实测】插件父子关系 · 适配验收”调用一次插件 Agent，Explore 回复 `PI_SUBAGENTS_RELATION_OK`，形成 `Explore#fb1548b3` |
| 开发版端到端 | 8 项通过：非当前父悬停列出正确子、子保留普通属性、独立条目仍在、父关系不误记原 active、子悬停父入口可达、实际返回正确父、真实卸载父、从父入口按文件重新打开 |
| 新增反例 | 用真实不同的 agentId/sessionId 及超长首条消息复现失败后修正；插件解析与内置集成窄回归共 58 项通过 |
| backend 全套 | 90 文件、912 项通过 |
| renderer/main 回归 | 8 文件、178 项通过 |
| 类型检查 | backend/shared/desktop node+web 全部通过 |
| 构建 | `npm run build -w packages/desktop` 通过，未生成安装包或发版 |
| 独立验证 | verifier PASS，独立复跑 58 项及 backend typecheck，未确认 P1/P2 |
| LSP 边界 | 主动查 4 个后端文件时 1 个确认 clean、3 个无法确认；由实际 tsc 补足，未把静默当通过 |

真实证据在 `.local/agent-work/probe/hover-demo/`：
- `plugin-adapted-preview.json`：旧真实派工的关系结果。
- `adaptation-result.json`：新增实际 Agent 派工及预览结果。
- `adaptation-e2e.json`：8 项真实界面断言。
- `adaptation-parent.png` / `adaptation-child.png`：父悬停子入口、子悬停父入口截图。
- `verify-adaptation.mjs`：操作真实开发页面、真实 IPC/backend 的局部验收脚本；不模拟关系、不伪造文件指针。

覆盖边界（§11 阶段记录，重启恢复已由 §12 扩展）：本轮实机验证 pi-subagents 0.22.0 的默认目录、前台持久化 Agent；自定义 session_dir、未持久化/未落盘、身份缺失/歧义仍不猜。后台终态记录解析有单测，但未增加后台真实模型派工验收。父→子关系可从现有日志重建；子→父入口仍按本次点击建立内存关系，重启后直接从侧栏打开子会话不自动恢复这张内存表。聊天消息内原始 Agent 卡的 sessionFile 缺失不在本轮修改范围，本轮跳转入口是悬停卡。

未 commit/push/tag，未替换当前安装版；独立开发验收窗口和测试会话保留供用户查看。

## 十二、重启后父关系、显示更多与历史文案（已批准）

用户实际体验发现三处缺口，本节替代原 D1/D3 的限制。目标：重启后直接悬停插件子会话即可看到父入口；剩余子会话可按需加载；离线会话显示“历史会话”而非误导性的“未加载 / 无实时状态”。不在启动时加载全部历史实例，不创建新持久化关系表。

### 12.1 反向关系恢复

- `SessionHoverRelations` 增加可选 `parent: SessionHoverRelationParent`；字段固定为 `{ sessionId: string; sessionFile: string; cwd: string; name?: string }`，路径仍不渲染。
- 子文件自己的身份和预算检查通过后，读取 header.parentSession 作为**待验证线索**。子/父必须在普通 sessions 安全根中，真实路径、文件类型、id 与文件名、cwd 一致，禁止自引用/越界；不只相信 parentSession。
- 对该父文件读取并验证当前分支，再调用既有 `resolvePiSubagentRelations` 得到完整插件关系集合（不先截六条），只有集合包含当前子 file + sessionId，才返回父 DTO。
- 父在 registry 中时使用已加载 manager 的当前 leaf/entries；不存在时才按磁盘分支解析。已加载父的 id/cwd/file 不匹配时拒绝，不用旧磁盘分支绕过撤回。
- 复用/提取现有有界读取与整树验证纯函数，不复制一份放松校验的 JSONL 解析器。反向只验证一层，不递归解析父的父；相关父不可读、超预算、无真实派工或关系已撤回时仅省略父入口，保留子自己的可用预览。
- 子与候选父各守原 8 MiB 预算；插件候选前缀扫描预算不变。无 parentSession 的内置子会话不扫描全库猜父关系。
- Card 采用当前内存返回目标优先，否则采用本次后端验证的 parent。悬停不往返回 store 写记录；`returnToParent(childId, fallbackTarget?)` 支持经验证的回退目标，传回退时必须包含 `{ parentSessionId, parentFile, cwd }`，类型要求 cwd 必填；已有内存关系时不传回退。冷目标打开后再次核对 id/cwd，匹配后才切换。
- 标题优先现有内存/目录 metadata，其次父 DTO 的已保存 name，最后使用本地化通用标题。

### 12.2 有界分页与展开

- 仍使用 `session:hoverPreview`，请求增加可选 `childrenOffset?: number`（默认 0，非负安全整数），每次返回六条。非法 offset 在任何读取前拒绝。
- 每次仍先得到完整合法集合，再返回 `slice(offset, offset+6)`；relations 增加可选 `offset`、`total`、`revision`。实际后端分页响应均提供这些字段；保留可选性兼容旧测试/调用方。
- `hidden = max(0, total - offset - 本页条数)`；`revision` 是完整有序合法子集合的稳定摘要，包含会影响展示/跳转的字段。它只用于分页一致性，不是权限凭证。
- 前端累计已请求页，首屏六条；“显示更多（剩余 N 个）”按需请求下一页并追加，直至全部可见；提供“收起”，回到首屏。卡片整体滚动与视口夹紧不变，不额外套内部滚动条。
- 不把后端截断改成一次返回全部大 payload。revision 改变、offset 不连续或源目标变化时，丢弃累计页，重新请求第 0 页，不能混合撤回/新增/删除前后的列表。

### 12.3 前端请求所有权与缓存

- 缓存 key 纳入 childrenOffset，保留现有一个在途槽、最新待请求、LRU/TTL/失效守卫。
- 新 hook `components/sidebar/useSessionHoverPages.ts` 是实际挂载 Card 的请求所有者：Provider 不再同时在 effect 中 setTarget；Provider 的立即 dismiss/卸载失效仍可 setTarget(null)。Card 只在真的显示时挂载 hook。
- 固定 hook API：`useSessionHoverPages(target)` 返回 `{ preview, loadingMore, moreError, expanded, loadMore, collapse }`；preview 为首屏基本信息与累计子行/最新 hidden 的组合，Card 不自己拼接分页。
- 源 key（不含 offset）变化、关闭重开、历史失效或当前已完成页的 TTL 重读，重置为首屏。翻页请求中的 null 只表示加载更多，保留已确认的前页。
- 加载更多失败保留前页，显示 inline 错误和重试；重试须真正作废失败缓存，不只是重复命中 5 秒失败项。收起或换目标后旧翻页响应不得把列表再次展开。
- revision 不一致回首屏时须作废该会话的旧页缓存，避免“旧首屏 ↔ 新后页”的循环。

### 12.4 文案与交互

- zh unloaded 改为“历史会话”，en 为“Historical session”；内部判别 key 不变。实时已知时仍显示工作中/空闲等，不把旧终态伪装成当前实时状态。
- 新增 zh/en 显示更多、收起、加载更多、加载失败/重试文案。按钮支持 Enter/Space，加载期间禁重复点击；追加后和收起时保持可用焦点，不关闭卡片。
- 不扩大执行器权限，不改变插件独立条目/内置只读隐藏规则，不新增安装或发版操作。

### 12.5 必须补充的验证

1. 清空 renderer 返回关系/整个开发进程重启后，直接悬停 `Explore#fb1548b3`：父 DTO 恢复并可点击；不先开父或从父卡进入。
2. 父被撤回（含已加载 parent 的 leaf 与磁盘不同）、父文件缺失/越界/坏树/超预算、普通 Fork/Clone、自引用均不显示假父入口。
3. 反向匹配能找到父的第 7～9 个子会话；不能依赖父首屏六条。
4. 九条：首屏 6 → 点击更多 9 → 收起 6；全部仍可点。内置与插件混合分页顺序/计数正确。
5. 多页 revision 变化、翻页失败重试、翻页期间收起/关闭/换目标、TTL/撤回失效、请求串行都不回归。
6. 冷启动显示“历史会话”，没有批量打开历史；卡片支持真实 DOM 点击/键盘，不用 SSR 冒充交互验收。

### 12.6 实施结果与完整重启验收

**三项已落实并通过真实开发版验收。**

- 父恢复：使用持久化插件子文件与父的当前分支交叉核验，无内存关系时也返回父 DTO；父失效只省略父入口。悬停本身不装载历史实例、不写返回关系表。
- 列表展开：六条一页，按需追加、可收起；revision 不一致回到新首屏；失败可重试，收起/关闭后的迟到页不重新展开。分页请求由 Card hook 的单一控制器持有。
- 状态：离线会话显示“历史会话”，没有为了改文案而批量装载历史或伪造实时状态。

| 验证 | 结果 |
| --- | --- |
| backend 全套 | 91 文件、920 项通过 |
| renderer/main 回归 | 10 文件、198 项通过（已同步更新 remembered 目标不传 fallback 的旧断言） |
| 类型检查 | backend/shared、desktop node/web 通过；最终 cold fallback 的 cwd 改为必填后 desktop 再次通过 |
| 桌面构建 | 含最终 cwd 接线修正的 `npm run build -w packages/desktop` 通过 |
| 隔离 Electron DOM | 20 项通过，含展开/收起焦点、冷父 DTO 的 id/file/cwd 传递、历史文案与原生 Tab/Enter |
| 独立复核 | 初次静态/自动检查无确认 P1/P2，但缺实机故 INCONCLUSIVE；冷父接线修正后窄复核 PASS，并指出一条旧测试断言需更新，已更新并重跑全部相关测试 |
| 完整进程重启 | 同一个隔离配置目录，PID **28856 → 26800**，Node inspector 实例标识也改变；并非只刷新 renderer 或做 GC |
| 冷启动初态 | 已加载历史实例 **0**，内存返回关系 **0** |
| 真实界面验收 | **11 项通过**，详见下文 |

完整重启使用独立的 `reboot-verification/cold-user-data-dev`，仅在确认无运行任务的验证实例中执行退出并重新启动；不退出用户安装版、不改用户正式配置。复用了真实 `Explore#fb1548b3` 文件验证父恢复，九条列表使用之前明确标注的演示 JSONL，IPC、后端、会话打开与导航均为真实实现，不模拟父关系。

实测关键断言：
1. 没有先打开父会话，直接悬停 Explore 就得到正确父入口。
2. 悬停前后均为 0 loaded / 0 relations；点击该入口后实际打开正确父页。
3. 冷卡状态文案为“历史会话”。
4. 九条：6 → 请求 offset=6（后端返回 3 条、total=9、hidden=0）→ UI 累计 9 → 收起 6。
5. 再次展开后第九条能够实际打开，并可使用原返回入口回父页。

**实机纠错记录：** 第一次冷测试虽然恢复了父 DTO，但 Card 漏传 cwd，而导航冷回退要求 cwd，导致只显示入口、点不动。现已补齐 `{parentSessionId,parentFile,cwd}`，将类型收紧为必填，并同步增加 DOM 与 Card 断言；随后重新退出/启动进程，完整走通，不把第一次仅渲染成功当成验收。

证据位于 `.local/agent-work/probe/hover-demo/reboot-verification/`：
- `before-restart.json`、`after-start.json`、`result.json`：进程身份、冷启动状态与 11 项结果。
- `cold-parent-restored.png`：重启后直接悬停子会话，父入口与“历史会话”同屏。
- `all-nine-expanded.png`：全部九条与“收起子会话列表”。
- 驱动脚本：上级目录的 `restart-ui.mjs`、`verify-three-fixes.mjs`。

未执行项仍按边界处理：本轮没有新增后台模型派工、自定义 session_dir 或全主题人工验收；未替换安装版、未 commit/push/tag/发版。内置子会话没有持久化父指针，仍不通过全库扫描猜反向父；本轮完整重启恢复针对已适配的插件持久化关系。