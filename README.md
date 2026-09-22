# Bug Triage Assistant

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Capability Status & Known Limitations

Evaluated on 280 held-out Godot issues (20 adversarial, 37 duplicate pairs) across 5 controlled batches.

**Working capabilities**

| Capability | Result | Human baseline |
| --- | --- | --- |
| Module classification Top-1 | 73.02% | 60.0% |
| Module classification Top-3 | 89.93% | 80.0% |
| Structured output parse rate | 100% | — |

**Known limitations (disclosed, not hidden)**

| Limitation | Fact |
| --- | --- |
| Severity (4-level) accuracy | 46.07% best — **below the 56.4% naive baseline** (predicting `low` for everything) |
| `other` class | F1 = 0; excluded from Macro-F1 per evaluation spec |
| Information-sufficiency detection | 20% correctly flagged on the adversarial set (20 samples) |
| Duplicate detection Precision | 0.5909, below the 0.75 threshold; Recall@5 = 0.4865 |

**On severity**: five controlled batches were run — minimal prompt, adjective definitions, sequential decision procedure, few-shot anchors, and a cross-model test with the flagship `qwen3-max`. None beat the naive baseline. In the cross-model test, classification rose +4.84pp while severity rose only +2.54pp, indicating the bottleneck is the semantic decidability of the severity levels themselves, not model capability. Severity is therefore **not a usable capability** and was not pursued further.

**Data**: Godot public issues. Internal company data was not usable (confidentiality), so transferability to enterprise bug distributions is unverified.

## Getting Started

First, run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.
