# Artifact Boundaries — Ownership and Contracts

This is the binding reference for who writes what (`CLAUDE.md` §3.2). Section 2
says which agent, script or person may write into each folder; section 3 states,
for each artifact, who reads it, which schema it follows, how sensitive it is,
whether it is archived, and how older versions stay readable. The per-schema
facts are also declared in `scripts/lib/schema-contracts.js`, which the
Architecture Stability check and `test/schema-contracts.test.js` read.

---

## 1. Why one writer per folder

The pipeline runs a chain of agents, each consuming what the previous one
produced. If two writers share a folder, one can silently overwrite the
other's artifact (the traceability chain breaks at the overwrite), or write a
different shape (schema validation stops anchoring the contract). So the rule
is absolute: **one writer per folder**. Any number of readers is fine.

---

## 2. Ownership

If you are about to write into a folder whose owner isn't you, **stop**
(section 5).

| Path                                                                                   | Writer                                                                       | What goes in                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context.json`, `story.md` (repo root)                                                 | Analyst; the runner (`scripts/run-pipeline.js`)                              | The run's decision manifest and its story. The Analyst writes `context.json`; the runner stages `story.md` and records gate decisions, bindings and status. No agent records an approval.                                                                                                                                                                                                                                                                               |
| `gates/`                                                                               | The runner (`scripts/run-pipeline.js` through `scripts/lib/gate-records.js`) | `NNN-<gate>-<decision>.md`, one per human gate decision, approved or rejected: reviewer, times, the brief as shown, the automatic checks and every reviewed input with its digest; and `NNN-<gate>-<decision>/`, a copy of the reviewed files. Written after the decision is saved, never edited, archived with the run. No agent writes here. `--restore` copies files back from here into their own folders at the reviewer's request (`docs/pipeline-runner.md` §5). |
| `test-cases/`                                                                          | Test Designer Agent                                                          | `[story].json`. The test-management adapters add only their linkage fields (`testlink_id`, `external_ids`, `sync_state`; `docs/sync-recovery.md`).                                                                                                                                                                                                                                                                                                                      |
| `planner-input/`                                                                       | Test Designer Agent                                                          | `[story].planner-brief.md` for the Playwright Planner, and `[story].external-plan.json` when the approved scope has manual, component or skip cases.                                                                                                                                                                                                                                                                                                                    |
| `specs/`                                                                               | Playwright Planner (Native Agent)                                            | `[story].md`. The Generator never writes here.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `tests/`                                                                               | Playwright Generator (Native Agent); `seed.spec.ts` is human                 | `[story].spec.ts`. The Healer never writes here.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tests/fixtures/`                                                                      | Human / team                                                                 | App-specific fixtures, when an app needs them.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `api-tests/collections/`, `environments/`                                              | API Agent                                                                    | `[story].postman_collection.json` and `[story].postman_environment.json`. Environments hold no secrets; the API key is injected at run time.                                                                                                                                                                                                                                                                                                                            |
| `external-evidence/`                                                                   | Human operator, only through `scripts/import-execution.js`                   | `[story].results.json` and the evidence files under `[story]/`. Importing approves nothing; the external Gate 4 reviews them. No agent writes here.                                                                                                                                                                                                                                                                                                                     |
| `reports/`                                                                             | Playwright and Newman (the runners)                                          | Raw reports per execution (`reports/<execution-id>/...`, `reports/results.json`) and the sanitized published summaries. Gitignored.                                                                                                                                                                                                                                                                                                                                     |
| `analysis/`                                                                            | Failure Classifier (pre-classifier script and agent)                         | `failure-analysis.json`: drafted by `scripts/run-failure-classifier.js`, finalized by the agent.                                                                                                                                                                                                                                                                                                                                                                        |
| `analysis/execution-ledger.json`                                                       | `scripts/normalize-results.js`                                               | The cross-runner counting model. Read by the classifier, the Reporter, the Healer harness and the TestLink execution sync; none of them write it.                                                                                                                                                                                                                                                                                                                       |
| `analysis/spec-reviews/`                                                               | Spec Reviewer Agent                                                          | `[story].spec-review.{json,md}`: a checklist and risk coverage that assist Gate 3. It never approves.                                                                                                                                                                                                                                                                                                                                                                   |
| `analysis/healer-validation/`                                                          | `scripts/run-healer.js`                                                      | One record per submitted candidate (`FAIL-XXX.attempt-N.json` and its `.md`), Yellow suggestion notes, and `FAIL-XXX.exhausted.md`. Evidence only.                                                                                                                                                                                                                                                                                                                      |
| `release/`                                                                             | Reporter Agent                                                               | `release-report.md` and `release-report.json`.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `release/bug-drafts/`                                                                  | Failure Classifier; `scripts/create-jira-bugs.js` (see 4.4)                  | `BUG-XXX.md`, one per Red failure.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `release/healer-patches/`                                                              | `scripts/run-healer.js`                                                      | `FAIL-XXX.attempt-N.patch` for a candidate that passed the static check and the isolated re-run. Never applied or committed by the Healer.                                                                                                                                                                                                                                                                                                                              |
| `.healer-candidates/`                                                                  | Playwright healer (proposals only)                                           | Candidate copies of a test for one Green failure (`docs/native-healer-handoff.md`). Gitignored inputs to `run-healer.js`.                                                                                                                                                                                                                                                                                                                                               |
| `.healer-workspace/`                                                                   | `scripts/run-healer.js`                                                      | The isolated copy a candidate is re-run in. Gitignored; removed after each run.                                                                                                                                                                                                                                                                                                                                                                                         |
| `.qaizen/`                                                                             | The runner and the sync adapters                                             | Transient state: `transition.json` and `staging/` for a new-story transition, `locks/<target>.lock` while an adapter writes. Gitignored (section 4).                                                                                                                                                                                                                                                                                                                    |
| `runs/`                                                                                | `scripts/lib/run-lifecycle.js` (runner `--story`, `new-run.js`)              | One archive per run, `runs/<story>/<archive-id>/` with its `run-manifest.json`, and the `runs/latest.json` pointer.                                                                                                                                                                                                                                                                                                                                                     |
| `metrics/`                                                                             | `scripts/pipeline-metrics.js`                                                | `pipeline-metrics.{json,md}`, regenerable from `runs/`. Gitignored.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `evolve/`                                                                              | `scripts/evolve.js`                                                          | `evolve-proposal.{json,md}`: suggestions only. Gitignored.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `session-summaries/`                                                                   | `scripts/session-summary.js`                                                 | Friction notes captured after a run, read by `/evolve`. Gitignored.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `evidence/`                                                                            | Human operator, through `scripts/benchmark-capture.js`                       | `benchmark.jsonl`: one schema-valid record per story and arm, behind `docs/evidence.md`. Appended, never edited by an agent.                                                                                                                                                                                                                                                                                                                                            |
| `examples/`                                                                            | Human / team                                                                 | Example stories, valid expected outputs (`expected/`), invalid ones each schema must reject (`invalid/`), the evaluation manifest, the demo fixtures, the Bench Shop app and the shared static server.                                                                                                                                                                                                                                                                  |
| `docs/`, `schemas/`, `agents/`, `skills/`, `scripts/`, `config/`, `.github/workflows/` | Human / team                                                                 | Documentation, contracts, prompts, skills, tooling, integration maps and CI. Schema changes follow the Architecture Stability Rule.                                                                                                                                                                                                                                                                                                                                     |
| `.claude/agents/`, `.mcp.json`                                                         | `npx playwright init-agents`; `.mcp.json` also by the team                   | The Playwright Native Agent definitions (regenerated, never edited; `docs/design-decisions.md` D1) and the MCP registry.                                                                                                                                                                                                                                                                                                                                                |

