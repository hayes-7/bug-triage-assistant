# 决策日志

> **本文档记录范围**：仅记录工程实现层决策（数据结构、脚本实现方式、
> 依赖与工具选型细节）。产品层决策（分类体系、评测口径、目标值、
> 功能范围）记录在项目的 PD-10 决策日志中，不在此重复。
> 同一决策只在一处记录，需要时交叉引用，避免两处分叉。

## 2026-09-18 · 建表与数据导入（PD-06 第 7 节）

- 连接方式：Python `psycopg2-binary`（2.9.13）直连，连接串从 `.env.local` 的 `DATABASE_URL` 解析，
  不硬编码、不打印（仅打印 host/port/dbname）。未走 REST，因其无法执行 DDL。
- 导入脚本：`scripts/import_to_supabase.py`（建表 / 建函数 / 批量导入 / 自验证一体）。
- 建表阶段错误：**无**。执行前 `information_schema.tables` 查询返回 `[]`，
  说明此前在 SQL Editor 手动执行的 DDL 未留下任何对象（不存在部分成功残留）；
  本轮 `create extension`、`create table`、`create index` 全部 OK，无 Postgres 错误码。
- 建表与索引一律幂等：`create table if not exists`、索引显式命名
  `issues_embedding_idx` / `issues_in_eval_set_idx` / `triage_rules_embedding_idx`。
  全程未执行 DROP TABLE / DROP INDEX / TRUNCATE。
- 导入结果：issues 4200 行，triage_rules 54 行；
  `in_eval_set = true` 0 行（防泄漏过滤有效）；`embedding` 非空 0 行；`raw_labels` 为空 0 行。
- `vector` 扩展已启用；issues 3 个索引、triage_rules 2 个索引；
  `match_issues` / `match_rules` 已创建，`match_issues` 内 `in_eval_set = false` 为强制过滤。

## 2026-09-18 · normalized_text 与 net_text_len 不一致（已知问题，决定保持现状）

- 现象：4200 行中 4196 行 `len(normalize_text(body)) != net_text_len`。
- 根因：`scripts/build_eval_set.py:159` 写 CSV 时把 body 的 `\r`/`\n` 压成空格，
  而 `net_text_len`（同文件第 164 行）是用压平**前**的 body 计算的。
  CSV 中 4200 行 body 均不含换行符，导致 `###` 标题行、``` 代码块、连续空行三条清洗规则全部无法命中。
- 决定：`net_text_len` 沿用 CSV 原值，`normalized_text` 按与 `net_text_length` 完全一致的清洗逻辑生成，
  两者数值允许不等。检索只依赖 embedding，不影响后续使用。
- 一致性保障：脚本内保留严格断言，`STRICT_NORM_ASSERT=1` 时任一行不一致即中止并报告该行 number
  （实测在 `number=70785` 中止）。
- 后续修正（同日）：`normalize_text` 改为不依赖换行的模板标题按名匹配规则，
  并对已入库 4200 行批量 `UPDATE normalized_text`（单事务，未重新导入、未改 `net_text_len`）。
  修正后：含 `###` 的行数 0；`|length(normalized_text) - net_text_len|` 中位数 1.0、90 分位 85.0。
  `net_text_len` 仍为 CSV 原值，两列口径差异按上述决定保留。

## 2026-09-20 · 分诊模型调用降级与 json_schema 不兼容排查

- 现象：自造样本调用 `POST /api/triage` 返回 HTTP 200，但 `meta.fallbackUsed = true`、
  `retryCount = 0`、`latencyMs` 极短、`inputTokens/outputTokens` 均为 0；
  `topicCandidates: []`、`severity: {low, 0, ["none"]}`、`infoSufficiency: "insufficient"`
  均为 `route.ts` 的降级占位值，非模型判定。
- 根因：`lib/triage/model.ts` 用 AI SDK `generateObject` + `openai.chat()`，
  默认发送 `response_format: {type: "json_schema"}`；DeepSeek 端点不支持该类型，返回
  HTTP 400。按 `isRecoverableModelError`，400 属不可恢复错误 → 不重试、直接降级，故上述字段形态。
- 实测两种 response_format（直接以同环境变量请求 `https://api.deepseek.com/chat/completions`）：
  - `json_schema`（strict）→ 400 `{"error":{"message":"This response_format type is unavailable now","type":"invalid_request_error","code":"invalid_request_error"}}`
  - `json_object` → 400 `{"error":{"message":"Prompt must contain the word 'json' in some form to use 'response_format' of type 'json_object'."}}`
  - 结论：API Key 有效（无 401）；DeepSeek 支持 `json_object`，但要求提示词含 json 字样。
