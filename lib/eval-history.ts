/**
 * 评测批次历史（静态数据模块）
 *
 * ⚠ 本文件由脚本从 data/eval_metrics_*.json 逐字段抄出，请勿手工编辑。
 * 任何数字都不得手改或美化：报告页的可信度完全依赖「页面数字 == JSON 数字」。
 * 新增批次时重新生成本文件，不要在此处追加手写条目。
 *
 * 为何用静态模块而非运行时读目录：
 *   1. 报告页需要能静态渲染（含日后部署到 Serverless/Edge），运行时扫 data/
 *      目录在构建产物中不可靠——data/ 不随构建产物分发；
 *   2. 评测结果是冻结的历史事实，不是运行期状态，没有动态读取的必要；
 *   3. 固定为源码后，数字进入 git 历史，可追溯每次报告页改动对应的数据版本。
 *
 * 生成时间：2026-09-23T02:47:20.425Z
 * 源文件：data/eval_metrics_baseline-20260920.json、data/eval_metrics_sev-defined.json、data/eval_metrics_sev-procedural.json、data/eval_metrics_sev-fewshot.json、data/eval_metrics_qwen3max-v13.json、data/eval_metrics_with-rag.json
 */

import type { SeverityLevel, TopicCategory } from "@/types/contract";

export type EvalRunRecord = {
  runId: string;
  /** 批次标签，来自 JSON 的 runLabel 原值（注意与 runId 不一定相同） */
  runLabel: string;
  promptVersion: string;
  modelId: string;
  createdAt: string;
  /** 实际计入统计的样本数，注意各批次不完全相同 */
  sampleCount: number;
  topicTop1Accuracy: number;
  topicTop3HitRate: number;
  topicMacroF1: number;
  severityAccuracy: number;
  perTopicF1: Record<TopicCategory, number>;
  perSeverityF1: Record<SeverityLevel, number>;
  parseSuccessRate: number;
  retryRate: number;
  fallbackRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  adversarial: {
    sampleCount: number;
    correctlyFlagged: number;
    correctlyFlaggedRate: number;
  };
  /** null 表示该批次未跑查重段（sev-defined 即为此情形） */
  duplicate: {
    pairs: number;
    recallAt5: number;
    precision: number;
    precisionThreshold: number;
  } | null;
};

