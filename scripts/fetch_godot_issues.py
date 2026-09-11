#!/usr/bin/env python3
"""
Godot Issue 数据拉取脚本（W1 Day 2 用）

用途：按年份切片拉取 Godot 已关闭的 bug issue，绕开 Search API 1000 条上限。
输出：CSV（可直接用 Excel / 飞书表格打开）+ JSON（保留完整字段）

用法：
    # 1. 先申请 GitHub Personal Access Token（只需勾选 public_repo）
    #    https://github.com/settings/tokens
    # 2. 设置环境变量后运行
    export GITHUB_TOKEN=your_token_here        # Windows: set GITHUB_TOKEN=your_token_here
    python fetch_godot_issues.py

    # 换数据源做泛化验证时，改 REPO 和 LABEL_PREFIX 即可
"""

import csv
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

# ============ 可调参数 ============
REPO = "godotengine/godot"       # 泛化验证时可改为 bevyengine/bevy
YEARS = [2022, 2023, 2024, 2025, 2026]
PER_YEAR = 400                   # 每年拉多少条（100 的倍数最省请求）
QUERY_BASE = "type:issue label:bug state:closed"
LABEL_PREFIX = "topic:"          # Bevy 用 "A-"
OUT_DIR = "."
# =================================

TOKEN = os.environ.get("GITHUB_TOKEN", "")
API = "https://api.github.com/search/issues"

SEVERITY_LABELS = {
    "crash", "high priority", "performance", "regression",
    "usability", "confirmed", "needs testing", "needs work", "archived",
}


def request_json(url: str) -> dict:
    """带认证与限流退避的请求。"""
    req = urllib.request.Request(url)
    req.add_header("Accept", "application/vnd.github+json")
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")

    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=40) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # 403/429 = 限流，退避重试
            if e.code in (403, 429):
                wait = 20 * (attempt + 1)
                print(f"  限流，等待 {wait}s 后重试...")
                time.sleep(wait)
                continue
            raise
        except Exception as e:
            print(f"  请求失败（{e}），5s 后重试...")
            time.sleep(5)
    raise RuntimeError("重试多次仍失败，请检查 token 或网络")


def fetch_year(year: int) -> list:
    """拉取指定年份的 issue。Search API 单查询上限 1000，按年切片即可绕开。"""
    items = []
    pages = (PER_YEAR + 99) // 100
    for page in range(1, pages + 1):
        q = f"repo:{REPO} {QUERY_BASE} created:{year}-01-01..{year}-12-31"
        url = f"{API}?q={urllib.parse.quote(q)}&per_page=100&page={page}"
        data = request_json(url)
        batch = data.get("items", [])
        items.extend(batch)
        print(f"  {year} p{page}: +{len(batch)} 条（该年总量 {data.get('total_count', '?')}）")
        if len(batch) < 100:
            break
        time.sleep(2)  # 温和请求，避免触发二级限流
    return items


def split_labels(labels: list) -> tuple:
    names = [l["name"] for l in labels]
    topics = [n for n in names if n.startswith(LABEL_PREFIX)]
    plats = [n for n in names if n.startswith("platform:")]
    sev = [n for n in names if n in SEVERITY_LABELS]
    return names, topics, plats, sev


def main():
    if not TOKEN:
        print("⚠️  未检测到 GITHUB_TOKEN，未认证请求限流 60 次/小时，很可能中途失败。")
        print("   建议先申请：https://github.com/settings/tokens （只勾 public_repo）\n")

    all_items = []
    for year in YEARS:
        print(f"拉取 {year} ...")
        try:
            all_items.extend(fetch_year(year))
        except Exception as e:
            print(f"  {year} 拉取中断：{e}")
        time.sleep(2)

    # 按 issue 编号去重
    unique = {it["number"]: it for it in all_items}
    items = sorted(unique.values(), key=lambda x: x["number"])
    print(f"\n合计 {len(items)} 条（去重后）")

    json_path = os.path.join(OUT_DIR, "godot_issues_raw.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)

    csv_path = os.path.join(OUT_DIR, "godot_issues.csv")
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow([
            "number", "title", "topic_labels", "severity_labels", "platform_labels",
            "all_labels", "topic_count", "body", "comments", "reactions",
            "author_association", "created_at", "closed_at", "html_url",
        ])
        for it in items:
            names, topics, plats, sev = split_labels(it["labels"])
            body = (it.get("body") or "").replace("\r", " ").replace("\n", " ")
            w.writerow([
                it["number"], it["title"], "|".join(topics), "|".join(sev), "|".join(plats),
                "|".join(names), len(topics), body[:2000], it["comments"],
                it.get("reactions", {}).get("total_count", 0),
                it.get("author_association", ""),
                it["created_at"][:10], (it.get("closed_at") or "")[:10], it["html_url"],
            ])

    # 数据探查：这几个数字直接决定你的方案设计
    from collections import Counter
    topic_counter = Counter()
    multi = 0
    no_topic = 0
    short_body = 0
    for it in items:
        _, topics, _, _ = split_labels(it["labels"])
        topic_counter.update(topics)
        if len(topics) > 1:
            multi += 1
        if not topics:
            no_topic += 1
        if len(it.get("body") or "") < 200:
            short_body += 1

    print(f"\n输出：{csv_path}")
    print(f"      {json_path}")
    print("\n=== 数据探查（这几个数字决定你的方案设计）===")
    print(f"总条数            : {len(items)}")
    print(f"无 topic 标签      : {no_topic}  ← 这些不能用作评测集")
    print(f"多 topic 标签      : {multi}  ← 决定是多标签还是单标签任务")
    print(f"描述过短(<200字)   : {short_body}  ← 考虑是否单独处理")
    print(f"\n--- topic 分布（前 20）---")
    total_labeled = sum(topic_counter.values()) or 1
    for name, cnt in topic_counter.most_common(20):
        print(f"{cnt:5d}  {cnt / total_labeled * 100:5.1f}%  {name}")
    print("\n⚠️  注意最高频类别的占比。若超过 30%，必须做类别平衡采样，")
    print("   否则模型全猜它就能拿到虚高的准确率。评测请用 Macro-F1。")


if __name__ == "__main__":
    main()
