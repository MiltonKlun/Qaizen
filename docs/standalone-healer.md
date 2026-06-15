# Standalone: the guardrailed healer

> One à-la-carte piece (IMPROVEMENT-PLAN Phase 7 / PFI-6). The value you can
> lift out on its own is **the guardrail**, not an autopilot: a deterministic
> safety check that decides whether a candidate test patch is allowed — it
> **never commits, never merges, and only ever produces a reviewable patch**.

## What you get (and what you don't)

**You get** `guardrailViolations(originalSource, patchedSource)` — a pure
function (`scripts/healer-guardrails.js`) that rejects any candidate patch
that:

- adds `.skip` / `.fixme` (test suppression),
- deletes a test,
- weakens an assertion to a trivially-true form (`toBeTruthy`, …),
- introduces/updates a snapshot, or
- changes an expected value / assertion target (business meaning).

`[]` means the candidate is safe (e.g. a locator-only fix); any non-empty
result means **reject**. The harness `scripts/run-healer.js` wraps this: it
filters failures to Green-only, sets up an isolated workspace, runs the
guardrail, re-runs only the affected test, and emits
`release/healer-patches/FAIL-XXX.patch` + a validation note.

**You don't get** automatic fix _generation_. By design, the headless harness's
patch-generation step is a no-op hook (`generatePatch` returns null): a script
can't safely LLM-invent a locator fix. An agent (or the Playwright native
healer) supplies the candidate; this layer's job is to **gate** it, not invent
it. So "standalone" here means "standalone _safety check_", honestly — not
"standalone auto-repair".

## Quickstart (≤5 commands)

```bash
# See the guardrail decide, deterministically (Green allowed, Red rejected):
npm run demo:healer            # exits 0; prints SAFE for a locator fix, REJECTED for a value change

# Use the guardrail on your own candidate patch (any Playwright repo):
node -e "import('./scripts/healer-guardrails.js').then(({guardrailViolations}) => \
  console.log(guardrailViolations(origSource, patchedSource)))"

# Run the harness over a classified failure set (Green-only, patch files):
node scripts/run-healer.js              # dry-run: what it would heal
node scripts/run-healer.js --apply      # write patch files (still NEVER commits)
```

## Hard limits

- **Playwright only.** Never touches Newman/API tests
  (`docs/healer-guardrails.md` — "never touches API").
- **Green only.** Yellow → suggestion, never applied. Red → bug draft, never
  touched.
- **Max 3 attempts** per test; low confidence → `unknown_needs_human_review`.
- **Never commits, never merges, never auto-applies to the working tree.**
  Every change is a `.patch` a human reviews. Even in CI the healer comments,
  it does not push.

## Borrowing just the idea

The portable concept is the **forbidden-operation list as a pure function**:
before any auto-fix touches a test, mechanically prove it didn't suppress,
delete, or weaken anything. That check is stack-agnostic — the same five rules
apply to a Cypress or a unit test. (The pre-Gate-4 scanner, `docs/review-gates.md`
Gate 4, reuses the very same `WEAK_ASSERTION_PATTERN`/`SKIP_PATTERN` constants —
one source of truth.)

## References

- `scripts/healer-guardrails.js` — the pure guardrail + exported constants.
- `scripts/run-healer.js` — the safe harness.
- `npm run demo:healer` — the deterministic Green-vs-Red demonstration.
- `docs/healer-guardrails.md` — the full Green/Yellow/Red rules.
