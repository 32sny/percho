---
类型: 技术方案
状态: 方案已定稿待批准
创建: 2026-11-03
更新: 2026-11-15
适用: Percho 项目工作区文件树、只读文件查看与 Artifacts 预览联动
---

# 项目文件树与只读查看：从项目目录打开文件，不改动磁盘

> **关联总路线**：[Percho 后续功能完整路线图](PLAN-percho-follow-up-roadmap.md)
> **当前基线**：Percho 0.7.6 / SDK 1.5.1；2026-11-15补记Windows文件链接缺陷。正文文件树设计仍待实施前按获批HEAD核对路径、符号与安全边界。
> **状态边界**：本文是待审方案，不授权修改源码、配置、依赖或 UI 插件。
> **阶段归属**：本文实现 catalog **P4**「项目文件树只读 + 统一打开路由」；首版只读，完整 Monaco 编辑器归 **P8**，须另行批准。

## 一、目标与阶段边界

### 1.1 交付契约

用户可从当前项目打开文件树，展开目录并打开项目文件：

- 文本文件进入只读源码 surface；
- HTML、SVG、Markdown 和受支持图片进入合适的预览 surface；
- 有效项目路径外的读取一律拒绝；
- 目录读取按需加载，不递归扫描整个项目；
- 文件过大、二进制、消失、无权限时有明确状态，不冻结界面；
- 文件树、聊天文件引用和 diff 文件名通过一个 `openProjectFile` 路由；
- 现有 ArtifactsDrawer 的 transcript 产物行为保持不变。

### 1.2 非目标

- 不做 Monaco 编辑器、文件保存、创建/重命名/删除。
- 不做项目内全文搜索、⌘P 文件跳转、多标签或分屏文件 pane。
- 不把项目文件树塞进 ArtifactsDrawer 的产物数据模型。
- 不接受 renderer 提供的任意绝对路径。
- 不修改 agent 的读写工具、项目权限或 Git 状态。
- 不引入新的文件监听器；本期用户显式刷新或重新打开读取。

### 1.3 已登记缺陷：Windows 聊天文件链接无响应（WIN-LINK-01）

- **状态**：用户已要求后续实现；本轮仅登记，不改代码，不代表P4整体获准实施。
- **现象**：聊天里的本地Markdown链接显示为蓝色，但点击 `C:/Users/.../docs/release-notes.md` 或 `E:/输出项目库/.../清单.md` 没有反应；不是文件不存在。
- **已核实原因**：`renderer/src/components/chat/markdown-link.ts` 的通用协议正则将 `C:`/`E:` 当成未知协议，返回 `unsupported`；`Markdown.tsx` 随后阻止默认导航并静默返回。`main/path-target.ts` 已有Windows绝对路径解析，main `ipc/app.ts` 的既有 `openPath` 用 `shell.openPath` 调系统程序。
- **分步范围**：先修现有外部打开链路中的Windows盘符分类与绝对路径判定（包括没有cwd时），保持协议白名单；这项缺陷可单独修复，不必等待文件树/分屏。P4实施时再把可靠解析且通过项目安全校验的路径接入 `openProjectFile` 内嵌预览。外部打开不是应用内预览，不混称已实现。
- **项目外路径**：用户示例的E盘中枢文件可能在当前项目外。允许识别本地链接不等于允许项目内读取API任意读盘；界外文件沿用经审查的系统打开入口，或明确提示并提供复制路径，不能静默扩大预览权限。
- **待验收**：C/E盘绝对路径（正反斜杠）、中文/空格/百分号编码、`:行:列`后缀、相对路径与cwd有/无两种情况；HTTP(S)和页内锚点不回归；`javascript:`等危险/未知协议仍拒绝；缺文件或打不开给明确反馈。盘符相对路径（如`C:foo`）与UNC须明确策略，不用宽泛放行所有冒号绕过。需分类器单测及真实Windows点击验证。
- **实施入口**：`components/chat/markdown-link.ts`及其测试、`Markdown.tsx`、`main/path-target.ts`及其测试、`main/ipc/app.ts`。后续补齐P4预览时重新核对D5接口，不直接把绝对路径塞进项目读取DTO。

### 1.4 与已有桌面规划的差别

