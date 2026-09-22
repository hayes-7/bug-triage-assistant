/**
 * Prompt v2.0 —— 检索增强版本（模块二 · RAG）
 *
 * 文档依据：PD-07 Prompt 管理规范
 * 对应评测批次：with-rag
 *
 * ─────────────────────────────────────────────────────────────
 * 本版变更（相对 v1.3）
 * ─────────────────────────────────────────────────────────────
 * 两处变更：
 *
 * 1）SYSTEM_PROMPT 新增「Reference material」段。
 *    该段只说明参考材料的性质与用法（弱上下文、非证据），
 *    不含任何具体检索内容——内容由 buildUserPrompt 在请求时注入。
 *
 * 2）buildUserPrompt 新增可选入参 reference，命中时追加参考材料段：
 *    Top-3 相似 Issue 标题 + Top-2 官方规则条文。
 *    检索失败或空结果时该段整体缺省，用户提示词与 v1.3 逐字一致。
 *
 * 触发依据：v1.3 严重度 43.53%，已判定为「严重度方向达能力上限，不再优化」
 * （见 CHANGELOG v1.3 与 qwen3max-v13 的处置）。模块二转向分类侧增强：
 * 分类 Top-1 73.02% 仍低于 qwen3-max 的 77.86%，且 v1.0–v1.3 的提示词
 * 工程从未给过模型任何「本项目语料」层面的信息——模块名清单是抽象的，
 * 检索回来的相似报告标题是具体的。
 *
 * 机制依据：v1.1–v1.3 逐版证明模型在本任务上是语义最近邻匹配器。
 * 检索增强与这一机制同向：它不改判定规则，只给模型提供同一语义空间里
 * 的真实邻域样本，让最近邻有更好的参照物。
 *
 * ─────────────────────────────────────────────────────────────
 * 刻意保持不变的部分（保证独立归因）
 * ─────────────────────────────────────────────────────────────
 * v1.3 的模块类别段、严重度判定程序 (a)-(d) 全文、12 条 few-shot 示例、
 * 信息充分度段、signals 清单、参考材料段以外的 buildUserPrompt 输出、
 * MODEL_PARAMS（temperature 0 / maxOutputTokens 800）、
 * INPUT_TRUNCATE_TOKENS（1500）全部逐字一致。
 * v2.0 与 v1.3 的指标差值，即为「检索增强」这一手段的独立贡献值。
 *
 * ─────────────────────────────────────────────────────────────
 * 防泄漏约束（硬性）
 * ─────────────────────────────────────────────────────────────
 * 只注入相似 Issue 的 number / title 与规则的 label_name / rule_text。
 * 绝不注入检索结果的 gt_topics / gt_severity——那等同于给答案，
 * 会让评测指标失真。match_issues 已内置 in_eval_set = false 过滤，
 * 检索库为 4200 条非评测集记录。
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
 * 12 条示例全部取自检索库 data/retrieval_corpus.csv（in_eval_set = false），
 * 与 v1.3 逐字一致，本版未增删。
 * 泄漏校验：候选 number 与 eval_set_main.csv(280) 交集 0、
 * 与 eval_set_adversarial.csv(20) 交集 0。
 *
 * 示例样本编号：
 *   low:    #85096 #83660 #86599 #69328 #99972 #118919
 *   high:   #111465 #119320
 *   crash:  #69082 #68602
 *   normal: #96820 #118047
 *
 * ─────────────────────────────────────────────────────────────
 * 检索参考材料来源登记（本版新增）
 * ─────────────────────────────────────────────────────────────
 * 来源表：issues（in_eval_set = false，4200 条，已向量化）、
 *         triage_rules（54 条官方规则）。
 * 注入字段：issues.number / issues.title、triage_rules.label_name /
 *           triage_rules.rule_text。
 * 未注入字段：gt_topics、gt_severity、raw_labels、html_url、body。
 * 检索参数：match_issues(embedding, 0.5, 3)、match_rules(embedding, 2)。
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
export const PROMPT_VERSION = "v2.0";

/** 对应的评测批次标识 */
export const EVAL_BATCH_LABEL = "with-rag";

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

Reference material — the user message may contain a section named
"Reference material" listing titles of similar past bug reports and
excerpts of the project's official triage rules. Use it as weak context
only: it can suggest the vocabulary or the module that a report belongs
to, but it is not evidence about the report you are judging. Similar
wording does not mean the same bug, and the listed titles carry no
answer for this report.

Base your judgments only on the report content. Do not guess beyond
what the text states.`;

// ============================================================
// 用户提示词
// ============================================================

/** 参考材料：仅含标题与规则条文，不含任何标准答案字段 */
export type ReferenceMaterial = {
  issues: { number: number; title: string }[];
  rules: { labelName: string; ruleText: string }[];
};

/**
 * 构造用户提示词。
 *
 * 注意：body 的截断须在调用本函数之前完成（1500 token，PD-06 第 4.3 节），
 * 本函数不负责截断，以便截断逻辑可被单独测试与调整。
 *
 * reference 缺省或内容为空时，本函数的输出与 v1.3 逐字一致，
 * 用于检索降级路径的对照。
 */
export function buildUserPrompt(input: {
  title: string;
  body: string;
  reference?: ReferenceMaterial;
}): string {
  const base = `Title: ${input.title}

Body:
${input.body}`;

  const reference = formatReference(input.reference);
  return reference ? `${base}\n\n${reference}` : base;
}

/**
 * 拼装参考材料段。
 *
 * 空结果返回空字符串，调用方据此保持与 v1.3 一致的提示词形态。
 */
function formatReference(reference?: ReferenceMaterial): string {
  if (!reference) return "";

  const issueLines = reference.issues
    .filter((issue) => issue.title.trim().length > 0)
    .map((issue) => `- #${issue.number} ${issue.title.trim()}`);

  const ruleLines = reference.rules
    .filter((rule) => rule.ruleText.trim().length > 0)
    .map((rule) =>
      rule.labelName.trim()
        ? `- [${rule.labelName.trim()}] ${rule.ruleText.trim()}`
        : `- ${rule.ruleText.trim()}`,
    );

  if (issueLines.length === 0 && ruleLines.length === 0) return "";

  const blocks: string[] = [];
  if (issueLines.length > 0) {
    blocks.push(`Similar past reports:\n${issueLines.join("\n")}`);
  }
  if (ruleLines.length > 0) {
    blocks.push(`Official triage rules:\n${ruleLines.join("\n")}`);
  }

  return `Reference material:\n${blocks.join("\n")}`;
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
