# Prompt Versioning

> Every custom agent prompt (`agents/*.md`)
> carries a semantic `version` in its frontmatter. A run records which
> version of each agent it used in `context.json.prompt_versions`. A minor or
> major prompt change, and every model upgrade, is scored on the regression
> set over repeated trials (§3a); a major one is also evaluated on a candidate
> the agent generated from the fixed stories before adoption (§3). This is
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
  - 1.0.0: Initial versioned baseline. ...
---
```

| Field            | Meaning                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `version`        | Semantic version (`MAJOR.MINOR.PATCH`) of this prompt. Matched by `^[0-9]+\.[0-9]+\.[0-9]+$`.      |
| `changed_in_run` | The `run_id` whose results justified the most recent change, or `null` for the baseline.           |
| `changelog`      | Newest-first list of `- <version>: <what changed and why>` lines. Never rewritten, only prepended. |

All seven agents start at `1.0.0` — the initial versioned baseline. The
changelog of the baseline summarizes the prompt's history up to that point
in one entry; it is not a per-phase diff.

### When to bump which number

This mirrors semver, applied to _behavior the downstream contract depends on_:

- **PATCH** (`1.0.0 → 1.0.1`) — wording, clarity, examples, typo fixes. No
  change to the artifact's shape, the IDs it mints, or the decisions it makes.
- **MINOR** (`1.0.0 → 1.1.0`) — new optional capability that does not change
  existing outputs. E.g. the Analyst gaining the optional `code_change_context`
  step was a MINOR-class change: present-when-applicable, absent otherwise.
  **A MINOR change is scored on the regression set (§3a) before it is
  merged**: "does not change existing outputs" is what the set checks.
- **MAJOR** (`1.0.0 → 2.0.0`) — changes the shape, the IDs, the linkage, or the
  decision logic of an output. E.g. changing how the Test Designer assigns
  automation decisions, or restructuring `context.json` population. **A MAJOR
  change MUST be evaluated on a candidate (§3) and scored on the regression
  set (§3a) before it is merged.**

A PATCH changes no output by definition, so it needs neither; a wording edit
that does change what the agent produces is not a PATCH.

A schema change is almost always a MAJOR change to the agent(s) that produce or
consume that schema, and the Architecture Stability Rule (`CLAUDE.md` §3.10)
already requires schema + agents + docs + examples to move in the same PR.
Bump the affected agents' `version` in that same PR.

---

## 2. Pinning a run to its prompts

`context.json` has an optional `prompt_versions` object:

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

The same pin decides prompt stability: `npm run metrics`
groups completed runs by their exact `prompt_versions` vector and judges each
group on its latest 10 runs; a run that lacks the version of any agent that ran
is excluded, not guessed. See `docs/pipeline-architecture.md` §8.2.

When you archive a run with `scripts/new-run.js`, the run-local `context.json`
carries its `prompt_versions` with it — so `runs/` becomes an honest record of
_which prompts produced which results_, which is exactly what the pipeline
metrics and `/evolve` read back.

> **Honest scope:** populating `prompt_versions` is a manual/agent step
> (read each agent's `version:` and record it when the run starts). A
> declared version says what a prompt claims to be, so the runner also records
> what it was (§2a). None of the archived runs under `runs/` records either
> yet, so their prompts are unknown, not assumed.

### 2a. What the runner records: prompt-file digests

For each agent step the runner keeps `context.json` `provenance`
(`scripts/lib/provenance.js`): the SHA-256 of every prompt file the step uses
(its agent prompt and skills; for the Playwright Planner and Generator the
generated `.claude/agents/` definitions, untracked as they are, or `null`
where they do not exist), the model id and harness version, the output it
describes, and the date. The runner cannot see which model ran an agent, so
the operator declares it once per session, like the reviewer name:
`QAIZEN_MODEL` and `QAIZEN_HARNESS`; undeclared, it is `unknown`.
Provenance is written with the runner's own writes (a gate decision at the
latest), the first time it sees a step's output and again when the output
changes, so a run stopped at a gate still writes nothing. `npm run pipeline
-- --status` shows it. Older runs keep no provenance and show as unknown;
nothing is backfilled.

The digests and the declared model are taken when the runner records them,
not when the agent ran: at its next write after the agent wrote its output (a
gate decision at the latest). A prompt edited in between is recorded as
edited. The Healer is not among the steps: it produces no run artifact, and
each candidate it submits is recorded with its own digests in
`analysis/healer-validation/` (`docs/healer-guardrails.md`); its prompt
file is not recorded there yet.

Gate 3 binds the Planner's and the Generator's prompt files by digest
(binding version 3), not their declared versions: editing either prompt
after Gate 3 returns Gate 3 to pending, with the edited file named, and
through the chained digests every gate after it. The Generator's prompt is
bound at Gate 3, as its declared version was, so an edit to it reopens a spec
review whose spec did not change. Two consequences follow:

- Regenerating the agent definitions (`npx playwright init-agents` after a
  Playwright upgrade, `docs/dependency-maintenance.md`) reopens Gate 3 of
  every run in progress, as does running a run on a machine whose
  `.claude/agents/` differ or are absent (they are gitignored).
- The prompt files are read from the run's folder. A normal run's folder is
  the repository; the demo workspace under `runs/DEMO-1/` has no
  `.claude/agents/`, so its Gate 3 binds both prompts as absent while its
  provenance, read from the repository, records their digests.

An approval recorded under an earlier version keeps verifying by its own
rules.

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

   `--stage reporter` evaluates a Reporter candidate. The Reporter reports on
   a run, not a story, so its candidate starts from a copy of
   `examples/evaluation/reporter-inputs/login-success/` (a synthetic finalized
   run of the fixed story, described in its README). The release report is
   checked against that run's own context, test cases, analysis and ledger
   (`scripts/lib/report-checks.js`): schema, version, counts derived from the
   ledger, coverage per risk as the ledger supports it, failure lists, bug
   drafts, flaky units, a recommendation that is never `pass` while something
   blocks it, and no `conditional_pass` over a Red failure on a high-severity
   risk. No gold
   release report is declared, so the comparison in step 4 is always with a
   previous candidate's results: for a change, produce one candidate with the
   current prompt first, then one with the changed prompt.

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

Every results file the evaluator writes is rewritten only when its results
change: a re-run that measures the same thing leaves the file, and the date
it records, as they are.

---

## 3a. The regression set

One candidate from one story says little about a change that breaks one kind
of input, and nothing about how often the agent gets it right. The regression
set (`examples/evaluation/regressions/`, `schemas/regression-set.schema.json`)
holds the cases the agents must keep getting right, each an input, the agent
it is for, the behavior expected of it and the mechanical checks that decide
it, with where it came from:

- audit probes that turn on an agent's judgment (a criterion with its
  comparison flipped, cut short, taken from an "Out of scope" section or a
  comment; a payment story in Spanish held to the full track);
- the Bench Shop seeded bugs, which the Test Designer must cover with an
  automated case;
- false heals, which the Healer must decline, with a control case it must
  still repair so that declining everything does not pass;
- every escaped defect, once one is recorded (none is yet).

**When it runs.** On every MINOR or MAJOR prompt change, for the cases of the
changed agent; on every model upgrade, and on every regeneration of the
Playwright agent definitions (the Healer's prompt), for every case.

**How it runs.** The evaluator never runs an agent. Run the agent k times on
each case's input (k is in the manifest, 3 today), as the case's README says,
and put each output under `<trials-dir>/<case-id>/trial-<n>/`. Then declare
the model as for a run and score the trials:

```bash
QAIZEN_MODEL=<model id> node scripts/evaluate-agents.js \
  --regressions <trials-dir> [--agent analyst|test-designer|healer]
