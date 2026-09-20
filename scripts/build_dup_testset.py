#!/usr/bin/env python3
"""
查重测试集构建脚本（PD-06 第 5 / 第 8 章配套）

背景：
  state_reason = duplicate 的样本不包含指向原单的编号
  （1500 条样本中有 51 条 duplicate，其中仅 4 条在 body 里提到 #编号）
  真正的重复关系记录在评论中，须逐条调 comments 接口提取。

用途：
  提取「重复单 D → 原单 O」的配对关系，产出查重测试集，用于计算 Recall@5。

关键约束（本轮新增）：
  对每一对检查 O 是否存在于**检索库**（issues 表中 in_eval_set = false 的行）。
  检索库 = 检索时唯一可被命中的集合；O 不在其中则该对永远不可能被召回，
  Recall@5 会被系统性拉低。这是数据构成问题，不是模型能力问题。

规模预期：
  目标 50 对，下限 30 对。若"原单在检索库内"的对数 < 30，
  须按 PD-06 第 8 节启用备用方法（本脚本会原样提示，不自行补足）。

数据源：
  优先 godot_issues_raw.json（由 fetch_godot_issues.py 产出）；
  不存在时改用 GitHub Search API 直接拉取
  `type:issue label:bug state:closed reason:duplicate`（实测 total_count ≈ 310）。

用法：
    python build_dup_testset.py
  环境变量（从 .env.local 读取）：GITHUB_TOKEN、DATABASE_URL
"""

import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import psycopg2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate_embeddings import load_env_local, db_url   # noqa: E402

# ============ 配置 ============
REPO = "godotengine/godot"
INPUT_JSON = "godot_issues_raw.json"   # 由 fetch_godot_issues.py 产出（可选）
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
OUT_CSV = os.path.join(OUT_DIR, "dup_testset.csv")            # 仅可用对
OUT_CSV_ALL = os.path.join(OUT_DIR, "dup_testset_all.csv")    # 全部对（含标记列）
TARGET_PAIRS = 50
MIN_PAIRS = 30
REQUEST_DELAY = 1.2                    # 请求间隔，避免触发二级限流
MAX_DUP_PAGES = 5                      # Search API 最多翻页数（100/页）

TOKEN = os.environ.get("GITHUB_TOKEN", "")

# 重复关系的措辞模式，按可靠性排序
STRONG_PATTERNS = [
    r"duplicate of\s*#(\d{4,6})",
    r"dupe of\s*#(\d{4,6})",
    r"closing in favor of\s*#(\d{4,6})",
    r"superseded by\s*#(\d{4,6})",
    r"already (?:reported|fixed) in\s*#(\d{4,6})",
    r"same (?:as|issue as)\s*#(\d{4,6})",
]
WEAK_PATTERNS = [
    r"see\s*#(\d{4,6})",
    r"related to\s*#(\d{4,6})",
    r"fixed by\s*#(\d{4,6})",
]
# 实测：Godot 维护者常用完整 URL 而非 #编号 指代原单，例如
#   "It seems like it may be a duplicate of one or both of these issues:
#    - https://github.com/godotengine/godot/issues/86970"
# 故在 # 形式之外补一组 URL 形式，否则这类表述会被判为"未找到指向"。
STRONG_URL_PATTERNS = [
    r"duplicate of\s*(?:https?://\S*?/issues/)(\d{4,7})",
    r"dupe of\s*(?:https?://\S*?/issues/)(\d{4,7})",
    r"closing in favor of\s*(?:https?://\S*?/issues/)(\d{4,7})",
    r"same (?:as|issue as)\s*(?:https?://\S*?/issues/)(\d{4,7})",
]

ISSUE_URL_RE = re.compile(r"github\.com/[\w.-]+/[\w.-]+/issues/(\d{4,7})")
NEGATIVE_RE = re.compile(
    r"not (?:a |an )?duplicate|isn'?t a duplicate|is not a duplicate", re.I)

STRONG_RE = re.compile("|".join(STRONG_PATTERNS), re.I)
WEAK_RE = re.compile("|".join(WEAK_PATTERNS), re.I)
STRONG_URL_RE = re.compile("|".join(STRONG_URL_PATTERNS), re.I)


def request_json(url: str):
    """带认证与限流退避的请求。返回 None 表示放弃该条。"""
    req = urllib.request.Request(url)
    req.add_header("Accept", "application/vnd.github+json")
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (403, 429):
                wait = 30 * (attempt + 1)
                print(f"    限流，等待 {wait}s")
                time.sleep(wait)
                continue
            if e.code == 404:
                return None
            raise
        except Exception as e:
            print(f"    请求异常（{e}），5s 后重试")
            time.sleep(5)
    return None


