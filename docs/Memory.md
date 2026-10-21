---
类型: 项目经验错题本
状态: 有效
创建: 2026-10-17
更新: 2026-10-21
适用: Percho（32sny/percho）发版、构建与跨平台协作
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

---

> 来源指针：以上条目沉淀自 2026-10-17 会话（Git 透镜 + 产物预览工作台 + v0.7.0 发版全流程）；完整架构与踩坑复盘见 `docs/PERCHO-CUSTOM-WORKBENCH-AND-RELEASE.md`。条目 7 已回流中枢（见同日提名记录）。
