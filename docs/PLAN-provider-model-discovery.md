---
类型: 技术方案
状态: A1 纯逻辑与 fetch 适配器已实现并通过样例回放；IPC/表单接入与真实站点验证未做
创建: 2026-11-15
更新: 2026-11-18
适用: Percho 0.7.7 / Pi SDK 1.5.1 自定义 Provider 模型发现与能力元数据
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
| 上游端点 | 同文件 `needsApiVersionProbe` / `fetchUpstreamModels` / `requestModels` | 仅两种 OpenAI 兼容协议的裸根会在失败后再试 `/v1/models`；`/api` 只试 `/api/models`。保存侧的并发探测 `resolveUpstreamBaseUrl` 是另一条链，不移植到保存流程。 |
| 本方保存 | `packages/backend/src/settings/settings.ts` | `buildCustomEntry`逐模型重建字段，只保留当前支持项；新增字段必须同步保存/读回，避免编辑再保存丢失 |
| 共享契约/表单 | `packages/shared/src/settings.ts`、renderer `components/settings/providers/` | 自定义model DTO、回填和编辑状态需一并扩展；后端支持不等于UI已支持 |
| 档位 | SDK `pi-ai/dist/models.js` `getSupportedThinkingLevels` | `reasoning=false`只off；映射null禁用；未定义的off/minimal/low/medium/high仍可用，xhigh/max须显式字符串 |
| 请求编码 | SDK `pi-ai/dist/api/anthropic-messages.js` | `compat.forceAdaptiveThinking === true`选择adaptive；`thinkingLevelMap`只映射effort；否则是budget-based thinking |
| 配置schema | SDK coding-agent `dist/core/model-config.js` | 支持model-level thinkingLevelMap/compat，不必为基础导入功能修改SDK |

## 三、必须修订的需求规则

### 字段来源与值校验

- 最终字段优先级：用户明确配置/当前已编辑值 > 本次有效API响应 > SDK精确匹配 > 经验证别名匹配 > 未知留空。
- 初次导入可自动补齐；重复提取不得无提示覆盖既有值，保守保留旧值并显示差异，允许用户明确接受更新。不以“字段非空”冒充有完整来源跟踪。
- 总窗口、输入上限、输出上限分别解析，具体键和冲突按下表。保留有效候选的原始键、值与来源；缺失不等于冲突，冲突不能用 SDK 默认值盖掉。
- 字符串数字转为有限正安全整数，拒绝空字符串、0、负数、NaN/Infinity及单位混杂字符串；false是有效能力声明，不能用truthy过滤覆盖。
- 字段缺失、明确false、空数组、非法数组分别处理。未知effort不静默映射成已支持；数组全部无效时回退并提示，不生成全禁用模型。
- `reasoning_text`可能描述推理文本输出能力；其false不必然否定可调effort。非空有效efforts可说明可调推理，不能据此证明某种API编码。
- `lifecycle`可显示active/off等状态；提取不自动删除已保存模型。`model_off`应说明模型不可用，换key/思考模式不能修复模型下架。
- pricing/tools/json_schema不在当前验收核心，未知字段不能随意映射或假装已支持。

#### A1：模型上限怎么认

| 响应中的字段（模型条目顶层） | 发现结果 | 导入规则 |
| --- | --- | --- |
| `context_window`、`context_length`、`max_context_length` | `contextWindow`，总上下文窗口 | 只取有效值。同义字段数值相等时合并来源；有效值不同时列出各键和值，总窗口留给用户确认，不选较大、较小或第一个。 |
| `max_input_tokens` | `inputLimit`，仅输入上限 | 作为发现结果的参考信息，不写入 SDK 模型配置，不代填总窗口，也不与输出上限相加。 |
| `max_output_tokens` | `maxTokens`，最大输出 | 仅按明确的输出上限导入；首版不猜测未列出的键。 |

数值接受正安全整数，或去除首尾空白后全为十进制数字、转换后仍为正安全整数的字符串。坏值记下字段名并跳过，不阻断其他有效键。子上限小于或等于总窗口是正常情况；若输入或输出**单项**大于总窗口，两者都保留来源但不自动导入，不牵连未冲突的字段。输入、输出的上限并非一次请求的实际用量，不校验两者之和。用户已编辑的配置始终保留；这些规则只生成候选，不写配置。