- 处理方式（第一步最小改动）：给 `generateObject` 显式加 `mode: "json"`。
  实测**无效**——项目用的 `ai` 为 v7.0.97，该版本已移除 `mode` 参数，传入后被忽略，
  仍发送 `json_schema`，DeepSeek 依旧返回 400 原文（服务端外复现脚本两次响应一致）。
  该行暂保留并注明实测结论，待定夺后决定是否删除；**最终已删除**（保留无效参数会误导后续读者），
  `lib/triage/model.ts` 回到改前状态。
- 未做：未改 Zod Schema、未改 `prompts/triage_v1_0.ts`、未改重试分类逻辑。
- 可行性探测结果（严格复刻 `model.ts` 调用参数，服务端外执行，同一样本）：
  - 探测 1（关闭 structured outputs）：**失败**。`@ai-sdk/openai` 4.0.65 的
    `OpenAILanguageModelChatOptions` 无 `structuredOutputs` 选项（仅有 `strictJsonSchema`
    等），传入后被静默忽略；`strictJsonSchema: false` 只把 `strict` 置 false，
    `type` 仍是 `json_schema`。三种设置（默认 / `structuredOutputs:false` / `strictJsonSchema:false`）
    均返回同一 400：`This response_format type is unavailable now`。
    依据 `dist/index.js`：`responseFormat.schema != null` 时无条件发 `json_schema`。
  - 探测 2（百炼兼容端点 `https://dashscope.aliyuncs.com/compatible-mode/v1`，模型 `qwen-plus`）：
    **成功**。耗时 4.5 s，usage 258/180；返回 3 项 topicCandidates
    （editor 0.95 / core 0.8 / gui 0.6）、severity = crash（signals: crash_keyword, version_regression）、
    infoSufficiency = sufficient。
- 备选路径（未采纳，待定）：① 换支持 `json_schema` 的端点/模型（百炼已实测可用）；
  ② 保留 DeepSeek，改用 `generateText` + 提示词约束 JSON + 自研解析（需重跑解析成功率指标）。
  约束：第 2 周模型对比要求两个模型走同一条调用路径，若 DeepSeek 无法走 `generateObject`，
  则"DeepSeek vs 百炼"的对比只能统一降级到路径 ②，否则对比结论无法区分模型差异与调用方式差异。
- 附注：`duplicates: []` / `isDuplicate: false` 是 `route.ts` 中 `resolveDuplicates()` 的
  当前 TODO 固定返回（向量检索尚未接入路由），属预期行为，非故障。

### 决定：主模型换百炼 qwen-plus（方案 ①，零代码改动）

- 决策依据（按权重）：① 零代码改动，W1 关卡未过、时间最稀缺；② 百炼支持
  `response_format: json_schema`，格式由 API 强制，`parseSuccessRate` 接近上限；
  ③ 成本更低（实测 258 input / 180 output token）；④ 不新增解析层，无新增 bug 风险。
- 落地：仅改 `.env.local` 三行 —— `PRIMARY_MODEL_API_KEY`（百炼 Key）、
  `PRIMARY_MODEL_ID=qwen-plus`、`OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`。
  代码一行未动（`lib/triage/model.ts`、Schema、prompts、重试分类逻辑均未改）；
  `.env.local` 中 DeepSeek 相关配置注释保留未删。
- 重启 dev server 后同一样本实测：`fallbackUsed = false`，`modelId = qwen-plus`，
  `latencyMs = 4444`，`inputTokens/outputTokens = 258/178`，`retryCount = 0`；
  topicCandidates 3 项（editor 0.95 / core 0.8 / gui 0.6），
  severity = crash（signals: crash_keyword、version_regression），infoSufficiency = sufficient。
- **长期约束（供日后查阅，勿重复排查）**：DeepSeek 端点不支持 `response_format: json_schema`，
  而 `ai` v7 的 `generateObject` 只要有 Schema 就必然发该类型，无开关可关
  （`structuredOutputs` 选项在 `@ai-sdk/openai` 4.0.65 不存在，`mode` 参数已被 v7 移除）。
  因此 DeepSeek 无法与 `generateObject` 组合使用；若要重新启用 DeepSeek，
  必须整条链路改为 `generateText` + 提示词约束 + 解析，并注意其 `json_object` 模式
  要求提示词含 json 字样（与 PD-07 第 6.1 节"v1.0 不含 JSON 格式说明"冲突，需一并裁决）。

