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
 *
 * 本文件的界面取舍几乎全部来自 D21 的一次真实用户实测（1 位用户），而非设计偏好：
 * 每一处提示文案都能追溯到用户当时的一句误解。改文案前请先读对应位置的注释，
 * 那里的实测证据是本项目真正的工程资产，别处查不到。
 *
 * 注释只记 Why：为什么这么写、踩过什么坑、实测数据是多少、不这么做会怎样；
 * 不记 What（代码本身已在做的事）。宁可少而准，不为凑密度写复述式注释。
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

/**
 * 严重度准确率标注（硬性要求，不得省略）。
 *
 * 为什么必须写：严重度四档判定经六批实验验证存在能力上限——
 * 当前准确率 44.29%，低于「一律猜最常见的那一档」的朴素基线 56.43%。
 * 也就是说这个字段目前不如瞎猜，只能当参考值，绝不能当结论用。
 *
 * 不标注的话，用户会把「崩溃」这个红底徽章当成已验证的事实直接拿去排期。
 * 因此这行小字必须与徽章同屏出现，删掉、变灰或移进折叠区都视为违约。
 */
const SEVERITY_ACCURACY_NOTE = "参考值 · 实测准确率约 44%";

/**
 * 模块候选百分比口径标注（硬性要求，不得省略）。
 *
 * 实测（D21，1 位真实用户）：用户把 95% 理解为「这条判断有 95% 概率是对的」，
 * 实际那是模型自报置信度（中位 98%，而真实 Top-1 准确率仅 73%，
 * 280 条中无一条低于 0.75），是失真的信号，不能当可靠性依据用。
 * 因此必须在看得到数字的位置说明它只表示候选之间的相对强弱。
 */
const TOPIC_CONFIDENCE_NOTE =
  "百分比表示候选之间的相对强弱，不代表这条判断正确的概率";

/**
 * 契约枚举 → 中文标签。
 *
 * 为什么用 Record<TopicCategory, string> 而不是普通对象：
 * 契约新增或改名一个模块档位时，这里会直接编译报错，不会漏翻、也不会留下 undefined 标签。
 * 界面一律不自创契约里没有的档位——模块归属是评测口径，多一个少一个都会让界面与评测对不上。
 */
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

/**
 * 四档配色只承载「档位高低」这一个信息，不承载「判定可靠」的含义——
 * 可靠性由旁边的准确率标注单独说明。两者不混用：
 * 颜色越醒目只表示越严重，不表示这个严重度判得越准。
 */
const SEVERITY_STYLES: Record<SeverityLevel, string> = {
  crash: "bg-red-100 text-red-800 ring-red-300",
  high: "bg-orange-100 text-orange-800 ring-orange-300",
  normal: "bg-sky-100 text-sky-800 ring-sky-300",
  low: "bg-slate-100 text-slate-700 ring-slate-300",
};

/**
 * 为什么这里用 as const 而不是 Record<InfoSufficiency, string>：
 * 信息充分度只作展示，不参与任何界面分支——触发判定直接读 result.infoSufficiency
 * （见 evaluateManualReview），文案与枚举不绑定也不会出现漏档位。
 * 好处是契约后续调整充分度命名时，界面不必跟着改。
 */
const SUFFICIENCY_LABELS = {
  sufficient: "信息充分",
  partial: "信息部分充分",
  insufficient: "信息不足",
} as const;

