/**
 * 发送路径失败 → UiError 的旧入口（Composer 内联条数据源）。
 * 构造器已下沉 shared `errors.ts`（`buildSendUiError`）：控制投递失败卡（§19.8）与内联条
 * 共用同一套标题/详情/分类判定，避免两份措辞漂移。本模块仅保留原导入路径的 re-export，
 * 内联行为（含原分类的 retry/compact actions）保持不变。
 */
export { buildSendUiError } from "@percho/shared";
