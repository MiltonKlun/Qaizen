# Plan — Poor-fit improvements (make it lighter & more portable)

> **Status:** planned, not started. These six improvements target the
> situations where the pipeline currently **over-fits** (too heavy for routine
> work; assumes one workflow/stack; manual orchestration doesn't scale). The
> unifying goal: **shrink gracefully for small jobs, stretch to foreign stacks**
> — instead of all-or-nothing. Each is additive; none weakens a gate.

**Discipline (same as every phase plan):** each Task Group ships as its own
branch → PR → green CI → merge. One PR off `main` at a time. A schema change
triggers the Architecture Stability Rule (schema + agents + docs + examples +
migration in ONE PR). Prefer the Open/Closed adapter pattern
(`agents/test-management-adapter.md`) over editing the core. Stop-and-ask before
a new dependency.

---

## Order of work (by priority / payoff)

| #   | Task Group                                | Effort  | Unlocks                           |
| --- | ----------------------------------------- | ------- | --------------------------------- |
| 1   | **PFI-1** Tiered lite/standard/full mode  | Low–Med | Routine work stops being painful  |
| 2   | **PFI-2** Thin gated runner               | Med     | Scales beyond one-story-at-a-time |
| 3   | **PFI-3** Story-source + CI ports         | Med     | Fits more companies' workflows    |
| 4   | **PFI-4** Test-runner port (Cypress/k6/…) | High    | Fits teams on other tooling       |
| 5   | **PFI-5** Sharper Gate 3/4 review assist  | Low–Med | Better net win on simple stories  |
| 6   | **PFI-6** "When to use" + à-la-carte docs | Low     | Adoption without resentment       |

> The cheap, high-impact trio is **PFI-1, PFI-5, PFI-6** — doing only those
> removes most real-world friction without touching the architecture. PFI-2–4
> are the deeper investments for "used by a whole team on varied projects."
> PFI-6 may be pulled forward at any time (pure docs, no dependency on others).

---

## PFI-1 — Tiered "lite / standard / full" mode

Let a story declare how much ceremony it needs, so a bugfix isn't forced
through the full machinery.

**Schema change** (`schemas/context.schema.json`, Architecture Stability) —
add an OPTIONAL `track` field; backward-compatible (absent ⇒ `standard`).

- [ ] Schema: add `track: "lite" | "standard" | "full"` (optional, default `standard`).
- [ ] Define each level (in `docs/`):
  - [ ] **lite** — Analyst + a single consolidated gate (`qa_scope_approved`) +
        quick test-design; skip prompt-versioning, runs-archival, metrics ceremony.
  - [ ] **standard** — the four gates; no Phase-3 scaffolding required.
  - [ ] **full** — everything (high-risk features).
- [ ] Wire the existing hooks: `qa_scope_approved` (consolidates G1+G2) is the
      lite path's gate; `design_stage` interplay documented.
- [ ] Agents read `track` and adjust expectations (e.g. lite doesn't require
      `prompt_versions`). Update `agents/analyst.md` + `agents/test-designer.md`.
- [ ] Companions in the same PR: `docs/review-gates.md` (lite consolidation),
      a new example `examples/expected/*lite*.expected-context.json`, migration
      (no-op annotator — optional field).

**Definition of Done:**

- [ ] `track` validates; absent ⇒ behaves exactly as today (no regression).
- [ ] A lite run skips the heavy ceremony and is documented as legitimate.
- [ ] Gate 4 still required at `full`/`standard`; lite's consolidation never
      removes the code gate where code exists.
- [ ] Architecture Stability satisfied in one PR.

---

## PFI-2 — Thin gated runner

Remove the clerical "now run the next step" friction. **Not autonomy** — it
stops at every gate for human input.

- [ ] Create `scripts/run-pipeline.js`:
  - [ ] Reads `context.json` (+ `track` from PFI-1) to know the next step.
  - [ ] Runs the **deterministic** steps (validators, classifier, metrics) and
        **prints the agent step to invoke** at LLM steps (it does not fake the LLM).
  - [ ] **Halts at each gate** with a clear "you are at Gate N — review X" prompt;
        never advances past an unset gate (`review_gates` precondition check).
  - [ ] `--status` sub-mode: print where the run is in the chain.
- [ ] Never pushes, commits, merges, or calls a write `--apply` (those stay
      explicit/human, `CLAUDE.md` §3.6 / "writes are never a side effect").
- [ ] `npm run pipeline` script; document in the runbook as the orchestration
      convenience (the manual steps remain valid for anyone who prefers them).

**Definition of Done:**

- [ ] The runner chains steps and **stops at every gate**; cannot skip one.
- [ ] Makes zero writes/commits/merges; no autonomous batch across stories.
- [ ] A run can be driven with fewer manual "run the next thing" actions.
- [ ] Smoke test added (`test/`) asserting it halts at an unset gate.

---

## PFI-3 — Story-source + CI ports

Generalize the front door + CI the way test-management was generalized.

### PFI-3a — Story-source port

- [ ] Define the port (interface): `fetch(storyRef) -> story.md + metadata`.
- [ ] Adapters behind it (selector env var, e.g. `STORY_SOURCE`):
  - [ ] `jira` (exists — `scripts/fetch-jira-story.js`; wrap behind the port).
  - [ ] `github-issues` (read-only, via the GitHub MCP already configured).
  - [ ] `markdown` (manual `story.md` — the no-source path).
  - [ ] (planned, not built) `linear`.
- [ ] "No clean AC" is a first-class path → hands to the PFI/CE brainstorm front-end.

### PFI-3b — CI port

- [ ] Document a generic CI contract (what the pipeline needs from CI):
      run `quality-checks` equivalent + optional test jobs + artifact upload.
- [ ] Provide a **GitLab CI** example (`.gitlab-ci.yml`) alongside the GitHub one.
- [ ] Ensure scripts emit a portable result (e.g. JUnit/JSON) consumable by any CI.

**Definition of Done:**

- [ ] Story source is selectable; adding one is a new adapter, not a core edit.
- [ ] At least Jira + GitHub-issues + markdown work; others planned.
- [ ] A second CI provider has a working example. Open/Closed preserved.

---

## PFI-4 — Test-runner port (Cypress / k6 / …)

The biggest architectural gap: the spine assumes Playwright + Newman. Make
execution pluggable so teams on other tooling get the pipeline's value
(risk→case→traceability→report) without rewriting it.

- [ ] Define a `TestRunnerAdapter` port (mirror `TestManagementAdapter`):
      `generate(spec) -> test artifact`, `execute() -> normalized results JSON`.
- [ ] Normalize results to one shape the Failure Classifier already understands
      (so the classifier/reporter stay runner-agnostic).
- [ ] Adapters:
  - [ ] `playwright` (exists — wrap behind the port; no behavior change).
  - [ ] `newman` (exists — wrap).
  - [ ] (planned) `cypress`, `k6`, `rest-assured`.
  - [ ] `manual-only` — export test cases, no automation (for black-box/vendor apps).
- [ ] Selector env var (e.g. `E2E_RUNNER`, `API_RUNNER`); default = current stack.
- [ ] Document that only **generation + execution** are runner-specific; the
      rest of the chain is unchanged.

**Definition of Done:**

- [ ] Existing Playwright/Newman paths work unchanged behind the port (no regression).
- [ ] One additional runner (or `manual-only`) proven end-to-end to the report.
- [ ] Adding a runner is a new adapter, never a core edit.

---

## PFI-5 — Sharper Gate 3/4 review assist

Make review _faster_ (that's where AI-test time goes), so the net win on simple
stories improves.

- [ ] **Diff-aware Spec Reviewer** — use `code_change_context` (TG15) to surface
      inline at Gate 3: "this spec covers / misses the changed files / this risk."
  - [ ] Extend `agents/spec-reviewer.md` (version bump) + the spec-review schema
        if a new field is needed (Architecture Stability if schema changes).
- [ ] **Locator-quality pre-check** for Gate 4 — lean on `eslint-plugin-playwright`
      (+ the locator policy in `docs/review-gates.md`) to auto-flag brittle
      selectors _before_ the human reviews, so Gate 4 focuses on business logic.
  - [ ] Add a lint rule/config or a small check script; surface findings in CI
        (informational) and/or the runner (PFI-2).

**Definition of Done:**

- [ ] Gate 3 shows diff-aware coverage; Gate 4 sees selector hygiene pre-flagged.
- [ ] The human still decides both gates (assist, never approve — `CLAUDE.md` §3.5).
- [ ] `evaluate` stays green after any prompt change.

---

## PFI-6 — "When to use" + à-la-carte docs (pull forward anytime)

Cheap, high-leverage, no dependency on the others. Prevents misapplication and
coworker resentment.

- [ ] Create `docs/when-to-use-this.md` — honest fit / don't-fit guide:
  - [ ] Strong fits (discovery/test-design on important features; portfolio;
        team standard; greenfield).
  - [ ] Poor fits (routine tickets; foreign stacks; expecting autonomy) — and
        what to do instead (lite mode, borrow the ideas).
  - [ ] A "which `track` for this story?" decision aid (ties to PFI-1).
- [ ] Create à-la-carte one-pagers (borrow the ideas without the full repo):
  - [ ] Automation Decision Model (standalone).
  - [ ] Healer Green/Yellow/Red rule (standalone).
  - [ ] The four-gate checklist (standalone).
- [ ] Reframe gates as _help, not bureaucracy_ in `docs/review-gates.md` wording.

**Definition of Done:**

- [ ] `docs/when-to-use-this.md` exists and is honest about limits.
- [ ] The three à-la-carte one-pagers are adoptable on their own.
- [ ] Doc-only; no code change.

---

## Completion criteria (this plan)

- [ ] `track` mode exists; lite path is light and legitimate (PFI-1).
- [ ] A thin gated runner reduces manual step-driving without autonomy (PFI-2).
- [ ] Story source + CI are pluggable; a second of each works (PFI-3).
- [ ] Execution is pluggable; existing runners unchanged, one new path proven (PFI-4).
- [ ] Gate 3/4 review is sharper; the human still decides (PFI-5).
- [ ] An honest "when to use" guide + à-la-carte one-pagers exist (PFI-6).
- [ ] Every change additive; no gate weakened; Gate 4 stays human throughout.
