# UI 规范

新增或调整 renderer 界面时阅读。基调：**克制、简约、苹果风**。复用现有组件与语义 token，不为单个功能另造视觉体系。

## 视觉规则

- 浮层/卡片无边框：`rounded-xl bg-surface shadow-soft`，弹出层用 `shadow-pop`，以阴影分层。
- 状态只用一枚着色 glyph 表达；不使用大面积色底、徽章、左边条。info glyph 用 `ink-faint`。
- 文字层级：标题 13px/500 `ink-2`，正文 13px，元信息 11px `ink-faint`，详情 11.5px mono `ink-dim`；实际字号必须用下文 token。
- 操作用幽灵按钮：平时 `ink-faint`，hover 显 `bg-hover`，主操作文字加重；不用实心底色抢注意力。
- 行内选择器用胶囊 `rounded-full px-2.5 py-1`，形状仅在 hover/展开时显现。
- 颜色仅用 `styles/globals.css` 的语义 token 和 severity 变量，深浅主题各有定义，不写死具体色值。
- 非必要不画结构分隔线。滚动边界使用 `.edge-fade` + `lib/use-edge-fade.ts`，只在该方向还有内容时淡出；聊天下沿贴输入框，不淡。
- 必须画线时用 `.fade-rule` / `.fade-rule-v`，中段实、两头充分淡出，不用突兀的 1px 实线。

## 字号只有一套入口

组件使用 `styles/typography.css` 的 `text-ui-*`，禁止 `text-[13px]`、`text-xs/sm/lg` 和行内固定 px 字号。

- 可用 token：`text-ui-10/105/11/115/12/125/13/135/14/15/16/18/19`。
- 档位与夹紧规则在 shared `typography.ts`；DOM 变量接线在 renderer `lib/typography.ts`。
- `globals.css` 必须先 import Tailwind，再 import `typography.css`，否则 preflight 会压掉按钮、输入框等字号。
- Monaco 是 JS 度量例外，复用 `monacoFontSizeFor` / `monacoLineHeightFor`。当前 Markdown 库只在创建编辑器时应用字号，换档需要重建代码块，不要误以为 CSS 变量会自动更新它。
- 修改后运行现有 typography 守护测试；专项验收查 `scripts/check-font-size.mjs` 文件头。

## 浮层与交互

- fixed 浮层通过 `createPortal(..., document.body)` 挂载。`.edge-fade` 的 mask 会裁剪整个绘制子树，子元素 rect 正确也可能只绘制出一部分。
- 优先复用 `components/ui/` 的 Tooltip、ContextMenu、ConfirmDialog、Switch 等；新增提示不用原生 title。右缘 Tooltip 用 `align="end"`，避免撑出横向滚动。
- 弹层尺寸和方向按可用视口夹紧。越界元素的 autoFocus 可能带动根容器程序性横滚；只看截图不够，需验证真实命中与溢出。
- 不手动删除 React 管理的 DOM；退场动画、卸载与焦点接管必须协调。
- 拖动结束不只监听 pointerup，也要覆盖 pointercancel / lostpointercapture 等取消路径，避免窗口外松手后永久停在拖动态。
- 动画遵守 `prefers-reduced-motion`。避免通过逐帧改变布局宽度让聊天内容连续重排；优先固定尺寸 + transform。
- 文案用 `useT()`，同时维护 `i18n/zh.ts` 与 `en.ts`；第三方原名不强行翻译。

## Composer 附件托盘配方