---

## 3. Artifact contracts

Each JSON artifact below validates against its schema (`npm run validate:all`
for the committed ones). "Archived" means `runs/` keeps a byte-identical,
digest-verified copy when the run is set aside; `reports/` is never archived.
Sensitivity says what may and may not appear in the file.

| Artifact                                                    | Schema                            | Readers                                                                                                 | Sensitivity                                                            | Archived | Compatibility                                                                                                                             |
| ----------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `context.json`                                              | `context.schema.json`             | Every agent; the runner; approval binding                                                               | Story text, risks and decisions; no secrets                            | Yes      | `migrate-context-v1-to-v2.js` and `migrate-context-gate-decisions.js`; later fields are optional                                          |
| `test-cases/[story].json`                                   | `test-cases.schema.json`          | API Agent, Planner brief, normalizer (approved scope), sync adapters, classifier, Reporter              | Business test design; no credentials or production data                | Yes      | `migrate-testcases-external-ids.js` (optional); `testlink_id` stays valid                                                                 |
| `planner-input/[story].external-plan.json`                  | `external-execution.schema.json`  | External gates; `import-execution.js`; normalizer                                                       | Procedures and commands; no secrets                                    | Yes      | Single version (1.0)                                                                                                                      |
| `external-evidence/[story].results.json` and evidence files | `external-execution.schema.json`  | External Gate 4; normalizer                                                                             | Evidence files must hold no secrets or personal data                   | Yes      | Single version (1.0)                                                                                                                      |
| `api-tests/collections/[story].postman_collection.json`     | `postman-collection.schema.json`  | `run-newman.js`; Gates 3′ and 4′                                                                        | Requests and assertions; never a credential                            | Yes      | Postman v2.1 subset                                                                                                                       |
| `reports/<execution-id>/newman/...`, `reports/results.json` | none (runner-owned formats)       | `normalize-results.js`                                                                                  | **May contain injected secrets**; gitignored, never uploaded           | No       | Read as the runners write them                                                                                                            |
| `reports/<execution-id>/published/`                         | none                              | `ci-summary.js`; CI upload                                                                              | Sanitized: secrets redacted in every encoding, or nothing is published | No       | —                                                                                                                                         |
| `analysis/execution-ledger.json`                            | `execution-ledger.schema.json`    | Classifier, Reporter, Healer harness, TestLink execution sync                                           | Sanitized excerpts only; no bodies, headers or injected values         | Yes      | Single version (1.0); rebuilt, never migrated                                                                                             |
| `analysis/failure-analysis.json`                            | `failure-analysis.schema.json`    | Reporter, Healer harness, TestLink execution sync, metrics                                              | Error excerpts from the ledger; no secrets                             | Yes      | 2.x is derived from the ledger, and its flat totals must project its breakdown; 1.x in `runs/` stays valid                                |
| `analysis/spec-reviews/[story].spec-review.json`            | `spec-review.schema.json`         | The human at Gate 3                                                                                     | Findings about the spec                                                | Yes      | Single version (1.0)                                                                                                                      |
| `analysis/healer-validation/*.json`                         | `healer-validation.schema.json`   | Metrics; the human reviewing a patch                                                                    | Run evidence; no secrets                                               | Yes      | Single version (1.0); old Markdown notes counted apart                                                                                    |
| `release/release-report.json`                               | `release-report.schema.json`      | The runner's completion check (a 2.0 report must carry the ledger's counts); metrics; release reviewers | Summaries only                                                         | Yes      | 2.0 for a 2.x analysis, counts from `npm run report:summary`; 1.x keeps its meaning; `migrate-release-report-tg12.js` adds rollups to 1.x |
| `release/bug-drafts/BUG-XXX.md`                             | none (`docs/bug-draft-format.md`) | `create-jira-bugs.js`; Reporter                                                                         | No secrets or personal data (they may be filed in Jira)                | Yes      | Sections fixed by `docs/bug-draft-format.md`; Sync State added for Jira filing                                                            |
| `runs/<story>/<id>/run-manifest.json`, `runs/latest.json`   | none                              | `list-runs.js`, metrics, `new-run.js`                                                                   | File paths and digests                                                 | —        | Additive fields                                                                                                                           |
| `evidence/benchmark.jsonl`                                  | `benchmark-record.schema.json`    | `docs/evidence.md` (people)                                                                             | Measurements and provenance                                            | —        | 1.0 records stay valid; 1.1 adds provenance and timing                                                                                    |
| `examples/evaluation/manifest.json`                         | `evaluation-manifest.schema.json` | `evaluate-agents.js`                                                                                    | —                                                                      | —        | Single version (1.0)                                                                                                                      |

