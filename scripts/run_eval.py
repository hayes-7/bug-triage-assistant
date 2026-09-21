#!/usr/bin/env python3
"""
分诊接口批量评测脚本（口径依 PD-05 第 4 节）

用法：
    python scripts/run_eval.py                      # 主评测集 280 条 + 对抗集 20 条 + 查重 37 对
    python scripts/run_eval.py --limit 20           # 只跑前 20 条（冒烟用）
    python scripts/run_eval.py --run-id run-20260920-090000   # 断点续传（继续该 runId）
    python scripts/run_eval.py --skip-dup           # 跳过查重评测段（不需要数据库/向量）
    python scripts/run_eval.py --only-dup           # 只跑查重评测段
    python scripts/run_eval.py --fresh              # 忽略已有结果，从头重跑

调用方式（强制）：
    通过 HTTP 逐条调用 POST http://localhost:3000/api/triage，
    不绕过 HTTP 直接调用内部函数。降级 / 重试 / 超时路径本身就是评测对象，
    只有端到端调用才能覆盖。dev server 须处于运行状态，本脚本不自行启动。

并发与限流：
    串行调用，每条之间固定间隔 200ms。刻意不提高并发：
    限流导致的鉴权类失败会污染 retryRate 等指标。

HTTP 客户端：
    Python 标准库 urllib.request（与 scripts/ 下其它脚本一致，不引入新依赖）。

落盘产物（均在 data/ 下）：
    eval_results_{runId}.csv                  主评测集逐条明细（错误分析的唯一依据）
    eval_results_{runId}_adversarial.csv      对抗集逐条明细
    eval_results_{runId}.progress.json        断点续传进度（已完成编号）
    eval_metrics_{runId}.json                 汇总指标 + 批次配置（EvalConfig）
    eval_dup_results_{runId}.csv              查重逐对明细

环境变量：从 .env.local 读取（不打印值）
    DATABASE_URL / EMBEDDING_API_KEY / EMBEDDING_BASE_URL   仅查重评测段需要
"""

import argparse
import csv
import hashlib
import json
import math
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")

# ============================================================
# 配置常量
# ============================================================

API_URL = "http://localhost:3000/api/triage"

# 客户端超时须大于服务端端到端阈值（TIMEOUTS.endToEnd = 45s），否则服务端还在跑客户端已放弃
REQUEST_TIMEOUT = 75
# 每条之间的间隔（秒）。限流会导致鉴权类失败，污染 retryRate，故固定串行 + 间隔
SLEEP_BETWEEN_REQUESTS = 0.2
# 仅传输层异常（连接重置 / 超时）重试；HTTP 状态码一律不重试，如实记录
TRANSPORT_RETRIES = 1
PROGRESS_EVERY = 50

# 来自 types/contract.ts
TOPIC_CATEGORIES = [
    "editor", "rendering", "gui", "gdscript", "core", "platforms",
    "animation", "buildsystem", "import", "input", "other",
]
# Macro-F1 只算这 10 个具体类别，排除 other（PD-05 第 4 节强制口径）
CONCRETE_TOPIC_CATEGORIES = [t for t in TOPIC_CATEGORIES if t != "other"]
SEVERITY_LEVELS = ["crash", "high", "normal", "low"]

# 批次配置（对应 contract.ts 的 EvalConfig）。来源：
#   retrievalTopK   PD-04 检索 Top-K
#   dupThreshold    DUP_THRESHOLD_INITIAL（第 2 周阈值扫描后更新，见 D-09）
#   temperature     prompts/triage_v1_0.ts MODEL_PARAMS.temperature
#   maxInputTokens  INPUT_TRUNCATE_TOKENS / MAX_INPUT_TOKENS
# promptVersion 不在此处硬编码，一律从响应 meta 读取。
EVAL_CONFIG = {
    "retrievalTopK": 5,
    "dupThreshold": 0.75,
    "temperature": 0,
    "maxInputTokens": 1500,
}

# 目标阈值（PD-05 第 3 / 第 6 节）
TARGETS = {
    "topicTop1Accuracy": ("ge", 0.55),
    "topicTop3HitRate": ("ge", 0.80),
    "parseSuccessRate": ("ge", 0.95),
    "fallbackRate": ("le", 0.01),
}
# 人工基线（PD-12）
HUMAN_BASELINE = {"top1": 0.600, "top3": 0.800, "severity": 0.600}

# 查重评测段（PD-10 D-18）
DUP_MATCH_COUNT = 6     # 调 match_issues 时多取 1 条，用于抵消「命中自身」占用的候选位
DUP_FINAL_K = 5         # 剔除 D 自身后取前 5，与真实场景 Top-5 可比
DUP_MATCH_THRESHOLD = 0.0   # 评测时不过滤，完整观察候选

# 逐条明细 CSV 列（顺序与需求一致，不得增删）
RESULT_COLUMNS = [
    "number", "gt_topics", "pred_topic1", "pred_topic2", "pred_topic3",
    "gt_severity", "pred_severity", "confidence", "info_sufficiency",
    "latency_ms", "retry_count", "fallback_used", "prompt_version", "model_id",
]

MAIN_CSV = os.path.join(DATA_DIR, "eval_set_main.csv")
ADV_CSV = os.path.join(DATA_DIR, "eval_set_adversarial.csv")
DUP_CSV = os.path.join(DATA_DIR, "dup_testset.csv")
CORPUS_CSV = os.path.join(DATA_DIR, "retrieval_corpus.csv")


# ============================================================
# 数据模型
# ============================================================

