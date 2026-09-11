#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Prompt 一致性校验脚本
依据：PD-07 第 6.2 节（枚举一致性）、第 8.1 节（few-shot 泄漏防范）

用途
────
每次修改 Prompt 或 contract.ts 之后执行一次，检查三项：

  1. 枚举一致性 —— 提示词中的类别名、档位名、信号值与 contract.ts 逐字一致
  2. 无 JSON 格式说明 —— 提示词中不得出现字段名或花括号（PD-07 第 6.1 节）
  3. few-shot 无泄漏 —— 注释登记的示例样本编号不得出现在评测集中

为什么需要脚本
──────────────
这三项人工核对都容易遗漏，且失败时不会产生任何报错信号：

  - 枚举不一致：模型输出契约外的取值，Macro-F1 无法计算
  - 双重格式约束：症状是解析失败，但实际原因在提示词，排查成本高
  - few-shot 泄漏：准确率虚高，且完全无异常表现

用法
────
  python check_prompt.py                      # 使用默认路径
  python check_prompt.py --prompt prompts/triage_v1_0.ts \
                         --contract types/contract.ts \
                         --eval-set data/eval_set_main.csv

退出码
──────
  0  全部通过
  1  存在不通过项
"""

import argparse
import csv
import os
import re
import sys

# ============================================================
# 工具函数
# ============================================================

def read_text(path):
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def strip_ts_comments(src):
    """移除 TypeScript 的行注释与块注释。

    必须先做这一步再提取枚举值。契约文件的注释中含引号内容
    （例如 SeveritySignal 的注释里引用了 "Not reproducible in" 结构），
    若不移除注释会被误当作枚举取值，产生虚假的不一致报告。
    """
    src = re.sub(r"/\*[\s\S]*?\*/", "", src)
    src = re.sub(r"//[^\n\r]*", "", src)
    return src


def extract_enum_values(src, type_name):
    """从 TypeScript 联合类型定义中提取字符串字面量取值。

    形如：
        export type TopicCategory =
          | "editor"   // 注释
          | "rendering"
          ...;
    """
    clean = strip_ts_comments(src)
    m = re.search(
        r"export\s+type\s+" + re.escape(type_name) + r"\s*=([\s\S]*?);",
        clean,
    )
    if not m:
        return None
    return [v for v in re.findall(r'"([^"]+)"', m.group(1))]


def extract_prompt_text(src):
    """提取 SYSTEM_PROMPT 模板字符串的内容。"""
    m = re.search(r"SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`", src)
    return m.group(1) if m else None


def extract_example_ids(src):
    """提取注释中登记的 few-shot 示例样本编号。

    约定格式（PD-07 第 8.1 节）：
        * 示例样本编号：12345, 67890
        * 示例样本编号：（无）
    """
    m = re.search(r"示例样本编号[：:]\s*([^\n\r]*)", src)
    if not m:
        return None  # 未登记，属规范违反
    line = m.group(1)
    return [int(x) for x in re.findall(r"\d{3,7}", line)]


def load_eval_numbers(path):
    if not os.path.exists(path):
        return None
    nums = set()
    with open(path, "r", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            for key in ("number", "issue_number", "id"):
                if key in row and row[key]:
                    try:
                        nums.add(int(row[key]))
                    except ValueError:
                        pass
                    break
    return nums


# ============================================================
# 校验项
# ============================================================

def check_enum_consistency(prompt_text, contract_src):
    """检查项 1：提示词中的枚举值与 contract.ts 一致。"""
    results = []
    specs = [
        ("TopicCategory", "模块类别"),
        ("SeverityLevel", "严重度档位"),
        ("SeveritySignal", "判定信号"),
        ("InfoSufficiency", "信息充分度"),
    ]

    for type_name, label in specs:
        vals = extract_enum_values(contract_src, type_name)
        if vals is None:
            results.append((False, f"{label}：contract.ts 中未找到 {type_name} 定义"))
            continue

        missing = [v for v in vals if not re.search(r"\b" + re.escape(v) + r"\b", prompt_text)]
        if missing:
            results.append((
                False,
                f"{label}：以下 {len(missing)} 项未出现在提示词中 → {', '.join(missing)}",
            ))
        else:
            results.append((True, f"{label}：{len(vals)} 项全部一致"))

    # 反向检查：提示词中出现了契约外的疑似类别名
    topic_vals = extract_enum_values(contract_src, "TopicCategory") or []
    forbidden = ["2d", "3d", "physics", "audio", "network", "multiplayer"]
    leaked = [
        w for w in forbidden
        if w not in topic_vals and re.search(r"(?<![\w-])" + re.escape(w) + r"(?![\w-])", prompt_text)
    ]
    if leaked:
        results.append((
            False,
            f"反向检查：提示词中出现契约外的取值 → {', '.join(leaked)}（可能被模型当作候选）",
        ))
    else:
        results.append((True, "反向检查：提示词中无契约外的类别取值"))

    return results


def check_no_json_spec(prompt_text, contract_src):
    """检查项 2：提示词中不得含 JSON 格式说明（PD-07 第 6.1 节）。"""
    results = []

    braces = prompt_text.count("{") + prompt_text.count("}")
    if braces > 0:
        results.append((False, f"提示词中出现 {braces} 处花括号，疑似手写了 JSON 格式说明"))
    else:
        results.append((True, "提示词中无花括号"))

    # 契约字段名不应出现在提示词中
    field_names = [
        "topicCandidates", "infoSufficiency", "isDuplicate",
        "promptVersion", "latencyMs", "fallbackUsed", "requestId",
    ]
    found = [f for f in field_names if f in prompt_text]
    if found:
        results.append((
            False,
            f"提示词中出现契约字段名 → {', '.join(found)}（格式约束应仅由 Zod Schema 承担）",
        ))
    else:
        results.append((True, "提示词中无契约字段名"))

    return results


def check_fewshot_leakage(prompt_src, eval_numbers):
    """检查项 3：few-shot 示例不得取自评测集（PD-07 第 8.1 节）。"""
    ids = extract_example_ids(prompt_src)

    if ids is None:
        return [(
            False,
            "未找到「示例样本编号」登记行。依 PD-07 第 8.1 节，"
            "即使无示例也须写明「（无）」",
        )]

    if not ids:
        return [(True, "未使用 few-shot 示例，无泄漏风险")]

    if eval_numbers is None:
        return [(
            False,
            f"已登记 {len(ids)} 个示例样本，但评测集文件不存在，无法校验泄漏。"
            f"须在评测集生成后重新执行本检查",
        )]

    overlap = sorted(set(ids) & eval_numbers)
    if overlap:
        return [(
            False,
            f"数据泄漏：{len(overlap)} 个示例样本同时存在于评测集 → "
            f"{', '.join('#' + str(x) for x in overlap[:10])}",
        )]

    return [(True, f"{len(ids)} 个示例样本均不在评测集中")]


# ============================================================
# 主流程
# ============================================================

def main():
    ap = argparse.ArgumentParser(description="Prompt 一致性校验")
    ap.add_argument("--prompt", default="prompts/triage_v1_0.ts")
    ap.add_argument("--contract", default="types/contract.ts")
    ap.add_argument("--eval-set", default="data/eval_set_main.csv")
    args = ap.parse_args()

    print("=" * 62)
    print("Prompt 一致性校验（PD-07 第 6.2 / 8.1 节）")
    print("=" * 62)
    print(f"提示词  : {args.prompt}")
    print(f"契约    : {args.contract}")
    print(f"评测集  : {args.eval_set}")
    print()

    prompt_src = read_text(args.prompt)
    contract_src = read_text(args.contract)

    if prompt_src is None:
        print(f"[错误] 提示词文件不存在：{args.prompt}")
        return 1
    if contract_src is None:
        print(f"[错误] 契约文件不存在：{args.contract}")
        return 1

    prompt_text = extract_prompt_text(prompt_src)
    if prompt_text is None:
        print("[错误] 未能从提示词文件中提取 SYSTEM_PROMPT 模板字符串")
        return 1

    version_match = re.search(r'PROMPT_VERSION\s*=\s*"([^"]+)"', prompt_src)
    version = version_match.group(1) if version_match else None
    if version:
        print(f"检出版本号：{version}")
    else:
        print("[警告] 未找到 PROMPT_VERSION 常量导出")
    print()

    eval_numbers = load_eval_numbers(args.eval_set)

    sections = [
        ("检查项 1 · 枚举一致性", check_enum_consistency(prompt_text, contract_src)),
        ("检查项 2 · 无 JSON 格式说明", check_no_json_spec(prompt_text, contract_src)),
        ("检查项 3 · few-shot 泄漏防范", check_fewshot_leakage(prompt_src, eval_numbers)),
    ]

    failed = 0
    for title, results in sections:
        print(f"── {title} " + "─" * max(0, 46 - len(title)))
        for ok, msg in results:
            mark = "通过" if ok else "不通过"
            print(f"  [{mark}] {msg}")
            if not ok:
                failed += 1
        print()

    print("=" * 62)
    if failed == 0:
        print("校验结果：全部通过")
        print()
        print("提醒：本脚本不检查提示词的判定效果，仅检查形式约束。")
        print("      效果验证须通过 300 条主评测集执行完整评测。")
        return 0

    print(f"校验结果：{failed} 项不通过")
    print()
    print("处理要求：")
    print("  - 枚举不一致 → 修改提示词使其与 contract.ts 一致，不要反向修改契约")
    print("  - 出现 JSON 格式说明 → 删除，格式约束交由 Zod Schema 承担")
    print("  - few-shot 泄漏 → 更换示例样本，仅可取自 in_eval_set = false 的记录")
    return 1


if __name__ == "__main__":
    sys.exit(main())
