import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { truncateToTokenLimit } from "@/lib/truncate";
import { errorResponse } from "@/lib/triage/errors";
import { MissingModelApiKeyError, callTriageModel } from "@/lib/triage/model";
import { normalizeModelOutput, type ModelOutput } from "@/lib/triage/schema";
import { PROMPT_VERSION } from "@/prompts/triage_v1_0";
import {
  TIMEOUTS,
  type ErrorResponse,
  type TriageInput,
  type TriageMeta,
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

    return NextResponse.json(buildResult(modelCall.output, meta), { status: 200 });
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
function buildResult(output: ModelOutput | null, meta: TriageMeta): TriageResult {
  // TODO: 向量检索未实现，duplicates/isDuplicate 临时固定，详见 resolveDuplicates
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
      ...resolveDuplicates(),
      infoSufficiency: "insufficient",
      meta,
    };
  }

  const normalized = normalizeModelOutput(output);

  return {
    topicCandidates: normalized.topicCandidates,
    severity: normalized.severity,
    ...resolveDuplicates(),
    infoSufficiency: normalized.infoSufficiency,
    meta,
  };
}

/**
 * TODO: 向量检索尚未实现，此处固定返回空结果。
 *
 * 接入真实检索后：查询 Top-5 相似 issue，按 similarity 降序返回 0–5 项
 * （每项须带可跳转的 url），并在 duplicates[0].similarity >= DUP_THRESHOLD
 * 且模型语义确认时置 isDuplicate = true。检索超时（TIMEOUTS.retrieval）
 * 时跳过检索，不阻断模块判定。
 */
function resolveDuplicates(): Pick<TriageResult, "duplicates" | "isDuplicate"> {
  return { duplicates: [], isDuplicate: false };
}
