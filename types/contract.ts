/**
 * Bug 智能分诊助手 · 核心类型定义
 *
 * 来源：PD-04 接口契约文档 v1.0
 * 枚举值依据：PD-02 分类体系定义文档 v1.1
 *
 * 使用说明：
 *   本文件为项目的唯一结构依据。实现代码须严格遵循此处定义，
 *   不得增删字段、变更命名或扩展枚举取值。
 *   如需变更，先修改 PD-04 并升版本号，再同步此文件。
 */

// ============================================================
// 枚举定义
// ============================================================

/**
 * 模块类别（11 项）
 * 对应 PD-02 第 3.1 节 M01–M11
 * 注意：2d / 3d 不在此枚举内，二者为维度修饰词而非功能模块
 */
export type TopicCategory =
  | "editor" // M01  编辑器软件自身，与运行时无关
  | "rendering" // M02  渲染管线：画面显示、材质、光照、阴影
  | "gui" // M03  游戏内 UI 控件（与编辑器界面区分）
  | "gdscript" // M04  GDScript 语言：语法、类型系统、运行时报错
  | "core" // M05  核心引擎层：对象系统、资源管理、序列化、信号
  | "platforms" // M06  特定平台适配（仅在特定平台复现）
  | "animation" // M07  动画系统：AnimationPlayer、动画树、骨骼
  | "buildsystem" // M08  编译构建：SCons、编译器兼容性
  | "import" // M09  资源导入：模型、图片、音频的导入转换
  | "input" // M10  输入系统：键盘、鼠标、手柄、触摸
  | "other"; // M11  其余 16 个低频类别的归并项

/** 严重程度（4 档，单条缺陷仅输出一档） */
export type SeverityLevel =
  | "crash" // 崩溃、卡死、无法继续运行
  | "high" // 功能性回归：旧版本正常而新版本异常
  | "normal" // 影响体验或性能，功能仍可用
  | "low"; // 一般性缺陷

/**
 * 判定信号（用于说明严重度判定依据）
 * 依据 PD-02 第 5.5 节实测：崩溃关键词召回率 97.2%、精确率 39.1%
 * 因此本字段仅作依据说明，判定本身须由模型基于语义完成
 */
export type SeveritySignal =
  | "crash_keyword" // 崩溃类关键词：crash / segfault / freeze / hang
  | "stack_trace" // 堆栈信息：traceback / stack trace / backtrace
  | "version_regression" // "Not reproducible in" 结构（对 regression 预测准确率 76.2%）
  | "performance_issue" // 性能问题：卡顿、帧率下降、内存占用
  | "usability_issue" // 可用性问题：操作不便、提示不清
  | "compile_failure" // 编译或构建失败
  | "none"; // 未命中任何信号

/** 信息充分度（对抗测试的验收依据） */
export type InfoSufficiency =
  | "sufficient" // 描述完整
  | "partial" // 可辨识但缺少复现步骤或环境信息
  | "insufficient"; // 过于简短，无法判断模块归属

// ============================================================
// 输入
// ============================================================

export type TriageInput = {
  /** 缺陷标题，长度 1–500 字符 */
  title: string;
  /** 缺陷描述，长度 0–50000 字符，允许空字符串 */
  body: string;
  /** 原始记录地址，可选，仅用于结果回溯展示 */
  sourceUrl?: string;
};

// ============================================================
// 输出
// ============================================================

export type TopicCandidate = {
  topic: TopicCategory;
  /** 0–1，三项之和不要求为 1 */
  confidence: number;
  /** 判定理由，不超过 80 字符，用于产品可解释性 */
  reasoning: string;
};

export type DuplicateCandidate = {
  issueNumber: number;
  title: string;
  /** 0–1，向量余弦相似度 */
  similarity: number;
  /** 必填。用户须能跳转核对，是查重功能可用的前提 */
  url: string;
};

/**
 * 检索到的相似历史 Issue（v2.0 参考材料，用于界面「AI 参考了什么」）
 *
 * 防泄漏（硬性）：仅透出 number / title / similarity。
 * 绝不包含 gt_topics / gt_severity / body / html_url——
 * 前者等同于把标准答案透给界面与模型，会让评测指标失真。
 */
export type ReferenceIssue = {
  number: number;
  title: string;
  /**
   * 0–1，向量余弦相似度。
   * 可选：检索层（lib/retrieval.ts）当前只透出 number / title，
   * 未把 RPC 返回的 similarity 带出来，故该值可能缺失。
   * 缺失时界面不显示相似度，不显示 0%（0% 是错误结论而非「未知」）。
   */
  similarity?: number;
};

