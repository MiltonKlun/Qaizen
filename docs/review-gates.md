# Review Gates

> **Status:** Phase 1 baseline. The four gates run as boolean flags in
> `context.json.review_gates`. Phase 1.5 adds parallel API-branch
> counterparts of Gates 3 and 4 (the `'` gates below). Phase 2 (TG6)
> extends each gate to an optional richer
> `{ status, reviewer, reviewed_at, notes }` object via `oneOf`; the
> boolean form remains valid. Phase 2 (TG7) adds the optional
> `qa_scope_approved` gate that consolidates Gates 1 and 2. Phase 1
> sticks to the booleans.

The pipeline has four hard checkpoints between agents. Each one is a
**human review**, with explicit criteria. A gate that has not been
approved blocks the next stage; the orchestrator does not advance.

**Gate 4 is permanently human.** That is a non-negotiable rule, set in
the project `README.md` section 9 and enforced in every phase plan.

---

## The four gates

| #   | Name                              | Approved after                          | Blocks                                               |
| --- | --------------------------------- | --------------------------------------- | ---------------------------------------------------- |
| 1   | Requirement Interpretation        | Analyst writes `context.json`           | Test Designer (`planning-tests` + `designing-cases`) |
| 2   | Test Scope Approval               | Test Designer writes test cases + brief | Playwright Planner Native Agent + API Agent (P1.5)   |
| 3   | Specs Review                      | Playwright Planner writes the spec      | Playwright Generator Native Agent                    |
| 3'  | (Phase 1.5+) Collection Review    | API Agent writes the Postman collection | Newman execution                                     |
| 4   | Code Review **(PERMANENT)**       | Playwright Generator writes the test    | Test execution                                       |
| 4'  | (Phase 1.5+) API Assertion Review | API Agent finalizes assertions          | Newman execution                                     |

The `'` (prime) gates are the API-branch equivalents — they run in
parallel with the E2E-branch gates when the story has both
`automate_e2e` and `automate_api` test cases.

---

## Gate state in `context.json`

```jsonc
"review_gates": {
  "requirements_reviewed": false,
  "test_scope_reviewed": false,
  "specs_reviewed": false,
  "code_reviewed": false
}
```

All four start as `false` when the Analyst initializes `context.json`.
Each becomes `true` only after a human signs off per the criteria below.

After each transition, re-validate `context.json` against the schema.
The pipeline orchestrator (in Phase 1, this is the human operator
following `phase1-foundation-e2e.md` Task Group 13) checks the relevant
flag before invoking the next agent.

**Phase 2 enhancement (TG6):** any gate's value may also be an object
`{ status: boolean, reviewer: string, reviewed_at: ISO_DATE, notes: string }`.
The boolean form continues to validate (it's a `oneOf` —
`gateValue` in `schemas/context.schema.json`). Phase 1 uses booleans
only; Phase 2 may use either, per gate, in the same file (a context can
mix forms — e.g. audited objects for Gates 1–3 and a bare boolean for
Gate 4).

**Reading a gate (binding for agents and scripts):** a gate is
_passed_ when its value is the boolean `true` **or** an object whose
`status` is `true`. Anything else (false, `{ status: false }`, absent)
is _not passed_. Agents that gate on `code_reviewed` /
`requirements_reviewed` etc. apply exactly this rule — see the
preconditions in `agents/test-designer.md`, `agents/failure-classifier.md`,
and `agents/reporter.md`.

**Who writes the audit fields:** the agent never self-approves a gate
(CLAUDE.md §3.5). The human approves; when they hand the agent a
reviewer name / reason ("approved by alice, AC clarified"), the agent
records them in the object form instead of just flipping the boolean.
Gate 4 stays human permanently regardless of form.

**Migration path (boolean → object).** Migrating is _optional_ — old
boolean contexts stay valid forever. If you want the audit slots
present (to fill `reviewer` / `notes` later), run the idempotent
migration:

```
node scripts/migrate-context-v1-to-v2.js            # dry-run (default)
node scripts/migrate-context-v1-to-v2.js --apply    # wrap booleans into objects
```

It wraps each boolean `b` into `{ status: b, reviewer: null,
reviewed_at: null, notes: null }` and leaves gates already in object
form untouched, so running it twice is a no-op. See
`examples/expected/login-success-audited.expected-context.json` for a
context using the object form (and a mixed boolean) that validates
against the schema.