- 图片与文件/目录/会话统一放在正文上方的 `flex flex-wrap` 托盘，图片在前、文件在后；选中引用 `quotes` 独立一行且不计入折叠阈值。
- 芯片统一 `rounded-lg bg-hover h-5.5 px-2 text-ui-12 text-ink-2`；图片用 `size-4 rounded object-cover` 的真实 data URL 缩略图，类型尾缀用 `font-mono text-ui-105 text-ink-faint`，不新增色值或任意像素尺寸。
- 合计超过 5 枚时默认展示前 5 枚并用真实按钮展开/收起（`aria-expanded`）；草稿切换或总数回落至 5 枚以内时重置。折叠只裁剪渲染，不裁剪草稿或发送数据。
- 折叠态必须单行：按容器实宽算出这一行能放几枚（`+N 项` 钮的宽度也计入），全部放得下就直接平铺；宽度靠不可见的 `inert` 测量行拿真实芯片宽度，不复用阈值硬编码。
- 删除按钮不占流：绝对定位成渐变遮罩压在尾缀上（`w-5`，`bg-gradient-to-l from-hover`），常态 `opacity-0` + 不接收指针，hover / focus 时浮现并把尾缀淡出（原位替换）。Tooltip 复用 `components/ui/Tooltip`，仅暴露语义文件名/会话标题，不展示原始机器路径。
- 托盘有芯片时在托盘与正文之间画一条 `.fade-rule`（`mx-3.5`），无芯片不画。
- 正文 `<textarea>` 只在有 slash 命令胶囊时与其 flex 同行，否则保持 `w-full`。

## 已发送气泡的 @ 引用芯片

- 发送时附件会拼回 `@<path>` 文本；气泡渲染用 `chat/message-attachments.ts` 切成 text / reference 片段，reference 走 `chat/MessageAttachmentChip.tsx`，不显示机器路径。
- 只切真路径：会话转录按 `…/percho-transcripts/….md`（文件名可含空格与 `·`）匹配到 `.md` 收尾；普通路径必须带路径分隔符。`@昵称`、邮箱、普通词不切。
- 芯片与托盘同款柔灰：`rounded-md bg-hover h-5.5 px-1.5 text-ui-12`，前置 `@` + 单色 glyph + 语义名 + `font-mono text-ui-105` 类型尾缀（会话为「会话」微标）。
- **左键单击即执行主操作**：会话芯片 → 打开所在会话（必走前端 `useProjectsStore.openSession`，只调后端 IPC 不会切界面）；文件/目录芯片 → 系统默认应用打开。
- 会话转录新文件名保留完整会话 ID，导航按完整 ID 精确匹配，芯片与自动标题仍只展示语义名；无名转录支持完整 UUID 文件名。旧八位前缀引用仅在唯一匹配时跳转，多义时提示从侧栏重新拖入，不按标题猜测或选择第一条。
- hover / focus 才浮出**精简**操作卡：`createPortal` + `placeMenu` 夹进视口（避开 `.edge-fade` 的 mask 裁切）。不重复标题/副标题、不画 `.fade-rule`；只在名字被截断时补一行完整名。
- 菜单项规格对齐 `components/ui/ContextMenu.tsx`：`h-[30px] gap-[10px] rounded-[7px] px-2 text-ui-13` + 左侧 13px 单色图标，禁止裸文字列表。
- 会话芯片只留三项：打开所在会话（`SessionChatIcon`）/ 查看转录文件（`FileTextIcon`）/ 复制路径（`CopyIcon`）——会话不是本地文件，不给「在访达中显示」（只会指向 Temp 目录）。
- 原文不变：复制与撤回仍用 `message.text`，芯片只是展示层转译。

## 消息与图片的特殊边界

- UI 历史来自完整分支，而非压缩后的模型上下文，见 [架构](architecture.md)。
- 历史图片使用 `components/chat/history-image/` 资源层；稳定外盒、加载区门控、缩略图与原图预览各有归属，不在列表直接挂大量原图 data URL。资源释放与 worker 代次沿用现有服务，不在组件另建缓存。
- markstream/Monaco/Mermaid 的接入限制先查 `Markdown.tsx`、`MermaidBlock.tsx` 与现有测试；不要复制库内部实现。

实机调试与验收方法见 [UI 调试](ui-debugging.md)。
