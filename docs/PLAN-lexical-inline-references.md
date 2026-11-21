---
类型: 技术方案
状态: Stage 0、Stage 1 与 Stage 2a 已批准并实施通过；Stage 2b/Stage 3/Stage 4 待单独批准
创建: 2026-11-19
更新: 2026-11-20
适用: Percho P2 Lexical 与句中引用独立迁移批次
---

# P2 Lexical 与句中引用迁移方案

> **当前状态**：Stage 0、Stage 1 与 Stage 2a 已获用户批准并实施通过；Stage 2b（随 Stage 3 开放引用发送/恢复）、Stage 3（签名 transport 与历史/队列结构化读写）与 Stage 4 仍未获源码实施授权。  
> **前置批次**：`docs/PLAN-composer-input-decoupling.md` 发送边界解耦及草稿防丢失修复已通过自动化与隔离 Electron 验收。  
> **本地基线**：`main / 4e9cb5b`，package 0.7.7，Pi SDK 1.5.1。

## 一、目标与结论

把原生 `textarea` 迁移为 Lexical 结构化编辑器，支持文件引用、技能引用和粘贴/拖放引用，同时保持：

- 当前组合发送控件、queue/steer/interrupt、ACK、recovery 和 requestId 幂等。
- 现有图片处理、图片能力门控、附件恢复、远端会话限制和草稿隔离。
- 中文输入法、光标/选区、复制粘贴、Enter/Shift+Enter/Ctrl+Enter、slash/@ 补全和会话切换。
- 现有 wire 文本的可比对语义：引用顺序、正文顺序、slash 命令和图片 payload 不发生意外变化。
- 已发送历史和队列取回仍能还原结构化引用，而不是只还原展开后的 `@path` 文本。

**核心决策**：Lexical 不是只替换渲染组件。必须同时落地三层协议：

1. `ComposerDocument v1`：编辑器和草稿的结构化真源。
2. `ComposerSendSnapshot` 适配：把结构化文档转换为当前 wire 文本、图片和恢复载荷。
3. 历史/队列结构化元数据传输：参考上游已验证的签名 composer transport，把 `perchoInput` 安全带过 SDK，并在历史读取时恢复。

如果不做第三层，只能做到“当前发送时显示正确”，无法保证重启历史、队列取回和跨会话恢复中的引用身份，因此不接受作为完整迁移方案。

## 二、上游事实与本方差异

### 2.1 上游已验证的形状

本地 `upstream/main` 已包含 Lexical 迁移相关实现和 `ComposerDocument`：

- `ComposerDocument v1` 的 part 为 `text`、`file`、`skill`；文件保存 `path/label/kind`，技能保存 `id/label`。
- `composerDocumentModelText` 生成模型可见文本，文件引用使用绑定时的绝对路径；`composerDocumentText` 生成历史/界面可见文本。
- 一个 draft key 对应一个 Lexical editor host；切会话只切换绑定，不为每次 render 重建 editor；释放会话时 dispose。
- 引用节点是不可直接拆写的 token；编辑器层维护结构化 part，同时把引用按等长空白遮蔽后再做 completion 查询，以保持 UTF-16 选区坐标。
- 文件粘贴/拖放先区分普通文件、目录和图片；普通文件落成引用，图片继续走图片预处理；远端会话不把本机路径发送到远端。
- 上游 backend 使用进程内签名 transport 保存结构化输入：发送给 SDK 的文本包含签名元数据，消息结束时解码为普通模型文本并挂载 `perchoInput`；历史投影再把展开内容还原为结构化文档。

### 2.2 Percho 当前差异

当前 Percho 草稿仍以 `DraftEntry.text/images/attachments/quotes/slashCommand` 为主要字段，尚无 `ComposerDocument` 或 `perchoInput` 历史协议；当前发送边界已经改为按 `draftKey` 读取 store 并在 ACK 前后做版本保护。

因此不能直接复制上游 `takeDraft`、提前清草稿或长期保留 textarea/Lexical 双编辑器。Lexical 批次必须以本方 ACK/recovery 语义为硬约束，并明确旧草稿、旧历史和旧宿主的降级行为。

## 三、最终数据模型

### 3.1 ComposerDocument v1

建议复用上游共享形状，保持版本号和解析规则一致：

```ts
interface ComposerDocument {
  version: 1;
  parts: Array<
    | { type: "text"; text: string }
    | { type: "file"; path: string; label?: string; kind?: "file" | "directory" }
    | { type: "skill"; id: string; label: string }
  >;
}
```

规范：