桌面长规划负责产品方向；本文只负责可在仓库内实施和验收的只读文件树方案。若获批，只能执行 catalog P4 的只读范围。编辑器阶段必须另行批准，不因本方案的目标 surface 预留而自动授权。

## 二、现有实现定位

### 2.1 可复用能力

| 能力 | 当前路径 | 方案中的用途 |
|---|---|---|
| 项目文件枚举 | `packages/backend/src/project/files.ts` `walkProjectFiles(cwd)` | 复用排除目录和排序原则；为树增加按目录枚举，不能拿现有全量路径数组直接画完整树 |
| 项目信任 | `packages/shared/src/ipc-channels.ts` `ensureProjectTrust` | 项目登记/信任入口仍走现有流程；文件读取不得放宽项目权限 |
| IPC 类型单源 | `packages/shared/src/ipc-channels.ts` | 新增文件操作通道，并通过现有 `CHANNEL_TABLE` 派生 API |
| Main IPC 装配 | `packages/desktop/src/main/ipc/` | 新增项目文件 handler；禁止 renderer 直接 `fs` |
| Artifacts 来源 | `renderer/src/components/artifacts/useArtifacts.ts` | 保持 transcript edit/write 派生逻辑作为“本轮产物”来源 |
| Artifacts 表面 | `ArtifactsDrawer.tsx`、`TopBar.tsx`、`Viewport.tsx`、`ZoomBar.tsx` | 复用既有可预览内容的展示能力，先抽/定义输入适配，不把文件内容写入 transcript |
| 会话与项目状态 | `stores/projects.ts`、`stores/session-workspace.ts` | 读取当前项目 cwd；不得将源码路径写进会话 `SessionWorkspaceSnapshot.files` |
| UI 规范 | `docs/ui.md` | 树、弹层、源码面板、字号、颜色和键盘交互的强制规范 |

### 2.2 当前缺口与旧假设纠正

1. `walkProjectFiles` 返回全项目相对路径，最多 5000 项并缓存 30 秒；不是按目录分页 API，也不是文件内容读取 API。
2. `useArtifacts()` 从 transcript 工具参数推导内容，不保证等于磁盘当前版本，不能作为项目文件查看器的读取后端。
3. `Viewport` 以 `srcDoc` + sandbox iframe 展示内容；现有 HTML sandbox 允许脚本，因此项目文件打开流程不得借此隐式扩大到任意本地文件/外部资源。
4. `SessionWorkspaceSnapshot.files` 持久化的是会话 JSONL 文件路径；它与源码文件无关。源码工作区需要单独状态，第一阶段只存项目标识和相对路径。
5. `ProjectEntry`/project root 的稳定 ID 与信任状态必须以当前实现确认；如果只有 cwd，没有稳定 projectId，采用规范化 cwd 作为临时请求键但 main 端必须重新解析/授权，不能信任 renderer 回传 root。
6. `realpath` 检查必须覆盖 Windows junction/symlink；仅用 `path.resolve(root, rel).startsWith(root)` 不够。

## 三、架构决策

### D1：新建 ProjectExplorer，与 ArtifactsDrawer 职责分离

ProjectExplorer 负责目录浏览和磁盘内容；ArtifactsDrawer 负责本轮产物列表、源码/预览/缩放。两者可接收同一 `ProjectFileOpenRequest` 并委托 shared `FileSurface`/preview adapter，但不共用 `ArtifactItem`，不把磁盘读取结果冒充工具调用产物。

### D2：IPC 以 project identity + 相对路径为输入

```ts
export interface ProjectFileRequest {
  cwd: string; // 仅用于匹配当前已登记项目；main/backend 必须复核
  relativePath: string; // POSIX 分隔符；根目录用 ""
}

export interface ProjectFileEntry {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
  size: number | null;
  modifiedAt: number | null;
}

export type ReadProjectFileResult =
  | { ok: true; relativePath: string; content: string; size: number; modifiedAt: number; contentHash: string; truncated: false }
  | { ok: false; code: "NOT_FOUND" | "OUTSIDE_PROJECT" | "NOT_TEXT" | "TOO_LARGE" | "PERMISSION_DENIED" | "READ_FAILED" };
```