@dataclass
class SampleResult:
    """一条样本的端到端结果。ok=False 表示 HTTP 失败（不参与任何指标统计）。"""
    number: str
    gt_topics: list = field(default_factory=list)
    pred_topics: list = field(default_factory=list)
    gt_severity: str = ""
    pred_severity: str = ""
    confidence: float = 0.0
    info_sufficiency: str = ""
    latency_ms: int = 0
    retry_count: int = 0
    fallback_used: bool = False
    prompt_version: str = ""
    model_id: str = ""
    ok: bool = True
    error: str = ""
    # token 数仅来自响应 meta，不写入明细 CSV（明细列固定为 RESULT_COLUMNS），
    # 累计值保存在进度 JSON 里，跨断点续传累加。
    input_tokens: int = 0
    output_tokens: int = 0

    def to_row(self) -> dict:
        """confidence 取 Top-1 候选的置信度（与 pred_topic1 对应）。"""
        padded = list(self.pred_topics) + [""] * (3 - len(self.pred_topics))
        return {
            "number": self.number,
            "gt_topics": "|".join(self.gt_topics),
            "pred_topic1": padded[0],
            "pred_topic2": padded[1],
            "pred_topic3": padded[2],
            "gt_severity": self.gt_severity,
            "pred_severity": self.pred_severity,
            "confidence": f"{self.confidence:.4f}" if self.ok else "",
            "info_sufficiency": self.info_sufficiency,
            "latency_ms": self.latency_ms,
            "retry_count": self.retry_count if self.ok else "",
            "fallback_used": str(self.fallback_used).lower() if self.ok else "",
            "prompt_version": self.prompt_version,
            "model_id": self.model_id,
        }

    @staticmethod
    def from_row(row: dict) -> "SampleResult":
        """从明细 CSV 反解（断点续传时复用已完成样本）。"""
        preds = [row.get(f"pred_topic{i}", "") for i in (1, 2, 3)]
        confidence = row.get("confidence", "")
        return SampleResult(
            number=row.get("number", ""),
            gt_topics=[t for t in (row.get("gt_topics") or "").split("|") if t],
            pred_topics=[p for p in preds if p],
            gt_severity=row.get("gt_severity", "") or "",
            pred_severity=row.get("pred_severity", "") or "",
            confidence=float(confidence) if confidence else 0.0,
            info_sufficiency=row.get("info_sufficiency", "") or "",
            latency_ms=int(row.get("latency_ms") or 0),
            retry_count=int(row.get("retry_count") or 0),
            fallback_used=str(row.get("fallback_used", "")).lower() == "true",
            prompt_version=row.get("prompt_version", "") or "",
            model_id=row.get("model_id", "") or "",
            ok=True,
        )


# ============================================================
# 通用工具
# ============================================================

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def pp(delta: float) -> str:
    return f"{delta * 100:+.1f}pp"


def file_fingerprint(path: str) -> str:
    """数据集版本 = 内容 sha256 前 12 位（内容变了版本号就变，可复现）。"""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:12]


def load_rows(path: str) -> list:
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def split_topics(raw: str) -> list:
    return [t.strip() for t in (raw or "").split("|") if t.strip()]


def percentile_nearest_rank(values: list, q: float) -> float:
    """最近秩百分位（P95）：与 SQL percentile_disc 同口径，不插值。"""
    if not values:
        return 0.0
    ordered = sorted(values)
    k = max(1, math.ceil(q * len(ordered)))
    return float(ordered[k - 1])


def binary_f1(tp: int, fp: int, fn: int) -> float:
    denom = 2 * tp + fp + fn
    return (2 * tp / denom) if denom else 0.0


def topic_gt(s: SampleResult) -> list:
    return s.gt_topics


def topic_pred_top1(s: SampleResult) -> list:
    """
    只取 Top-1。PD-05 第 4 节强制口径：
    若改用 Top-3，每条样本会多出 2 个必然错误的预测，FP 虚增约 2 倍，F1 失真。
    """
    return s.pred_topics[:1]


def severity_gt(s: SampleResult) -> list:
    return [s.gt_severity] if s.gt_severity else []


def severity_pred(s: SampleResult) -> list:
    return [s.pred_severity] if s.pred_severity else []


def per_class_f1(samples: list, classes: list, gt_of, pred_of) -> dict:
    """
    逐类二分类 F1。gt_of / pred_of 分别为标准答案与预测的取值函数：
      模块   → topic_gt / topic_pred_top1（Top-1，见上）
      严重度 → severity_gt / severity_pred（单值）
    标准答案 gt_topics 是多标签集合，逐类独立判定：
      命中该类且预测为该类 → TP；未含该类却预测为该类 → FP；
      含该类但预测为其它类 → FN。
    """
    out = {}
    for cls in classes:
        tp = fp = fn = 0
        for s in samples:
            preds = pred_of(s)
            pred = preds[0] if preds else None
            gt_hit = cls in gt_of(s)
            if gt_hit and pred == cls:
                tp += 1
            elif not gt_hit and pred == cls:
                fp += 1
            elif gt_hit and pred != cls:
                fn += 1
        out[cls] = {
            "f1": binary_f1(tp, fp, fn),
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "support": tp + fn,
            "predicted": tp + fp,
        }
    return out


# ============================================================
# HTTP 调用（端到端，不绕过接口）
# ============================================================

def check_server_up() -> bool:
    try:
        req = urllib.request.Request(API_URL, method="POST")
        urllib.request.urlopen(req, timeout=5).read()
        return True
    except urllib.error.HTTPError:
        return True          # 400/415 也说明进程活着
    except Exception:
        return False


def call_triage(title: str, body: str) -> tuple:
    """
    单条调用。返回 (payload|None, elapsed_ms, error|None)。

    只有传输层异常（连接重置、超时）才重试：这类失败服务端可能并未处理完，
    重试不改变 meta 语义。HTTP 状态码一律不重试，如实记录为失败样本。
    """
    payload_bytes = json.dumps({"title": title, "body": body}).encode("utf-8")
    started = time.time()
    last_error = None
    for attempt in range(TRANSPORT_RETRIES + 1):
        req = urllib.request.Request(
            API_URL,
            data=payload_bytes,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                raw = resp.read().decode("utf-8")
            elapsed = int(round((time.time() - started) * 1000))
            return json.loads(raw), elapsed, None
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "ignore")[:200]
            except Exception:
                pass
            elapsed = int(round((time.time() - started) * 1000))
            return None, elapsed, f"HTTP {e.code}: {detail}"
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_error = f"传输失败: {e}"
            if attempt < TRANSPORT_RETRIES:
                time.sleep(3 * (attempt + 1))
        except json.JSONDecodeError as e:
            elapsed = int(round((time.time() - started) * 1000))
            return None, elapsed, f"响应非 JSON: {e}"
    elapsed = int(round((time.time() - started) * 1000))
    return None, elapsed, last_error


