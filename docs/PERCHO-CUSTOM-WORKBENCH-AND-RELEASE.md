---
类型: 架构改造与自动化发版实战
状态: 已完成
创建: 2026-10-17
更新: 2026-10-17
适用: Percho 客户端定制开发、原生右侧工作区演进、CI/CD 自动化发版与多端构建
---

# Percho 原生右侧工作区演进与自动化发版全流程实战

> 本文档完整记录了从 PI-Desktop 灵感启发、剖析 UI 插件沙箱边界、走向 Fork 原生宿主开发，到彻底打通「Git 透镜 + 产物预览工作台 + 极简拖拽把手 + 本地极速开发态 + 全平台云端 CI/CD 自动更新」的完整工程闭环。

---

## 一、项目背景与决策路径

### 1.1 灵感缘起与诉求
用户希望在 Percho 桌面端中拥有类似 [vastsa/pi-desktop](https://github.com/vastsa/pi-desktop) 内置插件 `pi.gitlens` 的“Git 透镜”侧边栏功能，直观查看当前分支、已暂存/未暂存指标卡、最近提交流与行级追溯。

### 1.2 为什么现有的 UI 插件规范无法实现？
经深入分析 Percho 的 UI 插件系统（`~/.percho/ui-plugins/SPEC.md`），发现存在两道无法逾越的硬边界：
1. **槽位缺失**：UI 插件规范仅开放了工具调用卡、子代理卡、Todo 面板 3 个替换槽和角标/浮层加挂区，**没有右侧工作面板（Work Panel / Sidebar）宿主容器**；
2. **沙箱权限隔离**：UI 插件运行在严格受限的渲染进程中，严禁 Node API（无 `child_process`/`fs`），禁止调用系统私有 IPC，无法直接执行底层的 `git` 命令；
3. **数据接口未暴露**：宿主插件 API 仅暴露了聊天流与额度信息，未提供 Git 宿主服务。

### 1.3 核心决策：Fork 宿主源码自主演进（途径 3）
Percho 是完全开源的 Electron + React Monorepo（`Jaxton07/percho`）。选择 Fork 路线能够：
- 获得宿主特权层（Main Process）的控制权，原生驱动系统 Git CLI；
- 能够改造主布局，拥有原厂一体化的右侧工作面板；
- 借助 GitHub Actions 免费云端虚拟机全自动打包发布，并通过内置 `electron-updater` 实现独立可控的软件内自动升级。

---

## 二、架构演进与核心功能实现

整个架构遵循 `packages/shared`（类型契约）➔ `packages/desktop/src/main`（特权服务）➔ `packages/desktop/src/preload`（安全暴露）➔ `packages/desktop/src/renderer`（高保真交互）的标准链路。

```text
                                  ┌──────────────────────────────────────────────┐
                                  │           Electron Main Process              │
                                  │   (git.ts: execFile 安全无阻塞命令驱动)        │
                                  └──────────────────────┬───────────────────────┘
                                                         │ IPC (GIT_CHANNELS)
                                  ┌──────────────────────▼───────────────────────┐
                                  │           Electron Preload Layer             │
                                  │      (contextBridge 自动生成强类型 window.pi) │
                                  └──────────────────────┬───────────────────────┘
                                                         │
                     ┌───────────────────────────────────┼───────────────────────────────────┐
                     │                                   │                                   │
      ┌──────────────▼─────────────┐       ┌─────────────▼──────────────┐      ┌─────────────▼──────────────┐
      │       Git 透镜 (GitLens)    │       │ 产物预览工作台 (Artifacts)  │      │     会话变更 (DiffSidebar)   │
      │ 5大Tab + 4指标卡 + 亮暗自适应│       │ HTML/SVG沙箱 + 白底Markdown│      │ 顺手升级: 增加鼠标拖拽宽度  │
      └──────────────┬─────────────┘       └─────────────┬──────────────┘      └─────────────┬──────────────┘
                     │                                   │                                   │
                     └───────────────────────────────────┴───────────────────────────────────┘
                                                         │
                                  ┌──────────────────────▼───────────────────────┐
                                  │           Unified Right Work Panel           │
                                  │   - 顶栏专属入口 (Diff/GitLens/Artifacts)     │
                                  │   - 三大面板智能互斥，永不遮挡重叠             │
                                  │   - 纯透明极简把手拖拽调宽 + 本地记忆持久化   │
                                  │   - position: absolute 彻底根除右侧过度黑边  │
                                  └──────────────────────────────────────────────┘
```

### 2.1 Git 透镜（Git Lens）
- **特权主进程服务**（`packages/desktop/src/main/git.ts`）：
  - 封装 `runGit`，强制注入 `GIT_TERMINAL_PROMPT=0` 与 `GIT_OPTIONAL_LOCKS=0`，避免无终端环境后台挂起；
  - 严密的路径安全校验（`isSafeRelativePath`、`isSafeRef`、`isSafeBranchName`），严防越权目录穿透；
  - 实现了 `status`（已暂存、未暂存、未跟踪、冲突分类）、`log`、`show`、`diff`、`blame`、`branch`、`commit`、`stash` 全套指令。
- **IPC 契约**（`packages/shared/src/ipc-channels.ts`）：
  - 声明 `GIT_CHANNELS` 并合并至 `CHANNEL_TABLE`，Preload 自动推导出强类型 `window.pi.gitStatus` 等 API。
- **高保真前端界面**（`packages/desktop/src/renderer/src/components/git-lens/`）：
  - **【概览】**：4 块核心计数卡（已暂存、未暂存、未跟踪、冲突）与提交流；
  - **【历史】**：支持关键字搜索与文件相对路径过滤；
  - **【改动】**：工作区变动按状态分组，点击查看补丁，内置快速暂存 Commit 框；
  - **【分支】**：本地分支一览，当前分支高亮，支持一键切换分支；
  - **【追溯】**：按行追溯文件作者、提交时间与具体行代码。

### 2.2 产物与文件预览工作台（Artifacts Preview）收编
- **告别 DOM 劫持**：彻底移除了先前 UI 插件被迫通过 `document.querySelector(".diff-sidebar")` + `ReactDOM.createPortal` 强行越权挂载的缺陷，重构为 Percho 官方原厂核心组件；
- **视口沙箱引擎**（`Viewport.tsx`）：
  - HTML / SVG：通过安全的 `iframe sandbox="allow-scripts allow-modals"` 渲染；
  - Markdown：动态感知宿主主题，**在亮色模式下自动呈现纯白底黑字（Typora / GitHub Light 级别）**，彻底修复硬编码黑底；
  - 源码模式：带行号的高亮代码检视。
- **顶部与底部控制**：
  - `TopBar.tsx`：产物下拉切换、复制源码、浏览器独立标签打开、一键全屏最大化/还原；
  - `ZoomBar.tsx`：50% ~ 200% 快捷比例切换与一键 1:1 复位。

### 2.3 右侧工作区交互打磨与视觉统一
1. **彻底消除右侧黑边**：所有右侧栏改用与 `DiffSidebar` 100% 一致的 `position: absolute; inset-block: 0; right: 0;` 定位，关闭态使用 `visibility: hidden; pointer-events: none;`，绝不撑开父级溢出黑边；
2. **纯透明极简拖拽把手**：移除了所有把手的背景颜色和彩色粗线，完全对齐官方左侧栏：**纯透明命中区，只改光标为 `col-resize`**，鼠标悬停不干扰视觉；
3. **自适应亮暗主题**：全面改用 `var(--color-canvas)`、`var(--color-surface)`、`var(--color-ink)` 原生主题变量，亮色白底浅灰卡片，暗色沉稳高级；
4. **右上角统一关闭体验**：Git 透镜右上角增加与 Diff 变更侧栏像素级一致的 `×` 关闭按钮，支持按 `Esc` 键一键退出；
5. **三大面板智能互斥**：打开任意一个侧栏时自动收起其他两个，告别抽屉重叠打架。

---

## 三、本地极速开发态架构（对齐 RetouchStudio）

为了杜绝“每改一行代码就打 Tag 等云端打包”的盲调低效流程，本地建立了毫秒级热重载（HMR）环境：

### 3.1 解决本地 Windows esbuild 版本冲突
- **冲突根因**：Windows 环境下全局/缓存的 `esbuild.exe` 与项目依赖的 esbuild JS 代码版本不匹配时，会报 `Host version does not match binary version`；
- **解决方案**：在根目录统一安装匹配的 `esbuild@0.25.12`，彻底清理 `packages/desktop/node_modules` 下的旧版残留包，实现全工程版本归一。

### 3.2 启动脚本设计（纯英文防乱码）
参考 `E:\Project\RetouchStudio\run_dev.cmd` 的实践经验，在 Windows 批处理中严格采用纯 ASCII 英文，杜绝 CMD 默认 GBK 编码导致的字符乱码与指令中断：

```cmd
@echo off
setlocal EnableExtensions
title Percho (dev)

set "REPO_ROOT=C:\Users\Administrator\Desktop\Percho"
if not exist "%REPO_ROOT%\packages\desktop" (
    echo [ERROR] Cannot find Percho packages/desktop directory!
    pause
    exit /b 1
)

cd /d "%REPO_ROOT%\packages\desktop"
echo [INFO] Starting Percho dev server...
call npx electron-vite dev

if errorlevel 1 (
    echo [ERROR] Percho dev exited with error code %ERRORLEVEL%.
    pause
)
```

**效果**：双击桌面上的 `启动Percho开发版.bat` 或项目根目录的 `run_dev.cmd`，1.3 秒直接弹出独立开发窗口，修改代码秒级生效，按 F12 即可调试审查。

---

## 四、全自动 CI/CD 与软件内更新全链路

### 4.1 自动更新源绑定
在 `packages/desktop/electron-builder.yml` 中将发布源绑定至个人仓库：
```yaml
publish:
  provider: github
  owner: 32sny
  repo: percho
```
客户端内置的 `electron-updater` 会监听 `https://github.com/32sny/percho/releases/latest/download/latest.yml`。

### 4.2 跨平台 Release 构建脚本优化
在 `.github/workflows/release.yml` 中：
1. **解除发货连坐机制**：
   在 `publish` 任务中加上 `if: always()`，即使 Mac 或 Linux 因环境依赖波动，只要 Windows 安装包编译成功，系统绝不跳过，照样发布上架；
2. **多平台矩阵构建**：
   同时调动 `macos-latest`、`windows-latest`、`ubuntu-latest` 三台虚拟机并行编译全平台安装包；
3. **保持全平台依赖一致性**：
   保留官方原版包含 Linux `glibc`/`musl` 及 macOS 的 `package-lock.json`，确保云端虚拟机跑 `npm ci` 顺畅无阻。

---

## 五、关键踩坑与避坑复盘（Lessons Learned）

| 踩坑场景 | 现象表现 | 真实根因 | 彻底避坑方案 |
| :--- | :--- | :--- | :--- |
| **版本号脱节** | 客户端检测更新始终提示“已是最新版本” | 只改了 Git Tag，忘记修改 `packages/desktop/package.json` 中的 `version`，导致生成的 `latest.yml` 依然是旧版号 | 必须保证 `package.json` 的版本号严格大于客户端版本，`semver.gt` 方能触发更新 |
| **命令行参数互斥** | GitHub Actions 在 `Create GitHub release` 步骤秒退报错 | 在 `gh release create` 命令中同时传入了 `--generate-notes` 和 `--notes-file` | GitHub CLI 规范中这两个参数互斥，二选一使用，不能混传 |
| **Windows 下 npm 洗依赖** | 云端 Mac 和 Ubuntu 虚拟机执行 `npm ci` 报 lockfile 缺失 | 在 Windows 本地运行 `npm install` 会自动清洗非当前操作系统的可选依赖配置 | 涉及跨平台项目，切勿在 Windows 本地随意重写全平台 lockfile，必要时使用 `git checkout` 保护 |
| **CMD 批处理乱码闪退** | 双击 `.bat` 出现乱码并提示“不是内部或外部命令” | 批处理保存为 UTF-8 且包含中文提示，与 Windows CMD 默认 GBK 冲突 | 自动化运维脚本一律使用纯 ASCII 英文编写，禁止中文注释 |
| **Release 无法自动生成更新日志** | Releases 页面只有表格，没有生成 `What's Changed` | GitHub 自带的 `Generate release notes` 依赖 Pull Request（PR）关联 | 直接 push Tag 且无关联 PR 时，该按钮会被 GitHub 置灰，需在发布正文中手工或脚本注入提交说明 |

---

## 六、全链路验证结果与交付清单

1. **GitHub 仓库单一纯净提交**：
   - 仓库地址：`https://github.com/32sny/percho`
   - 主分支提交：已全部压平（Squash）为单一标准 Commit，无测试草稿痕迹。
2. **全平台编译大通关**：
   - GitHub Actions Run ID: `39018809878`
   - `build (macos-latest)`：SUCCESS ✓
   - `build (windows-latest)`：SUCCESS ✓
   - `build (ubuntu-latest)`：SUCCESS ✓
   - `publish`：SUCCESS ✓（耗时 8m 38s，全绿大通关！）
3. **正式上架资产清单**（`v0.7.0`）：
   - `percho-windows-x64.exe` (Windows 生产安装包)
   - `percho-windows-x64.zip` (Windows 免安装绿色版)
   - `percho-mac-arm64.dmg` (macOS 苹果芯片版)
   - `percho-mac-x64.dmg` (macOS Intel 芯片版)
   - `percho-linux-x86_64.AppImage` (Linux 独立运行版)
   - `latest.yml` (自动更新探测文件)
4. **客户端热升级验证**：
   - 本地 0.6.5 客户端点击「设置 ➔ 关于 ➔ 检查更新」，成功弹出 **`发现新版本 0.7.0，点击下载`**，全链路闭环彻底通过。
