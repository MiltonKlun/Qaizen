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
→ GATE 4 → execute (runner runs npx playwright test) → classify (runner runs
the rule-based classifier) → [reporter step] → --resume → done
```

When the run completes the runner reminds you of the two post-run habits:
`npm run new-run <story-id>` (archive) and `npm run session-summary` (feed
`/evolve`).

## 3. Guide steps vs exec steps

| Kind      | Steps                                                   | Who acts                                                                                            |
| --------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Guide** | analyst, test-designer, planner, api, generator, report | **You + the agent.** The runner prints the exact instruction and exits; it never fakes an LLM step. |
| **Gate**  | gate1, gate2, gate3, gate4                              | **You, interactively.** Brief rendered, decision captured, audit + telemetry written.               |
| **Exec**  | execute, classify                                       | **The runner.** Deterministic: `npx playwright test`, then `scripts/run-failure-classifier.js`.     |

Playwright failures at the execute step are **data for the classifier**, not
a runner error — the runner continues to `classify` either way. The
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
`test/scripts-smoke.test.js`) and proves **by construction** that no CI job,
script, or agent can ever pass a gate: every CI stdin is a pipe, and the
only path to an approval is a human typing at a terminal. A separate smoke
test asserts no GitHub workflow invokes the runner at all.

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