/**
 * 为什么用判别联合而不是多个 boolean（isLoading / isError / result）：
 * 多个 boolean 会允许「正在加载且已失败」这类非法组合，渲染时只能靠 if 的书写顺序兜底；
 * 判别联合让非法状态无法被表示，且 success 态下 result 一定有值，不必再写非空断言。
 */
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
  /**
   * 保存最近一次真正发出的请求内容，供错误态「重试」复用。
   *
   * 为什么存「已发出的内容」而不是输入框当前值：失败后用户可能已经改动了输入，
   * 重试必须重放当初那一次请求，否则既复现不了报错，也分不清是偶发还是必现。
   */
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

      // 解析失败不能直接抛：网关或代理在超时、5xx 时常返回一段 HTML 错误页，
      // 若在此抛出，就会用「无法连接」盖掉真正有用的 HTTP 状态码分支。
      // 因此解析一律降级为 null，交给下面的 !response.ok 统一处理。
      const payload: unknown = await response.json().catch(() => null);

      // 优先取后端错误码：RATE_LIMITED / MODEL_UNAVAILABLE 这类码比 HTTP 状态更能定位问题，
      // 取不到时才退回 HTTP_${status}，保证界面永远不会出现没有码的错误态。
      if (!response.ok) {
        const error = (payload as ErrorResponse | null)?.error;
        setView({
          status: "error",
          code: error?.code ?? `HTTP_${response.status}`,
          message: error?.message ?? `请求失败（HTTP ${response.status}）`,
        });
        return;
      }

      // 不做运行时 schema 校验：响应结构由 types/contract 与后端约定保证。
      // 且校验失败会在渲染时立刻暴露（缺字段会渲染成空白），
      // 比在界面层吞掉异常、静默展示半张卡片更容易被发现。
      setView({ status: "success", result: payload as TriageResult });
    } catch (error) {
      // 网络中断 / 跨域 / 服务未启动等 fetch 层失败：没有 HTTP 状态码可用，
      // 只能给出可操作的排查方向，不伪装成业务错误码。
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

  /**
   * 只要求标题非空：契约里 body 允许为空串（长度 0–50000），
   * 真实缺陷报告里也确实存在只有标题的情况，强制正文会把这类输入挡在门外。
   * loading 期间禁用是为了拦住重复提交——每次提交都要跑一次检索加模型调用，
   * 重复提交的代价是双倍耗时与双倍 token。
   */
  const canSubmit = title.trim().length > 0 && view.status !== "loading";

  function handleSubmit() {
    if (!canSubmit) return;
    // void 掉 Promise：结果一律经 setView 反映到界面，此处 await 之后没有后续动作，
    // 留下悬空 Promise 会在 lint 与严格模式下报错。
    void runTriage({ title: title.trim(), body });
  }

  /**
   * 填充示例后主动把视图拨回 idle。
   *
   * D21 实测：用户点完示例按钮后认为「这个网页的目的已经完成了」，
   * 原因是示例一填进去，页面看起来就像已经分诊过一次。
   * 回到空态是为了让示例明确停在「待提交」这一步，
   * 主路径（输入自己的 bug）不被"已完成"的错觉掩盖。
   */
  function fillSample(sample: SampleIssue) {
    setTitle(sample.title);
    setBody(sample.body);
    setView({ status: "idle" });
  }

  return (
    <div className="w-full flex-1 bg-slate-50 font-sans text-slate-900">
      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        {/*
          导航只放两个外链：指标口径与已知限制全部外置到报告页与关于页。
          主页面的职责是完成一次分诊，首屏若被免责声明占满，输入区就会被挤下去。
        */}
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
          {/*
            这句说明同时承担两个作用：说清"能得到什么"，以及声明"只是辅助建议"。
            后半句不可删——所有判定均为辅助建议、最终归类由人工确认，
            这是本工具对外的统一口径，报告页与关于页也是同一说法。
          */}
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
          {/*
            maxLength 与契约长度上限对齐（title 1–500、body 0–50000）：
            在输入框先夹一道，而不是等提交后被 BODY_TOO_LONG 打回。
            超限输入往往是粘贴进来的整段日志，写完才发现被拒的代价更高。
          */}
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
            {/* 「越完整判定越准」不是客套话：信息充分度是低置信提示的主触发条件之一，
                正文越完整越不容易被判成信息不足（见 evaluateManualReview）。 */}
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
            {/*
              字数与耗时预期放在按钮同一行：提交前最后一刻的犹豫
              （内容是不是太长、点下去是不是卡住了）在这一行就能消解，
              不必移开视线去找说明。
            */}
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

/**
 * 示例一键填充。
 *
 * D21 实测：用户点完示例按钮后认为「这个网页的目的已经完成了」，
 * 没有意识到下一步应该换成自己的 bug。示例的本意是降低门槛
 * （没有现成素材也能立刻看到效果），但不能盖住主路径。
 *
 * 因此标题与说明都写明示例只是演示、看完要换自己的内容；
 * 但不删按钮、不提高使用成本——降低门槛的作用仍需保留。
 */
function SamplePicker({
  onPick,
  disabled,
}: {
  onPick: (sample: SampleIssue) => void;
  disabled: boolean;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-medium text-slate-800">
        示例缺陷（点击填入）—— 先看效果，换成你自己的 bug 试试
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        示例只是演示：取自评测集真实记录，覆盖不同模块。看完效果后，把标题和正文换成你自己的缺陷再点「开始分诊」。
        末条为信息不足样本，用于查看低置信提示。
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

/**
 * 空态不留白屏，是四态之一。
 *
 * 一进页面就渲染结果区，是为了让「填完会得到什么」有明确的位置预期；
 * 留白会让首次访问的人分不清这里是加载中还是出错了。
 * 引导同时指向输入区与示例按钮——与 SamplePicker 的引导是同一条主路径。
 */
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

/**
 * 加载态：骨架屏 + 明确耗时预期。
 *
 * 为什么写明「约 5 秒」：v2.0 单次端到端实测约 5 秒，不写预期的话用户会在两三秒时
 * 以为卡住而重复提交——每次提交都要跑一次检索与模型调用，重复提交的代价是双倍耗时与 token。
 *
 * 为什么骨架的三块与结果卡片的三块（模块 / 严重度 / 相似 Issue）一一对应：
 * 骨架只占位不表达内容，但块数与大致高度一致，结果返回时布局不跳动，
 * 用户不会误以为页面被重排、怀疑看到的是另一次请求的结果。
 *
 * aria-busy / aria-live 是给读屏用户的等价信息：视觉上有转圈，
 * 听觉上也要知道「正在加载」而不是页面无响应。
 */
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

/**
 * 错误态。
 *
 * role="alert" 是硬性要求：分诊失败属于需要立刻被感知的阻断性结果，
 * 不能被读屏软件当普通文本跳过。
 *
 * 为什么必须给「重试」并复用 lastSubmission：一次分诊约 5 秒、内容还要手动粘贴，
 * 失败后让人重填一遍的代价远高于重试本身；且重试重放的是当初那次请求，
 * 否则偶发失败永远无法复现。
 */
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

/**
 * 结果卡片的装配顺序是有讲究的：
 *   琥珀横幅（建议人工确认）→ 降级红标 → 结果卡片 → 元信息。
 *
 * 需要人工介入的信息一律放在最上方、先于任何判定值出现：
 * 否则用户会先读到模块与严重度，把「已经看完结论」当成既定事实，
 * 再看到提示时已经不会回头改判断了。
 */
function ResultCard({ result }: { result: TriageResult }) {
  const top1 = result.topicCandidates[0];
  const review = evaluateManualReview(result);

  /**
   * 结果卡片内不再渲染 references（原「AI 参考了什么」区块）。
   *
   * 原因：检索层一次 match_issues 的结果同时喂给 references.issues（slice 0-3）
   * 与 duplicates（slice 0-5），两者是同一批记录，内容必然重复；
   * 并列展示时条目与相似度百分比完全一致（实测 #100014 77% / #99414 71% /
   * #83236 71%），用户第一反应是「这两项是否重复推送」，反而损害可信度。
   * 可解释性说明改为并入下方的 DuplicatesSection。
   *
   * 只停前端渲染：types/contract.ts 的 references 字段、
   * app/api/triage/route.ts 的返回、lib/retrieval.ts 的 slice 口径一律不动，
   * 契约与注入给模型的内容保持原样。
   *
   * 附：references.rules 更早之前就已停止渲染——规则是标签定义文本，与缺陷描述的
   * 语义空间不同，相似度区分度低，展示会削弱可信度。v2.1 计划改为按模型候选类别名
   * 匹配规则并通过 rules-by-topic 批次评测后再议。该字段后端照常返回，本次不动。
   */

  return (
    <div className="space-y-4">
      {/* 降级红标优先：fallbackUsed 时只显示红标，不再叠加琥珀横幅 */}
      {review.showBanner && (
        <LowConfidenceBanner
          topOneConfidence={top1?.confidence}
          infoSufficiency={result.infoSufficiency}
          fallbackUsed={result.meta.fallbackUsed}
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
 * 换言之，任何低于 0.75 的数值阈值都永不触发，是死阈值；
 * 这里保留的 0.5 只是兜底，真正起作用的是 fallbackUsed 与 infoSufficiency 两个语义条件。
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

/**
 * 按真实触发来源生成一句通俗原因。
 *
 * 实测（D21）：用户看到「建议人工确认」后自行脑补成「检索库较小」，
 * 因此原因必须写明触发点本身，且不提检索库规模：
 * 本提示与参考材料的多少无关，只与这条描述的信息量、模型是否返回结果、自评置信度有关。
 */
function buildLowConfidenceCause(input: {
  fallbackUsed: boolean;
  infoSufficiency: TriageResult["infoSufficiency"];
  topOneConfidence?: number;
}): string | null {
  const causes: string[] = [];

  if (input.fallbackUsed) {
    causes.push("模型未返回有效结果");
  }

  if (input.infoSufficiency === "insufficient") {
    causes.push("这条描述的信息不足，无法可靠判断（与参考材料多少无关）");
  }

  if (
    input.topOneConfidence !== undefined &&
    input.topOneConfidence < LOW_CONFIDENCE_THRESHOLD
  ) {
    causes.push("模型自评置信度低于阈值");
  }

  return causes.length > 0 ? `原因：${causes.join("；")}。` : null;
}

/**
 * 主文案：只陈述实际触发的条件，不写「或」。
 *
 * 原为静态枚举「信息不足或置信度低于阈值（实际 X，阈值 Y）」，
 * 只触发信息不足时会输出「置信度低于阈值（实际 0.85，阈值 0.50）」这类自相矛盾的文案
 * （实测信息不足样本即如此：0.85 高于 0.50）。
 * 因此阈值数字只在置信度确实低于阈值时出现。
 */
function buildLowConfidenceHeadline(input: {
  infoSufficiency: TriageResult["infoSufficiency"];
  topOneConfidence?: number;
}): string {
  const byInsufficient = input.infoSufficiency === "insufficient";
  const confidence = input.topOneConfidence;

  // 阈值数字只在这一支出现：置信度确实低于阈值
  if (confidence !== undefined && confidence < LOW_CONFIDENCE_THRESHOLD) {
    const score = `（实际 ${formatScore(confidence)}，阈值 ${formatScore(
      LOW_CONFIDENCE_THRESHOLD,
    )}）`;
    return byInsufficient
      ? `这条描述的信息不足，且模型自评置信度低于阈值${score}，判定不可完全采纳，建议人工归类。`
      : `模型自评置信度低于阈值${score}，判定不可完全采纳，建议人工归类。`;
  }

  if (byInsufficient) {
    return "这条描述的信息不足，模型判定不可完全采纳，建议人工归类。";
  }

  // 兜底：横幅显示但两个语义条件都没命中（如降级路径），避免主文案空白
  return "模型判定不可完全采纳，建议人工归类。";
}

/**
 * 琥珀横幅。醒目样式（2px 琥珀边 + 满底琥珀）是硬性要求：
 * 它表达的是「本次判定不可直接采纳」，必须比结果卡片更先被看到。
 * 触发条件见 evaluateManualReview，主文案与原因句分别由下面两个 build* 函数生成。
 */
function LowConfidenceBanner({
  topOneConfidence,
  infoSufficiency,
  fallbackUsed,
  reasons,
}: {
  topOneConfidence?: number;
  infoSufficiency: TriageResult["infoSufficiency"];
  fallbackUsed: boolean;
  reasons: string[];
}) {
  const cause = buildLowConfidenceCause({
    fallbackUsed,
    infoSufficiency,
    topOneConfidence,
  });
  const headline = buildLowConfidenceHeadline({ infoSufficiency, topOneConfidence });

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
          <p className="mt-1 text-sm leading-6 text-amber-900">{headline}</p>
          {cause !== null && (
            <p className="mt-1 text-sm leading-6 font-medium text-amber-900">
              {cause}
            </p>
          )}
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

/**
 * 模块候选 Top-3。
 *
 * 为什么三条都列出来而不是只给 Top-1：只给一条会让用户以为模型只产出一个答案，
 * 无从判断是"险胜"还是"压倒性"；三条并列把候选间的相对差距摊开，交给人工判断。
 *
 * 为什么只有 Top-1 用深色条：视觉上强调首选，但不隐藏另两条的数值——
 * 「强调」不能被读成「只有它有可能」。
 *
 * 为什么同时显示中文标签与英文 key：日志、评测脚本、契约里用的都是英文 key，
 * 界面保留英文，用户才能把界面与后端日志直接对照。
 *
 * 进度条的 role="meter" 与 aria-label 必须保留：它是数值而不是装饰，
 * 读屏用户要拿到与视觉一致的数值，后加的口径说明不得以任何理由替换掉这些属性。
 */
function TopicSection({
  candidates,
}: {
  candidates: TriageResult["topicCandidates"];
}) {
  return (
    <div className="px-4 py-4 sm:px-5">
      <h3 className="text-sm font-semibold text-slate-800">模块候选 Top-3</h3>

      {/* 与严重度处的 SEVERITY_ACCURACY_NOTE 同一套样式，紧邻百分比数值 */}
      <p className="mt-1 text-xs leading-5 font-medium text-amber-700">
        {TOPIC_CONFIDENCE_NOTE}
      </p>

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

/**
 * 严重度。
 *
 * 为什么必须带准确率标注：见 SEVERITY_ACCURACY_NOTE——当前 44.29%，低于朴素基线 56.43%，
 * 只能当参考值。徽章越醒目，这行标注越不能省，否则醒目程度会被误读成确定程度。
 *
 * 为什么要展示 signals（命中的关键词）：严重度是模型从描述里读出来的，
 * 摊开命中信号后用户能立刻判断「它是因为看到 crash 这个词才判崩溃的」，
 * 从而决定信不信。这是目前唯一能让人复核严重度的线索。
 */
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

/**
 * 相似历史 Issue。
 *
 * 这批记录有双重身份：既是查重候选，也是注入模型、影响模块判定的材料——
 * 检索层同一批 match_issues 结果分别 slice 成 references 与 duplicates。
 * 原「AI 参考了什么」区块因此删除，可解释性说明并入本区块，详见 ResultCard 处的注释。
 *
 * 相似度用百分比（formatPercent）、阈值与置信度用两位小数（formatScore）：
 * 前者表达给用户的强弱感受，后者要能与契约常量、评测脚本、日志直接对照。
 */
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
        <>
          {/*
            原「AI 参考了什么」区块的可解释性说明，合并到此处。
            因为 references.issues 就是 duplicates 的前 3 条（见检索层 slice 口径），
            与其另起一块重复同一批记录，不如在此说明这批记录的双重身份：
            既是查重候选，也是注入模型、影响模块判定的材料。
          */}
          <p className="mt-1 text-xs leading-5 text-slate-500">
            以下是为本条缺陷检索到的相似历史 Issue，也是模型判定模块归属时读入的参照材料。
            <span className="mt-0.5 block">点击编号可查看原始 Issue。</span>
          </p>

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
        </>
      )}
    </div>
  );
}

// ---- 请求元信息（可追溯性）----

/**
 * 请求元信息。
 *
 * 为什么把 requestId / 耗时 / token / 重试次数直接摊在页面上：
 * 分诊结果本身不可复现（模型输出有随机性），用户反馈「这条判错了」时，
 * 只有 requestId 能把界面上的一次展示与后端日志里的一次调用对上。
 * 没有这行信息，任何一条问题反馈都无法定位。
 */
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

/**
 * 百分比只用于「给用户看的强弱」（模块置信度、相似度），不用于阈值。
 * 两类数字刻意分开排版：阈值要能与契约常量和评测脚本逐字对照，见 formatScore。
 */
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
