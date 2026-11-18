---
类型: 技术方案
状态: 审查后方案作为规划基线；用户明确暂不实施
创建: 2026-11-15
更新: 2026-11-15
适用: Percho 0.7.6 / Pi SDK 1.5.1 自定义 Provider 模型发现与能力元数据
---

# 自定义 Provider 模型提取与能力增强

> 将上游模型发现移植并扩展为可编辑的能力导入；本文件是审查与建议，不代表已实现，也不包含中转站实测结果。

## 一、目标与边界

需求来源：用户提供的《把 Percho 上游的「模型自动提取」移植过来，并按我的实际需求增强》讨论稿。目标是减少模型ID、输入输出上限、视觉与思考档位的手工配置，保护用户已有配置。

结论：模型清单、字段优先解析和动态思考档位可实施；Anthropic兼容能力须独立建模，不能把efforts等同adaptive。建议分两批：先完成发现/编辑/保存闭环；再实现严格限定的一次协议回退。

本轮只读代码与官方文档，未读取真实凭证、未访问CoArena API、未跑模型请求或实现测试。不能承诺其当前仍有10个模型，也不能将讨论稿中的模型名称和上限当作实时已验证事实。

## 二、实际实现定位

| 层 | 位置 | 已核实事实 |
| --- | --- | --- |
| 上游发现 | 固定 `87476fa` 的 `packages/backend/src/settings/upstream-models.ts` | 读取id/name；通过SDK目录及别名匹配补能力；未直接解析需求中的能力字段 |
| 上游端点 | 同文件 `modelsUrl` / `fetchUpstreamModelList` | root base URL才自动尝试/v1；含/api路径不会自动补齐；端点与API key解析有既有逻辑，不宜照抄假定适配用户站点 |
| 本方保存 | `packages/backend/src/settings/settings.ts` | `buildCustomEntry`逐模型重建字段，只保留当前支持项；新增字段必须同步保存/读回，避免编辑再保存丢失 |
| 共享契约/表单 | `packages/shared/src/settings.ts`、renderer `components/settings/providers/` | 自定义model DTO、回填和编辑状态需一并扩展；后端支持不等于UI已支持 |
| 档位 | SDK `pi-ai/dist/models.js` `getSupportedThinkingLevels` | `reasoning=false`只off；映射null禁用；未定义的off/minimal/low/medium/high仍可用，xhigh/max须显式字符串 |
| 请求编码 | SDK `pi-ai/dist/api/anthropic-messages.js` | `compat.forceAdaptiveThinking === true`选择adaptive；`thinkingLevelMap`只映射effort；否则是budget-based thinking |
| 配置schema | SDK coding-agent `dist/core/model-config.js` | 支持model-level thinkingLevelMap/compat，不必为基础导入功能修改SDK |

## 三、必须修订的需求规则

### 字段来源与值校验

- 最终字段优先级：用户明确配置/当前已编辑值 > 本次有效API响应 > SDK精确匹配 > 经验证别名匹配 > 未知留空。
- 初次导入可自动补齐；重复提取不得无提示覆盖既有值，保守保留旧值并显示差异，允许用户明确接受更新。不以“字段非空”冒充有完整来源跟踪。
- 字段名可容错，但语义不可混同：`context_length/context_window/max_context_length`通常是总窗口，`max_input_tokens`可能仅指输入上限。两者并存且不一致时要记录冲突/来源；仅输入上限不直接相加输出上限猜总窗口。别名优先级与冲突提示需定案。
- 字符串数字转为有限正安全整数，拒绝空字符串、0、负数、NaN/Infinity及单位混杂字符串；false是有效能力声明，不能用truthy过滤覆盖。
- 字段缺失、明确false、空数组、非法数组分别处理。未知effort不静默映射成已支持；数组全部无效时回退并提示，不生成全禁用模型。
- `reasoning_text`可能描述推理文本输出能力；其false不必然否定可调effort。非空有效efforts可说明可调推理，不能据此证明某种API编码。
- `lifecycle`可显示active/off等状态；提取不自动删除已保存模型。`model_off`应说明模型不可用，换key/思考模式不能修复模型下架。
- pricing/tools/json_schema不在当前验收核心，未知字段不能随意映射或假装已支持。

### 动态档位

若API明确返回完整允许列表，则对SDK七个档位建立明确映射，未支持项用null关闭，不只填写low/high等可用项。示例（列表确为完整集合时）：

```json
{
  "off": null,
  "minimal": null,
  "low": "low",
  "medium": null,
  "high": "high",
  "xhigh": null,
  "max": null
}
```

此例才会在SDK中得到low/high；不含efforts时沿用SDK推理能力与默认规则，`reasoning=false`仍只有off，不能笼统承诺全部off到high。

`none`可表示UI的off，但其线上编码不是跨API统一字符串：Anthropic可能需要thinking.disabled，OpenAI兼容可能需要none或省略字段。必须按实际协议构造并核对请求；不能统一都发`output_config.effort`。

### Anthropic adaptive 与回退