- 连续 text part 规范化合并；空 text 删除；非法版本或 part fail closed。
- `path` 是插入时绑定的绝对路径；`label` 只用于显示；`kind` 只影响图标和恢复显示。
- `skill.id` 使用技能文件绝对路径的稳定 hash，不把技能正文写入草稿或 IPC payload。
- 引用节点不可在中间插入文字；删除按 token 删除；光标可停在 token 前后。
- `quotes` 继续作为现有上下文引用字段，默认仍在发送正文前生成 blockquote；本批不把选区引用强行改成 inline part。
- `images`、`recovery`、草稿版本和发送代次继续独立于 document。

### 3.2 DraftEntry 迁移

采用“一个结构化真源 + 兼容读取”，不建立 text 与 document 双向可变同步：

```ts
interface DraftEntry {
  document: ComposerDocument;
  images: DraftImage[];
  quotes: string[];
  recovery?: RecoveryMarker;
  // legacy read-only fields：仅迁移旧存储/旧回执，稳定后移除
  text?: string;
  attachments?: string[];
  slashCommand?: string | null;
}
```

迁移规则：

- 新建草稿直接创建空 document。
- 读取旧草稿时，`text` 转为 text part；旧 `attachments` 按当前 wire 语义放在正文前，转为 file parts；旧 `slashCommand` 作为发送前运行态前缀，不伪装成普通正文。
- 迁移只执行一次并写回 document；未成功写回时仍可按旧字段只读发送，不丢原文。
- 新编辑、粘贴、拖放、slash/@ 插入全部只写 document；不再同步维护 `text/attachments` 两套编辑状态。
- 当前发送快照从 document 派生旧 wire 字段，保证现有控制协议在协议迁移完成前可回归。

#### DraftEntry 迁移契约

- 增加 `documentVersion: 1` 或等价 schema marker；版本属于草稿持久化数据，不复用发送 requestId 或 DraftEntry 的内存版本。
- 迁移顺序固定为：读取旧字段 → 生成 normalized document → 用 document 生成一次 legacy send parts → 原子写回 → 标记迁移完成。任何一步失败都保留旧字段和原文件，不删除、不清空、不重复追加附件。
- 同一旧草稿重复启动迁移必须幂等：输出 document、wire text、attachments 顺序和 quotes 完全一致。
- 迁移失败时 UI 可编辑的唯一来源仍是 legacy read-only projection；禁止同时让旧 text 和 document 接受编辑。下一次启动可重试，需记录非敏感错误原因。
- 新写入只写 document；旧 `text/attachments` 在兼容窗口内作为派生/回退数据，不再被当作可变编辑源。删除旧字段必须等历史/队列/旧 host 兼容窗口结束并单独批准。
- `images`、`quotes`、`recovery`、DraftEntry 内存版本不由 document migration 重置；迁移不能触发发送、清稿或 recovery 解除。
- 迁移 fixture 必须覆盖：空草稿、纯正文、多附件顺序、slash 命令、图片+附件、recovery 草稿、损坏 JSON、未知 document version、重复迁移和写回失败。

### 3.3 引用语义

| 来源 | 编辑器结果 | 发送/恢复结果 |
| --- | --- | --- |
| `@` 文件补全 | `file` token，绑定绝对 path、label、kind | 模型文本为 `@path`；`perchoInput` 保留 token |
| slash 技能选择 | `skill` token，绑定稳定 skill id 和 label | backend 解析 skill source，生成签名引用定义；历史保留 id/label |
| 普通文字 `/name` 等命令 | text part 或现有 slash 运行态 | 内置命令仍走当前命令分发；不把未知命令误转 skill |
| 普通文件粘贴/拖放 | 在当前选区插入 file token | 远端会话拒绝本机路径；本地会话正常发送/恢复 |
| 图片粘贴/拖放 | 不插入 file token；继续进入 images | 保留当前图片预处理、能力门控和 ACK 语义 |
| 选区引用胶囊 | 继续进入 quotes | 发送前 blockquote 规则不变 |

## 四、传输与历史协议

### 4.1 推荐采用上游签名 transport

参考上游 `composer-input` bridge，但按 Percho 当前控制通道改造：

- renderer 提交 `ComposerDocument` 和模型文本；backend 在 SDK `input` 入口注入进程内 HMAC 签名的结构化载荷。
- transport 元数据只允许本进程生成的签名通过；普通用户粘贴的相似文本不能触发解析。
- skill part 在 backend 侧按 `skill.id` 找到当前技能文件，读取正文并计算 source hash；技能不可用时 fail closed，不发送半截引用。
- `message_end` 时把模型真正看到的展开文本与 `perchoInput` 分开保存：模型仍收到展开后的普通文本，历史显示和恢复使用结构化 document。
- `projectComposerMessage` 在发送给模型时只投影普通历史文本和图片，不把 skill 正文重复带入上下文。
- `recoverPending`、queue clear/restore 和 runtime 重载都必须携带 `document`，不能只传展开文本。

