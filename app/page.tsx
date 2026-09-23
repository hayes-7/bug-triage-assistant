"use client";

/**
 * Bug 智能分诊工作台（第一批界面 · PD-10 D18 四态）
 *
 * 数据来源：只调 POST /api/triage，只依赖 types/contract 的 TriageResult。
 * 本页不引入 @/lib/supabase、不引入 @/lib/retrieval，不做任何数据库访问。
 *
 * 四态：
 *   idle    未提交 —— 展示引导文案与示例按钮，不留白屏
 *   loading 提交中 —— 骨架屏 + 明确耗时预期（v2.0 单条约 5 秒）
 *   error   失败  —— 展示错误码与文案，并提供「重试」入口（复用上次提交内容）
 *   success 成功  —— 结果卡片；命中人工复核条件时卡片上方强制显示「建议人工确认」
 *                    （判定见 evaluateManualReview）
 */

import { useCallback, useState } from "react";

import Link from "next/link";

import { SAMPLE_ISSUES, type SampleIssue } from "@/lib/sample-issues";
import {
  LOW_CONFIDENCE_THRESHOLD,
  type ErrorResponse,
  type SeverityLevel,
  type TopicCategory,
  type TriageResult,
} from "@/types/contract";

/** 严重度准确率标注（硬性要求，不得省略） */
const SEVERITY_ACCURACY_NOTE = "参考值 · 实测准确率约 44%";

const TOPIC_LABELS: Record<TopicCategory, string> = {
  editor: "编辑器",
  rendering: "渲染",
  gui: "游戏内 UI",
  gdscript: "GDScript",
  core: "核心引擎",
  platforms: "平台适配",
  animation: "动画",
  buildsystem: "编译构建",
  import: "资源导入",
  input: "输入",
  other: "其他",
};

const SEVERITY_LABELS: Record<SeverityLevel, string> = {
  crash: "崩溃",
  high: "高",
  normal: "中",
  low: "低",
};

const SEVERITY_STYLES: Record<SeverityLevel, string> = {
  crash: "bg-red-100 text-red-800 ring-red-300",
  high: "bg-orange-100 text-orange-800 ring-orange-300",
  normal: "bg-sky-100 text-sky-800 ring-sky-300",
  low: "bg-slate-100 text-slate-700 ring-slate-300",
};

const SUFFICIENCY_LABELS = {
  sufficient: "信息充分",
  partial: "信息部分充分",
  insufficient: "信息不足",
} as const;

type ViewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: TriageResult }
  | { status: "error"; message: string; code?: string };

type Submission = { title: string; body: string };

