# IMPROVEMENT-PLAN.md — AI-Assisted QA Pipeline

> **Status (2026-06-15): all coded phases complete.** Phases 1–8 shipped one
> PR off `main` at a time (#34 telemetry, #35 runner, #36 demo, #37 lite track,
> #38 evidence tooling, #40 Gate 3/4 assist, #41 when-to-use docs + deferred
> ledger; #39 tracked these planning docs in-repo). What remains is **human-led
> and cannot be done by an agent**: IP-0.1 (rotate API tokens) and the Phase-5
> benchmark **run series** (IP-5.1/5.4/5.7) — running real stories through both
> arms to turn `docs/evidence.md` from skeleton into measured results. Those
> four boxes are intentionally left `[ ]`.

> **Purpose.** Executable improvement plan derived from `PROJECT-BRIEF.md` §18.
> Written so an agent (e.g., Claude Code) can work through it **in order and
> atomically**: one phase = one PR off `main` (anti-stacking rule), one task =
> one verifiable unit of work. The executing agent updates the checkboxes in
> this file as work completes and records blockers inline.
>
> **Source mapping (traceability to the brief):** Phase 1 = new (enables gate
> telemetry) · Phase 2 = PFI-2 · Phase 3 = new (demo) · Phase 4 = PFI-1 ·
> Phase 5 = CE-1 / weakness #1 · Phase 6 = PFI-5 · Phase 7 = PFI-6 + CE-3 ·
> Phase 8 = deferral ledger for PFI-3/PFI-4/CE-2/4/5/6.
>
> **North star:** make the four gates cheaper to _exercise_, never cheaper to
> _mean_. Nothing in this plan weakens the gates, traceability, schema
> validation, or the Healer guardrails. Several phases strengthen them.

> **Coherence check (2026-06-10, applied before adoption).** The plan was
> verified against the repo and corrected in five places; everything else is
> verbatim from the original:
>
> 1. **Field names:** `context.gate_decisions[]` items use `decided_at`
>    (schema-required), not `reviewed_at`; the `gateValue` audit object is the
>    one that uses `reviewed_at`. IP-1.1 / IP-2.3 wording fixed accordingly.
> 2. **Folder ownership in the demo (Phase 3):** `tests/` is owned by the
>    Playwright Generator (CLAUDE.md §3.2) — the demo must NOT copy fixture
>    specs into it. Demo specs stay under `examples/demo-run/tests/` and run
>    via a dedicated demo Playwright config (`--config`), which also keeps them
>    out of CI's `playwright-full` job (whose `testDir` is `./tests`).
> 3. **IP-6.1 reality:** `scripts/healer-guardrails.js` uses inline regex
>    literals today, not named constants — the task is to _extract_ them into
>    named exports, behavior-identical, not merely re-export.
> 4. **IP-2.4 detail:** `package.json`'s `test:unit` / `test:smoke` /
>    `test:pipeline` enumerate explicit files — new test files must be appended
>    to those script entries or they silently never run.
> 5. **Ownership table lives in two places:** new top-level folders
>    (`evidence/`, `examples/demo-run/` labeling) must be added to BOTH
>    `docs/artifact-boundaries.md` and `README.md` §5 (Spanish).
> 6. **`contract-stability` is never "silent" on a docs-only schema PR:**
>    `scripts/check-contract-changes.js` warns whenever `schemas/` changes
>    without ALL of `agents/` + `docs/` + `examples/expected/` changing too.
>    Phase 1 intentionally has no `agents/` change, so the warning fires by
>    design and is **acknowledged in the PR description** (the script's own
>    documented path) — IP-1.4 and the phase done-when reworded.
> 7. **House style for timestamps:** existing schema timestamps
>    (`decided_at`, `reviewed_at`, `fetched_at`) are plain strings with an
>    ISO-8601 description, not `format: date-time` (ajv-formats is wired but
>    unused by convention). `opened_at` follows the same style — IP-1.1 fixed.

---

## 0. How to execute this plan (binding rules for the agent)

1. **One phase per PR, one PR off `main` at a time.** Branch naming:
   `feat/ip-phase-<N>-<slug>`. Do not start phase N+1 before phase N is merged.
2. **CLAUDE.md §3 discipline applies at all times:** folder ownership, exactly
   one generic JSON validator, traceability IDs, the four gates, Healer
   guardrails, stop conditions. >3 failed attempts on any task → **stop and
   report** with findings; do not brute-force.
3. **Schema-touching phases (1, 4, 5) must satisfy the Architecture Stability
   Rule inside the same PR.** The companion checklist is embedded in those
   phases — do all of it or do not touch the schema.
4. **Any edit to `agents/*.md`** requires: semver `version` bump + `changelog`
   entry + `changed_in_run`. Expect the informational `prompt-eval` CI job; a
   match drop of more than 10% vs baseline → rework the prompt before merge.
5. **Zero new runtime dependencies in this entire plan.** Node built-ins only
   (`node:readline`, `node:http`, `node:test`, `node:child_process`). If a task
   appears to need a dependency → stop and ask (stack is closed, brief §10).
6. **Phase Definition of Done (applies to every phase, in addition to per-task
   criteria):**
   ```bash
   npm run typecheck && npm run lint && npm run format:check \
     && npm run validate:all && npm run validate:examples \
     && npm run test:unit && npm run test:smoke
   ```
   All green, plus CI `quality-checks` green on the PR.
7. **Language convention:** `README.md` is Spanish — write README edits in
   Spanish. `docs/*` and code comments follow the existing English convention.
8. **Status legend:** `[ ]` todo · `[x]` done · `[~]` blocked (append reason).

---

## Phase 0 — Pre-flight (no PR)

Goal: a clean, verified starting point. IP-0.1 is independent of the rest and
must not gate the other phases, but it must happen this week.

- [ ] **IP-0.1 (HUMAN ONLY — cannot be delegated to an agent).** Rotate the API
      tokens that appeared in the earlier dev transcript (brief §15.8): Atlassian/
      Jira, Postman, TestLink. **Done when:** old tokens revoked at the provider,
      local `.env` updated, nothing staged or committed.
- [x] **IP-0.2 (agent).** Verify clean baseline on `main`: run the full §17
      verification block from the brief (`npm ci`, typecheck, lint, format:check,
      validate:all, validate:examples, test:unit, test:smoke, demo:healer,
      evaluate). **Done when:** all green; paste the summary into the Phase 1 PR
      description as the recorded baseline.
      _Done 2026-06-10: all green on main @ c5e488f — 17/17 examples, 10/10
      unit, 9/9 smoke, demo:healer PASS, evaluate 100% (5/5). Recorded in PR #34._
- [x] **IP-0.3 (agent).** Read before writing: `CLAUDE.md`,
      `docs/review-gates.md`, `docs/context-json-guide.md`,
      `docs/artifact-boundaries.md`, `docs/prompt-versioning.md`,
      `docs/healer-guardrails.md`, `docs/pipeline-architecture.md`,
      `schemas/context.schema.json`. **Done when:** the agent can state, in the
      Phase 1 PR description, the current `gateValue` shape and the
      `gate_decisions[]` item shape verbatim (note: the former uses `reviewed_at`,
      the latter uses `decided_at`).
      _Done 2026-06-10: shapes stated in PR #34. Extra finding: only
      `agents/spec-reviewer.md` mentions `gate_decisions` and it explicitly
      sets no gates (human appends the log)._

---

## Phase 1 — Gate telemetry groundwork (PR 1)

**Goal:** every gate decision records when review _started_, so gate cost in
minutes becomes measurable (`decided_at − opened_at` in the log;
`reviewed_at − opened_at` in the gate audit object). Schema-first, so the
Phase 2 runner PR contains zero schema changes. This is the future adoption
argument: "the four gates cost a median of X minutes per story."

- [x] **IP-1.1 Schema change.** In `schemas/context.schema.json`: add
      **optional** `opened_at` to `gate_decisions[]` items (plain `string`, ISO
      8601 description — same style as `decided_at`), and optional `opened_at`
      (`["string","null"]`, same style as `reviewed_at`) to the audit-object
      variant of `gateValue`. Optional fields → all existing artifacts remain
      valid → **no migration script required** (state this explicitly in the PR
      description).
- [x] **IP-1.2 Architecture Stability companions (same PR).** Update
      `docs/context-json-guide.md` and `docs/review-gates.md` with `opened_at`
      semantics (set at the moment the gate brief is first presented to the
      reviewer); add `opened_at` to at least one gate decision in every affected
      `examples/expected/` context fixture; check `docs/artifact-boundaries.md`
      and `docs/pipeline-architecture.md` — update if they enumerate context
      fields, otherwise record "n/a" in the PR.
- [x] **IP-1.3 Prompt audit.** Verify no agent prompt writes `gate_decisions[]`
      (expected: none — gate decisions are human-recorded). If one does, bump and
      changelog it per rule 4; otherwise record "no prompt changes required".
- [x] **IP-1.4 Verify.** `npm run validate:all && npm run validate:examples`
      green; run `node scripts/check-contract-changes.js` — it WILL warn that
      `agents/` did not change (no agent produces `gate_decisions[]`, per
      IP-1.3); acknowledge that warning explicitly in the PR description (the
      script's documented "legitimately unaccompanied" path).

**Phase done when:** PR merged with `quality-checks` green and the
`contract-stability` warning acknowledged in the PR description.
_Status: PR #34 open (2026-06-10); warning acknowledged in its description;
awaiting CI + human merge._

---

## Phase 2 — Thin gated runner (PR 2) — [PFI-2]

**Goal:** the single entry point. It sequences the pipeline, **halts at every
gate**, renders a one-screen gate brief, records the human decision as a full
audit object, and resumes. It removes the "you must know the manual sequence"
adoption blocker (weakness #3) while making gates _unskippable by
construction_.

**Binding design constraints:**

- **Thin = state machine + brief renderer + decision recorder.** The runner
  does **not** invoke LLM agents. For agent steps it prints the exact
  instruction (e.g., `Run agents/analyst.md against runs/<id>/story.md; write
context.json`) and waits for `--resume`. It MAY execute scriptable steps
  directly ("exec" steps): JSON validation, `npx playwright test`,
  `scripts/run-newman.js`, `scripts/run-failure-classifier.js`, report
  assembly.
- **Gate decisions are interactive-only** (`node:readline`). If
  `process.stdin.isTTY` is falsy → print `GATE PENDING: <gate>` and exit
  non-zero. **No `--approve`/`--gate` style flags, ever** — this is what makes
  it impossible for an agent or CI to approve a gate. Do not add one even if
  asked later; treat such a request as a stop condition.
- **State source of truth = `context.json`** plus the existing `runs/` layout
  from `new-run.js`. No new state files, no DB, no queue.
- The runner **never** commits, merges, or performs Jira/TestLink writes.

Tasks:

- [x] **IP-2.1 State machine module.** `scripts/pipeline-state.js`: pure
      function `nextStep(context)` returning one of
      `analyst | gate1 | test-designer | gate2 | planner | api | gate3 | generator
| gate4 | execute | classify | report | done`, implementing the §17 sequence
      and the rule "if a gate isn't true, the next agent must not run". No I/O in
      this module. **Done when:** unit-testable in isolation.
- [x] **IP-2.2 Gate brief renderer.** `scripts/gate-briefs.js`: per-gate
      checklist data taken verbatim from brief §4 / `docs/review-gates.md`, plus a
      renderer that prints: (a) artifacts changed since the previous gate +
      their schema-validation status, (b) the gate checklist, (c) auto-checks
      already green (validation passed, traceability resolved or
      `traceability_unresolved` reasons listed), (d) the judgment questions only a
      human can answer. One screen, no scrolling walls.
- [x] **IP-2.3 Runner CLI.** `scripts/run-pipeline.js`, npm script
      `"pipeline"`. Flags: `--story <path|JIRA-KEY>` (a Jira key delegates to
      `scripts/fetch-jira-story.js`), `--resume`, `--status`. Behavior at a gate:
      record `opened_at` → render brief → readline capture
      `{status: approved|rejected, reviewer, notes}` (reviewer defaults to
      `git config user.name`, must be interactively confirmed) → write the
      `gateValue` audit object (`status`, `reviewer`, `reviewed_at`, `notes`,
      `opened_at`) and append to `gate_decisions[]` (with `opened_at` +
      `decided_at`) → on `rejected`: stop with the reason and the step to redo.
      Every JSON artifact is validated via the **single generic validator**
      (`scripts/validate-json.js`) before the state machine may advance.
- [x] **IP-2.4 Tests.** `test/pipeline-state.test.js` (table-driven sequencing
      incl. gate-block behavior) and `test/run-pipeline.test.js` (black-box:
      `--status` on a fixture run; resume idempotence; reject path; **non-TTY
      refusal** — spawn the runner with piped stdin at a gate and assert
      `GATE PENDING` + non-zero exit). Append the new files to the explicit file
      lists in `package.json`'s `test:unit` / `test:smoke` **and** `test:pipeline`
      scripts (they enumerate files; a file not listed never runs). Respect the
      `test/` = pipeline-own-tests convention.
- [x] **IP-2.5 Docs.** New `docs/pipeline-runner.md` (usage, guide vs exec
      steps, the non-TTY rule, FAQ: "why is there no `--approve` flag"). Add the
      runner to `CLAUDE.md` operating instructions and to the `README.md` index
      (Spanish). Update `docs/pipeline-architecture.md` (structural addition).
- [x] **IP-2.6 CI safety assertion.** Extend `test/scripts-smoke.test.js` to
      assert the runner's non-TTY refusal, which proves by construction that no CI
      job can ever pass a gate. Confirm no workflow invokes the runner.
- [x] **IP-2.7 package.json.** Add `"pipeline"` script. Do not rename existing
      scripts.

**Phase done when:** from a fresh `npm run new-run`, `npm run pipeline --
--story <real story>` walks the full loop with all four gates recorded as
audit objects (with `opened_at`/`reviewed_at`), `npm run pipeline -- --status`
reports the correct next step at every stage, and `npm run metrics` ingests
the recorded `gate_decisions[]`.
_Status (2026-06-10): all tasks shipped in PR 2; sequencing/--status/refusal/
telemetry shape proven by 14 unit + 22 smoke tests. The full interactive walk
on a REAL story is necessarily a human session (gates are TTY-only by
design — the agent cannot do it) and is the first use of the runner after
merge; it doubles as the first Phase-5 telemetry datapoint._

---

## Phase 3 — Ten-minute canned demo (PR 3)

**Goal:** a skeptical coworker experiences all four gates end-to-end in under
10 minutes, **fully offline** (no Jira, no MCPs, no network), deterministic —
the `demo:healer` pattern extended to the whole loop. Rule 8 ("don't generate
tests from text alone") is not violated because **nothing is generated**: all
artifacts are prefilled fixtures being replayed; only execution is real.

- [x] **IP-3.1 Fixtures.** `examples/demo-run/` (owner: Human/team —
      `examples/` is already human-owned): `story.md`; stage snapshots
      `context.after-analyst.json`, `test-cases/DEMO-1.json`,
      `planner-input/DEMO-1.planner-brief.md`, `specs/DEMO-1.spec.md`;
      `tests/demo-login.spec.ts` (passing) and `tests/demo-broken.spec.ts`
      (intentionally failing — it feeds the classifier); `app/index.html` (small
      static page the tests run against). **The demo specs live and stay under
      `examples/demo-run/tests/` — they are NEVER copied into the root `tests/`
      folder, which is owned by the Playwright Generator (CLAUDE.md §3.2).**
      All fixtures carry full traceability IDs (DEMO story → RISK → TC → SPEC →
      PW → FAIL → BUG) and validate against their schemas.
- [x] **IP-3.2 Demo driver.** `scripts/demo-pipeline.js`, npm script
      `"demo:pipeline"`: creates an isolated run via `new-run.js` writing a `DEMO`
      sentinel file into the run folder; serves `app/` with `node:http` on an
      ephemeral port; advances stage-by-stage by copying the next fixture **into
      the run folder** (never into agent-owned root folders), validating it with
      the generic validator, and invoking the **real** runner gate flow — gates
      remain interactive, because experiencing the gates is the point. The execute
      stage runs Playwright with a dedicated demo config —
      `npx playwright test --config examples/demo-run/playwright.demo.config.ts`
      (its `testDir` points at `examples/demo-run/tests/`) — so the demo suite is
      invisible to `npm test` and to CI's `playwright-full` job (root config
      `testDir: './tests'`). The broken test produces a FAIL → classifier →
      `BUG-XXX.md` draft → release report, demonstrating the complete traceability
      chain.
- [x] **IP-3.3 Metrics isolation.** `scripts/pipeline-metrics.js` skips runs
      containing the `DEMO` sentinel (demo runs must never count toward
      `prompt_stability_met` or gate-cost stats). Unit test for the skip.
- [x] **IP-3.4 Determinism guard.** `--dry-run` flag lists stages without
      touching the network; smoke test asserts demo needs no external hosts.
- [x] **IP-3.5 Docs.** Quickstart section in `README.md` (Spanish) + addendum
      in `docs/pipeline-runner.md`; label `examples/demo-run/` clearly as fixtures
      in `docs/artifact-boundaries.md` **and** in the `README.md` §5 ownership
      table; note the demo config in `docs/test-tagging.md` if a `@demo` tag is
      used (so the tag vocabulary stays documented in one place).

**Phase done when:** fresh clone + `npm ci` + `npm run demo:pipeline` reaches
the release report in <10 minutes with exactly four interactive gate stops and
zero network access.

---

## Phase 4 — Lite track (PR 4) — [PFI-1]

**Goal:** tiered ceremony for routine work (weakness #2). Lite thins
**artifacts**, never **decisions**: schema validation, traceability, the
automation-decision requirement, and auditable gate records all survive in
every track. Gates 1+2 consolidate via the already-designed
`qa_scope_approved`; Gates 3 and 4 may be reviewed in one sitting but are
**recorded as two distinct decisions**. The track floor is principled, not
vibes: **Red-taxonomy domains can never be `lite`.**

- [x] **IP-4.1 Red-domain data module.** `scripts/red-domains.js`: export the
      Healer Red taxonomy as data with keyword patterns (business-logic
      assertions, permission/role behavior, security validations, pricing/payment,
      compliance, data integrity). Cross-link `docs/healer-guardrails.md` as the
      canonical narrative. **Do not modify Healer code** — this is a new consumer
      of the same taxonomy, not a refactor of `healer-guardrails.js`.
- [x] **IP-4.2 Track floor.** `scripts/track-floor.js`: pure
      `minimumTrack(context)` → `'lite' | 'standard' | 'full'`, returning a floor
      of `standard` (with reasons) when story/risks/ACs match red domains, plus
      size heuristics (e.g., >4 ACs or >5 risks → `standard`; constants at the top
      of the file, documented). Table-driven unit tests in
      `test/track-floor.test.js` (appended to the `test:unit` file list).
- [x] **IP-4.3 Schema change.** `schemas/context.schema.json`: optional
      `track` enum `["lite","standard","full"]` (absence = `standard`, documented
      rather than schema-defaulted) and optional
      `track_floor: {minimum, reasons[]}`.
- [x] **IP-4.4 Architecture Stability companions (same PR).** Update
      `docs/context-json-guide.md`; `docs/review-gates.md` (lite gate semantics:
      one `qa_scope_approved` audit decision replaces Gates 1+2; Gates 3/4 stay
      separate records); `docs/pipeline-architecture.md` (track-aware flow is
      structural); `docs/automation-decision-model.md` (one line: decision +
      written reason remain mandatory in **every** track); add a lite fixture to
      `examples/expected/`; migration: none needed (optional fields) — state it.
- [x] **IP-4.5 Prompt updates (semver + changelog each).** `agents/analyst.md`:
      propose `track` with reasons; emit the lite output profile (risks, ACs,
      ambiguities only) when lite; never propose below `minimumTrack`.
      `agents/test-designer.md`: lite output profile (trimmed narrative fields;
      `automation_decision` + `automation_decision_reason` untouched).
- [x] **IP-4.6 Runner enforcement.** Track-aware sequencing in
      `pipeline-state.js` (lite: analyst → `qa_scope_approved` gate → planner/api
      → gate3 → gate4 → execute → classify → report). The runner **refuses** to
      record `track: lite` when `minimumTrack(context)` is higher, printing the
      reasons. Unit tests for both behaviors.
- [x] **IP-4.7 Verify.** `prompt-eval` delta ≤10% vs baseline (rework prompts
      if exceeded); full Phase DoD green; run one real lite story end-to-end and
      one red-domain story that gets correctly floored to `standard`.

---

## Phase 5 — Evidence: pipeline vs raw prompting (PR 5 + run series) — [CE-1, weakness #1]

**Goal:** replace asserted value with measured value. Two arms over 5–10
already-shipped stories with ground truth. Pipeline-arm runs go through
`new-run.js`, so the benchmark **also** accumulates real runs toward the
10-run `prompt_stability_met` threshold (weakness #6) — one effort, two gaps
closed.

- [ ] **IP-5.1 (HUMAN + agent) Story selection.** 5–10 shipped stories with
      ground truth (bugs found post-ship; selectors that later broke); mixed
      sizes; ≥1 red-domain story; ≥1 story suitable for `lite`. Record the list
      and rationale in `docs/benchmark-protocol.md`.
- [x] **IP-5.2 Protocol doc.** `docs/benchmark-protocol.md`: Arm A = same
      model, raw prompt ("write Playwright tests for this story") with reasonable
      follow-ups, timeboxed; Arm B = pipeline via the runner. Metric definitions
      with formulas: time-to-first-green-test; Gate-4 corrections (B) vs
      corrections-to-acceptable (A), both judged against the same §4 Gate-4
      checklist; **fictional-test rate** (% of assertions about behavior never
      observed in the running app — this is where rule 8 should dominate);
      selector survival after replay against ≥2 later app versions; known-bug
      catch rate; traceability coverage (expected ~0 for Arm A — say so).
      Pre-register the thresholds that would count as "pipeline worth it" **and**
      what would count as "raw prompting wins for this class of story".
- [x] **IP-5.3 Capture tooling.** New top-level `evidence/` (owner: Human/team
      — add the row to the ownership table in `docs/artifact-boundaries.md`
      **and** `README.md` §5). `scripts/benchmark-capture.js` appends JSONL
      measurement records. Because every JSON artifact must validate (discipline
      rule 3): add a minimal `schemas/benchmark-record.schema.json` + one
      `examples/expected/` record, and satisfy the Architecture Stability
      companions (no prompts affected, no migration — new schema).
- [ ] **IP-5.4 (HUMAN drives gates, agent assists) Execute both arms** per
      story. After each pipeline run:
      `npm run session-summary -- --friction "<observed friction>"`.
- [x] **IP-5.5 Selector survival (environment-dependent).**
      `scripts/selector-survival.js`: replay each arm's tests against later
      checkouts/tags of the target app. If app history is unavailable, downgrade
      this metric to qualitative and record the justification in the evidence doc
      — do not fake the number.
- [x] **IP-5.6 Evidence write-up.** `docs/evidence.md`: honest results,
      **including where raw prompting won**, plus the measured median
      minutes-per-gate from Phase-1 telemetry. Link it from `README.md` (Spanish).
- [ ] **IP-5.7 Metrics check.** `npm run metrics` after the series; record
      whether `prompt_stability_met` now computes (10+ logged runs) and paste the
      output into the PR.

---

## Phase 6 — Gate 3/4 assist (PR 6) — [PFI-5]

**Goal:** the reviewer spends judgment, not archaeology. A static pre-Gate-4
scan in the guardrails' one-source-of-truth style. The scan **informs and
never fixes** — Gate 4 stays permanently human; this makes the human faster,
not optional.

- [x] **IP-6.1 Additive-only guardrails extraction.** In
      `scripts/healer-guardrails.js`, the suppression/weak-assertion patterns are
      currently **inline regex literals** — extract them into named exported
      constants (e.g. `SKIP_PATTERN`, `WEAK_ASSERTION_PATTERN`) used by
      `guardrailViolations`, **without changing any behavior**. Acceptance: the
      existing 10/10 guardrail unit tests pass unmodified; `guardrailViolations`
      output is byte-identical on the demo fixtures (`npm run demo:healer` exits
      0 unchanged).
- [x] **IP-6.2 Scanner.** `scripts/gate4-scan.js`: pure `gate4Findings(source)`
  - CLI over given test files. Checks: hard waits (`waitForTimeout`, bare
    `setTimeout`); `.skip` / `.fixme` / `.only`; fragile locators (`nth-child`,
    `.nth(`, index-based XPath, long CSS chains); missing `TC-`/`SPEC-`
    traceability comment; weak assertions (reuse IP-6.1 constants — do not
    duplicate the regexes). Output: findings list + a "judgment items for the
    human" footer (the §4 Gate-4 questions). The scanner never edits files.
- [x] **IP-6.3 Tests + script.** `test/gate4-scan.test.js` (table-driven;
      `tests/seed.spec.ts` as the known-clean fixture; appended to the `test:unit`
      file list). npm script `"scan:gate4"`.
- [x] **IP-6.4 Runner integration.** The Gate-4 brief embeds scan findings as
      its "auto-checks" section, so the reviewer opens the gate with the
      mechanical checks pre-answered.
- [x] **IP-6.5 Gate-3 sharpening.** `agents/spec-reviewer.md` version bump:
      tighten the checklist (negative-case presence per TC priority,
      unrelated-flow detection, spec→TC traceability echo). If Phase-1/5 telemetry
      exists, let the most-frequent Gate-3 rejection reasons drive the checklist
      order; otherwise refine from brief §4. `prompt-eval` delta ≤10%.
- [x] **IP-6.6 Optional CI job.** `gate4-scan` (informational,
      `continue-on-error`) on PRs touching `tests/`: posts a findings summary
      comment. Never blocking, never editing — mirrors the existing informational
      CI posture.

---

## Phase 7 — Honest docs: fit/don't-fit + à-la-carte (PR 7) — [PFI-6, CE-3]

**Goal:** coworkers can adopt one piece without buying the whole pipeline, and
nobody is oversold (weakness #5). The standalone wedges lead with the two
zero-ceremony tools.

- [x] **IP-7.1 Fit guide.** `docs/when-to-use.md`: _fit_ (multi-AC features,
      red-domain stories, anything needing an audit trail) / _don't-fit_ (one-off
      scripts, throwaway spikes, sub-lite work). For sub-lite work, state plainly:
      "prompt the AI directly; here is exactly what you forfeit — traceability and
      the audit trail." Honesty in docs; **no bypass is added to the tool**.
- [x] **IP-7.2 Three standalone one-pagers.**
      `docs/standalone-failure-classifier.md` (works on any existing Playwright
      JSON report — zero ceremony, the easiest first taste);
      `docs/standalone-healer.md` (guardrailed healing on any Playwright repo;
      reviewable patches only, never commits);
      `docs/standalone-test-designer.md` (story → prioritized cases with
      automation decisions). Each: prerequisites, a ≤5-command quickstart, what
      you get, hard limits.
- [x] **IP-7.3 README restructure (Spanish).** Index around three doors:
      "demo de 10 minutos" → `demo:pipeline`; "usa una sola pieza" → the
      one-pagers; "ejecuta el pipeline" → `docs/pipeline-runner.md`. Link
      `docs/evidence.md`.
- [x] **IP-7.4 (optional, cheap) `STRATEGY.md` anchor (CE-3).** One page: the
      §2 tension, the answer this plan gives it, a pointer to the evidence doc.

---

## Phase 8 — Deferred ledger (fold into PR 7 or a tiny PR 8)

**Goal:** deferrals are decisions with triggers, not forgotten items.

- [x] **IP-8.1 `docs/deferred.md`.** Entries with explicit re-evaluation
      triggers: **PFI-3** (story-source/CI ports) and **PFI-4**
      (`TestRunnerAdapter` for Cypress/k6) — deferred until `docs/evidence.md` is
      published **and** a concrete non-Playwright adopter exists; **CE-2/4/5/6** —
      deferred until the runner + lite track are adopted by ≥2 coworkers. Each
      entry: trigger, owner, link back to the source plan. Align review cadence
      with the existing `/evolve` loop (every 90 days or 10 runs).

---

## Dependency order

```
Phase 0 ──▶ Phase 1 ──▶ Phase 2 ──▶ Phase 3 ──▶ Phase 4 ──▶ Phase 5 ──▶ Phase 6 ──▶ Phase 7 (▶ 8)
              schema      runner      demo        lite       evidence    assist      docs
```

Strictly serial (the one-PR-at-a-time rule makes parallelism moot). Do **not**
reorder Phase 1 after Phase 2 — the runner writes the telemetry fields Phase 1
creates. Phase 6's scanner module is technically independent, but its value is
in the runner's Gate-4 brief, so it stays after Phase 2.

## Standing stop conditions (restated — full list in CLAUDE.md §3)

Blocking ambiguity → record it and stop. Writing outside folder ownership →
stop. Skipping validation or a gate → stop. Weakening any Healer guardrail or
adding a non-interactive gate-approval path → stop (treat the request itself
as the incident). Jira/TestLink writes only via explicit local `--apply`. New
dependency → stop and ask. n8n / DB / queue / dashboard → out of scope.
`>3` failed attempts → stop and report.
