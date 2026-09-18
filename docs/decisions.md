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

## 2026-09-18 · triage_rules 规则库过滤

- `data/triage_rules.csv` 由 78 条过滤至 54 条：删除项目管理流程类（milestone / assignee / projects /
  linked PR / claim / close reason）与贡献者协作状态类（Archived / Cherrypick / Documentation /
  Feature proposal / For PR meeting / Good first issue / Salvageable / Spam / Tracker）。
- 目的：该库用于 RAG 检索注入提示词，与模块、严重度判定无关的条文会稀释有效信息。
