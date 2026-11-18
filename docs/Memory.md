---
类型: 项目经验错题本
状态: 有效
创建: 2026-10-17
更新: 2026-11-15
适用: Percho（32sny/percho）发版、构建、跨平台协作与跨会话协作
---

# Percho 项目 Memory（错题本真源）

> 维护规则：写入前先检索去重，更新旧条目而非新建；经验提升为规则后删除重复正文、保留来源指针。每条含：现象、根因、下次怎么做。

## 1. 发版三对齐（版本号一致性）

- **现象**：客户端点「检查更新」提示"已是最新版本"，但 Releases 上明明有新版。
- **根因**：Git Tag、`packages/desktop/package.json` 的 `version`、云端 `latest.yml` 三者脱节（如 Tag 叫 v0.7.0 而包内版本仍是 0.6.8）。更新判定是 `semver.gt(客户端版本, latest.yml 版本)`，包内版本才是 `latest.yml` 的来源。
- **下次怎么做**：打 Tag 前核对 `git tag vX.Y.Z` 与 `packages/desktop/package.json` 的 `version` 完全一致；发版后用 `curl https://github.com/32sny/percho/releases/download/vX.Y.Z/latest.yml` 验证 version 字段。

## 2. `gh release create` 参数互斥

- **现象**：Actions 在 `Create GitHub release` 步骤秒退报错，安装包编译成功却发布失败。
- **根因**：`--generate-notes` 与 `--notes-file` 是互斥参数，同时传入直接报错退出。
- **下次怎么做**：二选一。用自定义正文就走 `--notes-file -` + heredoc；要自动生成走 `--generate-notes`（注意它依赖 PR 关联，见条目 6）。当前 `release.yml` 用的是 `--notes-file -`，保持原样。

## 3. Windows 本地 npm 会清洗跨平台 lockfile

- **现象**：云端 macos/ubuntu 虚拟机 `npm ci` 报 lockfile 缺平台依赖（glibc/musl 等），三端只剩 Windows 出包。
- **根因**：在 Windows 本地跑 `npm install` 会把非当前平台的 optional 依赖配置从 `package-lock.json` 中清洗掉；`npm ci` 严格校验直接失败。
- **下次怎么做**：跨平台项目不在本地随意跑 `npm install` 改写 lockfile；lockfile 被污染时用 `git checkout <基准提交> -- package-lock.json` 恢复全平台版本（仅同步版本号可用 node 脚本精准改 `packages.desktop.version` 字段，不重排全文）。构建脚本保持官方 `npm ci` 不改。

## 4. 删 Tag ≠ 删 Release

- **现象**：`git push origin --delete vX.Y.Z` 后，GitHub 网页 Release list 仍挂着旧条目。
- **根因**：Git Tag 与 GitHub Release 是两套独立对象，删 Tag 不会联动删 Release。
- **下次怎么做**：清理发版痕迹时成对执行：`git push origin --delete <tag>` + 删除对应 Release（网页垃圾桶图标或 `gh release delete <tag> --yes`）。

## 5. Windows 批处理纯 ASCII 防 GBK 乱码

- **现象**：双击 `.bat` 出现乱码并报"不是内部或外部命令"，窗口闪退。
- **根因**：脚本以 UTF-8 保存且含中文，与 CMD 默认 GBK 代码页冲突，中文被拆成乱码字节被当作命令执行。
- **下次怎么做**：自动化 `.bat/.cmd` 一律纯 ASCII 英文（含注释）；模板见项目根 `run_dev.cmd`（对齐 RetouchStudio 实践）。

## 6. GitHub "Generate release notes" 依赖 PR

- **现象**：编辑 Release 时按钮置灰，提示 "There were no pull requests associated with the commits"。
- **根因**：自动生成只统计两个 Tag 之间的 Pull Request；直接 push 提交（无 PR）时按钮禁用。
- **下次怎么做**：直接 push 的发版流程，Release 正文由 `release.yml` 的 heredoc 提供；需要详尽 changelog 时在 heredoc 中写全，或发版后手动编辑补充。

