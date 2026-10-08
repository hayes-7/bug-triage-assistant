#!/usr/bin/env python3
"""Generate lib/eval-history.ts from data/eval_metrics_*.json.

Why this script exists
----------------------
The report page (/report) and about page (/about) are statically prerendered:
their metrics are baked into lib/eval-history.ts at build time. Adding a new
evaluation batch therefore has no visible effect unless that module is
regenerated and committed. This script is the only supported way to do that.

Hard rules enforced here
------------------------
1. Every number is copied from the JSON. Nothing is hard-coded, rounded, or
   "cleaned up". The credibility of the report page rests entirely on
   "page number == JSON number".
2. A missing or non-numeric field aborts the run instead of being silently
   written out as 0 / null. A silently-wrong metric is worse than no metric.
3. The naive-baseline figure is derived from the confusion matrix of the
   latest batch, not typed in.

Usage
-----
    .venv/Scripts/python.exe scripts/build_eval_history.py             # Windows
    .venv/bin/python scripts/build_eval_history.py                     # macOS/Linux

        --check    diff only, write nothing (exit 2 if differences)
        --list     list discovered batches in generated order

Interpreter
-----------
This script uses the standard library only (argparse, difflib, json, pathlib,
sys) and runs on any Python 3.7+, so the system python is fine. The README
still spells out the .venv interpreter purely for consistency with the rest of
the docs: the evaluation entry point (scripts/run_eval.py) genuinely requires
.venv because it needs psycopg2, and two different interpreter conventions in
one README is more confusing than one uniform convention.

Output encoding is UTF-8 and line endings are LF, regardless of platform, so
that regenerating on Windows does not produce a whole-file diff. The generated
file carries no timestamp for the same reason: a timestamp would make every run
look like a change and would break --check's ability to say "data unchanged".

Exit codes
----------
    0  success (or no differences in --check mode)
    1  abort: a required field is missing or non-numeric
    2  --check found differences
"""

from __future__ import annotations

import argparse
import difflib
import json
import sys
from pathlib import Path
from typing import Any


def force_utf8_stdio() -> None:
    """Make stdout/stderr UTF-8 regardless of the console codepage.

    The generated header contains CJK text and U+26A0. On a Windows console
    whose active codepage is GBK, printing them raises UnicodeEncodeError and
    aborts the run midway -- which is baffling, because the failure has nothing
    to do with the data. Force UTF-8 so the tool behaves the same on every
    platform and in every terminal.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:  # Python 3.7+
            reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUTPUT = ROOT / "lib" / "eval-history.ts"

GLOB = "eval_metrics_*.json"

# Field order of the generated entries. Anything listed in REQUIRED_NUMERIC is
# checked before writing; unknown topics/severities are a hard error too.
TOPICS = [
    "editor",
    "rendering",
    "gui",
    "gdscript",
    "core",
    "platforms",
    "animation",
    "buildsystem",
    "import",
    "input",
    "other",
]
SEVERITIES = ["crash", "high", "normal", "low"]

REQUIRED_NUMERIC = [
    "topicTop1Accuracy",
    "topicTop3HitRate",
    "topicMacroF1",
    "severityAccuracy",
    "parseSuccessRate",
    "retryRate",
    "fallbackRate",
    "avgLatencyMs",
    "p95LatencyMs",
]


class Abort(Exception):
    """Raised when the source data cannot be copied faithfully."""


def num(value: Any) -> str:
    """Render a number the way TypeScript source would.

    Python's repr() and JS's Number#toString() both emit the shortest form that
    round-trips, so repr() reproduces the digits that JS would print for a
    non-integral float: a ratio such as 205/280 keeps every digit JS would
    print, and no value is rounded or reformatted on its way into the output.

    The one place they differ: an integral float reprs as "0.0" / "5095.0" in
    Python but JS prints "0" / "5095". Emitting the Python form would churn the
    whole file every run (every parseSuccessRate: 1, every p95LatencyMs: 5095)
    and bury the numbers that actually changed -- so strip the ".0" here.
    bool is rejected outright: a metric that came back as a boolean is broken.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise Abort(f"not a number: {value!r}")
    if isinstance(value, float) and value.is_integer():
        # Only safe for magnitudes that JS represents exactly; anything larger
        # keeps the float form rather than risk a wrong integer literal.
        if abs(value) < 2**53:
            return str(int(value))
    return repr(value)


