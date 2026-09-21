import { createOpenAI } from "@ai-sdk/openai";
import {
  APICallError,
  JSONParseError,
  NoObjectGeneratedError,
  TypeValidationError,
  generateObject,
} from "ai";

import { MODEL_PARAMS, SYSTEM_PROMPT, buildUserPrompt } from "@/prompts";
import { TIMEOUTS } from "@/types/contract";

import { modelOutputSchema, type ModelOutput } from "./schema";

/** 未配置 PRIMARY_MODEL_ID 时使用的默认模型 */
export const DEFAULT_MODEL_ID = "gpt-4o-mini";

/** 首次调用 + 1 次重试 */
const MAX_ATTEMPTS = 2;

export class MissingModelApiKeyError extends Error {
  constructor() {
    super("环境变量 PRIMARY_MODEL_API_KEY 未配置");
    this.name = "MissingModelApiKeyError";
  }
}

export type ModelCallResult = {
  /** null 表示重试后仍失败，调用方须返回降级结果 */
  output: ModelOutput | null;
  /** 实际调用的模型标识，写入 meta.modelId，作为模型对比实验的分组依据 */
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  /** 实际重试次数，0 表示首次成功 */
  retryCount: number;
};

/**
 * 调用模型生成结构化分诊结果。
 *
 * 环境变量（均在请求处理时读取，不在模块加载时读取）：
 *   PRIMARY_MODEL_API_KEY  必填，缺省抛 MissingModelApiKeyError
 *   OPENAI_BASE_URL        可选，OpenAI 兼容端点；不配置时使用 provider 默认地址
 *   PRIMARY_MODEL_ID       可选，缺省为 DEFAULT_MODEL_ID
 * 三项分开配置是为了更换 OpenAI 兼容厂商（DeepSeek、通义等）时只改 .env.local，不改代码。
 * 注意：不同厂商的结构化输出支持程度不同，切换后须重跑解析成功率指标。
 *
 * 超时与重试策略：
 *   - 单次模型调用 30 秒超时（TIMEOUTS.model），按解析失败处理，进入重试；
 *   - 仅可恢复错误重试 1 次，仍失败时 output 返回 null，由调用方降级；
 *   - 不可恢复错误（鉴权、配置等）不再重试，直接降级，retryCount 保持 0：
 *     这类错误重试注定失败，而 retryRate 是 PD-05 的正式评测指标，
 *     把配置故障计入重试会让错误分析误判为模型不稳定；
 *   - 端到端信号一旦触发则立即中断，不再重试，交由路由返回 504。
 */
export async function callTriageModel(options: {
  title: string;
  body: string;
  endToEndSignal?: AbortSignal;
}): Promise<ModelCallResult> {
  const apiKey = process.env.PRIMARY_MODEL_API_KEY;
  if (!apiKey) throw new MissingModelApiKeyError();

  const baseURL = process.env.OPENAI_BASE_URL?.trim() || undefined;
  const modelId = process.env.PRIMARY_MODEL_ID?.trim() || DEFAULT_MODEL_ID;

  const openai = createOpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const prompt = buildUserPrompt({ title: options.title, body: options.body });

  let inputTokens = 0;
  let outputTokens = 0;
  let retryCount = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) retryCount += 1;

    try {
      const { object, usage } = await generateObject({
        // 使用 Chat Completions 而非默认的 Responses API：
        // 前者是各 OpenAI 兼容端点（含自建网关与中转）普遍支持的接口
        model: openai.chat(modelId),
        instructions: SYSTEM_PROMPT,
        prompt,
        schema: modelOutputSchema,
        temperature: MODEL_PARAMS.temperature,
        maxOutputTokens: MODEL_PARAMS.maxOutputTokens,
        // 重试由本函数显式控制，关闭 SDK 内部重试以免次数叠加
        maxRetries: 0,
        abortSignal: AbortSignal.any([
          AbortSignal.timeout(TIMEOUTS.model),
          ...(options.endToEndSignal ? [options.endToEndSignal] : []),
        ]),
      });

      inputTokens += usage.inputTokens ?? 0;
      outputTokens += usage.outputTokens ?? 0;

      return { output: object, modelId, inputTokens, outputTokens, retryCount };
    } catch (error) {
      if (options.endToEndSignal?.aborted) throw error;

      const recoverable = isRecoverableModelError(error);
      console.error("[triage] 模型调用失败", {
        attempt: attempt + 1,
        modelId,
        recoverable,
        error,
      });

      if (!recoverable) break;
    }
  }

  console.error("[triage] 返回降级结果", { modelId, retryCount });
  return { output: null, modelId, inputTokens, outputTokens, retryCount };
}

/**
 * 网络层错误码：连接被重置 / 拒绝、DNS 失败、读写超时等，属可恢复错误。
 * 用于识别 undici 抛出的 `TypeError: fetch failed`（cause 为下述错误码）。
 */
const RECOVERABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * 判断错误是否可恢复（值得重试）。
 *
 * 可恢复：模型超时/中止、解析或校验失败、408/429、5xx、网络层失败。
 * 不可恢复：401/403 鉴权失败、配置错误（如 API Key 含非 ASCII 字符导致
 *           Header 构造失败）、LoadAPIKeyError，以及一切无法归类的错误。
 *
 * 采用"默认不重试"：重试只对已确认具备幂等收益的错误开放，
 * 未归类错误直接降级，避免无谓消耗重试次数并污染 retryRate。
 */
function isRecoverableModelError(error: unknown): boolean {
  // HTTP 层：有状态码按状态码判定；无状态码（连接类失败）按 provider 标记判定
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status !== undefined) return status === 408 || status === 429 || status >= 500;
    return error.isRetryable;
  }

  // 解析失败：模型输出不符合 Schema，或 JSON 无法解析
  if (
    NoObjectGeneratedError.isInstance(error) ||
    TypeValidationError.isInstance(error) ||
    JSONParseError.isInstance(error)
  ) {
    return true;
  }

  // 30 秒模型超时（端到端超时已在调用处单独处理，不会走到这里）
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;

  // fetch failed：cause 为网络错误码时属可恢复；
  // 其余 TypeError（典型为 Header 构造失败）属配置错误，不重试
  if (error instanceof TypeError) return hasRecoverableNetworkCause(error);

  return false;
}

function hasRecoverableNetworkCause(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && RECOVERABLE_NETWORK_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
