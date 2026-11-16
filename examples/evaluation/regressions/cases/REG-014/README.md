# REG-014 — Spec Reviewer

**Where it comes from (seeded-defect).** Control for the seeded spec cases: the faithful BENCH-2 spec, every approved case covered with its expected outcome. A reviewer that flags everything does not pass the set.

**Expected behavior.** The review raises nothing above info.

## Running a trial

For each trial, lay the case's files out in a fresh, empty workspace
outside the repository checkout (so the agent cannot read the other cases or
an earlier trial's `analysis/`), at the paths the pipeline uses, then run the
Spec Reviewer (`agents/spec-reviewer.md`) there with the step instruction below, as
the runner prints it for round 1. The context records the gates the agent's
precondition names as passed; a trial workspace has no runner, so tell the
agent the precondition holds instead of letting it run `--status`. The
workspace has no validator either: tell the agent to skip its schema
validation step, since the evaluator validates every trial (`review_valid`).
Do not run the gates, and do not show the agent this README.

| Case file          | Workspace path                           |
| ------------------ | ---------------------------------------- |
| `context.json`     | `context.json`                           |
| `test-cases.json`  | `test-cases/BENCH-2.json`                |
| `planner-brief.md` | `planner-input/BENCH-2.planner-brief.md` |
| `spec.md`          | `specs/BENCH-2.md`                       |

```text
Run the spec-reviewer (agents/spec-reviewer.md) on the spec; it writes analysis/spec-reviews/BENCH-2.spec-review.json.
  Give it these two values; the review must carry them as written:
    input_digest: a3fb2127f92ab28e919fabad839fc993b9bb2cf0c05752b9ff622fd46134be76
    round: 1
  Round 1 of 3.
  The review advises; it never approves or rejects. Then --resume: the gate asks for your own concerns before it shows the review.
```

The input digest is the digest of this folder's input files
(`caseDigest` in `scripts/lib/regression-eval.js`); it changes whenever an
input file does.

Trial output: `spec-review.json`, the `analysis/spec-reviews/BENCH-2.spec-review.json` the agent wrote.

Checks: `review_valid`, `no_alarm` (`scripts/lib/regression-checks.js`).