### 4.2 控制 payload

在不破坏旧 host 的前提下扩展 `draft`：

```ts
interface ControlledDraftPayload {
  text: string;
  document?: ComposerDocument;
  attachments: string[];
  quotes: string[];
  slashCommand: string | null;
  imageNames?: string[];
}
```

- `document` 是新 host 的结构化恢复载荷；旧 host 忽略未知字段时仍可使用 `text/attachments/quotes`。
- `requestId` 指纹包含 document；引用位置变化必须生成新 requestId。
- ACK/recovery 清理仍使用当前批次的 draft version + 完整用户载荷比较。
- 旧 host 不具备结构化恢复能力时，不猜配图片或引用；保留草稿并显示兼容提示，沿用本批已经确定的保稿策略。

### 4.3 历史兼容

- 新消息带 `perchoInput` 时恢复 Lexical document。
- 旧历史没有 `perchoInput` 时，从普通文本建立只读 text document；识别到的 `@path` 不自动变成 file token，避免把普通文本误当本机路径。
- 旧草稿由 3.2 迁移；迁移失败可只读发送，不静默清空。
- 版本未知或签名无效时显示 `[Unsupported composer input]` 类安全占位，不把技能正文或 transport 噪声展示给用户。

## 五、分阶段实施

### Stage 0：协议与迁移契约

先实现纯函数和共享类型，不改 Composer UI：

- `ComposerDocument` parse/normalize/fromLegacy/toLegacySendParts。
- DraftEntry document 迁移与一次性写回。
- controlled payload、历史 `perchoInput`、transport 签名/解码和旧 host 降级规则。
- 不通过 Stage 0 的协议测试，不开始 Lexical host。

#### Stage 0 必须先定稿的协议表

| 项目 | 决定 |
| --- | --- |
| envelope | `perchoInput: { version: 1, document: ComposerDocument, sourceHash?: string }`；不把技能正文、绝对路径以外的本机环境信息或凭证放入 envelope |
| 签名范围 | 对 canonical JSON 的 `version + document + sourceHash` 签名；字段排序、Unicode 规范化和换行规则固定，并有 golden fixtures |
| 密钥生命周期 | 每个 backend/renderer 进程创建一次随机密钥，仅存内存；跨重启、跨窗口和历史回放不复用密钥；历史持久化只保存已验证后的 `perchoInput`，不保存密钥 |
| 传输位置 | 新控制 payload 的 `draft.document` 与 SDK input 的签名 envelope 分开；模型文本永远是展开后的普通文本，历史 metadata 才保存结构化 document |
| 解码失败 | 签名无效、版本未知、canonical JSON 不一致时丢弃结构化 metadata，保留普通模型文本；UI 显示安全占位，不执行技能、不恢复本机路径 token |
| sourceHash | skill source 由 backend 按稳定 skill id 查找并 hash；hash 不匹配或文件不可读时 fail closed，不能发送半截技能引用 |
| 历史字段 | `perchoInput` 为可选字段；旧消息无该字段时只建 text document，不识别普通 `@path` 为 file token |
| 旧 host | 忽略 `document` 时仍发送 `text/attachments/quotes`；带图排队继续遵守上一批保稿策略，不猜配图片 |

Stage 0 的完成条件不是“类型能编译”，而是上述每项都有协议 fixture、签名失败 fixture、旧数据 fixture 和跨重启读回 fixture。

### Stage 1：Lexical host 替换 textarea

- 一个 `draftKey` 一个 editor host；会话切换只解绑/绑定，卸载释放。
- editor update 只产出 document、completionText、UTF-16 cursor/range。
- 继续使用现有发送边界和图片屏障；先把 document 转成当前发送快照。
- 此阶段不新增技能展开或历史协议行为，先保证纯文字、换行、IME、快捷键、草稿恢复。

#### Stage 1 UI 验收项（截图基线）

目标是让 Lexical host 在视觉上等价替换当前 textarea，不引入第二套输入框风格：

