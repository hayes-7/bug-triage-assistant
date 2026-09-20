#!/usr/bin/env python3
"""
检索库向量化脚本（PD-06 / 模块二配套）

范围（严格限定）：
  - issues：仅 in_eval_set = false 的行，字段源 normalized_text
  - triage_rules：全部行，字段源 rule_text
  - 评测集行（in_eval_set = true）不生成向量，检索时须被排除

模型：阿里云百炼 text-embedding-v4，显式 dimensions=1536（默认 1024，不传则与 vector(1536) 不符）

环境变量（请求处理时读取，不模块级缓存）：
  EMBEDDING_API_KEY    必填
  EMBEDDING_BASE_URL   必填，百炼 OpenAI 兼容端点
  EMBEDDING_MODEL_ID   可选，缺省 text-embedding-v4

用法：
    python scripts/generate_embeddings.py --estimate   # 仅估算规模与成本，不调用 API
    python scripts/generate_embeddings.py              # 生成并写入
    python scripts/generate_embeddings.py --only-missing   # 跳过已有向量的行（默认开启）
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

import psycopg2
from psycopg2.extras import execute_values

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BATCH_SIZE = 10          # 百炼 embedding 接口单次 input 上限 10 条
MAX_ATTEMPTS = 2         # 首次调用 + 1 次重试
DIMENSIONS = 1536        # 必须与表结构 vector(1536) 一致（模型默认 1024）
DEFAULT_MODEL_ID = "text-embedding-v4"
PRICE_PER_1K_TOKENS = 0.0005   # 元 / 千 token（百炼 text-embedding-v4 参考单价）
CHARS_PER_TOKEN = 4.0          # 估算用：英文约 4 字符 / token


def load_env_local() -> None:
    """把 .env.local 的键值载入 os.environ（仅补全未设置的项）。"""
    path = os.path.join(ROOT, ".env.local")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


def read_embedding_config() -> tuple:
    """每次请求前读取，不使用模块级缓存（便于运行时切换模型/厂商）。"""
    api_key = os.environ.get("EMBEDDING_API_KEY", "").strip()
    base_url = os.environ.get("EMBEDDING_BASE_URL", "").strip()
    model_id = os.environ.get("EMBEDDING_MODEL_ID", "").strip() or DEFAULT_MODEL_ID
    if not api_key:
        raise RuntimeError("EMBEDDING_API_KEY 未配置")
    if not base_url:
        raise RuntimeError("EMBEDDING_BASE_URL 未配置")
    return api_key, base_url.rstrip("/"), model_id


def db_url() -> str:
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        raise RuntimeError("DATABASE_URL 未配置")
    return url


def fetch_scope(cur, only_missing: bool) -> tuple:
    """读取待向量化的文本：issues（仅 in_eval_set=false）+ triage_rules。"""
    miss_issue = "and embedding is null" if only_missing else ""
    cur.execute(f"""
        select number, normalized_text from issues
        where in_eval_set = false {miss_issue}
        order by number;
    """)
    issues = [(n, t or "") for n, t in cur.fetchall()]

    miss_rule = "where embedding is null" if only_missing else ""
    cur.execute(f"select id, rule_text from triage_rules {miss_rule} order by id;")
    rules = [(i, t or "") for i, t in cur.fetchall()]
    return issues, rules


def is_recoverable(error: Exception) -> bool:
    """
    重试分类（沿用 lib/triage/model.ts 的判定口径）：
      可重试：408 / 429 / 5xx、超时、网络层失败
      不重试：401 / 403 鉴权失败、其它配置错误、无法归类者
    """
    if isinstance(error, urllib.error.HTTPError):
        return error.code == 408 or error.code == 429 or error.code >= 500
    if isinstance(error, urllib.error.URLError):
        return True
    return isinstance(error, TimeoutError)


class EmbeddingAuthError(Exception):
    """鉴权/配置失败：不重试，且中止整轮生成（重试无意义）。"""


def embed_batch(texts: list) -> tuple:
    """调用 /embeddings，返回 (vectors, tokens)；鉴权/配置错误不重试。"""
    api_key, base_url, model_id = read_embedding_config()
    payload = json.dumps({
        "model": model_id,
        "input": texts,
        "dimensions": DIMENSIONS,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}/embeddings",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    last_error = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            items = sorted(data["data"], key=lambda x: x["index"])
            vectors = [it["embedding"] for it in items]
            if len(vectors) != len(texts):
                raise RuntimeError(
                    f"返回向量数 {len(vectors)} != 输入条数 {len(texts)}")
            if len(vectors[0]) != DIMENSIONS:
                raise RuntimeError(
                    f"返回维度 {len(vectors[0])} != {DIMENSIONS}")
            return vectors, data.get("usage", {}).get("total_tokens", 0)
        except Exception as e:                       # noqa: BLE001
            last_error = e
            msg = getattr(e, "read", None)
            detail = ""
            if callable(msg):
                try:
                    detail = msg().decode("utf-8", "ignore")[:200]
                except Exception:                    # noqa: BLE001
                    detail = ""
            print(f"    批次失败（attempt {attempt + 1}）：{e} {detail}", flush=True)
            if isinstance(e, urllib.error.HTTPError) and e.code in (401, 403):
                # 鉴权失败不再重试，且直接中止整轮（否则会白白跑完剩余批次）
                raise EmbeddingAuthError(f"HTTP {e.code}：{detail}") from e
            if not is_recoverable(e):
                break
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"批次重试后仍失败：{last_error}")


def write_vectors(cur, table: str, key_col: str, rows: list) -> None:
    """rows: [(key, vector)] → 批量 UPDATE（vector 以文本数组形式转换）。"""
    values = [(k, "[" + ",".join(f"{x:.7f}" for x in vec) + "]") for k, vec in rows]
    execute_values(
        cur,
        f"""
        update {table} as t
           set embedding = v.vec::vector
          from (values %s) as v(key, vec)
         where t.{key_col} = v.key
        """,
        values, page_size=200,
    )


def run_table(cur, table: str, key_col: str, rows: list, stats: dict) -> None:
    label = f"{table}({len(rows)})"
    done, failed, tokens = 0, 0, 0
    pending = []
    for idx, (key, text) in enumerate(rows, start=1):
        pending.append((key, text))
        if len(pending) < BATCH_SIZE and idx != len(rows):
            continue
        keys = [k for k, _ in pending]
        texts = [t or " " for _, t in pending]
        try:
            vectors, used = embed_batch(texts)
            write_vectors(cur, table, key_col, list(zip(keys, vectors)))
            done += len(keys)
            tokens += used
        except EmbeddingAuthError:
            raise
        except Exception as e:                       # noqa: BLE001
            failed += len(keys)
            print(f"  [跳过批次] {label} 首个 number/id={keys[0]}：{e}", flush=True)
        if done and done % 500 == 0:
            print(f"  {label} 进度：{done}/{len(rows)}", flush=True)
        pending = []

    stats["done"] += done
    stats["failed"] += failed
    stats["tokens"] += tokens
    print(f"  {label} 完成：成功 {done}，失败 {failed}，token {tokens}", flush=True)


def estimate() -> None:
    conn = psycopg2.connect(db_url())
    try:
        with conn.cursor() as cur:
            cur.execute("""
                select count(*), coalesce(sum(length(normalized_text)), 0)
                from issues where in_eval_set = false;
            """)
            n_issue, chars_issue = cur.fetchone()
            cur.execute("select count(*) from issues where in_eval_set = true;")
            n_eval = cur.fetchone()[0]
            cur.execute("""
                select count(*), coalesce(sum(length(rule_text)), 0)
                from triage_rules;
            """)
            n_rule, chars_rule = cur.fetchone()
    finally:
        conn.close()

    chars = chars_issue + chars_rule
    tokens = chars / CHARS_PER_TOKEN
    cost = tokens / 1000 * PRICE_PER_1K_TOKENS
    print("=== 规模估算（不调用 API）===")
    print(f"issues 待向量化（in_eval_set = false）：{n_issue} 行，"
          f"{chars_issue} 字符")
    print(f"triage_rules 待向量化：{n_rule} 行，{chars_rule} 字符")
    print(f"评测集行（in_eval_set = true，不向量化）：{n_eval} 行")
    print(f"合计：{n_issue + n_rule} 条，{chars} 字符")
    print(f"估算 token（按 {CHARS_PER_TOKEN:g} 字符/token）：约 {tokens:,.0f}")
    print(f"估算费用（{PRICE_PER_1K_TOKENS} 元/千 token）：约 {cost:.2f} 元")


def status() -> None:
    """查看向量化进度与泄漏情况（不调用 API）。"""
    conn = psycopg2.connect(db_url())
    try:
        with conn.cursor() as cur:
            cur.execute("select count(*) from issues where embedding is not null;")
            n_issue_vec = cur.fetchone()[0]
            cur.execute("select count(*) from issues "
                        "where in_eval_set = true and embedding is not null;")
            n_leak = cur.fetchone()[0]
            cur.execute("select count(*) from triage_rules "
                        "where embedding is not null;")
            n_rule_vec = cur.fetchone()[0]
            cur.execute("select distinct vector_dims(embedding) from issues "
                        "where embedding is not null;")
            dims = [r[0] for r in cur.fetchall()]
    finally:
        conn.close()
    print("=== 向量入库状态 ===")
    print(f"issues 中 embedding 非空：{n_issue_vec} 行")
    print(f"in_eval_set = true 却有向量：{n_leak} 行（应为 0）")
    print(f"triage_rules 中 embedding 非空：{n_rule_vec} 行")
    print(f"向量维度：{dims}")


def main():
    load_env_local()
    if "--estimate" in sys.argv:
        estimate()
        return
    if "--status" in sys.argv:
        status()
        return

    only_missing = "--only-missing" in sys.argv or True
    read_embedding_config()          # 先校验配置，避免跑一半才发现缺 Key
    conn = psycopg2.connect(db_url())
    started = time.time()
    stats = {"done": 0, "failed": 0, "tokens": 0}
    try:
        with conn.cursor() as cur:
            issues, rules = fetch_scope(cur, only_missing)
        print(f"待处理：issues {len(issues)} 行，triage_rules {len(rules)} 行",
              flush=True)
        with conn:
            with conn.cursor() as cur:
                run_table(cur, "issues", "number", issues, stats)
                run_table(cur, "triage_rules", "id", rules, stats)
        conn.commit()

        with conn.cursor() as cur:
            cur.execute("select count(*) from issues where embedding is not null;")
            n_issue_vec = cur.fetchone()[0]
            cur.execute("select count(*) from issues "
                        "where in_eval_set = true and embedding is not null;")
            n_leak = cur.fetchone()[0]
            cur.execute("select count(*) from triage_rules "
                        "where embedding is not null;")
            n_rule_vec = cur.fetchone()[0]
            cur.execute("select vector_dims(embedding) from issues "
                        "where embedding is not null limit 1;")
            dims = cur.fetchone()
    finally:
        conn.close()

    elapsed = time.time() - started
    print("\n=== 统计 ===")
    print(f"成功条数：{stats['done']}")
    print(f"失败条数：{stats['failed']}")
    print(f"总 token：{stats['tokens']}")
    print(f"总耗时：{elapsed:.1f} 秒")
    print("\n=== 入库确认 ===")
    print(f"issues 中 embedding 非空：{n_issue_vec} 行")
    print(f"in_eval_set = true 却有向量：{n_leak} 行（应为 0）")
    print(f"triage_rules 中 embedding 非空：{n_rule_vec} 行")
    print(f"向量维度：{dims}")


if __name__ == "__main__":
    main()