def require_numeric(source: Any, key: str, where: str) -> Any:
    if not isinstance(source, dict) or key not in source:
        raise Abort(f"{where}: missing field '{key}'")
    value = source[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise Abort(f"{where}: field '{key}' is not numeric: {value!r}")
    return value


def discover() -> list[Path]:
    files = sorted(DATA_DIR.glob(GLOB))
    if not files:
        raise Abort(f"no files matching {DATA_DIR / GLOB}")
    return files


def load_runs(files: list[Path]) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    for path in files:
        with path.open(encoding="utf-8") as handle:
            payload = json.load(handle)
        metrics = payload.get("metrics")
        if not isinstance(metrics, dict):
            raise Abort(f"{path.name}: missing 'metrics' object")
        runs.append({"path": path, "payload": payload, "metrics": metrics})

    # Order by createdAt ascending so the report reads in experiment order.
    def sort_key(run: dict[str, Any]) -> str:
        created = run["payload"].get("createdAt")
        if not isinstance(created, str):
            raise Abort(f"{run['path'].name}: missing 'createdAt'")
        return created

    runs.sort(key=sort_key)
    return runs


def render_entry(run: dict[str, Any]) -> str:
    path, payload, m = run["path"], run["payload"], run["metrics"]
    where = path.name

    for key in ["runId", "runLabel", "promptVersion", "modelId", "createdAt"]:
        if not isinstance(payload.get(key), str):
            raise Abort(f"{where}: missing or non-string '{key}'")
    for key in REQUIRED_NUMERIC:
        require_numeric(m, key, where)
    require_numeric(m, "sampleCount", where)

    per_topic = m.get("perTopicF1")
    per_sev = m.get("perSeverityF1")
    if not isinstance(per_topic, dict) or not isinstance(per_sev, dict):
        raise Abort(f"{where}: missing perTopicF1 / perSeverityF1")
    for topic in TOPICS:
        require_numeric(per_topic, topic, f"{where} perTopicF1")
    for level in SEVERITIES:
        require_numeric(per_sev, level, f"{where} perSeverityF1")

    adv = payload.get("adversarial") or {}
    for key in ["sampleCount", "correctlyFlagged", "correctlyFlaggedRate"]:
        require_numeric(adv, key, f"{where} adversarial")

    dup_raw = payload.get("duplicate")
    if isinstance(dup_raw, dict) and "duplicateRecallAt5" in dup_raw:
        for key in ["pairs", "duplicateRecallAt5", "duplicatePrecision", "precisionThreshold"]:
            require_numeric(dup_raw, key, f"{where} duplicate")
        dup = (
            "{\n"
            f"      pairs: {num(dup_raw['pairs'])},\n"
            f"      recallAt5: {num(dup_raw['duplicateRecallAt5'])},\n"
            f"      precision: {num(dup_raw['duplicatePrecision'])},\n"
            f"      precisionThreshold: {num(dup_raw['precisionThreshold'])},\n"
            "    }"
        )
    else:
        # Batches that never ran the duplicate stage say so explicitly; a null
        # is not the same thing as a zero.
        dup = "null"

    topic_lines = "\n".join(
        f"      {t}: {num(per_topic[t])}," for t in TOPICS
    )
    sev_lines = "\n".join(f"      {s}: {num(per_sev[s])}," for s in SEVERITIES)

    return (
        "  {\n"
        f"    runId: {json.dumps(payload['runId'])},\n"
        f"    runLabel: {json.dumps(payload['runLabel'])},\n"
        f"    promptVersion: {json.dumps(payload['promptVersion'])},\n"
        f"    modelId: {json.dumps(payload['modelId'])},\n"
        f"    createdAt: {json.dumps(payload['createdAt'])},\n"
        f"    sampleCount: {num(m['sampleCount'])},\n"
        f"    topicTop1Accuracy: {num(m['topicTop1Accuracy'])},\n"
        f"    topicTop3HitRate: {num(m['topicTop3HitRate'])},\n"
        f"    topicMacroF1: {num(m['topicMacroF1'])},\n"
        f"    severityAccuracy: {num(m['severityAccuracy'])},\n"
        "    perTopicF1: {\n"
        f"{topic_lines}\n"
        "    },\n"
        "    perSeverityF1: {\n"
        f"{sev_lines}\n"
        "    },\n"
        f"    parseSuccessRate: {num(m['parseSuccessRate'])},\n"
        f"    retryRate: {num(m['retryRate'])},\n"
        f"    fallbackRate: {num(m['fallbackRate'])},\n"
        f"    avgLatencyMs: {num(m['avgLatencyMs'])},\n"
        f"    p95LatencyMs: {num(m['p95LatencyMs'])},\n"
        "    adversarial: {\n"
        f"      sampleCount: {num(adv['sampleCount'])},\n"
        f"      correctlyFlagged: {num(adv['correctlyFlagged'])},\n"
        f"      correctlyFlaggedRate: {num(adv['correctlyFlaggedRate'])},\n"
        "    },\n"
        f"    duplicate: {dup},\n"
        "  },"
    )


def naive_baseline(latest: dict[str, Any]) -> tuple[str, int, int]:
    """Derive the majority-class baseline from the severity confusion matrix.

    The matrix is indexed [predicted][actual], so summing a column gives the
    ground-truth count for that level.
    """
    path, m = latest["path"], latest["metrics"]
    matrix = m.get("severityConfusionMatrix")
    if not isinstance(matrix, dict):
        raise Abort(f"{path.name}: missing severityConfusionMatrix")

    counts: dict[str, int] = {}
    for level in SEVERITIES:
        column = 0
        for predicted in SEVERITIES:
            row = matrix.get(predicted)
            if not isinstance(row, dict) or level not in row:
                raise Abort(f"{path.name}: confusion matrix missing [{predicted}][{level}]")
            value = row[level]
            if not isinstance(value, int) or isinstance(value, bool):
                raise Abort(f"{path.name}: confusion matrix value not an int: {value!r}")
            column += value
        counts[level] = column

    majority = max(SEVERITIES, key=lambda level: counts[level])
    return counts, majority, counts[majority], sum(counts.values())


def render(runs: list[dict[str, Any]]) -> str:
    latest = runs[-1]
    counts, majority, count, total = naive_baseline(latest)

    entries = "\n".join(render_entry(run) for run in runs)
    sources = "、".join(f"data/{run['path'].name}" for run in runs)
    counts_line = " / ".join(f"{level} {counts[level]}" for level in SEVERITIES)
    topic_order = "\n".join(f'  "{t}",' for t in TOPICS)
    severity_order = "\n".join(f'  "{s}",' for s in SEVERITIES)

    return f"""/**
 * 评测批次历史（静态数据模块）
 *
 * ⚠ 本文件由 scripts/build_eval_history.py 从 data/eval_metrics_*.json
 *   逐字段抄出，请勿手工编辑。
 * 任何数字都不得手改或美化：报告页的可信度完全依赖「页面数字 == JSON 数字」。
 * 新增批次时重新生成本文件，不要在此处追加手写条目。
 *
 * 为何用静态模块而非运行时读目录：
 *   1. 报告页需要能静态渲染（含日后部署到 Serverless/Edge），运行时扫 data/
 *      目录在构建产物中不可靠——data/ 不随构建产物分发；
 *   2. 评测结果是冻结的历史事实，不是运行期状态，没有动态读取的必要；
 *   3. 固定为源码后，数字进入 git 历史，可追溯每次报告页改动对应的数据版本。
 *
 * 本文件刻意不含生成时间戳：时间戳会让每次生成都产生 diff，淹没真正的数字
 * 变化，并使 --check 模式永远报差异、「确认数据无变化」这个语义失效。
 * 生成日期改由 git 提交历史提供。
 *
 * 源文件：{sources}
 */

import type {{ SeverityLevel, TopicCategory }} from "@/types/contract";

export type EvalRunRecord = {{
  runId: string;
  /** 批次标签，来自 JSON 的 runLabel 原值（注意与 runId 不一定相同） */
  runLabel: string;
  promptVersion: string;
  modelId: string;
  createdAt: string;
  /** 实际计入统计的样本数，注意各批次不完全相同 */
  sampleCount: number;
  topicTop1Accuracy: number;
  topicTop3HitRate: number;
  topicMacroF1: number;
  severityAccuracy: number;
  perTopicF1: Record<TopicCategory, number>;
  perSeverityF1: Record<SeverityLevel, number>;
  parseSuccessRate: number;
  retryRate: number;
  fallbackRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  adversarial: {{
    sampleCount: number;
    correctlyFlagged: number;
    correctlyFlaggedRate: number;
  }};
  /** null 表示该批次未跑查重段（sev-defined 即为此情形） */
  duplicate: {{
    pairs: number;
    recallAt5: number;
    precision: number;
    precisionThreshold: number;
  }} | null;
}};

/** 按 createdAt 升序，与实验推进顺序一致 */
export const EVAL_RUNS: readonly EvalRunRecord[] = [
{entries}
] as const;

/** 最新批次（当前线上使用的 v2.0） */
export const LATEST_RUN_ID = {json.dumps(latest['payload']['runId'])};

/**
 * 严重度朴素基线：恒定输出最多数类别的准确率。
 *
 * 取值依据：{latest['payload']['runId']} 批次 severityConfusionMatrix 按列求和得到标准答案分布
 * （该矩阵为 [预测档][标准答案档]，故列和即标准答案计数）：
 *   {counts_line}，合计 {total}。
 * 最多数类别为 "{majority}"（{count} 条），故基线 = {count} / {total}。
 *
 * 该值是本项目判断「严重度是否可用」的门槛：模型准确率低于它，
 * 说明不如无脑输出 "{majority}"，不具备产品价值。
 */
export const SEVERITY_NAIVE_BASELINE = {{
  /** 最多数类别 */
  majorityLevel: "{majority}" as SeverityLevel,
  count: {count},
  total: {total},
  accuracy: {count} / {total},
}} as const;

export const TOPIC_ORDER: readonly TopicCategory[] = [
{topic_order}
] as const;

export const SEVERITY_ORDER: readonly SeverityLevel[] = [
{severity_order}
] as const;
"""


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Regenerate lib/eval-history.ts from data/eval_metrics_*.json.",
        epilog="See the module docstring for why this step is required.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="compare against the current file and report differences; write nothing",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="list discovered batches in generated order and exit",
    )
    args = parser.parse_args()
    force_utf8_stdio()

    try:
        runs = load_runs(discover())
    except Abort as error:
        print(f"abort: {error}", file=sys.stderr)
        return 1

    if args.list:
        for index, run in enumerate(runs, start=1):
            payload = run["payload"]
            print(
                f"  {index}. {payload['runId']}  "
                f"prompt={payload['promptVersion']}  "
                f"model={payload['modelId']}  "
                f"createdAt={payload['createdAt']}  "
                f"n={run['metrics'].get('sampleCount')}"
            )
        return 0

    try:
        content = render(runs)
    except Abort as error:
        print(f"abort: {error}", file=sys.stderr)
        return 1

    if args.check:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if current == content:
            print(f"up to date: {OUTPUT.relative_to(ROOT)}")
            return 0
        print(f"differences found in {OUTPUT.relative_to(ROOT)}:")
        diff = difflib.unified_diff(
            current.splitlines(keepends=True),
            content.splitlines(keepends=True),
            fromfile="current",
            tofile="generated",
            n=1,
        )
        sys.stdout.writelines(diff)
        return 2

    # UTF-8 + LF on every platform: a Windows CRLF rewrite would show up as a
    # whole-file diff and hide the numbers that actually changed.
    with OUTPUT.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
    print(f"wrote {OUTPUT.relative_to(ROOT)}  ({len(runs)} batches)")
    for run in runs:
        print(f"  - {run['payload']['runId']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
