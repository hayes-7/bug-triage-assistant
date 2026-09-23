import { TIMEOUTS } from "@/types/contract";

import { getSupabaseServerClient } from "./supabase";
import { RULE_CACHE_LOAD_TIMEOUT_MS } from "./triage/config";

/**
 * 检索层（模块二 · RAG）
 *
 * 职责：把当前缺陷报告变成向量，取回 Top-K 相似 Issue 与 Top-K 官方规则，
 * 供提示词作为「参考材料」注入，并为查重功能提供候选。
 *
 * ─────────────────────────────────────────────────────────────
 * 检索参数（阈值与 Top-K）
 * ─────────────────────────────────────────────────────────────
 *   MATCH_THRESHOLD = 0.5  相似度下限（起始值）
 *   ISSUE_TOP_K     = 3    注入提示词的相似 Issue 条数（v2.0 冻结值，不得变动）
 *   DUP_TOP_K       = 5    查重展示的候选条数（契约 duplicates 为 0–5 项）
 *   RULE_TOP_K      = 2    官方规则条数
 *
 * 注：RPC match_rules() 的签名只有 (query_embedding, match_count) 两个参数，
 * 不含阈值参数，故规则侧不传阈值（详见 scripts/import_to_supabase.py 中的
 * 函数定义）。规则表仅 54 条，Top-2 已是相当窄的召回，无阈值亦无泄漏风险。
 *
 * ─────────────────────────────────────────────────────────────
 * 注入内容与 v2.0 的一致性（硬性）
 * ─────────────────────────────────────────────────────────────
 * 注入提示词的参考材料 = issues（Top-3）+ rules（Top-2），与 v2.0 评测批次
 * 逐字一致。本文件后续的两项改造都刻意绕开了这一点：
 *
 *   1. match_issues 的 match_count 由 3 提到 5（= DUP_TOP_K），
 *      但注入提示词的仍是前 3 条。RPC 内部是
 *      `order by embedding <=> query_embedding limit match_count`，
 *      limit 5 的前 3 条与 limit 3 的 3 条同序同值，
 *      因此注入内容不变，第 4–5 条只用于查重展示，不进提示词。
 *   2. 规则侧改为「缓存规则向量 + 本地算余弦」替代每次 RPC，
 *      算法与 match_rules() 的 `1 - (embedding <=> q)` 同一口径，
 *      仍是向量检索取 Top-2，不是按类别名匹配。
 *
 * 即：v2.0 的检索行为在语义上完全一致，指标可继续与既有批次对比，
 * 不需要升 Prompt 版本。
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
 * 规则缓存不可用属「单路降级」：rules 为空但 issues 照常返回（见 rulesOk）。
 *
 * ─────────────────────────────────────────────────────────────
 * 防泄漏（硬性）
 * ─────────────────────────────────────────────────────────────
 * 只取 number / title / html_url / similarity 与 label_name / rule_text /
 * similarity。绝不读取或注入 gt_topics / gt_severity——那等同于把标准答案
 * 喂给模型，会让评测指标失真。match_issues 已内置 in_eval_set = false 过滤。
 *
 * 其中 html_url 与 similarity 只服务于查重展示（契约 DuplicateCandidate
 * 的 url / similarity 为必填），绝不进入提示词：
 * prompts/triage_v2_0.ts 的 formatReference() 只读 number / title，
 * 且接口响应的 references 由 lib/triage/schema.ts 按白名单拷贝，
 * 两道关卡都不会把 html_url 带出去。
 */

/** 与入库脚本 DIMENSIONS 一致，必须与 vector(1536) 相符 */
const EMBEDDING_DIMENSIONS = 1536;

/** 与 generate_embeddings.py 的 DEFAULT_MODEL_ID 一致 */
const DEFAULT_EMBEDDING_MODEL_ID = "text-embedding-v4";

/** 相似度下限（起始值，可按批次实测调整并在 CHANGELOG 登记） */
const MATCH_THRESHOLD = 0.5;

/** 注入提示词的相似 Issue 条数（v2.0 冻结值） */
const ISSUE_TOP_K = 3;

/** 查重候选条数，契约 duplicates 为 0–5 项 */
const DUP_TOP_K = 5;

/**
 * 实际传给 match_issues 的 match_count。
 * 取两个用途的较大值，一次 RPC 同时满足「注入前 3 条」与「查重前 5 条」，
 * 不额外增加一次往返（多一次往返会抬高超时降级概率）。
 */
const ISSUE_MATCH_COUNT = Math.max(ISSUE_TOP_K, DUP_TOP_K);