---

## Optional consolidation of Gates 1 and 2 (Phase 2 TG7)

> **Optional, opt-in, and reversible.** Most teams keep the four gates
> separate. Consolidation is an efficiency lever, not a default — turn
> it on only after the evidence below, and never for Gate 4.

After enough runs, a team may notice Gate 1 (Requirement
Interpretation) and Gate 2 (Test Scope Approval) are _always approved
together_ — the same reviewer signs both in the same sitting, with no
case where requirements were fine but scope was wrong (or vice versa).
When that pattern is real, the schema offers an **optional**
`review_gates.qa_scope_approved` field that records a single combined
QA-scope sign-off in place of the two separate ones.

`qa_scope_approved` uses the same `gateValue` shape as every other gate
(boolean `true`, or `{ status, reviewer, reviewed_at, notes }`), and is
_passed_ by the same rule (boolean `true` or object `status: true`).

### When it's worth consolidating

- [ ] **10+ runs** have gone through Gates 1 and 2 with **no
      discrepancy** — there was never a run where one passed and the
      other was rejected on its own merits.
- [ ] The **same role** approves both gates in practice.
- [ ] The team explicitly decides the combined sign-off does not lose
      review rigor (the Gate 1 _and_ Gate 2 criteria are still checked —
      they're just recorded as one approval).

If Gates 1 and 2 ever diverge again (a run where requirements were
right but scope was wrong, or the reverse), that's the signal to
**un-consolidate**: stop using `qa_scope_approved` and go back to
approving the two gates separately. Nothing in the schema forces the
consolidation to stick.

### How to consolidate (backward-compatible)

1. Set `review_gates.qa_scope_approved` to your approval (boolean or
   audit object).
2. **Keep `requirements_reviewed` and `test_scope_reviewed` present.**
   They are _deprecated, not removed_ — the schema still requires them,
   and downstream agents still read them. Set both to match the
   consolidated decision (`true` / `{ status: true }`) so a tool that
   only knows the two-gate model still sees the gates as passed.

This is why consolidation is purely additive: a context that uses
`qa_scope_approved` _also_ carries the two underlying gates, so no
agent or script written against the four-gate model breaks. See
`examples/expected/login-success-consolidated.expected-context.json`.

### What never consolidates

- **Gate 3 (Specs Review)** stays separate — it reviews a different
  artifact (the spec) produced by a different agent.
- **Gate 4 (Code Review)** is **NEVER** consolidated into
  `qa_scope_approved` or anything else. It is permanently human and
  permanently its own gate (`README.md` §9, `CLAUDE.md` §3.5). Folding
  it into an earlier approval would defeat the one checkpoint the whole
  system is anchored on.

---

## Gate 1 — Requirement Interpretation

**When it runs:** After the Analyst Agent produces `context.json` (Phase
1 TG13 step 4).

**Inputs the reviewer reads:**

- `context.json` — especially the `story`, `acceptance_criteria`,
  `ambiguities`, and `risks` fields.
- The original `story.md` (Mode A) or the Jira issue (Mode B) for
  comparison.

**Criteria (all must hold):**

- [ ] **AC accuracy** — every acceptance criterion in `context.json`
      matches what the story actually says. No paraphrasing that
      drifts. No silent additions.
- [ ] **Ambiguities explicit** — every part of the story that was
      unclear is listed in `ambiguities` with the right `blocking`
      flag. There are no silent assumptions.
- [ ] **Risks meaningful** — each `RISK-XXX` is a real product /
      business / security risk the team would care about, not a
      rephrasing of the AC. A story with non-trivial behavior should
      not have zero risks.
- [ ] **No invented business rules** — anything in `context.json`
      that isn't traceable to the source story (or to a clearly
      labeled ambiguity) is removed before approval.

**Approver:** the QA engineer driving the slice, or the product owner
when domain detail is in question.

**On approval:**

1. Set `review_gates.requirements_reviewed = true`.
2. Set `status = "in_progress"`.
3. Re-validate `context.json`.
4. Proceed to the Test Designer.

**On rejection:**

1. Do NOT set the flag.
2. Write correction notes (Phase 1: in chat / in a comment on the
   story; Phase 2 audit fields capture them in `notes`).
