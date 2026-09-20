#!/usr/bin/env python3
"""
检索冒烟测试（PD-06 / 模块二配套）

验证三件事：
  ① 检索链路可用（match_rules / match_issues 能返回结果）
  ② HNSW 向量索引正常工作（explain 中应出现 Index Scan using *_embedding_idx）
  ③ 防数据泄漏生效（评测集样本不应被检索到自身，且其 number 不在 issues 表中）

用法：
    python scripts/smoke_retrieval_test.py            # 默认 5 条，seed=42
    python scripts/smoke_retrieval_test.py 10 7       # 指定条数与随机种子

说明：
  - 只读：不写入任何数据、不修改表；
  - threshold 固定传 0.0，仅用于观察完整相似度分布，非生产配置；
  - query embedding 复用 generate_embeddings 的同一模型与 dimensions=1536。
"""

import csv
import os
import random
import statistics
import sys

import psycopg2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate_embeddings import (     # noqa: E402
    DIMENSIONS, embed_batch, load_env_local, read_embedding_config, db_url,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVAL_CSV = os.path.join(ROOT, "data", "eval_set_main.csv")
SAMPLE_N = 5
SEED = 42
TOP_K = 5
THRESHOLD = 0.0      # 仅用于观察分布；生产阈值待定


def vec_literal(vec) -> str:
    return "[" + ",".join(f"{x:.7f}" for x in vec) + "]"


def sample_rows(n: int, seed: int) -> list:
    with open(EVAL_CSV, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    rng = random.Random(seed)
    picked = rng.sample(rows, min(n, len(rows)))
    print(f"评测集总行数：{len(rows)}，随机种子：{seed}，抽取 {len(picked)} 条\n")
    return picked


def main():
    sample_n = int(sys.argv[1]) if len(sys.argv) > 1 else SAMPLE_N
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else SEED

    load_env_local()
    api_key, base_url, model_id = read_embedding_config()
    print(f"模型：{model_id}  维度：{DIMENSIONS}  端点：{base_url}")

    rows = sample_rows(sample_n, seed)

    conn = psycopg2.connect(db_url())
    conn.set_session(readonly=True, autocommit=True)
    issue_sims, rule_sims = [], []
    leak_hits = []
    shown_plan = False

    try:
        with conn.cursor() as cur:
            for idx, row in enumerate(rows, start=1):
                number = int(row["number"])
                title = row["title"] or ""
                body = row["body"] or ""
                query_text = f"{title}\n\n{body}".strip()
                (vec,), _ = embed_batch([query_text])
                vl = vec_literal(vec)

                # 样本自身是否已在检索库中（预期不存在）
                cur.execute("select count(*) from issues where number = %s;",
                            (number,))
                self_in_db = cur.fetchone()[0]

                cur.execute("select * from match_rules(%s::vector, %s);",
                            (vl, TOP_K))
                rules = cur.fetchall()
                cur.execute("select * from match_issues(%s::vector, %s, %s);",
                            (vl, THRESHOLD, TOP_K))
                issues = cur.fetchall()

                print("=" * 78)
                print(f"[{idx}] number={number}  （该 number 是否存在于 issues 表："
                      f"{self_in_db}，预期 0）")
                print(f"    title：{title[:80]}")
                print(f"    query 文本长度：{len(query_text)} 字符")

                print(f"  -- match_rules Top-{TOP_K} --")
                if not rules:
                    print("    （空结果）")
                for rid, label, text, sim in rules:
                    rule_sims.append(sim)
                    print(f"    id={rid:<3} sim={sim:.4f}  label={label}")
                    print(f"        {text[:60]}")

                print(f"  -- match_issues Top-{TOP_K}（threshold={THRESHOLD}）--")
                if not issues:
                    print("    （空结果）")
                for num, t, _url, sim in issues:
                    issue_sims.append(sim)
                    flag = "  <<< 命中自身，数据泄漏" if num == number else ""
                    print(f"    number={num:<6} sim={sim:.4f}  {t[:60]}{flag}")
                    if num == number:
                        leak_hits.append((number, num, sim))
                hit_nums = [num for num, _t, _u, _s in issues]
                verdict = ("含自身" if number in hit_nums
                           else "Top-5 中不含自身")
                print(f"  >> 防泄漏逐条确认：#{number} → {verdict}"
                      f"（Top-5 number：{hit_nums}）")

                if not shown_plan:
                    shown_plan = True
                    cur.execute("""
                        explain (analyze, costs off)
                        select i.number, i.title,
                               1 - (i.embedding <=> %s::vector) as similarity
                          from issues i
                         where i.in_eval_set = false
                           and i.embedding is not null
                         order by i.embedding <=> %s::vector
                         limit %s;
                    """, (vl, vl, TOP_K))
                    print("\n  -- 执行计划（验证 HNSW 索引是否被使用）--")
                    for (line,) in cur.fetchall():
                        print(f"    {line[:160]}")   # 计划行含完整向量字面量，截断显示
    finally:
        conn.close()

    print("\n" + "=" * 78)
    print("=== 防泄漏检查 ===")
    print(f"Top-{TOP_K} 中命中自身的条数：{len(leak_hits)}（预期 0）")
    for n, hit, sim in leak_hits:
        print(f"    number={n} 命中自身 {hit}，sim={sim:.4f}")

    print("\n=== issue 相似度分布（5 条 × Top-5）===")
    if issue_sims:
        print(f"样本数：{len(issue_sims)}")
        print(f"最小值：{min(issue_sims):.4f}")
        print(f"中位数：{statistics.median(issue_sims):.4f}")
        print(f"最大值：{max(issue_sims):.4f}")
        print(f"均值：{statistics.fmean(issue_sims):.4f}")
        print("全部取值（升序）：" +
              ", ".join(f"{s:.4f}" for s in sorted(issue_sims)))
    else:
        print("无相似度数据（match_issues 全部返回空结果）")

    print("\n=== 规则相似度分布（5 条 × Top-5，参考）===")
    if rule_sims:
        print(f"样本数：{len(rule_sims)}  最小值：{min(rule_sims):.4f}  "
              f"中位数：{statistics.median(rule_sims):.4f}  "
              f"最大值：{max(rule_sims):.4f}")
    else:
        print("无相似度数据")


if __name__ == "__main__":
    main()
