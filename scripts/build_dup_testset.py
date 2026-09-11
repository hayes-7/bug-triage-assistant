#!/usr/bin/env python3
"""
查重测试集构建脚本（PD-06 第 5 章配套）

背景：
  实测发现 state_reason = duplicate 的样本不包含指向原单的编号
  （1500 条样本中有 51 条 duplicate，其中仅 4 条在 body 里提到 #编号）
  真正的重复关系记录在评论中，须逐条调 comments 接口提取。

用途：
  从 duplicate 样本的评论中提取「重复单 → 原单」的配对关系，
  产出查重测试集，用于计算 Recall@5。

规模预期：
  目标 50 对，下限 30 对。提取成功率取决于评论措辞的规范程度，
  执行前无法确定。若不足 30 对，需按 PD-06 第 5.4 节启用备用方法。

用法：
    export GITHUB_TOKEN=your_token
    python build_dup_testset.py
"""

import csv
import json
import os
import re
import time
import urllib.error
import urllib.request

# ============ 配置 ============
REPO = "godotengine/godot"
INPUT_JSON = "godot_issues_raw.json"   # 由 build_eval_set.py 产出
OUT_CSV = "dup_testset.csv"
TARGET_PAIRS = 50
MIN_PAIRS = 30
REQUEST_DELAY = 1.2                    # 请求间隔，避免触发二级限流

TOKEN = os.environ.get("GITHUB_TOKEN", "")

# 重复关系的措辞模式，按可靠性排序
# 第一组：明确表述，可信度高
STRONG_PATTERNS = [
    r"duplicate of\s*#(\d{4,6})",
    r"dupe of\s*#(\d{4,6})",
    r"closing in favor of\s*#(\d{4,6})",
    r"superseded by\s*#(\d{4,6})",
    r"already (?:reported|fixed) in\s*#(\d{4,6})",
    r"same (?:as|issue as)\s*#(\d{4,6})",
]
# 第二组：弱表述，需标记为待人工确认
WEAK_PATTERNS = [
    r"see\s*#(\d{4,6})",
    r"related to\s*#(\d{4,6})",
    r"fixed by\s*#(\d{4,6})",
]

STRONG_RE = re.compile("|".join(STRONG_PATTERNS), re.I)
WEAK_RE = re.compile("|".join(WEAK_PATTERNS), re.I)


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


def extract_ref(comments: list) -> tuple:
    """
    从评论列表中提取原单编号。

    返回 (编号, 强度)，强度为 'strong' / 'weak' / None
    优先返回强表述的匹配结果。
    """
    weak_hit = None
    for c in comments:
        body = c.get("body") or ""
        m = STRONG_RE.search(body)
        if m:
            num = next(g for g in m.groups() if g)
            return int(num), "strong"
        if weak_hit is None:
            m2 = WEAK_RE.search(body)
            if m2:
                num = next(g for g in m2.groups() if g)
                weak_hit = int(num)
    return (weak_hit, "weak") if weak_hit else (None, None)


