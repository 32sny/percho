---
类型: 技术方案
状态: 方案已定稿待批准
创建: 2026-10-31
更新: 2026-11-12
适用: Percho — 会话工作区左右二分（split panes）
---

# 会话工作区左右分屏：从「胶囊切换」到「两个会话并排看」

> **创建日期**：2026-10-31
> **状态**：方案已定稿待批准
> **关联版本**：v0.7.x（下一功能版本）
> **任务真源**：竞品分析结论——MonoCode 把「多会话并行」当第一公民（任意 pane 并排、拖拽成 split），Percho 有 `SessionTabBar` 胶囊集合但一次只能看一个会话，这是当前最大的交互结构性缺口

---

## 一、目标与阶段边界

### 1.1 交付契约

1. **任意两个工作区成员可并排显示**：主 pane（左）+ 次 pane（右），中间可拖拽分隔条调整比例。
2. **焦点会话语义不变**：`sessions.activeSessionId` 仍然是「焦点会话」。左栏点击、⌘N、Diff 侧栏、GitLens、Artifacts、TodoPanel、审批 Dock 的现有行为全部保持——它们跟随焦点。
3. **次 pane 拥有自己的输入框与审批**：两个 pane 各自可独立发消息、独立处理权限审批、独立流式渲染。
4. **按钮级入口**：胶囊右键菜单 / 左栏会话行菜单新增「在右侧打开」。已有次 pane 时换成「取消分屏」。
5. **跨重启保留**：次 pane 的会话文件路径 + 分隔比例落盘；重启后会话文件不存在 → 静默回单 pane。
6. **GC 保护**：任何可见 pane 里的会话不参与内存卸载。

### 1.2 非目标（Out of Scope，防范围蔓延）

- 树形 / 嵌套 / 三分以上分屏（MonoCode 的 `PaneTree` 模型）。**明确只做二分**。
- 把编辑器 / 终端 / Changes 面板当 pane 的「任意 surface」模型（MonoCode 的 `SurfaceTabs`）。Percho 的 Diff/GitLens/Artifacts 保持全局单例浮层。
- 拖拽胶囊到聊天区创建分屏（第二阶段再评估，本方案只做菜单入口）。
- 左右 pane 的独立滚动位置持久化（次 pane 重启后回消息尾部，与现有「切会话回底」一致）。
- 跨 Electron 窗口（`BrowserWindow`）多会话。
- 左栏「该会话已在某个 pane 打开」的视觉标记。

---

## 二、现有实现定位

### 2.1 可复用能力（已核实存在）

| 能力 | 位置 | 复用方式 |
|---|---|---|
| 工作区成员表（file / sessionId 双键、插右、去重、失效裁剪） | `renderer/src/stores/session-workspace.ts` | 分屏的成员来源就是它，不新造集合 |
| 成员 → 展示集解析（被 GC 卸载的成员照样能画出胶囊） | 同上 `resolveWorkspaceSessions` | 次 pane 会话未装载时先用它解析出 meta 画占位 |
| 底部交换槽已参数化 | `components/session/DockSlot.tsx`（`sessionId` 入参） | 直接传 pane 的 sessionId |
| transcript 按会话分槽 | `stores/transcript.ts`（`bySession[sessionId]`） | 天然支持两条流并行 |
| 按会话取 cwd | `lib/active-cwd.ts` `selectActiveCwd` | 需增按 id 取 cwd 的变体（见 §三 D3） |
| 偏好持久化单写者 + 只留最后意图 | `session-workspace.ts` 的 `schedulePersist` | 分屏状态并入同一份快照，不新增 IPC |
| 视图过渡 | `lib/session-page-slide.ts` + `data-session-page` / `data-session-id` | 分屏时按 D4 关闭过渡 |

### 2.2 不能直接复用 / 需打破的旧假设

