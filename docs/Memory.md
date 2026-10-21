---
类型: 项目经验错题本
状态: 有效
创建: 2026-10-17
更新: 2026-10-21
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
- **验证依据与边界**：tech-debt-cleanup 专项本地全仓检查通过；远端 CI、构建打包及分支保护本轮未验证、未修改。

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

---

> 来源指针：以上条目沉淀自 2026-10-17 会话（Git 透镜 + 产物预览工作台 + v0.7.0 发版全流程）；完整架构与踩坑复盘见 `docs/PERCHO-CUSTOM-WORKBENCH-AND-RELEASE.md`。条目 7 已回流中枢（见同日提名记录）。