`cwd` 不能成为任意本机路径授权票据。IPC handler 必须将其映射到已登记、已信任项目；无法匹配则 fail-closed。若实施时确认项目 store 已有稳定 id，DTO 改用 `projectId`。

### D3：按目录懒加载 + 明确资源上限

- `listProjectDirectory` 只枚举指定目录的直接子项，按目录优先、名字排序。
- 不跟随软链接/junction；目录读取上限固定首版 1000 entries，响应含 `truncated`。
- 默认隐藏/排除 `.git`、`node_modules`、`dist`、`build`、`out`、缓存和 vendor 目录；规则与 `walkProjectFiles` 对齐，并可单测。
- 文件读取默认上限 2 MiB；按字节读取后验证 UTF-8/二进制特征；超限返回 `TOO_LARGE`，不截断后伪装成完整源码。
- 目录缓存按项目 + 相对路径，TTL 30 秒；读取文件不缓存内容或只缓存当前打开的版本 hash。

数值属于首版产品保护上限，后续如需调整应由实际仓库和 UI 验收支撑，不在 renderer 随意覆盖。

### D4：文件打开状态独立于会话状态

新增 `stores/workspace-files.ts`，仅保存：当前项目 key、展开路径、当前相对文件、surface mode 和 request generation。第一版是否跨重启保存待确认；推荐仅进程内状态，避免打开不存在的项目时恢复噪声。绝不将绝对路径内容或文件正文持久化。

### D5：安全文件打开路由

```ts
openProjectFile({ cwd, relativePath, line?, source? })
  -> validate request
  -> readProjectFile
  -> classify by extension + returned bytes
  -> preview adapter (supported renderable types)
     or read-only source viewer
  -> optional line focus
```

文件树、聊天路径链接、diff 文件名只能传相对路径；无法可靠解析时保持普通文本，不猜路径、不调用 `openPath` 打开外部程序。

### D6：预览信任边界

首版只复用当前 ArtifactsDrawer 已支持的 HTML/SVG/Markdown 和图片类型；但需确认用户信任模型和 iframe sandbox 策略：

- 不给文件 iframe 增加 `allow-same-origin` 或 Node 能力；
- 不默认赋予任意 file URL 读取权限；
- SVG/HTML 中的脚本、弹窗与外部资源按当前 sandbox 策略处理；
- 如现有 `srcDoc` 渲染不能安全加载 CSS/图片相对资源，应以不支持资源引用或只读源码方式退化，不放宽 Electron webPreferences。

图片预览若需 blob URL，必须定义 URL 生命周期和撤销点。

## 四、核心状态机与时序

### 4.1 打开项目文件树

```text
用户打开 ProjectExplorer
  -> 从 projects store 取当前已登记项目 cwd/projectId
  -> listProjectDirectory({project, relativePath:""})
  -> main 复核项目登记、信任和目录 realpath
  -> backend 返回直属条目 + truncated
  -> store 检查 request generation 与当前项目仍一致
  -> 渲染根目录
```

失败时保留已有树状态并展示可重试错误，不清空其他项目状态、不更换当前会话。

### 4.2 展开目录

```text
用户展开目录 D
  -> 检查 D 是本树返回的 directory entry
  -> listProjectDirectory(project, D.relativePath)
  -> 忽略旧 project/generation 返回值
  -> 缓存 D 的 children 与 truncated
```

同一目录并发请求单飞；刷新只失效所选目录缓存，不重新扫描整个工作区。

### 4.3 打开文件

```text
用户点击文件 F / 聊天文件链接 / diff 文件名
  -> openProjectFile(relativePath)
  -> readProjectFile（每请求重验路径）
  -> 结果错误码映射成对应空态
  -> 成功后按类型交给只读源码或安全预览 surface
  -> 更新当前选择与文件 hash
```

若用户在请求期间切换项目，旧结果不得覆盖新项目。磁盘随后改变时显示“内容可能已变化”并给显式刷新，不自动覆盖 buffer。

### 4.4 刷新与失效

- 刷新目录：重新读取该目录，保留仍存在的展开节点。
- 刷新文件：重新读盘并替换只读内容；本阶段没有 dirty buffer，故不需要覆盖确认。
- 文件不存在：显示 `NOT_FOUND`，树节点在下次父目录刷新后消失。
- 项目失去信任/被移除：清空当前内容 buffer 和项目根节点，禁止继续读取缓存中的旧文件。