1. **`App.tsx` 只有一个页面容器**：主区 `<div data-session-page data-session-id={activeSessionId}>` 同时是 `session-page-slide` 的锚点和 SVG 过渡的快照对象。第二 pane 若共用这个标记，`session-page-slide` 会把整列当一页拍快照。
2. **约 50 个文件直接读 `s.activeSessionId`**（`grep -rln activeSessionId` 实测 50 个，含测试）。其中位于聊天渲染路径上、必须改为「pane 作用域」的有：`chat/MessageList.tsx`、`chat/CornerStack.tsx`、`chat/TodoPanel.tsx`、`chat/SelectionToolbar.tsx`、`chat/message-actions.tsx`、`composer/Composer.tsx`、`composer/ContextRing.tsx`、`composer/PermissionPicker.tsx`、`composer/use-slash-menu.ts`、`composer/use-composer-send.ts`、`session/ApprovalDock.tsx`、`session/InteractionDock.tsx`、`session/ProjectBranchPicker.tsx`、`hooks/use-session-state.ts`。
3. **GC 只认单活跃**：`lib/session-gc.ts` 的 `pickUnloadCandidates` 用 `item.sessionId !== input.activeSessionId` 豁免。分屏后次 pane 的门面会话**不是** activeSessionId，会被当成「不活跃可卸」候选。
4. **`session-page-slide` 的等待判据是 `data-session-id` 变化**：分屏后两侧都可能变，必须显式关闭过渡，否则会拍到混合画面。
5. **`SessionTabBar` 的胶囊只表达「成员 + 激活」**：需要新增「该成员在次 pane」的视觉态，且右键菜单当前只有关闭/移出类动作。

---

## 三、架构决策

### D1：二分，不做 PaneTree

理由：MonoCode 的 `PaneTree` 成立前提是「任意 pane 承载任意 surface」（chat/editor/terminal/changes），Percho 的编辑器/终端能力尚不存在，三分以上分屏在 13–16 寸屏上没有实用宽度（每 pane < 600px 时 MessageList 的 760px 最大宽度被压扁，行内 diff 卡片不可读）。二分的改造成本约为 PaneTree 的 1/4，覆盖 90% 真实场景（一个会话跑长任务，另一个会话问问题/看 diff）。

**代价（明确接受）**：上限 2 个。用户要第三个就用胶囊切。

### D2：`activeSessionId` 保持原语义，新增独立 pane store

不改 `sessions.activeSessionId` 的定义（= 焦点会话），而是新增：

```ts
// packages/shared/src/panes.ts
export type PaneFocus = "primary" | "secondary";
export interface SplitState {
  /** 次 pane 的会话文件路径；null = 单 pane（未分屏） */
  secondaryFile: string | null;
  /** 焦点所在的 pane */
  focus: PaneFocus;
  /** 主 pane 占聊天列宽度的比例，夹紧到 [0.2, 0.8] */
  ratio: number;
}
export const SPLIT_DEFAULTS: SplitState = { secondaryFile: null, focus: "primary", ratio: 0.5 };
```

`activeSessionId` 恒等于「焦点 pane 的会话」。这样 50 处既有引用**零改动**仍是正确语义（它们本来就该跟随焦点）。

### D3：`usePaneSessionId()` 上下文，缺省回落焦点会话

```ts
// hooks/use-pane-session.ts
const PaneSessionContext = createContext<string | null>(null);
export function usePaneSessionId(): string | null {
  return useContext(PaneSessionContext) ?? useSessionsStore((s) => s.activeSessionId);
}
```

聊天渲染路径上的组件把 `useSessionsStore((s) => s.activeSessionId)` 换成 `usePaneSessionId()`。**这样做的好处**：改造可分批、可在单 pane 状态下逐组件回归（值恒等），不需要一次性重写整棵子树。

**同时新增**（避免组件自己去 store 拼 cwd）：

```ts
export function usePaneCwd(): string | null { /* 按 pane sessionId 从 sessions/history 解析 */ }
```

`Composer` 目前用 `selectActiveCwd`；改为 `usePaneCwd()`。

### D4：分屏时不播页面推/出过渡

`lib/session-page-slide.ts` 增加判据：`splitActive === true` → `shouldPlaySlide` 返回 false，直接切。次 pane 容器**不挂** `data-session-page` 标记（避免成为过渡快照目标），改挂 `data-session-pane="secondary"`。

分屏开关本身用**宽度/位移过渡**（`transform: translateX` + `width`，180ms，`prefers-reduced-motion` 降级为瞬切）。

### D5：GC 增「可见即保护」

`SessionGcInput` 增一个显式字段（不改既有字段语义）：

```ts
export interface SessionGcInput {
  activeSessionId: string | null;
  /** 分屏可见的会话（含主 pane 的焦点会话）：一律不卸载 */
  pinnedSessionIds?: readonly string[];
  // …既有字段
}
```

`pickUnloadCandidates` 的过滤条件由 `item.sessionId !== input.activeSessionId` 改为 `!visible.has(item.sessionId)`，其中 `visible = new Set([activeSessionId, ...pinnedSessionIds])`。

### D6：分屏状态并入 `SessionWorkspaceSnapshot`

