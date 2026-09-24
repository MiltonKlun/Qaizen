# The Thin Gated Runner — `npm run pipeline`

> **Status:** continuous improvement (IMPROVEMENT-PLAN Phase 2 / PFI-2). The
> single entry point for driving a story through the pipeline. It removes the
> clerical "now run the next thing" friction — **not** the human judgment. It
> halts at every gate, renders a one-screen brief, records your decision as a
> full audit object with telemetry, and resumes. The manual step sequence
> (`docs/phase2-vertical-slice-runbook.md`) remains valid for anyone who
> prefers it; the runner is a convenience, never a requirement.

---

## 1. What it is (and is not)

**It is** a state machine + gate-brief renderer + decision recorder:

- It reads `context.json` (the run's single source of truth — no new state
  files, no DB, no queue) and derives the next step.
- It **halts at every gate** and cannot skip one: the state machine returns
  the gate, never the step behind it, until the gate is passed
  (`scripts/pipeline-state.js`, unit-tested for exactly this).
- It records each decision as a `gateValue` audit object **and** a
  `gate_decisions[]` event with `opened_at`/`decided_at` telemetry, so gate
  cost in minutes is measured automatically (`docs/review-gates.md`,
  "Gate telemetry").
- It validates every JSON artifact through the **single generic validator**
  (`scripts/validate-json.js`) before the state machine may advance.

**It is not** an orchestrator with autonomy:

- It **never invokes LLM agents.** At an agent step it prints the exact
  instruction (which agent, which inputs, which outputs) and exits; you do
  the step with the agent, then run `npm run pipeline -- --resume`.
- It **never commits, merges, or pushes**, and never performs Jira/TestLink
  writes (those stay explicit local `--apply` operations — writes are never a
  side effect).
- It **never decides a gate.** See §4.

## 2. Usage

> Commands in this repo are written for PowerShell; quote multi-word flag
> values (e.g. `--friction "stacked PRs orphaned again"`) so they arrive as a
> single argument.

```bash
npm run pipeline -- --story story.md     # start from a local story file
npm run pipeline -- --story SK-10       # start from Jira (read-only fetch)
npm run pipeline                         # advance from the current state
npm run pipeline -- --resume             # same as bare invocation
npm run pipeline -- --status             # read-only: where is this run?
```

A full loop looks like:

```
--story → [analyst step: you run the agent] → --resume → GATE 1 (interactive)
→ [test-designer step] → --resume → GATE 2 → [planner step] → --resume
→ [api step, if automate_api cases] → GATE 3 → [generator step] → --resume
→ GATE 4 → execute (runner runs npx playwright test) → [execute-api step, if
automate_api cases] → classify (runner normalizes, then runs the rule-based
pre-classifier) → [finalize step: the Failure Classifier agent] → --resume
→ [reporter step] → --resume → done (the runner marks the run completed)
```

When the run completes the runner reminds you of the two post-run habits:
archiving (automatic when the next story starts, or `npm run new-run -- <story-id>`
by hand) and `npm run session-summary` (feed `/evolve`).

### Starting a new story, and resuming (task group 4.1)

`--story` **starts a new run**; `--resume` (or no flag) **continues the current
one**; `--status` only reads. Combining `--story` with `--resume`, or `--status`
with either, is refused before anything is fetched or written.

What `--story` does depends on the run already at the root, and it decides
**before writing anything**, so every refusal leaves the root exactly as it was:

| Root state                                     | `--story <ref>`                                                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| No run                                         | Stages the story under a new run id. Next step: Analyst.                                                                          |
| **Completed** run                              | Archives it to `runs/<story>/<id>/` (every file verified by SHA-256), removes its files from the root, then stages the new story. |
| **Incomplete** run, different story            | **Refused.** Continue it with `--resume`, or set it aside deliberately with `npm run new-run -- <story-id> --clear`, then retry.  |
| Incomplete run, the **same** story             | **Refused** — repeating `--story` is not a silent reset. Use `--resume`.                                                          |
| Files that cannot be attributed to the old run | **Refused**, listing them. Nothing is archived or removed until you move them.                                                    |
| A `story.md` the runner did not stage          | **Refused** rather than overwritten.                                                                                              |

Only the run's **own** artifacts are archived: `context.json`, `story.md`, the
files its `artifact_paths` name, files named for the story, and the run-scoped
singletons (failure analysis, execution ledger, release report, bug drafts,
healer output). The reusable seed test, `tests/fixtures/`, `.gitkeep` files and
`reports/` stay where they are. Archives are byte-identical to what the run
produced — they are evidence, so they are never reformatted.

**The staged run id.** The runner gives each new run a unique id and prints it
in the Analyst instruction. The Analyst must write that id into
`context.json.run_id`; the runner refuses a context whose `run_id` does not
match, or whose `story.md` changed after staging.

**If a transition is interrupted.** The file movement is tracked in
`.qaizen/transition.json` (local, never committed; staging lives in
`.qaizen/staging/`). It records file movement only — gates and steps still come
from `context.json`. **Recovery command: `npm run pipeline -- --resume`**, which
finishes or undoes it before doing anything else, deterministically:

