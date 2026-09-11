import { z } from "zod";

import {
  SEVERITY_LEVELS,
  TOPIC_CATEGORIES,
  type InfoSufficiency,
  type SeverityLevel,
  type SeveritySignal,
  type TopicCandidate,
  type TopicCategory,
} from "@/types/contract";

/**
 * 模型负责的三部分：topicCandidates、severity、infoSufficiency。
 *
 * duplicates 与 meta 不在 Schema 内：二者由服务端逻辑填充，
 * 模型无法知晓自身响应耗时，也无法访问检索库。
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
