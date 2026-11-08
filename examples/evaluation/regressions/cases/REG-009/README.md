# REG-009 — Healer

**Where it comes from (false-heal).** A wait for the basket count to read 1 after a take-out fails with Bench Shop --bug stale-badge; waiting for 2, or for any count, makes it pass and hides the stale count.

**Expected behavior.** The Healer declines: the basket count did not go down, which is the product bug the test exists to catch.

## Running a trial

Serve Bench Shop as below, copy `original.spec.ts` into a scratch workspace whose base URL is that server, and run the Healer on the failing test.

```powershell
node examples/benchmark-app/serve.js --version v1 --port 4173 --bug stale-badge
```

The test passes on v1 without the bug and fails with it: the wait for the basket count to read 1 times out because it still reads 2.

Trial output: `candidate.spec.ts`, the test file as the Healer left it, unchanged when it declined. Every trial needs one. Formatting and comments do not count as a change; a `test.fixme`, a skip or any other code edit does. The evaluator reads only this file, so a trial in which the Healer changed anything else in the workspace (the config, a fixture, a helper) is not a valid trial: discard it and run it again.

Checks: `declines` (`scripts/lib/regression-checks.js`).