/** 检索到的官方规则条文（v2.0 参考材料） */
export type ReferenceRule = {
  labelName: string;
  ruleText: string;
  /** 0–1，向量余弦相似度。可选，原因同 ReferenceIssue.similarity */
  similarity?: number;
};

/**
 * v2.0 检索到的参考材料，供界面展示「AI 参考了什么」。
 * 检索降级（embedding / RPC 失败、超时、配置缺失）时两个数组均为空数组，
 * 不返回 null——调用方只需判断 length，无需区分 null 与空。
 */
export type TriageReferences = {
  /** 相似历史 Issue，按相似度降序；检索降级时为空数组 */
  issues: ReferenceIssue[];
  /** 官方规则条文，按相似度降序；检索降级时为空数组 */
  rules: ReferenceRule[];
};

export type TriageMeta = {
  /** 单次请求标识，用于日志关联与问题定位 */
  requestId: string;
  /** 实际调用的模型标识，模型对比实验的分组依据 */
  modelId: string;
  /** Prompt 版本号，如 "v1.0"。评测可复现性的前提 */
  promptVersion: string;
  /** 端到端耗时 */
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** 重试次数，0 表示首次成功 */
  retryCount: number;
  /** 是否触发降级路径 */
  fallbackUsed: boolean;
  /** ISO 8601 格式 */
  timestamp: string;
};

export type TriageResult = {
  /** 固定 3 项，按 confidence 降序，三项 topic 互不相同。降级时为空数组 */
  topicCandidates: TopicCandidate[];

  severity: {
    level: SeverityLevel;
    confidence: number;
    /** 长度 ≥ 1，未命中时为 ["none"] */
    signals: SeveritySignal[];
  };

  /** 0–5 项，按 similarity 降序。无匹配时为空数组，不返回 null */
  duplicates: DuplicateCandidate[];

  /**
   * 综合判定，规则见 PD-04 第 4.3 节：
   *   duplicates 非空 且 duplicates[0].similarity >= DUP_THRESHOLD 且 模型语义确认
   *   DUP_THRESHOLD 初始值 0.75，第 2 周经阈值扫描实验确定
   */
  isDuplicate: boolean;

  infoSufficiency: InfoSufficiency;

  /**
   * v2.0 检索到的参考材料，可选字段。
   *
   * 为什么可选：v1.x 无检索环节，不返回本字段；界面须能在缺省时正常工作，
   * 因此不得升为必填，否则旧版本响应即视为违约。
   * 实现方（v2.0）在检索降级时返回两个空数组而非省略字段，
   * 界面据此区分「没检索到」与「该版本不支持检索」。
   */
  references?: TriageReferences;

  meta: TriageMeta;
};

// ============================================================
// 错误响应
// ============================================================

/**
 * 错误码：
 *   INVALID_INPUT       400  参数校验失败
 *   BODY_TOO_LONG       400  描述文本超长
 *   RATE_LIMITED        429  请求频率超限
 *   MODEL_UNAVAILABLE   503  模型不可用且降级亦失败
 *   TIMEOUT             504  端到端超时（阈值 45 秒）
 *   RUN_NOT_FOUND       404  评测批次不存在
 *   INTERNAL_ERROR      500  未预期的服务端错误
 */
export type ErrorResponse = {
  error: {
    code: string;
    message: string;
    /** 校验失败的字段名 */
    field?: string;
  };
  requestId: string;
};

// ============================================================
// 评测
// ============================================================

/** 实验参数配置，缺少此项将无法复现某一批次的结果 */
export type EvalConfig = {
  retrievalTopK: number;
  dupThreshold: number;
  temperature: number;
  maxInputTokens: number;
};

