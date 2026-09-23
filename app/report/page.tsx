/**
 * 评测报告页（/report）
 *
 * 数据来源：lib/eval-history.ts —— 由脚本从 data/eval_metrics_*.json 逐字段抄出。
 * 本页只做格式化（百分比、小数位）与排版，不对任何数字做修正、取整美化或筛选。
 * 凡是页面上出现的指标，都能在对应 JSON 里逐字找到原值。
 *
 * 服务端组件：静态数据无交互需求，不加 "use client"，不产生客户端 JS。
 * per-topic 表按需求做成「最新批次 + 全批次并列」，一次性呈现，避免切换态。
 */

import Link from "next/link";

import {
  EVAL_RUNS,
  LATEST_RUN_ID,
  SEVERITY_NAIVE_BASELINE,
  SEVERITY_ORDER,
  TOPIC_ORDER,
  type EvalRunRecord,
} from "@/lib/eval-history";
import type { SeverityLevel, TopicCategory } from "@/types/contract";

export const metadata = {
  title: "评测报告 · Bug 智能分诊助手",
  description: "6 批受控实验的指标对比，数字与 data/eval_metrics_*.json 一致",
};

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
  crash: "崩溃 crash",
  high: "高 high",
  normal: "中 normal",
  low: "低 low",
};

/** 每批次的实验意图，便于读懂指标为何变化。不含任何指标数字 */
const RUN_INTENT: Record<string, string> = {
  "baseline-20260920": "基线批次：v1.0 纯 LLM，无检索、无严重度专项优化",
  "sev-defined": "严重度四档给出明确定义（v1.1）",
  "sev-procedural": "严重度改为程序化判定步骤 (a)-(d)（v1.2）",
  "sev-fewshot": "追加 12 条严重度 few-shot 示例（v1.3）",
  "qwen3max-v13": "换模型对比：同 v1.3 提示词，qwen3-max（成本约 5–6 倍）",
  "with-rag": "检索增强：v2.0 注入 Top-3 相似 Issue + Top-2 官方规则",
};

const latest =
  EVAL_RUNS.find((run) => run.runId === LATEST_RUN_ID) ?? EVAL_RUNS[EVAL_RUNS.length - 1];

export default function ReportPage() {
  return (
    <div className="w-full flex-1 bg-slate-50 font-sans text-slate-900">
      <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
        <NavBar />

        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">评测报告</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            6 批受控实验的指标对比。所有数字取自 <Code>data/eval_metrics_*.json</Code>
            ，未做任何修正或美化；如与 JSON 不符即为缺陷。
          </p>
        </header>

        <Conclusion />
        <MainMetricsTable />
        <PerSeverityTable />
        <PerTopicTable />
        <StabilityTable />

        <footer className="mt-8 text-xs leading-6 text-slate-500">
          指标定义见 PD-05；批次配置与数据集指纹见各 JSON 的{" "}
          <Code>config</Code> 与 <Code>datasetVersions</Code> 字段。
          局限与不可用结论详见{" "}
          <Link href="/about" className="font-medium text-indigo-700 underline">
            关于页
          </Link>
          。
        </footer>
      </main>
    </div>
  );
}

// ============================================================
// 关键结论
// ============================================================

function Conclusion() {
  const baseline = SEVERITY_NAIVE_BASELINE;

  return (
    <section className="mb-6 rounded-xl border-2 border-amber-500 bg-amber-50 p-4 shadow-sm sm:p-5">
      <h2 className="text-sm font-bold text-amber-900">关键结论</h2>
      <p className="mt-2 text-sm leading-6 text-amber-900">
        严重度未达可用水平：最新批次准确率{" "}
        <strong>{formatPercent(latest.severityAccuracy)}</strong>，低于朴素基线{" "}
        <strong>{formatPercent(baseline.accuracy)}</strong>
        （恒定输出 <Code>{baseline.majorityLevel}</Code> 即可达到，{baseline.count}/
        {baseline.total}）。即模型的严重度判定不如无脑输出多数类，不具备产品价值，
        界面上仅作参考值展示，不可作为结论使用。
      </p>
      <p className="mt-2 text-xs leading-6 text-amber-800">
        模块判定方向可用：Top-3 命中率 {formatPercent(latest.topicTop3HitRate)}、Macro-F1{" "}
        {formatDecimal(latest.topicMacroF1)}，是本项目实际交付价值所在。
      </p>
    </section>
  );
}

