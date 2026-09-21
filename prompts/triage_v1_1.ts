/**
 * Prompt v1.1 —— 严重度判定标准版本
 *
 * 文档依据：PD-07 Prompt 管理规范
 * 对应评测批次：sev-defined
 *
 * ─────────────────────────────────────────────────────────────
 * 本版变更（相对 v1.0）
 * ─────────────────────────────────────────────────────────────
 * 唯一变更：为严重度四个档位补充判定标准，并提示版本回归强信号。
 *
 * 触发依据（baseline 批次实测）：
 *   - 严重度准确率 28.57%，为全部指标中与目标差距最大者
 *     （目标 65%，差 36.4pp）；同期分类 Top-1 已达 70.36%（目标 55%），
 *     资源应投在差距最大处，故 v1.1 由原定的「类别定义」改为「严重度定义」
 *   - `low` 档 158 个标准答案**零预测**
 *   - `normal` 档标准答案仅 8 个，却被预测 134 次（严重过度预测）
 *   - `high` 档按字面理解为"重要"而非"版本回归"，印证 PD-07 第 4.2 节预判
 *
 * 根因判断：PD-02 中 `low` 的定义为「无上述标签」，属**否定性定义**，
 * 缺乏正面判别特征，模型无法学习。本版为 `low` 补充正面描述
 * （局部/边缘缺陷、不阻断主工作流），而非沿用排除式表述。
 *
 * ─────────────────────────────────────────────────────────────
 * 刻意保持不变的部分（保证独立归因）
 * ─────────────────────────────────────────────────────────────
 * 本版**不得**引入除严重度以外的任何改动：
 *   - 不补充类别判定说明（原 PD-07 规划的 v1.1 内容，已推迟至 v1.2）
 *   - 不补充信息充分度判定标准（推迟至 v1.3）
 *   - 不加入 few-shot 示例
 *   - 不注入任何检索内容
 *
 * v1.1 与 v1.0 的指标差值，即为「明确严重度判定标准」这一手段的
 * 独立贡献值。若本版混入其他改动，该贡献将无法测量。
 *
 * 刻意保留的缺陷（留给 v1.2 · 类别定义）：
 *   1. 未区分 editor 与 gui 的边界
 *   2. 未说明 other 的语义
 *
 * ─────────────────────────────────────────────────────────────
 * 结构化输出约定（PD-07 第 6.1 节）
 * ─────────────────────────────────────────────────────────────
 * 本文件中不出现任何 JSON 格式说明、字段名清单或输出样例。
 * 格式约束的唯一来源是 Zod Schema（配合 generateObject 使用）。
 *
 * ─────────────────────────────────────────────────────────────
 * few-shot 示例来源登记（PD-07 第 8.1 节）
 * ─────────────────────────────────────────────────────────────
 * v1.1 不含示例。
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
 */
export const PROMPT_VERSION = "v1.1";

/** 对应的评测批次标识 */
export const EVAL_BATCH_LABEL = "sev-defined";

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

   Definitions:
   - crash: The engine or editor terminates abnormally, hangs, or becomes
     unusable. Typical signals: stack trace, segfault, freeze.
   - high: A regression — the bug appears in a newer version but did NOT
     exist in an earlier stable release. Judge this level by whether it is
     a regression, not by how important the bug seems. A phrase such as
     "worked in 4.1" or "Not reproducible in <older version>" is a strong
     indicator of this level.
   - normal: The feature still works but is degraded — a noticeable
     performance loss, or a usability problem that affects the workflow
     without blocking it.
   - low: A localized or edge-case defect that does not block the main
     workflow. The engine stays usable and the problem is confined to a
     specific feature, a minor behavior, or an unusual configuration.

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
 * 但幅度远小于 Prompt 变更的影响。
 */
export const MODEL_PARAMS = {
  temperature: 0,
  maxOutputTokens: 800,
} as const;

/** 输入截断上限，依 PD-06 第 4.3 节 */
export const INPUT_TRUNCATE_TOKENS = 1500;
