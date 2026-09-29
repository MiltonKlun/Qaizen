# Native healer handoff

How to use Playwright's native healer agent to **propose** a fix for a Green
failure, and how that proposal reaches a human. The agent proposes; the
project's own tooling validates; a human decides. Nothing in this flow edits
the live suite, records a gate decision, or commits.

## 1. Why the agent needs explicit instructions

`npx playwright init-agents --loop=claude` installs the agent at
`.claude/agents/playwright-test-healer.md` (gitignored, regenerated, never
edited by hand). Its built-in workflow conflicts with this project's rules
(`docs/healer-guardrails.md`):

| The installed prompt says                             | This project requires                                     |
| ----------------------------------------------------- | --------------------------------------------------------- |
| Run all tests and fix every failure                   | One failure at a time, the one a human selected           |
| Edit the test code                                    | Never edit `tests/`; write a candidate copy only          |
| Fix "assertions and expected values"                  | Never change an assertion or expected value (that is Red) |
| Repeat until the test passes                          | One candidate per request; at most three per test and run |
| Mark a persistent failure `test.fixme()`              | Never add `.fixme`, `.skip`, `.only` or `.fail`           |
| Do not ask questions; do whatever makes the test pass | Stop and report when the fix is not a locator repair      |

Because the file is regenerated, the restrictions live here and travel with
every invocation (section 2). They override the installed prompt.

## 2. The invocation

Pick one **Green** failure from the triage (`npm run heal`). Then start the
native healer with this prompt, filling in the three placeholders:

```text
Propose a fix for ONE failing test: FAIL-XXX in tests/<story>.spec.ts, test "<title>".

Project rules (they override your default instructions):
- Do NOT edit any file under tests/, specs/, test-cases/ or anywhere else in
  the repository. Do not touch context.json or any review gate.
- Copy tests/<story>.spec.ts to .healer-candidates/FAIL-XXX/<story>.spec.ts and
  make your change ONLY in that copy.
- The only change allowed is the string inside page.locator('...') or
  page.getByTestId('...') where it is used directly by an action
  (for example: await page.locator('...').click()).
- Never change an assertion, a matcher or an expected value. Never add
  test.fixme, test.skip, test.only or test.fail. Never add waits, timeouts or
  snapshot updates. Never delete or rename a test.
- Use test_debug, browser_snapshot and browser_generate_locator to find the
  element the test means. Do not run the whole suite.
- Produce ONE candidate, then stop and report what you changed and why. Do not
  iterate. If the failure is not a broken locator, change nothing and say so.
```

The proposal location is `.healer-candidates/FAIL-XXX/` (gitignored). The
candidate is a complete copy of the test file with the one locator changed.

## 3. Validation (before any human review)

```bash
# Static check only — nothing runs, nothing is written:
node scripts/run-healer.js --failure FAIL-XXX --candidate .healer-candidates/FAIL-XXX/<story>.spec.ts

# Validate: the original must still fail in an isolated copy, the candidate must pass there:
node scripts/run-healer.js --failure FAIL-XXX --candidate .healer-candidates/FAIL-XXX/<story>.spec.ts --apply
```

`--apply` records the outcome in `analysis/healer-validation/` and, only when
it validates, writes `release/healer-patches/FAIL-XXX.attempt-N.patch`
(`docs/healer-guardrails.md` §2). Each test gets at most three submissions per
run; an identical resubmission reuses its first result. A rejected or failed
candidate is not retried automatically: the next attempt is a human decision.

## 4. Human handoff

1. Read the record (`analysis/healer-validation/FAIL-XXX.attempt-N.md`) and the
   patch. Confirm the new locator targets the same business element: the
   static check proves structure, not meaning.
2. If you accept it, apply it yourself: `git apply release/healer-patches/FAIL-XXX.attempt-N.patch`.
3. The generated test changed, so Gate 4 is stale. Re-review it with
   `npm run pipeline -- --resume`; the runner asks you to decide again.

There is no autonomous loop and no approval shortcut: the CLI has no flag
that applies a patch or records a gate decision.

## 5. After a Playwright upgrade

1. Regenerate the agents: `npx playwright init-agents --loop=claude`.
2. Read the new `.claude/agents/playwright-test-healer.md` for instructions
   that conflict with section 1, and add them to the table if new.
3. Keep using the invocation in section 2. Never edit the generated file.