例：清单给出总窗口 `128000`、输入上限 `96000`、输出上限 `16384`，三者可以同时成立。去掉总窗口后，API 总窗口候选应为空，不是 `96000` 或 `112384`；如另有 SDK 精确匹配，其值须单独标注来源。

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
- 探测地址按下表生成。它决定客户端可以试哪里，不代表已验证任何真实中转站采用这些路径。
- 只将发现结果填入表单，用户保存才落盘；切换provider或编辑baseURL时旧请求结果不得覆盖新表单。
- 清单需处理分页和重复ID，显示实际提取数量，不硬编码10条；部分/截断结果不能称完整模型目录。
- UI遵守docs/ui.md及ui-spec，模型配置编辑后必须能准确读回，特别是false/null、档位和compat。

#### A1：从哪个地址取清单

先解析 HTTP(S) `baseUrl`，拒绝内嵌凭证、查询串及片段，不把它们拼进请求或错误文案。去除尾部 `/`，在原 origin 和路径前缀内追加路径段；只为**发现**执行串行 GET，不改推理用的 `baseUrl`，保存手工表单不触发网络请求。后端不记录 API key，也不在发现结果中将它返回 renderer。

| 基址路径 | 第一个请求 | 允许的第二个请求 |
| --- | --- | --- |
| `/` | `/models` | `/v1/models` |
| 恰好 `/api` | `/api/models` | `/api/v1/models`；不退回根 `/v1/models` |
| 其他路径，如 `/api/v1`、`/tenant/api` | 原路径后接 `/models` | 无。版本、租户及自定义前缀保持不变。 |

第二个请求仅限 `openai-completions` / `openai-responses`，且首个响应为 404、405 或 200 HTML 页面。合法空清单也是成功；200 JSON 但形状不是清单、401/403、429、5xx、超时、取消或网络错误应立即停止并报告，不当成路径错误。所有 3xx 都不跟随；两次请求共用总时限，响应大小和条目数均须有界。错误反馈可列出已试路径和原因，不含凭证或原始响应体。若清单确实在前缀外，首版提示无法自动发现并保留手填，不擅自扩大探测范围。

## 五、实施分片与受影响文件

| 分片 | 范围 | 出口 |
| --- | --- | --- |
| A1 发现与规范化 | 新backend settings/upstream-models、共享DTO、IPC与测试 | 脱敏fixture验证别名/值/来源/端点/超时，不写正式配置 |
| A2 表单与保存 | provider表单、回填、settings.buildCustomEntry及映射测试 | 新字段导入/手改/保存/重开保真，重复提取不覆盖用户值 |
| A3 档位与显式协议 | thinkingLevelMap与compat，实际SDK请求序列化验证 | UI可选档位与线上参数一致，官方provider不回归 |
| B 有界400协议回退 | 请求适配边界与取消/幂等/故障测试 | 严格错误分类、只一次、无重复用户/工具；另确认后实施 |

不合入整个上游settings实现，不带入Lexical/归档等无关P2功能，不改GitLens中文化，不随功能升级SDK版本。

## 六、验收与证据

[A1 脱敏验收样例](../scripts/fixtures/provider-discovery-a1.json) 是后续实现的输入和预期结果，不是真实 Provider 响应。`endpoints` 以同一虚构 origin 和默认 `openai-completions` 回放，按顺序消费 `reply`，核对实际请求的完整路径序列 `calls` 和结果。`list` / `empty` 表示合法非空 / 空清单，`html` / `object` 表示 200 HTML / 非清单 JSON。`limits` 仅验证 API 来源：在带 `id` 的模型条目上合入 `raw`，核对候选与告警；缺键即没有可自动采用的值，不代填 SDK 缺省。后续产品测试须另验来源明细、IPC、取消和资源上限。

2026-11-18 离线核对：用模拟响应回放上述 12 组端点、9 组上限样例，参考逻辑的结果均与样例一致。另对固定上游 `87476fa` 注入模拟请求，确认 `/api` 收到 404 不补 `/v1`、裸根收到 429 仍尝试 `/v1`，且其模型解析只保留 `id` / `name`。前者检验新规则，后者记录移植时需改变的行为；两者都不是 Percho 产品测试或真实站点验收。

