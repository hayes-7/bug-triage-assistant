#!/usr/bin/env python3
"""
建表 + 数据导入脚本（PD-06 第 7 节配套）

功能：
  1. 直连 Supabase（连接串从 .env.local 的 DATABASE_URL 读取，不硬编码、不打印）
  2. 查询 public schema 现有表，幂等建表 / 建索引 / 建检索函数
  3. 批量导入 data/retrieval_corpus.csv → issues，data/triage_rules.csv → triage_rules
  4. 导入后自验证（行数 / 防泄漏 / 索引 / 函数 / 抽样）

用法：
    python scripts/import_to_supabase.py
    python scripts/import_to_supabase.py --recompute-normalized  # 仅重算 normalized_text
    STRICT_NORM_ASSERT=1 python scripts/import_to_supabase.py   # 归一化断言不一致即中止
"""

import csv
import os
import re
import sys
from urllib.parse import urlparse

import psycopg2
from psycopg2.extras import execute_values

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_eval_set import net_text_length  # noqa: E402  （复用长度函数的判定逻辑）

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORPUS_CSV = os.path.join(ROOT, "data", "retrieval_corpus.csv")
RULES_CSV = os.path.join(ROOT, "data", "triage_rules.csv")

# 严格模式：len(normalize_text(body)) == net_text_len 断言不一致即中止（默认关闭并报告）
STRICT_NORM_ASSERT = os.environ.get("STRICT_NORM_ASSERT", "0") == "1"


# Godot Issue 模板标题（按名匹配，不依赖换行符）
TEMPLATE_HEADINGS = (
    r"Godot version|Tested versions|System information|Issue description|"
    r"Steps to reproduce|Minimal reproduction project(?:\s*\(MRP\))?"
)


def normalize_text(body: str) -> str:
    """
    归一化文本（适用于 CSV 中已被压平的 body：4200 行均不含换行符）

      a. 移除代码块（反引号不受压平影响）
      b. 移除图片引用
      c. 按名移除模板标题（不依赖 \\n）
      d. 移除残留的 Markdown 标题标记
      e. 合并空白并 strip
    """
    if not body:
        return ""
    t = re.sub(r"```[\s\S]*?```", "", body)
    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", t)
    t = re.sub(r"###\s*(?:%s)\s*" % TEMPLATE_HEADINGS, " ", t, flags=re.I)
    t = re.sub(r"#{1,6}\s*", " ", t)
    t = re.sub(r"\s{2,}", " ", t)
    return t.strip()


def load_database_url() -> str:
    """从 .env.local 解析 DATABASE_URL（不打印完整连接串）。"""
    env_path = os.path.join(ROOT, ".env.local")
    url = ""
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("DATABASE_URL="):
                url = line.split("=", 1)[1].strip()
    if not url:
        raise RuntimeError(".env.local 中未找到 DATABASE_URL")
    p = urlparse(url)
    print(f"连接目标：host={p.hostname} port={p.port} dbname={p.path.lstrip('/')}")
    return url


def split_labels(value: str) -> list:
    """'a|b|c' → ['a','b','c']；空串 → []"""
    return [x for x in (value or "").split("|") if x]


def to_bool(value: str) -> bool:
    return (value or "").strip().lower() in ("true", "1", "yes")


DDL_STATEMENTS = [
    "create extension if not exists vector;",
    """
    create table if not exists issues (
      number           integer primary key,
      title            text not null,
      body             text,
      normalized_text  text,
      gt_topics        text[],
      raw_labels       text[],
      gt_severity      text,
      net_text_len     integer,
      html_url         text not null,
      comments         integer,
      created_at       date,
      in_eval_set      boolean default false,
      eval_group       text,
      embedding        vector(1536)
    );
    """,
    "create index if not exists issues_embedding_idx "
    "on issues using hnsw (embedding vector_cosine_ops);",
    "create index if not exists issues_in_eval_set_idx on issues (in_eval_set);",
    """
    create table if not exists triage_rules (
      id          serial primary key,
      label_name  text,
      rule_text   text not null,
      source_url  text,
      embedding   vector(1536)
    );
    """,
    "create index if not exists triage_rules_embedding_idx "
    "on triage_rules using hnsw (embedding vector_cosine_ops);",
]