export type EvalMetrics = {
  // ---- 批次标识 ----
  runId: string;
  /** 批次标识，如 "baseline" / "with-rag" / "v1.2-tuned" */
  runLabel: string;
  promptVersion: string;
  modelId: string;
  config: EvalConfig;
  sampleCount: number;
  createdAt: string;

  // ---- 模块判定 ----
  /** 首位候选属于标准答案集合的比例。目标 ≥ 0.55，且须高于人工基线（PD-05 第 3 节） */
  topicTop1Accuracy: number;
  /** 三个候选中任一属于标准答案集合的比例。目标 ≥ 0.80（PD-05 第 3 节） */
  topicTop3HitRate: number;
  /**
   * 主指标。各类别单独算 F1 后取算术平均
   * 采用此指标而非整体准确率的原因：editor 类占 39.34%，
   * 全量输出 editor 即可获得约 39% 的表观准确率
   */
  topicMacroF1: number;
  perTopicF1: Record<TopicCategory, number>;

  // ---- 严重程度 ----
  severityAccuracy: number;
  /** severity 亦分布不均（low 约占 51%），需分档观测 */
  perSeverityF1: Record<SeverityLevel, number>;

  // ---- 查重 ----
  duplicateRecallAt5: number;
  /** 与召回率同时观测：阈值调低可提升召回但引入误判 */
  duplicatePrecision: number;

  // ---- 稳定性与成本 ----
  /** 首次解析成功的比例。目标 ≥ 0.95，另需 fallbackRate ≤ 0.01（PD-05 第 6 节） */
  parseSuccessRate: number;
  retryRate: number;
  fallbackRate: number;
  avgLatencyMs: number;
  /** 平均延迟会被少数快速响应拉低，P95 更反映实际体验 */
  p95LatencyMs: number;
  avgCostPer100: number;

  // ---- 对抗测试（不计入准确率统计）----
  adversarial: {
    sampleCount: number;
    /** 正确标记为 insufficient 的比例 */
    correctlyFlaggedRate: number;
    /**
     * 观测值：在样本被判为 insufficient 时，模型给出的 Top-1 主题候选
     *（topicCandidates[0].confidence）置信度的均值。
     *
     * 注意两点：
     * 1. 这是「主题置信度」，不是「信息充分度判定的置信度」——
     *    InfoSufficiency 为纯枚举，schema 中不存在充分度判定的置信度字段。
     * 2. 本指标不设目标值。实测表明「能猜对模块」与「能判断信息是否充足」
     *    是两种分离的能力：模型在信息不足时仍可能正确猜中模块并给出高置信度
     *   （baseline 批次该子集中 5/8 命中标准答案），故不能期待该值显著偏低。
     *
     * 「低置信度机制是否有效」由 correctlyFlaggedRate 与界面层对
     * insufficient / fallbackUsed 的处理负责验证，不由本字段承担。
     */
    avgTop1TopicConfidenceOnInsufficient: number;
  };
};

export type EvalResultItem = {
  issueNumber: number;
  title: string;
  /** 标准答案，已按 PD-02 第 4.3 节归一化 */
  groundTruthTopics: TopicCategory[];
  predictedTopics: TopicCategory[];
  hitTop1: boolean;
  hitTop3: boolean;
  groundTruthSeverity: SeverityLevel;
  predictedSeverity: SeverityLevel;
  severityCorrect: boolean;
  latencyMs: number;
};

export type EvalRunSummary = {
  runId: string;
  runLabel: string;
  promptVersion: string;
  modelId: string;
  sampleCount: number;
  topicTop1Accuracy: number;
  topicTop3HitRate: number;
  topicMacroF1: number;
  createdAt: string;
};

// ============================================================
// API 响应封装
// ============================================================

export type EvalRunListResponse = {
  /** 按 createdAt 降序 */
  runs: EvalRunSummary[];
};

export type EvalRunDetailResponse = {
  metrics: EvalMetrics;
  results: EvalResultItem[];
};

// ============================================================
// 常量
// ============================================================

export const TOPIC_CATEGORIES: readonly TopicCategory[] = [
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
] as const;

export const SEVERITY_LEVELS: readonly SeverityLevel[] = [
  "crash",
  "high",
  "normal",
  "low",
] as const;

/** 超时阈值（毫秒） */
export const TIMEOUTS = {
  /**
   * 检索超时后跳过检索，不阻断模型判定。
   *
   * 3_000 → 5_000（实测调整）：3 秒下约 1/3 请求在 rpc 阶段超时降级
   *（日志 reason: '检索超过 3000 毫秒'，elapsedMs 普遍 3006–3016，即卡在阈值上），
   * references 随之变成空数组、界面「AI 参考了什么」时有时无。
   * 端到端预算 45 秒、模型调用本身约 5–7 秒，检索多给 2 秒不构成风险。
   * 注意：本值只影响降级概率，不改变检索逻辑与注入内容，故不触发 Prompt 版本升级。
   */
  retrieval: 5_000,
  model: 30_000,
  endToEnd: 45_000,
} as const;

/** 查重阈值初始值，第 2 周经实验确定最终取值 */
export const DUP_THRESHOLD_INITIAL = 0.75;

/** 低置信度阈值：低于此值时界面提示人工复核 */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

/** 输入文本截断上限（token） */
export const MAX_INPUT_TOKENS = 1_500;