// ============================================================
// 1) 主指标对比表
// ============================================================

function MainMetricsTable() {
  return (
    <Panel
      title="主指标对比（6 批）"
      note="每行一个批次，按 createdAt 升序。样本数各批次不同，横向比较时须注意。"
    >
      <ScrollArea>
        <table className="w-full min-w-[54rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-300 bg-slate-50 text-left">
              <Th>批次 runId</Th>
              <Th>runLabel</Th>
              <Th>Prompt</Th>
              <Th>模型</Th>
              <Th align="right">样本数</Th>
              <Th align="right">Top-1</Th>
              <Th align="right">Top-3</Th>
              <Th align="right">Macro-F1</Th>
              <Th align="right">严重度</Th>
            </tr>
          </thead>
          <tbody>
            {EVAL_RUNS.map((run) => {
              const isLatest = run.runId === LATEST_RUN_ID;
              return (
                <tr
                  key={run.runId}
                  className={`border-b border-slate-200 ${isLatest ? "bg-indigo-50/60" : ""}`}
                >
                  <Td>
                    <span className="font-mono text-xs font-semibold">{run.runId}</span>
                    {isLatest && (
                      <span className="ml-1.5 rounded bg-indigo-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        当前线上
                      </span>
                    )}
                    <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">
                      {RUN_INTENT[run.runId] ?? ""}
                    </span>
                  </Td>
                  <Td>
                    <span className="font-mono text-xs">{run.runLabel}</span>
                  </Td>
                  <Td>
                    <span className="font-mono text-xs">{run.promptVersion}</span>
                  </Td>
                  <Td>
                    <span className="font-mono text-xs">{run.modelId}</span>
                  </Td>
                  <TdNum>{run.sampleCount}</TdNum>
                  <TdNum>{formatPercent(run.topicTop1Accuracy)}</TdNum>
                  <TdNum>{formatPercent(run.topicTop3HitRate)}</TdNum>
                  <TdNum>{formatDecimal(run.topicMacroF1)}</TdNum>
                  <TdNum
                    className={
                      run.severityAccuracy < SEVERITY_NAIVE_BASELINE.accuracy
                        ? "text-red-700"
                        : ""
                    }
                  >
                    {formatPercent(run.severityAccuracy)}
                  </TdNum>
                </tr>
              );
            })}
            <tr className="bg-slate-100">
              <Td colSpan={8}>
                <span className="text-xs font-medium text-slate-700">
                  严重度朴素基线（恒定输出 {SEVERITY_NAIVE_BASELINE.majorityLevel}，
                  {SEVERITY_NAIVE_BASELINE.count}/{SEVERITY_NAIVE_BASELINE.total}）
                </span>
              </Td>
              <TdNum className="font-bold">
                {formatPercent(SEVERITY_NAIVE_BASELINE.accuracy)}
              </TdNum>
            </tr>
          </tbody>
        </table>
      </ScrollArea>
      <p className="mt-2 text-xs leading-5 text-slate-500">
        红色表示该批次严重度准确率低于朴素基线。6 批全部低于基线。
      </p>
    </Panel>
  );
}

// ============================================================
// 2) 严重度分档 F1
// ============================================================