FUNCTION_STATEMENTS = [
    """
    create or replace function match_issues (
      query_embedding vector(1536),
      match_threshold float,
      match_count int
    )
    returns table (number integer, title text, html_url text, similarity float)
    language sql stable as $$
      select i.number, i.title, i.html_url,
             1 - (i.embedding <=> query_embedding) as similarity
      from issues i
      where i.in_eval_set = false
        and i.embedding is not null
        and 1 - (i.embedding <=> query_embedding) > match_threshold
      order by i.embedding <=> query_embedding
      limit match_count;
    $$;
    """,
    """
    create or replace function match_rules (
      query_embedding vector(1536),
      match_count int
    )
    returns table (id integer, label_name text, rule_text text, similarity float)
    language sql stable as $$
      select r.id, r.label_name, r.rule_text,
             1 - (r.embedding <=> query_embedding) as similarity
      from triage_rules r
      where r.embedding is not null
      order by r.embedding <=> query_embedding
      limit match_count;
    $$;
    """,
]


def show_existing_tables(cur):
    cur.execute("select table_name from information_schema.tables "
                "where table_schema='public' order by table_name;")
    rows = [r[0] for r in cur.fetchall()]
    print("public schema 现有表：", rows)
    return rows


def run_ddl(cur, existing):
    print("\n=== 建表（幂等）===")
    for stmt in DDL_STATEMENTS:
        label = stmt.strip().split("\n")[0][:70]
        try:
            cur.execute(stmt)
            print(f"  OK   {label}")
        except psycopg2.Error as e:
            print(f"  FAIL {label}")
            print(f"       code={e.pgcode} message={e.pgerror}")
            raise
    if "issues" in existing:
        print("  注：issues 表此前已存在，沿用现有表（未删除重建）")
    if "triage_rules" in existing:
        print("  注：triage_rules 表此前已存在，沿用现有表（未删除重建）")

    print("\n=== 检索函数 ===")
    for stmt in FUNCTION_STATEMENTS:
        label = stmt.strip().split("\n")[1].strip()[:70]
        cur.execute(stmt)
        print(f"  OK   {label}")