## 7. 桌面端 UI 迭代必须走本地热重载

- **现象**：早期为绕过本地 esbuild 冲突，每改一处就打 Tag 走云端打包验证，版本号泛滥、反馈极慢、频繁翻车。
- **根因**：把云端 CI 当调试预览用；本地依赖冲突未根治就绕行。
- **下次怎么做**：UI/交互改动一律先 `run_dev.cmd` 本地热重载（秒级、F12 可调试），肉眼验收满意后一次性提交打 Tag；云端构建只用于最终发版。本地 esbuild 版本冲突的根治顺序：`npm ls esbuild` 查全树 → 核对根/子包 manifest 是否被改动 → 清理 `packages/desktop/node_modules` 残留。

## 8. fork 后优先把 app.asar 补丁迁回源码

- **现象**：旧版 Percho 只能通过 `app.asar` 注入 `pi-antigravity` 启动预热和 esbuild 路径兼容逻辑；fork 后仍继续依赖桌面补丁，会随版本、打包目录和自动更新产生脆弱性。
- **根因**：补丁针对编译产物和固定版本，无法从源代码层获得类型检查、回归测试和持续维护；补丁失败还可能阻塞应用启动。
- **下次怎么做**：一旦拥有 fork，优先将行为迁入源码；本次已落到 `packages/backend/src/antigravity-prewarm.ts`、`packages/backend/src/pi-backend.ts` 和 `packages/desktop/src/main/ui-plugins/build.ts`。旧版补丁仅按其明确支持的版本使用，不能套用到新版安装包。
- **适用与读取时机**：本项目移植二进制补丁或准备发布时读取。
- **验证依据与边界**：`v0.7.1` 的预热测试 3/3、esbuild 回归测试 2/2、backend 类型检查和 desktop 构建通过；新版安装包中额度 UI 的启动显示效果尚未实测。
- **退出方式**：补丁逻辑被上游合并或相关 SDK 接口变更时复核；升级为项目硬规则后仅保留来源指针。

## 9. 开发版数据目录与正式版隔离

- **现象**：`run_dev.cmd` 启动的新窗口没有正式版的历史会话，容易误判为数据丢失或弹窗没有记录。
- **根因**：开发模式使用独立的 `@percho/desktop-dev` 和 `~/.pi/agent-dev` 数据目录，刻意避免污染正式数据。
- **下次怎么做**：验证旧会话时明确复制测试会话到开发目录或使用测试数据；不要直接修改正式会话目录。临时副本的保留与清理应记录，不能仅因结束探测就宣称已清理。
- **适用与读取时机**：本项目开发窗口缺少历史记录、需要用旧会话复现 UI 问题时读取。
- **验证依据**：本轮检查了 `dev-agent-dir.ts` 的隔离配置，将单条正式会话复制到开发目录后，开发窗口能显示对应历史。
- **退出方式**：开发数据隔离策略变更时复核；若已纳入开发指南，本条缩为指南指针。

## 10. 封板前先确认同一提交的 CI 绿

- **现象**：存量类型错误和平台测试假设导致 CI 长期红，后续发版难以区分旧债与回归。
- **根因**：既有 CI 已含 lint、typecheck、test 硬失败步骤，但发版纪律没有要求同一候选提交先通过检查。
- **下次怎么做**：封板先本地执行 `npm run typecheck && npm run lint && npm run test`；取得发布授权后，还须确认候选提交对应远端 CI 成功，再推进发版。工作流步骤存在、本地三绿、远端 CI 成功、分支保护 required checks 是不同事实，不相互替代；没有 push 授权时只交付本地验证证据。
- **适用与读取时机**：本项目封板、发布和调整 CI 门禁时读取。
- **验证依据与边界**：tech-debt-cleanup 阶段仅有本地证据；2026-11-15 v0.7.6 已有原生四架构 CI、PR 合并、main CI 与三平台 Release 证据。必须按 run ID/head SHA 分开核对；分支保护是独立门槛，不能用事后CI成功掩盖管理员push的绕过提示。
- **跨项目执行入口**：`E:/输出项目库/Yu-AI工程/2-资产/checklist/GitHub三平台CI与PR发布清单.md`，在PR/合并/tag/发布时读取；通用步骤不在此复制。
- **退出方式**：工作流或分支保护策略变化时复核，规则提升到发布规范后保留此来源指针。