def parse_response(payload: dict, gt_topics: list, gt_severity: str,
                   number: str, elapsed_ms: int) -> SampleResult:
    meta = payload.get("meta") or {}
    candidates = payload.get("topicCandidates") or []
    pred_topics = [c.get("topic") for c in candidates if c.get("topic")]
    return SampleResult(
        number=number,
        gt_topics=gt_topics,
        pred_topics=pred_topics,
        gt_severity=gt_severity,
        pred_severity=(payload.get("severity") or {}).get("level", "") or "",
        confidence=float(candidates[0].get("confidence", 0) or 0) if candidates else 0.0,
        info_sufficiency=payload.get("infoSufficiency", "") or "",
        latency_ms=int(meta.get("latencyMs", elapsed_ms) or elapsed_ms),
        retry_count=int(meta.get("retryCount", 0) or 0),
        fallback_used=bool(meta.get("fallbackUsed", False)),
        # promptVersion / modelId 只从响应 meta 取，禁止硬编码
        prompt_version=meta.get("promptVersion", "") or "",
        model_id=meta.get("modelId", "") or "",
        ok=True,
        input_tokens=int(meta.get("inputTokens", 0) or 0),
        output_tokens=int(meta.get("outputTokens", 0) or 0),
    )


# ============================================================
# 断点续传
# ============================================================

def paths_for(run_id: str, dataset: str) -> tuple:
    suffix = "" if dataset == "main" else "_adversarial"
    return (
        os.path.join(DATA_DIR, f"eval_results_{run_id}{suffix}.csv"),
        os.path.join(DATA_DIR, f"eval_results_{run_id}{suffix}.progress.json"),
    )


def load_progress(progress_path: str) -> dict:
    if not os.path.exists(progress_path):
        return {"completed": [], "failed": []}
    with open(progress_path, encoding="utf-8") as f:
        return json.load(f)


def save_progress(progress_path: str, progress: dict) -> None:
    progress["updatedAt"] = now_iso()
    with open(progress_path, "w", encoding="utf-8") as f:
        json.dump(progress, f, ensure_ascii=False, indent=2)


def restore_completed(csv_path: str, completed: set) -> tuple:
    """
    续传时复用明细 CSV 中已完成的样本，并把文件裁剪为「仅已完成行」，
    避免上一轮留下的失败行与新一轮结果重复。

    判定「已完成」取并集：
      ① 进度 JSON 记录的编号；
      ② 明细行已有预测（pred_topic1 非空）。
    ② 的意义：进程被强杀时进度 JSON 可能未落盘，但明细是每条 flush 的，
    据此可避免重复调用已完成样本。
    """
    if not os.path.exists(csv_path):
        return [], completed
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    kept = [r for r in rows
            if r.get("number") in completed or (r.get("pred_topic1") or "").strip()]
    done = {r.get("number") for r in kept}
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=RESULT_COLUMNS)
        writer.writeheader()
        writer.writerows(kept)
    return [SampleResult.from_row(r) for r in kept], done


# ============================================================
# 评测执行
# ============================================================

def run_dataset(rows: list, dataset: str, run_id: str, args) -> tuple:
    """逐条调用并落盘。返回 (results, stats)。"""
    csv_path, progress_path = paths_for(run_id, dataset)
    label = "主评测集" if dataset == "main" else "对抗集"

    completed_set, progress = set(), {"completed": [], "failed": []}
    results = []
    fresh = not os.path.exists(csv_path)
    if not args.fresh and os.path.exists(csv_path):
        progress = load_progress(progress_path)
        completed_set = set(str(n) for n in progress.get("completed", []))
        results, completed_set = restore_completed(csv_path, completed_set)
        print(f"[{label}] 断点续传：已完成 {len(results)} 条，"
              f"本次跳过这些编号", flush=True)

    pending = [r for r in rows if str(r["number"]) not in completed_set]
    if args.limit is not None:
        pending = pending[: max(0, args.limit - len(results))]

    print(f"[{label}] 总数 {len(rows)}，已完成 {len(results)}，"
          f"待调用 {len(pending)}，间隔 {SLEEP_BETWEEN_REQUESTS * 1000:.0f}ms 串行",
          flush=True)
    if pending:
        est = len(pending) * 4.8 + len(pending) * SLEEP_BETWEEN_REQUESTS
        print(f"[{label}] 预计耗时 {est / 60:.1f} 分钟（按 4.8s/条 估算）", flush=True)

    write_header = fresh or not completed_set
    mode = "w" if write_header else "a"
    started = time.time()
    failures = 0
    # token 累计值跨续传累加（明细 CSV 不记录 token，故存进度 JSON）
    tok_in = int(progress.get("totalInputTokens", 0) or 0)
    tok_out = int(progress.get("totalOutputTokens", 0) or 0)

    with open(csv_path, mode, encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=RESULT_COLUMNS)
        if write_header:
            writer.writeheader()
        f.flush()

        for idx, row in enumerate(pending, start=1):
            number = str(row["number"])
            gt_topics = split_topics(row.get("gt_topics", ""))
            gt_severity = (row.get("gt_severity") or "").strip()

            payload, elapsed, error = call_triage(
                row.get("title", "") or "", row.get("body", "") or "")

            if payload is None:
                failures += 1
                failed = SampleResult(number=number, gt_topics=gt_topics,
                                      gt_severity=gt_severity,
                                      latency_ms=elapsed, ok=False, error=error or "")
                writer.writerow(failed.to_row())
                f.flush()
                progress.setdefault("failed", []).append(
                    {"number": number, "error": error})
                print(f"    [失败] number={number} {error}", flush=True)
            else:
                result = parse_response(payload, gt_topics, gt_severity,
                                        number, elapsed)
                results.append(result)
                writer.writerow(result.to_row())
                f.flush()          # 每条落盘，进程被中断也不丢已完成部分
                completed_set.add(number)
                tok_in += result.input_tokens
                tok_out += result.output_tokens

            if idx % PROGRESS_EVERY == 0 or idx == len(pending):
                done = len(results)
                print(f"[{label}] 进度 {idx}/{len(pending)}"
                      f"（累计完成 {done}/{len(rows)}，"
                      f"用时 {(time.time() - started) / 60:.1f} 分钟）", flush=True)

            time.sleep(SLEEP_BETWEEN_REQUESTS)

    progress["completed"] = sorted(completed_set, key=lambda x: int(x) if x.isdigit() else 0)
    progress["totalInputTokens"] = tok_in
    progress["totalOutputTokens"] = tok_out
    save_progress(progress_path, progress)

    stats = {
        "total": len(rows),
        "completed": len(results),
        "failed": failures,
        "elapsedSec": round(time.time() - started, 1),
        "totalInputTokens": tok_in,
        "totalOutputTokens": tok_out,
    }
    return results, stats


