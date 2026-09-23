import { z } from "zod";

import type { RetrievalResult } from "@/lib/retrieval";
import {
  SEVERITY_LEVELS,
  TOPIC_CATEGORIES,
  type InfoSufficiency,
  type SeverityLevel,
  type SeveritySignal,
  type TopicCandidate,
  type TopicCategory,
  type TriageReferences,
} from "@/types/contract";

/**
 * 模型负责的三部分：topicCandidates、severity、infoSufficiency。
 *
 * duplicates、references 与 meta 不在 Schema 内：三者由服务端逻辑填充，
 * 模型无法知晓自身响应耗时，也无法访问检索库。
 * 尤其 references 必须来自检索层的真实返回——若交给模型输出，
 * 模型会编造 issue 编号，界面「AI 参考了什么」即失去可核对性。
 */

const TOPIC_VALUES = [...TOPIC_CATEGORIES] as [TopicCategory, ...TopicCategory[]];
const SEVERITY_VALUES = [...SEVERITY_LEVELS] as [SeverityLevel, ...SeverityLevel[]];
const SIGNAL_VALUES: [SeveritySignal, ...SeveritySignal[]] = [
  "crash_keyword",
  "stack_trace",
  "version_regression",
  "performance_issue",
  "usability_issue",
  "compile_failure",
  "none",
];

export const modelOutputSchema = z.object({
  topicCandidates: z
    .array(
      z.object({
        topic: z.enum(TOPIC_VALUES),
        confidence: z.number().min(0).max(1),
        // 不校验 80 字符上限：该约束已写入 Prompt，模型偶发超长会触发
        // 解析失败并计入降级率，代价远大于收益
        reasoning: z.string(),
      }),
    )
    .length(3)
    .refine(
      (candidates) => new Set(candidates.map((candidate) => candidate.topic)).size === 3,
      { message: "topicCandidates 的 topic 不得重复" },
    ),

  severity: z.object({
    level: z.enum(SEVERITY_VALUES),
    confidence: z.number().min(0).max(1),
    signals: z.array(z.enum(SIGNAL_VALUES)).min(1),
  }),

  infoSufficiency: z.enum(["sufficient", "partial", "insufficient"] satisfies readonly InfoSufficiency[]),
});

export type ModelOutput = z.infer<typeof modelOutputSchema>;

export type NormalizedModelOutput = {
  topicCandidates: TopicCandidate[];
  severity: {
    level: SeverityLevel;
    confidence: number;
    signals: SeveritySignal[];
  };
  infoSufficiency: InfoSufficiency;
};

/**
 * 归一化模型输出：
 *   1. topicCandidates 按 confidence 降序（契约要求，排序为确定性归一化，不依赖模型自觉）；
 *   2. signals 去重，未命中任何信号时为 ["none"]，命中信号时移除冗余的 "none"。
 */
export function normalizeModelOutput(output: ModelOutput): NormalizedModelOutput {
  return {
    topicCandidates: [...output.topicCandidates].sort((a, b) => b.confidence - a.confidence),
    severity: {
      ...output.severity,
      signals: normalizeSignals(output.severity.signals),
    },
    infoSufficiency: output.infoSufficiency,
  };
}

function normalizeSignals(signals: SeveritySignal[]): SeveritySignal[] {
  const hits = Array.from(new Set(signals)).filter((signal) => signal !== "none");
  return hits.length > 0 ? hits : ["none"];
}

/**
 * 把检索层结果映射为契约的 references 字段。
 *
 * 逐字段显式白名单拷贝，不使用展开运算：
 * 检索层日后若多带出 gt_topics / html_url 等字段，展开会把它们一并泄漏到响应里，
 * 而白名单拷贝在这种情况下仍然安全。
 *
 * 降级（retrieval.ok = false）时两个数组均为空数组，不返回 null。
 * 检索层已按相似度升序距离排序（RPC 的 order by 距离），此处保持原序即为相似度降序。
 */
export function normalizeReferences(retrieval: RetrievalResult): TriageReferences {
  return {
    issues: retrieval.issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      // 检索层当前未透出 similarity（见 types/contract.ts 的 ReferenceIssue 注释），
      // 这里按可选字段处理：拿到就带上，拿不到就不写，绝不填 0 充数
      ...pickSimilarity(issue),
    })),
    rules: retrieval.rules.map((rule) => ({
      labelName: rule.labelName,
      ruleText: rule.ruleText,
      ...pickSimilarity(rule),
    })),
  };
}

/** 仅当来源对象真的带了 0–1 的 similarity 时才产出该键，否则产出空对象 */
function pickSimilarity(source: unknown): { similarity?: number } {
  const value = (source as { similarity?: unknown } | null)?.similarity;
  if (typeof value !== "number" || !Number.isFinite(value)) return {};
  return { similarity: Math.min(1, Math.max(0, value)) };
}
