import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import type { RetrievalResult } from "@/lib/retrieval";
import { truncateToTokenLimit } from "@/lib/truncate";
import {
  buildIssueUrl,
  resolveDupDisplayMin,
  resolveDupThreshold,
} from "@/lib/triage/config";
import { errorResponse } from "@/lib/triage/errors";
import { MissingModelApiKeyError, callTriageModel } from "@/lib/triage/model";
import {
  normalizeModelOutput,
  normalizeReferences,
  type ModelOutput,
} from "@/lib/triage/schema";
import { PROMPT_VERSION } from "@/prompts";
import {
  TIMEOUTS,
  type DuplicateCandidate,
  type ErrorResponse,
  type TriageInput,
  type TriageMeta,
  type TriageReferences,
  type TriageResult,
} from "@/types/contract";

export const runtime = "nodejs";

/** 依契约输入约束：title 1–500，body 0–50000 */
const MAX_TITLE_LENGTH = 500;
const MAX_BODY_LENGTH = 50_000;

export async function POST(
  request: Request,
): Promise<NextResponse<TriageResult | ErrorResponse>> {
  const requestId = randomUUID();
  const startedAt = Date.now();

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "INVALID_INPUT", "请求体不是合法的 JSON", requestId);
  }

  const input = (payload ?? {}) as Partial<TriageInput>;

  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    return errorResponse(400, "INVALID_INPUT", "title 为必填且不能为空", requestId, "title");
  }
  if (input.title.length > MAX_TITLE_LENGTH) {
    return errorResponse(
      400,
      "INVALID_INPUT",
      `title 长度不得超过 ${MAX_TITLE_LENGTH} 字符`,
      requestId,
      "title",
    );
  }

  let body: string;
  if (input.body === undefined || input.body === null) {
    body = "";
  } else if (typeof input.body !== "string") {
    return errorResponse(400, "INVALID_INPUT", "body 必须是字符串", requestId, "body");
  } else {
    body = input.body;
  }

  if (body.length > MAX_BODY_LENGTH) {
    return errorResponse(
      400,
      "BODY_TOO_LONG",
      `body 长度不得超过 ${MAX_BODY_LENGTH} 字符`,
      requestId,
      "body",
    );
  }

  const truncatedBody = truncateToTokenLimit(body);

  const endToEndController = new AbortController();
  let endToEndTimedOut = false;
  const endToEndTimer = setTimeout(() => {
    endToEndTimedOut = true;
    endToEndController.abort();
  }, TIMEOUTS.endToEnd);

  try {
    const modelCall = await callTriageModel({
      title: input.title,
      body: truncatedBody,
      endToEndSignal: endToEndController.signal,
    });

    if (endToEndTimedOut) {
      return errorResponse(
        504,
        "TIMEOUT",
        `端到端处理超过 ${TIMEOUTS.endToEnd} 毫秒`,
        requestId,
      );
    }

    const meta: TriageMeta = {
      requestId,
      modelId: modelCall.modelId,
      promptVersion: PROMPT_VERSION,
      latencyMs: Date.now() - startedAt,
      inputTokens: modelCall.inputTokens,
      outputTokens: modelCall.outputTokens,
      retryCount: modelCall.retryCount,
      fallbackUsed: modelCall.output === null,
      timestamp: new Date().toISOString(),
    };

    const references = normalizeReferences(modelCall.retrieval);

    return NextResponse.json(
      buildResult(modelCall.output, modelCall.retrieval, references, meta),
      { status: 200 },
    );
  } catch (error) {
    if (endToEndTimedOut) {
      return errorResponse(
        504,
        "TIMEOUT",
        `端到端处理超过 ${TIMEOUTS.endToEnd} 毫秒`,
        requestId,
      );
    }
    if (error instanceof MissingModelApiKeyError) {
      return errorResponse(500, "INTERNAL_ERROR", error.message, requestId);
    }

    console.error("[triage] 未预期的服务端错误", { requestId, error });
    return errorResponse(500, "INTERNAL_ERROR", "服务端未预期的错误", requestId);
  } finally {
    clearTimeout(endToEndTimer);
  }
}

/** 模型输出为空时返回降级结果，HTTP 状态码仍为 200，不虚构候选类别 */
function buildResult(
  output: ModelOutput | null,
  retrieval: RetrievalResult,
  references: TriageReferences,
  meta: TriageMeta,
): TriageResult {
  if (!output) {
    /**
     * 降级结果中的 severity.level 与 infoSufficiency 是枚举占位值，不是模型判定结果：
     * 契约要求这两个字段必填且须取枚举内的值，模型无输出时无法给出真实判定。
     * 因此当 meta.fallbackUsed = true 时，这两项不可用于界面展示或指标统计，
     * 前端应隐藏或明确标注为"判定不可用"。
     * severity.confidence = 0、signals = ["none"]、topicCandidates = [] 同理，均非判定结论。
     */
    return {
      topicCandidates: [],
      severity: { level: "low", confidence: 0, signals: ["none"] },
      // 查重与模型无关：检索已完成，候选照常透出
      ...resolveDuplicates(retrieval),
      infoSufficiency: "insufficient",
      // references 与模型无关：检索已完成，照常透出，界面仍可展示「AI 参考了什么」
      references,
      meta,
    };
  }

  const normalized = normalizeModelOutput(output);

  return {
    topicCandidates: normalized.topicCandidates,
    severity: normalized.severity,
    ...resolveDuplicates(retrieval),
    infoSufficiency: normalized.infoSufficiency,
    references,
    meta,
  };
}