/** 官方规则条数 */
const RULE_TOP_K = 2;

export type RetrievedIssue = {
  number: number;
  title: string;
  /** 0–1，向量余弦相似度，来自 match_issues 的 similarity 列 */
  similarity?: number;
  /** 原始 Issue 链接，来自 issues.html_url。仅供查重展示，不进提示词 */
  htmlUrl?: string;
};

export type RetrievedRule = {
  labelName: string;
  ruleText: string;
  /** 0–1，向量余弦相似度，口径与 match_rules 的 similarity 列一致 */
  similarity?: number;
};

export type RetrievalResult = {
  /** 注入提示词的相似 Issue，Top-3，按相似度降序 */
  issues: RetrievedIssue[];
  /**
   * 查重候选，Top-5，按相似度降序，是 issues 的超集。
   * 供 app/api/triage/route.ts 填充契约的 duplicates 字段，不进提示词。
   */
  duplicateCandidates: RetrievedIssue[];
  /** 官方规则，Top-2，按相似度降序 */
  rules: RetrievedRule[];
  /** false 表示整体降级：embedding 或 match_issues 失败/超时，三个数组均为空 */
  ok: boolean;
  /** 整体降级原因，仅用于服务端日志与归因，不进入接口响应 */
  reason?: string;
  /** false 表示仅规则路径降级：rules 为空，但 issues 正常返回 */
  rulesOk: boolean;
  /** 规则路径降级原因，仅用于服务端日志与归因 */
  rulesReason?: string;
};