- 对讨论稿中的Gemini/GPT/Kimi/DeepSeek efforts分别构造fixture，校验SDK实际支持档位，不以UI标签测试代替。
- 128000/16384的数字/字符串、vision=false、空efforts、未知effort、缺字段、只有id、冲突上限、SDK错误模糊匹配均有独立断言。
- 验保存后再编辑再保存仍保留compat/map及用户值；模型删除/下架不自动改正式配置。
- 内存HTTP测试服务检查候选URL、Bearer/Anthropic鉴权、同源重定向、HTML、超时/取消；隔离HOME/agent，无真实key。
- SDK真实序列化检查anthropic adaptive、budget、off与OpenAI兼容的各自参数，验证“可选max”确实编码为max。
- 第二批回退须有未取消才重试、部分流绝不重放、错误不匹配不重试、单条用户身份/工具不重放的门闩测试。
- 经用户确认provider使用方式后才做真实CoArena有限验收，模型数和ID按届时响应记录；fixture不能代替站点实测。

## 七、审查结果与待确认

**后续依赖（2026-11-15规划调整）**：本功能A1–A3为P2优先首批；通过后才进入独立的输入层解耦→Lexical与句中引用批次。B协议自动回退单独定案，不是Lexical前置条件。本Plan不负责编辑器迁移，不扩大字段提取范围，具体排序见catalog；用户当前仅批准规划调整。

2026-11-18：按确认的第一步补定 A1 清单端点和 token 上限规则，并提供脱敏样例。下一步是让 A1 后端实现消费这些样例，再接共享 DTO / IPC；A2 表单保存、A3 档位与 B 协议自动回退均不在本次范围。真实公网中转站路径、模型数及能力仍未实测，不能凭截图或样例断言。

2026-11-18 A1 纯逻辑落地：`packages/backend/src/settings/model-discovery.ts` 提供 `resolveModelListPlan`（基址→候选地址序列，拒绝凭证/查询串/片段，不改推理用 baseUrl）、`discoverModelList`（注入式 HTTP，串行、共用总时限、响应体积与条目数有界、3xx 不跟随、404/405 与 200 HTML 才补试、去重并按 id 计数）、`parseModelLimits`（三种上限语义分离，冲突/非法/不一致均留来源与告警）。`packages/backend/test/model-discovery.test.ts` 直接回放本文上述 12 组端点与 9 组上限样例，31 项全绿；`tsc --noEmit`、`biome check` 通过。

2026-11-18 A1 适配器：`packages/backend/src/settings/model-discovery-fetch.ts` 把 fetch 包成 `DiscoveryRequest`——凭证仅在内存拼 Authorization，`redirect: "manual"` 不跟随 3xx，读取阶段超字节上限直接取消（`bodyTooLarge`）；测试断言结果 JSON 序列化不含 key、不跟随重定向发第二次请求。加上适配器 10 项，当前 41 项测试全绿。仍无 IPC、无界面。

2026-11-18 A1 接通产品：共享 DTO `DiscoveredModelSummary` / `ProviderModelDiscoveryResult`，通道 `settings:discoverModels` 与 `settings:cancelDiscoverModels`；`SettingsService.discoverProviderModels` 在表单新填 key 为空时读 auth.json 已存 key，同 requestId 重入先取消旧请求；renderer 新增 `ModelIdPicker`（Portal + placeMenu 浮层、按 id/name 过滤、冲突项不显数字）与模型行操作区的「自动获取」，选中才写该行 id/上限，缺值不覆盖手填；改 baseUrl/api 作废旧结果，卸载取消在途请求，过期结果按 requestId 丢弃。测试：后端 43 项（含 DTO 映射）、provider 相关前端 19 项、desktop 全量 1482 项、全工作区 typecheck 与 biome 通过；UI 硬编码扫描新增文件无违规。尚未启动 Electron 实机看界面，视觉与交互验收待做。