/**
 * 由检索结果填充查重字段。
 *
 * ── 数据来源 ──
 * 复用 lib/retrieval.ts 已完成的那一次 match_issues 检索
 *（retrieval.duplicateCandidates，Top-5，按相似度降序），
 * 不额外发起检索、不新增 RPC：查重与参考材料本就基于同一个 query embedding
 * 和同一份候选列表，再查一次只会翻倍延迟与超时概率。
 *
 * ── 防泄漏 ──
 * match_issues() 的 SQL 内置 `where i.in_eval_set = false`
 *（scripts/import_to_supabase.py 的函数定义），评测集样本不可能进入候选，
 * 该过滤由数据库侧保证，本次未改动 RPC，故过滤仍然生效。
 *
 * ── 展示下限与语义分区 ──
 * 检索侧的 MATCH_THRESHOLD（0.5）是 references 的召回下限，对查重列表过宽，
 * 故此处按 resolveDupDisplayMin() 再筛一道，三段语义分区：
 *   similarity >= DUP_THRESHOLD（0.75）      展示，且 isDuplicate = true
 *   DUP_DISPLAY_MIN ~ DUP_THRESHOLD          展示，但 isDuplicate = false
 *   similarity <  DUP_DISPLAY_MIN（0.70）    不展示
 * 过滤只作用于 duplicates（面向人的展示列表）。
 * references 走另一条路径（normalizeReferences → retrieval.issues 前 3 条），
 * 不受本过滤影响，注入给模型的内容因此逐字不变。
 * 过滤后不足 5 条即少几条，契约允许 duplicates 为 0–5 项。
 *
 * ── isDuplicate 判定（MVP）──
 * 条件：duplicates 非空 且 duplicates[0].similarity >= 阈值。
 * 阈值来源：lib/triage/config.ts 的 resolveDupThreshold()，
 * 默认取契约常量 DUP_THRESHOLD_INITIAL（0.75），可由环境变量 DUP_THRESHOLD 覆盖，
 * 与 EvalConfig.dupThreshold 同源，不在此处硬编码。
 * 与契约 PD-04 第 4.3 节的差异：该节要求再叠加「模型语义确认」，
 * 当前模型 Schema 无此输出字段（见 lib/triage/schema.ts 的说明），
 * 故 MVP 只做阈值判定，语义确认待后续版本补齐。
 * 正因缺这一条，界面不宣称「重复」，只陈述相似度并交人工核对（见 app/page.tsx）。
 *
 * ── 降级 ──
 * 检索失败或超时时 duplicateCandidates 为空数组，本函数返回
 * { duplicates: [], isDuplicate: false }，绝不返回 null，
 * HTTP 状态码仍为 200，topic / severity 主流程不受影响。
 */
function resolveDuplicates(
  retrieval: RetrievalResult,
): Pick<TriageResult, "duplicates" | "isDuplicate"> {
  const displayMin = resolveDupDisplayMin();

  const duplicates: DuplicateCandidate[] = retrieval.duplicateCandidates.flatMap(
    (candidate) => {
      /**
       * 契约要求 DuplicateCandidate.similarity 必填。
       * 检索层的 similarity 是可选字段（RPC 异常时可能缺失），
       * 缺失时丢弃该条而不是补 0：0 相似度是一个错误的结论，
       * 会让界面把完全不相关的 Issue 当成查重候选展示。
       */
      if (candidate.similarity === undefined) {
        console.warn("[triage] 查重候选缺少 similarity，已丢弃", {
          issueNumber: candidate.number,
        });
        return [];
      }

      // 低于展示下限的弱相关项不进列表（检索侧仍取回，references 不受影响）
      if (candidate.similarity < displayMin) return [];

      return [
        {
          issueNumber: candidate.number,
          title: candidate.title,
          similarity: candidate.similarity,
          url: buildIssueUrl(candidate.number, candidate.htmlUrl),
        },
      ];
    },
  );

  const dupThreshold = resolveDupThreshold();
  const topSimilarity = duplicates[0]?.similarity ?? 0;
  const isDuplicate = duplicates.length > 0 && topSimilarity >= dupThreshold;

  return { duplicates, isDuplicate };
}