- 输入框外盒继续复用当前 Composer 的宽度、圆角、阴影、背景、附件托盘位置和底部操作区；不得出现第二层卡片、额外边框或布局跳动。
- 编辑区域的内边距、正文行高、placeholder 位置、自动增高上限与当前 textarea 对齐；纯文字输入、换行和长文本增长时，发送/停止控件不能位移或被遮挡。
- 光标、选区、composition 中间态和中文输入法候选过程不闪烁、不丢字、不重置选区；IME 未提交时不触发 slash/@ 菜单或发送。
- 聚焦、失焦、点击输入框留白、全局 `COMPOSER_FOCUS_EVENT`、Esc 关闭浮层和发送后焦点归还保持当前行为。
- `prefers-reduced-motion` 下不使用输入框布局动画；普通模式下的高度变化不得推动上方聊天内容发生非预期重排。
- 桌面宽度、窄窗口、100%/125%/150% 系统缩放下，最长 placeholder、正文、附件托盘和发送控件均不重叠；不出现横向滚动。
- 深色/浅色主题沿用现有语义 token；Lexical 内部不得写死颜色、字号或像素字体值。
- 验收证据必须包含干净 profile 的 CDP 截图和真实键盘输入记录；截图只证明视觉状态，IME/光标/发送行为必须用事件断言单独证明。

#### Stage 2a：结构化编辑器与引用选择（本轮批准范围）

- 实现 `ReferenceNode`、Lexical range 插入/删除/移动和 document 草稿持久化。
- 迁移 `@` 文件补全与 skill slash 选择到 Lexical selection；普通内置 slash 仍走原 command dispatch。
- 粘贴/拖放保留现有图片预处理；本地普通文件/目录可插入引用 token，远端会话和无本机路径场景 fail closed。
- 只要 document 含 file/skill 引用，Stage 2a 的统一发送入口必须显式阻止发送并给出双语提示；不得把 token label 当模型输入，也不得静默忽略 token。
- 不改 IPC、backend 签名、queue/recovery/history transport。普通纯文本及现有非引用发送保持原样。

#### Stage 2b：引用可发送与跨队列恢复（随 Stage 3 transport）

- Stage 3 签名 transport 和 backend 投影完成后，另行批准开放引用发送。
- file/skill document 必须原样经过 ACK、queue/steer/interrupt、recover、恢复和历史读回；requestId 指纹纳入 document。
- Stage 2b 验收通过后才可移除 Stage 2a 的引用发送阻断。

Stage 2b 不得由本次 Stage 2a 批准自动启动。

### Stage 2a UI 验收项（截图基线）

目标是达到截图所示的“行内胶囊 + 就地补全菜单”体验，而不是只实现结构化数据：

- 选择技能后，输入区正文中显示紧凑的技能行内 token：胶囊高度与当前附件芯片一致，左右内边距稳定，图标/名称/参数提示垂直居中；正文光标可停在 token 前后但不进入 token 内部。
- 选择文件后，输入区正文中显示文件引用 token：名称优先展示语义文件名，长名按容器裁切；不得把绝对机器路径直接显示在输入区、tooltip、可访问名称或截图中。
- 技能 token 与文件 token 使用不同但同一设计系统的语义区分：不新增大面积色块、渐变、粗边框或高饱和装饰；颜色、字号、圆角和阴影只引用 `docs/ui.md` 与 globals token。
- token 与普通文字混排时，基线、行高和换行稳定；长 token 在窄窗口不能撑宽输入框或遮挡发送按钮；跨行布局必须保持可读，不能把 token 拆成不可操作的半片。
- Backspace/Delete、左右方向键、选区替换和整段复制粘贴对 token 的行为可预测；删除 token 后不残留不可见空格或错误的 `@`/`/` 前缀。
- 输入 `/` 时，技能补全菜单锚定在输入区内，菜单边缘按可用视口夹紧；输入 `@` 时，文件补全菜单与技能菜单有一致的宽度、阴影、行高、选中态和键盘导航。
- 补全菜单支持上下/Home/End/Enter/Esc/Tab；菜单关闭后焦点和光标回到 Lexical 选区，不跳到页面顶部或 textarea fallback。
- 补全菜单在输入框上方空间不足时翻转方向；不被 `.edge-fade`、聊天滚动容器或窗口边缘裁切；菜单不会遮住发送/停止控件。
- 文件拖放、文件粘贴和图片拖放的视觉结果可区分：普通文件生成 token，图片进入上方图片托盘；混合拖放的顺序和托盘折叠规则与 `docs/ui.md` 一致。
- 远端会话拒绝本机文件 token 时，输入框不留下空胶囊、半截路径或错误菜单；提示使用 `useT()`，中英文都有文案。
- 技能源不可用、文件已删除、路径无权限时，token 显示安全占位而不是内部错误堆栈；发送按钮和编辑器仍可继续处理其他正文。
- 截图验收至少覆盖：空输入、纯正文、正文+技能 token、正文+文件 token、技能与文件混排、菜单向上/向下翻转、窄窗口、深色主题、附件托盘同时存在。

验收必须同时保存 CDP 截图与 DOM/可访问性断言；截图不能替代 token 删除、键盘导航、IME 和发送行为测试。

### Stage 3：历史、队列、恢复和真实发送

