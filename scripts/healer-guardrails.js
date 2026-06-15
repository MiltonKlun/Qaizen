// Healer guardrails — the forbidden-operation checks on a candidate patch
// (Phase 3 TG2/TG14). Extracted so both the harness (scripts/run-healer.js)
// and the TG14 demonstration import the SAME logic — single source of truth,
// no drift. Pure function, no I/O, no side effects.
//
// guardrailViolations(originalSource, patchedSource) -> string[]
//   [] means the candidate is SAFE (e.g. a locator-only fix). A non-empty
//   array lists every forbidden change the candidate attempted; the harness
//   REJECTS any candidate with violations (CLAUDE.md §3.6 hard stops):
//     - adds .skip/.fixme (test suppression)
//     - removes a test
//     - weakens an assertion to a trivially-true form (toBeTruthy, ...)
//     - introduces/updates a snapshot
//     - changes an expected value/assertion target (business meaning)
//
// The pattern constants below are EXPORTED so a second, read-only consumer —
// the pre-Gate-4 scanner (scripts/gate4-scan.js, IMPROVEMENT-PLAN Phase 6) —
// reuses the exact same definitions of "test suppression" and "weakened
// assertion" rather than re-deriving them (one source of truth, no drift).
// They are plain (non-global) regexes, so .test() is reuse-safe (no lastIndex
// state). Extracting them is behavior-preserving: guardrailViolations is
// byte-identical, the 10/10 guardrail tests pass unchanged.

/** Test suppression: .skip / .fixme / test.skip / describe.skip. */
export const SKIP_PATTERN = /\.(skip|fixme)\s*\(|test\.skip|describe\.skip/;

/** Assertion weakened to a trivially-true form. */
export const WEAK_ASSERTION_PATTERN =
  /toBeTruthy\(\)|toBeDefined\(\)|\.not\.toThrow\(\)/;

export function guardrailViolations(originalSource, patchedSource) {
  const v = [];
  const addedLines = patchedSource
    .split('\n')
    .filter((l) => !originalSource.includes(l.trim()) && l.trim());

  // Never add .skip / .fixme / .only-as-skip or xfail.
  if (SKIP_PATTERN.test(patchedSource) && !SKIP_PATTERN.test(originalSource)) {
    v.push('adds .skip/.fixme (test suppression is forbidden)');
  }
  // Never delete a test (fewer test( / it( calls than before).
  const countTests = (s) => (s.match(/\b(test|it)\s*\(/g) || []).length;
  if (countTests(patchedSource) < countTests(originalSource)) {
    v.push('removes a test (deleting tests is forbidden)');
  }
  // Never weaken an assertion to a trivially-true form.
  if (WEAK_ASSERTION_PATTERN.test(addedLines.join('\n'))) {
    v.push('weakens an assertion (e.g. toBeTruthy) — forbidden');
  }
  // Never touch snapshots.
  if (
    /toMatchSnapshot|toHaveScreenshot|updateSnapshot/.test(patchedSource) &&
    !/toMatchSnapshot|toHaveScreenshot/.test(originalSource)
  ) {
    v.push('introduces/updates a snapshot — needs explicit human approval');
  }
  // Never change an expected value: heuristic — flag changes inside
  // toEqual/toBe/toHaveText/toHaveValue/toHaveURL argument literals.
  const expectedLiterals = (s) =>
    (
      s.match(
        /\.(toEqual|toBe|toHaveText|toHaveValue|toHaveURL|toHaveCount)\(([^)]*)\)/g
      ) || []
    )
      .sort()
      .join('|');
  if (expectedLiterals(originalSource) !== expectedLiterals(patchedSource)) {
    v.push(
      'changes an expected value/assertion target — forbidden (business meaning must not change)'
    );
  }
  return v;
}
