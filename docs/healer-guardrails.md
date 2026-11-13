# Healer Guardrails

> **Status:** enforced in code. `scripts/healer-guardrails.js` checks every
> proposed fix statically, and `scripts/run-healer.js` validates it by
> re-running the failing test in isolation before any patch exists (section
> 2). The Playwright native healer agent only proposes candidates, under the
> restrictions in `docs/native-healer-handoff.md`. The Failure Classifier's
> Green/Yellow/Red decides what may be proposed at all.

This document is the binding rule for what the Healer may and may not do.
It is referenced by `CLAUDE.md` section 3.6.

The Healer's job is to repair failing Playwright tests **as reviewable
patches**. Not direct commits. Not merges. Patches that a human reviews
and applies. The Healer applies only to Playwright
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

### How Green is granted automatically

The rule-based pre-classifier (`scripts/lib/classify-failure.js`) grants
Green in exactly one case: every failed attempt timed out on a locator
**action** the Healer may repair (`locator.click`, `dblclick`, `fill`,
`press`, `pressSequentially`, `check`, `uncheck`, `selectOption`, `hover`,
`setInputFiles`), no assertion failed, and none of the following holds:

- **The operation is not one of those actions.** A timeout on `waitFor`,
  `innerText`, `textContent`, `inputValue`, `isVisible`, `count`,
  `getAttribute`, `page.click` or any other operation may be the very
  outcome the test checks (a confirmation that never appeared). Yellow
  `unknown_needs_human_review`.
- **The element was found but could not be acted on**: the call log says
  the locator resolved, or the element is disabled, not editable, not
  visible, not stable, outside the viewport, or covered by another element.
  That is a behavior or layout change (a disabled Pay button, a new modal),
  not a stale locator. Yellow `unknown_needs_human_review`.
- **The locator finds its element by what the page shows**: a text engine
  (`text=`, `getByText`, `:has-text`, `:text`, a `hasText` filter, XPath
  `text()`), a role name, label, placeholder, alt text or title with a
  number in it (a regular-expression name counts, `\d` included), or any
  value with a currency sign. A missing `text=$29.99` may be a wrong price.
  Yellow `unknown_needs_human_review`.
- **A Red domain is in the test title or in what the locator looks for**
  (each quoted value and regular-expression name on its own, never its
  method names: `getByRole` is not a permission). The title includes the
  spec file's name, so every test in `checkout.spec.ts` is in the pricing
  domain.
- **The test case's risks are high or Red, or cannot be known**: a
  high-severity risk, a risk whose description names a Red domain, a risk
  id `context.json` does not describe, a case missing from the run's test
  cases, a failure traced to no case, or a run whose test-cases file is not
  named or cannot be read.
- **Most of the run failed**: at least three Playwright tests failed or were
  blocked, and they are more than half. A test is its file and title: one
  test failing in three browsers is one. That many at once needs a person to
  see whether the app, the environment or one shared element changed.

The last three are Yellow `locator_or_selector`, with every reason that
applied. The risk and run checks need the run, so they apply when
`scripts/run-failure-classifier.js` classifies; a bare call to the
classifier for one unit cannot know them. Everything else it cannot prove is
Yellow too, including a bare test timeout: one run cannot establish that a
timeout is mere instability rather than a hang, so "wait unstable" and
"timeout stabilization" become Green only when the Failure Classifier Agent
or a human establishes it. The message text is still trusted: test code that
throws its own error worded like an action timeout reads as one, and only
its domain or its risk keeps it from Green.

It reads what the error says **failed**, never keywords. The review found
`expect(locator).toHaveText('$100.00')` against an element showing `$1.00`
classified Green because the message contains "locator". That
is an assertion that observed a wrong business value, so it is **Red**.

### What does NOT qualify as Green, even if it looks similar

- Replacing a brittle selector with one that matches a _different_
  element (even if the test then passes). That's a Yellow at best,
  often Red.
- Adding a `waitForTimeout()` instead of fixing the underlying race.
  Hard waits are explicitly listed as a Gate 4 rejection criterion.
- "Healing" a Green failure by removing the assertion that made it
  fail. That's never a fix. See section 5 — Never Touched List.

### What the static check accepts automatically

Green describes what a human may fix. What `scripts/healer-guardrails.js`
accepts **without** a human deciding the change is much narrower. It parses
the original and the candidate with the TypeScript compiler API and compares
their executable structure, ignoring positions, whitespace and comments. A
candidate is eligible only if the one thing that changed is:

- the static string argument of `page.locator('...')` or
  `page.getByTestId('...')`,
