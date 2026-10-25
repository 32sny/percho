---
类型: 流程规范
状态: 有效
创建: 2026-10-25
更新: 2026-10-25
适用: Percho GitHub Release 正文版式、生成方式与发布顺序
---

# Release Notes 版式与发布顺序

GitHub Release 正文的固定版式。**真源为本文件**；`scripts/release-notes.mjs` 只是按此版式输出骨架，版式变更先改这里再改脚本。

适用：`32sny/percho` 每次打 tag 发版。构建边界见 [构建发布](build-release.md)。

## 一、固定版式

```markdown
## What's Changed in vX.Y.Z          ← H2 唯一标题，固定句式

### <主题一>                        ← 用户能感知的变化，一节一个主题
- <能力>：<用户场景 + 实际行为>

### <主题二>                        ← 按需增删
### 修复                            ← 有则写
### 验证                            ← 只写真实跑过的检查
### 已知限制                        ← 有则写，不把未验证写成无问题
### Downloads                       ← 固定英文表头 + 固定五行
| Platform | Download |
| --- | --- |
| macOS (Apple Silicon) | percho-mac-arm64.dmg |
| macOS (Intel) | percho-mac-x64.dmg |
| Windows | percho-windows-x64.exe |
| Windows (zip) | percho-windows-x64.zip |
| Linux (x64) | percho-linux-x86_64.AppImage |

> macOS 为 Ad-hoc 签名，Gatekeeper 拦截时右键 →「打开」。Windows/Linux 支持应用内自动更新。

**Full Changelog**: https://github.com/32sny/percho/compare/vX.Y.Z-1...vX.Y.Z
```

**顺序固定**：标题 → 主题 → 修复 → 验证 → 已知限制 → Downloads → Full Changelog。空的节整节删掉，不留占位标题。

## 二、必须包含

| 项 | 要求 |
| --- | --- |
| H2 标题 | `## What's Changed in vX.Y.Z`，唯一一个 H2 |
| 主题节 | 讲用户能感知的结果，不堆实现细节 |
| 验证 | 写明实际跑过的：测试文件/用例数、类型检查范围、实机验收方式、Release 三平台结果 |
| Downloads | 固定五行 + Ad-hoc 签名说明 |
| Full Changelog | 恰好一条，链接 `compare/v<上一版>...v<本版>` |

## 三、禁止

- **不写内部提交列表**（`✨ feat` / `🧹 chore` 这类是本仓提交记录，不是 Release 正文；历史版本都没有）。
- **不重复 Full Changelog**（v0.7.3 正文末尾重复了两遍，是编辑失误，不要照抄）。
- **不省 Downloads 表**（v0.7.3 漏了；资产在侧栏但不等于正文有下载指引）。
- **不承诺未验证的能力**；没跑过的检查不出现在"验证"里。
- **不把"未验证"写成"无问题"**；不确定就写进"已知限制"或干脆不写这一条。
- **不复制上游英文模板**（`What's New` 之类）：本仓正文用中文，H2 句式保持 `What's Changed in`。

## 四、生成方式

```bash
node scripts/release-notes.mjs                    # 版本取根 package.json，起点取上一 tag
node scripts/release-notes.mjs --from v0.7.2      # 指定 compare 起点
```

脚本只打印到 stdout，不写文件、不改 git 状态，自动填好版本号、Downloads 表与 compare 链接。人只需替换主题小节和验证内容。参数错误或 git 查询失败时以退出码 1 结束，**不猜版本、不输出半成品**。

## 五、发布顺序（顺序错了会打架）

1. 本地准备：版本号三处同步（根 `package.json`、`packages/desktop/package.json`、`package-lock.json` 只改版本行），commit `🔖 release: vX.Y.Z`。
2. 合并前本地过一遍：`npm run lint`、`npm run typecheck`、`npm run test`、`npm run build`。保留真实退出码。
3. 打**注解** tag（与历史一致）：`git tag -a vX.Y.Z -m "<一句话主题>"`。
4. push `main`，再 push tag。推送 tag 触发 `release.yml`：三平台构建 → 自动用默认正文建 Release 并上传资产。
5. **等 workflow 完成后再编辑正文**：到 Release 页面点 Edit，用第四节生成的骨架替换。
   **不要提前手动「Draft a new release」**：`release.yml` 的 publish 步骤是 `gh release create`，同名 Release 已存在会失败。

## 六、发布后核对

- 资产齐全：15 个（三平台安装包 + zip/dmg + `.blockmap` + `latest*.yml` 更新元数据）。
- 自动更新链路：`latest.yml` / `latest-mac.yml` / `latest-linux.yml` 里的版本字段等于本次版本号。
- 正文：只有一条 Full Changelog、有 Downloads 表、无误报的"验证"项。
- 发现正文写错直接 Edit 修改，不回改历史版本正文。

## 七、历史版式差异（仅作参考，不作为模板）

| 版本 | 偏离 |
| --- | --- |
| v0.7.0 | Emoji 大标题 + 无 Downloads 表 + 无 Full Changelog（早期风格） |
| v0.7.3 | H2 改成「vX.Y.Z — 主题」、缺 Downloads 表改用「安装说明」、Full Changelog 重复两遍 |
| v0.7.1 / v0.7.2 | 与本文版式一致，可作为对照样本 |
