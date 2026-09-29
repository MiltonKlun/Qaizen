# Prompt Versioning

> **Status:** Phase 3 (TG8). Every custom agent prompt (`agents/*.md`)
> carries a semantic `version` in its frontmatter. A run records which
> version of each agent it used in `context.json.prompt_versions`. A major
> prompt change is evaluated on a candidate the agent generated from the fixed
> stories before adoption (§3; task group 8.1). This is
> additive and backward-compatible — older runs without `prompt_versions`
> still validate.

The agent prompts ARE the product. A test suite is only as good as the
prompt that produced it, so a prompt is a contract like a schema: when it
changes, the change must be traceable, reviewable, and — for major changes —
evaluated on a candidate generated from the fixed stories before it ships. This doc defines how.

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
  change MUST be evaluated on a candidate (§3) before it is merged.**

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

## 3. Evaluating a prompt change

Two different things are called "evaluation" here, and only one of them says
anything about a prompt.

**Expected fixture validation** (`npm run evaluate`) scores the committed gold
outputs in `examples/expected/` against the structural invariants: schema
validity, required fields, ID patterns, TC→RISK and TC→AC links, automation
decision with a reason, and risk coverage. It reads no prompt and runs no
agent, so a prompt edit cannot change its result. It proves the fixtures are
still a sound bar. CI runs it as the informational `Expected fixture
validation` job when `agents/` changes; that job does not evaluate the change.

Which gold outputs exist is declared in `examples/evaluation/manifest.json`
(`schemas/evaluation-manifest.schema.json`): every story in `examples/stories/`
is `designer` (context and test cases), `analyst` (context only) or `none` (no
gold output yet, with a reason). A story missing from the manifest, or a
declared output that is missing, fails the run instead of shrinking the
denominator. Analyst-only stories are labelled as such and never count as
tested Test Designer outputs. The results keep the declared, scored and missing
counts separate from the match, and the match is exact (floored, so 199 of 200
checks is 99.5%, never a rounded 100%).

**Candidate evaluation** scores output that the agent produced with the prompt
under review. This is the human prompt-change workflow:

1. **Record the prompt.** Bump the version (§1). The evaluator records each
   evaluated prompt's version and a SHA-256 of its content.
2. **Generate a candidate** by running the existing agent, with the changed
   prompt, on one of the fixed stories in `examples/stories/`. Record the
   versions in the candidate's `context.json.prompt_versions`. The evaluator
   refuses a candidate for any other story, and one whose recorded versions
   differ from the prompts on disk.
3. **Evaluate it:**

   ```bash
   node scripts/evaluate-agents.js --candidate-dir <run-dir> \
     [--stage analyst] [--baseline <previous evaluation-results.json>]
   ```

   Designer stage (the default) needs both the context and
   `test-cases/<story-id>.json`; `--stage analyst` evaluates a deliberate
   Analyst-only candidate.

4. **Compare with the baseline**: a previous candidate's results with
   `--baseline`, otherwise the story's gold output. The report names every
   check that regressed or was fixed and the change in the match; a drop of
   more than **10 points** is the documented "needs rework" signal. It is a
   warning, not a block: the human decides whether the drop is acceptable
   (e.g. the dataset is stale) or the prompt needs rework.
5. **Review what the checks cannot see.** Read the candidate against the
   review-gate rubrics (`docs/review-gates.md`): do the ACs mean what the
   story means, are the risks real, are the automation decisions sound? Note
   the reviewer's findings next to the results.
6. **Keep the evidence.** The results are written to
   `<run-dir>/evaluation-results.json`, next to the candidate that produced
   them; attach both to the PR. The committed fixture results are never
   overwritten by a candidate run.

The model's output is what is evaluated here, not the gold fixture again.
Scores stay structural: wording similarity is not measured, and a structural
100% is not an assertion that the business interpretation is correct.

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
5. For a MAJOR change: run the candidate workflow (§3) on the affected fixed
   stories, confirm no check regressed and the match did not drop more than 10
   points against the baseline, review the candidate against the gate rubrics,
   and attach the candidate with its `evaluation-results.json` to the PR.
6. On the next run, record the new version in `context.json.prompt_versions`.
