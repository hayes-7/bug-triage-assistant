/**
 * 关于页（/about）
 *
 * 职责：把这个项目「能用到什么程度、哪里不能用」讲清楚。
 * 写作原则：宁可显得不好看，也不写无法被 data/ 下产物验证的话。
 * 页面上每个数字都标注了出处批次，可直接对照 data/eval_metrics_*.json。
 *
 * 服务端组件：纯静态文本，不需要客户端 JS。
 */

import Link from "next/link";

import { EVAL_RUNS, LATEST_RUN_ID, SEVERITY_NAIVE_BASELINE } from "@/lib/eval-history";

export const metadata = {
  title: "关于 · Bug 智能分诊助手",
  description: "数据来源、评测方式与已知限制",
};

const latest = EVAL_RUNS.find((run) => run.runId === LATEST_RUN_ID) ?? EVAL_RUNS[0];
const qwen3max = EVAL_RUNS.find((run) => run.runId === "qwen3max-v13");

/**
 * Top-1 置信度中位数，取自 data/eval_results_with-rag.csv 的 confidence 列。
 * 280 条的取值分布：0.75×1、0.92×32、0.95×106、0.98×141，中位数 0.98。
 * 该值不在 eval_metrics JSON 中，故在此登记来源，不作为可推导指标。
 */
const LATEST_CONFIDENCE_MEDIAN = 0.98;

