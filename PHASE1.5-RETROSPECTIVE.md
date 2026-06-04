# Phase 1.5 — Retrospective

> **Status:** Phase 1.5 complete. This file is the prerequisite for starting
> Phase 2 (`README.md` section 3).
>
> Run that closed Phase 1.5: STORY-002 (composite Account access &
> provisioning). Run ID: `2026-05-31T19-00-00Z-tg9run`.
> Completion date: 2026-05-31.

---

## 1. What worked

### 1.1 The API branch executed real HTTP with assertions

The headline result: `npm run test:api STORY_ID=STORY-002` ran 2 requests
and 5 assertions against the live reqres.in API, all passing — create user
→ 201 with `id` + `createdAt` (TC-003), register-without-password → 400
with an error mentioning password (TC-004). The dual flow worked: one
story produced both a Playwright suite (E2E, Saucedemo) and a Newman
collection (API, reqres.in), and the same Reporter unified them with a
grouped `execution_summary { e2e, api, combined }`.

### 1.2 The "do not invent endpoint shapes" rule caught a real change

This is the most important lesson of the phase. The Gate-2-approved API
test cases assumed the classic keyless reqres.in (POST → 201 / 400). When
the API Agent verified the endpoints live (per `agents/api-agent.md` §5),
**both returned `401 missing_api_key`** — reqres.in had added mandatory
free-tier auth. Had the agent written assertions from the TC text alone,
the collection would have been fictional and the slice would have failed
for the wrong reason. The verification step is exactly what the §3.8
"don't generate tests from text alone" rule exists to force. Logged as
`docs/ambiguities.md` A5.

### 1.3 The forward-compat schema hooks made TG3 nearly free

Three of the four "schema updates" in TG3 were no-ops because the Phase 1
TG7 schemas already shipped the API hooks (`api_metadata`,
`source`/`request_id`, the flat-or-grouped `execution_summary` oneOf) with
validated examples. Only `postman-collection.schema.json` was genuinely
new. Backward compatibility was proven by re-validating all Phase 1
artifacts against the post-TG3 schemas — no migration needed.

### 1.4 Extension, not duplication

The Failure Classifier and Reporter were extended to cover both branches,
never forked. One `analysis/failure-analysis.json`, one release report.
The schemas were extended, not duplicated. This held the line the phase
plan's final instruction warned about ("if you find yourself writing a
separate Failure Classifier for API, stop").

### 1.5 The locator policy paid off on the E2E side

The Planner, told to follow `docs/review-gates.md` § locator policy,
evaluated both `[data-test='...']` hooks and `getByRole(...)` and chose
the dedicated test attributes as primary, documenting the runner-up. The
policy added in Phase 1 Gate 4 is now demonstrably steering agent
behavior.

### 1.6 Secret hygiene held in git (the committed artifacts)

The collection references `{{api_key}}`; the committed environment file
has an empty `api_key`; the real value is injected at run time by
`scripts/run-newman.js --env-var` from `REQRES_API_KEY`. No secret is in
any committed file.

---

## 2. What frictioned

### 2.1 reqres.in added mandatory auth (A5)

The biggest friction. The demo API chosen in A3 changed its contract
between the A3 decision and the TG9 run. Resolution: the project owner
provided a free reqres.in key; the Newman environment carries it as
`{{api_key}}` from `.env`. Cost: one blocked step + a round-trip for the
key. Upside: it produced the phase's best validation of the do-not-invent
rule.

### 2.2 Secrets leak into Newman's JSON results

Found at Step 14: `reports/newman-results.json` records the live
`x-api-key` request header (3 occurrences for this run). The file is
gitignored, so it does not reach the repo — but **in Phase 2, CI uploads
Newman results as build artifacts**, where a leaked key would be exposed.
Tracked as a Phase 2 follow-up in A5: scrub `x-api-key` / `Authorization`
from the Newman export before it becomes a CI artifact. Also: the reqres
and Postman keys were visible in the build session and should be rotated.

### 2.3 The Postman MCP package name was wrong in the plan (A4)

`@postman/mcp-server` (plan text) is a 404 on npm; the unscoped
`postman-mcp-server` is third-party (rejected per CLAUDE.md §4/§9). The
official package is `@postman/postman-mcp-server`. The TG1 "verify the
name" instruction caught it. Note: the Postman MCP was configured but
**not actually exercised** this phase — the API Agent authored the
collection directly to the filesystem and verified shapes with `curl`-
equivalent calls; the MCP's read/write-to-cloud path is still unproven.
See §5 recommendation.

### 2.4 The `$STORY_ID` shell-expansion in the plan's test:api script

The plan's literal `newman run ...$STORY_ID...` script does not work when
npm runs scripts through `cmd` on Windows. Wrapped in
`scripts/run-newman.js` (reads `STORY_ID` from env or argv, handles a
missing environment file, returns correct exit codes). Works on
Windows + POSIX + CI.

### 2.5 Composite story is a workaround, not a real dual-surface app

