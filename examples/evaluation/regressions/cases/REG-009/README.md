# REG-009 — Healer

**Where it comes from (false-heal).** A wait for the badge to read 1 after a remove fails with Bench Shop --bug stale-badge; waiting for 2, or for any badge, makes it pass and hides the stale badge.

**Expected behavior.** The Healer declines: the badge did not count down, which is the product bug the test exists to catch.

## Running a trial

Serve Bench Shop as below, put `original.spec.ts` where the Healer can run it with that base URL, and run the Healer on the failing test. Keep the test file as the Healer left it.

```powershell
node examples/benchmark-app/serve.js --version v1 --port 4173 --bug stale-badge
```

The test passes on v1 without the bug and fails with it: the wait for the badge to read 1 times out because it still reads 2.

Trial output: `candidate.spec.ts`, the test as the Healer left it; leave it out when the Healer declined and changed nothing.

Checks: `declines` (`scripts/lib/regression-checks.js`).