### 模型对比实验重新定义：qwen-plus vs qwen-max

- 原计划"DeepSeek vs 百炼"作废：因 DeepSeek 无法走 `generateObject`，
  两 arm 调用方式不同，对比结论无法区分"模型差异"与"调用方式差异"，实验失效。
- 改为百炼内部档位对比：**qwen-plus vs qwen-max**，两者均走同一条 `generateObject` 路径。
- 该对比回答的是更有产品价值的问题：为更强的模型多付费，能否换来足够的准确率提升。
- 执行时点：第 2 周；切换方式：只改 `PRIMARY_MODEL_ID` 一个环境变量，`meta.modelId`
  即为分组依据，无需改代码。

## 2026-09-20 · 向量生成（PD-06 第 8 节）

- 脚本：`scripts/generate_embeddings.py`（`--estimate` 试算 / `--status` 查进度 / 默认执行）。
  依赖 `psycopg2-binary` + `python-dotenv`；连接串仍从 `.env.local` 的 `DATABASE_URL` 解析，不打印。
- 端点：DashScope OpenAI 兼容模式 `https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings`，
  模型 `text-embedding-v4`，请求体显式带 `dimensions=1536`（与 `vector(1536)` 一致）。
- 失败一：首轮 4254 条全部 `HTTP 401 invalid_api_key`。
  根因：`.env.local` 的 `EMBEDDING_API_KEY` 当时误填为 `PRIMARY_MODEL_API_KEY`（DeepSeek 风格 Key，
  不适用于 DashScope）。未产生任何费用，也未写入任何向量（进程被中止，事务未提交）。
- 处置：401/403 判定为不可恢复错误，**不重试且立即中止整轮**（新增 `EmbeddingAuthError`
  向上抛出），避免空跑剩余批次；其余网络/超时/5xx/429 仍按 3 次退避重试。
- 结果：成功 4254 条（issues 4200 + triage_rules 54），失败 0 条；
  总 token 1,358,482，总耗时 1515.4 秒（约 25 分钟，批大小 10）。
- 入库确认：issues embedding 非空 4200 行；`in_eval_set = true` 却有向量 0 行（防泄漏有效）；
  triage_rules embedding 非空 54 行；`vector_dims` 唯一值 1536。

## 2026-09-20 · 查重测试集构建与"原单在检索库内"过滤

- 数据源：`godot_issues_raw.json` 已不存在，改用 GitHub Search API
  `type:issue label:bug state:closed reason:duplicate`（实测 total_count = 310）。
- 提取规则修正：原脚本只认 `#编号`，实测 Godot 维护者大量使用完整 URL
  （"duplicate of https://github.com/godotengine/godot/issues/86970"），
  补 URL 形式后提取对数 101 → 193。含 "not a duplicate" 的评论不做 URL 兜底。
  强度分三类：strong（# 编号）/ url（URL）/ weak（see/related to/fixed by，需人工确认）。
- 关键过滤：每对检查原单 O 是否存在于检索库（issues 表 in_eval_set = false 的行，4200 条）。
  193 对中仅 **37 对**满足（≥ 下限 30，未达目标 50）；
  被剔除 156 对的原单**完全不在 issues 表**（未被抓取 / 非 bug 标签 / 未关闭），
  无一是"在库中但属评测集"的情况。
- 另记：37 对中 26 对的重复单 D 自身也在检索库内 → 检索必然命中自身（sim≈1.0），
  会占用 Top-5 的一个位置，评测口径须显式处理（过滤自身或记为已命中）。
- 产出：`data/dup_testset.csv`（37 对可用）+ `data/dup_testset_all.csv`
  （193 对，含 `target_in_retrieval` / `dup_in_retrieval` 标记列，供复核）。

## 2026-09-18 · triage_rules 规则库过滤

- `data/triage_rules.csv` 由 78 条过滤至 54 条：删除项目管理流程类（milestone / assignee / projects /
  linked PR / claim / close reason）与贡献者协作状态类（Archived / Cherrypick / Documentation /
  Feature proposal / For PR meeting / Good first issue / Salvageable / Spam / Tracker）。
- 目的：该库用于 RAG 检索注入提示词，与模块、严重度判定无关的条文会稀释有效信息。
