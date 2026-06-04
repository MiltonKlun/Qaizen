---
name: receiving-tickets
description: |
  Discover phase. Reads a user story (manual story.md or Jira via MCP
  read-only) and produces context.json validated against
  schemas/context.schema.json. Populates story metadata, acceptance criteria,
  risks, and ambiguities. Sets the initial traceability anchor for the rest
  of the pipeline. Run first when a new story enters the QA pipeline.
disable-model-invocation: true
adapted_from: dogkeeper886/ai-qa-workflow @ v3.0
adaptation_notes: |
  Original skill scaffolds an `active/<TICKET>/` workspace with many
  documentation files (00_Main_Task, README, Ticket_Relationship_Diagram,
  etc.) and publishes nothing to disk that this pipeline consumes.
  In our system the single canonical artifact is `context.json`, which is
  index/manifest only — all narrative content goes inside it or in the
  optional `story.md` (mode A) / Jira issue (mode B). The original
  `/jr-trace-*` slash commands are not used.
tools:
  - mcp-atlassian:jira_get_issue
  - mcp-atlassian:jira_search
  - mcp-atlassian:jira_get_issue_link_types
  - mcp-atlassian:confluence_get_page
  - mcp-atlassian:confluence_search
---

# receiving-tickets

**Phase:** 1+
**Owned by this skill:** the `agents/analyst.md` agent uses this skill to
produce `context.json`.
**Folder ownership:** writes only `context.json` at the project root.
Never touches `test-cases/`, `planner-input/`, `specs/`, `tests/`,
`analysis/`, or `release/`.
**Gate downstream:** **Gate 1 — Requirement Interpretation** runs immediately
after this skill completes. Do not proceed to `planning-tests` until
`context.json.review_gates.requirements_reviewed == true`.

## What this skill produces

A single file: `context.json` at the project root.

It MUST validate against `schemas/context.schema.json`. After writing it,
the orchestrator runs:

```
node scripts/validate-json.js schemas/context.schema.json context.json
```

If validation fails, fix and re-validate. Do not move on with an invalid
artifact.

## What this skill does NOT produce

