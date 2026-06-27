# Healer Guardrails

> **Status:** Phase 1 documents the rules. Phase 3 enforces them in code
> (`scripts/run-healer.js`). In Phase 1 the Healer Native Agent
> (`.claude/agents/playwright-test-healer.md`) is scaffolded but **not
> invoked**. The Failure Classifier still marks each failure
> Green/Yellow/Red so the data is ready when Phase 3 wires the Healer
> up.

This document is the binding rule for what the Healer may and may not do.
It is referenced by `CLAUDE.md` section 3.6 and is invoked by every
phase plan.

The Healer's job is to repair failing Playwright tests **as reviewable
patches**. Not direct commits. Not merges. Patches that a human reviews
and applies. Phase 1.5+ confirms the Healer applies only to Playwright
tests — it never touches Newman / API tests.

---

## 1. Three severities

Every failure is independently classified along two axes:

- A **classification** (locator, wait, product bug, etc.) — describes
  what kind of failure it is. See
  `schemas/failure-analysis.schema.json` and the table in
  `skills/analyzing-logs/SKILL.md`.
- A **severity** — Green / Yellow / Red — describes _what the Healer
  is allowed to do about it_.

This document is about the severity dimension.

| Severity   | Healer action                                             | Human required                    |
| ---------- | --------------------------------------------------------- | --------------------------------- |
| **Green**  | Auto-fix as a `.patch` file in `release/healer-patches/`. | Yes — to apply the patch.         |
| **Yellow** | Write a suggestion; do NOT modify the test.               | Yes — to decide whether to apply. |
| **Red**    | Do NOT touch the test. Produce a bug draft only.          | Yes — to triage the bug.          |

The Healer never auto-applies anything. Even Green is "write a patch
the human reviews". The system was built to make rushing impossible.

---

## 2. Green — auto-fix allowed (as a reviewable patch)

Green failures are mechanical drift between the test and the
application that does **not** change what the test asserts about
business behavior.

### What qualifies

- **Locator broken** — the selector no longer matches because the
  HTML changed (renamed CSS class, restructured DOM), but the same
  visible element is still on the same page. Healing replaces the
  selector with a semantically equivalent one (preferring
  `getByRole`, `getByLabel`, `getByText` over CSS).
- **Selector ambiguity** — a selector now matches multiple elements
  because the page added a similar element elsewhere. Healing
  narrows the selector to the right one.