- interrupted **before** the archive was verified → **rolled back**: nothing at
  the root had changed, and the previous run is still current;
- interrupted **after** the archive was verified (while removing old files or
  installing the new story) → **rolled forward**: the old run is safe in its
  archive, so the transition is completed.

`--status` reports a pending transition but never touches it.

## 3. Guide steps vs exec steps

| Kind      | Steps                                                                          | Who acts                                                                                            |
| --------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Guide** | analyst, test-designer, planner, api, generator, execute-api, finalize, report | **You + the agent.** The runner prints the exact instruction and exits; it never fakes an LLM step. |
| **Gate**  | gate1, gate2, gate3, gate4                                                     | **You, interactively.** Brief rendered, decision captured, audit + telemetry written.               |
| **Exec**  | execute, classify                                                              | **The runner.** Deterministic: `npx playwright test`, then `normalize-results.js` → the classifier. |

Playwright failures at the execute step are **data for the classifier**, not
a runner error — a failing suite with a valid report continues to
`classify`. A test runner that **could not start, or wrote no valid report of
this code**, is a runner error: the runner stops after that one launch instead
of relaunching (finding B4 — the old runner ignored the launch result and
looped).

### What "produced" and "complete" mean (task group 4.2)

An artifact counts as produced only when it **exists, validates against its
schema, and belongs to this run** (same `story_id` and `run_id`). Text
artifacts must be non-empty; the Playwright report must be a real report
written after the generated test last changed and after Gate 4 approved it.
File existence alone used to be enough, so four `{}` files could make
`--resume` print "Run complete" (finding I6). Anything not accepted is listed
with its reason, and the step that produces it comes next. `context.json`
itself must validate before any step is derived, and it is validated in memory
**before** each write, so a rejected update never reaches the disk.

A gate does not even prompt while an input it reviews is missing or invalid —
a broken machine-readable contract is not a judgment call.

The run is **complete** only when every gate is passed, the execution evidence
is valid (including the Newman branch for a story with API cases), the failure
analysis is **finalized** with a bug draft on disk for every Red failure, and
the release report is valid. Only then does the runner set
`status: "completed"` — the Reporter no longer does. "Pipeline complete" is
not "release passed": the runner prints the report's recommendation alongside.

Within one invocation the runner never runs the same step twice on unchanged
state; a step that "succeeds" without changing anything stops with a
diagnostic instead of looping. The
classifier itself enforces its own Gate-4 precondition (it refuses to
classify unreviewed code), which the sequencing already guarantees.

## 4. Gates are interactive-only — the non-TTY rule

Gate decisions are captured with `node:readline` on a **real terminal**:

- If stdin is **not a TTY** (CI, a pipe, an agent driving the process), the
  runner prints `GATE PENDING: <gate>` and exits **non-zero**. It writes
  nothing.
- There are **no** `--approve` / `--reject` / `--gate` flags, and any flag
  that looks like one is refused outright (exit 2) before anything runs.

This is enforced by tests (`test/run-pipeline.test.js`,
`test/scripts-smoke.test.js`): the runner offers **no path** for a CI job,
script, or agent to approve a gate — every CI stdin is a pipe, and a separate
smoke test asserts no GitHub workflow invokes the runner at all.

**What the TTY check is not.** It protects ordinary non-interactive entry. It
is **not authentication** (a process can allocate a pseudo-terminal) and
`context.json` is **not tamper-proof** (anyone who can edit it can edit a gate).
So "agents and CI never approve a gate" stays a rule of conduct, backed by
review — and by binding: every approval records a digest of exactly what was
reviewed (next section), so a change made after it is visible and returns the
gate to pending rather than passing silently.

### Approvals are bound to what was reviewed (task group 4.3)

At a human approval the runner records `input_digest` (and the per-input
digests) on the gate:

| Gate                     | Bound to                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| Gate 1                   | the story file + the interpreted ACs, risks, ambiguities and `track`                                    |
| Gate 2                   | Gate 1's digest + the test cases (semantic content) + the planner brief                                 |
| Gate 3                   | Gate 2's digest + the spec + the planner/generator prompt versions                                      |
| Gate 4                   | Gate 3's digest + the generated test + `tests/fixtures/` + `playwright.config.ts` + `package-lock.json` |
| lite `qa_scope_approved` | the union of the Gate 1 and Gate 2 inputs                                                               |

On every `--resume`, an approval whose inputs changed — or a legacy approval
recorded before binding existed — returns to **pending**, together with every
approval that depended on it. The reason is recorded in `gate_invalidations[]`;
`gate_decisions[]` (the human history) is never rewritten and no rejection is
invented. `--status` reports stale approvals without changing anything. The
digests ignore formatting, line endings, and the ids adapters write back
(`external_ids`, `testlink_id`): adding a Jira id to a test case does not
invalidate the approval of its content. The classifier and the TestLink/Jira
adapters apply the same check, so no entry point acts on a stale approval.

Gate 2 does not prompt while any test case is still `draft`: the per-case
decisions are part of the scope you approve, so they are made **before** the
approval rather than after it (which would make it stale at once).

