#!/usr/bin/env node
// Healer harness (Phase 3 TG2; candidate processing since task group 6.3).
//
// Two modes:
//
// 1. TRIAGE (default): read analysis/failure-analysis.json, partition the
//    failures into Green / Yellow / Red and say what can happen to each.
//    Read-only; --apply also writes Yellow suggestion notes.
//
// 2. CANDIDATE: process one proposed fix for one Green failure.
//      node scripts/run-healer.js --failure FAIL-001 --candidate <file> [--apply]
//    The Healer does not write fixes; a person or an agent proposes a
//    candidate file. This checks it:
//      - the current run's context, finalized analysis and ledger identify the
//        live test file and the single failing test; Gate 4 must be current;
//        API, Yellow and Red failures and ambiguous tests are refused;
//      - the static check (scripts/healer-guardrails.js) must find it
//        eligible;
//      - with --apply: the needed sources are copied into a task-owned
//        workspace (.healer-workspace/, gitignored); the unchanged original
//        must still fail there; then the SAME single test runs with the
//        candidate (one project, no repeats, no retries, no snapshot updates)
//        and must pass;
//      - only then is a unified patch written to release/healer-patches/,
//        proven by applying it to a copy of the original.
//    Every submission with --apply is recorded in analysis/healer-validation/
//    (schemas/healer-validation.schema.json): rejected_static,
//    validation_failed or validated. At most three per (run, original
//    source, test); resubmitting an identical candidate reuses its record.
//    Without --apply only the static check runs and nothing is written.
//
// Never: edits the live test, commits, merges, approves, or retries on its
// own. A validated patch still needs human review. The workspace is a
// filesystem separation, not a security sandbox: the test code runs with
// your privileges and environment.
//
// Exit codes: 0 ok / validated · 1 refused, rejected, not validated, or a
//   guardrail violation was attempted · 2 usage or file error

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { argv, env, exit } from 'node:process';

import {
  readJson,
  readValidatedJson,
  writeJsonAtomic,
  writeTextAtomic,
} from './lib/artifact-io.js';
import { requireCurrentGate } from './lib/approval-binding.js';
import { readLedger } from './lib/execution-ledger.js';
import {
  MAX_ATTEMPTS,
  PATCH_DIR,
  VALIDATION_DIR,
  buildPatch,
  collectSources,
  createWorkspace,
  readAttempts,
  removeWorkspace,
  resolveTarget,
  runSingleTest,
  sha256,
} from './lib/healer-candidate.js';
import { ELIGIBILITY_NOTE, checkCandidate } from './healer-guardrails.js';

const FA = 'analysis/failure-analysis.json';
const LEDGER = 'analysis/execution-ledger.json';
const ANALYSIS_SCHEMA = 'schemas/failure-analysis.schema.json';
const RECORD_SCHEMA = 'schemas/healer-validation.schema.json';

const APPLY = argv.includes('--apply');
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const failureId = flag('--failure');
const candidatePath = flag('--candidate');
const configPath = flag('--config') ?? 'playwright.config.ts';

if (Boolean(failureId) !== Boolean(candidatePath)) {
  console.error(
    'Usage: node scripts/run-healer.js [--apply]                                   # triage\n' +
      '       node scripts/run-healer.js --failure FAIL-XXX --candidate <file> [--apply] [--config <file>]'
  );
  exit(2);
}

if (failureId) exit(await processCandidate());
exit(triage());

// ---------------------------------------------------------------- triage

