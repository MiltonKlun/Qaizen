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

`[]` means the candidate is eligible under the static check (e.g. a
locator-only fix); any non-empty result means **reject**. A `[]` result is
not a statement that the fix is correct — a human still reviews it.

> **Status of the harness (review finding S3).** `scripts/run-healer.js` is
> currently **triage scaffolding**, not a healing pipeline. It reads
> `analysis/failure-analysis.json`, partitions failures into Green/Yellow/Red,
> reports what would be eligible, and writes Yellow suggestion notes with
> `--apply`.
>
> It does **not** yet ingest a candidate patch, create an isolated workspace,
> re-run the affected test, emit a validated `.patch`, or enforce the 3-attempt
> cap — `generatePatch()` returns `null` unconditionally, so the guardrail and
> rerun code inside it is unreachable. **The guardrail function itself is real
> and usable on its own** (see below); it is the ingestion around it that is
> missing. Candidate processing arrives in Phase 6.

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

# Triage a classified failure set (Green/Yellow/Red partition, no patching):
node scripts/run-healer.js              # report what WOULD be eligible
node scripts/run-healer.js --apply      # also write Yellow suggestion notes
```

## Hard limits

- **Playwright only.** Never touches Newman/API tests
  (`docs/healer-guardrails.md` — "never touches API").
- **Green only.** Yellow → suggestion, never applied. Red → bug draft, never
  touched.
- **Never commits, never merges, never auto-applies to the working tree.**
  Even in CI the healer comments, it does not push.
- **Not yet enforced by the harness** (Phase 6): candidate ingestion, the
  isolated rerun, the `.patch` output, and the **max-3-attempts** cap. Those
  limits are documented policy today, not code the harness runs — nothing
  currently reaches the guardrail check inside `run-healer.js`. The guardrail
  function is separately real: call `guardrailViolations()` directly, as above.

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
