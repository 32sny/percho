---
类型: 技术方案
状态: 第一阶段及草稿防丢失修复已实施；自动化与隔离 Electron 验收通过，待用户验收
创建: 2026-11-19
更新: 2026-11-19
适用: Percho P2 发送边界解耦第一阶段；Lexical 接入之前
---

# P2 输入层解耦第一阶段：发送边界解耦

当前基线为 `main / 4e9cb5b`，package 版本 0.7.7。用户已批准本阶段实施，并批准后续 ACK 草稿防误清、旧宿主队列防丢失及隔离 Electron 验收。本文记录最终实现；此前的 draft controller、readiness hook 与按正文猜配 legacy 图片快照的方案均未采用。

阶段顺序仍以 `PLAN-percho-feature-catalog.md` 为准；本批通过后不自动开始 Lexical 或句中引用。

## 一、实施范围

本批建立 `useDraftStore → 发送快照 → 发送执行` 的单向边界。继续使用现有 textarea、组合发送控件、菜单、图片预处理和文件拖放实现。

- Composer 仅向 `useComposerSend` 传入 `draftKey`、会话与运行态，移除文本、图片、附件、引用、slash 字段及 setter 的重复传递。
- 发送 hook 从指定 key 的唯一草稿 store 同步读取最新草稿，保留 recovery、压缩、图片支持、发送模式等既有门禁顺序。
- 获取同步 send guard 后创建独立副本快照；门禁到快照创建之间没有 await。快照用于同一次传输、幂等指纹及 ACK 清理。
- ACK 前不清草稿；成功后只有草稿版本、完整载荷均与发送时相同且无 recovery 保护，才清原 key。
- 旧宿主采用保稿兼容策略，详见第四节。完整托管控制通道的 queue/steer/interrupt 和恢复协议保持。

不引入 draft controller、第二份编辑状态、图片 readiness hook、Lexical、草稿持久化迁移、SDK/IPC 协议调整或新 UI 布局。本批新增的两条 toast 文案用于解释旧宿主带图排队限制及不确定受理状态。

## 二、文件与责任

路径均相对于 `packages/desktop/src/renderer/src/`。

| 文件 | 最终责任 |
| --- | --- |
| `components/composer/Composer.tsx` | 保留 UI、输入事件、拖放、粘贴与图片准备屏障；仅收窄发送 hook 接线 |
| `components/composer/send-snapshot.ts` | 纯函数构造正文和独立副本快照；不读 store、不调 IPC、不清草稿 |
| `components/composer/use-composer-send.ts` | 从 draftKey 读草稿、执行门禁/传输、版本校验清理、旧宿主保稿及全文回填 |
| `stores/drafts.ts` | 保持 DraftEntry 和 store schema；用 WeakMap 关联内存草稿版本 |
| `components/composer/send-snapshot.test.ts` | 内容顺序、数组/图片副本、空白与命令格式 |
| `components/composer/use-composer-send.test.ts` | 发送、ACK、幂等、恢复、压缩、图片支持和旧宿主兼容性回归 |
| `i18n/zh.ts`、`i18n/en.ts` | 旧宿主图片排队限制与不确定回执保稿提示 |

事件桥没有最终差异。试验性 `legacy-queue-snapshots.ts` 已移除，生产代码不存在按文本或位置给队列消息配图的缓存。

## 三、发送与 ACK 时序

1. 编辑器事件、外部预填、附件或引用更新仍写入唯一 `useDraftStore`。
2. `Composer.sendWhenReady()` 等待原草稿的在途图片完成，检查活动会话与只读状态，再调用最新的 `handleSend`。
3. hook 从 `options.draftKey` 同步读取 DraftEntry 和其版本。recovery 分支单独执行并返回；普通发送不跨 await 重读/混用不同草稿。
4. 保持现有门禁顺序；取得同步 send guard 后，构造一次 `ComposerSendSnapshot`。
5. 快照保存 `draftKey`、`draftVersion`、原始字段的副本、content、imageNames、mode 和 wasActive。引用 blockquote 在前，附件 `@path` 与正文保持原格式；图片发送只传 `data/mimeType`，恢复信息保留名称。
6. 新会话仍先捕获 `__new__` 草稿，再 promotion 到真实 sessionId；旧 ACK 仍针对原草稿 key 清理，不能清 promoted session 的后续草稿。
7. 成功 ACK 清理前检查当前 DraftEntry 的版本、完整内容及 recovery。用户等待期间改过草稿，即使重新写成完全相同内容，也保留。
8. 失败保留草稿；受控发送的 requestId、错误卡、恢复与压缩契约保持。

快照复制数组和图片对象，不使用运行时 `Object.freeze`。版本通过 `WeakMap<DraftEntry, number>` 关联，每次正常 `updateDraft` 推进单调序号，不新增持久字段或累积每个 session 的版本表。

### 迟到 ACK 的反例验证