def fetch_duplicate_items() -> list:
    """Search API 直接拉取被标记为 duplicate 的 bug issue。"""
    q = f"repo:{REPO} type:issue label:bug state:closed reason:duplicate"
    items, seen = [], set()
    for page in range(1, MAX_DUP_PAGES + 1):
        url = (f"https://api.github.com/search/issues"
               f"?q={urllib.parse.quote(q)}&per_page=100&page={page}")
        data = request_json(url)
        if not data:
            break
        batch = data.get("items", [])
        for it in batch:
            if it["number"] not in seen:
                seen.add(it["number"])
                items.append(it)
        print(f"  p{page}: +{len(batch)} 条（total_count={data.get('total_count')}）")
        if len(batch) < 100:
            break
        time.sleep(2)
    return items


def load_retrieval_numbers() -> set:
    """检索库号码集合 = issues 表中 in_eval_set = false 的行（唯一可被召回的集合）。"""
    conn = psycopg2.connect(db_url())
    conn.set_session(readonly=True, autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute("select number from issues where in_eval_set = false;")
            nums = {n for (n,) in cur.fetchall()}
            cur.execute("select count(*) from issues where in_eval_set = true;")
            n_eval = cur.fetchone()[0]
    finally:
        conn.close()
    print(f"检索库（in_eval_set = false）：{len(nums)} 条；"
          f"评测集（in_eval_set = true）：{n_eval} 条")
    return nums


def fetch_titles(numbers: list) -> dict:
    """从检索库取标题（仅取库中存在的号码）。"""
    if not numbers:
        return {}
    conn = psycopg2.connect(db_url())
    conn.set_session(readonly=True, autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute("select number, title from issues where number = any(%s);",
                        (sorted(set(numbers)),))
            return {n: t for n, t in cur.fetchall()}
    finally:
        conn.close()


def extract_ref(comments: list) -> tuple:
    """
    从评论列表中提取原单编号。

    返回 (编号, 强度)：
      strong   #编号 形式的明确表述
      url      URL 形式的明确表述（原单以完整链接给出）
      weak     弱表述（see / related to / fixed by），需人工确认
      None     未找到
    优先级：strong > url > weak。含 "not a duplicate" 的评论不做 URL 兜底，
    避免把"不是重复单"的反例误判为重复对。
    """
    weak_hit = None
    for c in comments:
        body = c.get("body") or ""
        m = STRONG_RE.search(body)
        if m:
            return int(next(g for g in m.groups() if g)), "strong"
        m = STRONG_URL_RE.search(body)
        if m:
            return int(next(g for g in m.groups() if g)), "url"
        if weak_hit is None:
            m2 = WEAK_RE.search(body)
            if m2:
                weak_hit = int(next(g for g in m2.groups() if g))
        if (weak_hit is None and "duplicat" in body.lower()
                and not NEGATIVE_RE.search(body)):
            m3 = ISSUE_URL_RE.search(body)
            if m3:
                return int(m3.group(1)), "url"
    return (weak_hit, "weak") if weak_hit else (None, None)


def main():
    load_env_local()
    global TOKEN
    TOKEN = os.environ.get("GITHUB_TOKEN", "")
    if not TOKEN:
        print("⚠️  未设置 GITHUB_TOKEN。未认证限流 60 次/小时，很可能中途失败。\n")

    # ---- 数据源 ----
    items, source = [], ""
    if os.path.exists(INPUT_JSON):
        items = json.load(open(INPUT_JSON, encoding="utf-8"))
        if isinstance(items, dict):
            items = items.get("items", [])
        items = [it for it in items if it.get("state_reason") == "duplicate"]
        source = f"{INPUT_JSON}"
    else:
        print(f"未找到 {INPUT_JSON}，改用 GitHub Search API 拉取 duplicate 样本")
        items = fetch_duplicate_items()
        source = "GitHub Search API (reason:duplicate)"

    by_number = {it["number"]: it for it in items}
    dup_items = items
    print(f"数据源：{source}")
    print(f"state_reason = duplicate 的样本：{len(dup_items)} 条")
    print(f"开始提取重复关系（预计 {len(dup_items) * REQUEST_DELAY / 60:.1f} 分钟）\n")

    retrieval = load_retrieval_numbers()

    pairs, no_ref, self_ref, fetch_fail = [], [], [], []

    for i, it in enumerate(dup_items, 1):
        num = it["number"]
        url = (f"https://api.github.com/repos/{REPO}/issues/{num}"
               f"/comments?per_page=30")
        comments = request_json(url)
        if comments is None:
            fetch_fail.append(num)
            print(f"[{i}/{len(dup_items)}] #{num} 评论获取失败，跳过")
            time.sleep(REQUEST_DELAY)
            continue

        ref, strength = extract_ref(comments)
        if ref is None:
            no_ref.append(num)
            print(f"[{i}/{len(dup_items)}] #{num} 未找到原单指向")
        elif ref == num:
            self_ref.append(num)
            print(f"[{i}/{len(dup_items)}] #{num} 指向自身，忽略")
        else:
            pairs.append({
                "dup_number": num,
                "dup_title": it["title"],
                "target_number": ref,
                "target_title": by_number.get(ref, {}).get("title", ""),
                "strength": strength,
                "target_in_retrieval": ref in retrieval,
                "dup_in_retrieval": num in retrieval,
                "needs_manual_check": strength == "weak",
                "dup_url": it.get("html_url", ""),
            })
            flag = "" if ref in retrieval else "  （原单不在检索库内）"
            print(f"[{i}/{len(dup_items)}] #{num} → #{ref}  [{strength}]{flag}")

        time.sleep(REQUEST_DELAY)

    # 标题：库中存在的号码统一从库取，保证与检索库一致
    titles = fetch_titles([p[k] for p in pairs
                           for k in ("dup_number", "target_number")])
    for p in pairs:
        if p["dup_number"] in titles:
            p["dup_title"] = titles[p["dup_number"]]
        if p["target_number"] in titles:
            p["target_title"] = titles[p["target_number"]]

    fieldnames = ["dup_number", "dup_title", "target_number", "target_title",
                  "strength", "target_in_retrieval", "dup_in_retrieval",
                  "needs_manual_check", "dup_url"]

    usable = [p for p in pairs if p["target_in_retrieval"]]
    dropped = [p for p in pairs if not p["target_in_retrieval"]]
    usable_strong = [p for p in usable if p["strength"] in ("strong", "url")]
    self_hit_risk = [p for p in usable if p["dup_in_retrieval"]]

    if pairs:
        os.makedirs(OUT_DIR, exist_ok=True)
        with open(OUT_CSV_ALL, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames)
            w.writeheader()
            w.writerows(pairs)
        with open(OUT_CSV, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames)
            w.writeheader()
            w.writerows(usable)

    print("\n" + "=" * 60)
    print("提取结果")
    print("=" * 60)
    print(f"duplicate 样本总数            : {len(dup_items)}")
    print(f"评论获取失败                  : {len(fetch_fail)}")
    print(f"未找到原单指向                : {len(no_ref)}")
    print(f"指向自身（忽略）              : {len(self_ref)}")
    print(f"提取到的重复对总数            : {len(pairs)}")
    for s in ("strong", "url", "weak"):
        label = {"strong": "#编号 明确表述", "url": "URL 明确表述",
                 "weak": "弱表述（需人工确认）"}[s]
        print(f"  其中 {label:<20s}: "
              f"{len([p for p in pairs if p['strength'] == s])}")
    print(f"原单在检索库内（可用对）      : {len(usable)}  ← 测试集实际规模")
    print(f"  其中强表述                  : {len(usable_strong)}")
    print(f"  其中重复单自身也在检索库内   : {len(self_hit_risk)}  ← 检索会命中自身，需另行处理")
    print(f"原单不在检索库内（剔除）      : {len(dropped)}")

    if dropped:
        print("\n被剔除的对（原单不在检索库内，前 20 条）：")
        for p in dropped[:20]:
            print(f"    #{p['dup_number']} → #{p['target_number']}  [{p['strength']}]")
        print("  原因：检索库仅含 in_eval_set = false 的行，"
              "这些原单不在其中，检索永远无法命中，计入会拉低 Recall@5")

    print("\n" + "-" * 60)
    if len(usable) >= TARGET_PAIRS:
        print(f"达到目标规模（{TARGET_PAIRS} 对）：从 {len(usable)} 对中随机取 "
              f"{TARGET_PAIRS} 对即可")
    elif len(usable) >= MIN_PAIRS:
        print(f"达到下限（{MIN_PAIRS} 对）但未达目标（{TARGET_PAIRS} 对）")
        print(f"建议：全部 {len(usable)} 对采用，并在评测报告中注明实际规模")
    else:
        print(f"⚠️  可用对仅 {len(usable)} 对，低于下限 {MIN_PAIRS} 对")
        print("须按 PD-06 第 8 节启用备用方法：")
        print("  1. 对检索库两两计算相似度，取 > 0.85 的候选对")
        print("  2. 按相似度降序人工确认")
        print(f"  3. 补足至 {MIN_PAIRS} 对（预估 40 分钟）")

    print("\n" + "-" * 60)
    print(f"输出文件：{OUT_CSV}（仅原单在检索库内的 {len(usable)} 对，直接用于评测）")
    print(f"          {OUT_CSV_ALL}（全部 {len(pairs)} 对，含 target_in_retrieval 标记，供复核）")
    print("字段说明：")
    print("  target_in_retrieval  原单是否在检索库内（本轮新增，唯一决定是否可用）")
    print("  dup_in_retrieval     重复单自身是否也在检索库内（为 true 时检索会命中自身）")
    print("\n⚠️  实际对数须记入 PD-10 决策日志，评测报告中须说明测试集来源与规模。")


if __name__ == "__main__":
    main()