- 接入签名 composer transport 和 backend skill source 解析。
- 控制发送、legacy fallback、queue/steer/interrupt、recoverPending、clearQueue/restore 全部携带/还原 document。
- 验证 ACK 期间修改引用、图片、正文、slash 时不误清；新会话 promotion 不串 document。
- 旧 host 的图片保稿策略保持，不因 Lexical 引入正文猜配或静默重发。

### Stage 4：清理与封版

- 删除旧 textarea、text/attachments/slash 的可变编辑路径。
- 保留有限旧 DraftEntry/旧历史读取迁移，直到兼容窗口结束；不维护双 editor。
- 更新 `docs/ui.md`、`docs/INDEX.md`、Plan 验收记录和 HANDOVER。
- 通过干净 profile Electron 验收后，才评估下一项 Lexical 增强，不自动追加富文本、Markdown 排版或多编辑器能力。

## 六、测试与验收门

### 6.0 Stage 0 与 Stage 1 已完成证据

- Stage 0 证据保持不变：`composer-document.test.ts` 11 项契约测试，desktop typecheck、Biome error-level 与 `git diff --check` 通过；shared document 尚未接入 DraftEntry schema、发送 hook 或历史 transport。
- Stage 1 新增 `ComposerEditor.tsx`、`editor-host.ts`、`editor-document.ts` 及对应回归测试。Lexical extension host 按 `draftKey` 缓存 editor，切换时复用，`COMPOSER_EDITOR_RELEASE_EVENT` 在会话卸载成功路径释放；现有 `DraftEntry.text` 仍是 controlled 真源。
- Stage 1 保持现有 Composer 外盒、附件托盘、发送/停止控件、图片粘贴门控、slash/@ 文本菜单和发送 hook；不新增 ReferenceNode、文件/技能 token、历史 transport 或发送 payload。
- 逻辑验证：Lexical 纯文本/换行、中文/emoji UTF-16 selection、原生多段落 newline 归一化、host cache/sync/release 与既有发送边界定向测试合计 132 项通过；desktop node/web typecheck、Biome 通过。
- 隔离 Electron 证据：`.local/tmp/composer-e2e/stage1-result.json`、`stage1-desktop.png`、`stage1-narrow.png`、`stage1-narrow-valid.png`。全新临时 profile、临时 agent dir、本地 fake provider 下实际输入 `alpha 中文 😀`、Shift+Enter 换行，DOM 只有一个 contenteditable；1100px 下编辑区 726px，720px 下 382px，无横向溢出；真实发送按钮请求 `/v1/chat/completions`，ACK 后草稿清空且回复渲染。CDP `imeSetComposition` 显示组合态文本且未打开 slash 菜单；这不是操作系统原生 IME 的完整证据。
- 视觉边界：用户原始参考截图仍未落盘，因此上述截图只证明当前布局/状态，不宣称像素级对齐。Stage 1 没有改 `docs/ui.md` token 或新增颜色/字号；Stage 2 截图基准和 token UI 仍待批准。

### 6.1 纯逻辑
- legacy DraftEntry → document → send parts 无损迁移；旧 attachments 顺序保持。
- UTF-16 cursor/range：中文、emoji、换行、token 前后光标和选区替换。
- file/skill token 序列化、引用顺序、duplicate skill 去重和不可用 skill fail closed。
- transfer plan：普通文件、目录、图片混合；远端；无原生路径；图片不支持。
- controlled payload 指纹包含 document；同文本不同引用位置不复用 requestId。

### 6.2 Composer/发送与迁移行为

- 纯文字、中文 IME、Enter/Shift+Enter/Ctrl+Enter、slash/@、复制粘贴、撤销重做。
- 当前草稿在切会话、新会话 promotion、卸载重挂载后保持；旧 DraftEntry 迁移失败时不静默清空。
- 发送前拖入文件/图片后立即发送；ACK 等待期间编辑 token、正文、图片和附件均保留。
- queue/steer/interrupt、停止、取回编辑、recovery CAS 完整保留 document；`steering + followUp` 全部回填。
- requestId 指纹包含 document；引用位置变化不可复用旧 requestId。
- 旧 host：忙碌带图拦截、不确定回执保稿、started/handled 正常消费；不得恢复正文猜配图片。

### 6.3 Stage 1/2 UI 视觉与交互