## 11. 平台假设类测试失败的 Windows 归因与修法

- **现象**：CI/本地测试大量存量失败（backend 9 文件 23 测试、desktop 6 文件 12 测试），横跨多个版本无人处理；单文件复跑与全量跑数字还会漂移。
- **根因**：绝大多数是测试硬编码 POSIX 假设（字面量 `/agent/models.json` 键、`new URL().pathname` 传盘符路径、期望 0o600 权限位、期望 `/` 分隔符），在 Windows 上必挂；另有超时型 flaky（updater 冷加载）与守护范围过时（typography 命中 iframe 独立预览文档）。**没有一个是产品真 bug。**
- **下次怎么做**：① 失败先单文件复跑逐个归因（平台假设 / flaky / 真 bug / 守护过时四类），不拿全量报错猜；② 平台假设用本机路径 API（`fileURLToPath`/`resolve`/`join`/`isAbsolute`）构造期望，保留语义覆盖，禁止只删断言；③ Windows 不支持的权限位用 `it.skipIf(process.platform === 'win32')` 限平台跳过并注明理由；④ flaky 靠隔离依赖修根因，禁止仅加超时掩盖；⑤ 数字断言以文件级清单为硬基线，测试总数当参考值（flaky 会导致漂移）。
- **适用与读取时机**：修存量测试失败、新增跨平台测试、评审测试改动时读取。
- **验证依据与边界**：tech-debt-cleanup 阶段 0/2 实测，35 个存量失败归因后两包全绿（backend 853/853、desktop 1156/1156）。

## 12. 类型收窄专项修法：守卫后 `!` + 归因注释 + 编译产物一致性

- **现象**：`noUncheckedIndexedAccess` 下存量代码爆出成批 TS2322/TS18048（git.ts 16 错、ArtifactsDrawer 2 错），逐个修容易顺手改逻辑。
- **根因**：数组下标访问类型层面返回 `T | undefined`，而多数报错点前已有长度守卫（如 `fields.length < 9 → continue`），类型系统看不到守卫效果。
- **下次怎么做**：① 只加守卫后非空断言（`fields[0]!`）+ 一行归因注释，禁止改解析/运行逻辑；② 验证标准用「移除注释后 transpile 产物与修改前逐字节一致」——比找不存在的旧测试跑一遍更强；③ 顺带用 TS AST 提取私有函数原文进 VM 补回归测试（零产品改动，见 git-parse.test.ts），防同点位复发。
- **适用与读取时机**：清类型错误、评审「纯类型修复」提交时读取。
- **验证依据与边界**：faedc91/6b628d8 实测，全仓 typecheck exit 0。

## 13. 跨会话频道协作（channel-watch）实战纪律

- **现象**：首次完整实战（tech-debt-cleanup 专项，发起方会话 + 实施方会话双边）跑通阶段 0→3 全流程，暴露三处协议价值点。
- **根因**：跨会话协作的失败模式不是「不会干」，而是「信息不同步时自由发挥」：plan 与代码现状有出入（git-status 测试不存在、CI 门禁前提过时）、单方验证数字有 flaky 漂移、范围外发现顺手修。
- **下次怎么做**：① 发起方写 plan 前核实「引用的测试/工作流是否存在」，已两次因未核实导致卡点（好在阶段门兜住）；② 实施方遇到断言不符/前提过时/范围外问题一律停手留言请裁决，不自行绕过——两次卡点都是实施方停手正确、发起方认领 plan 责任；③ review 不全信实施方报告，抽查关键论断（本次三处证据全属实）+ 在冻结提交上独立复跑关键数字；④ 连做授权是显式例外：模式被归因表完全约束后才放行连做，且设红线（发现需改产品代码立即停手）；⑤ 卡点裁决优先「归因 + 采信替代验证」而非机械要求原 plan；⑥ 频道产物（JSON/log 证据）留在频道目录不进 Git，每次收工清理临时目录。
- **适用与读取时机**：发起方建频道写 HANDOFF/plan 前、实施方接手频道任务时、review 方裁决卡点时读取。
- **验证依据与边界**：2026-10-21 tech-debt-cleanup 全流程实测（0→3 阶段 + 终审 PASS），频道档案在 `.local/agent-work/channel/tech-debt-cleanup/`（会不定期清理）。

