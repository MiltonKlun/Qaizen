# `evidence/` — benchmark measurement data

> **Owner:** Human / team (IMPROVEMENT-PLAN Phase 5). This folder holds the
> raw measurements behind `docs/evidence.md` — the pipeline-vs-raw-prompting
> benchmark (`docs/benchmark-protocol.md`).

## What lives here

- **`benchmark.jsonl`** — one JSON object per line, each a measurement of one
  story under one arm (`raw` or `pipeline`). Every line validates against
  `schemas/benchmark-record.schema.json`. Appended by
  `npm run benchmark:capture` (`scripts/benchmark-capture.js`); never edited by
  an agent. Created on first capture; absent until the run series starts.

## How records get here

```bash
# Append one measurement (see scripts/benchmark-capture.js --help for fields).
npm run benchmark:capture -- --story SK-42 --arm pipeline --track standard \
  --time-to-green 14.5 --gate4-corrections 1 --fictional-rate 0 \
  --selector-survival 1 --known-bug-catch 1 --traceability 1 \
  --note "one Gate-4 correction; full traceability"
```

The capture script validates each record against the schema **before**
appending, so a malformed measurement never lands in the file (discipline
rule 3 — validate before saving).

## Honesty rules (from the protocol)

- A metric that was not measured is recorded as `null`, never as `0`. A gap
  is explicit.
- The raw arm's `traceability_coverage` is expected near 0 — that is a real
  property of raw prompting, not a measurement defect.
- `docs/evidence.md` must report **where raw prompting won**, not only where
  the pipeline did.