export default function AboutPage() {
  return (
    <div className="w-full flex-1 bg-slate-50 font-sans text-slate-900">
      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        <NavBar />

        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">关于本项目</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            一个缺陷分诊辅助工具的可行性验证。下面写清数据来自哪里、怎么评的、
            以及哪些结论不能用——后者比前者重要。
          </p>
        </header>

        <Section title="1 · 数据来源">
          <ul className="space-y-2 text-sm leading-6 text-slate-700">
            <Li>
              <strong>全部语料来自 Godot 引擎的公开 Issue</strong>
              （<Code>godotengine/godot</Code>），经 GitHub 公开 API 采集，
              标准答案取自维护者实际打上的 <Code>topic:*</Code> 与严重度标签，
              不是我自己标的。
            </Li>
            <Li>
              <strong>公司真实缺陷数据因保密不可用</strong>，未被使用、未被上传、
              也未参与任何评测。因此本项目的所有指标只代表「在 Godot 这类开源引擎
              Issue 上的表现」，迁移到具体业务语料前必须重跑评测，不可直接套用。
            </Li>
            <Li>
              检索库为 4200 条非评测集 Issue，评测集样本已通过
              <Code>in_eval_set = false</Code> 从检索侧排除，避免把标准答案喂回模型。
            </Li>
          </ul>
        </Section>

        <Section title="2 · 评测方式">
          <ul className="space-y-2 text-sm leading-6 text-slate-700">
            <Li>
              <strong>主集 280 条</strong>：模块 Top-1 / Top-3 / Macro-F1 与严重度准确率。
              其中 2 个批次实际计入 279 / 278 条（见下方说明）。
            </Li>
            <Li>
              <strong>对抗集 20 条</strong>：描述残缺的样本，检验模型是否肯承认
              「信息不足」。样本量小，只作定性参考，不构成指标。
            </Li>
            <Li>
              <strong>查重测试 37 对</strong>：已知重复的 Issue 对，测 Recall@5 与
              Precision。原计划 50 对，实际可用 37 对（其余不满足「原单在检索库内」）。
            </Li>
            <Li>
              <strong>6 批受控实验</strong>，每批只动一个变量，使指标差值可归因到单一手段：
              <div className="mt-2 overflow-x-auto">
                <table className="min-w-[30rem] border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-300 bg-slate-50 text-left">
                      <th className="px-2 py-1.5 font-semibold whitespace-nowrap">批次</th>
                      <th className="px-2 py-1.5 font-semibold whitespace-nowrap">Prompt</th>
                      <th className="px-2 py-1.5 font-semibold whitespace-nowrap">模型</th>
                      <th className="px-2 py-1.5 text-right font-semibold whitespace-nowrap">
                        样本数
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {EVAL_RUNS.map((run) => (
                      <tr key={run.runId} className="border-b border-slate-200">
                        <td className="px-2 py-1.5 font-mono whitespace-nowrap">
                          {run.runId}
                        </td>
                        <td className="px-2 py-1.5 font-mono whitespace-nowrap">
                          {run.promptVersion}
                        </td>
                        <td className="px-2 py-1.5 font-mono whitespace-nowrap">
                          {run.modelId}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                          {run.sampleCount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Li>
            <Li>
              温度固定 0、输入截断 1500 token、数据集带 sha 指纹，
              保证同一批次可复现。完整指标见{" "}
              <Link href="/report" className="font-medium text-indigo-700 underline">
                评测报告页
              </Link>
              。
            </Li>
          </ul>
        </Section>

        <Section title="3 · 已知限制" tone="warn">
          <p className="mb-3 text-sm leading-6 text-amber-900">
            以下每一条都会实际影响你怎么用这个工具，请读完再用。
          </p>

          <div className="space-y-4">
            <Limit title="严重度判定不可用">
              四档（crash / high / normal / low）准确率仅{" "}
              <Strong>{formatPercent(latest.severityAccuracy)}</Strong>
              （{latest.runId} 批次），<strong>低于朴素基线</strong>{" "}
              <Strong>{formatPercent(SEVERITY_NAIVE_BASELINE.accuracy)}</Strong>
              ——即恒定输出 <Code>{SEVERITY_NAIVE_BASELINE.majorityLevel}</Code>
              （标准答案中占 {SEVERITY_NAIVE_BASELINE.count}/
              {SEVERITY_NAIVE_BASELINE.total}）都比模型准。6 批全部低于基线，
              最好的一批也只有{" "}
              {formatPercent(Math.max(...EVAL_RUNS.map((r) => r.severityAccuracy)))}。
              <br />
              <strong>结论：严重度不可作为结论使用</strong>，界面上只作参考值展示，
              已标注「参考值 · 实测准确率约 44%」。
            </Limit>

            <Limit title="置信度未经校准，百分比不代表正确概率">
              最新批次模型自评的 Top-1 置信度<strong>中位数为 {formatPercent(LATEST_CONFIDENCE_MEDIAN)}</strong>
              （取值只有 0.75 / 0.92 / 0.95 / 0.98 四种，最低 0.75），
              而实际 Top-1 准确率只有{" "}
              <Strong>{formatPercent(latest.topicTop1Accuracy)}</Strong>。
              二者相差约 25 个百分点。
              <br />
              <strong>
                因此界面上的百分比只表示候选之间的相对强弱，不代表实际正确概率。
              </strong>
              也正因为此，界面的「建议人工确认」提示不依赖置信度数值，
              改以语义信号为主（走降级路径、或模型自述信息不足）触发——
              实测纯数值阈值几乎永不触发。
            </Limit>

            <Limit title="other 类几乎无法判定，且不计入 Macro-F1">
              <Code>other</Code> 是 16 个低频类别的归并项，语义不内聚，
              跨领域样本也归到这里。各批次 F1：前 4 批<strong>均为 0</strong>，
              qwen3max-v13 为 {formatDecimal(qwen3max?.perTopicF1.other ?? 0)}，
              最新 {latest.runId} 批次为{" "}
              <Strong>{formatDecimal(latest.perTopicF1.other)}</Strong>。
              <br />
              <strong>Macro-F1 的计算不含 other</strong>，只对其余 10 类取算术平均
              （已核验：10 类均值与 JSON 的 <Code>topicMacroF1</Code> 一致）。
              所以 Macro-F1 <strong>系统性地乐观</strong>，
              读它时要记得 other 这一类实际上没被解决。
            </Limit>

            <Limit title="查重存在误报，isDuplicate 不是强结论">
              Precision 仅{" "}
              <Strong>
                {formatDecimal(latest.duplicate?.precision ?? 0)}
              </Strong>
              （阈值 {latest.duplicate?.precisionThreshold ?? 0.75}，
              {latest.duplicate?.pairs ?? 37} 对测试样本），Recall@5{" "}
              {formatDecimal(latest.duplicate?.recallAt5 ?? 0)}。
              且测试对全为真重复对、无真负例，该 Precision 偏高，只作量级参考。
              <br />
              更要紧的是：<Code>isDuplicate</Code> 目前<strong>仅按相似度阈值判定</strong>，
              缺少接口契约要求的第三个条件「模型语义确认」。
              已实测到误报（相似度 0.77 但并非同一缺陷）。
              因此界面不宣称「重复」，只显示「相似度较高，建议人工核对是否重复」。
              该项已登记待后续版本处理。
            </Limit>

            <Limit title="信息充分度判定弱，样本量小">
              对抗集上「正确标记为信息不足」的比例：{latest.runId} 批次{" "}
              <Strong>{formatPercent(latest.adversarial.correctlyFlaggedRate)}</Strong>
              （{latest.adversarial.correctlyFlagged}/{latest.adversarial.sampleCount}），
              6 批区间为{" "}
              {formatPercent(Math.min(...EVAL_RUNS.map((r) => r.adversarial.correctlyFlaggedRate)))}
              –
              {formatPercent(Math.max(...EVAL_RUNS.map((r) => r.adversarial.correctlyFlaggedRate)))}
              。<strong>仅 20 条样本，只能作定性参考</strong>，
              不足以支撑任何结论，也不构成验收指标。
            </Limit>

            <Limit title="其他须知">
              <ul className="ml-4 list-disc space-y-1">
                <li>
                  2 个批次的计入样本数为 279 / 278 而非 280，横向比较时须注意
                  分母不完全相同。
                </li>
                <li>
                  <Code>sev-defined</Code> 批次的 <Code>runLabel</Code> 被记为
                  <Code>baseline</Code>，与基线批次同名；该批次也未跑查重段。
                </li>
                <li>
                  查重指标在跑过的批次中数值完全相同——它只依赖检索库与阈值，
                  与提示词、模型无关。
                </li>
                <li>
                  检索到的「官方规则」相关性低（相似度集中在 0.3–0.5），
                  规则是标签定义文本、与缺陷描述不在同一语义空间。
                  接口仍返回该字段，但界面已不展示，避免误导。
                </li>
              </ul>
            </Limit>
          </div>
        </Section>

        <Section title="4 · 本地复现">
          <ol className="space-y-2 text-sm leading-6 text-slate-700">
            <Oli n={1}>
              <strong>装依赖</strong>：<Code>npm install</Code>
            </Oli>
            <Oli n={2}>
              <strong>配环境变量</strong>：复制 <Code>.env.example</Code> 为{" "}
              <Code>.env.local</Code>，按其中注释填入模型与向量服务的 Key、
              以及 Supabase 连接信息。各变量的作用与默认值都写在
              <Code>.env.example</Code> 里，本仓库不含任何真实凭据。
            </Oli>
            <Oli n={3}>
              <strong>启动</strong>：<Code>npm run dev</Code>，打开{" "}
              <Code>http://localhost:3000</Code> 即可提交缺陷进行分诊。
            </Oli>
            <Oli n={4}>
              可选：<Code>npx tsc --noEmit</Code> 做类型检查，
              <Code>npm run lint</Code> 做静态检查。
              检索或模型不可用时接口会降级返回，界面有明确提示，不会白屏。
            </Oli>
          </ol>
        </Section>

        <footer className="mt-8 border-t border-slate-200 pt-4 text-xs leading-6 text-slate-500">
          本页所有数字取自 <Code>data/eval_metrics_*.json</Code> 与{" "}
          <Code>data/eval_results_with-rag.csv</Code>，未做修正或美化。
          若发现页面数字与源文件不一致，以源文件为准并视为缺陷。
        </footer>
      </main>
    </div>
  );
}

// ============================================================
// 布局
// ============================================================

function NavBar() {
  return (
    <nav className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 pb-3 text-sm">
      <Link href="/" className="font-medium text-slate-600 hover:text-indigo-700">
        分诊工作台
      </Link>
      <Link href="/report" className="font-medium text-slate-600 hover:text-indigo-700">
        评测报告
      </Link>
      <span className="font-semibold text-indigo-700">关于</span>
    </nav>
  );
}

function Section({
  title,
  tone = "plain",
  children,
}: {
  title: string;
  tone?: "plain" | "warn";
  children: React.ReactNode;
}) {
  const warn = tone === "warn";
  return (
    <section
      className={`mb-6 rounded-xl border p-4 shadow-sm sm:p-5 ${
        warn ? "border-2 border-amber-500 bg-amber-50" : "border-slate-200 bg-white"
      }`}
    >
      <h2
        className={`mb-3 text-sm font-bold ${warn ? "text-amber-900" : "text-slate-800"}`}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function Limit({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-amber-300 bg-white/70 p-3">
      <h3 className="text-sm font-semibold text-amber-900">{title}</h3>
      <div className="mt-1.5 text-sm leading-6 text-slate-700">{children}</div>
    </div>
  );
}

function Li({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-slate-400" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function Oli({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700">
        {n}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.9em] break-words text-slate-700">
      {children}
    </code>
  );
}

function Strong({ children }: { children: React.ReactNode }) {
  return <strong className="font-mono font-bold tabular-nums">{children}</strong>;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatDecimal(value: number): string {
  return value.toFixed(4);
}
