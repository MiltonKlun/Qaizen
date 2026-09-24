# Execution normalization

How raw Playwright and Newman reports become one execution ledger, and why the
raw reports are never counted directly.

Contract: `schemas/execution-ledger.schema.json` (task group 2.2a).
Adapters: `scripts/lib/execution-results.js`, assembly in
`scripts/lib/build-ledger.js`, CLI in `scripts/normalize-results.js`
(task group 3.1).

---

## Why a normalizer exists

The two runners disagree about what a "test" is, and each one's own summary
answers a different question than "did we verify the approved scope?". Three
failures were found in live code before this module existed:

| Finding | What the raw report does                                                                     | What went wrong                                                                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **B2**  | Playwright reports `timedOut` **only on an attempt**. The test-level status is `unexpected`. | Code that read the last attempt's status and matched `'unexpected' \|\| 'failed'` silently dropped every timeout. A hung test reported as neither passed nor failed — a false green. |
| **B5**  | Newman's `failures[]` includes transport errors that produced no assertion.                  | `assertions.total - failures.length` is not a pass count. In the captured fixture it under-counts (3 vs 4); with fewer assertions it goes **negative**.                              |
| **B6**  | Neither report carries domain IDs.                                                           | IDs were minted from a running failure counter (`PW-001`, `REQ-001`…), so an ID depended on the order things failed.                                                                 |

## The rules

### Playwright

The **aggregate test status** decides the outcome, never the last attempt.

| Report shape                                                   | Ledger outcome     |
| -------------------------------------------------------------- | ------------------ |
| `status: expected`, `expectedStatus: passed`                   | `passed`           |
| `status: expected`, `expectedStatus: failed` (a `test.fail()`) | `expected_failure` |
| `status: unexpected` (assertion failure **or** timeout)        | `failed`           |
| `status: flaky` (failed, then passed on retry)                 | `flaky`            |
| `status: skipped`                                              | `skipped`          |
| any attempt `interrupted`                                      | `blocked`          |
| no attempts at all                                             | `not_run`          |
| unrecognized status                                            | `blocked`          |

Attempt statuses are translated to the schema's vocabulary at the boundary:
Playwright's camelCase `timedOut` becomes `timed_out`. Passing the raw value
through produces a ledger that fails validation.

Note that Playwright's `stats.expected` folds declared expected failures in with
real passes — in the captured fixture, `expected: 4` is 2 passes plus 2
`test.fail()` tests. The ledger keeps them apart, because an expected failure is
not passing coverage.

Report-level errors (global setup failure) are preserved as **source errors**
even when zero tests appear, and are counted separately from unit outcomes.

### Newman

One unit per request per iteration. Assertions are **nested evidence** inside
their request, never units of their own.

Transport is checked **before** assertions, because a test script that ran
against no response can still emit a failed assertion, and counting that as a
business failure would misreport a blocked request:

| Report shape                             | Ledger outcome                                                    |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `requestError` present, or no response   | `blocked`                                                         |
| response present, **zero** assertions    | `blocked` — nothing was verified, however well the transport went |
| response present, all assertions skipped | `skipped`                                                         |
| response present, any assertion failed   | `failed`                                                          |
| response present, all assertions passed  | `passed`                                                          |

Transport errors are recorded as an attempt on the unit. They are never
subtracted from assertion totals.

### Domain links (B6)

The adapters resolve **no** domain IDs. Every unit leaves the adapter with null
links and a stated reason. `resolveDomainLinks()` fills them from a
caller-supplied mapping of declared metadata, and:

- an unmapped unit keeps its null links **and its reason**;
- a mapping claiming two different cases for one unit is recorded as
  **ambiguous** and left unresolved for a human;
- an ID is never derived from position or failure ordering.

A unit's id is a function of runner identity alone, so re-running with different
results produces the same ids. This is covered by a test that flips every
outcome in the report and asserts the ids do not move.

### Coverage

Approved-case coverage is tracked separately from unit totals:

- an approved case with **no linked unit** is `not_run`; it creates no fictional
  unit and inflates nothing;
- a case is `passed` only when **every** linked unit strictly passed;
- a case whose only linked unit is `flaky` is **not** covered — unstable is not
  verified;
- a nonempty approved scope with zero executed units has coverage `0`, even
  though its unit pass rate is `null`.

`unit_pass_rate` is `null` for zero units. Not `0`, not `1` — "we ran nothing"
is not a pass rate.

## Usage

```bash
# Both runners
npm run normalize -- --story QA-1042 \
  --playwright reports/results.json \
  --newman reports/newman-results.json

# API-only: no fabricated Playwright report is required
npm run normalize -- --story QA-1042 --newman reports/newman-results.json

# With a declared domain mapping
npm run normalize -- --story QA-1042 --playwright reports/results.json \
  --mapping config/unit-mapping.json
```

Exit codes: `0` a valid ledger was written · `1` inputs read but the ledger could
not be written (validation, invariant, or write failure) · `2` usage error, or
no execution inputs.

With **neither** runner supplied the command exits `2` rather than writing an
empty ledger, because an empty ledger is indistinguishable from a clean run.
Manual/external result import is task group 7.x.

### Mapping file

```json
{
  "approved_case_ids": ["TC-001", "TC-002"],
  "units": {
    "pw:chromium:login.spec.ts > rejects a bad password": {
      "test_case_id": "TC-001",
      "playwright_test_id": "PW-001",
      "spec_id": "SPEC-001"
    }
  }
}
```

An entry whose value is an **array** marks the unit ambiguous: the ledger records
that a human must disambiguate rather than picking one.

## Secrets

Every error excerpt carried into the ledger passes through the shared
`redactText()` from `scripts/lib/report-sanitization.js`, with values supplied
via `QAIZEN_REDACT_VALUES` (comma-separated). This applies to **durable**
evidence, not only CI publication — raw reports are secret-bearing by design,
and the ledger is archived.

The test fixture `test/fixtures/newman-mixed-outcomes.json` deliberately retains
an injected synthetic secret in all three sites where Newman really leaks one
(`environment.values[].value` and each `request.header[].value`). One test
asserts the fixture still contains it — so the leak test cannot silently pass on
a secret-free fixture — and another asserts it never reaches the ledger.

## Fixtures

Both fixtures in `test/fixtures/` are **real captured reports**, not
hand-written: a Playwright run of genuinely failing tests (assertion failure,
timeout, retry-then-pass, skip, `test.fail()`, across two projects) and a Newman
run against a local server (passing assertions, multiple failing assertions in
one request, a zero-assertion request, and a real `ECONNREFUSED`).

This is rule 3.8 applied to fixtures. Hand-written fixtures encode what we
_believe_ a runner emits, and the belief was wrong twice: that `timedOut`
appears as a test status, and that Newman's failure count matches its failed
assertion count. A suite built on invented fixtures would have passed while the
adapters were wrong. Machine-identifying paths are stripped; the report
structure is otherwise untouched.