```

The report gives, per case, the trials passed out of k, pass^k (every trial
passed) and a Wilson 95% interval on its pass rate; then the share of cases
passing every trial, and of trials passing, each with its interval. pass^k is
the measure because an agent behind a human gate must be right every time,
not once in k. A missing trial is missing work, never a smaller denominator.

**The decision rule is written before the run.** It is part of the manifest:
today, block the change when any case fails all k of its trials, or when the
share of cases passing every trial falls below the lower bound of the previous
results' interval. The evaluator refuses to run while the set has uncommitted
changes, so the rule and the cases that judged a change are in history before
the results. A block is the "needs rework" outcome, not a gate: the human
reads the failed trials and decides. A small set detects only large
regressions, so a failing case is re-run to separate a flake from a
regression, and adding cases is worth more than adding trials.

**The evidence.** The results, with the prompt-file digests, the declared
model and the output digest of every trial, go to
`evidence/regressions/<agent>.json` (`all.json` without `--agent`;
`schemas/regression-results.schema.json`) and are committed with the change.
The file already there is the previous result the rule compares with.

**Incidents become cases.** A false heal, an escaped defect or a probe that
shows an agent doing the wrong thing is added as a case, with its input and
the expected behavior, in its own commit before the change it motivates is
evaluated.

---

## 4. What this is NOT

- **Not** an automatic prompt-rewriter. Metrics and `/evolve` _propose_
  changes; a human edits the prompt and bumps the version. Prompts are never
  rewritten autonomously (`CLAUDE.md` §3).
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
6. For a MINOR or MAJOR change: score the changed agent's regression cases
   (§3a) and commit `evidence/regressions/<agent>.json` with the change; a
   block is rework unless the human, having read the failed trials, records
   why it is acceptable in the PR.
7. On the next run, record the new version in `context.json.prompt_versions`.

On a model upgrade, with no prompt change, score every case (§3a) before the
new model is used for runs.
