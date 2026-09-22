import { TIMEOUTS } from "@/types/contract";

import { getSupabaseServerClient } from "./supabase";

/**
 * 检索层（模块二 · RAG）
 *
 * 职责：把当前缺陷报告变成向量，取回 Top-K 相似 Issue 与 Top-K 官方规则，
 * 供提示词作为「参考材料」注入。检索库与 RPC 均已就绪，本文件只做调用，
 * 不执行任何 SQL、不写入任何数据。
 *
 * ─────────────────────────────────────────────────────────────
 * 检索参数（阈值与 Top-K）
 * ─────────────────────────────────────────────────────────────
 *   MATCH_THRESHOLD = 0.5  相似度下限（起始值）
 *   ISSUE_TOP_K     = 3    相似 Issue 条数
 *   RULE_TOP_K      = 2    官方规则条数
 *
 * 注：RPC match_rules() 的签名只有 (query_embedding, match_count) 两个参数，
 * 不含阈值参数，故规则侧不传阈值（详见 scripts/import_to_supabase.py 中的
 * 函数定义）。规则表仅 54 条，Top-2 已是相当窄的召回，无阈值亦无泄漏风险。
 *
 * ─────────────────────────────────────────────────────────────
 * 与入库保持一致（硬性）
 * ─────────────────────────────────────────────────────────────
 * query embedding 的模型、维度必须与 scripts/generate_embeddings.py 一致：
 * 同一 EMBEDDING_BASE_URL / EMBEDDING_MODEL_ID，且显式 dimensions = 1536
 * （模型默认 1024，不传则与 vector(1536) 不符，检索将无结果）。
 *
 * ─────────────────────────────────────────────────────────────
 * 失败降级（硬性）
 * ─────────────────────────────────────────────────────────────
 * embedding 失败、RPC 失败、配置缺失、整体超时——任何一步出问题都返回
 * 空参考材料，分诊继续走纯 LLM 路径，绝不抛错中断。
 * 检索是增强项，不是前置依赖：其可用性不得影响分诊接口的可用性。
 *
 * ─────────────────────────────────────────────────────────────
 * 防泄漏（硬性）
 * ─────────────────────────────────────────────────────────────
 * 只取 number / title 与 label_name / rule_text。
 * 绝不读取或注入 gt_topics / gt_severity——那等同于把标准答案喂给模型，
 * 会让评测指标失真。match_issues 已内置 in_eval_set = false 过滤。
 */

/** 与入库脚本 DIMENSIONS 一致，必须与 vector(1536) 相符 */
const EMBEDDING_DIMENSIONS = 1536;

/** 与 generate_embeddings.py 的 DEFAULT_MODEL_ID 一致 */
const DEFAULT_EMBEDDING_MODEL_ID = "text-embedding-v4";

/** 相似度下限（起始值，可按批次实测调整并在 CHANGELOG 登记） */
const MATCH_THRESHOLD = 0.5;

/** 相似 Issue 条数 */
const ISSUE_TOP_K = 3;

/** 官方规则条数 */
const RULE_TOP_K = 2;

export type RetrievedIssue = {
  number: number;
  title: string;
};

export type RetrievedRule = {
  labelName: string;
  ruleText: string;
};

export type RetrievalResult = {
  issues: RetrievedIssue[];
  rules: RetrievedRule[];
  /** false 表示降级：任一环节失败或超时，issues / rules 均为空数组 */
  ok: boolean;
  /** 降级原因，仅用于服务端日志与归因，不进入接口响应 */
  reason?: string;
};

/** 检索失败时的返回值：空参考材料，调用方无需特殊处理 */
const EMPTY_RESULT: RetrievalResult = { issues: [], rules: [], ok: false };

/**
 * 检索参考材料。
 *
 * @param options.title 缺陷标题
 * @param options.body  缺陷正文（调用处已按 INPUT_TRUNCATE_TOKENS 截断）
 */