/** 按 createdAt 升序，与实验推进顺序一致 */
export const EVAL_RUNS: readonly EvalRunRecord[] = [
  {
    runId: "baseline-20260920",
    runLabel: "baseline",
    promptVersion: "v1.0",
    modelId: "qwen-plus",
    createdAt: "2026-09-20T10:57:39+00:00",
    sampleCount: 280,
    topicTop1Accuracy: 0.7035714285714286,
    topicTop3HitRate: 0.9,
    topicMacroF1: 0.6855404764299323,
    severityAccuracy: 0.2857142857142857,
    perTopicF1: {
      editor: 0.6296,
      rendering: 0.7048,
      gui: 0.6316,
      gdscript: 0.8302,
      core: 0.5091,
      platforms: 0.3922,
      animation: 0.8889,
      buildsystem: 0.7895,
      import: 0.8511,
      input: 0.6286,
      other: 0,
    },
    perSeverityF1: {
      crash: 0.8989,
      high: 0.4094,
      normal: 0.0704,
      low: 0,
    },
    parseSuccessRate: 0.9892857142857143,
    retryRate: 0.010714285714285714,
    fallbackRate: 0,
    avgLatencyMs: 4681.6,
    p95LatencyMs: 5095,
    adversarial: {
      sampleCount: 20,
      correctlyFlagged: 8,
      correctlyFlaggedRate: 0.4,
    },
    duplicate: {
      pairs: 37,
      recallAt5: 0.4865,
      precision: 0.5909,
      precisionThreshold: 0.75,
    },
  },
  {
    runId: "sev-defined",
    runLabel: "baseline",
    promptVersion: "v1.1",
    modelId: "qwen-plus",
    createdAt: "2026-09-21T11:39:31+00:00",
    sampleCount: 280,
    topicTop1Accuracy: 0.7321428571428571,
    topicTop3HitRate: 0.9,
    topicMacroF1: 0.7121797136523711,
    severityAccuracy: 0.375,
    perTopicF1: {
      editor: 0.6538,
      rendering: 0.75,
      gui: 0.7119,
      gdscript: 0.7778,
      core: 0.4286,
      platforms: 0.566,
      animation: 0.8889,
      buildsystem: 0.8718,
      import: 0.8444,
      input: 0.6286,
      other: 0,
    },
    perSeverityF1: {
      crash: 0.8172,
      high: 0.5471,
      normal: 0.1395,
      low: 0,
    },
    parseSuccessRate: 1,
    retryRate: 0,
    fallbackRate: 0,
    avgLatencyMs: 4562.4,
    p95LatencyMs: 5009,
    adversarial: {
      sampleCount: 20,
      correctlyFlagged: 7,
      correctlyFlaggedRate: 0.35,
    },
    duplicate: null,
  },
  {
    runId: "sev-procedural",
    runLabel: "sev-procedural",
    promptVersion: "v1.2",
    modelId: "qwen-plus",
    createdAt: "2026-09-22T02:05:44+00:00",
    sampleCount: 279,
    topicTop1Accuracy: 0.7204301075268817,
    topicTop3HitRate: 0.9032258064516129,
    topicMacroF1: 0.696495220287263,
    severityAccuracy: 0.36200716845878134,
    perTopicF1: {
      editor: 0.6727,
      rendering: 0.717,
      gui: 0.6667,
      gdscript: 0.7778,
      core: 0.5185,
      platforms: 0.4583,
      animation: 0.8485,
      buildsystem: 0.7692,
      import: 0.8696,
      input: 0.6667,
      other: 0,
    },
    perSeverityF1: {
      crash: 0.7434,
      high: 0.6667,
      normal: 0.0896,
      low: 0.0706,
    },
    parseSuccessRate: 0.9892857142857143,
    retryRate: 0.010714285714285714,
    fallbackRate: 0.0035714285714285713,
    avgLatencyMs: 4670.9,
    p95LatencyMs: 5108,
    adversarial: {
      sampleCount: 20,
      correctlyFlagged: 6,
      correctlyFlaggedRate: 0.3,
    },
    duplicate: {
      pairs: 37,
      recallAt5: 0.4865,
      precision: 0.5909,
      precisionThreshold: 0.75,
    },
  },
  {
    runId: "sev-fewshot",
    runLabel: "sev-fewshot",
    promptVersion: "v1.3",
    modelId: "qwen-plus",
    createdAt: "2026-09-22T06:08:56+00:00",
    sampleCount: 278,
    topicTop1Accuracy: 0.7302158273381295,
    topicTop3HitRate: 0.8992805755395683,
    topicMacroF1: 0.707898900440037,
    severityAccuracy: 0.4352517985611511,
    perTopicF1: {
      editor: 0.6863,
      rendering: 0.7238,
      gui: 0.6923,
      gdscript: 0.7719,
      core: 0.5517,
      platforms: 0.5357,
      animation: 0.8571,
      buildsystem: 0.8108,
      import: 0.7826,
      input: 0.6667,
      other: 0,
    },
    perSeverityF1: {
      crash: 0.713,
      high: 0.6761,
      normal: 0.0971,
      low: 0.2755,
    },
    parseSuccessRate: 0.9928571428571429,
    retryRate: 0.007142857142857143,
    fallbackRate: 0.007142857142857143,
    avgLatencyMs: 4765.4,
    p95LatencyMs: 5189,
    adversarial: {
      sampleCount: 20,
      correctlyFlagged: 5,
      correctlyFlaggedRate: 0.25,
    },
    duplicate: {
      pairs: 37,
      recallAt5: 0.4865,
      precision: 0.5909,
      precisionThreshold: 0.75,
    },
  },
  {
    runId: "qwen3max-v13",
    runLabel: "qwen3max-v13",
    promptVersion: "v1.3",
    modelId: "qwen3-max",
    createdAt: "2026-09-22T07:18:09+00:00",
    sampleCount: 280,
    topicTop1Accuracy: 0.7785714285714286,
    topicTop3HitRate: 0.9142857142857143,
    topicMacroF1: 0.7564020657248789,
    severityAccuracy: 0.4607142857142857,
    perTopicF1: {
      editor: 0.6726,
      rendering: 0.7706,
      gui: 0.717,
      gdscript: 0.8727,
      core: 0.5333,
      platforms: 0.5385,
      animation: 0.8889,
      buildsystem: 0.9231,
      import: 0.8696,
      input: 0.7778,
      other: 0.04,
    },
    perSeverityF1: {
      crash: 0.7692,
      high: 0.6413,
      normal: 0.0851,
      low: 0.3529,
    },
    parseSuccessRate: 1,
    retryRate: 0,
    fallbackRate: 0,
    avgLatencyMs: 3710.7,
    p95LatencyMs: 4400,
    adversarial: {
      sampleCount: 20,
      correctlyFlagged: 4,
      correctlyFlaggedRate: 0.2,
    },
    duplicate: {
      pairs: 37,
      recallAt5: 0.4865,
      precision: 0.5909,
      precisionThreshold: 0.75,
    },
  },
  {
    runId: "with-rag",
    runLabel: "with-rag",
    promptVersion: "v2.0",
    modelId: "qwen-plus",
    createdAt: "2026-09-22T10:33:34+00:00",
    sampleCount: 280,
    topicTop1Accuracy: 0.7321428571428571,
    topicTop3HitRate: 0.95,
    topicMacroF1: 0.6962986496760082,
    severityAccuracy: 0.44285714285714284,
    perTopicF1: {
      editor: 0.6792,
      rendering: 0.72,
      gui: 0.6923,
      gdscript: 0.7857,
      core: 0.4615,
      platforms: 0.5,
      animation: 0.8205,
      buildsystem: 0.8108,
      import: 0.75,
      input: 0.7429,
      other: 0.2456,
    },
    perSeverityF1: {
      crash: 0.7778,
      high: 0.6803,
      normal: 0.0741,
      low: 0.2843,
    },
    parseSuccessRate: 0.9964285714285714,
    retryRate: 0.0035714285714285713,
    fallbackRate: 0,
    avgLatencyMs: 5409.4,
    p95LatencyMs: 6444,
    adversarial: {
      sampleCount: 20,
      correctlyFlagged: 5,
      correctlyFlaggedRate: 0.25,
    },
    duplicate: {
      pairs: 37,
      recallAt5: 0.4865,
      precision: 0.5909,
      precisionThreshold: 0.75,
    },
  },
] as const;

