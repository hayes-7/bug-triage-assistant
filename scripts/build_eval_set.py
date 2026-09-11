#!/usr/bin/env python3
"""
评测集构建脚本（PD-05 / PD-06 配套）

用途：从原始数据中构建三个集合
  1. 主评测集      280 条（净文本 >= 200 字符，分层抽样）
  2. 对抗测试集     20 条（净文本 <  200 字符）
  3. 检索库        其余全部（已排除上述评测集，防数据泄漏）

关键设计：
  - 净文本长度：去除 Markdown 模板、代码块、图片后的实际信息量
    原方案以 body 长度筛选，实测筛出 0 条（Godot 有 Issue 模板，最短 274 字符）
  - in_eval_set 标记：评测集样本必须从检索库中排除，否则查重会命中自身

用法：
    export GITHUB_TOKEN=your_token
    python build_eval_set.py
"""

import csv
import json
import os
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

# ============ 配置 ============
REPO = "godotengine/godot"
YEARS = [2022, 2023, 2024, 2025, 2026]
PER_YEAR = 900  # 每年拉取量，用于构建 4000 条检索库
NET_TEXT_THRESHOLD = 200  # 净文本长度分界（PD-05 第 2.1 节）
RANDOM_SEED = 42  # 固定随机种子，保证抽样可复现
OUT_DIR = "."

# PD-02 定义的 10 个具体类别
KEEP_TOPICS = [
    "editor", "rendering", "gui", "gdscript", "core",
    "platforms", "animation", "buildsystem", "import", "input",
]
# 维度修饰词，移出候选（PD-02 第 3.2 节）
MODIFIER_TOPICS = {"2d", "3d"}

# 分层抽样目标（PD-05 第 3.2 节）
SAMPLE_TARGET = {
    "editor": 45, "rendering": 35, "gui": 30,
    "gdscript": 25, "core": 25, "platforms": 25,
    "animation": 20, "buildsystem": 20, "import": 20,
    "input": 15, "other": 20,
}
ADVERSARIAL_TARGET = 20

# 严重度映射（PD-02 第 5.4 节，按优先级排他匹配）
SEVERITY_PRIORITY = [
    ("crash", "crash"),
    ("regression", "high"),
    ("performance", "normal"),
    ("usability", "normal"),
]

TOKEN = os.environ.get("GITHUB_TOKEN", "")
API = "https://api.github.com/search/issues"


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
            if e.code in (403, 429):
                wait = 20 * (attempt + 1)
                print(f"    限流，等待 {wait}s")
                time.sleep(wait)
                continue
            raise
        except Exception as e:
            print(f"    请求失败（{e}），5s 后重试")
            time.sleep(5)
    raise RuntimeError("重试多次仍失败")


def fetch_all() -> list:
    """按年份切片拉取，绕开 Search API 1000 条上限。"""
    store = {}
    for year in YEARS:
        print(f"拉取 {year} ...")
        pages = (PER_YEAR + 99) // 100
        for page in range(1, pages + 1):
            q = (f"repo:{REPO} type:issue label:bug state:closed "
                 f"created:{year}-01-01..{year}-12-31")
            url = f"{API}?q={urllib.parse.quote(q)}&per_page=100&page={page}"
            data = request_json(url)
            batch = data.get("items", [])
            for it in batch:
                store[it["number"]] = it
            print(f"  p{page}: +{len(batch)}")
            if len(batch) < 100:
                break
            time.sleep(2)
        time.sleep(2)
    return list(store.values())


def net_text_length(body: str) -> int:
    """
    计算去除模板后的净文本长度（PD-05 第 2.1 节）

    移除：Markdown 标题行、代码块、图片引用，合并连续空行
    """
    if not body:
        return 0
    t = re.sub(r"###[^\n]*\n", "", body)
    t = t.replace("\r", "")
    t = re.sub(r"```[\s\S]*?```", "", t)
    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", t)
    t = re.sub(r"\n{2,}", "\n", t)
    return len(t.strip())


def normalize_topics(labels: list) -> list:
    """
    归一化模块标签（PD-02 第 4.3 节）
      1. 移除 2d / 3d
      2. 不属于 10 类的映射为 other
      3. 去重排序
    """
    raw = [l["name"].replace("topic:", "")
           for l in labels if l["name"].startswith("topic:")]
    norm = {t if t in KEEP_TOPICS else "other"
            for t in raw if t not in MODIFIER_TOPICS}
    return sorted(norm)


def map_severity(labels: list) -> str:
    """严重度映射，按优先级排他匹配（PD-02 第 5.4 节规则一）。"""
    names = {l["name"] for l in labels}
    for tag, level in SEVERITY_PRIORITY:
        if tag in names:
            return level
    return "low"


def build_row(it: dict, in_eval: bool, group: str) -> dict:
    labels = it["labels"]
    topics = normalize_topics(labels)
    body = it.get("body") or ""
    return {
        "number": it["number"],
        "title": it["title"],
        "body": body.replace("\r", " ").replace("\n", " ")[:3000],
        "gt_topics": "|".join(topics),
        "topic_count": len(topics),
        "gt_severity": map_severity(labels),
        "raw_labels": "|".join(l["name"] for l in labels),
        "net_text_len": net_text_length(body),
        "body_len": len(body),
        "is_archived": "archived" in {l["name"] for l in labels},
        "in_eval_set": in_eval,
        "eval_group": group,
        "created_at": it["created_at"][:10],
        "html_url": it["html_url"],
    }