```ts
export interface SessionWorkspaceSnapshot {
  files: string[];
  activeFile: string | null;
  /** 次 pane 的会话文件（必须 ∈ files；不在则归一化为 null） */
  secondaryFile?: string | null;
  /** 分隔比例（缺省 0.5，夹紧 [0.2, 0.8]） */
  splitRatio?: number;
}
```

理由：成员表与布局同源同生命周期。用户在设置里把胶囊与轨道**双关**时，`clear()` 一并清空分屏状态——不需要第二条清理路径。旧版本快照缺这两个字段 → 解析为单 pane（向后兼容，无需迁移）。

### 错误处理契约（Fail-closed）

| 情形 | 行为 |
|---|---|
| 恢复时次 pane 的会话文件已不存在 / 已删 / 是只读子代理产物 | **静默降级为单 pane**（不弹 toast，与偏好丢失同策略），且把 `secondaryFile` 落盘为 null |
| 用户把焦点 pane 关闭（顶栏 ×）而它是次 pane | 次 pane 关闭 → 焦点回主 pane → 主 pane 保持原会话（不导航到别处） |
| 主 pane 的会话被用户从左栏删除 | 次 pane 若存在 → 提为焦点并顶成单 pane？**否**：保持分屏但主 pane 显示空态（新会话页），由用户决定下一步 |
| ratio 越界（拖拽 + 窗口缩小） | 夹紧到 [0.2, 0.8]；窗口宽度 < 900px 时禁用分屏入口（按钮置灰 + tooltip 说明） |
| 次 pane 会话正在流式时用户分屏打开第三个 | 拒绝：只允许 2 个，提示「先关闭当前分屏」 |

---

## 四、核心状态机 / 时序

### 4.1 打开分屏

```
用户点「在右侧打开」(sessionId S)
  → 校验 isPrimaryNavigationSession(S)                     // 只读子代理不进分屏
  → 校验窗口宽度 ≥ 900px
  → panes.openSecondary(S)
       ├─ S 未装载 → sessions.loadSession(S)（只装载，不改 active）
       ├─ split.secondaryFile = S.sessionFile
       ├─ split.focus = "secondary"
       ├─ sessions.activate(S.sessionId)                    // activeSessionId = S（焦点）
       ├─ schedulePersist(快照含 secondaryFile + ratio)
       └─ 通知 GC 重算（pinnedSessionIds 变化）
  → PaneSessionContext(secondary) 包裹次 pane 子树，渲染 MessageList + DockSlot
```

### 4.2 关闭分屏

```
panes.closeSecondary()
  → 若 split.focus === "secondary"：
       焦点回主 pane → sessions.activate(主 pane 成员 id)
  → split = { secondaryFile: null, focus: "primary", ratio: 沿用 }
  → schedulePersist + GC 重算
```

### 4.3 焦点切换

点任一 pane 的空白/输入框 → `panes.focusPane("secondary")` → `sessions.activate(次 pane 会话)`。左栏点击某个已在次 pane 的会话 → 只切焦点，不移动位置（沿用 `addMember` 的「已加入只激活不挪位」语义）。

### 4.4 冷启动恢复

```
restoreSessionWorkspace()（既有）
  → 读快照（含 secondaryFile / splitRatio）
  → resolveMembersByFile(files, history) 裁掉失效成员
  → secondaryFile ∈ 存活成员？是 → 设次 pane（不抢 activeFile）
                            否 → 单 pane（并把 secondaryFile 落盘为 null）
  → epoch 令牌比对（既有机制）后再落地，防止用户在恢复期间自己操作被覆盖
```

---

## 五、受影响文件与变更策略