/** 最新批次（当前线上使用的 v2.0） */
export const LATEST_RUN_ID = "with-rag";

/**
 * 严重度朴素基线：恒定输出最多数类别的准确率。
 *
 * 取值依据：with-rag 批次 severityConfusionMatrix 按列求和得到标准答案分布
 * （该矩阵为 [预测档][标准答案档]，故列和即标准答案计数）：
 *   crash 42 / high 72 / normal 8 / low 158，合计 280。
 * 最多数类别为 "low"（158 条），故基线 = 158 / 280。
 *
 * 该值是本项目判断「严重度是否可用」的门槛：模型准确率低于它，
 * 说明不如无脑输出 "low"，不具备产品价值。
 */
export const SEVERITY_NAIVE_BASELINE = {
  /** 最多数类别 */
  majorityLevel: "low" as SeverityLevel,
  count: 158,
  total: 280,
  accuracy: 158 / 280,
} as const;

export const TOPIC_ORDER: readonly TopicCategory[] = [
  "editor",
  "rendering",
  "gui",
  "gdscript",
  "core",
  "platforms",
  "animation",
  "buildsystem",
  "import",
  "input",
  "other",
] as const;

export const SEVERITY_ORDER: readonly SeverityLevel[] = [
  "crash",
  "high",
  "normal",
  "low",
] as const;
