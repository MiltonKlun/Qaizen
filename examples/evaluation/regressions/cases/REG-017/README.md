# REG-017 — Test Reviewer

**Where it comes from (seeded-defect).** Planted in a faithful BENCH-2 test: the test for TC-004, the only negative case (no postcode), is left out, though Gate 2 approved it as automate_e2e and the spec has its scenario.

**Expected behavior.** The review raises TC-004 as not tested above info, and nothing above info about the other cases.

## Running a trial

Lay the case's files out in a scratch workspace at the paths the pipeline
uses, then run the Test Reviewer (`agents/test-reviewer.md`) there with the step
instruction below, as the runner prints it for round 1. The context records
the gates the agent's precondition names as passed; a trial workspace has no
runner, so tell the agent the precondition holds instead of letting it run
`--status`. Do not run the gates, and do not show the agent this README.

| Case file          | Workspace path                           |
| ------------------ | ---------------------------------------- |
| `context.json`     | `context.json`                           |
| `test-cases.json`  | `test-cases/BENCH-2.json`                |
| `planner-brief.md` | `planner-input/BENCH-2.planner-brief.md` |
| `spec.md`          | `specs/BENCH-2.md`                       |
| `test.spec.ts`     | `tests/BENCH-2.spec.ts`                  |

```text
Run the test-reviewer (agents/test-reviewer.md) on the generated test; it writes analysis/test-reviews/BENCH-2.test-review.json.
  Give it these two values; the review must carry them as written:
    input_digest: 18b123b5858ac21b895a95dba0068ff057530b6c36654e85f6937083984c9232
    round: 1
  Round 1 of 3.
  The review advises; it never approves or rejects. Then --resume: the gate asks for your own concerns before it shows the review.
```

The input digest is the digest of this folder's input files
(`caseDigest` in `scripts/lib/regression-eval.js`); it changes whenever an
input file does.

Trial output: `test-review.json`, the `analysis/test-reviews/BENCH-2.test-review.json` the agent wrote.

Checks: `review_valid`, `finds`, `no_alarm` (`scripts/lib/regression-checks.js`).
