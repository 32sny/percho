import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ModelRow } from "./model-rows";

// i18n store 在导入时就读取 localStorage / navigator，SSR 环境先补上
// 测试环境的 JSX 走 classic 变换，会生成 React.createElement；而组件在应用构建里用的是自动 JSX、
// 本身不导入 React。这里把 React 注入全局，让 SSR 渲染能跑。
vi.stubGlobal("React", React);
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
vi.stubGlobal("navigator", { language: "zh-CN" });

const { ModelRowsEditor } = await import("./ModelRowsEditor");
const { EMPTY_MODEL_ROW } = await import("./model-rows");

type EditorProps = React.ComponentProps<typeof ModelRowsEditor>;

/** 静态渲染：检查 B 版分组、原生可访问语义与发现/冲突提示确实进入 HTML。 */
function render(rows: ModelRow[], discoveryModels = 0, extra: Partial<EditorProps> = {}): string {
	return renderToStaticMarkup(
		<ModelRowsEditor
			rows={rows}
			onChange={() => {}}
			discovery={
				discoveryModels > 0
					? {
							status: "ready",
							models: Array.from({ length: discoveryModels }, (_, index) => ({
								id: index === 0 ? "m-1" : `relay-${index}`,
								warnings: [],
							})),
							path: "/v1/models",
						}
					: undefined
			}
			canDiscover
			onDiscover={() => {}}
			{...extra}
		/>,
	);
}

describe("ModelRowsEditor B 版渲染", () => {
	it("每模型是无边框白底阴影卡，标题含序号、ID、来源和删除动作", () => {
		const html = render([{ ...EMPTY_MODEL_ROW, id: "m-1" }], 1);
		expect(html).toContain('<article aria-label="m-1" class="rounded-xl bg-surface px-3 py-2 shadow-soft">');
		expect(html).toContain(">01</span>");
		expect(html).toContain('value="m-1"');
		expect(html).toContain("自动提取");
		expect(html).toContain('aria-label="删除此行"');
		expect(html).not.toContain("rounded-xl border border-border");
	});

	it("勾了思考才出现档位组；能力始终使用项目 Switch", () => {
		const thinking = render([{ ...EMPTY_MODEL_ROW, id: "m-1", reasoning: true, imageInput: true }]);
		expect(thinking.match(/role="switch"/g)).toHaveLength(2);
		expect(thinking).toContain('aria-label="思考"');
		expect(thinking).toContain('aria-label="图像"');
		expect(thinking.match(/h-4 w-7/g)).toHaveLength(2);
		expect(thinking).toContain('<fieldset aria-label="档位"');
		expect(thinking).toContain("关闭");
		expect(thinking).toContain("xhigh");
		expect(thinking).toContain("未选 = 跟随默认");

		const plain = render([{ ...EMPTY_MODEL_ROW, id: "m-1", reasoning: false }]);
		expect(plain).not.toContain('<fieldset aria-label="档位"');
		expect(plain).not.toContain("未选 = 跟随默认");
	});

	it("窗口/输出同排，常用值是有选中语义的安静 chip，非法值保留校验状态", () => {
		const html = render([{ ...EMPTY_MODEL_ROW, id: "m-1", contextWindow: "1M", maxTokens: "bad" }]);
		expect(html).toContain("@container space-y-1");
		expect(html).toContain("@lg:grid-cols-2");
		expect(html).toContain('<fieldset aria-label="窗口"');
		expect(html).toContain('<fieldset aria-label="输出"');
		expect(html).toContain("w-28 shrink-0");
		expect(html).toContain("flex-1 flex-wrap");
		expect(html).toContain('aria-pressed="true" class="rounded-full');
		expect(html).toContain("1M");
		expect(html).toContain("32k");
		expect(html).toContain('aria-invalid="true"');
		expect(html).toContain("fade-rule mt-1");
	});

	it("管理行有添加、清空、自动获取，取回状态紧跟操作区", () => {
		const html = render([{ ...EMPTY_MODEL_ROW, id: "m-1" }], 3);
		expect(html).toContain("添加模型");
		expect(html).toContain("清空模型列表");
		expect(html).toContain("自动获取");
		expect(html).toContain('<svg width="14" height="14"');
		expect(html).toContain('<svg width="13" height="13"');
		expect(html).toContain("取到 3 个模型");
		expect(html).toContain("bg-hover px-2 py-1");
		expect(html).toContain("查看模型列表填写说明");
	});

	it("接口上限冲突提示与采用入口仍保留", () => {
		const html = render([{ ...EMPTY_MODEL_ROW, id: "m-1" }], 1, {
			limitNotice: {
				modelId: "m-1",
				notice: { contextWindow: 128000, maxTokens: 256000, ambiguousContext: false },
			},
			onAdoptLimits: () => {},
		});
		expect(html).toContain("接口上限自相矛盾");
		expect(html).toContain("128k");
		expect(html).toContain("256k");
		expect(html).toContain("采用接口值");
	});
});