export default function TriageWorkbenchPage() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [view, setView] = useState<ViewState>({ status: "idle" });
  /** 保存最近一次真正发出的请求内容，供错误态「重试」复用 */
  const [lastSubmission, setLastSubmission] = useState<Submission | null>(null);

  const runTriage = useCallback(async (submission: Submission) => {
    setLastSubmission(submission);
    setView({ status: "loading" });

    try {
      const response = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submission),
      });

      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const error = (payload as ErrorResponse | null)?.error;
        setView({
          status: "error",
          code: error?.code ?? `HTTP_${response.status}`,
          message: error?.message ?? `请求失败（HTTP ${response.status}）`,
        });
        return;
      }

      setView({ status: "success", result: payload as TriageResult });
    } catch (error) {
      // 网络中断 / 跨域 / 服务未启动等 fetch 层失败
      setView({
        status: "error",
        code: "NETWORK_ERROR",
        message:
          error instanceof Error
            ? `无法连接分诊服务：${error.message}`
            : "无法连接分诊服务",
      });
    }
  }, []);

  const canSubmit = title.trim().length > 0 && view.status !== "loading";

  function handleSubmit() {
    if (!canSubmit) return;
    void runTriage({ title: title.trim(), body });
  }

  function fillSample(sample: SampleIssue) {
    setTitle(sample.title);
    setBody(sample.body);
    setView({ status: "idle" });
  }

  return (
    <div className="w-full flex-1 bg-slate-50 font-sans text-slate-900">
      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        <nav className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 pb-3 text-sm">
          <span className="font-semibold text-indigo-700">分诊工作台</span>
          <Link href="/report" className="font-medium text-slate-600 hover:text-indigo-700">
            评测报告
          </Link>
          <Link href="/about" className="font-medium text-slate-600 hover:text-indigo-700">
            关于
          </Link>
        </nav>

        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            Bug 智能分诊工作台
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            粘贴一条缺陷报告，得到模块 Top-3 候选、严重度参考值、相似历史 Issue，
            以及模型本次检索到的参考材料。所有判定均为辅助建议，最终归类由人工确认。
            指标与已知限制见{" "}
            <Link href="/report" className="font-medium text-indigo-700 underline">
              评测报告
            </Link>
            {" "}与{" "}
            <Link href="/about" className="font-medium text-indigo-700 underline">
              关于页
            </Link>
            。
          </p>
        </header>

        <SamplePicker onPick={fillSample} disabled={view.status === "loading"} />

        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <label className="block">
            <span className="text-sm font-medium text-slate-800">缺陷标题</span>
            <span className="ml-1 text-xs text-slate-400">必填 · 最长 500 字符</span>
            <input
              type="text"
              value={title}
              maxLength={500}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例：Crash in editor when using PlaneMesh"
              className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none"
            />
          </label>

          <label className="mt-4 block">
            <span className="text-sm font-medium text-slate-800">缺陷正文</span>
            <span className="ml-1 text-xs text-slate-400">可留空 · 越完整判定越准</span>
            <textarea
              value={body}
              maxLength={50_000}
              rows={10}
              onChange={(event) => setBody(event.target.value)}
              placeholder={"版本、系统信息、问题描述、复现步骤……"}
              className="mt-2 w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-[13px] leading-6 text-slate-900 placeholder:font-sans placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none"
            />
          </label>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-slate-500">
              正文 {body.length.toLocaleString("zh-CN")} 字符 · 单条分诊约需 5 秒
            </p>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="inline-flex w-full items-center justify-center rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300 sm:w-auto"
            >
              {view.status === "loading" ? "分诊中…" : "开始分诊"}
            </button>
          </div>
        </section>

        <div className="mt-6">
          {view.status === "idle" && <EmptyState />}
          {view.status === "loading" && <LoadingSkeleton />}
          {view.status === "error" && (
            <ErrorState
              code={view.code}
              message={view.message}
              onRetry={lastSubmission ? () => void runTriage(lastSubmission) : undefined}
            />
          )}
          {view.status === "success" && <ResultCard result={view.result} />}
        </div>
      </main>
    </div>
  );
}

// ============================================================
// 示例一键填充
// ============================================================