- 独立表示思考模式（默认SDK行为 / 手动budget / adaptive），优先明确响应声明、可靠且协议一致的SDK元数据、用户选择；无证据时不从模型名字或efforts存在性强推。
- `compat.forceAdaptiveThinking`与thinkingLevelMap一起保存，现有官方provider行为不得被全局覆盖。
- 首批可以显式设置adaptive；自动协议回退作为独立第二批，避免扩大发现按钮职责。
- 若实现回退，只限自定义anthropic-messages provider、首请求400明确同时指出enabled不支持且要求adaptive/effort、尚无响应内容/工具执行且未取消的场景；改变请求形态仅一次。同一用户消息ID、不重复持久化、不重新运行工具/输入钩子，不修改历史thinking块。
- 401/403、429、模型下架、上下文超限及泛化提到thinking的400均不得触发。失败继续显示原错误和回退结果；不静默持久化一次猜测为永久能力。
- 实施前再核SDK已有重试/回退入口，避免叠加自动重试或SDK补丁；若无法保持消息幂等，停在显式配置方案。

## 四、端点与交互

- 自动提取是独立异步操作，不作为保存前置。失败、超时、HTML响应、鉴权失败应给明确反馈，保留可保存的手工表单。
- 对https://coarena.ai/api，必须确认models路径究竟为/api/models、/api/v1/models还是根/v1/models；不能因示例文字就认为路径已证实。
- 复用已有受限探测逻辑并考虑可覆盖models endpoint（或预览探测地址）；同源受控候选，有总超时与响应大小/条目上限，禁止携凭证跨源重定向。不将api key放日志或返回renderer。
- 只将发现结果填入表单，用户保存才落盘；切换provider或编辑baseURL时旧请求结果不得覆盖新表单。
- 清单需处理分页和重复ID，显示实际提取数量，不硬编码10条；部分/截断结果不能称完整模型目录。
- UI遵守docs/ui.md及ui-spec，模型配置编辑后必须能准确读回，特别是false/null、档位和compat。

## 五、实施分片与受影响文件

| 分片 | 范围 | 出口 |
| --- | --- | --- |
| A1 发现与规范化 | 新backend settings/upstream-models、共享DTO、IPC与测试 | 脱敏fixture验证别名/值/来源/端点/超时，不写正式配置 |
| A2 表单与保存 | provider表单、回填、settings.buildCustomEntry及映射测试 | 新字段导入/手改/保存/重开保真，重复提取不覆盖用户值 |
| A3 档位与显式协议 | thinkingLevelMap与compat，实际SDK请求序列化验证 | UI可选档位与线上参数一致，官方provider不回归 |
| B 有界400协议回退 | 请求适配边界与取消/幂等/故障测试 | 严格错误分类、只一次、无重复用户/工具；另确认后实施 |

不合入整个上游settings实现，不带入Lexical/归档等无关P2功能，不改GitLens中文化，不随功能升级SDK版本。

## 六、验收与证据

- 对讨论稿中的Gemini/GPT/Kimi/DeepSeek efforts分别构造fixture，校验SDK实际支持档位，不以UI标签测试代替。
- 128000/16384的数字/字符串、vision=false、空efforts、未知effort、缺字段、只有id、冲突上限、SDK错误模糊匹配均有独立断言。
- 验保存后再编辑再保存仍保留compat/map及用户值；模型删除/下架不自动改正式配置。
- 内存HTTP测试服务检查候选URL、Bearer/Anthropic鉴权、同源重定向、HTML、超时/取消；隔离HOME/agent，无真实key。
- SDK真实序列化检查anthropic adaptive、budget、off与OpenAI兼容的各自参数，验证“可选max”确实编码为max。
- 第二批回退须有未取消才重试、部分流绝不重放、错误不匹配不重试、单条用户身份/工具不重放的门闩测试。
- 经用户确认provider使用方式后才做真实CoArena有限验收，模型数和ID按届时响应记录；fixture不能代替站点实测。

## 七、审查结果与待确认

**后续依赖（2026-11-15规划调整）**：本功能A1–A3为P2优先首批；通过后才进入独立的输入层解耦→Lexical与句中引用批次。B协议自动回退单独定案，不是Lexical前置条件。本Plan不负责编辑器迁移，不扩大字段提取范围，具体排序见catalog；用户当前仅批准规划调整。

需求可行，建议将A1–A3作为第一批规划，B单独收口。用户已澄清“就用”表示采用审查后的方案，并明确目前只计划规划，不实施；不再作为语义未明阻塞。具体字段冲突、端点与回退启用策略仍须按正文定案，不能借截图默认放开。提供的截图15-32-19/15-32-33显示自动获取按钮与模型选择列表，支持该交互需求；relay.example域名与示例模型不能作为真实站点能力证据。本轮未实现代码、未运行新增测试、未发送真实provider请求、未commit/push。

参考依据：固定上游87476fa源码、当前SDK1.5.1实现；Anthropic官方[Thinking/effort](https://platform.claude.com/docs/en/build-with-claude/effort)与[Steering thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)。官方文档说明effort与thinking相关但不同，支持级别随模型变化；不能据此认定第三方网关对非Claude模型的真实行为。