## 五、受影响文件与变更策略

| 模块 / 逻辑 ID | 目标文件路径 | 变更类型 | 核心策略说明 |
|---|---|---|---|
| 文件类型契约 | `packages/shared/src/project-files.ts` | 新增 | DTO、错误码、node/response 类型；无 Node/Electron 依赖 |
| IPC 通道 | `packages/shared/src/ipc-channels.ts` | 修改 | `listProjectDirectory`、`readProjectFile` typed invoke |
| 文件系统能力 | `packages/backend/src/project/files.ts` | 修改 | 复用现有排除项；增加单层枚举、受限 read、真实路径边界、缓存失效 |
| backend 导出 | `packages/backend/src/index.ts` | 修改 | 导出文件 API 与纯校验函数供 main 装配和测试 |
| Main IPC | `packages/desktop/src/main/ipc/project-files.ts` | 新增/修改 | 查项目/信任、转发 typed handler、错误不泄露绝对路径 |
| Main 装配 | `packages/desktop/src/main/ipc/index.ts` 或当前实际注册入口 | 修改 | 接入 handler；实施前重新核实真实装配文件名 |
| 文件状态 | `packages/desktop/src/renderer/src/stores/workspace-files.ts` | 新增 | 目录缓存、展开态、当前文件、request generation |
| 树组件 | `renderer/src/components/project/ProjectExplorer.tsx` | 新增 | 根目录、懒加载、筛选、刷新、空态和错误态 |
| 文本查看 | `renderer/src/components/project/ProjectFileViewer.tsx` | 新增 | 行号、长行策略、复制、刷新、行定位；只读 |
| 文件路由 | `renderer/src/lib/open-project-file.ts` | 新增 | 所有入口统一解析、读盘、surface 分类 |
| Artifacts 适配 | `renderer/src/components/artifacts/` | 修改 | 新增外部项目文件输入适配；不改 useArtifacts 的产物推导语义 |
| 聊天/差异跳转 | `renderer/src/components/chat/`、`components/diff/` | 修改 | 只接可靠的当前项目相对路径；路径含义不确定时不启用 |
| UI | `renderer/src/App.tsx`、`styles/globals.css`、i18n | 修改 | 挂 explorer 入口、语义 token、字号 token、双语和焦点路径 |
| 文档 | `docs/ui.md`、`docs/INDEX.md` | 修改 | 经批准实施后登记新形态和导航入口 |

## 六、测试设计与验证（TDD 契约）

### 6.1 Backend 纯函数与文件系统测试

在 `packages/backend/src/project/files.test.ts` 或当前同域测试布局新增：

- 根目录直属条目排序、目录优先；深层目录不被提前遍历。
- `.git`、`node_modules`、配置的构建目录过滤；每目录 1000 条上限和 `truncated`。
- UTF-8 正常读取、有效 hash、size/mtime 返回。
- `../outside.txt`、绝对路径、Windows drive path、UNC 均拒绝。
- symlink/junction 指向根外时拒绝；根内 symlink 按定案策略拒绝跟随。
- 文件不存在、权限失败、目录当文件、文件当目录。
- 超过 2 MiB 返回 `TOO_LARGE`；NUL/非法 UTF-8 返回 `NOT_TEXT`。
- 缓存 TTL 命中、显式失效以及不同项目隔离。

### 6.2 IPC 与 renderer 测试

- Main handler 不能只信 renderer cwd；未知/不信任项目拒绝。
- 参数校验失败不泄露本机绝对路径。
- ProjectExplorer 加载、展开、刷新、空目录、截断和错误重试。
- 切项目后旧请求迟到不覆盖新项目；关闭 surface 后迟到读取不恢复 UI。
- 点击 text/HTML/SVG/Markdown 各进入正确 surface；unsupported binary 显示明确空态。
- ArtifactsDrawer 从 transcript 推导的列表、选择和预览行为不回归。
- 测试沿用 `npm test -w @percho/backend -- <test-path>` 与 `npm test -w @percho/desktop -- <test-path>`；以 package Vitest scripts 为准，不使用 Jest 的 `--runInBand`。

