---
类型: 项目经验错题本
状态: 有效
创建: 2026-10-17
更新: 2026-10-17
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

---

> 来源指针：以上条目沉淀自 2026-10-17 会话（Git 透镜 + 产物预览工作台 + v0.7.0 发版全流程）；完整架构与踩坑复盘见 `docs/PERCHO-CUSTOM-WORKBENCH-AND-RELEASE.md`。条目 7 已回流中枢（见同日提名记录）。
