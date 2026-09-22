import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase 客户端（服务端专用）
 *
 * 用途：模块二（检索增强）的向量检索，读 issues / triage_rules 两表，
 * 调用 RPC match_issues() 与 match_rules()。
 *
 * ─────────────────────────────────────────────────────────────
 * 安全约束（硬性）
 * ─────────────────────────────────────────────────────────────
 * 本客户端使用 SUPABASE_SERVICE_ROLE_KEY，该 Key 绕过 RLS，可读全表。
 * 因此：
 *   - 只能被服务端代码 import（app/api/**、lib/** 的服务端路径）；
 *   - 不得被任何 "use client" 组件、浏览器可达模块或直接 import；
 *   - 不得作为返回值、不得写入日志、不得进入接口响应。
 * 环境变量 SUPABASE_SERVICE_ROLE_KEY 未加 NEXT_PUBLIC_ 前缀，
 * Next.js 不会将其内联进客户端 bundle，这是本约束的第一道保障。
 *
 * 环境变量（均在调用时读取，不在模块加载时读取，便于运行时切换）：
 *   NEXT_PUBLIC_SUPABASE_URL    必填，项目 URL
 *   SUPABASE_SERVICE_ROLE_KEY   必填，service role 密钥
 */

export class MissingSupabaseConfigError extends Error {
  constructor() {
    super("环境变量 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY 未配置");
    this.name = "MissingSupabaseConfigError";
  }
}

/**
 * 按 URL + Key 缓存客户端实例，避免每个请求重建连接。
 * Key 变化时重建（例如 .env.local 改动后重启前的热重载）。
 */
let cached: { key: string; client: SupabaseClient } | null = null;

/**
 * 取得服务端 Supabase 客户端。
 *
 * 配置缺失时抛 MissingSupabaseConfigError：调用方（lib/retrieval.ts）
 * 须捕获并降级为空参考材料，不得让错误传播到分诊主流程。
 */
export function getSupabaseServerClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";

  if (!url || !serviceRoleKey) {
    throw new MissingSupabaseConfigError();
  }

  const cacheKey = `${url}|${serviceRoleKey}`;
  if (cached && cached.key === cacheKey) {
    return cached.client;
  }

  const client = createClient(url, serviceRoleKey, {
    // 本客户端只做无状态 RPC 调用，不承载用户会话
    auth: { persistSession: false, autoRefreshToken: false },
  });

  cached = { key: cacheKey, client };
  return client;
}