- where `page` is provably the Playwright fixture (destructured as
  `{ page }` in a test or hook callback, never renamed, aliased or
  reassigned),
- and the locator is the receiver of an action in a statement of its own,
  awaited, whose value nothing uses: `await page.locator('...').click();`.
  The actions are `click`, `dblclick`, `fill`, `press`, `pressSequentially`,
  `check`, `uncheck`, `selectOption`, `hover` and `setInputFiles`. The
  statement may sit inside a loop or a condition, but not anywhere inside an
  assertion: any `expect(...)` chain, `expect.soft`, `expect.poll` and the
  callback of `expect(...).toPass()` are assertion context.

Everything else must be identical: imports, tests, groups, hooks, control
flow, every assertion (its target, matcher, modifiers such as `.not`,
expected values and `await`), snapshot targets and every other statement.
A locator whose value can reach a check is **not** eligible: one read with
`innerText`, `textContent`, `inputValue`, `isVisible`, `count`,
`getAttribute`, `waitFor` or any other method outside the list, one stored
in a variable or assigned, one passed to a function, one chained further
(`.first()`, `.locator(...)`), one awaited inside a larger expression
(`Promise.all`, `.catch`, `.then`), and any locator inside an assertion.

The new string of a `page.locator()` repair may not add selector syntax that
widens what it matches, moves it, or picks an element by position: `>>`
chains, `nth=`, positional pseudo-classes (`:nth-*`, `:first-*`, `:last-*`,
`:only-*`), `:is()`, `:where()` and `:not()`, a top-level union (`,` or
`|`), a backslash escape, an unclosed quote or bracket, a selector engine
the original did not use (`text=`, `role=`, `xpath=`, `internal:*`, ...),
XPath (and, where the original was XPath, a new predicate, group or union),
text matching (text engines, a quoted selector, `:has-text()`, `:text()`,
`:text-is()`, `:text-matches()`) on text the original did not use, and a
subject that is the whole page (`body`, `html`, `:root`, `:scope`, `*`,
alone or qualified, and their XPath forms). Pseudo-classes and engines are
matched regardless of case, as Playwright reads them; texts are compared
without quotes or case. Syntax the original already had may stay. A
`getByTestId` string is matched exactly as a test id, so this check does not
apply to it. The list refuses known ways to widen or move a target from
inside the string; it does not prove that the new selector means the same
element (see below).

A locator stays repairable inside a loop, a condition and a `test.step`
callback. It is not repairable inside a function stored under a name (which
could be handed to an assertion elsewhere), inside an assertion reached
through an alias (`const ex = expect`, `expect.configure(...)`, a namespace
import, `expect['poll']`, a destructured `require`), or when the action is
a trial (`click({ trial: true })`), which only checks that the element is
actionable.

Rejected with a reason: added `.skip` / `.fixme` / `.only` / `.fail` (even if
the file already had one), a removed test or hook, dynamic test registration,
a removed traceability id (comments included), code turned into a comment,
and source that does not parse. Role/name selectors (`getByRole`), navigation,
waits and timeouts are still Green for a human to fix, but not eligible for
automatic acceptance in this version.

A clean result means **eligible under static checks; human review still
required**. Equal structure does not prove that a new selector targets the
same business element: an action moved to another element of the same shape
(a click on `checkout` changed to `continue-shopping`) passes this check.
The action-target comparison below (step 5) catches such a swap even when the
test still passes with it; the reviewer reading the patch remains the check
for what it cannot see.

The probe suite, `test/healer-probes.test.js`, holds candidates that keep a
test's structure but change what a check examines, or widen a selector from
inside its string; every one must be refused. Re-run it after every
`npx playwright init-agents` regeneration, because a regenerated healer may
propose patches in shapes the earlier one did not:

```bash
node --test test/healer-probes.test.js test/healer-guardrails.test.js
```

### Classifier action

Document the Green classification in `analysis/failure-analysis.json`.
Take no further action. The human may manually apply a fix; that's a
Gate-4 re-run, not Healer work.

### Healer action

`scripts/run-healer.js` does not write fixes. It **processes** a
candidate that a person or an agent proposes:

```bash
node scripts/run-healer.js --failure FAIL-001 --candidate path/to/fixed.spec.ts          # static check only
node scripts/run-healer.js --failure FAIL-001 --candidate path/to/fixed.spec.ts --apply  # validate
```

