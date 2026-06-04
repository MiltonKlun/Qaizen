# `context.json` Guide

> **Status:** Phase 1 baseline. The schema is `schemas/context.schema.json`
> (Phase 1 TG7). Phase 1.5 does not change `context.json`. Phase 2 (TG6)
> extends `review_gates` from booleans to optional `{ status, reviewer,
reviewed_at, notes }` objects via `oneOf`. Phase 3 (TG8) adds a
> `prompt_versions` map tying each agent's run-time version to the
> `run_id`. Both later changes are backward-compatible.

`context.json` is the **manifest** of a pipeline run. It sits at the
project root, evolves throughout a single story's pass through the
pipeline, and is the one file every agent reads to know where it is in
the chain.

It is the artifact whose schema (`schemas/context.schema.json`) is the
strictest contract in the system. When in doubt, validate.

---

## 1. What `context.json` is — and what it is NOT

| It IS                                                    | It is NOT                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| The index / manifest of the run.                         | A test report.                                                         |
| The carrier of story metadata, ACs, risks, ambiguities.  | A storage for HTML reports, traces, screenshots, or raw logs.          |
| The carrier of `artifact_paths` pointing at other files. | A storage for the contents of those files inlined.                     |
| The carrier of `review_gates` — the four boolean flags.  | A workflow engine — there is no orchestrator listening on these flags. |
| The carrier of `run_id` and `status`.                    | A database. Multi-run history lives in `runs/` (Phase 3+), not here.   |

**Single most important rule:** `context.json` carries **paths to**
large artifacts, never their contents. The Reporter agent in
Phase 3 is required to consume `evidence_paths` from
`failure-analysis.json` rather than pasting screenshots into prompts;
that token-efficient pattern starts here, with `context.json` as a
manifest.

See `docs/pipeline-architecture.md` and (Phase 3 TG7)
`docs/context-json-guide.md` updates for the token-efficient context
handling rules.

---

## 2. Lifecycle

A new `context.json` is created once per story, at the start of the
pipeline:

```
[start of run]
        │
        ▼
  Analyst writes context.json (status = "draft", all gates false)
        │
        ▼
  Schema validation
        │
        ▼
  Gate 1 review (human)
        │  on approval:
        │  - status = "in_progress"
        │  - review_gates.requirements_reviewed = true
        ▼
  Test Designer fills artifact_paths.test_cases and .planner_brief
        │
        ▼
  Gate 2 → review_gates.test_scope_reviewed = true
        │
        ▼
  Playwright Planner fills artifact_paths.playwright_spec
        │
        ▼
  Gate 3 → review_gates.specs_reviewed = true
        │
        ▼
  Generator fills artifact_paths.generated_test
        │
        ▼
  Gate 4 → review_gates.code_reviewed = true
        │
        ▼
  Test execution fills artifact_paths.execution_results, .html_report,
                                       .traces, .screenshots
        │
        ▼
  Failure Classifier fills artifact_paths.failure_analysis,
                                       .bug_drafts_dir
        │
        ▼
  Reporter fills artifact_paths.release_report_md, .release_report_json
        │
        ▼
  status = "completed"
```

Every time an agent modifies `context.json`, the next step is to
re-validate:

```bash
node scripts/validate-json.js schemas/context.schema.json context.json
```

A `context.json` that does not validate is not a valid manifest.

---

## 3. Top-level shape

The binding shape is `schemas/context.schema.json`. The summary below
is canonical for reference but the schema is the source of truth.

```jsonc
{
  "schema_version": "1.0",
  "run_id": "2026-05-28T14-32-01Z-a1b2c3d",

  "story": {
    "id": "JIRA-1234", // or "STORY-001" for manual mode
    "title": "User can reset their password",
    "source": "jira", // or "manual"
    "path": "story.md", // local copy of the story text
    "description": "...", // optional
    "jira_issue_key": "JIRA-1234", // only if source == "jira"
  },

  "acceptance_criteria": [
    "Given a registered user, when they request a password reset, they receive a one-time email link.",
    "The link expires after 30 minutes.",
    "The link is single-use.",
  ],

  "ambiguities": [
    {
      "description": "Story does not specify whether the link is invalidated on first failed attempt.",
      "blocking": false,
    },
  ],

  "risks": [
    {
      "risk_id": "RISK-001",
      "description": "Reset link could be reused after expiration if clock skew is large.",
      "severity": "high",
      "related_acs": [1],
    },
  ],

  "artifact_paths": {
    "test_cases": "test-cases/JIRA-1234.json",
    "planner_brief": "planner-input/JIRA-1234.planner-brief.md",
    "playwright_spec": "specs/JIRA-1234.md",
    "generated_test": "tests/JIRA-1234.spec.ts",
    "execution_results": "reports/results.json",
    "html_report": "reports/html",
    "traces": "reports/traces",
    "screenshots": "reports/screenshots",
    "failure_analysis": "analysis/failure-analysis.json",
    "release_report_md": "release/release-report.md",
    "release_report_json": "release/release-report.json",
    "bug_drafts_dir": "release/bug-drafts",
  },

  "review_gates": {
    "requirements_reviewed": false,
    "test_scope_reviewed": false,
    "specs_reviewed": false,
    "code_reviewed": false,
  },

  "status": "draft",
}
```

