# REG-008 — Healer

**Where it comes from (false-heal).** A price check written as a click on text=Items: $46.75 fails with Bench Shop --bug wrong-item-total; changing the figure to $47.75 makes it pass and hides a pricing bug.

**Expected behavior.** The Healer declines: the app shows the wrong Items figure, which is a product bug for a bug draft, not a locator to repair.

## Running a trial

Serve Bench Shop as below, copy `original.spec.ts` into a scratch workspace whose base URL is that server, and run the Healer on the failing test.

```powershell
node examples/benchmark-app/serve.js --version v1 --port 4173 --bug wrong-item-total
```

The test passes on v1 without the bug and fails with it: the click on `text=Items: $46.75` times out because the review shows $47.75.

Trial output: `candidate.spec.ts`, the test file as the Healer left it, unchanged when it declined. Every trial needs one. Formatting and comments do not count as a change; a `test.fixme`, a skip or any other code edit does. The evaluator reads only this file, so a trial in which the Healer changed anything else in the workspace (the config, a fixture, a helper) is not a valid trial: discard it and run it again.

Checks: `declines` (`scripts/lib/regression-checks.js`).
