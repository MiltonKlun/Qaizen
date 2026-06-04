---
name: planning-tests
description: |
  Plan phase. Reads context.json (post-Gate-1) and produces the planner brief
  consumed by the Playwright Planner Native Agent. The brief is a focused
  Markdown summary of the story, acceptance criteria, risks, in-scope
  scenarios, out-of-scope items, and any UI baseline notes. It does NOT
  contain step-by-step test cases — those live in test-cases/[story-id].json
  (produced by the designing-cases skill).
disable-model-invocation: true
adapted_from: dogkeeper886/ai-qa-workflow @ v3.0
adaptation_notes: |
  Original skill produced an ISO/IEC/IEEE 29119-3 test plan tree
  (test_plan/sections/, test_design/scenarios/TS-XX, traceability matrix,
  risk register) and published 13–17 pages to Confluence using
  mcp-atlassian:confluence_create_page with per-page format gotchas. We do
  not publish to Confluence in this pipeline. Our planner brief is a single
  Markdown file consumed downstream by the Playwright Planner Native Agent
  (.claude/agents/playwright-test-planner.md). The "what to test" lives in
  the brief; the "step-by-step cases" live in the test-cases JSON, which is
  the designing-cases skill's responsibility.
tools:
  - Read
  - Glob
  - Grep
---

# planning-tests

**Phase:** 1+
**Owned by this skill:** the `agents/test-designer.md` agent uses this
skill (together with `designing-cases`) to produce
`planner-input/[story-id].planner-brief.md`.
**Folder ownership:** writes only into `planner-input/`. Never touches
`test-cases/` (that's `designing-cases`), `specs/` (that's the Playwright
Planner Native Agent), `tests/` (that's the Playwright Generator Native
Agent), `analysis/`, or `release/`.
**Gate upstream:** **Gate 1** must already be passed
(`context.json.review_gates.requirements_reviewed == true`).
**Gate downstream:** **Gate 2 — Test Scope Approval** runs after this skill
_and_ `designing-cases` both complete.

## Hard precondition

If `context.json.review_gates.requirements_reviewed != true`, **stop**.
Tell the human: "Gate 1 has not passed; planning cannot begin." Do not
attempt to plan from a story whose ambiguities were never reviewed.

This is the same stop rule documented in `CLAUDE.md` section 3.5.

## What this skill produces

A single file: `planner-input/[story-id].planner-brief.md`, where
`[story-id]` is `context.json.story.id` (e.g. `JIRA-1234.planner-brief.md`
or `STORY-001.planner-brief.md`).

This file is consumed by the Playwright Planner Native Agent
(`.claude/agents/playwright-test-planner.md`) along with the
`tests/seed.spec.ts` to drive the Planner's exploration of the
application via the `playwright-test` MCP. See `docs/seed-test-guidelines.md`.

## Required brief structure

The brief is human-readable Markdown. There is no JSON schema for it
(the Planner is an LLM, not a validator), but the structure below is
load-bearing — sections out of order or missing will confuse downstream
agents.

```markdown
# Planner Brief — [story.id]: [story.title]

## Story summary

[2–4 sentences. What is the user trying to do, and why.]

## Acceptance criteria

[Numbered list, copied verbatim from context.json.acceptance_criteria.
Do not paraphrase. Do not invent.]

## Risks (anchors)

[For each RISK-XXX from context.json.risks:]

- **RISK-001** (severity): [description]. Related ACs: [list].

## In-scope scenarios for the Playwright Planner

[High-level scenarios the Planner should explore. One per bullet, each
tagged with the RISK-XXX it primarily addresses. Do NOT write steps
here — the Planner discovers steps by driving the app. Each scenario
should map to one or more TC-XXX once designing-cases runs.]

## Out-of-scope for the Planner

[Explicit exclusions. Things the Planner should NOT explore:

- Other features.
- Pre-existing behavior unrelated to this story (e.g. regression of
  functionality that this story does not touch).
- Flows the story explicitly defers.
  This list is the single biggest defense against bloated test plans;
  the source skill calls it out as the most common failure mode.]

## UI baseline notes (if available)

[Anything the analyst observed in the live app that the Planner should
know — feature flags, hidden controls, "tab vs route" semantics,
wireframe-vs-reality deltas. Omit this section if no baseline trace
was done; the Planner will then explore from scratch.]

## Ambiguities still open

[Non-blocking ambiguities from context.json.ambiguities that the Planner
should be aware of but should not stop on. Blocking ambiguities should
have prevented Gate 1 from passing in the first place.]

## Traceability

- Story: [story.id]
- Risks covered: [RISK-001, RISK-002, ...]
- This brief is the source for: planner-input/[story-id].planner-brief.md
  → specs/[story-id].md (SPEC-XXX) → tests/[story-id].spec.ts (PW-XXX)
```

After writing, update `context.json.artifact_paths.planner_brief` to the
relative path of the new file, then re-validate `context.json`.

## Traceability rules

- The brief MUST reference every `RISK-XXX` from `context.json.risks`.
  If a risk has no in-scope scenario, the brief still lists it under
  Risks (anchors) and explicitly notes "Not addressed by this slice —
  defer or escalate." Silently dropping a risk is a Gate 2 rejection.
- The brief does NOT mint new `TC-XXX` IDs. That is `designing-cases`'
  job. The brief talks about scenarios in plain language; the test
  cases will later be linked back to the brief by referencing
  `context.json.story.id` and the relevant `RISK-XXX`.

## Out-of-scope work (do not do here)

- Writing step-by-step test cases (→ `designing-cases`).
- Assigning automation decisions (→ `designing-cases`, applies the
  Automation Decision Model from `docs/automation-decision-model.md`).
- Producing Playwright specs (→ Playwright Planner Native Agent, after
  Gate 3 setup).
- Producing Playwright tests (→ Playwright Generator Native Agent,
  after Gate 4).
- Publishing to Confluence — not in this pipeline.
- Anything in TestLink — Phase 2.

## When to STOP and ask

- `requirements_reviewed != true` → hard stop, no negotiation.
- The story has zero risks but acceptance criteria implying real
  consequences → ask whether the risks were under-documented.
- An AC genuinely cannot be expressed as one or more scenarios → record
  in `context.json.ambiguities` with `blocking: true`, stop.

## Gate 2 hand-off

After this skill _and_ `designing-cases` both finish, Gate 2 runs. See
`docs/review-gates.md` for the criteria. Both artifacts
(`planner-input/[story-id].planner-brief.md` and
`test-cases/[story-id].json`) are required inputs.

## Next step

Run the `designing-cases` skill to produce `test-cases/[story-id].json`.

## References

- `schemas/context.schema.json` — the schema for `context.json` this
  skill reads (created in Phase 1 TG7).
- `docs/review-gates.md` — Gate 1 precondition and Gate 2 criteria
  (created in Phase 1 TG6).
- `docs/traceability.md` — full traceability chain (created in Phase 1 TG6).
- `docs/seed-test-guidelines.md` — how the brief and the seed test
  together drive the Playwright Planner (created in Phase 1 TG6).
- `docs/automation-decision-model.md` — referenced by `designing-cases`,
  not this skill, but listed here so the reader knows where it lives.
- `agents/test-designer.md` — the agent prompt that orchestrates both
  this skill and `designing-cases` (created in Phase 1 TG10).
- `.claude/agents/playwright-test-planner.md` — the Native Agent that
  consumes the brief (scaffolded in Phase 1 TG3).