# ============================================================
# 指标计算
# ============================================================

def compute_metrics(results: list, run_id: str, dataset: str, stats: dict) -> dict:
    attempted = [s for s in results if s.ok]          # HTTP 成功的样本
    fallback = [s for s in attempted if s.fallback_used]
    # 降级样本的 topicCandidates=[] 与 severity 均为占位值（见 route.ts buildResult 注释），
    # 不可用于准确率与 F1 统计，故从口径中剔除；降级比例由 fallbackRate 单独观测。
    valid = [s for s in attempted if not s.fallback_used]

    n_attempted = len(attempted)
    n_valid = len(valid)

    top1_hits = sum(1 for s in valid if s.pred_topics and s.pred_topics[0] in s.gt_topics)
    top3_hits = sum(1 for s in valid if any(t in s.gt_topics for t in s.pred_topics))
    sev_hits = sum(1 for s in valid if s.pred_severity == s.gt_severity)
    # 参考口径：降级样本按「未命中」计入（topicCandidates 为空，自然计入 miss）
    top1_hits_cons = sum(1 for s in attempted
                         if s.pred_topics and s.pred_topics[0] in s.gt_topics)
    top3_hits_cons = sum(1 for s in attempted
                         if any(t in s.gt_topics for t in s.pred_topics))

    per_topic = per_class_f1(valid, TOPIC_CATEGORIES, topic_gt, topic_pred_top1)
    # Macro-F1：10 个具体类别（排除 other）的算术平均，且只用 Top-1
    macro_f1 = statistics.fmean(
        [per_topic[c]["f1"] for c in CONCRETE_TOPIC_CATEGORIES]
    ) if n_valid else 0.0
    per_severity = per_class_f1(valid, SEVERITY_LEVELS, severity_gt, severity_pred)

    latencies = [s.latency_ms for s in attempted]
    # 首次解析成功率：首次调用即成功 = 未降级 且 未重试（重试后成功不计入）
    first_try_ok = sum(1 for s in attempted if not s.fallback_used and s.retry_count == 0)
    retried = sum(1 for s in attempted if s.retry_count > 0)

    prompt_versions = sorted({s.prompt_version for s in attempted if s.prompt_version})
    model_ids = sorted({s.model_id for s in attempted if s.model_id})

    metrics = {
        "runId": run_id,
        "dataset": dataset,
        "sampleCount": n_valid,
        "attemptedCount": n_attempted,
        "failedCount": stats.get("failed", 0),
        "excludedFallbackCount": len(fallback),
        "promptVersion": "/".join(prompt_versions) or "未知",
        "modelId": "/".join(model_ids) or "未知",
        "topicTop1Accuracy": (top1_hits / n_valid) if n_valid else 0.0,
        "topicTop3HitRate": (top3_hits / n_valid) if n_valid else 0.0,
        "topicMacroF1": macro_f1,
        "perTopicF1": {c: round(per_topic[c]["f1"], 4) for c in TOPIC_CATEGORIES},
        "perTopicDetail": per_topic,
        "severityAccuracy": (sev_hits / n_valid) if n_valid else 0.0,
        "perSeverityF1": {c: round(per_severity[c]["f1"], 4) for c in SEVERITY_LEVELS},
        "perSeverityDetail": per_severity,
        "severityConfusionMatrix": severity_confusion(valid, SEVERITY_LEVELS),
        "totalInputTokens": int(stats.get("totalInputTokens", 0)),
        "totalOutputTokens": int(stats.get("totalOutputTokens", 0)),
        "totalTokens": int(stats.get("totalInputTokens", 0))
                       + int(stats.get("totalOutputTokens", 0)),
        "parseSuccessRate": (first_try_ok / n_attempted) if n_attempted else 0.0,
        "retryRate": (retried / n_attempted) if n_attempted else 0.0,
        "fallbackRate": (len(fallback) / n_attempted) if n_attempted else 0.0,
        "avgLatencyMs": round(statistics.fmean(latencies), 1) if latencies else 0.0,
        "p95LatencyMs": round(percentile_nearest_rank(latencies, 0.95), 1),
        # 参考：降级按未命中计入时的 Top-1 / Top-3
        "topicTop1AccuracyWithFallbackAsMiss":
            (top1_hits_cons / n_attempted) if n_attempted else 0.0,
        "topicTop3HitRateWithFallbackAsMiss":
            (top3_hits_cons / n_attempted) if n_attempted else 0.0,
    }
    return metrics


def severity_confusion(samples: list, levels: list) -> dict:
    """严重度混淆矩阵：行 = 预测档，列 = 标准答案档。"""
    matrix = {p: {g: 0 for g in levels} for p in levels}
    for s in samples:
        p = s.pred_severity if s.pred_severity else "(空)"
        g = s.gt_severity if s.gt_severity else "(空)"
        matrix.setdefault(p, {g: 0 for g in levels})
        matrix[p][g] = matrix[p].get(g, 0) + 1
    return matrix


