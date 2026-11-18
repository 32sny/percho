/**
 * monaco worker 接管（0.5.4）：stream-monaco 在模块顶层用
 * `new URL("monaco-editor/esm/vs/.../xx.worker.js", import.meta.url)` 裸说明符拼 worker 地址，
 * dev 下它被 Vite 预打包进 .vite/deps/chunk-*.js，import.meta.url 指向 deps 目录，
 * 拼出的 worker 路径不存在 → worker 404 → 终端 "The file does not exist at .../.vite/deps/..."
 * + renderer "Uncaught [object Event]"（每次代码块编辑器实例化都触发）。
 *
 * 这里用 Vite 官方 monaco 模式（?worker 导入，dev/build 都由 Vite 正确出包）抢先注册
 * self.MonacoEnvironment.getWorker —— stream-monaco 的 ensureMonacoWorkers 检测到已有
 * getWorker 会自动让位（源码 preloadMonacoWorkers 顶部 guard），本模块在 main.tsx 早期
 * 引入，先于懒加载的 stream-monaco 执行。
 *
 * 注册 editor + 全部语言 worker（ts/json/css/html）：worker 承载的是 language service
 *（校验/诊断/颜色/折叠/符号等请求），editor worker 只实现通用文本模型协议，
 * 不含这些请求的 handler。若 json/css/html 的 label 落到 editor worker 兜底，
 * 主线程语言服务请求会在 worker 内报 Missing requestHandler: doValidation /
 * findDocumentColors / getFoldingRanges / findDocumentSymbols，功能整体失效。
 * 因此按 label 路由到对应语言 worker。
 */
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

declare global {
	interface Window {
		MonacoEnvironment?: {
			getWorker?(workerId: string, label: string): Worker;
			getWorkerUrl?(workerId: string, label: string): string;
		};
	}
}

self.MonacoEnvironment = {
	getWorker(_workerId: string, label: string) {
		if (label === "json") return new jsonWorker();
		if (label === "css" || label === "scss" || label === "less") return new cssWorker();
		if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
		if (label === "typescript" || label === "javascript") return new tsWorker();
		return new editorWorker();
	},
};

/**
 * monaco 服务补注册（0.5.3）：聊天代码块（markstream-react → stream-monaco）创建的
 * standalone editor 在实例化 contribution 时抛 "depends on UNKNOWN service"
 * （ICodeLensCache / IInlayHintsCache / ISuggestMemories / actionWidgetService /
 * treeViewsDndService，一 天 1000+ 条 error 日志）。这些服务的 registerSingleton
 * 在各自模块顶层执行，但懒加载链只拉进了 controller 注册、没拉服务注册模块。
 *
 * 这里把缺失的注册模块钉进主 chunk：启动时同步执行 registerSingleton，编辑器
 * 实例化时服务齐备。只读代码块用不上 codeLens/inlayHints 等功能，此修复主要为
 * 消除错误日志洪水（避免淹没真实 renderer 错误）。monaco 升级后若出现新的
 * UNKNOWN service 报错，按同样方式在此补注册模块。
 */
import "monaco-editor/esm/vs/editor/contrib/codelens/browser/codeLensCache.js";
import "monaco-editor/esm/vs/editor/contrib/inlayHints/browser/inlayHintsController.js";
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestMemory.js";
import "monaco-editor/esm/vs/platform/actionWidget/browser/actionWidget.js";
import "monaco-editor/esm/vs/editor/common/services/treeViewsDndService.js";