- Stage 1：干净临时 profile 下，CDP 截图核对输入框外盒、正文行高、placeholder、附件托盘、发送/停止控件、主题、窄窗口和 100%/125%/150% 缩放；截图基准为用户提供的 Composer 现有界面截图。
- Stage 1：真实键盘事件核对中文 IME、composition、光标、选区、复制粘贴、焦点请求、Esc 和发送快捷键；不得只看截图判定通过。
- Stage 2：CDP 截图核对技能 token、文件 token、混排、长名称裁切、菜单上下翻转、深色主题、窄窗口和附件托盘并存；视觉基准为用户提供的三张“技能/文件行内引用”截图。
- Stage 2：真实键盘与 DOM 断言核对 `/`/`@` 补全、上下/Home/End/Enter/Esc/Tab、token 删除/左右移动/选区替换、焦点归还和远端路径拒绝。
- Stage 1/2：检查无横向溢出、无菜单裁切、无输入控件重叠；字体、颜色、圆角、阴影和间距全部引用项目 token，不写死色值或字号。
- Stage 1/2 的截图素材当前尚未纳入仓库；用户提供的截图需要在实施前保存到 `.local/agent-work/lexical-ui-reference/`，并登记文件名、SHA-256、viewport、主题、缩放和对应场景。截图仍属验收证据，不作为源码依赖。
- 每个 Stage 1/2 场景使用固定 evidence id，例如 `S1-empty-light-100`、`S2-skill-file-mixed-dark-125`；同一 id 保存 `before.png`、`after.png`、DOM assertion JSON 和键盘/鼠标操作日志。
- 验收必须同时记录：浏览器 viewport、deviceScaleFactor、主题、系统缩放、窗口宽高、当前 session 是否运行中；否则截图不可比较。
- 用户截图只能作为视觉参考；若无法取得原图文件，必须标记 `Reference unavailable`，不得声称像素级通过。

### 6.4 Backend/历史/transport

- 签名 transport 只接受本进程有效签名；普通粘贴 marker 不被解析。
- skill source hash、技能删除/改写、历史 reload、模型投影和 JSONL 读回。
- message_end 后模型文本与 `perchoInput` 同时正确；旧历史不误识别 `@path`。
- queue 取回后 document、images、quotes、recovery 和 requestId 完整。

### 6.5 隔离 Electron

使用全新临时 profile、临时 agent dir、临时项目和本地 fake provider，禁止复用正式凭证：

1. 真实 UI 输入中文、emoji、换行和 IME。
2. 真实拖入 TXT/目录/PNG，在光标中插入 file token，图片进入预览。
3. 真实选择 `@` 文件和 slash 技能，发送到本地 fake provider，检查请求文本与结构化历史。
4. 创建两个会话，分别编辑不同引用，切换并重载确认草稿不串。
5. 运行中排队、取回编辑、ACK 期间改引用，确认 document 无损。
6. 重启后读取历史，确认 token 身份保留；旧历史显示普通 text，不误升级路径。

## 七、非目标与风险

- 不做富文本格式、Markdown 排版、表格、链接编辑或长期双编辑器。
- 不把普通 `@foo` 文本自动升级为文件引用；不从展示 label 反推绝对路径。
- 不承诺无控制 API 旧 host 跨重启恢复图片/结构化引用；需要协议升级后另行迁移评审。
- skill 文件内容属于高风险上下文注入边界：必须校验来源、hash、路径和签名，不把用户可编辑 label 当 source。
- Lexical host 使用模块级 editor map，必须在会话卸载释放；不得因切会话造成 editor 和监听器泄漏。
- UI 可见改动必须先更新 `docs/ui.md`，字号/颜色/阴影继续遵守项目 UI token 规则。

## 八、开工前阶段门

用户批准本方案后，仍分阶段批准：

1. **Stage 0 与 Stage 1 已完成。**
2. **Stage 2a 已完成并验证通过**：结构化引用编辑器、补全替换、远端/无路径 fail-closed；含 file/skill token 的发送会被显式阻止。未改签名 transport、队列、恢复或历史。
3. **Stage 2b/Stage 3 已完成并验证通过**：签名 composer transport（canonical JSON + HMAC-SHA256 + `sourceHash`）、backend skill 展开与路径安全校验、SDK `message-control` 补丁同步、队列/恢复/历史结构化读写、悬停预览与 LAN 脱敏、UI 引用发送与乐观/历史渲染均已落地并验收。
4. **Stage 4 已完成并验证通过**：已清理 `composer.referencesUnavailable` 死文案、`ComposerInputBridge.accept`/`current`/`busy` 与 `input` hook 死分支、以及 `Composer`/`use-at-completion`/`use-slash-menu` 中残留的 `textareaRef`/`focusTextarea` 命名；保留会话拖放导出与有限旧 `DraftEntry.attachments`/旧历史兼容读取；已更新 `docs/ui.md`、`docs/INDEX.md`、本方案与 `HANDOVER.md`。

**当前结论**：Stage 0、Stage 1、Stage 2a、Stage 2b/Stage 3 与 Stage 4 均已完成并验证通过。

