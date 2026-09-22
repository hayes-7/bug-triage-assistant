/**
 * Prompt v1.3 —— few-shot 示例版本（严重度判定的最后一搏）
 *
 * 文档依据：PD-07 Prompt 管理规范
 * 对应评测批次：sev-fewshot
 * 立项文档：outputs/v1.3_立项文档.md
 *
 * ─────────────────────────────────────────────────────────────
 * 本版变更（相对 v1.2）
 * ─────────────────────────────────────────────────────────────
 * 唯一变更：在严重度判定程序之后，叠加 12 条 few-shot 示例，
 * 用「具体样本 → 档位」的映射给模型语义锚点。
 *
 * 触发依据（sev-procedural 批次实测，data/eval_metrics_sev-procedural.json）：
 *   - 严重度准确率 36.20%，命中证伪条件①（< 朴素基线 56.4%）
 *   - v1.2 的顺序判定程序 + MUST 指令是软约束：模型是语义最近邻匹配器，
 *     不执行程序；(d) low 作为终点未被执行，normal 吸走 109 条真值 low
 *   - 依 v1.2 预注册的失败处置，转 few-shot
 *
 * 机制依据：v1.2 证明模型不做程序执行、只做语义最近邻。few-shot 是三版里
 * 唯一与该机制不冲突的路线——它不给规则，给锚点。
 *
 * 两个补丁（Hayes 2026-09-22 确认带上）：
 *   1. 示例分布反映「low 是多数类」：12 条中 low 占 6 条。示例的数量分布是
 *      模型能直接感受到的硬信号，破「回避 low」倾向（MUST 指令这类软约束做不到）
 *   2. 示例用自然语言叙述，不用 JSON 结构：避开 check_prompt.py 检查项 2
 *      （提示词含花括号 / 契约字段名）
 *
 * 关键设计：low 的 6 条示例中，3 条是「功能行为错误但影响小」的边界形态
 * （对应 v1.2 被 normal 吞掉的 109 条的样子），3 条是纯文案/UI 小问题。
 * 数据核查（2026-09-22）：被 normal 吞的 109 条真值 low 与 v1.2 判对的 6 条 low，
 * 全部是「无严重度标签的兜底 low」——这是 low 在本数据集的全部形态，
 * 故示例刻意纳入「听起来偏严重实则 low」的边界样本（如 #86599 数据剥离），
 * 教模型看影响面而非字面。
 *
 * ─────────────────────────────────────────────────────────────
 * 刻意保持不变的部分（保证独立归因）
 * ─────────────────────────────────────────────────────────────
 * v1.2 的严重度判定程序（(a)-(d) 全文）、模块类别段、信息充分度段、
 * signals 清单、buildUserPrompt、MODEL_PARAMS、INPUT_TRUNCATE_TOKENS
 * 全部逐字一致。v1.3 与 v1.2 的指标差值，即为「few-shot 示例」这一手段的
 * 独立贡献值。
 *
 * ─────────────────────────────────────────────────────────────
 * 结构化输出约定（PD-07 第 6.1 节）
 * ─────────────────────────────────────────────────────────────
 * 本文件中不出现任何 JSON 格式说明、字段名清单或输出样例。
 * 格式约束的唯一来源是 Zod Schema（配合 generateObject 使用）。
 * 示例中的档位词（crash/high/normal/low）是契约枚举值，非字段名。
 *
 * ─────────────────────────────────────────────────────────────
 * few-shot 示例来源登记（PD-07 第 8.1 节）
 * ─────────────────────────────────────────────────────────────
 * 12 条示例全部取自检索库 data/retrieval_corpus.csv（in_eval_set = false）。
 * 泄漏校验：候选 number 与 eval_set_main.csv(280) 交集 0、
 * 与 eval_set_adversarial.csv(20) 交集 0。
 *
 * 示例样本编号：
 *   low:    #85096 #83660 #86599 #69328 #99972 #118919
 *   high:   #111465 #119320
 *   crash:  #69082 #68602
 *   normal: #96820 #118047
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
export const PROMPT_VERSION = "v1.3";

/** 对应的评测批次标识 */
export const EVAL_BATCH_LABEL = "sev-fewshot";

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

   Worked examples (match by meaning; these are anchors, not rules to
   copy verbatim):

   - "remove_paragraph(0) in RichTextLabel only works once" — low: the
     function misbehaves on repeated calls, but the feature still works
     and the impact is a single edge case.

   - "Untyped Declaration warning for iterator broken for dictionaries
     and can't be ignored" — low: a compiler warning behaves unexpectedly,
     but it is an annoyance, not a broken workflow.

   - "Resources with properties set to missing resource types are stripped
     upon save" — low: data is lost only in an unusual missing-type
     scenario; the main workflow is unaffected, so judge by impact, not
     by the word "stripped".

   - "BaseMaterial3D: wrong tooltip/documentation for roughness texture
     channel" — low: the on-screen help text is wrong, but the feature
     itself works.

   - "Very slight grammatical issue in documentation" — low: a typo in
     the docs, with no functional impact.

   - "Two full screen/zoom buttons and no app icon on macOS High Sierra"
     — low: a cosmetic UI glitch on an old OS version.

   - "Baking lightmaps in Compatibility no longer works due to core shader
     regression" — high: it is a regression, with explicit evidence (not
     reproducible in the previous stable release).

   - "Using Input.parse_input_event can make button presses stop working
     in some circumstances" — high: a regression, reproducible in the new
     version and not in the earlier stable one.

   - "Editor crashes when deleting children of GraphNode" — crash: the
     editor terminates abnormally on a specific action.

   - "Random crashes with no errors logged, related to memory access
     violations" — crash: the process dies from a memory error.

   - "NavMap sync write_lock blocks the main loop, causes stuttering" —
     normal: the feature works but performance is degraded.

   - "Overlapping Area3Ds in Jolt physics seems to cause lag" — normal:
     a performance degradation under a specific condition.

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
