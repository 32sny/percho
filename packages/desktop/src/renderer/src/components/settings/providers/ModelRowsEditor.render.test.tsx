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

/** 静态渲染冒烟：确认「档位」输入行与候选入口真的出现在 HTML 里（纯数据单测看不到这层） */
function render(rows: ModelRow[], discoveryModels = 0): string {
	return renderToStaticMarkup(
		<ModelRowsEditor
			rows={rows}
			onChange={() => {}}
			discovery={
				discoveryModels > 0
					? {
							status: "ready",
							models: Array.from({ length: discoveryModels }, (_, index) => ({
								id: `relay-${index}`,
								warnings: [],
							})),
							path: "/v1/models",
						}
					: undefined
			}
			canDiscover
			onDiscover={() => {}}
		/>,
	);
}

describe("ModelRowsEditor 渲染", () => {
	it("勾了思考才出现档位输入行", () => {
		const thinking = render([{ ...EMPTY_MODEL_ROW, id: "m-1", reasoning: true }]);
		expect(thinking).toContain("档位");
		expect(thinking).toContain("可关闭");
		expect(thinking).toContain("low, high, max"); // placeholder

		const plain = render([{ ...EMPTY_MODEL_ROW, id: "m-1", reasoning: false }]);
		expect(plain).not.toContain("可关闭");
	});

	it("操作行有自动获取，取回后给出去向提示", () => {
		const html = render([{ ...EMPTY_MODEL_ROW, id: "m-1" }], 3);
		expect(html).toContain("自动获取");
		expect(html).toContain("取到 3 个模型");
	});
});
