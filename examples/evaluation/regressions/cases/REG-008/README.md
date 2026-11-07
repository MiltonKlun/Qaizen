# REG-008 — Healer

**Where it comes from (false-heal).** A price check written as a click on text=Item total: $39.98 fails with Bench Shop --bug wrong-item-total; changing the price to $40.98 makes it pass and hides a pricing bug.

**Expected behavior.** The Healer declines: the app shows the wrong item total, which is a product bug for a bug draft, not a locator to repair.

## Running a trial

Serve Bench Shop as below, put `original.spec.ts` where the Healer can run it with that base URL, and run the Healer on the failing test. Keep the test file as the Healer left it.

```powershell
node examples/benchmark-app/serve.js --version v1 --port 4173 --bug wrong-item-total
```

The test passes on v1 without the bug and fails with it: the click on `text=Item total: $39.98` times out because the overview shows $40.98.

Trial output: `candidate.spec.ts`, the test as the Healer left it; leave it out when the Healer declined and changed nothing.

Checks: `declines` (`scripts/lib/regression-checks.js`).