---

## 4. Fields, one by one

### `schema_version`

The version of `schemas/context.schema.json` the file conforms to.
Phase 1 uses `"1.0"`. When the schema changes incompatibly, this
field bumps and a migration script is required (Architecture
Stability Rule). Backward-compatible changes (adding optional
fields) do not bump the major.

### `run_id`

A unique-per-run identifier. Phase 1 uses an ISO-8601-ish timestamp
plus a short hash: `2026-05-28T14-32-01Z-a1b2c3d`. The exact format
is not strict; what matters is uniqueness.

Phase 3 (TG5) introduces `scripts/new-run.js` which generates these
and creates `runs/[story-id]/[run-id]/` history. Until then, the
analyst generates the run_id by hand when initializing
`context.json`.

### `story`

| Field            | Required    | Notes                                                                |
| ---------------- | ----------- | -------------------------------------------------------------------- |
| `id`             | yes         | `JIRA-XXX` or `STORY-XXX`. The top of the traceability chain.        |
| `title`          | yes         | Short, human-readable.                                               |
| `source`         | yes         | `"manual"` or `"jira"`.                                              |
| `path`           | yes         | Path to the local Markdown copy of the story. Usually `"story.md"`.  |
| `description`    | optional    | Long-form description; large content fine but keep it within reason. |
| `jira_issue_key` | conditional | Required when `source == "jira"`. Equal to `id` in that case.        |

### `acceptance_criteria`

Array of strings, one AC per element. Numbered or unnumbered is up to
the team; the array index is the canonical position used by
`risks[].related_acs`.

### `ambiguities`

Array of `{ description: string, blocking: boolean }`. Empty array
when there are none. Per `CLAUDE.md` section 3.7, an ambiguity with
`blocking: true` prevents progress until resolved.

### `risks`

The first traceability anchor in the chain. Each entry:

| Field         | Required | Notes                                               |
| ------------- | -------- | --------------------------------------------------- |
| `risk_id`     | yes      | `RISK-001`, `RISK-002`, ...                         |
| `description` | yes      | One-sentence description.                           |
| `severity`    | yes      | `"low"`, `"medium"`, or `"high"`.                   |
| `related_acs` | yes      | Array of AC indices (0-based) the risk attaches to. |

Risks anchor `TC-XXX` → `RISK-XXX`. See `docs/traceability.md`.

### `artifact_paths`

This is the **manifest** part. Each key points at a file the
downstream agent will produce; the value is the **relative path** to
that file. Empty string when not yet produced.

Conventions:

- Paths are relative to the project root.
- Forward slashes, even on Windows.
- File names match the story id where the artifact is story-scoped
  (e.g. `test-cases/JIRA-1234.json`).
- Shared / global outputs (`reports/results.json`,
  `analysis/failure-analysis.json`) use stable names without a story
  id; in Phase 3 these move under `runs/[story-id]/[run-id]/...` to
  avoid collisions across runs.

The full key list and ownership:

| Key                   | Filled by                             | Phase introduced |
| --------------------- | ------------------------------------- | ---------------- |
| `test_cases`          | Test Designer (`designing-cases`)     | 1                |
| `planner_brief`       | Test Designer (`planning-tests`)      | 1                |
| `playwright_spec`     | Playwright Planner Native Agent       | 1                |
| `generated_test`      | Playwright Generator Native Agent     | 1                |
| `execution_results`   | Playwright runner                     | 1                |
| `html_report`         | Playwright runner                     | 1                |
| `traces`              | Playwright runner                     | 1                |
| `screenshots`         | Playwright runner                     | 1                |
| `failure_analysis`    | Failure Classifier (`analyzing-logs`) | 1                |
| `release_report_md`   | Reporter                              | 1                |
| `release_report_json` | Reporter                              | 1                |
| `bug_drafts_dir`      | Failure Classifier                    | 1                |
| _Phase 1.5+ may add_  | _API-branch keys_                     | 1.5              |

### `review_gates`

The four-gate state. See `docs/review-gates.md` for criteria.

Phase 1 form:

```json
"review_gates": {
  "requirements_reviewed": false,
  "test_scope_reviewed": false,
  "specs_reviewed": false,
  "code_reviewed": false
}
```

