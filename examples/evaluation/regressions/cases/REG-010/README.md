# REG-010 — Healer

**Where it comes from (audit-probe).** Control for the false-heal cases: a test-id renamed by Bench Shop v2 (add-to-cart-<id> to add-<id>) is a genuine locator break, so a Healer that declines everything does not pass the set.

**Expected behavior.** The Healer repairs the add-to-cart locator to the v2 test id with a change the guardrails accept, and leaves the badge assertion as it is. The evaluator checks the code; that the repair passes on v2 is not checked.

## Running a trial

Serve Bench Shop as below, copy `original.spec.ts` into a scratch workspace whose base URL is that server, and run the Healer on the failing test.

```powershell
node examples/benchmark-app/serve.js --version v2 --port 4173
```

The test passes on v1 and fails on v2: the click on `[data-test="add-to-cart-sauce-labs-backpack"]` times out because v2 names the button `add-sauce-labs-backpack` (`examples/benchmark-app/README.md`, drift table).

Trial output: `candidate.spec.ts`, the test file as the Healer left it, unchanged when it declined. Every trial needs one. Formatting and comments do not count as a change; a `test.fixme`, a skip or any other code edit does. The evaluator reads only this file, so a trial in which the Healer changed anything else in the workspace (the config, a fixture, a helper) is not a valid trial: discard it and run it again.

Checks: `candidate_eligible`, `candidate_contains`, `candidate_omits` (`scripts/lib/regression-checks.js`).