function SamplePicker({
  onPick,
  disabled,
}: {
  onPick: (sample: SampleIssue) => void;
  disabled: boolean;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-medium text-slate-800">示例缺陷（点击填入）</h2>
      <p className="mt-1 text-xs text-slate-500">
        取自评测集真实记录，覆盖不同模块；末条为信息不足样本，用于查看低置信提示。
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {SAMPLE_ISSUES.map((sample) => (
          <button
            key={sample.number}
            type="button"
            disabled={disabled}
            onClick={() => onPick(sample)}
            title={sample.title}
            className={`max-w-full rounded-full border px-3 py-1.5 text-left text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              sample.lowSignal
                ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
                : "border-slate-300 bg-slate-50 text-slate-700 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700"
            }`}
          >
            <span className="break-words">#{sample.number} · {sample.label}</span>
            <span className="ml-1 text-[11px] font-normal text-slate-400">
              标注 {sample.gtTopic.join(" / ")}
              {sample.gtSeverity ? ` · ${SEVERITY_LABELS[sample.gtSeverity]}` : ""}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

// ============================================================
// 空态
// ============================================================

function EmptyState() {
  return (
    <section className="rounded-xl border border-dashed border-slate-300 bg-white/60 px-4 py-10 text-center">
      <p className="text-sm font-medium text-slate-700">还没有分诊结果</p>
      <p className="mx-auto mt-2 max-w-md text-xs leading-6 text-slate-500">
        在上方填写标题与正文后点击「开始分诊」。
        <br />
        没有现成素材？点上面任意一条示例缺陷即可一键填入。
      </p>
    </section>
  );
}

// ============================================================
// 加载态（骨架屏）
// ============================================================

function LoadingSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-live="polite"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"
    >
      <div className="flex items-center gap-2">
        <span className="size-4 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
        <p className="text-sm font-medium text-slate-700">正在检索参考材料并调用模型…</p>
      </div>
      <p className="mt-1 text-xs text-slate-500">v2.0 单条约 5 秒，请稍候，不要重复提交。</p>

      <div className="mt-5 animate-pulse space-y-5">
        <div className="space-y-3">
          <div className="h-3 w-24 rounded bg-slate-200" />
          {[0, 1, 2].map((index) => (
            <div key={index} className="space-y-2">
              <div className="h-3 w-40 rounded bg-slate-200" />
              <div className="h-2 w-full rounded-full bg-slate-200" />
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <div className="h-3 w-20 rounded bg-slate-200" />
          <div className="h-6 w-28 rounded-full bg-slate-200" />
        </div>
        <div className="space-y-2">
          <div className="h-3 w-32 rounded bg-slate-200" />
          <div className="h-3 w-full rounded bg-slate-200" />
          <div className="h-3 w-5/6 rounded bg-slate-200" />
        </div>
      </div>
    </section>
  );
}

// ============================================================
// 错误态
// ============================================================

function ErrorState({
  code,
  message,
  onRetry,
}: {
  code?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <section
      role="alert"
      className="rounded-xl border border-red-300 bg-red-50 p-4 shadow-sm sm:p-5"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-red-600 text-sm font-bold text-white">
          !
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-red-900">分诊请求失败</h2>
          <p className="mt-1 text-sm break-words text-red-800">{message}</p>
          {code && (
            <p className="mt-1 font-mono text-xs text-red-700">错误码：{code}</p>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 inline-flex items-center justify-center rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-800 transition-colors hover:bg-red-100"
            >
              重试
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

// ============================================================
// 结果卡片
// ============================================================

function ResultCard({ result }: { result: TriageResult }) {
  const top1 = result.topicCandidates[0];
  const review = evaluateManualReview(result);

  /**
   * references 整块的显隐只看 issues：
   * rules 小块已按下述原因停止渲染（见 ReferencesSection），
   * 若仍把 rules 计入显隐条件，会在「只有 rules、没有 issues」时
   * 渲染出一个空容器。
   */
  const references = result.references;
  const hasReferences = references !== undefined && references.issues.length > 0;

  return (
    <div className="space-y-4">
      {/* 降级红标优先：fallbackUsed 时只显示红标，不再叠加琥珀横幅 */}
      {review.showBanner && (
        <LowConfidenceBanner
          topOneConfidence={top1?.confidence}
          reasons={review.reasons}
        />
      )}

      {result.meta.fallbackUsed && (
        <section
          role="alert"
          className="rounded-xl border-2 border-red-400 bg-red-50 p-4 text-sm text-red-900"
        >
          <p className="font-semibold">本次判定不可用（已走降级路径）</p>
          <p className="mt-1 text-xs leading-6">
            模型重试后仍未返回结果，下方的模块候选、严重度与信息充分度均为占位值，
            不是判定结论，请勿据此归类。
          </p>
        </section>
      )}

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3 sm:px-5">
          <h2 className="text-sm font-semibold text-slate-800">分诊结果</h2>
          <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200">
            {SUFFICIENCY_LABELS[result.infoSufficiency]}
          </span>
          {/*
            不写「疑似重复」：当前 isDuplicate 只由相似度阈值决定，
            缺少契约 PD-04 4.3 节要求的第三个条件「模型语义确认」，
            不构成重复结论（实测 #68923 的 Top-1 相似度 0.76 但并非同一缺陷）。
            因此只陈述相似度事实并把结论交给人工，不由界面宣称重复。
          */}
          {result.isDuplicate && result.duplicates[0] && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-300">
              相似度较高（{formatScore(result.duplicates[0].similarity)}
              ），建议人工核对是否重复
            </span>
          )}
        </div>

        <div className="divide-y divide-slate-200">
          <TopicSection candidates={result.topicCandidates} />
          <SeveritySection severity={result.severity} />
          <DuplicatesSection duplicates={result.duplicates} />
        </div>
      </section>

      {hasReferences && <ReferencesSection references={references} />}

      <MetaFooter result={result} />
    </div>
  );
}

// ---- 人工复核判定 ----

/**
 * 人工复核提示的触发判定（语义触发为主 + 阈值兜底）。
 *
 * 为什么不只靠置信度阈值：模型的置信度自评校准很差。
 * data/eval_results_with-rag.csv（v2.0，280 条）的 Top-1 置信度只有
 * 0.75 / 0.92 / 0.95 / 0.98 四个取值，最低 0.75，零条低于 0.6；
 * 实测喂入 "bug" / "???" 这类无信息输入，模型仍给出 0.70–0.95 的置信度，
 * 却同时把 infoSufficiency 判成 insufficient。
 * 即「信息是否充足」这项语义判定可用，而「置信度数值」不可用。
 * 因此以 fallbackUsed / infoSufficiency 为主触发，置信度阈值仅作兜底。
 *
 * 阈值口径：统一取契约常量 LOW_CONFIDENCE_THRESHOLD（0.5），
 * 界面不再持有独立阈值，避免与契约、评测脚本三处口径分裂。
 */
function evaluateManualReview(result: TriageResult): {
  /** 三个条件的并集，命中即需人工复核 */
  shouldShowLowConfidenceHint: boolean;
  /** 是否渲染琥珀横幅：降级时交给红标，不重复展示 */
  showBanner: boolean;
  /** 触发来源，逐条展示以说明原因 */
  reasons: string[];
} {
  const top1 = result.topicCandidates[0];

  const byFallback = result.meta.fallbackUsed;
  const byInsufficient = result.infoSufficiency === "insufficient";
  const byLowConfidence =
    top1 !== undefined && top1.confidence < LOW_CONFIDENCE_THRESHOLD;

  const shouldShowLowConfidenceHint = byFallback || byInsufficient || byLowConfidence;

  const reasons: string[] = [];
  if (byFallback) reasons.push("模型降级：本次未取得模型判定");
  if (byInsufficient) reasons.push("信息不足：描述不足以判断模块归属");
  if (byLowConfidence) {
    reasons.push(
      `低置信：Top-1 置信度 ${formatScore(top1.confidence)} 低于阈值 ${formatScore(
        LOW_CONFIDENCE_THRESHOLD,
      )}`,
    );
  }

  return {
    shouldShowLowConfidenceHint,
    showBanner: shouldShowLowConfidenceHint && !byFallback,
    reasons,
  };
}

// ---- 低置信提示（醒目样式，硬性要求）----

function LowConfidenceBanner({
  topOneConfidence,
  reasons,
}: {
  topOneConfidence?: number;
  reasons: string[];
}) {
  const actual =
    topOneConfidence === undefined ? "无模块候选" : formatScore(topOneConfidence);

  return (
    <section
      role="alert"
      className="rounded-xl border-2 border-amber-500 bg-amber-100 p-4 shadow-sm sm:p-5"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-500 text-base font-bold text-white">
          !
        </span>
        <div className="min-w-0">
          <p className="text-base font-bold text-amber-900">建议人工确认</p>
          <p className="mt-1 text-sm leading-6 text-amber-900">
            该缺陷描述信息不足或置信度低于阈值（实际 {actual}，阈值{" "}
            {formatScore(LOW_CONFIDENCE_THRESHOLD)}），模型判定不可完全采纳，建议人工归类。
          </p>
          {reasons.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs leading-5 text-amber-900">
              {reasons.map((reason) => (
                <li key={reason}>· {reason}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

// ---- a) Top-3 模块 ----

function TopicSection({
  candidates,
}: {
  candidates: TriageResult["topicCandidates"];
}) {
  return (
    <div className="px-4 py-4 sm:px-5">
      <h3 className="text-sm font-semibold text-slate-800">模块候选 Top-3</h3>

      {candidates.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">
          未产出模块候选（模型降级）。请人工归类。
        </p>
      ) : (
        <ol className="mt-3 space-y-3">
          {candidates.map((candidate, index) => (
            <li key={candidate.topic}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-xs font-semibold text-slate-400">
                  #{index + 1}
                </span>
                <span className="text-sm font-semibold text-slate-900">
                  {TOPIC_LABELS[candidate.topic]}
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  {candidate.topic}
                </span>
                <span className="ml-auto font-mono text-xs font-semibold text-indigo-700 tabular-nums">
                  {formatPercent(candidate.confidence)}
                </span>
              </div>

              {/* 置信度条：宽度按 confidence 线性映射 */}
              <div
                role="meter"
                aria-valuenow={Math.round(candidate.confidence * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${candidate.topic} 置信度`}
                className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-slate-200"
              >
                <div
                  className={`h-full rounded-full transition-[width] duration-500 ${
                    index === 0 ? "bg-indigo-600" : "bg-indigo-300"
                  }`}
                  style={{ width: `${clampPercent(candidate.confidence)}%` }}
                />
              </div>

              {candidate.reasoning && (
                <p className="mt-1.5 text-xs leading-5 break-words text-slate-500">
                  {candidate.reasoning}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ---- b) 严重度 ----

function SeveritySection({ severity }: { severity: TriageResult["severity"] }) {
  return (
    <div className="px-4 py-4 sm:px-5">
      <h3 className="text-sm font-semibold text-slate-800">严重度</h3>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={`rounded-full px-3 py-1 text-sm font-bold ring-1 ${SEVERITY_STYLES[severity.level]}`}
        >
          {SEVERITY_LABELS[severity.level]}
        </span>
        <span className="font-mono text-[11px] text-slate-400">{severity.level}</span>
        <span className="font-mono text-xs text-slate-500 tabular-nums">
          置信度 {formatPercent(severity.confidence)}
        </span>
      </div>

      {/* 硬性要求：严重度旁必须带准确率标注，不得省略 */}
      <p className="mt-2 text-xs leading-5 font-medium text-amber-700">
        {SEVERITY_ACCURACY_NOTE}
      </p>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {severity.signals.map((signal) => (
          <span
            key={signal}
            className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600"
          >
            {signal}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---- c) 相似历史 Issue（duplicates）----

function DuplicatesSection({
  duplicates,
}: {
  duplicates: TriageResult["duplicates"];
}) {
  return (
    <div className="px-4 py-4 sm:px-5">
      <h3 className="text-sm font-semibold text-slate-800">相似历史 Issue</h3>

      {duplicates.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">
          未检出相似历史 Issue。
          <span className="mt-1 block text-xs text-slate-400">
            检索库中没有相似度高于阈值的记录，或本次检索降级。
          </span>
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {duplicates.map((duplicate) => (
            <li
              key={duplicate.issueNumber}
              className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 sm:flex-row sm:items-center sm:gap-3"
            >
              <a
                href={duplicate.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs font-semibold text-indigo-700 underline decoration-dotted hover:text-indigo-900"
              >
                #{duplicate.issueNumber}
              </a>
              <span className="min-w-0 flex-1 text-sm break-words text-slate-800">
                {duplicate.title}
              </span>
              <span className="font-mono text-xs text-slate-500 tabular-nums">
                {formatPercent(duplicate.similarity)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- d) AI 参考了什么（references）----

function ReferencesSection({
  references,
}: {
  references: NonNullable<TriageResult["references"]>;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 sm:px-5">
        <h2 className="text-sm font-semibold text-slate-800">AI 参考了什么</h2>
        <p className="mt-1 text-xs text-slate-500">
          本次判定前检索到并注入提示词的材料，供核对模型依据。
        </p>
      </div>

      <div className="divide-y divide-slate-200">
        {references.issues.length > 0 && (
          <div className="px-4 py-4 sm:px-5">
            <h3 className="text-xs font-semibold tracking-wide text-slate-500">
              参考的历史 Issue
            </h3>
            <ul className="mt-2 space-y-2">
              {references.issues.map((issue) => (
                <li
                  key={issue.number}
                  className="flex flex-col gap-1 rounded-lg bg-slate-50 px-3 py-2 sm:flex-row sm:items-center sm:gap-3"
                >
                  <span className="font-mono text-xs font-semibold text-slate-600">
                    #{issue.number}
                  </span>
                  <span className="min-w-0 flex-1 text-sm break-words text-slate-800">
                    {issue.title || "（无标题）"}
                  </span>
                  {issue.similarity !== undefined && (
                    <span className="font-mono text-xs text-slate-500 tabular-nums">
                      {formatPercent(issue.similarity)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/*
          「参考的官方规则」小块已停止渲染。

          原因：规则为标签定义文本，与 Bug 描述语义空间不同，相似度区分度低；
          展示会削弱可信度。v2.1 改为按模型候选类别名匹配规则、
          并通过 rules-by-topic 批次评测后，再恢复本小块展示。

          仅前端不渲染，后端一律不动：references.rules 照常返回（契约字段保留），
          注入模型的规则内容保持不变——改注入内容属新的优化手段，
          须作为 v2.1 单独版本重评，不在本次界面取舍里夹带。
        */}
      </div>
    </section>
  );
}

// ---- 请求元信息（可追溯性）----

function MetaFooter({ result }: { result: TriageResult }) {
  const { meta } = result;
  const items: [string, string][] = [
    ["模型", meta.modelId],
    ["Prompt", meta.promptVersion],
    ["耗时", `${meta.latencyMs} ms`],
    ["Token", `${meta.inputTokens} / ${meta.outputTokens}`],
    ["重试", String(meta.retryCount)],
    ["requestId", meta.requestId],
  ];

  return (
    <footer className="rounded-xl border border-slate-200 bg-white px-4 py-3 sm:px-5">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-[11px] sm:grid-cols-2">
        {items.map(([label, value]) => (
          <div key={label} className="flex min-w-0 gap-2">
            <dt className="shrink-0 text-slate-400">{label}</dt>
            <dd className="min-w-0 truncate font-mono text-slate-600">{value}</dd>
          </div>
        ))}
      </dl>
    </footer>
  );
}

// ============================================================
// 工具函数
// ============================================================

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * 以两位小数展示 0–1 的原始分值。
 * 阈值类文案用原始分值而非百分比：阈值本身在契约与评测脚本里就是 0.5 / 0.75，
 * 界面沿用同一写法，便于与配置和日志直接对照。
 */
function formatScore(value: number): string {
  return value.toFixed(2);
}

/** 进度条宽度：0–100 之间的整数，超出区间的异常值被夹紧而不撑破容器 */
function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 100)));
}