---

## 4. Kinds of state

Not everything the pipeline writes is the same kind of record. Treat each
kind accordingly.

1. **`context.json` is the decision manifest.** It is the one place a run's
   human decisions live: each gate's status, who decided, when, and the digest
   of what was reviewed (`docs/review-gates.md`). Everything else is evidence
   for, or output of, those decisions.
2. **Ledgers and analyses are evidence.** The execution ledger, the failure
   analysis, healer records and imported results describe what happened. They
   never approve anything, and nothing reads approval out of them.
3. **Locks are transient.** `.qaizen/locks/<target>.lock` exists only while an
   adapter writes to that external tool, so two writers cannot run at once. A
   lock that outlives its process is reported, and released only with
   `--release-stale-lock`.
4. **Transaction markers exist only for recovery.** `.qaizen/transition.json`
   and `.qaizen/staging/` record an in-flight new-story transition so an
   interrupted one is rolled back (nothing moved yet) or forward (the archive
   is verified). They are not run history; `runs/` is.

### 4.4 `release/bug-drafts/` has two writers, for different parts

- The **Failure Classifier** creates each `BUG-XXX.md` when it finalizes a Red
  failure (`FAIL-001 → BUG-001`, so re-running it is idempotent).
- **`scripts/create-jira-bugs.js --apply`** writes only the `Jira Issue Key`
  and `Sync State` sections of an existing draft when it files the issue. It
  never creates a draft.