def main():
    if not TOKEN:
        print("⚠️  未设置 GITHUB_TOKEN。约需 51 次请求，未认证限流 60 次/小时，")
        print("   很可能中途失败。建议先设置 Token。\n")

    if not os.path.exists(INPUT_JSON):
        print(f"未找到 {INPUT_JSON}")
        print("请先运行 build_eval_set.py 产出该文件。")
        return

    items = json.load(open(INPUT_JSON, encoding="utf-8"))
    if isinstance(items, dict):
        items = items.get("items", [])
    by_number = {it["number"]: it for it in items}

    # 取官方标记为重复的样本
    dup_items = [it for it in items if it.get("state_reason") == "duplicate"]
    print(f"数据集共 {len(items)} 条，其中 state_reason = duplicate 的 {len(dup_items)} 条")
    print(f"开始提取重复关系（预计 {len(dup_items) * REQUEST_DELAY / 60:.1f} 分钟）\n")

    pairs, no_ref, target_missing = [], [], []

    for i, it in enumerate(dup_items, 1):
        num = it["number"]
        url = (f"https://api.github.com/repos/{REPO}/issues/{num}"
               f"/comments?per_page=30")
        comments = request_json(url)
        if comments is None:
            print(f"[{i}/{len(dup_items)}] #{num} 获取失败，跳过")
            time.sleep(REQUEST_DELAY)
            continue

        ref, strength = extract_ref(comments)
        if ref is None:
            no_ref.append(num)
            print(f"[{i}/{len(dup_items)}] #{num} 未找到原单指向")
        elif ref == num:
            no_ref.append(num)
            print(f"[{i}/{len(dup_items)}] #{num} 指向自身，忽略")
        else:
            in_corpus = ref in by_number
            if not in_corpus:
                target_missing.append((num, ref))
            pairs.append({
                "dup_number": num,
                "dup_title": it["title"],
                "target_number": ref,
                "target_title": by_number.get(ref, {}).get("title", ""),
                "strength": strength,
                "target_in_corpus": in_corpus,
                "needs_manual_check": strength == "weak" or not in_corpus,
                "dup_url": it["html_url"],
            })
            flag = "" if in_corpus else "  （原单不在数据集内）"
            print(f"[{i}/{len(dup_items)}] #{num} → #{ref}  [{strength}]{flag}")

        time.sleep(REQUEST_DELAY)

    # ==== 输出 ====
    if pairs:
        with open(OUT_CSV, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=list(pairs[0].keys()))
            w.writeheader()
            w.writerows(pairs)

    # ==== 统计 ====
    strong = [p for p in pairs if p["strength"] == "strong"]
    usable = [p for p in pairs if p["strength"] == "strong" and p["target_in_corpus"]]

    print("\n" + "=" * 56)
    print("提取结果")
    print("=" * 56)
    print(f"duplicate 样本总数      : {len(dup_items)}")
    print(f"提取到原单指向          : {len(pairs)}")
    print(f"  其中强表述            : {len(strong)}")
    print(f"  其中原单在数据集内    : {len(usable)}  ← 可直接使用的测试对")
    print(f"未找到指向              : {len(no_ref)}")
    print(f"原单不在数据集内        : {len(target_missing)}")

    print("\n" + "-" * 56)
    if len(usable) >= TARGET_PAIRS:
        print(f"达到目标规模（{TARGET_PAIRS} 对）")
        print(f"建议：从 {len(usable)} 对中随机取 {TARGET_PAIRS} 对作为测试集")
    elif len(usable) >= MIN_PAIRS:
        print(f"达到下限（{MIN_PAIRS} 对）但未达目标（{TARGET_PAIRS} 对）")
        print(f"建议：全部 {len(usable)} 对采用，并在评测报告中注明实际规模")
    else:
        print(f"⚠️  仅 {len(usable)} 对，低于下限 {MIN_PAIRS} 对")
        print("须按 PD-06 第 5.4 节启用备用方法：")
        print("  1. 对检索库两两计算相似度，取 > 0.85 的候选对")
        print("  2. 按相似度降序人工确认")
        print(f"  3. 补足至 {MIN_PAIRS} 对（预估 40 分钟）")
        if target_missing:
            print(f"\n  提示：有 {len(target_missing)} 对的原单不在当前数据集内，")
            print("        可单独拉取这些原单以补充测试对")

    print("\n" + "-" * 56)
    print(f"输出文件：{OUT_CSV}")
    print("字段说明：")
    print("  strength           strong = 明确表述，weak = 弱表述需人工确认")
    print("  target_in_corpus   原单是否在当前数据集内")
    print("  needs_manual_check 是否需要人工确认")
    print("\n⚠️  实际提取的对数须记入 PD-10 决策日志，")
    print("   评测报告中须说明测试集的来源与规模。")


if __name__ == "__main__":
    main()