3. Re-run the Analyst with the corrections.
4. Repeat the gate.

---

## Gate 2 — Test Scope Approval

**When it runs:** After the Test Designer produces
`test-cases/[story-id].json` _and_
`planner-input/[story-id].planner-brief.md` (Phase 1 TG13 step 7).

**Inputs the reviewer reads:**

- `test-cases/[story-id].json`.
- `planner-input/[story-id].planner-brief.md`.
- `context.json` (specifically `risks` and `acceptance_criteria`).

**Criteria (all must hold):**

- [ ] **Risk coverage** — every `RISK-XXX` in `context.json.risks` is
      addressed by at least one TC, or is explicitly accepted without
      a test (with written justification).
- [ ] **Priorities reasonable** — `P0` is reserved for things whose
      failure blocks the release; nothing in `P0` is decorative or
      low-impact. Conversely, no high-severity risk has only `P3` cases.
- [ ] **Automation decisions justified** — every TC has a non-empty
      `automation_decision_reason`. The reasons are real ("API
      validation, no UI behavior to exercise"), not generic ("it's UI"
      or "automated").
- [ ] **Not E2E-heavy** — no more than ~60% of TCs are
      `automate_e2e`. If most TCs are E2E, the Test Designer was
      probably treating E2E as the default; push back.
- [ ] **Low-value cases marked correctly** — duplicates, exploratory
      checks, and obviously-not-worth-automating items are marked
      `manual` or `skip` with a real reason.
- [ ] **Out-of-scope discipline** — the planner brief's "Out-of-scope
      for the Planner" section explicitly excludes pre-existing
      behavior and unrelated flows.

**Approver:** the QA engineer driving the slice. For releases the
product owner co-approves.

**On approval:**

1. Set per-TC `status = "approved"` (or `rejected` for individual
   cases that got dropped; leave `draft` is not valid after Gate 2).
2. Set `review_gates.test_scope_reviewed = true`.
3. Re-validate `context.json` and `test-cases/[story-id].json`.
4. Proceed to the Playwright Planner Native Agent — and, if Phase 1.5
   is active and there are `automate_api` cases, also to the API
   Agent.

**On rejection:**

1. Do NOT set the flag.
2. Write correction notes pointing at specific TCs or risks.
3. Re-run the Test Designer (and `planning-tests` /
   `designing-cases` skills) with the corrections.
4. If the rejection traces to an upstream problem with the story
   (e.g. a hidden AC), this is also a Gate 1 re-open — record an
   entry in `context.json.ambiguities` and re-run the Analyst.

---

## Gate 3 — Specs Review (E2E)

**When it runs:** After the Playwright Planner Native Agent produces
`specs/[story-id].md` (Phase 1 TG13 step 10).

**Inputs the reviewer reads:**