/** 检索失败时的返回值：空参考材料，调用方无需特殊处理 */
const EMPTY_RESULT: RetrievalResult = {
  issues: [],
  duplicateCandidates: [],
  rules: [],
  ok: false,
  rulesOk: false,
};

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
  const progress = { stage: "init" };

  try {
    const queryText = `${options.title}\n\n${options.body}`.trim();
    if (!queryText) {
      return { ...EMPTY_RESULT, reason: "检索输入为空" };
    }

    const result = await Promise.race([
      runRetrieval(queryText, controller.signal, progress),
      timeoutGuard,
    ]);

    console.log("[retrieval] 参考材料已取回", {
      threshold: MATCH_THRESHOLD,
      issueTopK: ISSUE_TOP_K,
      issueMatchCount: ISSUE_MATCH_COUNT,
      dupTopK: DUP_TOP_K,
      ruleTopK: RULE_TOP_K,
      ruleSource: "本地缓存（向量余弦，口径同 match_rules）",
      rulesOk: result.rulesOk,
      elapsedMs: Date.now() - startedAt,
      issues: result.issues.map(
        (issue) => `#${issue.number} sim=${formatSimilarity(issue.similarity)} ${issue.title}`,
      ),
      dupCandidates: result.duplicateCandidates.length,
      rules: result.rules.map(
        (rule) =>
          `[${rule.labelName}] sim=${formatSimilarity(rule.similarity)} ${rule.ruleText}`,
      ),
    });

    return result;
  } catch (error) {
    const reason = timedOut
      ? `检索超过 ${TIMEOUTS.retrieval} 毫秒`
      : error instanceof Error
        ? error.message
        : String(error);

    // 降级日志：stage 标明卡在哪一步，供 fallbackRate 与超时归因统计
    console.error("[retrieval] 检索失败，降级为纯 LLM 路径", {
      stage: progress.stage,
      timeoutMs: TIMEOUTS.retrieval,
      elapsedMs: Date.now() - startedAt,
      reason,
    });
    return { ...EMPTY_RESULT, reason, rulesReason: reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 检索主流程。
 *
 * embedding 与规则缓存装载相互独立，并行发起以压缩耗时；
 * 规则缓存失败只影响 rules（单路降级），不影响 issues。
 */
async function runRetrieval(
  queryText: string,
  signal: AbortSignal,
  progress: { stage: string },
): Promise<RetrievalResult> {
  progress.stage = "embedding";

  let rulesOk = true;
  let rulesReason: string | undefined;

  const [embedding, cachedRules] = await Promise.all([
    embedQuery(queryText, signal),
    // 注意不传 signal：装载是跨请求的共享操作，不绑单次请求的生命周期
    loadRuleCache().catch((error: unknown) => {
      rulesOk = false;
      rulesReason = error instanceof Error ? error.message : String(error);
      // 单路降级日志：规则不可用，但 issues 路径继续
      console.error("[retrieval] 规则缓存不可用，本次不注入官方规则", {
        reason: rulesReason,
      });
      return [] as CachedRule[];
    }),
  ]);

  const client = getSupabaseServerClient();

  progress.stage = "rpc";
  const issueResponse = await client.rpc("match_issues", {
    query_embedding: embedding,
    match_threshold: MATCH_THRESHOLD,
    match_count: ISSUE_MATCH_COUNT,
  });

  if (issueResponse.error) {
    throw new Error(`match_issues：${issueResponse.error.message}`);
  }

  progress.stage = "rules-scoring";
  const rules = selectTopRules(embedding, cachedRules, RULE_TOP_K);

  // RPC 已按距离升序返回，此处保持原序即为相似度降序，不重新排序
  const duplicateCandidates: RetrievedIssue[] = (issueResponse.data ?? []).flatMap(
    (row: unknown) => {
      const record = row as
        | { number?: unknown; title?: unknown; html_url?: unknown; similarity?: unknown }
        | null;
      if (!record || typeof record.number !== "number") return [];
      return [
        {
          number: record.number,
          title: typeof record.title === "string" ? record.title : "",
          // similarity 由 match_issues 的 returns table 提供；异常值不产出该键
          ...(isValidSimilarity(record.similarity)
            ? { similarity: clampSimilarity(record.similarity) }
            : {}),
          ...(typeof record.html_url === "string" && record.html_url.trim().length > 0
            ? { htmlUrl: record.html_url }
            : {}),
        },
      ];
    },
  );

  return {
    // 注入提示词的仍是 Top-3，与 v2.0 一致；第 4–5 条只用于查重
    issues: duplicateCandidates.slice(0, ISSUE_TOP_K),
    duplicateCandidates: duplicateCandidates.slice(0, DUP_TOP_K),
    rules,
    ok: true,
    rulesOk,
    rulesReason,
  };
}

// ============================================================
// 规则缓存
// ============================================================

/**
 * 缓存后的规则条目：含向量与其模长（模长预先算好，避免每次查询重复计算）。
 * 注意向量只驻留服务端内存，不进接口响应、不写日志。
 */
type CachedRule = {
  labelName: string;
  ruleText: string;
  embedding: number[];
  /** 向量模长 ‖v‖，用于余弦相似度分母 */
  norm: number;
};

/**
 * 规则缓存（进程内存）
 *
 * ── 为何缓存 ──
 * triage_rules 仅 54 条、内容静态（由 scripts/import_to_supabase.py 一次性导入，
 * 运行期无写入）。原实现每个请求都要为它多打一次 match_rules RPC，
 * 与 match_issues 并发争用同一条连接，是 3 秒超时的主要贡献者
 *（实测降级日志全部停在 stage: 'rpc'）。改为装载一次、之后本地算余弦，
 * 可完全去掉这一路网络往返。54 × 1536 维 float 约 300 KB，内存代价可忽略。
 *
 * ── 何时失效 ──
 * 无 TTL，生命周期 = Node 进程。进程重启（dev 热重启、重新部署、Serverless
 * 实例回收）即重新装载。因此改动 triage_rules 表后必须重启服务端才能生效；
 * 这与「规则是随 Prompt 版本一起冻结的静态资产」的定位一致，
 * 不给它加运行期热更新通道，避免评测中途换材料。
 * 装载失败不写入缓存，下一次请求会重试（见 loadRuleCache 的 finally）。
 *
 * ── 为何不绑外部请求的 AbortSignal ──
 * 装载是跨请求的共享操作：多个并发请求共用同一个装载 Promise。
 * 若把它绑在「第一个请求」的 signal 上，该请求一旦超时中止（5 秒硬上限），
 * 装载会被连带取消，同批次所有等待者一起拿到规则装载失败——
 * 一次偶发超时污染一整批请求。Serverless 冷启动时并发首请求是常态，
 * 该放大效应会变成常态故障。
 * 因此装载只受自己的 RULE_CACHE_LOAD_TIMEOUT_MS 约束；
 * 单次请求仍有 TIMEOUTS.retrieval 兜底，装载慢只会让那一次走规则单路降级
 *（rules 为空、issues 正常），不会拖长响应，也不会阻断后续请求建缓存。
 *
 * ── 是否影响评测归因 ──
 * 不影响。缓存只改变「规则从哪里取」，不改变「取哪几条」：
 * 仍是对同一批向量做余弦相似度排序取 Top-2，与 match_rules() 的
 * `order by embedding <=> q limit 2` 同一口径同一数据源，
 * 注入提示词的文本因此逐字不变，v2.0 既有批次指标仍可直接对比。
 * 唯一可观测差异：每个进程的首个请求多付一次全表装载耗时（实测约 0.3–1 秒），
 * 会让该条的 meta.latencyMs 偏高，属冷启动而非模型性能，
 * 统计 P95 时若样本量小需注意剔除首条。
 */
let ruleCache: CachedRule[] | null = null;

/** 装载中的 Promise：并发首请求共享同一次装载，避免重复拉全表 */
let ruleCacheLoader: Promise<CachedRule[]> | null = null;

async function loadRuleCache(): Promise<CachedRule[]> {
  if (ruleCache) return ruleCache;
  if (ruleCacheLoader) return ruleCacheLoader;

  const loader = (async () => {
    const startedAt = Date.now();
    const client = getSupabaseServerClient();

    // 与 match_rules 的数据源一致：triage_rules 全表，跳过 embedding 为空的行。
    // 只取 label_name / rule_text / embedding，不取 source_url 等无关列。
    // 超时用自己的独立预算，不接受调用方的 signal（理由见上方缓存说明）。
    const { data, error } = await client
      .from("triage_rules")
      .select("label_name, rule_text, embedding")
      .not("embedding", "is", null)
      .abortSignal(AbortSignal.timeout(RULE_CACHE_LOAD_TIMEOUT_MS));

    if (error) throw new Error(`triage_rules 装载失败：${error.message}`);

    const rules: CachedRule[] = (data ?? []).flatMap((row: unknown) => {
      const record = row as
        | { label_name?: unknown; rule_text?: unknown; embedding?: unknown }
        | null;
      if (!record || typeof record.rule_text !== "string") return [];

      const embedding = parseEmbedding(record.embedding);
      if (!embedding) return [];

      return [
        {
          labelName: typeof record.label_name === "string" ? record.label_name : "",
          ruleText: record.rule_text,
          embedding,
          norm: Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0)),
        },
      ];
    });

    if (rules.length === 0) {
      throw new Error("triage_rules 无可用向量（0 条）");
    }

    console.log("[retrieval] 规则缓存已装载", {
      count: rules.length,
      dimensions: EMBEDDING_DIMENSIONS,
      elapsedMs: Date.now() - startedAt,
      note: "进程级缓存，无 TTL，重启后重新装载",
    });

    ruleCache = rules;
    return rules;
  })();

  ruleCacheLoader = loader;

  try {
    return await loader;
  } finally {
    /**
     * 装载失败时清空 loader，使下次请求重新发起装载（缓存未写入，行为不变）。
     * 只在仍指向本次 loader 时清空：并发等待者各自都会走到这里，
     * 若无条件赋 null，可能把后来者新建的 loader 误清掉。
     */
    if (ruleCacheLoader === loader) ruleCacheLoader = null;
  }
}