The DoD wants one story with both `automate_e2e` and `automate_api` cases
that both execute. But our E2E target (Saucedemo) and API target
(reqres.in) are different apps, so STORY-002 is a composite: a UI half
(Saucedemo login) and an API half (reqres.in provisioning) bolted under
one story, flagged as a non-blocking ambiguity. It exercised the dual
flow correctly, but the two branches address different risks on different
services rather than one coherent product. A real project would have one
app with both surfaces. The E2E half also re-covers the same login ground
as Phase 1's STORY-001 — the genuine novelty this phase was the API
branch.

### 2.6 API-gate tracking is out-of-band

Gates 3' (collection review) and 4' (API assertion review) were approved,
but `context.json` has no schema key to record them — adding
`collection_reviewed` / `api_assertions_reviewed` is a schema change
(Architecture Stability Rule) deferred to Phase 2. For this run the
approvals are recorded in the release report's open_questions and here.
The four E2E gate booleans remain the schema-tracked ones.

---

## 3. Phase 1.5 — completion criteria verification

Per `phase1.5-api-branch.md` section 4:

| Criterion | Status |
|---|---|
| Postman MCP configured and functional | ✓ configured (`@postman/postman-mcp-server`); functional-but-unexercised (see §2.3) |
| Newman installed and executable | ✓ Newman 6.2.2; `npm run test:api` ran 2 requests / 5 assertions |
| `api-tests/` folder structure exists | ✓ |
| Schemas updated (test-cases, failure-analysis, release-report, + postman-collection) | ✓ (3 already had hooks from TG7; postman-collection newly created) |
| API Agent exists (`agents/api-agent.md`) | ✓ 11 sections, points at the schema, documents COL→REQ→TC |
| Failure Classifier + Reporter updated for both branches | ✓ extended, not duplicated |
| API vertical slice executed with ≥1 `automate_api` | ✓ STORY-002: 2 automate_e2e + 2 automate_api, all passing |
| `PHASE1.5-RETROSPECTIVE.md` exists and reviewed | ✓ this file (review pending) |

### TG9 Definition of Done

| Item | Status |
|---|---|
| One story with ≥1 `automate_api` and ≥1 `automate_e2e` through the full pipeline | ✓ STORY-002 (2 + 2) |
| `api-tests/collections/STORY-002.postman_collection.json` exists and validates | ✓ |
| `api-tests/environments/STORY-002.postman_environment.json` exists | ✓ |
| `reports/newman-results.json` exists with execution results | ✓ 2 req / 5 assertions / 0 failed |
| `analysis/failure-analysis.json` includes both branches | ✓ combined totals; empty failures[] (both branches passed) |
| `release/release-report.md` covers both branches with grouped execution_summary | ✓ |
| `PHASE1.5-RETROSPECTIVE.md` exists | ✓ |

Traceability chain closed across both branches:

```
STORY-002 → RISK-001 → TC-001/TC-002 → SPEC-001/SPEC-002 → PW (tests/STORY-002.spec.ts)   [E2E, Saucedemo]
          → RISK-002 → TC-003/TC-004 → COL-001 → REQ-001/REQ-002                            [API, reqres.in]
(no FAIL, no BUG — 7 executions, all passed)
```

`context.json.status = "completed"`, all four E2E gates `true`, API gates
3'/4' approved out-of-band.

---

## 4. Notes carried from Phase 1 (still open)

- **A1** — whether to version `.claude/agents/*.md` in git. Still open;
  Phase 2 (CI) is the natural forcing function — CI needs the scaffolding
  reproducible after a fresh clone.
- **A2** — `playwright-test` MCP name vs the plan's `playwright`.
  Documented, not blocking.

---

## 5. Recommendations for Phase 2

In priority order:

1. **Redact secrets from Newman results before they become CI artifacts.**
   Highest priority — Phase 2 uploads `reports/newman-results.json` to CI.
   Post-process the export (or use a reporter that scrubs `x-api-key` /
   `Authorization`) so keys never land in an artifact. (A5 follow-up.)

2. **Add the API-gate keys to `context.schema.json`** —
   `collection_reviewed` and `api_assertions_reviewed` — as a proper
   Architecture-Stability-Rule change (schema + agent prompts + docs +
   examples + migration). Then the API branch's gates are schema-tracked
   like the E2E ones, which matters once CI checks gate state.

3. **Actually exercise the Postman MCP**, or decide it's optional. This
   phase configured it but the API Agent worked filesystem-first and
   verified shapes with direct calls. Phase 2 should either prove the
   cloud read/write path or document that the MCP is an optional
   convenience and Newman + filesystem is the supported path.

4. **Rotate the exposed keys** (reqres.in + Postman) before they matter.

5. **Resolve A1** when wiring CI — commit `.claude/agents/*.md` +
   `.mcp.json` (option B) so a fresh CI clone has the scaffolding, or
   document the regenerate step in the workflow.

6. **For a real dual-surface story** (when one exists), prefer an app that
   has both a UI and a real backend so the E2E and API branches validate
   the same product rather than two demo services. The composite-story
   pattern worked for validation but isn't how real stories look.

---

Phase 1.5 is complete. Phase 2 may begin once this retrospective is
reviewed (alongside `PHASE1-RETROSPECTIVE.md`, per the Phase 2
prerequisites).
