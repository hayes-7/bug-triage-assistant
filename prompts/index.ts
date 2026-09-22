/**
 * Prompt 当前启用版本的导出入口（PD-07 第 3.1 节）
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么需要这个文件
 * ─────────────────────────────────────────────────────────────
 * 版本化提示词文件（triage_v1_0.ts / triage_v1_1.ts / …）一旦发布即冻结，
 * 用于复现对应评测批次的结果。业务代码若直接 import 具体版本文件，
 * 每次升版都要改多处 import，且极易漏改——漏改处会继续用旧提示词，
 * 而 meta.promptVersion 由另一处提供，导致「批次标注版本」与
 * 「实际使用的提示词」不一致，整批数据不可用。
 *
 * 因此：业务代码一律从 "@/prompts" 导入，升版只改本文件一行 re-export。
 *
 * ─────────────────────────────────────────────────────────────
 * 切换版本的操作方式
 * ─────────────────────────────────────────────────────────────
 *   1. 确认新版本文件已通过 scripts/check_prompt.py 三项校验；
 *   2. 修改下方 import 语句中的版本号（唯一一处）；
 *   3. 确认 prompts/CHANGELOG.md 已登记该版本及执行前预期；
 *   4. 重启 dev server，冒烟核对 meta.promptVersion 已切换后再跑全量。
 *
 * 注意：meta.promptVersion 与 EVAL_BATCH_LABEL 均由本入口导出，
 * 二者同源，不存在单独修改其中一项的可能。
 */

export {
  EVAL_BATCH_LABEL,
  INPUT_TRUNCATE_TOKENS,
  MODEL_PARAMS,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  buildUserPrompt,
} from "@/prompts/triage_v1_3";