- Test cases (that's `designing-cases` writing to `test-cases/`).
- Planner brief (that's `planning-tests` writing to `planner-input/`).
- Confluence pages (this pipeline does not publish to Confluence in P1).
- Any Jira writes (Phase 1 is MCP read-only; see `docs/mcp-setup.md`).

## Modes

### Mode A — Manual story (Phase 1 baseline)

Input: a `story.md` file at the project root.

Steps:

1. Read `story.md`.
2. Parse the title, description, acceptance criteria, and any explicit
   risks the author wrote down.
3. Set:
   - `story.id` = `STORY-XXX` (e.g. `STORY-001`; ascending if multiple
     manual stories exist).
   - `story.source` = `"manual"`.
   - `story.title`, `story.description`, `story.path` = `"story.md"`.
   - `story.jira_issue_key` = omitted.

### Mode B — Jira (also available in Phase 1 because MCP is read-only)

Input: a Jira issue key, e.g. `JIRA-1234`.

Steps:

1. Call `mcp-atlassian:jira_get_issue` with the issue key, all fields,
   comments, and remote links.
2. If the issue references Confluence pages in remote links, call
   `mcp-atlassian:confluence_get_page` for each — but only to gather
   acceptance-criteria detail. Do NOT export every linked page to disk.
3. Write a copy of the issue summary + description + AC into `story.md`
   at project root for reproducibility (the next agent shouldn't need
   to re-hit Jira).
4. Set:
   - `story.id` = the Jira issue key (e.g. `"JIRA-1234"`).
   - `story.source` = `"jira"`.
   - `story.title` = Jira summary.
   - `story.jira_issue_key` = the same issue key.
   - `story.path` = `"story.md"` (the local copy).

Phase 2 enables write tools and adds the option to post a "QA pipeline
started" comment back to Jira, but only with explicit human approval.

## Required `context.json` fields

The schema is the source of truth (`schemas/context.schema.json`). Required
top-level fields at this stage:

- `schema_version` — string, e.g. `"1.0"`.
- `run_id` — unique identifier for this pipeline run (timestamp + short
  hash works).
- `story` — see Mode A / Mode B above.
- `acceptance_criteria` — array of strings, one AC per element. Do not
  invent ACs; if the source is ambiguous, list whatever was written and
  raise an entry in `ambiguities` (see below).
- `ambiguities` — array of `{ description, blocking }` objects. Empty
  array if there are none.
- `risks` — array of `{ risk_id, description, severity, related_acs }`.
  Each risk gets an ID `RISK-001`, `RISK-002`, ...; severity is your
  judgment (low / medium / high). Risks anchor the entire traceability
  chain — see `docs/traceability.md`.
- `artifact_paths` — start as an object with all the keys present and
  values either filled with the eventual path or left as empty strings.
  Later agents fill these in as they produce their artifacts.
- `review_gates` — initialize all four booleans to `false`.
- `status` — `"draft"` initially. Will become `"in_progress"` once Gate
  1 passes.

## Traceability anchors created here

| ID pattern                  | Created by this skill            |
| --------------------------- | -------------------------------- |
| `STORY-XXX` (or `JIRA-XXX`) | Yes — single value at `story.id` |
| `RISK-XXX`                  | Yes — one per entry in `risks[]` |

All other traceability IDs (`TC-XXX`, `SPEC-XXX`, `PW-XXX`, `API-XXX`,
`COL-XXX`, `REQ-XXX`, `FAIL-XXX`, `BUG-XXX`) are created by later
skills/agents and reference the IDs this skill produced.

## When to STOP and ask

Per `CLAUDE.md` section 3.7, do not invent requirements. Stop and ask
for human input when any of these apply:

- A `story.md` (Mode A) is missing or unreadable, or the Jira issue
  (Mode B) cannot be fetched.
- An acceptance criterion is internally contradictory.
- The story implies behavior the AC does not document, and you cannot
  tell whether that behavior is intended.
- The risks section would be empty because the story is genuinely
  unclear about what could go wrong.

Record each unresolved item in `context.json.ambiguities` with a clear
description and `blocking: true` if it prevents downstream test design,
`blocking: false` otherwise. If at least one entry has `blocking: true`,
do not advance to Gate 1 — surface the blockers to the human first.

## Gate 1 hand-off

After this skill writes `context.json`:

1. The orchestrator validates against the schema.
2. The human reviews per the criteria in `docs/review-gates.md`:
   - Acceptance criteria accurate.
   - Ambiguities explicit (no silent assumptions).
   - Risks meaningful, not just rephrased ACs.
   - No invented business rules.
3. On approval: human (or agent acting on human instruction) sets
   `context.json.review_gates.requirements_reviewed = true` and
   `status = "in_progress"`. Re-validate.
4. On rejection: human writes correction notes; the analyst re-runs
   this skill.

`planning-tests` MUST refuse to run if `requirements_reviewed != true`.

## Next step

After Gate 1 passes, run the `planning-tests` skill to produce the
`planner-input/[story-id].planner-brief.md` (Markdown brief consumed
by the Playwright Planner Native Agent), and the `designing-cases`
skill to produce `test-cases/[story-id].json`.

## References

- `schemas/context.schema.json` — the binding schema for the artifact
  this skill produces (created in Phase 1 TG7).
- `docs/review-gates.md` — Gate 1 criteria (created in Phase 1 TG6).
- `docs/traceability.md` — the full traceability chain and the rules
  this skill anchors (created in Phase 1 TG6).
- `docs/mcp-setup.md` — Atlassian MCP setup and the read-only allowlist
  (created in Phase 1 TG4).
- `agents/analyst.md` — the agent prompt that calls this skill
  (created in Phase 1 TG10).