| 模块 / 逻辑 ID | 目标文件路径 | 变更类型 | 核心策略说明 |
|---|---|---|---|
| 分屏纯逻辑 | `packages/shared/src/panes.ts` | 新增 | 类型 + `clampRatio` + `normalizeSplit` + `shouldAllowSplit(width)`；零 React、零 IPC，全部单测 |
| 分屏状态 | `renderer/src/stores/panes.ts` | 新增 | zustand；持久化**委托** `session-workspace` 的 `schedulePersist`（不另开写通道） |
| 单 pane 渲染块 | `renderer/src/components/session/SessionPane.tsx` | 新增 | 从 `App.tsx` 抽出：`MessageList` + `CornerStack` + `RegionHost` 角区 + `DockSlot`；接受 `sessionId` + `isSecondary` |
| 分隔条 | `renderer/src/components/session/SplitDivider.tsx` | 新增 | pointer capture（含 pointercancel/lostpointercapture）+ 键盘 ←/→ 调幅 + `aria-valuenow` |
| pane 作用域 Hook | `renderer/src/hooks/use-pane-session.ts` | 新增 | `usePaneSessionId` / `usePaneCwd` |
| 主布局 | `renderer/src/App.tsx` | 修改 | `data-session-page` 只保留主 pane；次 pane 条件渲染；`<SplitDivider/>` |
| 会话装载/激活分离 | `renderer/src/stores/sessions.ts` | 修改 | 抽出 `loadSession(id)`（只装载）；`openSession` 内部改用它，行为不变 |
| GC 保护 | `renderer/src/lib/session-gc.ts` | 修改 | `SessionGcInput.pinnedSessionIds` + 可见集合豁免 |
| GC 接线 | `renderer/src/lib/use-session-gc.ts` | 修改 | 从 panes store 读可见会话集合 |
| 快照类型 | `packages/shared/src/session.ts` | 修改 | `SessionWorkspaceSnapshot` 增可选 `secondaryFile` / `splitRatio` |
| 快照读写 | `renderer/src/stores/session-workspace.ts` | 修改 | `workspaceSnapshotOf` 带上分屏字段；`clear()` 一并清零 |
| 冷启动恢复 | `renderer/src/stores/session-workspace-restore.ts` | 修改 | 恢复次 pane（失效降级） |
| pane 作用域组件（13 处） | `components/chat/MessageList.tsx`、`chat/CornerStack.tsx`、`chat/TodoPanel.tsx`、`chat/SelectionToolbar.tsx`、`chat/message-actions.tsx`、`composer/Composer.tsx`、`composer/ContextRing.tsx`、`composer/PermissionPicker.tsx`、`composer/use-slash-menu.ts`、`composer/use-composer-send.ts`、`session/ApprovalDock.tsx`、`session/InteractionDock.tsx`、`session/ProjectBranchPicker.tsx` | 修改 | `s.activeSessionId` → `usePaneSessionId()`；`selectActiveCwd` → `usePaneCwd()`；**逐组件改、每步跑既有测试** |
| 顶栏入口 | `components/session/SessionTabBar.tsx` | 修改 | 胶囊右键菜单加「在右侧打开 / 取消分屏」；次 pane 中的胶囊加一枚静态指示 glyph（不用色底，符合 `docs/ui.md`「状态只用一枚着色 glyph」） |
| 左栏入口 | `components/sidebar/SessionMenu.tsx` | 修改 | 会话行菜单加同入口（窗口宽度不足时置灰） |
| 过渡关闭 | `renderer/src/lib/session-page-slide.ts` | 修改 | `shouldPlaySlide` 增 `splitActive` 判据 |
| 样式 | `renderer/src/styles/globals.css` | 修改 | `.split-divider` / `.session-pane-secondary`；只用语义 token；`prefers-reduced-motion` 降级 |
| 文案 | `renderer/src/i18n/zh.ts`、`i18n/en.ts` | 修改 | 新增 6 条：`split.openRight`、`split.close`、`split.tooNarrow`、`split.secondaryHint`、`split.limit`、`split.focusLabel` |
| UI 插件槽位 | `renderer/src/plugins/slots.ts` | 修改（评估） | 确认 `UI_SLOTS.TodoPanel` 等槽位在次 pane 内是否重复渲染；若会重复，次 pane 内只渲染默认实现、不挂插件槽（避免插件被调用两次） |

---

## 六、测试设计与验证（TDD 契约）

### 6.1 纯函数单测（先写 RED）

`packages/shared/src/panes.test.ts`：

- `clampRatio(0.05) === 0.2`、`clampRatio(0.95) === 0.8`、`clampRatio(NaN) === 0.5`
- `normalizeSplit({secondaryFile: ""})` → `secondaryFile null`
- `normalizeSplit({splitRatio: 3})` → `0.8`
- `shouldAllowSplit(880)` → false、`shouldAllowSplit(900)` → true

`renderer/src/stores/panes.test.ts`：

- 打开 → 焦点在次 pane；关闭 → 焦点回主 pane；两次打开同一会话 → 幂等（不产生第二个）
- `secondaryFile === activeFile` → 拒绝打开（同一会话不允许占两个 pane）

`renderer/src/lib/session-gc.test.ts`（扩展）：

- 输入 `activeSessionId: A`、`pinnedSessionIds: [B]`、4 个空闲会话 → **B 不在候选里**（RED：现有实现会把它算成 over-limit 候选）
- `keep: 3` + 分屏 B → 实际驻留 4 个，B 仍不被卸