- **Wait unstable** — the test was implicitly racing the page; an
  explicit deterministic wait fixes it. (Playwright's web-first
  assertions already wait, so this typically means "the test was
  using an outdated pattern".)
- **Timeout stabilization** — a flaky test passes consistently
  after raising the default timeout for a single explicit action
  (e.g. a slow login). Acceptable when the AC does not constrain
  performance.
- **Minor selector refactor that preserves business meaning** — for
  example, replacing a brittle CSS selector with `getByRole('button',
{ name: /Save/i })` is Green if both target the same logical
  control.

### What does NOT qualify as Green, even if it looks similar

- Replacing a brittle selector with one that matches a _different_
  element (even if the test then passes). That's a Yellow at best,
  often Red.
- Adding a `waitForTimeout()` instead of fixing the underlying race.
  Hard waits are explicitly listed as a Gate 4 rejection criterion.
- "Healing" a Green failure by removing the assertion that made it
  fail. That's never a fix. See section 5 — Never Touched List.

### Phase 1 action

Document the Green classification in `analysis/failure-analysis.json`.
Take no further action. The human may manually apply a fix; that's a
Gate-4 re-run, not Healer work.

### Phase 3 action

`scripts/run-healer.js` generates a candidate patch for the affected
file, applies it in an **isolated workspace** (a temp branch or a
worktree — never the main checkout), re-runs the affected test, and:

- If the patch passes, writes
  `release/healer-patches/FAIL-XXX.patch` plus
  `analysis/healer-validation/FAIL-XXX.md` documenting before/after
  for the human reviewer.
- If the patch fails, increments the attempt counter (capped at 3
  attempts per test) and tries a different approach.
- Never modifies the main working tree.
- Never commits.
- Never merges.

---

## 3. Yellow — suggestion only, requires human approval

Yellow failures are signs the application changed in a way that may
still be valid behavior. The Healer cannot tell from the failure
alone whether the new behavior is intended.

### What qualifies

- **UI structural change** — a new modal appeared between two steps,
  a wizard was reorganized, a page was split or merged.
- **Layout / flow reorganization** — the order of steps in a flow
  changed. The same business outcome is reachable, just along a
  different path.
- **New modal / new page / changed navigation** — the test's
  navigation no longer matches reality, but the destination still
  exists.
- **App behavior changed but possibly still valid** — e.g. a search
  now returns 10 results instead of 25; this may be a deliberate
  product change (new pagination default) or a regression.

### Phase 1 action

Document in `analysis/failure-analysis.json` with `severity: yellow`.
No fix attempt.

### Phase 3 action

The Healer writes a **suggestion** — e.g. a patch file plus a
`.suggestion.md` explaining "this is what I would change". It does
NOT apply the change, even in an isolated workspace, and does NOT
re-run the test. The suggestion is for the human to decide on.

---

## 4. Red — bug draft only, NEVER auto-fix

Red failures mean **the test caught a real business problem**, or are
in a category where touching the test would compromise safety.

### What qualifies

- **Business logic assertion failed** — the application produced the
  wrong outcome. Total = $42 when it should be $40. Date shown is
  yesterday's. Permission was granted that shouldn't have been.
- **Permission / role behavior** — a user got access they shouldn't
  have, or didn't get access they should have. This is always Red,
  even if a "small selector tweak" would make the test pass.
- **Security validation** — an XSS payload was not sanitized; a
  CSRF token was missing; an input that should reject a script tag
  accepted it.
- **Pricing calculation** — any number that ends up in a customer's
  invoice. Pricing is never auto-fixed.
- **Payment flow** — anywhere money moves. Same rule.
- **Compliance behavior** — audit logs, data retention, consent
  capture. Same rule.
- **Data integrity** — a record that should have been written was
  not, or was written with the wrong value.
- **Any assertion meaning change** — if "fixing" the test would
  require changing what business behavior is asserted, the failure
  is Red. The test was right; the app is wrong.

### Phase 1 action

The Failure Classifier (running `skills/analyzing-logs`) writes
`release/bug-drafts/BUG-XXX.md` for each Red failure. The bug draft
follows the format documented in `skills/analyzing-logs/SKILL.md`
(stable from Phase 1; Phase 2 parses it with
`scripts/create-jira-bugs.js`).

The Reporter Agent then incorporates the bug draft into
`release/release-report.md`, and if any Red bug drafts exist,
recommends `fail` or `conditional_pass` in the report's
`release_recommendation`.

### Phase 3 action

Identical to Phase 1. The Healer **never** runs on a Red failure. It
does not even attempt a patch in an isolated workspace.

### Phase 2 promotion

`scripts/create-jira-bugs.js --apply` promotes Red bug drafts to real
Jira issues. The `--apply` flag is mandatory; the script's default
mode is dry-run (prints what it _would_ do, creates nothing). The
Jira issue's link goes back into the bug draft's `Jira Issue Key`
field. Subsequent runs of the script skip drafts that already have a
key — that's the de-dup safety.

---

## 5. Hard stops (always, all phases)

These rules apply regardless of severity classification. Violating any
of them is a Healer bug that must be fixed before the Healer runs
again.

- **Maximum 3 fix attempts per test.** After 3 attempts on the same
  test, the Healer stops and marks the failure
  `unknown_needs_human_review`. Grinding past 3 attempts has
  historically not produced better fixes — only more questionable ones.
- **Never change an expected value.** If the test expects
  `total === 42` and the app returns `40`, the Healer never edits the
  `42`. That would silently weaken a Gate-2-approved assertion. The
  business expected value comes from `test-cases/[story-id].json`,
  which is owned by the Test Designer and approved at Gate 2.
- **Never delete a test.** Removing a test that fails is the cardinal
  bypass move. The Healer's tools physically refuse to delete a
  `.spec.ts` file (Phase 3 enforces this in code).
- **Never add `.skip` or equivalent.** Same reason. A skipped test is
  a deleted test that left a corpse.
- **Never update snapshots without explicit human approval.**
  Snapshot tests are assertions; auto-updating them is the same as
  silently changing what the test asserts. The human approves each
  snapshot update.
- **Every change is a reviewable patch.** The Healer writes
  `release/healer-patches/FAIL-XXX.patch`. It does not modify files
  in the main working tree. It does not commit. It does not push. It
  does not open a PR that auto-merges. It does open a PR draft in
  Phase 3 if so configured, but the PR is for human review, not for
  auto-merge.
- **If confidence is low, mark `unknown_needs_human_review`.** When
  the signals don't point cleanly to one severity, default to the
  cautious side — Yellow at worst, never Green by default. The
  Failure Classifier uses `unknown_needs_human_review` as the
  classification for these and the human takes it from there.

### The Healer never touches API / Newman tests

The Healer applies to **Playwright tests only**. This is a hard,
phase-independent rule:

- **Phase 1.5:** Newman / API tests are never auto-fixed, not even for
  the equivalents of Green signals (a sporadic retry-able timeout on an
  API request is documented, never patched).
- **Phase 3:** the Healer is wired up for Playwright Green failures.
  It still does **not** touch API tests. Extending the Healer to API
  collections would require a separate, explicit project-owner approval
  and its own guardrail design — it is out of scope for the Healer as
  defined here.
- **All API failures go through the bug-draft path** when they are Red,
  and are documented (no fix, no suggestion that implies a fix) when
  they are Green or Yellow.

Why API tests are excluded: a Postman collection's assertions and a
Newman failure are about a server contract, not a brittle UI locator.
There is no "locator drift" equivalent to safely auto-repair — an API
test that fails almost always means the contract moved (a real change)
or the assertion was wrong (a Test Designer / Gate 2 concern), neither
of which the Healer should resolve on its own.

This rule is enforced by `agents/failure-classifier.md` (which never
recommends a Healer action for `source: "newman"` failures), and
reiterated here.

---

## 6. Examples (small, concrete)

### Example A — Green

```
Test: tests/login.spec.ts
Failure: Timeout waiting for selector "[data-test='login-btn']"

Signals:
  - The button is visible in the screenshot.
  - The button text reads "Log in".
  - HTML inspection shows the button now has class "primary-button"
    and no data-test attribute.

Classification: locator_or_selector
Severity: green

Healer action (Phase 3): write a patch replacing
  page.locator("[data-test='login-btn']")
with
  page.getByRole("button", { name: /Log in/i })
re-run only this test, emit the patch.
```

### Example B — Yellow

```
Test: tests/checkout.spec.ts
Failure: Expected URL "/checkout/payment" but got "/checkout/review"

Signals:
  - The application now has a Review step before Payment.
  - The test navigates through Address → Payment as before.
  - The Review step is new since the last release.

Classification: ui_structural_change
Severity: yellow

Healer action (Phase 3): write a suggestion explaining the new
intermediate step. Do not apply. Human decides whether the new
flow is correct (then the test gets updated) or whether the Review
step was introduced by mistake (then the app gets a bug filed).
```

### Example C — Red

```
Test: tests/checkout.spec.ts
Failure: expect(orderTotal).toEqual(40) — actual 42

Signals:
  - The TC's expected_results says "Total = $40 for a $35 item plus
    $5 shipping with NO tax (state CA buyer, exempt seller)".
  - The application returned 42, which is the value with tax applied.
  - This is a tax-exempt seller; the TC asserts the calculation
    excludes tax.

Classification: product_bug
Severity: red

Healer action: NONE. Bug draft is created at
  release/bug-drafts/BUG-001.md
with links to FAIL-001, TC-XXX, RISK-XXX, evidence paths
(traces/screenshots), and an empty Jira Issue Key field for Phase 2
promotion.
```

---

## 7. What `failure-analysis.json` carries

Per `schemas/failure-analysis.schema.json` (Phase 1 TG7), each failure
records both the classification and the severity:

```jsonc
{
  "failure_id": "FAIL-001",
  "test_case_id": "TC-001",
  "playwright_test_id": "PW-001",
  "classification": "product_bug",
  "severity": "red",
  "error_message": "expected 40, got 42",
  "evidence_paths": ["reports/traces/...zip", "reports/screenshots/..."],
  "bug_draft_path": "release/bug-drafts/BUG-001.md",
}
```

The `severity` field is what the Phase 3 Healer reads to decide
whether to act, suggest, or stay away.

---

## 8. Anti-patterns to refuse

If a request comes in to do any of these — stop and report. They
violate the spirit of the guardrails even when they don't violate the
letter.

- "Just bump the timeout to 60 seconds across the suite" — not a Green
  fix. Slow tests are usually a signal, not a wait problem.
- "Have the Healer disable this snapshot test until we look at it" —
  no skip, no delete.
- "Let the Healer auto-apply Green patches in CI without a PR" — every
  change is a reviewable patch. CI may run the Healer; CI does not
  merge.
- "Promote this Red bug to Jira automatically as part of every run" —
  `--apply` is human-only.
- "Treat permission failures as Yellow because the test might be
  wrong" — permission is always Red. If the test is wrong, that's a
  Gate 2 problem, not a Healer problem.

---

## 9. References

- `CLAUDE.md` section 3.6 — guardrails as an operating principle.
- `README.md` — Green/Yellow/Red overview.
- `schemas/failure-analysis.schema.json` — the binding schema for
  `severity` and `classification`.
- `skills/analyzing-logs/SKILL.md` — how the Failure Classifier
  assigns severity.
- `docs/review-gates.md` — Gate 4 permanence and why the Healer
  cannot replace human review.
- `scripts/healer-guardrails.js` — the code that enforces these rules.
- `.claude/agents/playwright-test-healer.md` — the Native Agent
  definition.
