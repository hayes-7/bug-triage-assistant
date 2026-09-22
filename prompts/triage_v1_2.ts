/**
 * Prompt v1.2 —— 严重度判定程序化版本
 *
 * 文档依据：PD-07 Prompt 管理规范
 * 对应评测批次：sev-procedural
 * 立项文档：outputs/v1.2_立项文档.md
 *
 * ─────────────────────────────────────────────────────────────
 * 本版变更（相对 v1.1）
 * ─────────────────────────────────────────────────────────────
 * 唯一变更：把严重度判定从「四档并列定义」改为「按次序执行的判定程序」。
 *
 * 触发依据（sev-defined 批次实测，data/eval_metrics_sev-defined.json）：
 *   - 严重度准确率 37.50%，未达预期下限（45–55%），命中证伪条件①
 *   - `low` 档 158 个标准答案仍**零预测**（0/280），正面形容词定义无效
 *   - 朴素基线（全部预测 low）= 158/280 = 56.4%，**高于模型实测 37.50%**
 *
 * 三个机制级发现决定了本版设计：
 *   1. `low` 是程序性/残余类别（占 56%），本质是"排除其他档后的默认桶"，
 *      不可被"识别"只可被"排除后到达"——形容词式正面定义（edge-case/minor）
 *      描绘的形象远窄于真实外延，与 v1.0「无上述标签」同类失效
 *   2. 吸引子随"默认感"转移：v1.0 无定义→"normal"字面义吸走 134 次；
 *      v1.1 定义最长的是 high→high 成新吸引子（151 次，84 条真值 low）。
 *      只要走"定义竞争"范式，篇幅最长者必成吸引子
 *   3. 模型跑不赢"全猜 low"（56.4%），与多数类反向
 *
 * 因此本版把严重度改为按序判定：crash → high（须回归证据，否则不适用）
 * → normal → low（其余全部 + 最常见档 + 无匹配时必须选它）。
 * `low` 靠"程序位置"（最后一档 + 否则选它）确立，不靠篇幅——
 * 刻意让 low 的措辞短于 high，以规避发现 2 的吸引子机制。
 *
 * ─────────────────────────────────────────────────────────────
 * 刻意保持不变的部分（保证独立归因）
 * ─────────────────────────────────────────────────────────────
 * 本版**不得**引入除严重度判定方式以外的任何改动：
 *   - 不补充类别判定说明（继续推迟）
 *   - 不补充信息充分度判定标准（继续推迟）
 *   - 不加入 few-shot 示例（v1.3）
 *   - 不注入任何检索内容（v2.0）
 *
 * v1.2 与 v1.1 的指标差值，即为「判定程序化」这一手段的独立贡献值。
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
 * v1.2 不含示例。
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
export const PROMPT_VERSION = "v1.2";

/** 对应的评测批次标识 */
export const EVAL_BATCH_LABEL = "sev-procedural";

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

2. Severity — determine in this order; choose exactly one:

   (a) crash — the engine or editor terminates abnormally, hangs, or
       becomes unusable. Typical signals: stack trace, segfault, freeze.

   (b) high — a REGRESSION: the bug appears in a newer version but did
       NOT exist in an earlier stable release. This level REQUIRES
       evidence of a version comparison, such as "worked in 4.1",
       "Not reproducible in <older version>", or "used to work before".
       If no such evidence exists, this level does NOT apply, even when
       the bug seems important.

   (c) normal — the feature still works but is degraded: a noticeable
       performance loss, or a usability problem that affects the
       workflow without blocking it.

   (d) low — everything else. This is the MOST COMMON level, applying
       to roughly half of all reports: localized defects, edge cases,
       minor or cosmetic behavior, and unusual configurations that do
       not block the main workflow. When none of (a)-(c) clearly
       matches, you MUST choose low.

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