function PerSeverityTable() {
  return (
    <Panel
      title="严重度分档 F1（crash / high / normal / low）"
      note="分档观测的原因：severity 分布不均，整体准确率会掩盖个别档位完全失效的情况。"
    >
      <ScrollArea>
        <table className="w-full min-w-[40rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-300 bg-slate-50 text-left">
              <Th>批次</Th>
              {SEVERITY_ORDER.map((level) => (
                <Th key={level} align="right">
                  {SEVERITY_LABELS[level]}
                </Th>
              ))}
              <Th align="right">整体准确率</Th>
            </tr>
          </thead>
          <tbody>
            {EVAL_RUNS.map((run) => (
              <tr
                key={run.runId}
                className={`border-b border-slate-200 ${
                  run.runId === LATEST_RUN_ID ? "bg-indigo-50/60" : ""
                }`}
              >
                <Td>
                  <span className="font-mono text-xs">{run.runId}</span>
                </Td>
                {SEVERITY_ORDER.map((level) => (
                  <TdNum
                    key={level}
                    className={run.perSeverityF1[level] === 0 ? "text-red-700" : ""}
                  >
                    {formatDecimal(run.perSeverityF1[level])}
                  </TdNum>
                ))}
                <TdNum>{formatPercent(run.severityAccuracy)}</TdNum>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
      <p className="mt-2 text-xs leading-5 text-slate-500">
        normal 档在全部 6 批中 F1 均低于 0.15；low 档在前两批为 0（模型几乎不输出该档）。
        这是严重度整体不可用的直接原因。
      </p>
    </Panel>
  );
}

// ============================================================
// 3) per-topic F1
// ============================================================

function PerTopicTable() {
  return (
    <Panel
      title="各模块 F1（per-topic）"
      note={`最新批次 ${latest.runId} 列在最前并高亮；其余批次并列展示，便于观察单个类别随实验的变化。`}
    >
      <ScrollArea>
        <table className="w-full min-w-[46rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-300 bg-slate-50 text-left">
              <Th>模块</Th>
              <Th align="right">
                {latest.runId}
                <span className="ml-1 text-[10px] font-normal text-indigo-700">最新</span>
              </Th>
              {EVAL_RUNS.filter((run) => run.runId !== latest.runId).map((run) => (
                <Th key={run.runId} align="right">
                  <span className="font-mono text-[11px] font-medium">{run.runId}</span>
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TOPIC_ORDER.map((topic) => (
              <tr key={topic} className="border-b border-slate-200">
                <Td>
                  <span className="text-xs font-medium">{TOPIC_LABELS[topic]}</span>
                  <span className="ml-1 font-mono text-[10px] text-slate-400">{topic}</span>
                </Td>
                <TdNum className="bg-indigo-50/60 font-semibold">
                  {formatDecimal(latest.perTopicF1[topic])}
                </TdNum>
                {EVAL_RUNS.filter((run) => run.runId !== latest.runId).map((run) => (
                  <TdNum
                    key={run.runId}
                    className={run.perTopicF1[topic] === 0 ? "text-red-700" : ""}
                  >
                    {formatDecimal(run.perTopicF1[topic])}
                  </TdNum>
                ))}
              </tr>
            ))}
            <tr className="border-b-2 border-slate-300 bg-slate-100">
              <Td>
                <span className="text-xs font-bold">Macro-F1</span>
              </Td>
              <TdNum className="bg-indigo-100 font-bold">
                {formatDecimal(latest.topicMacroF1)}
              </TdNum>
              {EVAL_RUNS.filter((run) => run.runId !== latest.runId).map((run) => (
                <TdNum key={run.runId} className="font-semibold">
                  {formatDecimal(run.topicMacroF1)}
                </TdNum>
              ))}
            </tr>
          </tbody>
        </table>
      </ScrollArea>
      <p className="mt-2 text-xs leading-5 text-slate-500">
        other 类是 16 个低频类别的归并项，语义不内聚：前 4 批 F1 为 0，
        qwen3max-v13 为 {formatDecimal(runById("qwen3max-v13").perTopicF1.other)}，
        最新批次为 {formatDecimal(latest.perTopicF1.other)}。
        采用 Macro-F1 而非整体准确率，正是因为 editor 类占约 39%，全量输出 editor
        即可获得约 39% 的表观准确率。
      </p>
    </Panel>
  );
}

// ============================================================
// 4) 稳定性、成本与其他段指标
// ============================================================

function StabilityTable() {
  return (
    <Panel
      title="稳定性 / 延迟 / 对抗集 / 查重"
      note="解析成功率与降级率是 PD-05 的正式验收指标；对抗集与查重段样本量小，仅供参考。"
    >
      <ScrollArea>
        <table className="w-full min-w-[56rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-300 bg-slate-50 text-left">
              <Th>批次</Th>
              <Th align="right">解析成功率</Th>
              <Th align="right">重试率</Th>
              <Th align="right">降级率</Th>
              <Th align="right">平均延迟</Th>
              <Th align="right">P95 延迟</Th>
              <Th align="right">对抗集正确标记</Th>
              <Th align="right">查重 Recall@5</Th>
              <Th align="right">查重 Precision</Th>
            </tr>
          </thead>
          <tbody>
            {EVAL_RUNS.map((run) => (
              <tr
                key={run.runId}
                className={`border-b border-slate-200 ${
                  run.runId === LATEST_RUN_ID ? "bg-indigo-50/60" : ""
                }`}
              >
                <Td>
                  <span className="font-mono text-xs">{run.runId}</span>
                </Td>
                <TdNum>{formatPercent(run.parseSuccessRate)}</TdNum>
                <TdNum>{formatPercent(run.retryRate)}</TdNum>
                <TdNum>{formatPercent(run.fallbackRate)}</TdNum>
                <TdNum>{Math.round(run.avgLatencyMs)} ms</TdNum>
                <TdNum>{Math.round(run.p95LatencyMs)} ms</TdNum>
                <TdNum>
                  {formatPercent(run.adversarial.correctlyFlaggedRate)}
                  <span className="ml-1 text-[10px] text-slate-400">
                    {run.adversarial.correctlyFlagged}/{run.adversarial.sampleCount}
                  </span>
                </TdNum>
                <TdNum>
                  {run.duplicate ? formatDecimal(run.duplicate.recallAt5) : "—"}
                </TdNum>
                <TdNum>
                  {run.duplicate ? formatDecimal(run.duplicate.precision) : "—"}
                </TdNum>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
      <p className="mt-2 text-xs leading-5 text-slate-500">
        「—」表示该批次 JSON 无查重段（sev-defined 未跑查重），不是 0。
        查重指标在跑过的批次中完全相同，因为它只依赖检索库与阈值，与提示词、模型无关。
      </p>
    </Panel>
  );
}

// ============================================================
// 布局与格式化
// ============================================================

function NavBar() {
  return (
    <nav className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 pb-3 text-sm">
      <Link href="/" className="font-medium text-slate-600 hover:text-indigo-700">
        分诊工作台
      </Link>
      <span className="font-semibold text-indigo-700">评测报告</span>
      <Link href="/about" className="font-medium text-slate-600 hover:text-indigo-700">
        关于
      </Link>
    </nav>
  );
}

function Panel({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
      {note && <p className="mt-1 mb-3 text-xs leading-5 text-slate-500">{note}</p>}
      {children}
    </section>
  );
}

/** 窄屏下表格横向滚动，不压缩列宽、不换行错版 */
function ScrollArea({ children }: { children: React.ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">{children}</div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      scope="col"
      className={`px-2 py-2 text-xs font-semibold whitespace-nowrap text-slate-600 ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  colSpan,
}: {
  children: React.ReactNode;
  colSpan?: number;
}) {
  return (
    <td colSpan={colSpan} className="px-2 py-2 align-top">
      {children}
    </td>
  );
}

function TdNum({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td
      className={`px-2 py-2 text-right align-top font-mono text-xs whitespace-nowrap tabular-nums ${className}`}
    >
      {children}
    </td>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.9em] text-slate-700">
      {children}
    </code>
  );
}

function runById(runId: string): EvalRunRecord {
  const found = EVAL_RUNS.find((run) => run.runId === runId);
  if (!found) throw new Error(`未知批次 ${runId}`);
  return found;
}

/**
 * 百分比：保留两位小数，不四舍五入到整数。
 * 44.29% 与 44% 在本项目里是不同的陈述——前者可与 JSON 原值对照，后者不能。
 */
function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/** F1 等 0–1 指标保留四位小数，与 JSON 中 perTopicF1 的精度一致 */
function formatDecimal(value: number): string {
  return value.toFixed(4);
}