- `specs/[story-id].md`.
- `planner-input/[story-id].planner-brief.md` (for "is this what we
  asked for?").
- `test-cases/[story-id].json` (the `automate_e2e` subset).

**Criteria (all must hold):**

- [ ] **Matches approved scope** — every spec scenario maps to one or
      more TCs that were approved at Gate 2. No "while I was in
      there..." additions.
- [ ] **Negative cases present** — happy-path-only specs are a Gate 3
      rejection. The reviewer checks that meaningful negative inputs
      and boundaries are covered.
- [ ] **Expected outcomes are meaningful** — assertions describe
      business behavior, not implementation detail
      ("Page should show the user's name", not "the div with class
      `.user-name` should be present").
- [ ] **No unrelated flows** — the spec does not navigate into parts
      of the app the brief explicitly marked out-of-scope.
- [ ] **Traceability preserved** — each spec scenario references its
      `TC-XXX` in a comment or metadata block.

**Approver:** the QA engineer driving the slice. In Phase 3 the
`agents/spec-reviewer.md` agent assists by producing a checklist
JSON; the human still decides. The assistance does not change the
approval bar.

**On approval:**

1. Set `review_gates.specs_reviewed = true`.
2. Re-validate `context.json`.
3. Proceed to the Playwright Generator Native Agent.

**On rejection:**

1. Do NOT set the flag.
2. Update `planner-input/[story-id].planner-brief.md` with the
   correction (the brief is the Planner's instruction set; correcting
   in chat is fragile).
3. Re-run the Playwright Planner.
4. Repeat the gate.

### Gate 3' — Collection Review (Phase 1.5+)

The API-branch equivalent of Gate 3. Runs in parallel with Gate 3 when
a story has `automate_api` cases.

**When it runs:** After the API Agent produces
`api-tests/collections/[story-id].postman_collection.json` and the
matching environment (Phase 1.5 TG9, steps 9'–10').

**Inputs the reviewer reads:**

- `api-tests/collections/[story-id].postman_collection.json`.
- `api-tests/environments/[story-id].postman_environment.json`.
- `test-cases/[story-id].json` (the `automate_api` subset).
- `context.json` (risks + acceptance_criteria).

**Criteria (all must hold):**

- [ ] **Endpoints, methods, payloads match the AC.** Each request's
      method + path + body corresponds to a real `automate_api` TC and
      to what the acceptance criterion describes.
- [ ] **Endpoint shapes were verified, not invented.** The API Agent
      either used an OpenAPI spec or called the endpoint via the
      Postman MCP. Assertions that look guessed (a response shape no
      one observed) are a rejection.
- [ ] **Auth is configured via environment variables.** Any
      authentication uses `{{variables}}` sourced from the environment,
      never inline.
- [ ] **No hardcoded credentials or base URL anywhere.** The base URL
      is `{{base_url}}`; secrets are environment variables, never
      literal values in the committed collection.
- [ ] **Assertions cover happy path + meaningful negative cases.** A
      collection that only tests the 200 path and ignores the
      documented failure modes (400 on missing field, 403 on wrong
      role) is incomplete.
- [ ] **Traceability preserved.** The collection name carries `COL-XXX`;
      each request name + description references its `REQ-XXX` and the
      originating `TC-XXX`.

**Approver:** the QA engineer driving the slice.

**On approval:** record the approval (see Tracking below) and proceed to
schema validation (step 12') then Gate 4'.

**On rejection:** re-run the API Agent with corrections (e.g. "verify
the /register failure shape", "move the token to the environment"). Do
not weaken assertions to pass.

**Tracking:** stored as a boolean in `context.json.review_gates`
alongside the E2E gates. The recommended key is `collection_reviewed`.
Adding it to `schemas/context.schema.json` is a schema change and
follows the Architecture Stability Rule (schema + agent prompts + docs +
examples in one PR). Until the key is added, the human confirms Gate 3'
passed for the run before execution; the E2E `specs_reviewed` boolean is
**not** reused for the API branch — the two branches are reviewed
independently.

---

## Gate 4 — Code Review **(PERMANENTLY HUMAN)**

**When it runs:** After the Playwright Generator Native Agent
produces `tests/[story-id].spec.ts` (Phase 1 TG13 step 13).

**Inputs the reviewer reads:**

- `tests/[story-id].spec.ts`.
- `specs/[story-id].md` (to compare intent vs realization).
- `test-cases/[story-id].json` (for the `expected_results` to
  cross-check assertions).

**Criteria (all must hold):**

- [ ] **Locators stable and robust** — see the locator-selection
      policy below. The agent must pick the **most robust** locator
      for each element, not the first semantic match. CSS / XPath
      locators that depend on DOM structure carrying no business
      meaning (e.g. nth-child indices, generated class hashes) are
      still rejections.
- [ ] **Assertions test correct business behavior** — what is checked
      matches what the AC says, not "whatever happened to be on the
      page during exploration".
- [ ] **No skipped or weakened tests** — no `.skip`, no `.fixme`, no
      assertion that was loosened (`expect(x).toBeTruthy()` instead
      of `toEqual(expected)`). Skipping without explicit human
      approval is a Gate 4 rejection.
- [ ] **No hard waits without justification** — `page.waitForTimeout()`
      and equivalents need a comment explaining why a deterministic
      wait wouldn't work. Default answer is "rewrite with a
      deterministic wait".
- [ ] **Code readable and maintainable** — a future reader can tell
      what this test exercises without re-reading the spec.
- [ ] **Tests cover the approved scope** — every approved
      `automate_e2e` TC has a corresponding `test(...)` call.

**Approver:** a human engineer. This is the gate that anchors the
entire system. Never automate it. Future phases that add Spec
Reviewer assistance, controlled Healer patches, dual-judge frameworks,
etc. all leave Gate 4 human.

**On approval:**

1. Set `review_gates.code_reviewed = true`.
2. Re-validate `context.json`.
3. Proceed to `npm run test`.

**On rejection:**

1. Do NOT set the flag.
2. Either re-run the Generator with corrections, or edit the test
   manually — Gate 4 is the only gate where direct human edits to the
   generated artifact are normal.
3. Repeat the gate.

### Gate 4' — API Assertion Review (Phase 1.5+) **(PERMANENTLY HUMAN)**

The API-branch equivalent of Gate 4. Like Gate 4, this is permanently
human — it is the assertion-level review that decides whether the API
tests check the right business behaviour.

**When it runs:** After Gate 3' passes and the collection validates
against the schema (Phase 1.5 TG9, step 13').

**Inputs the reviewer reads:**

- The `event` → `script.exec` assertions in
  `api-tests/collections/[story-id].postman_collection.json`.
- `test-cases/[story-id].json` (for the `expected_results` to
  cross-check each assertion).

**Criteria (all must hold):**

- [ ] **Assertions test correct business behaviour** — each
      `pm.test(...)` checks what the AC / TC `expected_results` says,
      not just "the request didn't error".
- [ ] **Expected status codes are right** — the asserted status matches
      the TC (201 for a create, 400 for a missing field, 403 for a
      forbidden role), not a lazy `2xx`.
- [ ] **Response-shape validations cover business-critical fields** —
      the fields the AC cares about (an `id` on create, an `error`
      message on rejection) are asserted, not just the envelope.
- [ ] **No assertion was loosened to make the test pass** — no
      assertion deleted, commented out, or weakened (e.g. asserting a
      field merely "exists" when the TC specifies its value).
- [ ] **Traceability in the assertions** — each `pm.test` name
      references its `TC-XXX` so a Newman failure maps back cleanly.

**Approver:** a human engineer. Permanent — never automated, exactly
like Gate 4.

**On approval:** record the approval (see Tracking) and proceed to
execution (`npm run test:api`).

**On rejection:** re-run the API Agent, or edit the collection's
assertions manually (Gate 4' is, like Gate 4, a place where direct human
edits to the generated artifact are normal). Repeat the gate.

**Tracking:** stored as a boolean in `context.json.review_gates`
alongside the E2E gates, independent of `code_reviewed` so the two
branches are tracked separately. The recommended key is
`api_assertions_reviewed`. Adding it to `schemas/context.schema.json`
follows the Architecture Stability Rule. Until then the human confirms
Gate 4' passed for the run before `npm run test:api`.

---

## Locator selection policy (Gate 3 + Gate 4)

> **Pick the most robust locator for each element, not the first
> one that happens to be semantic.**

This project does NOT prescribe a fixed "always `getByRole`" rule.
Different elements on the same page have different best answers,
and the Planner / Generator / human reviewer is expected to choose
deliberately.

### Robustness ranking

Evaluate each candidate locator against three properties, in order:

1. **Survives cosmetic changes** — class renames, CSS refactors,
   minor DOM reordering, copy tweaks, theming.
2. **Uniquely identifies the intended element** without
   `.first()` / `.nth(N)` and without relying on text the marketing
   team might change.
3. **Carries business meaning a human reviewer can read** — the
   reviewer should be able to look at the locator and know which
   real-world thing on the page is being targeted.

Locators that satisfy all three are robust. Locators that satisfy
only one are brittle and rejected.

### Default preference order (use unless a more robust option exists)

| Preference | Locator family                                                                                                                    | Why                                                                                                                                                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1          | **Stable test hooks**: `[data-test='...']`, `[data-testid='...']`, `id='...'` placed deliberately by developers as test contracts | These are the most robust option **when present and used as documented contracts**. A `data-test` attribute named by the dev team for testing means cosmetic refactors won't touch it. Always prefer over `getByRole` if such an attribute exists and is unique. |
| 2          | **Semantic roles + accessible names**: `getByRole('button', { name: 'Login' })`, `getByLabel('Email')`                            | These survive class renames and translate well to accessibility tests. Use when no stable test hook exists.                                                                                                                                                      |
| 3          | **Stable text**: `getByText('Add to cart')` for short, business-critical, non-marketing copy                                      | OK when text is unlikely to change and uniquely identifies the element. Rejected when text is marketing copy ("Try it free for 30 days!") or non-unique.                                                                                                         |
| 4          | **Structural CSS**                                                                                                                | Last resort, only with a non-obvious justification in a comment. Anything depending on `nth-child`, generated class hashes (`._abc123`), or DOM position is rejected outright.                                                                                   |

### How the Planner and Generator should decide

When the Planner is exploring the live app via the
`playwright-test` MCP and identifying locators for the spec:

1. For each interactive element, list **all** plausible candidate
   locators: `data-test` attributes from the DOM, accessible-name
   role queries, label associations, text content.
2. Rank them by the three properties above.
3. Pick the most robust. Note the runner-up in a comment if it's
   close enough that the human reviewer might want to know.
4. Never default to "the first semantic match" if a more robust
   stable test hook exists on the same element.

The Generator inherits the spec's locator choices and should NOT
silently downgrade them. If a locator in the spec doesn't work, the
Generator stops and reports — it doesn't substitute a weaker one.

### Examples (small, concrete)

**Good — stable test hook wins over semantic role.**
The Login button on Saucedemo has `[data-test='login-button']` AND
matches `getByRole('button', { name: 'Login' })`. Both are
acceptable; the `data-test` attribute is the more robust choice
because the dev team placed it specifically as a test contract.
A Login button is rarely renamed, so in this specific case the
difference is small — but in general, ranking `data-test` ahead of
role-based locators is the right default.

**Good — semantic role wins because no stable hook exists.**
The Saucedemo "Products" heading on the inventory page has a
`[data-test='title']` attribute but renders as a generic element
without a heading role. `getByText('Products')` is fragile if the
page later contains the word "Products" elsewhere; the
`[data-test='title']` selector is the right choice here, despite
not being a semantic-role locator.

**Bad — `.first()` masking a non-unique locator.**
`getByRole('link', { name: 'Sauce Labs Backpack' }).first()` looks
fine until the Backpack appears twice on a future page. If a
test hook like `[data-test='inventory-item-backpack']` exists,
prefer it. If not, the test should be designed so the locator is
naturally unique (e.g. scope to a specific list container first).

**Bad — class name with no business meaning.**
`.css-1a2b3c4d` from a CSS-in-JS framework is a generated hash;
it survives nothing. Reject.

### What this is NOT

- Not a license to litter `[data-test='...']` everywhere. The
  attribute is robust only when it's a deliberate test contract,
  not a sprinkle.
- Not an excuse to ignore accessibility. If a button has no
  accessible name AND no test hook, the test should fail authoring
  and the team should add either (preferably both) — the test
  shouldn't paper over a real a11y gap with a CSS selector.

---

## What never gets automated

- **Gate 4** — full code review by a human. Permanent.
- **Approval after a Red failure** — see
  `docs/healer-guardrails.md`. Red failures only produce bug drafts;
  fixing them is always a human decision.
- **Real Jira / TestLink writes without `--apply`** — see Phase 2 plan.
  Bug promotion and TestLink sync are explicit-flag operations.

---

## What rejection looks like

In Phase 1, a rejection is informal: the reviewer says no, the agent
re-runs the relevant step. From Phase 2 onward, the `reviewer` and
`notes` audit fields let the team see who rejected what and why,
without losing it to chat history.

Rejections at any gate may cascade upstream:

- A Gate 4 rejection because an assertion is wrong → likely a Gate 2
  problem (the TC's `expected_results` were off). Fix at Gate 2 and
  re-flow.
- A Gate 3 rejection because the Planner explored the wrong flow →
  Gate 2's planner brief was vague. Fix the brief, re-run Planner.

The cost of catching a problem at Gate 4 that was really a Gate 1 or
Gate 2 problem is the entire downstream chain getting re-run. The
gates exist precisely to make catching it earlier cheaper than
catching it later.

---

## References

- `CLAUDE.md` section 3.5 — gates as an operating principle.
- `README.md` section 1.x and section 9 — Gate 4 permanence.
- `docs/pipeline-architecture.md` — where each gate sits in the flow.
- `docs/healer-guardrails.md` — Green/Yellow/Red and what auto-fix
  is allowed (never weakens the gates).
- `phase1-foundation-e2e.md` TG13 — the steps that run each Phase 1
  gate.
- `phase2-integrations.md` TG6 — the Phase 2 audit-field extension.