def compute_adversarial(results: list, stats: dict = None) -> dict:
    """对抗集：只看是否被正确标记为信息不足，不计入主集准确率。"""
    stats = stats or {}
    attempted = [s for s in results if s.ok]
    valid = [s for s in attempted if not s.fallback_used]
    flagged = [s for s in valid if s.info_sufficiency == "insufficient"]
    dist = {}
    for s in valid:
        dist[s.info_sufficiency] = dist.get(s.info_sufficiency, 0) + 1
    return {
        "sampleCount": len(valid),
        "correctlyFlaggedRate": (len(flagged) / len(valid)) if valid else 0.0,
        "correctlyFlagged": len(flagged),
        "avgTop1TopicConfidenceOnInsufficient":
            round(statistics.fmean([s.confidence for s in flagged]), 4) if flagged else 0.0,
        "infoSufficiencyDistribution": dist,
        "excludedFallbackCount": len(attempted) - len(valid),
        "totalInputTokens": stats.get("totalInputTokens", 0),
        "totalOutputTokens": stats.get("totalOutputTokens", 0),
    }


# ============================================================
# 报告输出
# ============================================================

def judge(value: float, rule: tuple) -> str:
    op, target = rule
    ok = value >= target if op == "ge" else value <= target
    return "达标" if ok else "未达标"


def print_metrics_report(metrics: dict, adv: dict, dataset_versions: dict,
                         run_id: str, started_at: str) -> None:
    line = "=" * 78
    print("\n" + line)
    print("批次配置（EvalConfig）")
    print(line)
    print(f"  runId            : {run_id}")
    print(f"  promptVersion    : {metrics['promptVersion']}（从响应 meta 读取）")
    print(f"  modelId          : {metrics['modelId']}（从响应 meta 读取）")
    print(f"  数据集版本        : {dataset_versions['main']}")
    print(f"                     对抗集 {dataset_versions['adversarial']}")
    print(f"                     查重集 {dataset_versions['dup']}")
    print(f"  执行时间          : {started_at} → {now_iso()}")
    print(f"  样本数            : 主集 {metrics['sampleCount']} 条"
          f"（调用 {metrics['attemptedCount']}，失败 {metrics['failedCount']}，"
          f"降级剔除 {metrics['excludedFallbackCount']}）")
    print(f"  配置              : retrievalTopK={EVAL_CONFIG['retrievalTopK']}, "
          f"dupThreshold={EVAL_CONFIG['dupThreshold']}, "
          f"temperature={EVAL_CONFIG['temperature']}, "
          f"maxInputTokens={EVAL_CONFIG['maxInputTokens']}")

    print("\n" + line)
    print("主评测集指标")
    print(line)
    rows = [
        ("topicTop1Accuracy", "Top-1 准确率", metrics["topicTop1Accuracy"],
         TARGETS.get("topicTop1Accuracy")),
        ("topicTop3HitRate", "Top-3 命中率", metrics["topicTop3HitRate"],
         TARGETS.get("topicTop3HitRate")),
        ("topicMacroF1", "Macro-F1（10 类 / Top-1）", metrics["topicMacroF1"], None),
        ("severityAccuracy", "严重度准确率", metrics["severityAccuracy"], None),
        ("parseSuccessRate", "首次解析成功率", metrics["parseSuccessRate"],
         TARGETS.get("parseSuccessRate")),
        ("retryRate", "重试率", metrics["retryRate"], None),
        ("fallbackRate", "降级率", metrics["fallbackRate"],
         TARGETS.get("fallbackRate")),
    ]
    print(f"{'指标':<26}{'实测':>12}   {'阈值':<16}{'判定':<8}")
    print("-" * 78)
    for key, label, value, rule in rows:
        shown = f"{value:.4f}" if key == "topicMacroF1" else pct(value)
        if rule is None:
            print(f"{label:<26}{shown:>12}   {'-':<16}{'-':<8}")
        else:
            op, target = rule
            text = f"{'>=' if op == 'ge' else '<='} {pct(target)}"
            print(f"{label:<26}{shown:>12}   {text:<16}{judge(value, rule):<8}")
    print(f"{'平均延迟':<26}{metrics['avgLatencyMs']:>10.1f}ms")
    print(f"{'P95 延迟':<26}{metrics['p95LatencyMs']:>10.1f}ms")

    print("\n" + line)
    print("与人工基线对照（基线来源 PD-12）")
    print(line)
    print(f"{'指标':<16}{'本批次':>12}{'人工基线':>12}{'差值':>12}")
    print("-" * 78)
    pairs = [
        ("Top-1 准确率", metrics["topicTop1Accuracy"], HUMAN_BASELINE["top1"]),
        ("Top-3 命中率", metrics["topicTop3HitRate"], HUMAN_BASELINE["top3"]),
        ("严重度准确率", metrics["severityAccuracy"], HUMAN_BASELINE["severity"]),
    ]
    for label, value, baseline in pairs:
        print(f"{label:<16}{pct(value):>12}{pct(baseline):>12}"
              f"{pp(value - baseline):>12}")

    print("\n" + line)
    print("逐类 F1（11 类，含 other；Macro-F1 仅取前 10 类）")
    print(line)
    print(f"{'类别':<14}{'F1':>10}{'TP':>8}{'FP':>8}{'FN':>8}{'gt 样本':>10}{'预测数':>10}")
    print("-" * 78)
    for cls in TOPIC_CATEGORIES:
        d = metrics["perTopicDetail"][cls]
        mark = "" if cls in CONCRETE_TOPIC_CATEGORIES else "  ← 不计入 Macro-F1"
        print(f"{cls:<14}{d['f1']:>10.4f}{d['tp']:>8}{d['fp']:>8}{d['fn']:>8}"
              f"{d['support']:>10}{d['predicted']:>10}{mark}")

    print("\n" + line)
    print("严重度逐档 F1（4 档）")
    print(line)
    print(f"{'档位':<14}{'F1':>10}{'TP':>8}{'FP':>8}{'FN':>8}{'gt 样本':>10}{'预测数':>10}")
    print("-" * 78)
    for lvl in SEVERITY_LEVELS:
        d = metrics["perSeverityDetail"][lvl]
        print(f"{lvl:<14}{d['f1']:>10.4f}{d['tp']:>8}{d['fp']:>8}{d['fn']:>8}"
              f"{d['support']:>10}{d['predicted']:>10}")

    print("\n" + line)
    print("严重度混淆矩阵（行 = 预测档，列 = 标准答案档）")
    print(line)
    matrix = metrics["severityConfusionMatrix"]
    pred_levels = list(matrix.keys())
    print(f"{'预测\\标准':<12}" + "".join(f"{g:>10}" for g in SEVERITY_LEVELS)
          + f"{'行合计':>10}")
    print("-" * 78)
    for p in pred_levels:
        total = sum(matrix[p].values())
        print(f"{p:<12}"
              + "".join(f"{matrix[p].get(g, 0):>10}" for g in SEVERITY_LEVELS)
              + f"{total:>10}")

    print("\n" + line)
    print(f"对抗测试集（{adv['sampleCount']} 条，另跑，不计入上述准确率）")
    print(line)
    print(f"  correctlyFlagged（标记为 insufficient）: "
          f"{pct(adv['correctlyFlaggedRate'])}  "
          f"({adv['correctlyFlagged']}/{adv['sampleCount']})")
    print(f"  insufficient 样本上的 Top-1 主题置信度均值: "
          f"{adv['avgTop1TopicConfidenceOnInsufficient']:.4f}")
    print(f"  infoSufficiency 分布                  : "
          f"{adv['infoSufficiencyDistribution']}")
    if adv["excludedFallbackCount"]:
        print(f"  降级样本已剔除                        : "
              f"{adv['excludedFallbackCount']} 条")