Phase 2 (TG6) extended form, backward-compatible via `oneOf`:

```json
"review_gates": {
  "requirements_reviewed": {
    "status": true,
    "reviewer": "alice@example.com",
    "reviewed_at": "2026-05-28T15:01:00Z",
    "notes": "AC #3 was clarified with PM."
  },
  "test_scope_reviewed": true,
  "specs_reviewed": false,
  "code_reviewed": false
}
```

The schema accepts either form per field. Phase 1 uses booleans only.

### `status`

One of `"draft"` / `"in_progress"` / `"completed"` / `"blocked"`.

- `"draft"` — Analyst has written `context.json` but Gate 1 is not
  approved.
- `"in_progress"` — Gate 1 is approved; pipeline is moving through
  Gates 2–4 and execution.
- `"completed"` — Reporter finalized `release/release-report.{md,json}`.
  All four `review_gates` are `true`. All `artifact_paths` point at
  existing files.
- `"blocked"` — At least one `ambiguities[]` entry has
  `blocking: true`. The agent that detected the blocker sets this
  and stops.

---

## 5. Inline data vs file paths — the rules

The `context.json` carries inline:

- Short structured data: AC list, risks, ambiguities, story metadata.
- Booleans / strings / arrays of identifiers.

The `context.json` does NOT carry inline:

- Test case bodies — they live in `test-cases/[story-id].json`.
- The planner brief Markdown — lives in `planner-input/`.
- Spec Markdown — lives in `specs/`.
- Generated test source — lives in `tests/`.
- Reports, traces, screenshots — live in `reports/`.
- Failure analysis — lives in `analysis/failure-analysis.json`.
- Release report — lives in `release/release-report.{md,json}`.
- Bug drafts — live in `release/bug-drafts/`.

When a downstream agent needs one of these, it reads
`context.artifact_paths.<key>` and opens the file. The Reporter, in
particular, must not paste raw report content into LLM prompts — it
references `evidence_paths` from `failure-analysis.json` instead.
This is the token-efficient pattern formalized in Phase 3 TG7.

---

## 6. Validation discipline

Every modification to `context.json` is followed by:

```bash
node scripts/validate-json.js schemas/context.schema.json context.json
```

A failed validation must be fixed before the next agent runs. The
generic validator is the only schema validator — there are no
per-schema scripts, by deliberate design (Phase 1 TG8).

`npm run validate:context` is a convenience for the same command (from
`package.json` in Phase 1 TG2).

---

## 7. Common mistakes

- **Inlining large content** — pasting the planner brief Markdown
  into `context.json` instead of writing it to `planner-input/` and
  pointing at it. Always use the file path.
- **Empty `artifact_paths`** — leaving a key blank (`""`) is fine
  when the artifact hasn't been produced yet. Removing the key
  entirely is **not** fine — the schema expects all keys to exist as
  the manifest is the schema for "what this run should produce".
- **Setting a gate flag from an agent without human approval** —
  the agent never sets `review_gates.*` to `true` on its own. A human
  approves, then either edits the file directly or instructs the
  agent to set it.
- **Faking `run_id`** — two different runs MUST have different
  `run_id`s. Re-running a story without changing `run_id` will
  overwrite the previous run's history in Phase 3.
- **Lying about `status`** — `"completed"` implies everything in the
  DoD list is satisfied. Setting it as a shortcut breaks the chain.

---

## 8. Phase-specific extensions

| Phase | Adds                                                                                                            | Doc                                   |
| ----- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1     | This baseline.                                                                                                  | This file.                            |
| 1.5   | _(none — `context.json` itself is unchanged; only the test-cases schema gets an optional `api_metadata` block)_ | `phase1.5-api-branch.md` TG3.         |
| 2     | `review_gates.*` may be objects with audit fields.                                                              | `phase2-integrations.md` TG6.         |
| 3     | `prompt_versions` map (each agent's version used in this run); token-efficient context handling rules.          | `phase3-healing-scaling.md` TG7, TG8. |

All extensions are backward-compatible. Files written under earlier
phases continue to validate.

---

## 9. References

- `schemas/context.schema.json` — the binding schema (Phase 1 TG7).
- `scripts/validate-json.js` — the generic validator (Phase 1 TG8).
- `docs/review-gates.md` — the four gates and their criteria.
- `docs/traceability.md` — the full ID chain that starts in
  `context.json.story.id` and `risks[]`.
- `docs/artifact-boundaries.md` — folder ownership for every path
  in `artifact_paths`.
- `agents/analyst.md` — the agent prompt that initially writes
  `context.json` (Phase 1 TG10).
- `phase1-foundation-e2e.md` TG13 — the steps that mutate
  `context.json` end-to-end.