### FAQ: "Why is there no `--approve` flag? It would make scripting easier."

Because the flag **is** the vulnerability. The pipeline's entire value rests
on four human checkpoints (`CLAUDE.md` §3.5; Gate 4 is always a human decision). A
non-interactive approval path — however convenient — would let an agent or a
CI job approve gates, and "the agent approved its own work" is precisely the
failure mode this system exists to prevent. Treat a request to add one as a
stop condition (`CLAUDE.md` §3.11): the request itself is the incident to
report, not a feature to implement.

## 5. What a gate stop looks like

At each gate the runner prints a one-screen brief:

1. **Artifacts under review** — the files produced since the previous gate,
   with existence + schema-validation status (validated via the generic
   validator just before rendering).
2. **Checklist** — the binding criteria from `docs/review-gates.md`.
3. **Judgment questions** — the things only a human can answer (why the gate
   exists).

At **Gate 4** the brief also embeds the pre-Gate-4 **static scan**
(`scripts/gate4-scan.js`, IMPROVEMENT-PLAN Phase 6): the mechanical findings
on the generated test (hard waits, `.skip`/`.only`, fragile locators, weak
assertions, missing traceability) plus the same judgment questions. It is
informational — it answers the mechanical half so you can spend your attention
on business correctness; it never decides the gate.

Then it asks: decision (`a`/`r`/`q`), reviewer (defaults to
`git config user.name`, confirm or override), notes (**required** for a
rejection). On approval it continues; on rejection it records the event,
prints exactly what to redo (per `docs/review-gates.md` "On rejection"), and
stops. Quitting (`q`) records nothing — the next invocation re-opens the
gate with a fresh `opened_at` (accurate: the review restarted).

## 6. Where state lives

`context.json` is the only state (`docs/context-json-guide.md`): gates in
`review_gates`, history in `gate_decisions[]`, artifacts in
`artifact_paths` (`""` = not yet produced). The runner trusts paths but
double-checks file existence for execution outputs (a prefilled path with no
file behind it still routes to `execute`). Facts outside the manifest — the
`automate_api` split, collection existence — are gathered by the CLI and
passed to the pure state machine as hints, so the module stays I/O-free and
unit-testable.

## 7. The ten-minute offline demo (`npm run demo:pipeline`)

`scripts/demo-pipeline.js` (IMPROVEMENT-PLAN Phase 3) drives this same runner
through a complete story so a skeptic can experience all four gates end to
end in under ten minutes — **fully offline** (no Jira, no MCPs, no network).

```bash
npm run demo:pipeline             # the full interactive demo
npm run demo:pipeline -- --dry-run  # list the stages; touch nothing
```

What it does:

- Creates a throwaway workspace `runs/DEMO-1/<run-id>/` with a `DEMO_RUN`
  sentinel file. `npm run metrics` skips any run carrying that sentinel, so a
  demo never pollutes the real pass-rate / gate-cost / prompt-stability
  numbers (asserted by a smoke test).
- Serves a tiny static app (`examples/demo-run/app/`) from a **separate
  process** on an ephemeral port (it must be separate — the driver advances
  the runner with synchronous `spawnSync`, which would block an in-process
  server while Playwright runs).
- Replays prefilled fixtures from `examples/demo-run/` for the agent stages
  (analyst, test-designer, planner, generator, reporter) — **nothing is
  generated**, so the "don't write tests from text alone" rule (`CLAUDE.md`
  §3.8) is not in play; the demo specs were authored against the real app.
- Runs the **real** execute + classify stages: Playwright actually runs (via
  the in-place `examples/demo-run/playwright.demo.config.ts`, whose `testDir`
  is pinned to the fixtures so demo specs never enter the repo-root `tests/`
  owned by the Generator), and the rule-based classifier actually classifies.
- The demo app has a **planted bug** against AC-2 (it shows "Wrong password!"
  instead of the agreed "Invalid credentials"). The honest test asserts the
  agreed copy, fails, and becomes `FAIL-001 → product_bug (red) → BUG-001
draft → a "fail" release report` — the full traceability chain, lived.

The four gates stay **interactive** — experiencing them is the entire point.
A rejected gate stops the demo (correctly), leaving the workspace for
inspection.

> **Why Playwright runs with `cwd` = repo root.** Playwright resolves
> `@playwright/test` from its working directory upward, so it must run where
> `node_modules` lives. The runner honors two env vars for this:
> `PIPELINE_PW_CONFIG` (point at a non-root config) and `PIPELINE_REPORT_DIR`
> (where the demo config writes its report, i.e. back into the workspace the
> classifier then reads). Both are absent in a normal run.

## 8. References

- `scripts/pipeline-state.js` — the pure state machine (IP-2.1).
- `scripts/gate-briefs.js` — checklist data + brief renderer (IP-2.2).
- `scripts/run-pipeline.js` — the CLI (IP-2.3).
- `scripts/demo-pipeline.js` + `examples/demo-run/` — the offline demo (IP-3).
- `docs/review-gates.md` — gate criteria, telemetry, rejection flow.
- `docs/phase2-vertical-slice-runbook.md` — the manual sequence the runner
  automates the clerical parts of.