测试在提交后挂起 ACK，用相同 `__new__` key 写入相同载荷，再放行旧 ACK，断言新草稿完整保留。临时移除版本门禁后，该测试在草稿保留断言处失败；恢复门禁后通过。变异检查证据为 `.local/tmp/composer-e2e/ack-mutation.log`；没有留下临时移除逻辑。

## 四、旧宿主的防丢失策略

旧宿主指完全没有消息控制 API、只能走 legacy `prompt/clearQueue` 的宿主。其 `clearQueue` 返回文本数组，没有可可靠关联图片的消息身份。

### 图片发送

- 最新 transcript 的 agentActive/followUpQueue 或调用时 wasActive 表明忙碌时，拦截带图 legacy 发送；完整草稿保留，提示等当前任务结束后再发。
- 空闲时仍可发送图片，不影响正常 started/handled 路径。
- 请求发出后若收到 queued、unknown 或缺省回执，不能确定图片是否已开始处理：完整草稿保留，提示先核对状态。该提示明确可能已经发出，避免把保稿误解为安全自动重试。
- started/handled 按版本与内容门禁正常消费草稿。
- queued 回执回滚本次乐观忙碌状态并移除本次 pending 气泡，不误显示已开始执行。

完整托管控制通道仍支持带图排队和完整取回；上述限制不适用于该通道。旧宿主不支持跨 renderer 重载/应用重启的完整排队图片恢复；本批通过提前阻止不安全操作或保留原稿防丢，不承诺旧协议具备无损恢复能力。

### 停止与取回

旧宿主 `clearQueue` 返回的 `steering` 和 `followUp` **全部**追加到操作开始时原会话的当前草稿。等待期间的新正文、图片、附件、引用、slash 与 recovery 保留，不覆盖另一会话。停止路径仍在回填后 abort；取回路径仍请求聚焦。

不根据正文、位置、相同条目数量或本地历史缓存猜测图片归属，避免同正文消息之间错贴图片。

## 五、验证结果

| 验证 | 结果与范围 |
| --- | --- |
| 桌面端全量 Vitest | Passed：111 files / 1513 tests，0 failed |
| Composer 定向 | Passed：13 files / 197 tests，其中发送 hook 116 项、快照 3 项 |
| desktop typecheck | Passed：node/web 两套 tsconfig |
| Biome | Passed：8 个改动源码文件 error-level check；旧测试中的非空断言 warning 未扩展清理 |
| `git diff --check` | Passed |
| ACK 版本保护变异检查 | Passed：移除门禁后目标断言 RED，已恢复代码并重跑全量 GREEN |
| 独立只读审查 | PASS；无剩余 blocker；审查读回了实际 diff 和验证证据 |

全量报告：`.local/tmp/composer-e2e/final-vitest.json`。检查覆盖的是 desktop 工作区，本轮没有运行 backend 全量测试、跨平台成品或安装升级验收。

## 六、隔离 Electron 实机验收

最终使用全新系统临时目录 `percho-composer-clean-*`。HOME/USERPROFILE/APPDATA/LOCALAPPDATA、Pi agent dir、Electron user-data 均指向该临时目录；没有复制正式凭证。自建本地 HTTP SSE 模型服务，只使用回环地址和零费用测试模型。

通过真实页面动作及 CDP Input 验证：

- 原生 DragData.files 拖入临时 TXT 和 PNG，经过 Electron 文件路径与图片预处理，显示附件和预览。
- Enter 触发生产 Composer → IPC → backend → 本地 HTTP 模型请求，服务收到正文、TXT 路径及图片；ACK 消费原草稿。
- 本地响应挂起时，两个 UI 创建的真实会话分别写入草稿；切换后各自内容保留。
- 运行中普通发送进入真实控制队列，点击“取回编辑”回填原正文。
- 组合发送控件的发送/停止按钮存在，发送方式菜单显示优先插话和打断并发送。

模型服务记录 4 次本地请求（包含长响应期间的自动重试），没有真实外部模型调用。结束后关闭本次 Electron/子进程与本地服务，两个端口已检查释放。

证据与可重放临时脚本位于 `.local/tmp/composer-e2e/`：`clean-first-result.json`、`clean-switch-result.json`、`clean-final-result.json`、截图、`launch-clean.cjs` 与 `verify-*.cjs`。脚本/日志不入 Git。

此前默认 `agent-dev` 验收发现已有历史数据，因此停止操作该 profile；本次输入的测试文字/合成图片已撤销。最终验收使用上述全新临时目录。未验证真实服务商 API、桌面原生鼠标拖窗、跨平台打包或替换用户已安装应用。

## 七、交付与下一批

本批源码、文档尚未 commit/push/tag，未打包安装。HANDOVER 为本地被忽略文件，记录当前断点。

本批可交用户验收；后续 Lexical 与句中引用仍需独立细化接口和验收边界，不自动衔接实施。若未来要让无控制 API 的旧宿主无损排队图片，须增加可关联的完整载荷协议及兼容性验证，不能重新引入正文猜配。
