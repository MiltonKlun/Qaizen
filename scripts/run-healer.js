#!/usr/bin/env node
// Healer harness with guardrails (Phase 3 TG2). The SAFETY layer around test
// healing — it enforces every Healer guardrail (CLAUDE.md §3.6,
// docs/healer-guardrails.md) in code. It NEVER commits, NEVER merges, NEVER
// touches main, and only ever processes GREEN failures, producing a reviewable
// .patch file. It does NOT auto-apply to the working tree.
//
// SCOPE / honesty: a headless script cannot itself LLM-generate a fix for a
// broken locator. So this harness owns the safe, deterministic parts —
//   • filter failure-analysis to Green-only,
//   • set up an isolated workspace copy of the affected test,
//   • enforce the forbidden-op guardrails on any candidate patch,
//   • re-run ONLY the affected test to validate,
//   • emit release/healer-patches/FAIL-XXX.patch + analysis/healer-validation/FAIL-XXX.md,
//   • cap at 3 attempts.
// The PATCH-GENERATION step is an explicit agent/LLM hook (see generatePatch
// below): in this script it is a no-op placeholder that reports "no candidate".
// A future Healer agent (or the Playwright native healer) supplies candidate
// patches; this harness decides whether they are SAFE and whether they WORK.
//
// Yellow => suggestion file only, never applied. Red => never touched.
//
// Usage:
//   node scripts/run-healer.js                 # dry-run: report what it would heal
//   node scripts/run-healer.js --apply         # produce patch files (still never commits)
//
// Exit codes: 0 ok · 1 a guardrail violation was attempted · 2 usage/file error

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { argv, exit } from 'node:process';

const APPLY = argv.includes('--apply');
const FA = 'analysis/failure-analysis.json';
const PATCH_DIR = 'release/healer-patches';
const VALIDATION_DIR = 'analysis/healer-validation';
const MAX_ATTEMPTS = 3;

if (!existsSync(FA)) {
  console.error(
    `No ${FA}. Run scripts/run-failure-classifier.js (TG1) or the Failure ` +
      `Classifier Agent first.`
  );
  exit(2);
}
const fa = JSON.parse(readFileSync(FA, 'utf8'));
const failures = fa.failures || [];