def stratified_sample(pool: list, rng: random.Random) -> list:
    """
    分层抽样：按类别抽取，同时兼顾年份均衡

    注意：多标签样本可能同时满足多个类别的抽样需求，
    此处以首个类别归组，避免重复抽取。
    """
    by_topic = defaultdict(list)
    for it in pool:
        topics = normalize_topics(it["labels"])
        # 优先归入具体类别，其次 other
        specific = [t for t in topics if t != "other"]
        key = specific[0] if specific else "other"
        by_topic[key].append(it)

    picked, seen = [], set()
    for topic, target in SAMPLE_TARGET.items():
        candidates = [it for it in by_topic.get(topic, [])
                      if it["number"] not in seen]
        # 按年份分组后轮转抽取，保证时间分布均衡
        by_year = defaultdict(list)
        for it in candidates:
            by_year[it["created_at"][:4]].append(it)
        for lst in by_year.values():
            rng.shuffle(lst)

        selected, years = [], sorted(by_year.keys())
        while len(selected) < target and any(by_year[y] for y in years):
            for y in years:
                if by_year[y] and len(selected) < target:
                    selected.append(by_year[y].pop())
        if len(selected) < target:
            print(f"  警告：{topic} 仅抽到 {len(selected)}/{target} 条")
        for it in selected:
            seen.add(it["number"])
        picked.extend(selected)
    return picked


def write_csv(path: str, rows: list) -> None:
    if not rows:
        return
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


def main():
    if not TOKEN:
        print("⚠️  未设置 GITHUB_TOKEN，未认证限流 60 次/小时，很可能中途失败")
        print("   申请地址：https://github.com/settings/tokens （只勾 public_repo）\n")

    rng = random.Random(RANDOM_SEED)
    items = fetch_all()
    print(f"\n拉取完成，去重后 {len(items)} 条")

    # 过滤：必须有归一化后的类别（否则无 Ground Truth）
    valid = [it for it in items if normalize_topics(it["labels"])]
    print(f"含有效标签：{len(valid)} 条（排除 {len(items) - len(valid)} 条无标签样本）")

    # 按净文本长度划分主池与对抗池
    main_pool = [it for it in valid
                 if net_text_length(it.get("body") or "") >= NET_TEXT_THRESHOLD]
    adv_pool = [it for it in valid
                if net_text_length(it.get("body") or "") < NET_TEXT_THRESHOLD]
    print(f"主评测池：{len(main_pool)} 条　对抗池：{len(adv_pool)} 条")

    # 1. 主评测集：分层抽样
    print("\n构建主评测集（分层抽样）...")
    eval_main = stratified_sample(main_pool, rng)
    print(f"主评测集：{len(eval_main)} 条")

    # 2. 对抗测试集
    rng.shuffle(adv_pool)
    eval_adv = adv_pool[:ADVERSARIAL_TARGET]
    print(f"对抗测试集：{len(eval_adv)} 条")

    # 3. 检索库：排除全部评测集样本（防数据泄漏）
    eval_numbers = {it["number"] for it in eval_main + eval_adv}
    retrieval = [it for it in items if it["number"] not in eval_numbers]
    print(f"检索库：{len(retrieval)} 条")

    # 输出
    write_csv(os.path.join(OUT_DIR, "eval_set_main.csv"),
              [build_row(it, True, "main") for it in eval_main])
    write_csv(os.path.join(OUT_DIR, "eval_set_adversarial.csv"),
              [build_row(it, True, "adversarial") for it in eval_adv])
    write_csv(os.path.join(OUT_DIR, "retrieval_corpus.csv"),
              [build_row(it, False, "retrieval") for it in retrieval])

    # ==== 校验 ====
    print("\n" + "=" * 52)
    print("校验结果")
    print("=" * 52)

    # 泄漏检查（PD-05 最关键的一项）
    overlap = eval_numbers & {it["number"] for it in retrieval}
    print(f"数据泄漏检查：评测集与检索库交集 {len(overlap)} 条 "
          f"→ {'通过' if not overlap else '❌ 存在泄漏，必须修复'}")

    # 类别分布
    print("\n主评测集类别分布：")
    c = Counter()
    for it in eval_main:
        for t in normalize_topics(it["labels"]):
            c[t] += 1
    for k in KEEP_TOPICS + ["other"]:
        target = SAMPLE_TARGET[k]
        mark = "" if c[k] >= target * 0.8 else "  ← 偏少"
        print(f"  {k:14s} {c[k]:3d}  (目标 {target}){mark}")

    # 多标签比例
    multi = sum(1 for it in eval_main if len(normalize_topics(it["labels"])) > 1)
    print(f"\n多标签样本：{multi} 条 ({multi / len(eval_main) * 100:.1f}%) "
          f"→ {'达标' if multi >= 60 else '低于 60 条要求'}")

    # 严重度分布
    sev = Counter(map_severity(it["labels"]) for it in eval_main)
    print("\n严重度分布：")
    for k in ["crash", "high", "normal", "low"]:
        print(f"  {k:8s} {sev[k]:3d}  ({sev[k] / len(eval_main) * 100:5.1f}%)")

    # 年份分布
    years = Counter(it["created_at"][:4] for it in eval_main)
    print("\n年份分布：", dict(sorted(years.items())))

    print("\n输出文件：")
    print("  eval_set_main.csv         主评测集（in_eval_set = True）")
    print("  eval_set_adversarial.csv  对抗测试集（in_eval_set = True）")
    print("  retrieval_corpus.csv      检索库（in_eval_set = False）")
    print("\n⚠️  入库时务必保留 in_eval_set 字段，检索必须过滤 in_eval_set = False")


if __name__ == "__main__":
    main()