# ============================================================
# 查重评测段（PD-10 D-18）
# ============================================================

def run_duplicate_eval(run_id: str, args) -> dict:
    """
    Recall@5 评测。

    口径（D-18）：
      - match_issues 传 match_count = 6；
      - 脚本内剔除 number == D 自身的结果，再取前 5；
      - 命中 = 原单 O 的 number 出现在这 5 条中。
    理由：37 对中 26 对（70%）的 D 自身也在检索库内，检索必然命中自身（sim≈1.0），
    会占用一个候选位。真实场景查询对象是新提交的缺陷、不在库内，Top-5 全为有效候选。
    不剔除等于凭空少一个候选位，Recall@5 被系统性低估且与真实场景不可比。
    剔除逻辑只在本脚本内实现，生产 SQL 函数保持 Top-5（命中自身在生产是有价值的提示）。
    """
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    try:
        import psycopg2
        from generate_embeddings import (
            DIMENSIONS, embed_batch, load_env_local, db_url,
        )
    except ImportError as e:
        print(f"[查重] 依赖缺失（{e}），跳过查重评测段。"
              f"可用 --skip-dup 显式跳过。", flush=True)
        return {}

    load_env_local()
    pairs = load_rows(DUP_CSV)
    if args.limit is not None:
        pairs = pairs[: args.limit]

    print("\n" + "=" * 78)
    print("查重评测段（PD-10 D-18）")
    print("=" * 78)
    print(f"测试对规模：{len(pairs)} 对（目标 50 对，实际 37 对；"
          f"均为「原单 O 在检索库内」的可用对）")
    print(f"检索参数  ：match_issues(threshold={DUP_MATCH_THRESHOLD}, "
          f"match_count={DUP_MATCH_COUNT}) → 剔除自身 → 取前 {DUP_FINAL_K}")

    # ---- D 的正文：优先取检索库（DB），缺失时回退本地语料 CSV ----
    dup_numbers = [int(p["dup_number"]) for p in pairs]
    bodies = {}
    try:
        conn = psycopg2.connect(db_url())
        conn.set_session(readonly=True, autocommit=True)
        with conn.cursor() as cur:
            cur.execute(
                "select number, title, body, normalized_text from issues "
                "where number = any(%s);", (dup_numbers,))
            for num, title, body, norm in cur.fetchall():
                bodies[num] = {"title": title, "body": body or "",
                               "normalized_text": norm or ""}
        conn.close()
    except Exception as e:
        print(f"[查重] 读取检索库失败（{e}），回退本地语料 CSV", flush=True)
    if not bodies:
        for r in load_rows(CORPUS_CSV):
            if int(r["number"]) in dup_numbers:
                bodies[int(r["number"])] = {
                    "title": r.get("title", ""), "body": r.get("body", "") or "",
                    "normalized_text": "",
                }

    missing_body = [n for n in dup_numbers if n not in bodies]
    if missing_body:
        print(f"[查重] 警告：{len(missing_body)} 个重复单在检索库内无正文，"
              f"仅用标题生成 query embedding（{missing_body}）")

    # ---- 生成 query embedding（批量 10 条，与入库同模型同维度）----
    query_texts = []
    for p in pairs:
        num = int(p["dup_number"])
        info = bodies.get(num, {})
        title = info.get("title") or p.get("dup_title", "")
        body = info.get("body", "")
        if args.query_text == "normalized" and info.get("normalized_text"):
            text = info["normalized_text"]
        else:
            text = f"{title}\n\n{body}".strip() if body else title
        query_texts.append(text or " ")

    vectors = []
    print(f"[查重] 生成 {len(query_texts)} 条 query embedding"
          f"（模型与入库一致，维度 {DIMENSIONS}）", flush=True)
    for i in range(0, len(query_texts), 10):
        chunk = query_texts[i:i + 10]
        batch, _used = embed_batch(chunk)     # 返回 (vectors, tokens)
        vectors.extend(batch)
        print(f"    进度 {min(i + 10, len(query_texts))}/{len(query_texts)}", flush=True)

    # ---- 检索 ----
    def vec_literal(vec) -> str:
        return "[" + ",".join(f"{x:.7f}" for x in vec) + "]"

    conn = psycopg2.connect(db_url())
    conn.set_session(readonly=True, autocommit=True)
    detail_rows, self_hit_pairs, sims = [], 0, []
    try:
        with conn.cursor() as cur:
            for p, vec in zip(pairs, vectors):
                dup_num = int(p["dup_number"])
                target_num = int(p["target_number"])
                cur.execute("select * from match_issues(%s::vector, %s, %s);",
                            (vec_literal(vec), DUP_MATCH_THRESHOLD, DUP_MATCH_COUNT))
                raw = cur.fetchall()          # (number, title, html_url, similarity)
                raw_nums = [r[0] for r in raw]
                had_self = dup_num in raw_nums
                if had_self:
                    self_hit_pairs += 1
                filtered = [r for r in raw if r[0] != dup_num][:DUP_FINAL_K]
                cand_nums = [r[0] for r in filtered]
                hit = target_num in cand_nums
                rank = cand_nums.index(target_num) + 1 if hit else 0
                top_sim = float(filtered[0][3]) if filtered else 0.0
                sims.append(top_sim)
                detail_rows.append({
                    "dup_number": dup_num,
                    "target_number": target_num,
                    "hit": str(hit).lower(),
                    "target_rank": rank,
                    "dup_self_in_raw_top6": str(had_self).lower(),
                    "self_filtered_count": len(raw) - len(
                        [r for r in raw if r[0] != dup_num]),
                    "top1_similarity": f"{top_sim:.4f}",
                    "top5_numbers": "|".join(str(n) for n in cand_nums),
                    "top5_similarity": "|".join(f"{float(r[3]):.4f}" for r in filtered),
                })
    finally:
        conn.close()

    if not detail_rows:
        print("[查重] 无结果，跳过统计。")
        return {}

    total = len(pairs)
    hits = sum(1 for r in detail_rows if r["hit"] == "true")
    recall = hits / total if total else 0.0

    # 精确率：阈值未扫描（D-09），此处按 DUP_THRESHOLD_INITIAL 给参考值。
    # 注：37 对全部为真重复对，无真负例，该参考值偏高，仅作量级参考。
    flagged = [r for r in detail_rows
               if float(r["top1_similarity"]) >= EVAL_CONFIG["dupThreshold"]]
    flagged_hit = sum(1 for r in flagged if r["hit"] == "true")
    precision = (flagged_hit / len(flagged)) if flagged else None

    out_path = os.path.join(DATA_DIR, f"eval_dup_results_{run_id}.csv")
    with open(out_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(detail_rows[0].keys()))
        writer.writeheader()
        writer.writerows(detail_rows)

    print(f"\n  duplicateRecallAt5   : {pct(recall)}  ({hits}/{total})")
    if precision is None:
        print(f"  duplicatePrecision   : 未计算（阈值 {EVAL_CONFIG['dupThreshold']} "
              f"下无样本被判为重复；阈值扫描留待 D-09）")
    else:
        print(f"  duplicatePrecision   : {pct(precision)}  "
              f"({flagged_hit}/{len(flagged)})，阈值 "
              f"{EVAL_CONFIG['dupThreshold']}，参考值")
    print(f"  D 自身命中原始 Top-6 : {self_hit_pairs}/{total} 对"
          f"（已剔除，不占候选位）")
    if sims:
        print(f"  首候选相似度         : 最小 {min(sims):.4f} / "
              f"中位 {statistics.median(sims):.4f} / 最大 {max(sims):.4f}")
    print(f"  逐对明细             : {os.path.relpath(out_path, ROOT)}")
    print("\n  口径说明：")
    print("    1. 实际测试对规模 37 对（目标 50 对），且检索库覆盖不完整 "
          "（193 对中仅 37 对的原单在库内）；")
    print("    2. 上述召回率是在该不完备前提下测得，不代表生产环境真实水平；")
    print("    3. 精确率仅在真重复对上测得（无真负例），须待 D-09 阈值扫描后重估。")

    return {
        "duplicateRecallAt5": round(recall, 4),
        "hits": hits,
        "pairs": total,
        "duplicatePrecision": (round(precision, 4)
                               if precision is not None else None),
        "precisionThreshold": EVAL_CONFIG["dupThreshold"],
        "flaggedPairs": len(flagged),
        "selfHitPairs": self_hit_pairs,
        "pairsWithoutBody": len(missing_body),
        "matchCount": DUP_MATCH_COUNT,
        "finalK": DUP_FINAL_K,
        "detailPath": os.path.relpath(out_path, ROOT),
    }