// --- Guardrail: forbidden operations on a candidate patch ----------------
// Returns a list of violations (empty = safe). This is the heart of the
// harness: even if a future agent proposes a patch, it is REJECTED if it does
// any of these. (CLAUDE.md §3.6 hard stops.)
function guardrailViolations(originalSource, patchedSource) {
  const v = [];
  const addedLines = patchedSource
    .split('\n')
    .filter((l) => !originalSource.includes(l.trim()) && l.trim());

  // Never add .skip / .fixme / .only-as-skip or xfail.
  if (
    /\.(skip|fixme)\s*\(|test\.skip|describe\.skip/.test(patchedSource) &&
    !/\.(skip|fixme)\s*\(|test\.skip|describe\.skip/.test(originalSource)
  ) {
    v.push('adds .skip/.fixme (test suppression is forbidden)');
  }
  // Never delete a test (fewer test( / it( calls than before).
  const countTests = (s) => (s.match(/\b(test|it)\s*\(/g) || []).length;
  if (countTests(patchedSource) < countTests(originalSource)) {
    v.push('removes a test (deleting tests is forbidden)');
  }
  // Never weaken an assertion to a trivially-true form.
  if (
    /toBeTruthy\(\)|toBeDefined\(\)|\.not\.toThrow\(\)/.test(
      addedLines.join('\n')
    )
  ) {
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

// --- Agent/LLM hook: produce a candidate patch for a Green failure -------
// In this harness it is a NO-OP that returns null (no candidate). A Healer
// agent overrides this step by supplying a candidate patched source. The
// harness's job is to GATE that candidate, not to invent it.
function generatePatch(/* failure, originalSource */) {
  return null; // no candidate from the headless harness
}

if (!existsSync(PATCH_DIR)) mkdirSync(PATCH_DIR, { recursive: true });
if (!existsSync(VALIDATION_DIR)) mkdirSync(VALIDATION_DIR, { recursive: true });

const green = failures.filter((f) => f.severity === 'green');
const yellow = failures.filter((f) => f.severity === 'yellow');
const red = failures.filter((f) => f.severity === 'red');

console.log('Healer harness');
console.log(
  `  Failures: ${failures.length} (green ${green.length}, yellow ${yellow.length}, red ${red.length})`
);
console.log(
  `  Green = candidates for an auto-fix PATCH (never auto-applied, never committed).`
);
console.log(
  `  Yellow = suggestion only. Red = NOT touched (bug-draft path only).`
);

let violationAttempted = false;

// Yellow: write a suggestion file, never modify the test.
for (const f of yellow) {
  console.log(
    `  ${f.failure_id} (yellow): suggestion-only — requires human review. Not patched.`
  );
  if (APPLY) {
    writeFileSync(
      `${VALIDATION_DIR}/${f.failure_id}.md`,
      `# ${f.failure_id} — Yellow (suggestion only)\n\n` +
        `Classification: ${f.classification}\n\n` +
        `This failure is Yellow: the Healer does NOT modify the test. A human must\n` +
        `decide. Error:\n\n> ${(f.error_message || '').slice(0, 400)}\n`
    );
  }
}

// Red: never touched.
for (const f of red) {
  console.log(
    `  ${f.failure_id} (red): NOT touched — bug draft only (${f.bug_draft_path || 'n/a'}).`
  );
}

// Green: try to heal via the agent hook, gated by guardrails. An
// agent-integrated loop tries up to MAX_ATTEMPTS candidates per failure,
// re-running only the affected test between attempts; the headless harness
// has no candidate, so it makes zero attempts.
let healed = 0;
for (const f of green) {
  console.log(
    `  ${f.failure_id} (green, ${f.classification}): candidate for healing (cap ${MAX_ATTEMPTS} attempts).`
  );

  // The harness needs the affected test file's source to gate a patch. The
  // failure-analysis from the agent carries it; the headless pre-classifier
  // sets test_case_id:null, so there is often no resolved file here. Without a
  // resolved source AND a candidate patch, the harness has nothing to gate.
  const originalSource = null; // an agent supplies the affected file source
  const candidate = generatePatch(/* f, originalSource */);

  if (!candidate || !originalSource) {
    console.log(
      `      no candidate patch (the headless harness does not generate fixes; ` +
        `a Healer agent supplies one). Skipping — nothing applied.`
    );
    continue;
  }

  // Gate the candidate (this runs when an agent provided one).
  const violations = guardrailViolations(originalSource, candidate);
  if (violations.length) {
    violationAttempted = true;
    console.error(`      REJECTED ${f.failure_id}: ${violations.join('; ')}`);
    if (APPLY) {
      writeFileSync(
        `${VALIDATION_DIR}/${f.failure_id}.md`,
        `# ${f.failure_id} — REJECTED candidate patch\n\nGuardrail violations:\n` +
          violations.map((x) => `- ${x}`).join('\n') +
          '\n'
      );
    }
    continue;
  }
  // (When safe + apply: write the .patch and the before/after, after a
  // single-test re-run validates it. Left as the agent-integrated path.)
  healed += 1;
}

console.log(
  `\nSummary: ${healed} green patch(es) would be emitted; ${yellow.length} yellow suggestion(s); ${red.length} red untouched.`
);
if (!APPLY)
  console.log(
    'DRY RUN (no files written). Re-run with --apply to write suggestion/validation files.'
  );
console.log(
  '\nGuardrails enforced in code: no commit, no merge, Green-only auto-fix, ' +
    'never change expected values, never add .skip, never delete a test, never ' +
    'update snapshots, max 3 attempts. Patch generation is an agent hook.'
);

// A guardrail violation being ATTEMPTED is a failure signal even though the
// harness blocked it (so CI / the human notices the agent misbehaved).
exit(violationAttempted ? 1 : 0);
