# Release Report — STORY-002: Account access and provisioning

**Run ID:** `2026-05-31T19-00-00Z-tg9run`
**Report date:** 2026-05-31T23:45:00Z
**Recommendation:** **pass** — both branches green; both high-severity risks covered_passing.

## Summary

STORY-002 is the Phase 1.5 dual E2E/API vertical slice. The E2E branch ran
against Saucedemo (login happy path + invalid-password rejection with the
no-session-cookie assertion); the API branch ran against reqres.in (create
user → 201, register-without-password → 400). All assertions passed in both
branches: 0 failures, 0 bug drafts.

> **Note on the e2e count:** the e2e execution group counts the full
> Playwright suite (5 tests = STORY-002's 2 + the retained STORY-001 2 + the
> seed), because both stories' tests coexist under `tests/` until the Phase 3
> `runs/` archival model lands. STORY-002's own E2E contribution is 2 passing
> tests.

## Coverage by risk

| Risk     | Severity | Covered by     | Branch | Status          |
| -------- | -------- | -------------- | ------ | --------------- |
| RISK-001 | high     | TC-001, TC-002 | E2E    | covered_passing |
| RISK-002 | high     | TC-003, TC-004 | API    | covered_passing |

## Execution summary (grouped)

| Branch       | Total | Passed | Failed | Skipped | Pass rate |
| ------------ | ----- | ------ | ------ | ------- | --------- |
| E2E          | 5     | 5      | 0      | 0       | 100%      |
| API          | 2     | 2      | 0      | 0       | 100%      |
| **Combined** | 7     | 7      | 0      | 0       | 100%      |

## Blocking failures

None.

## Non-blocking failures

None.

## Bug drafts

None.

## Recommendation

**pass.** Both high-severity risks are covered_passing across both branches:

- **RISK-001** by the two E2E tests — TC-001 (happy login → inventory) and
  TC-002 (invalid-password rejection, including the `session-username`
  cookie-absence check).
- **RISK-002** by the two API requests — TC-003 (create → 201 with
  `id` + `createdAt`) and TC-004 (register-without-password → 400 with an
  error mentioning password).

No blocking failures in either branch, no flakes, no outstanding manual or
unexecuted cases. The reqres.in endpoint shapes were verified live (with the
required `x-api-key`) before assertions were written.

## Open questions

- **Secrets hygiene:** `reports/newman-results.json` captures the live
  `x-api-key` request header (gitignored now, but a Phase 2 CI-artifact
  redaction follow-up is tracked in `docs/ambiguities.md` A5).
- **Gate tracking:** the API-branch gates (3' collection review, 4' assertion
  review) were approved out-of-band this run; adding `collection_reviewed` /
  `api_assertions_reviewed` keys to `context.schema.json` is a Phase 2
  follow-up.
- **Rotate** the reqres.in and Postman API keys that were exposed in the
  build session.

## Evidence

- `reports/html` — Playwright HTML report.
- `reports/results.json` — Playwright JSON results.
- `reports/newman-html` — Newman HTML report.
- `reports/newman-results.json` — Newman JSON results (treat as
  secret-bearing; see A5).
- `analysis/failure-analysis.json` — empty `failures[]` confirming no defects.
