# Artifact Boundaries — Folder Ownership and Collision Prevention

> **Status:** Phase 1 baseline. Rows tagged with **Phase 1.5+ / 2+ / 3+** are
> reserved owners; the folder does not yet exist (or is empty) until that
> phase. Do not write into a deferred folder in an earlier phase.

This document is the canonical reference for which agent or skill owns
which folder. It is the binding rule referenced by `CLAUDE.md` section 3.2.
The project `README.md` section 5 holds the source-of-truth ownership
table; this document expands it with the collision-prevention rules.

---

## 1. Why this matters

The pipeline runs a chain of agents in sequence, each producing artifacts
the next agent consumes. If two agents can write into the same folder, two
failure modes follow immediately:

1. **Silent overwrite.** Agent A writes `analysis/foo.json`; agent B writes
   another `analysis/foo.json` an hour later. The first artifact is lost
   without a trace. The traceability chain breaks at the overwrite.
2. **Shape divergence.** Agent A writes Markdown into `specs/`; agent B
   writes JSON into `specs/`. The downstream consumer can't tell which
   shape is the contract any more — the schema validation that anchors
   the rest of the pipeline becomes unreliable.

The rule is therefore simple and absolute: **one writer per folder**. A
folder may have many readers, but only one writer.

---

## 2. Ownership table

This table is the binding contract. If you find yourself about to write
into a folder whose owner isn't you, **stop**.

