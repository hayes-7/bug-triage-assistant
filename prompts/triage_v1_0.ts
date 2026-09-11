/**
 * Prompt v1.0 —— 极简基线版本
 *
 * 文档依据：PD-07 Prompt 管理规范与 v1.0 初版
 * 对应评测批次：baseline（PD-05 第 9.1 节）
 *
 * ─────────────────────────────────────────────────────────────
 * 设计说明（重要，勿删）
 * ─────────────────────────────────────────────────────────────
 * 本版本刻意采用极简设计，仅提供类别名称与档位名称：
 *   - 不提供类别判定说明
 *   - 不提供 few-shot 示例
 *   - 不注入任何检索内容
 *
 * 目的是使后续各项优化手段的贡献可被单独量化。
 * 若基线过强，多轮对比的提升幅度将落入随机波动范围，
 * 评测报告失去说服力。
 *
 * 已知缺陷为刻意保留，详见 PD-07 第 4.2 节：
 *   1. 未区分 editor 与 gui 的边界
 *   2. high 档未说明其特指版本回归（预期被按字面误用）
 *   3. 未说明 other 的语义（预期被用作兜底选项）
 *   4. 未提示 "Not reproducible in" 为版本回归强信号
 *
 * ─────────────────────────────────────────────────────────────
 * 结构化输出约定（PD-07 第 6.1 节）
 * ─────────────────────────────────────────────────────────────
 * 本文件中不出现任何 JSON 格式说明、字段名清单或输出样例。
 * 格式约束的唯一来源是 Zod Schema（配合 generateObject 使用）。
 * 在此处另写一份格式说明会造成双重约束来源，二者不一致时
 * 排查成本很高——症状表现为解析失败，实际原因在提示词。
 *
 * ─────────────────────────────────────────────────────────────
 * few-shot 示例来源登记（PD-07 第 8.1 节）
 * ─────────────────────────────────────────────────────────────
 * v1.0 不含示例。
 *
 * 后续版本加入示例时，须在此处登记所用样本编号，
 * 并确认其全部取自检索库（in_eval_set = false）。
 * 评测集样本用作示例属数据泄漏，且不会产生任何异常信号。
 *
 * 示例样本编号：（无）
 */

// ============================================================
// 版本常量
// ============================================================

/**
 * Prompt 版本号。
 *
 * 约束（PD-07 第 3.2 节原则三）：
 *   接口返回的 meta.promptVersion 必须引用本常量，
 *   禁止在调用处硬编码版本字符串。
 *   PD-04-A 第 3.2 节验收测试第 7 项用于核对此项。
 */
export const PROMPT_VERSION = "v1.0";

/** 对应的评测批次标识 */
export const EVAL_BATCH_LABEL = "baseline";

// ============================================================
// 系统提示词
// ============================================================

export const SYSTEM_PROMPT = `You are a bug triage assistant for the Godot game engine.

For each bug report, output three judgments:

1. Module category — choose from this list only:
   editor, rendering, gui, gdscript, core, platforms, animation,
   buildsystem, import, input, other
   Provide exactly three distinct candidates, ordered by confidence
   from high to low. For each candidate, give a confidence score
   between 0 and 1, and a one-sentence reason under 80 characters.

2. Severity — choose exactly one:
   crash, high, normal, low
   Also indicate which signals support your judgment, choosing from:
   crash_keyword, stack_trace, version_regression, performance_issue,
   usability_issue, compile_failure, none

3. Information sufficiency — choose exactly one:
   sufficient, partial, insufficient

Base your judgments only on the report content. Do not guess beyond
what the text states.`;

// ============================================================
// 用户提示词
// ============================================================

/**
 * 构造用户提示词。
 *
 * 注意：body 的截断须在调用本函数之前完成（1500 token，PD-06 第 4.3 节），
 * 本函数不负责截断，以便截断逻辑可被单独测试与调整。
 */
export function buildUserPrompt(input: {
  title: string;
  body: string;
}): string {
  return `Title: ${input.title}

Body:
${input.body}`;
}

// ============================================================
// 调用参数
// ============================================================

/**
 * 模型调用参数。
 *
 * temperature 设为 0 的原因：评测要求结果可复现。
 * 设为 0 后仍可能存在服务端因素导致的细微差异，
 * 但幅度远小于 Prompt 变更的影响。若同一批次重复执行
 * 的指标差异超过 1 个百分点，须在报告中说明。
 */
export const MODEL_PARAMS = {
  temperature: 0,
  maxOutputTokens: 800,
} as const;

/** 输入截断上限，依 PD-06 第 4.3 节 */
export const INPUT_TRUNCATE_TOKENS = 1500;
