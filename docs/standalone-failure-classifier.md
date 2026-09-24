# Standalone: the failure classifier

> One à-la-carte piece of the pipeline (IMPROVEMENT-PLAN Phase 7 / PFI-6).
> Adopt this without buying the whole flow. It turns a Playwright (and
> optional Newman) result file into a **classified** failure analysis — each
> failure tagged with a cause and a Green/Yellow/Red severity — so triage
> starts from signal, not a wall of stack traces.

## What you get

A **draft** `analysis/failure-analysis.json` (schema
`schemas/failure-analysis.schema.json`, version 2.0): every failed, blocked and
flaky test mapped to a closed taxonomy (`locator_or_selector`, `product_bug`,
`environment_issue`, …) and a severity that says what may be done about it —
**Green** (mechanically healable), **Yellow** (needs a human look), **Red** (a
real product bug). Each failure records the evidence behind the call in
`classification_reason`, so a reviewer can check it instead of trusting it.

It is **rule-based and deterministic** — zero LLM cost for the obvious cases;
genuinely ambiguous failures are marked `unknown_needs_human_review` rather
than guessed. It classifies from what Playwright says actually **failed** (the
operation and its `Expected:` / `Received:` values), not from keywords: a
wrong business value such as `$1.00` where `$100.00` was required is Red even
though the message mentions a locator, and Green is granted only to a locator
that could not be found during an action, outside the Red domains.

It writes a **draft**. It creates no bug drafts and finalizes nothing: the
Failure Classifier Agent (or a human) confirms each call, writes a bug draft
for every Red failure, resolves or acknowledges unresolved links, and sets
`status: "finalized"`. The Reporter and the TestLink sync refuse a draft.

## Prerequisites (read this — it's not zero-ceremony)

- A Playwright JSON report at `reports/results.json` (the repo's
  `playwright.config.ts` already emits this; or point your own run at it),
  and/or Newman reports.
- That run **normalized into an execution ledger** (`npm run normalize`,
  `docs/execution-normalization.md`). The classifier reads the ledger, never
  raw reports: raw reports dropped timed-out tests and let pass counts go
  negative.
- A `context.json` at the repo root **with Gate 4 (`code_reviewed`) passed.**
  This is a deliberate safety precondition, not an accident: classifying
  _unreviewed_ code is forbidden (`agents/failure-classifier.md` §2) — you
  don't triage tests nobody has reviewed. If you only have a raw report and no
  reviewed context, this tool will (correctly) refuse; that's the honesty
  boundary, and it's the one piece of "ceremony" this otherwise-standalone tool
  keeps.

## Quickstart (≤5 commands)

```bash
# 1. Have a Playwright JSON report (reports/results.json).
npx playwright test                       # or your own run, JSON reporter

# 2. Have a Gate-4-passed context.json at the root (minimal is fine).
#    review_gates.code_reviewed must be true (or { "status": true }).

# 3. Normalize the run into an execution ledger.
npm run normalize -- --story <STORY-ID> --playwright reports/results.json

# 4. Write the draft analysis/failure-analysis.json (--dry-run to preview).
node scripts/run-failure-classifier.js

# 5. (optional) Fail your CI if any product bug was found.
node scripts/run-failure-classifier.js --blocking   # exit 1 on a product_bug
```

## Hard limits

- It resolves ids **only from exact metadata** the report carries — the test
  title (`… [TC-002]`) and the Newman item name (`REQ-001 … (TC-001)`). An id
  it cannot prove stays `null` with a reason; it is never derived from the
  order failures appear. Conflicting ids are left unresolved, never chosen
  between.
- `--blocking` fails CI on **product bugs only**. It is not a release
  recommendation — flaky, blocked and unverified results do not trip it. The
  Reporter owns the release call.
- It **does not** call an LLM — a headless script can't. It maps the obvious
  and escalates the rest.
- The Gate-4 precondition is **not** removable here. If you want
  classification without it, you've left the safety model this tool is part of.

## Borrowing just the idea

If you can't (or won't) adopt the script, the reusable concept is the
**two-axis classification**: a _cause_ taxonomy + a _Green/Yellow/Red severity_
that dictates who may act (`docs/healer-guardrails.md`). That separation —
"what kind of failure" vs "what's allowed to happen about it" — is portable to
any test stack.

## References

- `scripts/run-failure-classifier.js` — the tool.
- `schemas/failure-analysis.schema.json` — the output contract.
- `docs/healer-guardrails.md` — the Green/Yellow/Red severity axis.
- `docs/when-to-use.md` — whether you want the whole pipeline instead.