The Reporter reads drafts and lists them in the release report; it does not
write them.

---

## 5. Rules

1. **One writer per folder** (section 1).
2. **Reads are free.** Any agent may read any folder; the Reporter reads
   everything and writes only `release/`.
3. **The Test Designer owns two folders.** `test-cases/[story].json` and
   `planner-input/[story].planner-brief.md` describe the same story at two
   levels: the Planner reads only the Markdown brief, and the Gate 2 reviewer
   compares both.
4. **Native Agents follow the same boundaries.** The Planner writes `specs/`
   only; the Generator writes `tests/[story].spec.ts` only, never
   `seed.spec.ts`; the Playwright healer proposes candidates in
   `.healer-candidates/`, and only `run-healer.js` writes healer evidence and
   patches.
5. **A schema change moves with its contract** (`CLAUDE.md` §3.10): its
   producing prompts, this document, one of its own docs, one of its examples,
   and a migration script when old artifacts must stay valid.
   `npm run check:contracts` lists what is missing, from
   `scripts/lib/schema-contracts.js`.
6. **Referencing is not writing.** A doc or schema may name a folder it does
   not own.

When ownership is unclear, don't write the file. Record the question in
`context.json.ambiguities` (or, with no story context yet, as a Proposed entry
in `docs/design-decisions.md`) and ask the human. For example: the Failure
Classifier finds a test case's expected result is wrong. That is a Test
Designer change and a return to Gate 2, not an edit to `test-cases/`.

---

## 6. References

- `CLAUDE.md` §3.2 (folder ownership) and §3.10 (Architecture Stability Rule).
- `scripts/lib/schema-contracts.js` — the per-schema contracts.
- `docs/runtime-contracts.md` — the shared modules and what each claim means.
- `docs/pipeline-architecture.md` — how the artifacts fit together.
- `docs/traceability.md` — the links every artifact carries.
- `docs/security-and-data-safety.md` — what may never be written anywhere.
