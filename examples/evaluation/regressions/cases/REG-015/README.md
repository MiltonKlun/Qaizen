# REG-015 — Test Reviewer

**Where it comes from (seeded-defect).** Planted in a faithful BENCH-2 test: the TC-002 test checks only that the Items figure is a positive amount, never that it is the sum of the listed prices. It passes with Bench Shop --bug wrong-item-total.

**Expected behavior.** The review raises the weak TC-002 assertion above info, and nothing above info about the other cases.

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
    input_digest: 721aa1b27f9f95bc458cb66f5c69617bd8c10bc042b9afff5e1e1495f117cba3
    round: 1
  Round 1 of 3.
  The review advises; it never approves or rejects. Then --resume: the gate asks for your own concerns before it shows the review.
```

The input digest is the digest of this folder's input files
(`caseDigest` in `scripts/lib/regression-eval.js`); it changes whenever an
input file does.

Trial output: `test-review.json`, the `analysis/test-reviews/BENCH-2.test-review.json` the agent wrote.

Checks: `review_valid`, `finds`, `no_alarm` (`scripts/lib/regression-checks.js`).