## 14. esbuild 用户级环境变量劫持（旧版宿主补丁残留）

- **现象**：本地全量测试 89 个文件全挂，报错 vite 内嵌 esbuild 版本错位；修好 node_modules 后仍复发。
- **根因**：旧版 Percho 的 app.asar 补丁注入了用户级环境变量 `ESBUILD_BINARY_PATH` 指向正式版 0.28.2 exe，机器级持久化，比代码残留更隐蔽；换机器/重装系统后旧宿主可能重新写入。
- **下次怎么做**：① 测试命令一律加 `env -u ESBUILD_BINARY_PATH` 前缀兜底；② 全量挂且报 esbuild 版本错位时先查 `echo $ESBUILD_BINARY_PATH` 和 `Get-EnvironmentVariable('ESBUILD_BINARY_PATH','User')`；③ 升级 v0.7.2+ 宿主后若复发，说明旧补丁仍在注入，要查宿主版本；④ bin shim/lib/main.js 的硬编码注入同模式排查。
- **适用与读取时机**：测试环境异常排查、新机器初始化开发环境时读取。
- **验证依据与边界**：2026-10-20 封版会话实测根治（删除用户级变量 + 修 shim），10-21 专项全程 `env -u` 前缀零复发。

## 15. 多文件批量消失事故：先冻结取证再恢复，归因要可推翻

- **现象**：封版期间 `packages/` 子树 626/627 个 tracked 文件两次凭空消失（另一会话同样中招），首笔事故提交曾夹带 626 个删除（已 reset 未污染远端）。
- **根因**：外部环境因素（USN 日志取证窗口已过，杀软/Defender/OneDrive/存储感知已排除，百度网盘桌面自动备份为最大嫌疑未定罪）；流程缺陷是 `git add` 前未复核 `git status`、`git commit` 后未 `git show --stat`。
- **下次怎么做**：① 两道流程防线固化：`git add` 前必须 `git status` 复核、`git commit` 后必须 `git show --stat` 核对——事故提交根本进不了历史；② 大规模 IO（全量测试、cp node_modules）后提交前先 `ls` 关键文件存在性；③ 归因要可推翻：首判「两会话并发竞态」被用户澄清推翻后立即收回，改按证据收敛（剩余嫌疑：百度网盘桌面备份）；④ 复发时用 FileSystemWatcher 哨兵抓现行（脚本未落地，需时再建）。
- **适用与读取时机**：批量文件消失/提交内容异常、Git 事故取证时读取。
- **验证依据与边界**：2026-10-20/21 两次事故复盘；根因未定罪（外部因素），防线与取证流程已固化。

## 16. v0.7.6 慢构建误判与 tag 提交标题

