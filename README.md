# Bug Triage Assistant

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Capability Status & Known Limitations

Evaluated on **300 held-out Godot issues** — a 280-issue main set plus a 20-case adversarial set — and 37 duplicate pairs, across **six** controlled batches. Current configuration: prompt v2.0 + qwen-plus.

**Working capabilities**

| Capability | Result | Human baseline |
| --- | --- | --- |
| Module classification Top-1 | 73.21% | 60.0% |
| Module classification Top-3 | 95.00% | 80.0% |
| Structured output parse rate | 99.64% | — |

> Human baseline comes from a 20-question set (PD-12 §2.1): module Top-1 60.0%, Top-3 80.0%, severity 60.0%. Note the small sample — at n=20 the 95% CI is roughly ±21pp, so this is a reference point, not a statistically tight comparison.

**Known limitations (disclosed, not hidden)**

| Limitation | Fact |
| --- | --- |
| Severity (4-level) accuracy | 44.29% in the current batch; best 46.07% across all batches — both **below the 56.43% naive baseline** (predicting `low` for everything) and below the human baseline of 60.0% |
| `other` class | F1 = 0 in the first four batches; 0.04 in the `qwen3-max` cross-model batch; 0.2456 in the current one; excluded from Macro-F1 |
| Confidence calibration | Uncalibrated: the model reports a median 98% confidence while Top-1 accuracy is 73% — percentages indicate relative ranking only, not correctness probability |
| Information-sufficiency detection | 25% correctly flagged in the current batch (20%–40% across six batches); 20-sample set, indicative only |
| Duplicate detection Precision | 0.5909 (target ≥ 0.75); Recall@5 = 0.4865 (target ≥ 60%) — identical in every batch that ran the duplicate stage, because it depends only on the retrieval corpus and threshold, not on the prompt or model; the `sev-defined` batch did not run this stage |
| `isDuplicate` | Judged by similarity only, missing the "model semantic confirmation" required by the contract — may produce false positives |

**On severity**: six controlled batches were run — minimal prompt, adjective definitions, sequential decision procedure, few-shot anchors, a cross-model test with the flagship `qwen3-max`, and retrieval augmentation (RAG). None beat the naive baseline. In the cross-model test, classification rose +4.84pp while severity rose only +2.55pp, indicating the bottleneck is the semantic decidability of the severity levels themselves, not model capability. Severity is therefore **not a usable capability** and was not pursued further.

**On model choice**: `qwen3-max` scores higher on Top-1 (77.86% vs 73.21%) but costs roughly 5–6× more per call (see `.env.example`). The default primary model therefore remains `qwen-plus`.

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in the required values (see `.env.example` for the complete list):

| Variable | Purpose |
| --- | --- |
| `PRIMARY_MODEL_API_KEY` / `OPENAI_BASE_URL` / `PRIMARY_MODEL_ID` | Triage model (DashScope, OpenAI-compatible) |
| `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL_ID` | Embedding model used for retrieval |
| `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Retrieval corpus (Postgres + pgvector) |

`DATABASE_URL` and `GITHUB_TOKEN` are only needed by the offline Python scripts (schema creation, data fetching) — not by the web app.

### 3. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 4. Verify retrieval is actually working

Submit one of the sample issues on the workbench. If the **相似历史 Issue / Similar historical issues** block lists several historical issues, retrieval is working.

If it is **empty**, the embedding variables are missing or wrong — retrieval then falls back to plain LLM **silently** (the page still returns results, no error shown).

### 5. (Optional) Run the evaluation

```bash
.venv/Scripts/python.exe scripts/run_eval.py --run-id <your-run-id>
```

On macOS/Linux use `.venv/bin/python`. The `.venv` interpreter is required: the global Python lacks `psycopg2`, and the duplicate-detection stage will be skipped silently without it.

## Offline Scripts (Python)

These are **not** used by the web app. They need the `.venv` interpreter (the global Python lacks `psycopg2`), plus `DATABASE_URL` and `GITHUB_TOKEN`.

| Script | Purpose |
| --- | --- |
| `fetch_godot_issues.py` | Pull closed Godot bug issues sliced by year (works around the Search API's 1000-result cap); outputs CSV + JSON |
| `build_eval_set.py` | Build the 280-issue main set, the 20-case adversarial set, and the retrieval corpus from the remainder; sets the `in_eval_set` leakage guard |
| `build_dup_testset.py` | Extract "duplicate → original" pairs from issue comments and emit the duplicate test set (37 pairs) |
| `import_to_supabase.py` | Idempotent create table / index / RPC functions, then bulk import and self-verify |
| `generate_embeddings.py` | Vectorise the retrieval corpus (`text-embedding-v4`, explicit `dimensions=1536`) |
| `smoke_retrieval_test.py` | Smoke test: retrieval works, the HNSW index is actually used, and leakage protection holds |
| `run_eval.py` | End-to-end batch evaluation through `POST /api/triage` (main set + adversarial set + duplicate stage) |
| `check_prompt.py` | Prompt consistency checks: enum parity with `contract.ts`, no JSON format instructions, few-shot leakage |
| `build_eval_history.py` | Regenerate `lib/eval-history.ts` from `data/eval_metrics_*.json` |

## Data Source

Evaluation and retrieval data come from **public Godot Engine issues** (`godotengine/godot` on GitHub). Ground-truth labels are derived from maintainer-assigned labels.

- Retrieval corpus: 4,200 issues, embedded and stored in Postgres with pgvector.
- Evaluation set: 280 held-out issues + 20 adversarial cases + 37 duplicate pairs.
- **Leakage control**: the retrieval corpus is filtered by `in_eval_set = false` at the SQL layer, so evaluated issues can never be retrieved.

Internal company bug data was **not used** — it is confidential. Consequently, transferability of these results to enterprise bug distributions is unverified.

## Maintenance Note

The report page (`/report`) and about page (`/about`) are **statically prerendered**: their metrics are baked into `lib/eval-history.ts` at build time.

**After adding a new evaluation batch, you must regenerate `lib/eval-history.ts` and commit it.** Adding JSON files under `data/` alone will not update the pages. Regenerate it with `.venv/Scripts/python.exe scripts/build_eval_history.py` (`.venv/bin/python` on macOS/Linux) — see that file for usage. That file is generated — do not edit it by hand.