1. The current run's context, finalized failure analysis and execution
   ledger identify the live test file and the single failing test. Gate 4
   must be current. API, Yellow and Red failures, an ambiguous test, and a
   candidate that is the live file itself are refused before anything runs.
   Eligibility comes from the rule-based draft as well: a failure the
   finalizing step raised to Green, but which the draft
   (`analysis/failure-analysis.draft.json`) did not call Green, is refused,
   and so is an analysis whose draft is missing, changed or another run's.
   This guards against a silent overwrite, not an adversary: someone who
   deletes the draft and its reference, or rewrites both the draft and its
   digest, is not stopped by it (files in the repository are not
   tamper-proof).
2. The static check above must find the candidate eligible.
3. With `--apply`, the config, the test and everything they import are
   copied into `.healer-workspace/` (gitignored; `.env` and other state
   are never copied). The unchanged original runs there 3 times and must
   fail all 3, at the same place (the same file, line and column). A test
   that passes on some runs is flaky, and one that fails in different places
   is broken in a way a locator does not explain: in both cases a locator
   change would only hide it, so nothing is validated and no attempt is used.
   The refusal is kept in `analysis/healer-validation/FAIL-XXX.inconsistent.md`
   (with the run and the original's digest), and the healer refuses that
   failure for the rest of the run: asking again until the original happens
   to fail 3 of 3 would let a flaky test through. The failure goes to a
   human: reclassify it as `flaky` or `unknown_needs_human_review` in the
   failure analysis, and fix the test or the app by hand. A runner error is
   not kept this way. `QAIZEN_HEALER_TIMEOUT_MS` (default 300000) is the
   time allowed per run, so 3 runs get three times it and 5 runs five times.
4. The **same single test** then runs 5 times with the candidate: one
   project, `--repeat-each 5`, `--retries 0`, no snapshot updates. It must
   execute 5 times and pass every time. Zero tests, a skip, an expected
   failure, another test, or a single failed run do not count.
5. One more run of the candidate, not counted, records what each of its
   actions acts on (`scripts/lib/action-targets.js`), and compares it, action
   by action, with what the repeat check recorded for the test before Gate 4
   (`context.json` `repeat_check.targets`): each element's accessible role,
   accessible name, test id and text, and where it stands among elements
   that look the same. The candidate must act on the same element each
   time, matched by exactly one element: the same role and name and, when
   several share them (three "Add to basket" buttons), the same one of them
   by position or test id; an element with no name is held to its test id,
   or to its text when that text is unique. A renamed test id, or another
   locator for the same element, is fine. The same element (same role and
   test id) whose visible name changed is **Yellow**, not a locator repair:
   it is written as a suggestion note (`FAIL-XXX.yellow-<digest>.md`, with
   the diff), uses no attempt, and a person decides whether the test should
   follow the app; without a test id, a changed name is refused instead.
   Another element, an element with nothing to identify it, or a locator
   matching several, is refused. A recording of a test that failed is
   compared up to the action where it stopped. On a run from before targets
   were recorded the comparison is not made and the record says so; once
   the repeat check records them, a test it did not record (its recording
   failed, it uses no `page` fixture) is refused for a person to review.
6. Only then is `release/healer-patches/FAIL-XXX.attempt-N.patch` written,
   a unified diff proven by applying it to a copy of the original.

Every submission with `--apply` is recorded in
`analysis/healer-validation/FAIL-XXX.attempt-N.json`
(`schemas/healer-validation.schema.json`) as `rejected_static`,
`validation_failed` or `validated`, with digests, the commands and their
results. At most **three** submissions per run, original source and test;
resubmitting an identical candidate reuses its outcome.

The cap travels with the run: each submission is also added to
`context.json` `healer_attempts[]` with its record file's SHA-256, and
`--apply` refuses to start when `context.json` does not validate. An attempt
in either store is used. A record file with no context entry (one written
before the context kept attempts) is added to the context on the next
`--apply`, before another attempt is used, so once recorded, deleting
`analysis/healer-validation/` gives nothing back. Where both stores have an
attempt, the context entry counts; a record that is missing, changed since,
disagrees with its entry, or claims an attempt number the context gives to
another file is reported. An identical resubmission of a `validated`
candidate exits 0 only while its record backs it and its patch is present
with the recorded digest. The runner keeps attempts added while it waited at
a prompt. Only editing both stores together can reset the cap; like the gate
trail, `context.json` is not tamper-proof.

- Never modifies the live test. It writes only its records, its patches and
  `context.json` `healer_attempts[]`.
- Never commits, never merges, never approves: a validated patch still
  needs human review before a human applies it.
- The workspace is a filesystem separation, not a security sandbox: the
  test code runs with your privileges and environment.

To have Playwright's native healer agent propose the candidate, use the
constrained invocation in `docs/native-healer-handoff.md`; its installed
prompt conflicts with these rules.

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

### Classifier action

Document in `analysis/failure-analysis.json` with `severity: yellow`.
No fix attempt.

### Healer action

The Healer writes a **suggestion** — e.g. a patch file plus a
`.suggestion.md` explaining "this is what I would change". It does
NOT apply the change, even in an isolated workspace, and does NOT
re-run the test. The suggestion is for the human to decide on.

---

## 4. Red — bug draft only, NEVER auto-fix

Red failures mean **the test caught a real business problem**, or are
in a category where touching the test would compromise safety.

The domains below are also matched as keywords, in `config/red-domains.json`
(English and Spanish today; one list per locale, all matched on every text).
Text is split into words first: camelCase, kebab-case, snake_case and
punctuation separate words, case is folded and accents are removed, so
`submitPayment`, `pay-now` and `PAGO` match "payment", "pay" and "pago". A
keyword is a word or a phrase of consecutive words, and a trailing `*`
matches any word that starts with it. The failure classifier (§2), the
lite-track floor and the downgrade confirmation all read that one list. A
false positive only adds review; a missing keyword is the risk, so add one
when a story's vocabulary is not there yet.

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

### Classifier action

The Failure Classifier (running `skills/analyzing-logs`) writes
`release/bug-drafts/BUG-XXX.md` for each Red failure. The bug draft
follows the format documented in `skills/analyzing-logs/SKILL.md`
(stable; `scripts/create-jira-bugs.js` parses it).

The Reporter Agent then incorporates the bug draft into
`release/release-report.md`, and if any Red bug drafts exist,
recommends `fail` (any Red failure on a high-severity risk, tracked in
Jira or not) or at best `conditional_pass` (Red failures only on
lower-severity risks) in the report's `release_recommendation`.

### Healer action

None. The Healer **never** runs on a Red failure. It
does not even attempt a patch in an isolated workspace.

### Promotion to Jira

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

- **Maximum 3 fix attempts per test.** Counted from `context.json`
  `healer_attempts[]` and the record files together (§2). After 3
  attempts on the same test, the Healer refuses further candidates and
  writes `FAIL-XXX.exhausted.md`: a human fixes the test, or it becomes a
  Yellow or Red decision. Grinding past 3 attempts has
  historically not produced better fixes — only more questionable ones.
- **Never change an expected value.** If the test expects
  `total === 42` and the app returns `40`, the Healer never edits the
  `42`. That would silently weaken a Gate-2-approved assertion. The
  business expected value comes from `test-cases/[story-id].json`,
  which is owned by the Test Designer and approved at Gate 2.
- **Never delete a test.** Removing a test that fails is the cardinal
  bypass move. The Healer's tools physically refuse to delete a
  `.spec.ts` file (enforced in code).
- **Never add `.skip` or equivalent.** Same reason. A skipped test is
  a deleted test that left a corpse.
- **Never update snapshots without explicit human approval.**
  Snapshot tests are assertions; auto-updating them is the same as
  silently changing what the test asserts. The human approves each
  snapshot update.
- **Every change is a reviewable patch.** The Healer writes
  `release/healer-patches/FAIL-XXX.patch`. It does not modify files
  in the main working tree. It does not commit. It does not push. It
  does not open a PR. A human reviews the patch and decides whether
  to apply it.
- **If confidence is low, mark `unknown_needs_human_review`.** When
  the signals don't point cleanly to one severity, default to the
  cautious side — Yellow at worst, never Green by default. The
  Failure Classifier uses `unknown_needs_human_review` as the
  classification for these and the human takes it from there.

### The Healer never touches API / Newman tests

The Healer applies to **Playwright tests only**. This is a hard,
phase-independent rule:

- Newman / API tests are never auto-fixed, not even for
  the equivalents of Green signals (a sporadic retry-able timeout on an
  API request is documented, never patched).
- The Healer is wired up for Playwright Green failures.
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

Healer action: write a patch replacing
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

Healer action: write a suggestion explaining the new
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
(traces/screenshots), and an empty Jira Issue Key field for later
promotion.
```

---

## 7. What `failure-analysis.json` carries

Per `schemas/failure-analysis.schema.json`, each failure
records both the classification and the severity:

```jsonc
{
  "failure_id": "FAIL-001",
  "test_case_id": "TC-001",
  "playwright_test_id": "PW-001",
  "classification": "product_bug",
  "severity": "red",
  "error_message": "expected 40, got 42",
  "evidence_paths": [
    "reports/test-results/.../trace.zip",
    "reports/test-results/.../test-failed-1.png",
  ],
  "bug_draft_path": "release/bug-drafts/BUG-001.md",
}
```

The `severity` field is what the Healer reads to decide
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