| Path                          | Owner                                                      |  Phase  | What goes in                                                                                                                                                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------- | :-----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/`                       | Human / team                                               |    1    | Architecture, gates, traceability, healer rules, integration guides.                                                                                                                                                                                                   |
| `schemas/`                    | Human / team                                               |    1    | JSON Schema contracts. Schema changes follow the Architecture Stability Rule.                                                                                                                                                                                          |
| `examples/stories/`           | Human / team                                               |    1    | Story example Markdown files used to anchor Analyst behavior.                                                                                                                                                                                                          |
| `examples/expected/`          | Human / team                                               |    1    | Expected outputs that validate against schemas — anchor for evaluation.                                                                                                                                                                                                |
| `examples/evaluation/`        | Human / team                                               |    2    | Extended evaluation dataset. Empty until P2.                                                                                                                                                                                                                           |
| `examples/demo-run/`          | Human / team                                               |   IP3   | Replayed FIXTURES for the offline demo (`scripts/demo-pipeline.js`): story, stage snapshots, the demo app + its in-place Playwright config + tests, the bug draft and release report. Not a live run; the demo copies these into a throwaway `runs/DEMO-1/` workspace. |
| `agents/`                     | Human / team                                               |    1    | Agent prompt files. **No artifacts are produced here.**                                                                                                                                                                                                                |
| `skills/`                     | Human / team                                               |    1    | Adapted SKILL.md files from `ai-qa-workflow`.                                                                                                                                                                                                                          |
| `test-cases/`                 | Test Designer Agent                                        |    1    | `[story-id].json` validated against `schemas/test-cases.schema.json`.                                                                                                                                                                                                  |
| `planner-input/`              | Test Designer Agent                                        |    1    | `[story-id].planner-brief.md` — Markdown brief for the Playwright Planner Native Agent.                                                                                                                                                                                |
| `specs/`                      | Playwright Planner Native Agent                            |    1    | `[story-id].md` — Planner's output. **The Generator does not write here.**                                                                                                                                                                                             |
| `tests/`                      | Playwright Generator Native Agent + `seed.spec.ts` (human) |    1    | `[story-id].spec.ts` from the Generator; `seed.spec.ts` from the human.                                                                                                                                                                                                |
| `tests/fixtures/`             | Human / team                                               |    1    | Placeholder in P1. Becomes app-specific fixtures when needed.                                                                                                                                                                                                          |
| `api-tests/`                  | API Agent                                                  |   1.5   | Postman collections + environments for `automate_api` cases. Active as of Phase 1.5 TG2.                                                                                                                                                                               |
| `api-tests/collections/`      | API Agent                                                  |   1.5   | `[story-id].postman_collection.json`.                                                                                                                                                                                                                                  |
| `api-tests/environments/`     | API Agent                                                  |   1.5   | `[story-id].postman_environment.json`.                                                                                                                                                                                                                                 |
| `reports/`                    | Playwright runner / Newman                                 | 1 / 1.5 | `results.json`, `newman-results.json`, HTML reports, traces, screenshots. Gitignored.                                                                                                                                                                                  |
| `analysis/`                   | Failure Classifier Agent                                   |    1    | `failure-analysis.json` validated against `schemas/failure-analysis.schema.json`.                                                                                                                                                                                      |
| `analysis/spec-reviews/`      | Spec Reviewer Agent                                        |    3    | Reserved until Phase 3. Empty until then.                                                                                                                                                                                                                              |
| `analysis/healer-validation/` | Healer                                                     |    3    | Reserved until Phase 3. Empty until then.                                                                                                                                                                                                                              |
| `release/`                    | Reporter Agent                                             |    1    | `release-report.md` and `release-report.json` (validated).                                                                                                                                                                                                             |
| `release/bug-drafts/`         | Failure Classifier / Reporter                              |    1    | `BUG-XXX.md` drafts. **Shared owners**, see section 4.                                                                                                                                                                                                                 |
| `release/healer-patches/`     | Healer                                                     |    3    | Reserved until Phase 3.                                                                                                                                                                                                                                                |
| `runs/`                       | `scripts/new-run.js`                                       |    3    | Per-story / per-run history. Reserved until Phase 3.                                                                                                                                                                                                                   |
| `metrics/`                    | `scripts/pipeline-metrics.js`                              |    3    | Pipeline metrics outputs. Reserved until Phase 3.                                                                                                                                                                                                                      |
| `scripts/`                    | Human / team                                               |    1    | Helper scripts (`validate-json.js`, `validate-examples.js`, etc.).                                                                                                                                                                                                     |
| `.github/workflows/`          | Human / team                                               |    2    | GitHub Actions workflows. Reserved until Phase 2.                                                                                                                                                                                                                      |
| `.claude/agents/`             | `npx playwright init-agents` scaffolder                    |    1    | The Playwright Native Agent definitions (planner / generator / healer). Regenerable. Do not edit.                                                                                                                                                                      |
| `.mcp.json`                   | Human / team + `init-agents` scaffolder                    |    1    | MCP server registry. Created by `init-agents`; later TGs merge new MCPs in.                                                                                                                                                                                            |

The project `README.md` section 5 is the authoritative source. This table
is a copy enriched with the collision rules in the next section.

---

## 3. Collision-prevention rules

### 3.1 One writer per folder

Already stated above. The single most-important rule.

### 3.2 Reads are free

Any agent may read from any folder. The traceability chain depends on
this — the Reporter Agent reads everything, but writes only to
`release/`.

### 3.3 The Test Designer owns two folders, not one

This is the only single-owner / multi-folder case in Phase 1. The Test
Designer Agent produces both:

- `test-cases/[story-id].json` — the schema-validated case list.
- `planner-input/[story-id].planner-brief.md` — the Markdown brief.

These are paired outputs; they describe the same story at different
levels of detail. Splitting them across two folders is deliberate so
that the Playwright Planner Native Agent reads only the Markdown
brief (no JSON parsing) and the Gate 2 reviewer can compare both.

### 3.4 Native Agents respect the same boundaries

The Playwright Native Agents (planner / generator / healer) are LLMs
under our control via `.claude/agents/*.md` definitions. The same
ownership rules bind them:

- The **Planner** writes to `specs/` only.
- The **Generator** writes to `tests/` only — and only the
  `[story-id].spec.ts` file, never `tests/seed.spec.ts` (which is
  human-owned).
- The **Healer** writes to `release/healer-patches/` and
  `analysis/healer-validation/` only. Reserved until Phase 3; in
  Phase 1 the Healer does not run.

### 3.5 `release/bug-drafts/` is shared by the Failure Classifier and the Reporter

This is the only shared-writer folder in Phase 1. The convention:

- The **Failure Classifier** writes each `BUG-XXX.md` _first_, at the
  moment it classifies a Red failure. The file's `Jira Issue Key` field
  is empty.
- The **Reporter** may _update_ the `Jira Issue Key` field after Phase 2
  promotion via `scripts/create-jira-bugs.js --apply`. The Reporter
  never creates a new BUG file; it only updates the key field.

Collision avoidance: BUG IDs come from `failure-analysis.json.failures[].failure_id`
plus a one-to-one mapping (`FAIL-001 → BUG-001`). Two parallel runs of the
Failure Classifier against the same `failure-analysis.json` will produce
the same filenames — which is correct (idempotent), not a collision.

### 3.6 Schema changes trigger the Architecture Stability Rule

When the work would change a `schemas/*.schema.json`, the same PR must
update every consuming agent prompt, the relevant doc(s), the affected
expected examples, and (if backward-incompatible) a migration script. See
`CLAUDE.md` section 3.10. This is not a folder-ownership rule, but it is
the boundary rule that prevents schemas from drifting from the artifacts
that depend on them.

### 3.7 Forward references are not writes

A document or schema may _reference_ a folder it does not own (e.g. this
doc mentions `release/bug-drafts/`). That's a read-style relationship,
not a write. Forward references are encouraged and don't violate
ownership.

---

## 4. What to do when ownership is unclear

If a task seems to require writing into a folder owned by another agent
— stop. Per `CLAUDE.md` section 3.11 and 3.7:

1. Don't write the file.
2. Record the ambiguity in `docs/ambiguities.md` (or, if the work is in
   progress, in `context.json.ambiguities`).
3. Surface it to the human.

Examples of valid stops:

- The Failure Classifier wants to update `test-cases/[story-id].json`
  because a test case's expected output was wrong. **Stop.** That's a
  Test Designer change, which means rolling back to Gate 2.
- The Healer (Phase 3) wants to delete a `.spec.ts` because it's
  consistently failing. **Stop.** That violates Healer guardrails
  (`docs/healer-guardrails.md`).
- An agent wants to write the API collection straight into
  `api-tests/collections/` in Phase 1. **Stop.** Phase 1.5 work, not
  Phase 1.

---

## 5. Phase-introduced folders timeline

| Folder                        | Created in    | First write happens in |
| ----------------------------- | ------------- | ---------------------- |
| All Phase 1 folders           | Phase 1 TG1   | Phase 1 TG7+           |
| `api-tests/` and subfolders   | Phase 1.5 TG2 | Phase 1.5 TG9          |
| `examples/evaluation/`        | Phase 2 TG11  | Phase 2 TG11           |
| `.github/workflows/`          | Phase 2 TG8   | Phase 2 TG8            |
| `analysis/spec-reviews/`      | Phase 3 TG4   | Phase 3 TG4            |
| `analysis/healer-validation/` | Phase 3 TG2   | Phase 3 TG2            |
| `release/healer-patches/`     | Phase 3 TG2   | Phase 3 TG2            |
| `runs/`                       | Phase 3 TG5   | Phase 3 TG5            |
| `metrics/`                    | Phase 3 TG6   | Phase 3 TG6            |

Creating a deferred folder early "to plan ahead" is not a small
improvement — it's a forbidden-work item. See `CLAUDE.md` section 8.

---

## 6. References

- `CLAUDE.md` section 3.2 — folder ownership as an operating principle.
- `README.md` section 5 — the source-of-truth ownership table.
- `docs/pipeline-architecture.md` — how the artifacts fit together.
- `docs/traceability.md` — what links every artifact carries.
- Per-phase plan files — the lists of which folders are added in
  which Task Group.