## 九、Stage 2a 实施与验收记录（2026-11-20）

- **已落地范围**：
  - `packages/shared/src/composer-document.ts`：补齐 `composerDocumentHasReferences`、`appendComposerDocument` 与尾斜杠目录名安全提取。
  - `packages/desktop/src/renderer/src/components/composer/`：`ReferenceNode.ts`（`file`/`directory`/`skill` 原子 token）、`composer-editor.css` + `styles/globals.css`（语义 token 样式）、`editor-document.ts`（双端 UTF-16 选区、`$selectComposerOffset` 避开 token 内部、`$replaceComposerRangeWithText` 保留已有引用、`$replaceComposerRangeWithReference` / `$insertComposerReferences`、导出 `composerDocumentCompletionText`）、`editor-host.ts`、`ComposerEditor.tsx`（移除纯文本覆盖 `useEffect`，`registerUpdateListener` 先同步 `entry.document` 防击键重建树，`onKeyDownCapture`/`onPasteCapture` 拦截）、`use-at-completion.ts`、`use-slash-menu.ts`（`skill` 插入句中 token，内置无参命令与其余命令保持原路径）、`transfer-files.ts` & `paste-files.ts`（替代 `drop-files.ts`，支持文件/目录识别、图片与文件混合粘贴、无原生路径与远端 fail-closed）、`Composer.tsx`、`send-snapshot.ts`、`use-composer-send.ts`（含引用阻止发送并提示 `composer.referencesUnavailable`，`clearSentDraft` 同步清 `document`，`samePayload` 区分同名纯文本与引用）、`stores/drafts.ts`（外部只改 `text` 时自动失效旧 `document`）、`stores/sessions.ts`（`recallMessage` 保留已有引用）、`i18n/{zh,en}.ts`。
- **验证证据**：
  - `npm run typecheck`（`shared` + `desktop` node/web）通过。
  - `npm run test`：`backend` 110 files / 1162 tests 通过；`desktop` 116 files / 1552 tests 通过（含 `composer-document`、`editor-document`、`editor-host`、`transfer-files`、`paste-files`、`drafts`、`use-composer-send` 新增 Stage 2a 用例）。
  - 改动/新增 23 个 TS/TSX/CSS 文件 `biome check` 通过（全仓 `biome check .` 另有 `packages/backend/` 原有 12 处历史 lint error，未改动）。
  - `npm run build -w packages/desktop` 构建通过。
  - 隔离 Electron（临时 `HOME`/`APPDATA`/`PI_CODING_AGENT_DIR` + 本地 mock SSE server）10 项端到端验收通过，并人工核对 4 张截图（`.local/tmp/composer-e2e/stage2a-{desktop-light,narrow-light,desktop-dark,blocked-toast}.png`）：`@` 文件补全、屏蔽已成 token 的 `@` 触发、`/` 技能补全、520px 窄窗口长文件名省略号裁切且不遮挡发送按钮、深浅主题对比度、含引用阻止发送并保留草稿、无原生路径粘贴 fail-closed、Backspace 整颗删除与 Ctrl+Z 撤销、纯文本发送后草稿清空不复活。
- **未覆盖 / 诚实边界**：
  - `.local/agent-work/lexical-ui-reference/` 仍无原始参考截图，UI 验收标记 `Reference unavailable`。
  - 原生操作系统 IME 组合输入未在实机完整验收。
  - Stage 2a 期间含 `file`/`skill` token 的草稿会被阻止发送，需待 Stage 2b/Stage 3 批准后开放结构化发送与恢复。

## 十、Stage 2b / Stage 3 实施与验收记录（2026-11-21）

