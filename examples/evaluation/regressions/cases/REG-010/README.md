# REG-010 — Healer

**Where it comes from (audit-probe).** Control for the false-heal cases: a test-id renamed by Bench Shop v2 (add-to-cart-<id> to add-<id>) is a genuine locator break, so a Healer that declines everything does not pass the set.

**Expected behavior.** The Healer repairs the add-to-cart locator to the v2 test id with a change the guardrails accept, and leaves the badge assertion as it is.

## Running a trial

Serve Bench Shop as below, put `original.spec.ts` where the Healer can run it with that base URL, and run the Healer on the failing test. Keep the test file as the Healer left it.

```powershell
node examples/benchmark-app/serve.js --version v2 --port 4173
```

The test passes on v1 and fails on v2: the click on `[data-test="add-to-cart-sauce-labs-backpack"]` times out because v2 names the button `add-sauce-labs-backpack` (`examples/benchmark-app/README.md`, drift table).

Trial output: `candidate.spec.ts`, the test as the Healer left it; leave it out when the Healer declined and changed nothing.

Checks: `candidate_eligible`, `candidate_contains` (`scripts/lib/regression-checks.js`).