### 6.3 手工验收

1. 在实际 Windows 项目中展开根目录、深层目录，并打开 TS、JSON、Markdown、HTML、SVG。
2. HTML/SVG 脚本和外部资源遵守既有 sandbox，不得到 renderer Node 权限。
3. 大仓库打开树时只请求根目录；展开才读取子目录，不扫描 5000+ 文件。
4. 用根外 symlink/junction 试读，必须拒绝；尝试盘符、UNC 和 `..`，均拒绝。
5. 文件外部改动后显式刷新可见新内容；删除文件后错误可恢复。
6. 同时验证 ArtifactsDrawer 原有 agent 产物预览、缩放、源码模式未回归。
7. 窄窗布局、焦点、键盘导航、Esc 和 reduced-motion 检查符合 `docs/ui.md`。

## 七、实施步骤与阶段门

- [ ] **阶段 0：重核事实**：确认 project id/cwd/信任真源、IPC 装配点、Artifacts 可复用 surface、当前 Electron sandbox；输出路径与接口差异清单后停手审查。
- [ ] **阶段 1：RED 安全测试**：先实现项目路径纯校验、realpath 边界、目录列表和读取的失败用例；越界/junction 断言必须失败。
- [ ] **阶段 2：Backend + IPC**：实现单层懒加载与有界文本读取；main 每次请求重新解析已登记项目并验证信任。
- [ ] **阶段 3：Renderer 文件状态与树**：增加 `workspace-files` store、ProjectExplorer 和只读 viewer；先不接聊天/diff 自动识别。
- [ ] **阶段 4：统一打开入口与预览适配**：按类型路由到安全 viewer/Artifacts preview；接入可靠的 diff/聊天路径。
- [ ] **阶段 5：回归与手工验收**：跑对应 backend/desktop 测试、typecheck、lint；完成 Windows 路径与 iframe 场景。
- [ ] **阶段 6：文档同步**：更新 `docs/ui.md` 与 `docs/INDEX.md`；本方案状态只有在证据齐备后才改为已实施。

### 阶段停止条件

- 无法建立稳定的项目根/信任映射。
- realpath/junction 边界在目标 Windows 环境无法可靠验证。
- 现有 Artifacts iframe 必须放宽 sandbox 才能显示项目文件。
- 文件树导致首屏全仓扫描或大量文件内容驻留。
- 聊天路径不能可靠映射到当前项目相对路径。

遇到上述任一项，停止并提交替代方案供用户确认，不扩展为任意路径查看器。

## 八、主要风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 路径穿越或 junction 越界读取 | 高 | main/backend 双端复核；realpath containment；负向 Windows 测试 |
| iframe 执行不可信项目内容 | 高 | 维持 sandbox；不加 Node/same-origin；无法安全预览时降级源码 |
| 大型仓库扫描阻塞 | 高 | 每层懒加载、数量上限、排除目录、TTL cache |
| Artifacts 伪装磁盘真值 | 中 | 两种数据模型、来源标识和读取路径分开 |
| 项目切换时旧 IPC 回包 | 中 | request generation + project key 校验 |
| Monaco/编辑器范围蔓延 | 中 | 明确不在此期；单独按 catalog P8 审批 |
| session-workspace 状态复用造成损坏 | 中 | 新建 `workspace-files`，类型和测试保护职责边界 |

## 九、审查清单

- [ ] 确认本次只批准 catalog P4 的只读文件树，不批准 P8 编辑器。
- [ ] 确认文件预览的 sandbox 策略；不以“先能显示”为由放宽权限。
- [ ] 确认目录/文件资源上限（默认 1000 entries / 2 MiB）。
- [ ] 确认文件树是否出现在当前项目侧栏，以及不支持项目态时的空态。
- [ ] 确认 A1 分屏先于文件 pane；本方案不把文件作为分屏 surface。
- [ ] 确认允许修改的源码路径与测试/文档路径。
- [ ] 用户明确批准实施后才开始阶段 0；批准本方案不意味着自动批准编辑器阶段。

**方案已完整落盘至 `docs/PLAN-project-file-tree-readonly.md`。请审查方案细节，确认无误请回复“批准执行”，我将正式按计划分步实施。**