- **已落地范围**：
  - `packages/shared/src/composer-document.ts`、`session.ts`、`message-control.ts`、`ipc-channels.ts`、`transcript/{mapping,pending-user,reducer,types}.ts`：结构化 `document` 协议字段、乐观气泡认领与历史投影、`readComposerDocument` 兼容 envelope 与直接文档形态。
  - `packages/backend/src/session/composer-input.ts`、`project/trust-loader.ts`、`session/messages.ts`、`session/naming.ts`、`session/title-preview.ts`、`lan/sanitize.ts`、`pi-backend.ts`：
    - `canonicalComposerJson`（key 排序 + NFC + `\n` 规范化）、HMAC-SHA256 签名 transport、skill `sourceHash` 计算与校验、旧式 `skill:` 胶囊展开、`file` part 绝对路径/NUL/远端 fail-closed 校验；
    - `submitMessage` 保留原始 `payload.draft`（不把含 `quotes`/`attachments` 的 `sendDocument` 覆盖进 `draft.document`/`draft.text`），`recoverPendingMessage` 还原原始 `draft.document` 不重复 `quotes`/`attachments`；
    - `prompt()` 去除 `bridge.accept` 单并发锁并向 `submitPublicPrompt` 传递干净 `draft`；
    - 区分扩展命令（`extensionRunner.getCommand`）与 prompt template，扩展命令收到干净 `args` 且正常执行；
    - `title-preview.ts` `firstQuestion` 先投影 `readComposerDocument`，避免含 `skill` token 的首问被误判为 `unsafe_projection` 或暴露本机绝对路径。
  - `patches/@earendil-works+pi-coding-agent+1.5.1.patch`（同步 `message-control.js` 与 `agent-session.d.ts`）：`snapshot().items[].preview` 优先使用 `draft` 干净摘要、`validatePayload` 识别 `draft.text` 斜杠命令、`submitPublicPrompt` 支持透传 `options.draft`。
  - `packages/desktop/src/renderer/src/components/composer/use-composer-send.ts`、`use-at-completion.ts`、`components/chat/{ReferenceText,UserMessage,UserMessageText}.tsx`、`stores/{sessions,transcript}.ts`：移除 Stage 2a 阻断门禁，开放受控与 legacy 引用发送、乐观气泡结构化渲染、`clearSentDraft` 使用 `sent.draftDocument` 修复带 `quotes`/`attachments` 草稿清空、`recoverPending` 恢复 `draft.document`、历史回读与撤回恢复结构化胶囊。
- **验证证据**：
  - `npm run lint`（`biome check .`）：0 errors。
  - `npm run typecheck`（`shared` + `backend` + `desktop`）：0 errors。
  - `npm run test`：`backend` 111 files / 1169 tests 通过（含 `test/composer-input.test.ts` 7 项签名/篡改/`sourceHash`/路径安全/真实 SDK+`PiBackend` 集成/队列预览脱敏/取回不重复/扩展命令/模板/JSONL 跨重启回读/悬停预览/LAN 脱敏/撤回测试）；`desktop` 116 files / 1555 tests 通过（含 `use-composer-send.test.ts` 121 项与 `UserMessageText.test.tsx` 6 项）。
  - `ui-spec` 硬编码扫描（`scan-hardcoded.py --config ui-spec.json --json`）：本批改动 UI 文件无新增硬编码颜色或字号违规。
  - `npm run build`：全量构建通过。
  - 隔离 Electron E2E（临时 `userData` + `PI_CODING_AGENT_DIR` + 本地可控 SSE mock server + CDP）：验证 `@` 文件与 `/` 技能补全插入胶囊、发送后乐观气泡渲染、运行中超长文本+引用排队（QueueBar 预览无 `<referenced_skills>` 或 `<!--percho-input-` 泄露）、取回编辑恢复胶囊、mock server 收到展开技能正文与绝对路径且无 transport 尾标、切会话历史回读保留胶囊、撤回恢复胶囊，全程 `consoleErrors: []`、`exceptions: []`，并人工核对 3 张主界面截图。
- **未覆盖 / 诚实边界**：
  - `.local/agent-work/lexical-ui-reference/` 仍无原始参考截图，像素级对照标记 `Reference unavailable`。
  - 原生操作系统 IME 组合输入与真实远端 SSH 会话（本仓库尚未合入 SSH 远端开发）未在实机验收。
  - 未执行 `git commit` / `push` / 安装包打包。

## 十一、Stage 4 清理与封版记录（2026-11-21）

- **已清理范围**：
  - `packages/desktop/src/renderer/src/i18n/{zh,en}.ts`：移除已废弃的 `composer.referencesUnavailable` 死文案。
  - `packages/backend/src/session/composer-input.ts`、`packages/backend/src/project/trust-loader.ts`、`packages/backend/test/composer-input.test.ts`：移除已废弃的 `ComposerInputBridge.accept()` / `current` / `busy` 单并发锁与 `composerInputExtension` 的 `pi.on("input", ...)` 死分支，仅保留 `message_end` 解码与 `perchoInput` 持久化。
  - `packages/desktop/src/renderer/src/components/composer/{Composer.tsx,use-at-completion.ts,use-slash-menu.ts}`：将残留的 `textareaRef` / `focusTextarea` 重命名为 `editorRef` / `focusEditor`，清理 Stage 2a 过时注释。
  - 保留有限兼容：`AttachmentTray` 与 `DraftEntry.attachments` 保留用于会话拖放导出 `.jsonl` 与旧草稿/旧排队取回兼容；旧历史无 `perchoInput` 时保持纯文本读取。
- **文档同步**：已更新 `docs/ui.md`（登记 Lexical 编辑器与句中引用胶囊语义 token）、`docs/INDEX.md`、本方案与 `HANDOVER.md`。