- **现象**：版本提交`b6c6639`的main CI仍显示打包时，助手误报macOS签名卡死，追加`4794b98`（仅ci.yml新增证书自动发现环境变量）并重跑，最终tag指向后者，用户看到CI提交标题而疑惑。
- **核实事实**：[原main运行43682297550](https://github.com/32sny/percho/actions/runs/43682297550)最终success；mac Intel打包05:50:56–05:53:41 UTC，仅2分45秒，整个run05:43:30–05:54:14 UTC。`4794b98`提交时间05:54:16 UTC，在旧run完成2秒后。没有日志证明签名弹窗或死锁，先前“约17分钟卡死”“skip token跳过”等判断均无证据，不能作为根因。
- **根因**：未以API时间戳计算耗时，混淆step状态并凭轮询次数推断卡住；没有在改workflow前重读最新结束状态。额外CI成功只证明新配置可跑，不能证明旧配置故障。
- **下次怎么做**：先核run/attempt/SHA及step时间，日志不够就明确未知。Release本来已有`CSC_IDENTITY_AUTO_DISCOVERY=false`；此变量禁用证书自动发现，不关闭`identity: "-"`的Ad-hoc签名。慢任务不应自动改配置。版本候选稳定后再发版，已发布tag不为修改显示标题而移动。
- **tag语义**：`v0.7.6`是注解tag，对象`a34584fa6eee317f88c1cf98a0ddd5cb7351d735`，解引用为`4794b98a964bcaa3568e333aa8ee0f7484e9ce19`。它包含父提交的0.7.6版本字段；GitHub显示目标commit标题，不是版本被改名。最终CI运行43683085900与Release运行43684005317都对应4794b98且success。无需重写历史。
- **适用与读取时机**：跟进长时间CI、调整签名参数或解释发布tag时。
- **退出方式**：此为定格案例；通用执行要求见中枢清单，未来工具自动采集时间线后保留此误判来源。

## 17. Release正文修改必须核对远端读回

- **现象**：v0.7.6发布后助手宣称“正式正文已更新”，实际只编辑了`.local`草稿；复核远端Release GET仍为工作流默认英文下载表。
- **根因**：没有执行正确远端更新及读回；还曾误用会POST创建PR的`create-pr.py`作为Release不存在性检查（422拒绝，不能证明Release状态）。
- **下次怎么做**：只读探测用GET Release/tag；更新正文使用已授权的PATCH Release，随后GET并与预期全文/哈希比较；确认下载表和Full Changelog完整。未取得写入响应和读回证据时只能称“草稿已更新”。
- **适用与读取时机**：发布正文、资产描述及任意外部应用写入后报告完成前。
- **验证依据与边界**：2026-11-15远端Release `445852393` GET确认旧正文；本次补做正确更新并读回，以`.local/agent-work/release/v0.7.6/body-verification.json`为执行证据。正文更正不代表安装/升级已验证。
- **退出方式**：外部写入读回成为工具强制门禁后，本条保留案例与通用清单指针。

---

## 18. 开发实例 CDP 验收：host 绑定与“页面没接管”的两种不同故障

- **现象**：隔离启动 Electron 后，Vite 构建成功、Electron 进程存活，但 `ERR_CONNECTION_REFUSED`；改好 host 后又出现“CDP 只有 about:blank”，被误判为同一种失败。
- **根因**：两类故障不同源。① Vite 只监听 `::1:5173`，Electron 请求 `localhost:5173`，Windows 下地址族不一致直接拒连；② 端口通了但没传 `--remoteDebuggingPort`，CDP 端点连的是别的调试目标，自然看不到 Electron 页面。
- **下次怎么做**：① renderer server 显式 `host: "127.0.0.1"`（已在 `packages/desktop/electron.vite.config.ts` 落地），不要在应用代码里改 URL 绕；② 从 `packages/desktop` 用 electron-vite 的原生参数 `--remoteDebuggingPort 9224` 启动，不要靠环境变量猜；③ 接管前先用 `/json/list` 核对 `url` 是否为真实应用页，`about:blank` 一律不算接管成功；④ 同时隔离 `HOME`／`APPDATA`／`PI_CODING_AGENT_DIR`。
- **适用与读取时机**：做 Electron/前端 E2E 验收、CDP 连不上或页面空白时读取。
- **验证依据与边界**：2026-11-14 实测——改 host 后 `http://127.0.0.1:5173/` 可连且 renderer 存活；用 `--remoteDebuggingPort 9224` 后才出现真实 Percho 页面并可用 Input 事件点击。只证明开发态，不等于生产 `file://` 或安装包。
- **退出方式**：electron-vite 或 Vite 默认绑定策略变化时复核；若已写入 `docs/ui-debugging.md`，本条缩为指针。

## 19. 子代理中断后必须核对残留进程与未生成的补丁，再续跑

- **现象**：执行子代理被 abort 后，测试进程仍占着端口与 rollup 文件锁，`node_modules` 已有半成品改动但 `patches/` 未重新生成；直接重跑会得到“补丁与源码不一致”的假失败，甚至覆盖已完成的改动。
- **根因**：中断只终止了代理会话，不回收它拉起的进程树，也不回滚它写到一半的源码；把“没拿到结论”当成“没留下痕迹”。
- **下次怎么做**：① 续跑前先按 PID 定位并只终止本轮进程树（禁止宽泛 `pkill electron`／`taskkill node`）；② 用开工前的文件哈希清单比对，区分“本轮半成品”与“他人并发改动”；③ 已改 dist 但未 `patch-package` 时，先确认语义完整再继续，不重置也不覆盖；④ 引用日志前先确认它真的落盘（本会话曾出现仅一行 `RUN` 的空日志）。
- **适用与读取时机**：子代理超时/中止/连接错误后继续实施、或出现端口与文件锁冲突时读取。
- **验证依据与边界**：2026-11-14 实测——清理残留 Vitest 进程树后重跑通过；补丁与安装源码 reverse-check 一致。清理只按已知 PID，不保证所有后代进程。
- **退出方式**：子代理执行器具备进程组回收与产物一致性检查后，本条缩为指针。

---

## 20. 插件版本号不能代表本机文件等同官方原码

- **现象**：同为pi-antigravity 0.14.0，本机代理/OAuth和提示词路径与npm发布包不同；另一AI调整后用户反馈桌面请求恢复。
- **根因**：安装目录内残留临时补丁，仅看package.json或文档会误判真实请求链与宿主职责。
- **下次怎么做**：只读比对实际加载路径与相同版本官方源码；代理、OAuth刷新、提示词兼容、429分别取证。更新插件前保留差异与回退点，不覆盖用户可用补丁，不把一次成功归因到所有问题。
- **适用与读取时机**：CLI/桌面行为不一致、升级插件后失效、评估宿主网络接入时。
- **验证依据与边界**：2026-11-15实际读本机http.ts/oauth.ts/stream.ts并与npm0.14.0 tarball比对；无真实provider复测，用户成功反馈不替代长期刷新验收。
- **退出方式**：临时补丁撤除且宿主/插件官方方案验收后更新本条，保留版本来源指针。

## 21. 文件路径呈蓝色不等于当前客户端能打开

- **现象**：用户点击本地Markdown路径链接无响应，误以为文档未落盘或需等待预览功能。
- **根因**：当前markdown-link.ts通用协议正则将C:/、E:/盘符当未知协议，Markdown.tsx静默忽略；现有openPath实际是系统打开，与未来内嵌预览不同。
- **下次怎么做**：先确认磁盘存在与点击链路，交付时给可复制完整路径；不能承诺蓝色可点。修复统一走已登记WIN-LINK-01，不为显示一个文件绕过协议/路径守卫。
- **适用与读取时机**：向Windows用户交付本地文件、修文件引用点击时。
- **验证依据与边界**：2026-11-15文件存在检查、实际分类器/点击handler读取及正则命中确认；尚未修复源码或执行真实点击回归。
- **退出方式**：WIN-LINK-01验收后缩为历史案例和方案指针。

> **跨项目指针（不复制正文）**：SDK 大版本迁移与补丁重移植的执行框架见 `docs/SDK-UPGRADE-PLAYBOOK.md`；通用测试体系建设（四态分类、受控门闩、本地受控代理、自启动 E2E）已沉淀为全局 Skill `ai-test-craftsman`（`~/.pi/agent/skills/ai-test-craftsman/SKILL.md`，真源候选见中枢 `2-资产/skills/`）。

> 来源指针：以上条目沉淀自 2026-10-17 会话（Git 透镜 + 产物预览工作台 + v0.7.0 发版全流程）；完整架构与踩坑复盘见 `docs/PERCHO-CUSTOM-WORKBENCH-AND-RELEASE.md`。条目 7 已回流中枢（见同日提名记录）。
