# Bug-draft format

> **Status:** stable from Phase 1; the binding contract for the
> Phase 2 promotion script `scripts/create-jira-bugs.js`. This file is
> the single source of truth for the bug-draft layout. The Failure
> Classifier writes drafts in this format; the script parses them; the
> Reporter reads (and, post-promotion, updates) them. If this format
> changes, it is a contract change — update the schema-adjacent docs,
> both agent prompts, and the parser together (Architecture Stability
> Rule).

A **bug draft** is a Markdown file at `release/bug-drafts/BUG-XXX.md`.
The Failure Classifier creates exactly one per **Red** failure
(`FAIL-XXX` → `BUG-XXX`, same number). Green and Yellow failures never
get a draft — they are documented in `analysis/failure-analysis.json`
only. The draft is a human-readable, reviewable artifact: a human reads
it, decides it's a real product bug, and only then runs the promotion
script to file it in Jira.

---

## 1. The canonical layout

The draft is parsed by its **level-2 headings** (`## Section`). Every
section below MUST be present. A missing section makes the draft
unusable to `scripts/create-jira-bugs.js`.

```markdown
# BUG-XXX

## Summary

[Brief description, one or two sentences.]

## Severity

red

## Linked Story

[story.id] (e.g. STORY-002 or SK-1042)

## Linked Failure

FAIL-XXX

## Linked Risk

RISK-XXX (from the originating TC's risk_ids; list all if multiple)

## Linked Test Case

TC-XXX (or API-XXX for API-branch failures)

## Steps to Reproduce

1. ...
2. ...

## Expected Behavior

[From the AC / TC.expected_results.]

## Actual Behavior

[Observed during the run.]

## Environment

- BASE_URL: ...
- Browser / runtime: ...
- run_id: ...

## Evidence

- reports/...
- traces/...
- screenshots/...

## Jira Issue Key

[empty until promoted; populated by scripts/create-jira-bugs.js --apply]
```

---

## 2. Field rules

| Section                 | Rule                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `# BUG-XXX`             | The H1 is the bug id. Matches the filename and the originating `FAIL-XXX` number.                                                       |
| `## Summary`            | One or two sentences. Becomes the Jira issue **summary** (first line) + part of the description.                                        |
| `## Severity`           | Exactly `red` or `yellow` (lowercase). Drives the Jira **priority** via `config/jira-priority-map.json`. Only `red` drafts are typical. |
| `## Linked Story`       | `context.story.id`. Used for the human-readable description; the actual Jira **issue link** uses `context.story.jira_issue_key` if set. |
| `## Linked Failure`     | The `FAIL-XXX` this bug came from.                                                                                                      |
| `## Linked Risk`        | One or more `RISK-XXX` from the originating TC.                                                                                         |
| `## Linked Test Case`   | The `TC-XXX` (or `API-XXX`).                                                                                                            |
| `## Steps to Reproduce` | Numbered list. Carried into the Jira description verbatim.                                                                              |
| `## Expected Behavior`  | From the AC / `TC.expected_results`.                                                                                                    |
| `## Actual Behavior`    | What the run observed.                                                                                                                  |
| `## Environment`        | `BASE_URL`, runtime, `run_id`. Carried into the description.                                                                            |
| `## Evidence`           | Paths only — never inlined contents (the path-not-content rule).                                                                        |
| `## Jira Issue Key`     | **Empty until promoted.** Its emptiness is the de-dup signal: a draft whose key is already filled is **skipped** on re-run.             |

---

## 3. How the promotion script uses it

`scripts/create-jira-bugs.js` (Phase 2 TG5):

1. Reads every `release/bug-drafts/BUG-*.md`.
2. Parses the level-2 sections above.
3. **De-dups:** if `## Jira Issue Key` already holds a value, the draft
   is skipped (already filed) — re-running is safe.
4. Maps `## Severity` → Jira priority via
   `config/jira-priority-map.json`.
5. Issue type comes from `JIRA_BUG_ISSUETYPE` (default `Bug`).
6. Builds the Jira issue: summary from `## Summary`, description
   assembled from Steps / Expected / Actual / Environment / Evidence /
   the linkage lines.
7. **Dry-run by default** — prints exactly what it _would_ create and
   exits without touching Jira. Only `--apply` performs the real
   `jira_create_issue` write.
8. On a real create, links the new bug to the story issue when
   `context.story.jira_issue_key` is present (link type from the
   priority map's `link_type`), then **writes the new key back** into
   the draft's `## Jira Issue Key` line.

The "writes are never a side effect" rule (`docs/mcp-setup.md`) means
the script is the **only** path that files a bug, and only with the
human-typed `--apply` flag. No agent files a Jira bug on its own.

---

## 4. Why a Markdown draft, not direct Jira creation

The draft is the human gate between "a test failed" and "we filed a
bug". A failed test is not automatically a product bug — it might be a
flaky test, an environment issue, or a test bug. The Failure Classifier
assigns severity; a human reviews the Red drafts; only the reviewed,
human-approved drafts get promoted. Filing straight to Jira would skip
that judgment and pollute the tracker with non-bugs.

---

## References

- `agents/failure-classifier.md` §11 — the agent that creates drafts.
- `agents/reporter.md` — reads drafts; updates `## Jira Issue Key`
  after promotion.
- `scripts/create-jira-bugs.js` — the promotion script.
- `config/jira-priority-map.json` — severity → priority mapping.
- `docs/mcp-setup.md` — the `atlassian-write` entry and the
  "writes are never a side effect" rule.
- `docs/traceability.md` — where `BUG-XXX` sits in the chain.
