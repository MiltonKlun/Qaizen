# Standalone: the test designer (Automation Decision Model)

> One à-la-carte piece (IMPROVEMENT-PLAN Phase 7 / PFI-6). Unlike the other
> two, this one is **a prompt + a decision model, not a CLI script**. You adopt
> it by pointing your AI at the agent prompt and the model — turning a story
> into a prioritized, justified set of test cases, each with an explicit
> "automate how / or not" decision.

## What you get

From a story (+ its risks), a `test-cases` list where **every case** carries:

- a priority (`P0`–`P3`) and a risk linkage (`risk_ids`),
- an **Automation Decision** — `automate_e2e` / `automate_api` /
  `automate_component` / `manual` / `skip` — with a **real written reason**
  (`automation_decision_reason`), not "it's UI",
- steps + expected results.

The discipline that makes this worth adopting: it is **forbidden to mark
everything E2E**. The model forces a deliberate per-case choice, which is the
single biggest lever against a slow, brittle, all-E2E suite.

## Prerequisites

- An AI you can hand a prompt to (Claude Code or equivalent).
- The story text + a sense of its risks (the Analyst produces these upstream in
  the full pipeline, but for standalone use you can supply them yourself).

## Quickstart (≤5 steps — it's a prompt workflow, not 5 shell commands)

```text
1. Read agents/test-designer.md — that IS the prompt; its rules are binding.
2. Read docs/automation-decision-model.md — the five decisions + when each is right.
3. Give your AI: the story, the risks, and those two files as context.
4. Ask it to produce a test-cases list applying the model — decision + a REAL
   reason on every case; never default to automate_e2e.
5. (optional) Validate the JSON against schemas/test-cases.schema.json:
     node scripts/validate-json.js schemas/test-cases.schema.json <your-file>.json
```

## Hard limits

- It produces **test cases**, not runnable tests. (Turning a case into a test
  against the _running app_ is the Planner/Generator's job — and the pipeline's
  rule that tests are never written from text alone.)
- The decision + reason are **mandatory in every track**, including lite
  (`docs/automation-decision-model.md`). Lite trims prose, never this decision.
- A generic reason ("it's automated") is a Gate-2 rejection in the full
  pipeline; hold yourself to the same bar standalone or you lose the value.

## Borrowing just the idea

Even without the JSON schema, the portable artifact is the **Automation
Decision Model itself**: a closed set of five choices, each with a written
justification, and a ban on defaulting to E2E. Tape that table to the wall of
any test-design session and you've adopted 80% of the value.

## References

- `agents/test-designer.md` — the prompt (the thing you actually adopt).
- `docs/automation-decision-model.md` — the five decisions.
- `schemas/test-cases.schema.json` — the output contract (optional validation).
- `docs/when-to-use.md` — whether you want the whole pipeline instead.