/**
 * 本地选出 Top-K 规则。
 *
 * 口径与 match_rules() 完全一致：
 *   SQL   1 - (embedding <=> query_embedding)  → pgvector 的余弦距离取补
 *   本地  dot(a,b) / (‖a‖·‖b‖)                 → 同一个余弦相似度
 * 排序方向同为相似度降序（= 距离升序），取前 K 条，无阈值（match_rules 无阈值参数）。
 */
function selectTopRules(
  queryEmbedding: number[],
  cachedRules: CachedRule[],
  topK: number,
): RetrievedRule[] {
  if (cachedRules.length === 0) return [];

  const queryNorm = Math.sqrt(
    queryEmbedding.reduce((sum, value) => sum + value * value, 0),
  );
  if (queryNorm === 0) return [];

  return cachedRules
    .map((rule) => ({
      labelName: rule.labelName,
      ruleText: rule.ruleText,
      similarity: clampSimilarity(
        dotProduct(queryEmbedding, rule.embedding) / (queryNorm * rule.norm),
      ),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let index = 0; index < a.length; index++) {
    sum += a[index] * b[index];
  }
  return sum;
}

/**
 * 解析 vector(1536) 列。
 * PostgREST 把 pgvector 序列化为 "[0.1,0.2,…]" 文本（恰好是合法 JSON），
 * 少数客户端版本会直接给出数组，两种形态都兼容。
 */
function parseEmbedding(raw: unknown): number[] | null {
  let values: unknown = raw;

  if (typeof raw === "string") {
    try {
      values = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS) return null;
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return null;
  }

  return values as number[];
}

// ============================================================
// 相似度工具
// ============================================================

function isValidSimilarity(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 余弦相似度理论区间为 [-1, 1]，契约要求 0–1，负值夹为 0 */
function clampSimilarity(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function formatSimilarity(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(4);
}

// ============================================================
// Embedding
// ============================================================

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