export async function retrieveReference(options: {
  title: string;
  body: string;
}): Promise<RetrievalResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUTS.retrieval);

  // RPC 不接受 signal，故整体再包一层竞速守卫，保证检索阶段有硬上限
  const timeoutGuard = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(new Error(`检索超过 ${TIMEOUTS.retrieval} 毫秒`));
    });
  });

  const startedAt = Date.now();
  let stage = "init";

  try {
    const queryText = `${options.title}\n\n${options.body}`.trim();
    if (!queryText) {
      return { ...EMPTY_RESULT, reason: "检索输入为空" };
    }

    stage = "embedding";
    const embedding = await embedQuery(queryText, controller.signal);
    const client = getSupabaseServerClient();

    stage = "rpc";
    const [issueResponse, ruleResponse] = await Promise.race([
      Promise.all([
        client.rpc("match_issues", {
          query_embedding: embedding,
          match_threshold: MATCH_THRESHOLD,
          match_count: ISSUE_TOP_K,
        }),
        client.rpc("match_rules", {
          query_embedding: embedding,
          match_count: RULE_TOP_K,
        }),
      ]),
      timeoutGuard,
    ]);

    const rpcErrors = [
      issueResponse.error ? `match_issues：${issueResponse.error.message}` : null,
      ruleResponse.error ? `match_rules：${ruleResponse.error.message}` : null,
    ].filter((message): message is string => message !== null);

    if (rpcErrors.length > 0) {
      throw new Error(rpcErrors.join("；"));
    }

    const issues: RetrievedIssue[] = (issueResponse.data ?? []).flatMap((row: unknown) => {
      const record = row as { number?: unknown; title?: unknown } | null;
      if (!record || typeof record.number !== "number") return [];
      return [{ number: record.number, title: typeof record.title === "string" ? record.title : "" }];
    });

    const rules: RetrievedRule[] = (ruleResponse.data ?? []).flatMap((row: unknown) => {
      const record = row as { label_name?: unknown; rule_text?: unknown } | null;
      if (!record || typeof record.rule_text !== "string") return [];
      return [
        {
          labelName: typeof record.label_name === "string" ? record.label_name : "",
          ruleText: record.rule_text,
        },
      ];
    });

    console.log("[retrieval] 参考材料已取回", {
      threshold: MATCH_THRESHOLD,
      issueTopK: ISSUE_TOP_K,
      ruleTopK: RULE_TOP_K,
      elapsedMs: Date.now() - startedAt,
      issues: issues.map((issue) => `#${issue.number} ${issue.title}`),
      rules: rules.map((rule) => (rule.labelName ? `[${rule.labelName}] ${rule.ruleText}` : rule.ruleText)),
    });

    return { issues, rules, ok: true };
  } catch (error) {
    const reason = timedOut
      ? `检索超过 ${TIMEOUTS.retrieval} 毫秒`
      : error instanceof Error
        ? error.message
        : String(error);

    console.error("[retrieval] 检索失败，降级为纯 LLM 路径", {
      stage,
      elapsedMs: Date.now() - startedAt,
      reason,
    });
    return { ...EMPTY_RESULT, reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 生成 query embedding。
 *
 * 接口调用方式与 scripts/generate_embeddings.py 保持一致：
 * POST {EMBEDDING_BASE_URL}/embeddings，body 含 model / input / dimensions，
 * Authorization 走 Bearer {EMBEDDING_API_KEY}。
 */
async function embedQuery(text: string, signal: AbortSignal): Promise<number[]> {
  const apiKey = process.env.EMBEDDING_API_KEY?.trim();
  const baseUrl = process.env.EMBEDDING_BASE_URL?.trim()?.replace(/\/+$/, "");
  const modelId = process.env.EMBEDDING_MODEL_ID?.trim() || DEFAULT_EMBEDDING_MODEL_ID;

  if (!apiKey) throw new Error("EMBEDDING_API_KEY 未配置");
  if (!baseUrl) throw new Error("EMBEDDING_BASE_URL 未配置");

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      input: [text],
      dimensions: EMBEDDING_DIMENSIONS,
    }),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`embedding 接口返回 HTTP ${response.status} ${detail.slice(0, 200)}`);
  }

  const payload = (await response.json()) as {
    data?: { index?: number; embedding?: number[] }[];
  };
  const vector = payload.data?.[0]?.embedding;

  if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`embedding 维度 ${vector?.length ?? 0} != ${EMBEDDING_DIMENSIONS}`);
  }

  return vector;
}
