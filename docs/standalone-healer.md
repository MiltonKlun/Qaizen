# Standalone: the guardrailed healer

> One à-la-carte piece. What you can lift out is a **checker for proposed
> test fixes**, not an autopilot: it decides whether a candidate patch is
> eligible, proves it by re-running the failing test in isolation, and hands
> a patch to a human. It never commits, never merges, and never edits the
> live test.

## What you get

**A static check.** `checkCandidate(original, candidate)` /
`guardrailViolations(original, candidate)` in `scripts/healer-guardrails.js`
parse both files and compare their executable structure. In this version the
only change accepted automatically is the string in `page.locator('...')` or
`page.getByTestId('...')` when `page` is the Playwright fixture and the
locator is used directly by an action. Changed or removed assertions,
expected values, snapshots, waits, test registrations, `.skip` / `.fixme` /
`.only` / `.fail`, deleted tests and removed traceability ids are all
rejected with a reason. A clean result means "eligible under static checks;
human review still required".

**Candidate processing.** `scripts/run-healer.js --failure FAIL-XXX
--candidate <file> --apply` takes one Green failure of the current run and:

1. confirms the unchanged original still fails in an isolated copy;
2. runs the same single test with the candidate (no retries, no repeats, no
   snapshot updates) and requires it to pass;
3. writes a unified patch, proven by applying it to a copy of the original;
4. records every submission (`schemas/healer-validation.schema.json`), at most
   three per test and run.

This is tested against a stand-in runner in CI and against real Playwright on
the offline demo app.

## What you don't get

**Fix generation.** The Healer does not write fixes. A person, or
Playwright's native healer agent run under the project's restrictions
(`docs/native-healer-handoff.md`), proposes a candidate; this layer decides
whether it is eligible and whether it works. Role/name selectors, waits and
timeouts are Green for a human to fix but are not accepted automatically.

## Quickstart

```bash
npm run demo:healer        # ELIGIBLE for a locator fix, REJECTED for a value change
npm run heal               # triage: what each failure of the current run can receive
node scripts/run-healer.js --failure FAIL-001 --candidate fixed.spec.ts          # static check
node scripts/run-healer.js --failure FAIL-001 --candidate fixed.spec.ts --apply  # validate + patch
```

## Hard limits

- **Green only.** Yellow → suggestion note. Red → bug draft, never touched.
  API/Newman tests are never healed.
- **Never** commits, merges, applies a patch or records a gate decision. A
  human reviews the patch and applies it; Gate 4 then needs a new decision.
- **Three submissions** per test and run, persisted; no automatic retry.
- The isolated copy is a filesystem separation, not a security sandbox.

## References

- `scripts/healer-guardrails.js` — the static check.
- `scripts/run-healer.js` — triage and candidate processing.
- `docs/healer-guardrails.md` — the Green/Yellow/Red rules and the sequence.
- `docs/native-healer-handoff.md` — using Playwright's native healer safely.