function triage() {
  if (!existsSync(FA)) {
    console.error(
      `No ${FA}. Run scripts/run-failure-classifier.js (TG1) or the Failure ` +
        `Classifier Agent first.`
    );
    return 2;
  }
  const fa = JSON.parse(readFileSync(FA, 'utf8'));
  const failures = fa.failures || [];
  const green = failures.filter((f) => f.severity === 'green');
  const yellow = failures.filter((f) => f.severity === 'yellow');
  const red = failures.filter((f) => f.severity === 'red');

  console.log('Healer triage');
  console.log(
    `  Failures: ${failures.length} (green ${green.length}, yellow ${yellow.length}, red ${red.length})`
  );
  console.log(
    '  Green = a proposed fix may be validated (never auto-applied, never committed).'
  );
  console.log(
    '  Yellow = suggestion only. Red = NOT touched (bug-draft path only).'
  );

  if (APPLY && yellow.length) mkdirSync(VALIDATION_DIR, { recursive: true });
  for (const f of yellow) {
    console.log(
      `  ${f.failure_id} (yellow): suggestion only — a human decides. Not patched.`
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
  for (const f of red) {
    console.log(
      `  ${f.failure_id} (red): NOT touched — bug draft only (${f.bug_draft_path || 'n/a'}).`
    );
  }
  for (const f of green) {
    console.log(
      `  ${f.failure_id} (green, ${f.classification}): a proposed fix can be checked with\n` +
        `      node scripts/run-healer.js --failure ${f.failure_id} --candidate <file> --apply` +
        ` (max ${MAX_ATTEMPTS} submissions).`
    );
  }
  console.log(
    `\nSummary: ${green.length} green (candidates welcome), ${yellow.length} yellow suggestion(s), ${red.length} red untouched.`
  );
  if (!APPLY)
    console.log(
      'DRY RUN (no files written). --apply writes the Yellow suggestion notes.'
    );
  console.log(
    '\nThe Healer does not write fixes. It checks a proposed one: static rules, then the exact ' +
      'failing test re-run in an isolated copy, then a patch for human review. It never commits, ' +
      'never merges, never edits a live test.'
  );
  return 0;
}

// ---------------------------------------------------------------- candidate

async function processCandidate() {
  // --- The current run, and the one failure it names -------------------
  const ctxRead = readJson('context.json');
  if (!ctxRead.ok) {
    console.error(ctxRead.message);
    return 2;
  }
  const context = ctxRead.data;
  const faRead = readValidatedJson(FA, ANALYSIS_SCHEMA);
  if (!faRead.ok) {
    console.error(`${faRead.message}. Refusing.`);
    return 1;
  }
  const analysis = faRead.data;
  if (
    !/^2\./.test(String(analysis.schema_version)) ||
    analysis.status !== 'finalized'
  ) {
    console.error(
      `${FA} must be a finalized 2.x analysis (the Healer acts on confirmed classifications). Refusing.`
    );
    return 1;
  }
  if (
    analysis.story_id !== context.story?.id ||
    analysis.run_id !== context.run_id
  ) {
    console.error(`${FA} is not the current run's analysis. Refusing.`);
    return 1;
  }
  const ledgerRead = readLedger(LEDGER, {
    storyId: context.story?.id,
    runId: context.run_id,
  });
  if (!ledgerRead.ok) {
    console.error(`${ledgerRead.message}. Refusing.`);
    return 1;
  }
  const gate4 = requireCurrentGate(context, 'code_reviewed', '.');
  if (!gate4.ok) {
    console.error(
      `Gate 4: ${gate4.reason}. Refusing: a candidate is only checked against human-approved code.`
    );
    return 1;
  }
  const target = resolveTarget({
    context,
    analysis,
    ledger: ledgerRead.data,
    failureId,
  });
  if (!target.ok) {
    console.error(`${target.reason}. Refusing.`);
    return 1;
  }
  const { unit, testPath } = target;

  if (!existsSync(candidatePath)) {
    console.error(`Candidate not found: ${candidatePath}`);
    return 2;
  }
  if (resolve(candidatePath) === resolve(testPath)) {
    console.error(
      'The candidate is the live test file. Propose the fix in a separate file; the Healer never edits the live suite.'
    );
    return 2;
  }
  const original = readFileSync(testPath, 'utf8');
  const candidate = readFileSync(candidatePath, 'utf8');
  const originalDigest = sha256(original);
  const candidateDigest = sha256(candidate);

  console.log(`Healer candidate check for ${failureId}`);
  console.log(
    `  Test: ${unit.test_title}${unit.project ? ` [${unit.project}]` : ''}`
  );
  console.log(`  Original: ${testPath} (${originalDigest.slice(0, 12)})`);
  console.log(
    `  Candidate: ${candidatePath} (${candidateDigest.slice(0, 12)})`
  );

  // --- The three-submission cap, and reuse of an identical candidate ---
  const key = { runId: context.run_id, originalDigest, unitId: unit.unit_id };
  const prior = readAttempts('.', key);
  const same = prior.find((r) => r.candidate.sha256 === candidateDigest);
  if (same) {
    console.log(
      `\nThis exact candidate was already submitted (attempt ${same.attempt}): ${same.outcome} — ${same.reason}\n` +
        `See ${same.file}. It does not get another attempt.`
    );
    return same.outcome === 'validated' ? 0 : 1;
  }
  if (prior.length >= MAX_ATTEMPTS) {
    const msg =
      `All ${MAX_ATTEMPTS} submissions for this test in this run are used ` +
      `(${prior.map((r) => `#${r.attempt} ${r.outcome}`).join(', ')}). ` +
      'Stop healing it: a human fixes it, or it becomes a Yellow/Red decision.';
    console.error(`\n${msg}`);
    if (APPLY) {
      writeTextAtomic(
        join(VALIDATION_DIR, `${failureId}.exhausted.md`),
        `# ${failureId} — healing attempts exhausted\n\n${msg}\n\nThis is not a validation result.\n`
      );
    }
    return 1;
  }

  // --- Static check ------------------------------------------------------
  const staticCheck = checkCandidate(original, candidate, {
    fileName: testPath,
  });
  console.log(
    `\nStatic check: ${staticCheck.eligible ? `ELIGIBLE — ${ELIGIBILITY_NOTE}` : 'REJECTED'}`
  );
  for (const v of staticCheck.violations) console.log(`  - ${v}`);
  for (const r of staticCheck.repairs)
    console.log(`  - line ${r.line}: "${r.from}" -> "${r.to}"`);
  if (!APPLY) {
    console.log(
      '\nStatic eligibility only. Re-run with --apply to validate it by running the test.'
    );
    return staticCheck.eligible ? 0 : 1;
  }

  const attempt = prior.length + 1;
  const recordPath = join(
    VALIDATION_DIR,
    `${failureId}.attempt-${attempt}.json`
  );
  if (existsSync(recordPath)) {
    console.error(
      `${recordPath} already exists for another run or test. Archive the previous run before healing again.`
    );
    return 1;
  }
  const base = {
    schema_version: '1.0',
    record_type: 'candidate_validation',
    story_id: context.story.id,
    run_id: context.run_id,
    failure_id: failureId,
    unit,
    original: { path: testPath, sha256: originalDigest },
    candidate: { path: candidatePath, sha256: candidateDigest },
    attempt,
    static_check: staticCheck,
    human_review: 'required',
  };

  if (!staticCheck.eligible) {
    return save({
      ...base,
      outcome: 'rejected_static',
      reason: `the static check rejected it: ${staticCheck.violations[0]}`,
      baseline: null,
      rerun: null,
      patch: null,
    });
  }

  // --- Isolated re-run -----------------------------------------------------
  const sources = collectSources('.', configPath, testPath);
  if (sources.problems.length) {
    console.error(
      `Cannot build the isolated copy: ${sources.problems.join('; ')}`
    );
    return 1;
  }
  const timeoutMs = Number(env.QAIZEN_HEALER_TIMEOUT_MS) || 300000;
  const workspace = createWorkspace(
    '.',
    `${failureId}-a${attempt}`,
    sources.files
  );
  try {
    const run = (label) =>
      runSingleTest({
        workspace,
        configPath,
        testPath,
        unit,
        label,
        env,
        timeoutMs,
      });

    console.log(`\nIsolated copy: ${workspace}`);
    const baseline = run('baseline');
    console.log(`  Baseline (original): ${baseline.status}`);
    if (baseline.status !== 'failed') {
      console.error(
        `The unchanged original did not fail in the isolated copy (${baseline.status}` +
          `${baseline.error_excerpt ? `: ${baseline.error_excerpt}` : ''}). ` +
          'There is nothing to validate the candidate against; no attempt was used.'
      );
      return 1;
    }

    writeFileSync(join(workspace, testPath), candidate);
    const rerun = run('candidate');
    console.log(`  Re-run (candidate): ${rerun.status}`);

    if (sha256(readFileSync(testPath, 'utf8')) !== originalDigest) {
      console.error(
        'The live test file changed during validation. Nothing is recorded; try again.'
      );
      return 1;
    }

    if (rerun.status !== 'passed' || rerun.tests_executed !== 1) {
      return save({
        ...base,
        outcome: 'validation_failed',
        reason:
          `the test ${rerun.status} with the candidate${rerun.error_excerpt ? `: ${rerun.error_excerpt}` : ''}`.slice(
            0,
            500
          ),
        baseline,
        rerun,
        patch: null,
      });
    }

    const built = buildPatch({
      workspace,
      relPath: testPath,
      original,
      candidate,
    });
    if (!built.ok) {
      return save({
        ...base,
        outcome: 'validation_failed',
        reason: built.reason.slice(0, 500),
        baseline,
        rerun,
        patch: null,
      });
    }
    const patchPath = join(PATCH_DIR, `${failureId}.attempt-${attempt}.patch`);
    const wrote = writeTextAtomic(patchPath, built.patch);
    if (!wrote.ok) {
      console.error(wrote.message);
      return 1;
    }
    return save(
      {
        ...base,
        outcome: 'validated',
        reason:
          'eligible under static checks, and the failing test passed with it in isolation',
        baseline,
        rerun,
        patch: {
          path: patchPath.split('\\').join('/'),
          sha256: sha256(built.patch),
          applies_cleanly: true,
        },
      },
      patchPath
    );
  } finally {
    removeWorkspace(workspace);
  }

  function save(record, patchPath = null) {
    const full = { ...record, created_at: new Date().toISOString() };
    const written = writeJsonAtomic(recordPath, full, {
      schemaPath: RECORD_SCHEMA,
    });
    if (!written.ok) {
      console.error(written.message);
      if (patchPath) rmSync(patchPath, { force: true });
      return 1;
    }
    writeTextAtomic(recordPath.replace(/\.json$/, '.md'), renderRecord(full));
    console.log(
      `\n${full.outcome.toUpperCase()} (attempt ${attempt} of ${MAX_ATTEMPTS}): ${full.reason}`
    );
    console.log(`  Evidence: ${recordPath}`);
    if (full.patch) {
      console.log(`  Patch for human review: ${full.patch.path}`);
      console.log(
        '  Not applied, not committed. Review it before applying it yourself.'
      );
    }
    return full.outcome === 'validated' ? 0 : 1;
  }
}

function renderRecord(r) {
  const run = (label, x) =>
    x
      ? `- ${label}: **${x.status}** (${x.tests_executed} test(s), exit ${x.exit_code})\n  \`${x.command}\`` +
        (x.error_excerpt ? `\n  > ${x.error_excerpt}` : '')
      : `- ${label}: not run`;
  return [
    `# ${r.failure_id} — candidate attempt ${r.attempt}: ${r.outcome}`,
    '',
    `**Human review required.** This record is evidence, not an approval.`,
    '',
    `- Test: ${r.unit.test_title}${r.unit.project ? ` [${r.unit.project}]` : ''}`,
    `- Original: ${r.original.path} (${r.original.sha256.slice(0, 12)})`,
    `- Candidate: ${r.candidate.path} (${r.candidate.sha256.slice(0, 12)})`,
    `- Reason: ${r.reason}`,
    '',
    '## Static check',
    '',
    r.static_check.eligible ? `Eligible — ${ELIGIBILITY_NOTE}.` : 'Rejected:',
    ...r.static_check.violations.map((v) => `- ${v}`),
    ...r.static_check.repairs.map(
      (x) => `- line ${x.line}: \`${x.from}\` → \`${x.to}\``
    ),
    '',
    '## Runs (isolated copy)',
    '',
    run('Baseline (original)', r.baseline),
    run('Re-run (candidate)', r.rerun),
    '',
    '## Patch',
    '',
    r.patch
      ? `\`${r.patch.path}\` — applies cleanly to the original. Not applied, not committed.`
      : 'None.',
    '',
  ].join('\n');
}