# ============================================================
# 主流程
# ============================================================

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="分诊接口批量评测（PD-05 第 4 节口径）")
    p.add_argument("--run-id", default=None,
                   help="批次标识；省略时自动生成。指定已存在的 runId 即断点续传")
    p.add_argument("--limit", type=int, default=None, help="每个数据集只跑前 N 条（冒烟用）")
    p.add_argument("--fresh", action="store_true", help="忽略已有结果，从头重跑")
    p.add_argument("--skip-dup", action="store_true", help="跳过查重评测段")
    p.add_argument("--only-dup", action="store_true", help="只跑查重评测段")
    p.add_argument("--query-text", choices=["title_body", "normalized"],
                   default="title_body",
                   help="查重 query 文本来源：title_body（默认，依 PD-10 D-18）"
                        "/ normalized（与入库字段一致）")
    return p


def start_console_log(path: str) -> str:
    """
    把 stdout 同步写入 data/eval_console_{runId}.log。

    日志含评测集样本编号，按 PD-08 第 4.2 节评测集不公开；data/ 已被
    .gitignore 忽略，写入此处可避免误提交。落盘失败不影响评测执行。
    """
    try:
        f = open(path, "w", encoding="utf-8")
    except OSError:
        return ""

    original = sys.stdout

    class _Tee:
        def write(self, data):
            original.write(data)
            f.write(data)

        def flush(self):
            original.flush()
            f.flush()

    sys.stdout = _Tee()
    return path


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    args = build_parser().parse_args()
    run_id = args.run_id or f"run-{datetime.now():%Y%m%d-%H%M%S}"
    started_at = now_iso()
    console_log = start_console_log(
        os.path.join(DATA_DIR, f"eval_console_{run_id}.log"))

    dataset_versions = {
        "main": f"eval_set_main.csv[{len(load_rows(MAIN_CSV))}行,"
                f"sha:{file_fingerprint(MAIN_CSV)}]",
        "adversarial": f"eval_set_adversarial.csv[{len(load_rows(ADV_CSV))}行,"
                       f"sha:{file_fingerprint(ADV_CSV)}]",
        "dup": f"dup_testset.csv[{len(load_rows(DUP_CSV))}行,"
               f"sha:{file_fingerprint(DUP_CSV)}]",
    }

    print("=" * 78)
    print("分诊接口批量评测")
    print("=" * 78)
    print(f"runId        : {run_id}")
    print(f"接口         : {API_URL}（端到端 HTTP，逐条串行）")
    if console_log:
        print(f"控制台日志   : {os.path.relpath(console_log, ROOT)}")
    print(f"数据集版本   : {dataset_versions['main']}")
    print(f"               {dataset_versions['adversarial']}")
    print(f"               {dataset_versions['dup']}")

    dup_metrics = {}
    if args.only_dup:
        dup_metrics = run_duplicate_eval(run_id, args)
        print("\n完成（仅查重评测段）。")
        return

    if not check_server_up():
        print("\n" + "!" * 78)
        print("dev server 未运行（无法连接 http://localhost:3000/api/triage）。")
        print("请先在项目目录下手动启动：")
        print("    cd bug-triage-assistant && npm run dev")
        print("确认 http://localhost:3000 可访问后重新执行本脚本。")
        print("本脚本不会自行启动后台进程。")
        print("!" * 78)
        sys.exit(1)

    main_rows = load_rows(MAIN_CSV)
    adv_rows = load_rows(ADV_CSV)
    wall_started = time.time()

    main_results, main_stats = run_dataset(main_rows, "main", run_id, args)
    metrics = compute_metrics(main_results, run_id, "main", main_stats)

    print("\n" + "-" * 78)
    adv_results, adv_stats = run_dataset(adv_rows, "adversarial", run_id, args)
    adv = compute_adversarial(adv_results, adv_stats)

    if not args.skip_dup:
        dup_metrics = run_duplicate_eval(run_id, args)
    else:
        print("\n[查重] 已按 --skip-dup 跳过。")

    print_metrics_report(metrics, adv, dataset_versions, run_id, started_at)

    # ---- 汇总落盘 ----
    summary = {
        "runId": run_id,
        "runLabel": run_id,
        "createdAt": started_at,
        "finishedAt": now_iso(),
        "promptVersion": metrics["promptVersion"],
        "modelId": metrics["modelId"],
        "config": EVAL_CONFIG,
        "datasetVersions": dataset_versions,
        "sampleCount": metrics["sampleCount"],
        "metrics": {k: v for k, v in metrics.items()
                    if k not in ("perTopicDetail", "perSeverityDetail")},
        "adversarial": adv,
        "duplicate": dup_metrics,
        "totals": {
            "wallClockSec": round(time.time() - wall_started, 1),
            "mainElapsedSec": main_stats.get("elapsedSec", 0),
            "adversarialElapsedSec": adv_stats.get("elapsedSec", 0),
            "modelCalls": metrics["attemptedCount"] + adv.get("sampleCount", 0),
            "inputTokens": metrics["totalInputTokens"]
                           + adv.get("totalInputTokens", 0),
            "outputTokens": metrics["totalOutputTokens"]
                            + adv.get("totalOutputTokens", 0),
            "totalTokens": metrics["totalInputTokens"]
                           + adv.get("totalInputTokens", 0)
                           + metrics["totalOutputTokens"]
                           + adv.get("totalOutputTokens", 0),
        },
        "artifacts": {
            "main": os.path.relpath(paths_for(run_id, "main")[0], ROOT),
            "adversarial": os.path.relpath(paths_for(run_id, "adversarial")[0], ROOT),
        },
    }
    metrics_path = os.path.join(DATA_DIR, f"eval_metrics_{run_id}.json")
    with open(metrics_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print("\n" + "=" * 78)
    print("落盘产物")
    print("=" * 78)
    print(f"  逐条明细（主集）  : {summary['artifacts']['main']}")
    print(f"  逐条明细（对抗集）: {summary['artifacts']['adversarial']}")
    if dup_metrics:
        print(f"  逐对明细（查重）  : {dup_metrics['detailPath']}")
    print(f"  汇总指标 + 配置   : {os.path.relpath(metrics_path, ROOT)}")
    print(f"  断点进度          : "
          f"{os.path.relpath(paths_for(run_id, 'main')[1], ROOT)}")

    t = summary["totals"]
    print("\n" + "=" * 78)
    print("总消耗")
    print("=" * 78)
    print(f"  模型调用次数      : {t['modelCalls']} 次（主集 "
          f"{metrics['attemptedCount']} + 对抗集 {adv.get('sampleCount', 0)}）")
    print(f"  输入 token        : {t['inputTokens']}")
    print(f"  输出 token        : {t['outputTokens']}")
    print(f"  合计 token        : {t['totalTokens']}")
    print(f"  总耗时（端到端）  : {t['wallClockSec']} 秒 "
          f"（{t['wallClockSec'] / 60:.1f} 分钟；主集 {t['mainElapsedSec']}s，"
          f"对抗集 {t['adversarialElapsedSec']}s，其余为查重段）")

    print("\n口径提示：")
    print("  1. Macro-F1 使用 Top-1、且排除 other 类（10 个具体类别）；")
    print("  2. 降级样本的 topic / severity 为占位值，已从准确率与 F1 中剔除，"
          "由 fallbackRate 单独观测；")
    print("     同批给出「降级按未命中计入」的 Top-1 / Top-3 参考值，见 JSON 的 "
          "topicTop1AccuracyWithFallbackAsMiss。")
    print("  3. 明细 CSV 的 confidence 列 = Top-1 候选置信度；"
          "latency_ms 取响应 meta.latencyMs（服务端口径）。")
    print("  4. avgCostPer100 未计算：缺模型单价表，需时按 input/output token 与单价补算。")


if __name__ == "__main__":
    main()