def load_issues():
    with open(CORPUS_CSV, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    data, mismatch = [], []
    for r in rows:
        body = r["body"] or ""
        norm = normalize_text(body)
        net = int(r["net_text_len"])
        if len(norm) != net:
            mismatch.append((r["number"], len(norm), net))
            if STRICT_NORM_ASSERT:
                print("\n[中止] 归一化断言失败："
                      f"number={r['number']} len(normalize_text)={len(norm)} "
                      f"net_text_len={net}")
                sys.exit(2)
        data.append((
            int(r["number"]),
            r["title"],
            body,
            norm,
            split_labels(r["gt_topics"]),
            split_labels(r["raw_labels"]),
            r["gt_severity"],
            net,
            r["html_url"],
            None,               # comments：CSV 无此列，留空
            r["created_at"],
            to_bool(r["in_eval_set"]),
            r["eval_group"],
            None,               # embedding：下一步单独处理
        ))
    print(f"\nread {CORPUS_CSV}: {len(data)} 行")
    print(f"归一化断言（len(normalize_text) == net_text_len）："
          f"一致 {len(data) - len(mismatch)} 行，不一致 {len(mismatch)} 行")
    if mismatch:
        print("  不一致示例（number, len(normalize_text), net_text_len）：")
        for m in mismatch[:5]:
            print(f"    {m[0]}, {m[1]}, {m[2]}")
    return data


def load_rules():
    with open(RULES_CSV, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    data = [(r["label_name"], r["rule_text"], r["source_url"], None)
            for r in rows]
    print(f"read {RULES_CSV}: {len(data)} 行")
    return data


def import_data_with_cursor(cur):
    issues = load_issues()
    rules = load_rules()
    execute_values(
        cur,
        """
        insert into issues (number, title, body, normalized_text, gt_topics,
                            raw_labels, gt_severity, net_text_len, html_url,
                            comments, created_at, in_eval_set, eval_group,
                            embedding)
        values %s
        on conflict (number) do update set
            title = excluded.title,
            body = excluded.body,
            normalized_text = excluded.normalized_text,
            gt_topics = excluded.gt_topics,
            raw_labels = excluded.raw_labels,
            gt_severity = excluded.gt_severity,
            net_text_len = excluded.net_text_len,
            html_url = excluded.html_url,
            comments = excluded.comments,
            created_at = excluded.created_at,
            in_eval_set = excluded.in_eval_set,
            eval_group = excluded.eval_group,
            embedding = excluded.embedding
        """,
        issues, page_size=500,
    )
    print(f"issues 写入：{len(issues)} 行")

    cur.execute("select count(*) from triage_rules;")
    existing_rules = cur.fetchone()[0]
    if existing_rules == 0:
        execute_values(
            cur,
            "insert into triage_rules (label_name, rule_text, source_url, "
            "embedding) values %s",
            rules, page_size=200,
        )
        print(f"triage_rules 写入：{len(rules)} 行")
    else:
        print(f"triage_rules 已有 {existing_rules} 行，跳过插入（避免重复）")


def verify(cur):
    print("\n=== 自验证 ===")
    queries = [
        ("1. issues 总行数（应 4200）",
         "select count(*) from issues;"),
        ("2. triage_rules 总行数（应 54）",
         "select count(*) from triage_rules;"),
        ("3. issues 中 in_eval_set = true 的行数（应为 0）",
         "select count(*) from issues where in_eval_set = true;"),
        ("4. issues 中 embedding 非空的行数（应为 0）",
         "select count(*) from issues where embedding is not null;"),
        ("5. issues 中 raw_labels 为空的行数（应为 0）",
         "select count(*) from issues where raw_labels is null "
         "or array_length(raw_labels, 1) is null;"),
        ("7a. pg_indexes 中 issues 的索引数",
         "select count(*) from pg_indexes where tablename = 'issues';"),
        ("7b. pg_indexes 中 triage_rules 的索引数",
         "select count(*) from pg_indexes where tablename = 'triage_rules';"),
        ("8. pg_proc 中的检索函数",
         "select proname from pg_proc where proname in "
         "('match_issues', 'match_rules') order by proname;"),
        ("扩展：vector 是否已启用",
         "select extname from pg_extension where extname = 'vector';"),
    ]
    for label, sql in queries:
        cur.execute(sql)
        print(f"{label}\n    → {cur.fetchall()}")

    print("6. 抽样 5 行（number, raw_labels, gt_topics, net_text_len, "
          "length(normalized_text)）")
    cur.execute("""
        select number, raw_labels, gt_topics, net_text_len,
               length(normalized_text)
        from issues order by number limit 5;
    """)
    for row in cur.fetchall():
        print(f"    {row[0]} | raw={row[1]} | gt={row[2]} | "
              f"net_text_len={row[3]} | len(normalized_text)={row[4]}")


def recompute_normalized(cur):
    """对已入库的 4200 行用新清洗函数重算 normalized_text（不重新导入）。"""
    cur.execute("select number, body from issues;")
    rows = cur.fetchall()
    values = [(num, normalize_text(body or "")) for num, body in rows]
    execute_values(
        cur,
        """
        update issues as i
           set normalized_text = v.norm
          from (values %s) as v(number, norm)
         where i.number = v.number
        """,
        values, page_size=500,
    )
    print(f"normalized_text 重算：{len(values)} 行")


def verify_normalized(cur):
    print("\n=== 重算后验证 ===")
    cur.execute("select count(*) from issues where normalized_text like '%###%';")
    print(f"normalized_text 含 '###' 的行数 → {cur.fetchall()}")

    cur.execute("""
        select
          percentile_cont(0.5) within group (
            order by abs(length(normalized_text) - net_text_len)::double precision),
          percentile_cont(0.9) within group (
            order by abs(length(normalized_text) - net_text_len)::double precision)
        from issues;
    """)
    print(f"|length(normalized_text) - net_text_len| 中位数 / 90 分位 → {cur.fetchall()}")

    cur.execute("""
        select number, length(normalized_text), normalized_text
        from issues
        where length(normalized_text) >= 200
        order by number limit 3;
    """)
    for num, ln, text in cur.fetchall():
        print(f"\n--- number={num} len={ln} ---\n{text}")


def main():
    url = load_database_url()
    conn = psycopg2.connect(url)
    try:
        if "--recompute-normalized" in sys.argv:
            with conn:                  # 单事务：失败整体回滚
                with conn.cursor() as cur:
                    recompute_normalized(cur)
            conn.commit()
            with conn.cursor() as cur:
                verify_normalized(cur)
            return
        with conn.cursor() as cur:
            existing = show_existing_tables(cur)
        with conn:                      # 事务：任一失败整体回滚
            with conn.cursor() as cur:
                run_ddl(cur, existing)
        with conn:
            with conn.cursor() as cur:
                import_data_with_cursor(cur)
        conn.commit()
        with conn.cursor() as cur:
            verify(cur)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
