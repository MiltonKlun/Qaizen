# Prompt Versioning

> **Status:** Phase 3 (TG8). Every custom agent prompt (`agents/*.md`)
> carries a semantic `version` in its frontmatter. A run records which
> version of each agent it used in `context.json.prompt_versions`. A major
> prompt change is gated by the evaluation dataset before adoption. This is
> additive and backward-compatible — older runs without `prompt_versions`
> still validate.

The agent prompts ARE the product. A test suite is only as good as the
prompt that produced it, so a prompt is a contract like a schema: when it
changes, the change must be traceable, reviewable, and — for major changes —
checked against the evaluation dataset before it ships. This doc defines how.

It does **not** introduce a registry, a database, or any runtime machinery.
Versions live in Git (the agent files) and are pinned per-run in
`context.json`. Git is the prompt history; this doc formalizes how to read it.

---

## 1. The version header

Each `agents/*.md` file declares three fields in its YAML frontmatter:

```yaml
---
name: analyst
version: 1.0.0
changed_in_run: null
changelog: |
  - 1.0.0: Initial versioned baseline (Phase 3 TG8). ...
---
```

| Field            | Meaning                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `version`        | Semantic version (`MAJOR.MINOR.PATCH`) of this prompt. Matched by `^[0-9]+\.[0-9]+\.[0-9]+$`.      |
| `changed_in_run` | The `run_id` whose results justified the most recent change, or `null` for the baseline.           |
| `changelog`      | Newest-first list of `- <version>: <what changed and why>` lines. Never rewritten, only prepended. |

All seven agents start at `1.0.0` — the initial versioned baseline. The
changelog of the baseline summarizes the prompt's history up to that point
(Phase 1 → Phase 3) in one entry; it is not a per-phase diff.

### When to bump which number

This mirrors semver, applied to _behavior the downstream contract depends on_:

- **PATCH** (`1.0.0 → 1.0.1`) — wording, clarity, examples, typo fixes. No
  change to the artifact's shape, the IDs it mints, or the decisions it makes.
- **MINOR** (`1.0.0 → 1.1.0`) — new optional capability that does not change
  existing outputs. E.g. the Analyst gaining the optional `code_change_context`
  step (TG15) was a MINOR-class change: present-when-applicable, absent otherwise.
- **MAJOR** (`1.0.0 → 2.0.0`) — changes the shape, the IDs, the linkage, or the
  decision logic of an output. E.g. changing how the Test Designer assigns
  automation decisions, or restructuring `context.json` population. **A MAJOR
  change MUST pass the evaluation gate (§3) before it is merged.**

A schema change is almost always a MAJOR change to the agent(s) that produce or
consume that schema, and the Architecture Stability Rule (`CLAUDE.md` §3.10)
already requires schema + agents + docs + examples to move in the same PR.
Bump the affected agents' `version` in that same PR.

---

## 2. Pinning a run to its prompts

`context.json` has an optional `prompt_versions` object (Phase 3 TG8):

```json
"prompt_versions": {
  "analyst": "1.0.0",
  "test-designer": "1.0.0",
  "failure-classifier": "1.0.0",
  "reporter": "1.0.0"
}
```

- Keys are agent `name`s (the frontmatter `name:`); values are that file's
  `version:` at the time the run executed.
- Record an agent only if it ran in this pass — a story that never reached the
  API branch need not list `api-agent`.
- The object is open (`additionalProperties`), so a new agent registers without
  a schema change.

This is what makes a metrics delta attributable: if pass-rate or Gate-rejection
rate moves between run N and run N+1, the `prompt_versions` diff tells you
whether a prompt change is a candidate cause. Without it, a regression and a
prompt change are two facts with no link between them.

When you archive a run with `scripts/new-run.js`, the run-local `context.json`
carries its `prompt_versions` with it — so `runs/` becomes an honest record of
_which prompts produced which results_, which is exactly what the pipeline
metrics (TG6) and `/evolve` (TG10) read back.

> **Honest scope:** populating `prompt_versions` is a manual/agent step today
> (read each agent's `version:` and record it when the run starts). It is not
> auto-injected by a script — that would require a runtime the project
> deliberately does not have. The field + this convention are the contract; a
> helper can be added later if the manual step proves to be friction.

---

## 3. Evaluation before adopting a major change

A MAJOR prompt change must be checked against the evaluation dataset before it
is adopted. The harness is `scripts/evaluate-agents.js` (Phase 2 TG11):

```bash
# Score the gold dataset (the bar a run is held to):
npm run evaluate

# Score a fresh run produced by the NEW prompt, against the same invariants:
node scripts/evaluate-agents.js --candidate-dir runs/STORY-XXX/<run-id>
```

The harness scores _structure and linkage_ (required fields, ID patterns,
TC→RISK linkage, automation-decision-with-reason), not wording — two valid runs
phrase things differently but must share the same shape.

**The rule (TG8):** if a prompt change drops the match percentage by more than
**10%** versus the prior baseline, that is a signal the change regressed the
contract. Initially this is a **warning, not a block** (consistent with the
`contract-stability` check) — the human decides whether the drop is acceptable
(e.g. the dataset itself is stale) or whether the prompt change needs rework.

In CI, the `prompt-eval` job runs `npm run evaluate` whenever `agents/` changed
in a PR. It is informational (`continue-on-error`): it surfaces the dataset
match percentage on the PR so a reviewer sees, at Gate time, whether the prompt
edit kept the evaluation green. It never blocks merge and never edits prompts.

---

## 4. What this is NOT

- **Not** an automatic prompt-rewriter. Metrics and `/evolve` _propose_
  changes; a human edits the prompt and bumps the version. Prompts are never
  rewritten autonomously (`CLAUDE.md` §3, Phase 3 §2).
- **Not** a separate version store. The version lives in the agent file; the
  history lives in Git; the per-run pin lives in `context.json`. No new system.
- **Not** a gate. The evaluation check is a signal that informs the human at
  the existing gates; it does not add a new approval step.

---

## 5. Checklist for changing an agent prompt

1. Edit `agents/<name>.md`.
2. Bump `version` (PATCH / MINOR / MAJOR per §1).
3. Prepend a `changelog` entry; set `changed_in_run` to the `run_id` that
   motivated it (or leave `null` for a non-data-driven edit).
4. If the edit is tied to a schema change, update schema + docs + examples in
   the **same PR** (Architecture Stability Rule, `CLAUDE.md` §3.10).
5. For a MAJOR change: regenerate the affected story outputs, run
   `node scripts/evaluate-agents.js --candidate-dir <run>`, and confirm the
   match percentage did not drop > 10%. Attach the result to the PR.
6. On the next run, record the new version in `context.json.prompt_versions`.
