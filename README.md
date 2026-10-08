# Bug Triage Assistant

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Capability Status & Known Limitations

Evaluated on 280 held-out Godot issues (20 adversarial cases, 37 duplicate pairs) across **six** controlled batches. Current configuration: prompt v2.0 + qwen-plus.

**Working capabilities**

| Capability | Result | Human baseline |
| --- | --- | --- |
| Module classification Top-1 | 73.21% | 60.0% |
| Module classification Top-3 | 95.00% | 80.0% |
| Structured output parse rate | 99.64% | — |

**Known limitations (disclosed, not hidden)**

| Limitation | Fact |
| --- | --- |
| Severity (4-level) accuracy | 44.29% in the current batch; best 46.07% across all batches — both **below the 56.43% naive baseline** (predicting `low` for everything) |
| `other` class | F1 = 0 in the first four batches; 0.2456 in the current one; excluded from Macro-F1 |
| Confidence calibration | Uncalibrated: the model reports a median 98% confidence while Top-1 accuracy is 73% — percentages indicate relative ranking only, not correctness probability |
| Information-sufficiency detection | 25% correctly flagged in the current batch (20%–40% across six batches); 20-sample set, indicative only |
| Duplicate detection Precision | 0.5909, below the 0.75 threshold; Recall@5 = 0.4865 |
| `isDuplicate` | Judged by similarity only, missing the "model semantic confirmation" required by the contract — may produce false positives |

**On severity**: six controlled batches were run — minimal prompt, adjective definitions, sequential decision procedure, few-shot anchors, a cross-model test with the flagship `qwen3-max`, and retrieval augmentation (RAG). None beat the naive baseline. In the cross-model test, classification rose +4.84pp while severity rose only +2.54pp, indicating the bottleneck is the semantic decidability of the severity levels themselves, not model capability. Severity is therefore **not a usable capability** and was not pursued further.

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

Submit one of the sample issues on the workbench. If the "What the AI referenced" block has content, retrieval is working.

If it is **empty**, the embedding variables are missing or wrong — retrieval then falls back to plain LLM **silently** (the page still returns results, no error shown).

### 5. (Optional) Run the evaluation

```bash
.venv/Scripts/python.exe scripts/run_eval.py --run-id <your-run-id>
```

On macOS/Linux use `.venv/bin/python`. The `.venv` interpreter is required: the global Python lacks `psycopg2`, and the duplicate-detection stage will be skipped silently without it.

## Data Source

Evaluation and retrieval data come from **public Godot Engine issues** (`godotengine/godot` on GitHub). Ground-truth labels are derived from maintainer-assigned labels.

- Retrieval corpus: 4,200 issues, embedded and stored in Postgres with pgvector.
- Evaluation set: 280 held-out issues + 20 adversarial cases + 37 duplicate pairs.
- **Leakage control**: the retrieval corpus is filtered by `in_eval_set = false` at the SQL layer, so evaluated issues can never be retrieved.

Internal company bug data was **not used** — it is confidential. Consequently, transferability of these results to enterprise bug distributions is unverified.

## Maintenance Note

The report page (`/report`) and about page (`/about`) are **statically prerendered**: their metrics are baked into `lib/eval-history.ts` at build time.

**After adding a new evaluation batch, you must regenerate `lib/eval-history.ts` and commit it.** Adding JSON files under `data/` alone will not update the pages. Regenerate it with `.venv/Scripts/python.exe scripts/build_eval_history.py` (`.venv/bin/python` on macOS/Linux) — see that file for usage. That file is generated — do not edit it by hand.
