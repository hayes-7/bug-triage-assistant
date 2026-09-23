/**
 * 分诊运行期配置（查重相关）
 *
 * 存在理由：查重阈值同时出现在三处语境——契约常量、评测配置
 * （EvalConfig.dupThreshold / scripts/run_eval.py 的 EVAL_CONFIG）、
 * 以及本次接入的线上判定。若各处各写一个字面量，
 * 阈值扫描实验（PD-10 D-09）结束后必然漏改其中之一，
 * 导致「评测用的阈值」与「线上判定的阈值」不一致，指标不可复现。
 * 因此线上判定只允许从本模块取值，不在业务代码里散落数字。
 */

import { DUP_THRESHOLD_INITIAL } from "@/types/contract";

/**
 * 取查重阈值。
 *
 * 取值优先级：
 *   1. 环境变量 DUP_THRESHOLD（0–1 的数值），用于阈值扫描实验免改代码；
 *   2. 契约常量 DUP_THRESHOLD_INITIAL（当前 0.75），即默认值。
 *
 * 非法值（非数值、超出 0–1）一律忽略并回落到契约常量，同时告警：
 * 静默接受非法阈值会让一整批结果的判定口径不明，比直接忽略更危险。
 *
 * 注意：环境变量只是实验入口，最终确定的取值须写回契约常量并登记 CHANGELOG，
 * 不能长期依赖某台机器的 .env.local——那等于阈值没有版本记录。
 */
export function resolveDupThreshold(): number {
  return resolveRatio(process.env.DUP_THRESHOLD, DUP_THRESHOLD_INITIAL, "DUP_THRESHOLD");
}

/**
 * 查重展示下限的默认值。
 *
 * 为何独立于 MATCH_THRESHOLD：后者（0.5）是 references（RAG 注入）的召回下限，
 * 宽一点有利于给模型多一些弱上下文；而查重列表是给人看的，
 * 0.69 这类弱相关项（实测 #68421 MultiMeshInstance3D 对 PlaneMesh 崩溃）
 * 摆在界面上没有核对价值，只会稀释真正的候选。
 * 两个用途的取舍方向相反，故必须是两个独立阈值，不能复用。
 */
const DUP_DISPLAY_MIN_INITIAL = 0.7;

/**
 * 取查重展示下限。
 *
 * 取值优先级与非法值处理同 resolveDupThreshold()：
 *   1. 环境变量 DUP_DISPLAY_MIN（0–1 的数值）；
 *   2. 模块常量 DUP_DISPLAY_MIN_INITIAL（当前 0.70）。
 *
 * 与 resolveDupThreshold() 一起构成三段语义分区：
 *   >= 0.75（DUP_THRESHOLD）      展示，且 isDuplicate = true
 *   0.70–0.75                     展示，但 isDuplicate = false
 *   <  0.70（DUP_DISPLAY_MIN）    不展示
 * 注意分区前提是 DUP_DISPLAY_MIN <= DUP_THRESHOLD；
 * 若被环境变量配成反序，中间档会消失（一切展示项都判为重复），
 * 故此处校验并告警，但不静默改写取值——改写会让线上口径与配置不符。
 */
export function resolveDupDisplayMin(): number {
  const displayMin = resolveRatio(
    process.env.DUP_DISPLAY_MIN,
    DUP_DISPLAY_MIN_INITIAL,
    "DUP_DISPLAY_MIN",
  );

  const dupThreshold = resolveDupThreshold();
  if (displayMin > dupThreshold) {
    console.warn("[triage] DUP_DISPLAY_MIN 高于 DUP_THRESHOLD，中间档将不存在", {
      displayMin,
      dupThreshold,
    });
  }

  return displayMin;
}

/**
 * 解析 0–1 的比率型环境变量。
 *
 * 非法值（非数值、超出 0–1）一律忽略并回落到默认值，同时告警：
 * 静默接受非法阈值会让一整批结果的判定口径不明，比直接忽略更危险。
 */
function resolveRatio(raw: string | undefined, fallback: number, name: string): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    console.warn(`[triage] ${name} 取值非法，回落到默认值`, {
      received: trimmed,
      fallback,
    });
    return fallback;
  }

  return parsed;
}

/**
 * 规则缓存装载超时（毫秒）。
 *
 * 为何独立于 TIMEOUTS.retrieval（5 秒）：装载是一次性的全表读取
 *（54 条 × 1536 维，实测 0.3–1.2 秒），服务于所有后续请求，
 * 不该被某一次请求的超时预算限制。给 10 秒是为了让冷启动阶段
 * 即使遇到网络抖动也能把缓存建起来；单次请求本身仍受 5 秒硬上限约束，
 * 装载慢只会让那一次请求走规则单路降级，不会拖长响应。
 */
export const RULE_CACHE_LOAD_TIMEOUT_MS = 10_000;

/**
 * 语料来源仓库，用于在 issues.html_url 缺失时兜底拼接链接。
 *
 * 检索库全部来自 godotengine/godot（见 scripts/ 的采集脚本与
 * data/retrieval_corpus.csv 的 html_url 列），故此处可安全写死仓库名；
 * 若将来接入第二个仓库，本兜底必须改为按记录来源判断，
 * 否则会拼出指向错误仓库的链接。
 */
const ISSUE_REPO = "godotengine/godot";

/**
 * 构造 Issue 链接。
 * 优先使用检索层透出的 html_url（数据库原值，最可靠）；
 * 缺失时按仓库 + 编号拼接——GitHub 的 /issues/{number} 路径稳定，
 * 且契约要求 DuplicateCandidate.url 必填（用户须能跳转核对），
 * 不允许返回空串。
 */
export function buildIssueUrl(issueNumber: number, htmlUrl?: string): string {
  const trimmed = htmlUrl?.trim();
  if (trimmed) return trimmed;
  return `https://github.com/${ISSUE_REPO}/issues/${issueNumber}`;
}