2026-11-18 实机反馈修整：打开候选面板时不能用输入框里已填的 ID 当过滤词（否则取回 18 条只剩 1 条），改为打开瞬间不带查询；DTO 的候选增加 `sources`（原始键与值），冲突/矛盾时既不自动填也不丢数字；选中后若上限未自动采用，操作区出一行说明并给「采用接口值」按钮，多值冲突（多个不同总窗口别名）只报歧义、不提供一键采用；`formatTokenCount`/`parseTokenCount` 补 M 档（1000000 → `1M`，可回读）。真实清单验证：`cn:deepseek-v4.1-flash` → 1M/393216、`cn:glm-5.3-flash` → 1M/131072 自动填入；`cn:kimi-k3-1` 因接口自相矛盾（总窗口 1000000 < 最大输出 1048576）不填，提示里带 1000000/1048576 供一键采用。测试：后端 43、provider 前端 23、desktop 全量 1486、typecheck 与 biome 通过。

2026-11-18 A3 档位落地：`packages/shared/src/thinking.ts` 新增 `readThinkingDeclaration`（读 `supports_reasoning` / `only_reasoning` / `reasoning_supported_efforts` / `can_disable_thinking`）与 `buildThinkingLevelMap`——只声明接口写明的 effort，其余显式 `null`；`off` 仅在 `can_disable_thinking === true` 时开放，否则置 `null`（只推理模型关不掉思考）。DTO 候选带 `thinking`；`CustomProviderModelInput` 增 `thinkingLevelMap`，`buildCustomEntry` 写入、`ProviderInfo.customModels` 回读、选中候选时带入并同时勾上「思考」（`reasoning=false` 时映射不生效）。SDK schema 为 `union([str(), nul()])`，`null` 即「该档不支持」，与写入形态一致。真实站点实测：`cn:kimi-k3.1-pro` 声明 `low/high/max`、无 `can_disable_thinking` → 写入 `off:null` 后 SDK 档位为 `[low, high, max]`；`cn:deepseek-v4.1-flash` 声明 `can_disable_thinking: true` → `[off, low, high, max]`。档位目前只由发现带入，表单里不能手改；滑块的实机效果未验收。

2026-11-18 档位选择控件：模型行勾「思考」后多出 `档位 [low, high, max]  ☑可关闭` 一行——留空即不写映射（跟随 SDK 默认），逗号/空格分隔、大小写不敏感、`off` 由「可关闭」决定，认不出的档位名标红并阻止保存；发现回来的值自动填入但可手改。触发这次改动的是实测结论：该站点接受任何 effort（含明显非法的 `ultra` 也回 200），`medium` 确实生效（同一 prompt、max_tokens 1500：`low` 106、`medium` 91、`high` 1021、`max` 263 思考 token），但每档只跑一次、`high` 反高于 `max`，单样本不能给档位排序，因此默认仍只按声明、额外档位需显式手填，不把不确定性写进默认路径。测试：desktop 110 文件 / 1493 项全绿，含新增静态渲染冒烟（断言「档位」行只在勾思考时出现）；typecheck 与 biome 通过。测试：shared 30、后端发现 44、provider 前端 25、desktop 全量 1488、typecheck 与 biome 通过。

2026-11-18 真实请求实测（本机中转站 `http://127.0.0.1:7863/v1`，只发 `GET` 清单，未发起推理，未写配置）：正常基址单请求 `/v1/models` 得 18 个模型，无截断无重复；字段分布为 `context_length`×18、`max_output_tokens`×17，未见 `max_input_tokens` / `context_window` / `max_context_length`。裸根基址 `/models` 404 后补试 `/v1/models` 成功，结果记录命中路径。`/api` 基址两条候选均 404 后失败，未触及根 `/v1/models`。错误 key 收到 401 立即停止且只发一次，key 未出现在结果里。实测遇到一个真实不一致样本：`cn:kimi-k3-1` 报 `context_length` 1000000 但 `max_output_tokens` 1048576，规则拒绝自动导入两者并出两条告警。同站点已落盘值与 API 值不一致（截图 1048576/131072，接口给出 1000000/393216），说明重复提取必须显示差异、不得静默覆盖。单个本机站点不能代表公网中转站，上述结论不外推。

参考依据：固定上游87476fa源码、当前SDK1.5.1实现；Anthropic官方[Thinking/effort](https://platform.claude.com/docs/en/build-with-claude/effort)与[Steering thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)。官方文档说明effort与thinking相关但不同，支持级别随模型变化；不能据此认定第三方网关对非Claude模型的真实行为。