`renderer/src/stores/session-workspace.test.ts`（扩展）：

- 旧快照（无 `secondaryFile`）→ 解析结果单 pane，不报错
- 快照 `secondaryFile` 不在 `files` 内 → 归一化为 null（守住「secondaryFile ∈ files」不变式）

### 6.2 组件/回归

- 全量 `npm run typecheck`（**必须**：13 个组件的 store 引用改动靠类型兜底）
- `npm test`（既有 `MessageList` / `Composer` / `session-gc-run` / `session-workspace-restore` 测试不得改动语义）
- 新增 `SessionPane` 快照无关的交互测试：给定 `usePaneSessionId` 返回 S1/S2，`MessageList` 各渲染各的消息

### 6.3 手动/CDP 验收（`scripts/cdp-shot.mjs`、`scripts/cdp-eval.mjs`）

1. 左右两个会话同时流式 → 两侧文字各自增长、互不串行、底栏状态各行其是
2. 次 pane 弹权限审批 → 审批卡出现在次 pane 底槽，主 pane 输入框可用
3. 打开分屏后让一个会话跑长任务，切到别处再回来 → 次 pane 会话**没有被卸载**（`unloadSession` 日志计数）
4. 拖拽分隔条到极限 → 夹紧 0.2/0.8；窗口缩到 800px → 比例被夹紧且不出现横向滚动
5. 重启（含杀掉进程）→ 次 pane 恢复；手动删掉次 pane 的 jsonl → 重启后单 pane 且无报错弹窗
6. 设置里把胶囊 + 轨道双关 → 工作区清空、分屏一并关闭

---

## 七、实施步骤与验收清单

> P3 内分 4 个可独立合并的小步；每步结束都必须是「行为不变或只增强」的可发布状态。

- [ ] **步骤 1（纯重构，零行为变化）**：抽 `SessionPane.tsx`；新增 `usePaneSessionId`；13 个组件换 Hook（此时 context 恒为空 → 回落焦点，行为完全等价）；`npm run typecheck` + `npm test` 全绿。
- [ ] **步骤 2（分屏可见）**：`shared/panes.ts` + `stores/panes.ts` + `SplitDivider` + `App.tsx` 双 pane 渲染；先用一条临时的顶栏按钮触发（不接菜单）；CDP 验证两侧独立。
- [ ] **步骤 3（持久化 + GC）**：`SessionWorkspaceSnapshot` 加字段、恢复链降级、`session-gc` 可见保护；单测补齐；重启验收。
- [ ] **步骤 4（入口与打磨）**：胶囊右键 / 会话行菜单入口、窗口宽度门限、`session-page-slide` 关闭过渡、i18n 双语言、样式与 reduced-motion、UI 插件槽位重复渲染核查。
- [ ] 文档收尾：更新 `docs/INDEX.md`（「顶栏胶囊、左侧轨道、工作区恢复」一行补上分屏入口）；同步 `docs/ui.md`（新增 `SplitDivider` 的浮层/键盘约定）。

---

## 八、风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 两个会话同时流式 → 重渲染翻倍，掉帧 | 高 | 事件合流已按会话隔离（`stores/event-conflator.ts`）；次 pane 的 `MessageList` 继承 `mount-window.ts` 的尾部挂载窗口；发布前用 3000 消息会话 + 双流式压测 |
| 内存：两个会话同时驻留（keep=3 → 实际 4） | 中 | 已知且可接受（`GC_DEFAULTS.keep=3` 本来就是「最近使用」而非硬上限）；可见保护优先于内存节省 |
| 13 处组件改 Hook 引入回归 | 中 | 步骤 1 用「context 缺省回落焦点」保证等价；逐组件提交 + 既有测试守护 |
| `session-page-slide` 拍到混合画面 | 中 | 分屏时**直接关闭过渡**（不做「两个容器同时过渡」的复杂方案） |
| UI 插件槽位在次 pane 被调用两次 | 中 | 槽位只在主 pane 挂插件实现；次 pane 渲染默认组件 |
| 窗口窄（< 900px）时分屏不可用 | 低 | 入口置灰 + tooltip；已有分屏则在窗口缩小时夹紧比例而非强制关闭 |
| 插件作者依赖「全局只有一个聊天区」的暗假设 | 低 | 在 `resources/ui-plugins/SPEC.md` 备注：pane 作用域下 `useSession()` 等宿主 API 返回的是**该 pane 的会话** |
