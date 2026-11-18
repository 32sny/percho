import { describe, expect, it, vi } from "vitest";

/**
 * monaco worker 路由单测：只验证 MonacoEnvironment.getWorker 的 label → worker 映射。
 * 所有 `?worker` 导入在此替换为仅记录身份的伪构造器（伪构造器即外部 Worker I/O，
 * 真 Worker 不在单测范围内）；monaco 服务补注册模块同样 stub，避免拉起整个编辑器。
 * Node 环境没有 `self`，而模块顶层会写 `self.MonacoEnvironment`，故导入前先补齐。
 */
const fakes = vi.hoisted(() => {
	const g = globalThis as unknown as { self?: unknown };
	g.self ??= g;
	const made: Record<string, number> = {};
	function make(kind: string) {
		return class {
			readonly kind = kind;
			constructor() {
				made[kind] = (made[kind] ?? 0) + 1;
			}
		};
	}
	return { made, make };
});

vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({ default: fakes.make("editor") }));
vi.mock("monaco-editor/esm/vs/language/css/css.worker?worker", () => ({ default: fakes.make("css") }));
vi.mock("monaco-editor/esm/vs/language/html/html.worker?worker", () => ({ default: fakes.make("html") }));
vi.mock("monaco-editor/esm/vs/language/json/json.worker?worker", () => ({ default: fakes.make("json") }));
vi.mock("monaco-editor/esm/vs/language/typescript/ts.worker?worker", () => ({
	default: fakes.make("typescript"),
}));
vi.mock("monaco-editor/esm/vs/editor/contrib/codelens/browser/codeLensCache.js", () => ({}));
vi.mock("monaco-editor/esm/vs/editor/contrib/inlayHints/browser/inlayHintsController.js", () => ({}));
vi.mock("monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestMemory.js", () => ({}));
vi.mock("monaco-editor/esm/vs/platform/actionWidget/browser/actionWidget.js", () => ({}));
vi.mock("monaco-editor/esm/vs/editor/common/services/treeViewsDndService.js", () => ({}));

// 副作用导入即被测对象：模块顶层注册 self.MonacoEnvironment
import "./monaco-contribs";

type RoutedWorker = { kind: string };

function getWorker(label: string): RoutedWorker {
	const env = (globalThis as unknown as { self: Window }).self.MonacoEnvironment;
	if (!env?.getWorker) throw new Error("MonacoEnvironment.getWorker 未注册");
	return env.getWorker("workerMain.js", label) as unknown as RoutedWorker;
}

describe("monaco worker 路由", () => {
	const cases: Array<[string, string]> = [
		["json", "json"],
		["css", "css"],
		["scss", "css"],
		["less", "css"],
		["html", "html"],
		["handlebars", "html"],
		["razor", "html"],
		["typescript", "typescript"],
		["javascript", "typescript"],
	];

	for (const [label, kind] of cases) {
		it(`${label} → ${kind} worker`, () => {
			const before = fakes.made[kind] ?? 0;
			const worker = getWorker(label);
			expect(worker.kind).toBe(kind);
			// 真实构造走伪构造器（外部 Worker I/O 的替身），未落到任何兜底分支
			expect(fakes.made[kind]).toBe(before + 1);
		});
	}

	it("未知 label 兜底 editor worker", () => {
		const before = fakes.made.editor ?? 0;
		expect(getWorker("plaintext").kind).toBe("editor");
		expect(getWorker("markdown").kind).toBe("editor");
		expect(fakes.made.editor).toBe(before + 2);
	});
});
