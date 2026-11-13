#!/usr/bin/env node
// @ts-check
// Healer harness.
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
//        must fail there 3 of 3 times, at the same place (a test that fails
//        only sometimes is flaky, not a broken locator); then the SAME single
//        test runs 5 times with the candidate (one project, no retries, no
//        snapshot updates) and must pass every time;
//      - only then is a unified patch written to release/healer-patches/,
//        proven by applying it to a copy of the original.
//    Every submission with --apply is recorded in analysis/healer-validation/
//    (schemas/healer-validation.schema.json): rejected_static,
//    validation_failed or validated, and added to context.json
//    healer_attempts[] with that record's digest. At most three per (run,
//    original source, test), counted from both stores, so deleting the
//    record files gives no attempt back; resubmitting an identical candidate
//    reuses its outcome. Without --apply only the static check runs and
//    nothing is written.
//
// Never: edits the live test, commits, merges, approves, or retries on its
// own. A validated patch still needs human review. The workspace is a
// filesystem separation, not a security sandbox: the test code runs with
// your privileges and environment.
//
// Exit codes: 0 ok / validated · 1 refused, rejected, not validated (also a
//   patch whose attempt could not be added to context.json, or whose record
//   or patch no longer backs it), or a guardrail violation was attempted ·
//   2 usage or file error

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
  validateValue,
  writeJsonAtomic,
  writeTextAtomic,
} from './lib/artifact-io.js';
import { requireCurrentGate } from './lib/approval-binding.js';
import { draftProblems } from './lib/run-artifacts.js';
import { DRAFT_PATH } from './lib/analysis-overrides.js';
import { readLedger } from './lib/execution-ledger.js';
import {
  compareTargets,
  readTargets,
  recordingEnv,
  targetsOf,
} from './lib/action-targets.js';
import {
  MAX_ATTEMPTS,
  PATCH_DIR,
  VALIDATION_DIR,
  buildPatch,
  collectSources,
  createWorkspace,
  attemptEntry,
  readAttempts,
  removeWorkspace,
  resolveTarget,
  runSingleTest,
  BASELINE_RUNS,
  CANDIDATE_RUNS,
  sha256,
} from './lib/healer-candidate.js';
import { ELIGIBILITY_NOTE, checkCandidate } from './healer-guardrails.js';

const CONTEXT_PATH = 'context.json';
const CONTEXT_SCHEMA = 'schemas/context.schema.json';
const FA = 'analysis/failure-analysis.json';
const LEDGER = 'analysis/execution-ledger.json';
const ANALYSIS_SCHEMA = 'schemas/failure-analysis.schema.json';
const RECORD_SCHEMA = 'schemas/healer-validation.schema.json';
// Where a failure the healer will not touch goes next.
const HUMAN_NEXT =
  'It goes to a human: reclassify the failure as flaky or unknown_needs_human_review in the failure analysis, and fix the test or the app by hand.';

const APPLY = argv.includes('--apply');
const flag = (/** @type {string} */ name) => {
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

// The check above makes the two flags present together or not at all.
if (failureId && candidatePath) {
  exit(await processCandidate(failureId, candidatePath));
}
exit(triage());

// ---------------------------------------------------------------- triage

function triage() {
  if (!existsSync(FA)) {
    console.error(
      `No ${FA}. Run scripts/run-failure-classifier.js or the Failure ` +
        `Classifier Agent first.`
    );
    return 2;
  }
  const fa = JSON.parse(readFileSync(FA, 'utf8'));
  const failures = fa.failures || [];
  /** @type {Record<string, any>[]} */
  const all = failures;
  // A failure is Green for the Healer only if the rule-based draft says so too.
  const draft =
    fa.rule_draft && existsSync(DRAFT_PATH)
      ? JSON.parse(readFileSync(DRAFT_PATH, 'utf8'))
      : null;
  /** @type {Set<string> | null} */
  const draftGreen = draft
    ? new Set(
        (draft.failures ?? [])
          .filter((/** @type {any} */ f) => f.severity === 'green')
          .map((/** @type {any} */ f) => f.failure_id)
      )
    : null;
  const green = all.filter(
    (f) =>
      f.severity === 'green' && (!draftGreen || draftGreen.has(f.failure_id))
  );
  const yellow = all.filter((f) => f.severity === 'yellow');
  const red = all.filter((f) => f.severity === 'red');

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

/**
 * @param {string} failureId
 * @param {string} candidatePath
 */
async function processCandidate(failureId, candidatePath) {
  // --- The current run, and the one failure it names -------------------
  // With --apply the Healer adds its attempts to context.json, so the file
  // must validate before anything runs: an attempt it cannot record there
  // would count only from the deletable record files.
  const ctxRead = APPLY
    ? readValidatedJson(CONTEXT_PATH, CONTEXT_SCHEMA)
    : readJson(CONTEXT_PATH);
  if (!ctxRead.ok) {
    console.error(
      APPLY
        ? `${ctxRead.message}. Refusing: the Healer records each attempt in ${CONTEXT_PATH}.`
        : ctxRead.message
    );
    return APPLY ? 1 : 2;
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
  // Eligibility comes from the rule-based draft, never from a classification
  // the finalizing step changed (scripts/lib/analysis-overrides.js).
  const drift = draftProblems(analysis, '.');
  if (drift.length) {
    console.error(`${FA}: ${drift.join('; ')}. Refusing.`);
    return 1;
  }
  const draft = analysis.rule_draft ? readJson(DRAFT_PATH) : null;
  if (draft && !draft.ok) {
    console.error(`${draft.message}. Refusing.`);
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
    draft: draft?.ok ? draft.data : null,
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
  let found = readAttempts('.', key, context);
  // A record with no context entry (written before context.json kept
  // attempts, or after the entry was removed) is added now, before another
  // attempt is used, so deleting it later gives nothing back.
  if (APPLY && found.recordOnly.length) {
    /** @type {Record<string, any>[]} */
    const entries = [];
    for (const r of found.recordOnly) {
      if (!validateValue(r.record, RECORD_SCHEMA).ok) {
        console.error(
          `${r.path} does not validate against ${RECORD_SCHEMA}, so it cannot be added to ${CONTEXT_PATH}. Refusing.`
        );
        return 1;
      }
      entries.push(attemptEntry(r.record, r.path, r.sha256));
    }
    const added = addAttemptEntries(context.run_id, entries);
    if (!added.ok) {
      console.error(`${added.message} Refusing.`);
      return 1;
    }
    console.log(
      `  Added ${entries.length} attempt(s) found only as record files to ${CONTEXT_PATH}.`
    );
    found = readAttempts('.', key, added.context);
  }
  const prior = found.attempts;
  for (const p of found.problems) console.log(`  Note: ${p}.`);
  const same = prior.find((r) => r.candidate_sha256 === candidateDigest);
  if (same) {
    console.log(
      `\nThis exact candidate was already submitted (attempt ${same.attempt}): ${same.outcome} — ${same.reason}\n` +
        `See ${same.file}. It does not get another attempt.`
    );
    if (same.outcome !== 'validated') return 1;
    const gap = validatedEvidenceGap(same);
    if (gap) {
      console.error(`Not reported as validated: ${gap}.`);
      return 1;
    }
    return 0;
  }
  // An original already seen failing inconsistently in this run is not
  // validated again: rerunning it until it happens to fail 3 of 3 would let
  // a flaky test through. It uses no attempt; it goes to a human.
  const inconsistentPath = join(VALIDATION_DIR, `${failureId}.inconsistent.md`);
  const seen = existsSync(inconsistentPath)
    ? readFileSync(inconsistentPath, 'utf8')
    : '';
  if (
    seen.includes(`- run: ${context.run_id}\n`) &&
    seen.includes(`- original: ${originalDigest}\n`)
  ) {
    console.error(
      `
The unchanged original of ${failureId} was already seen failing inconsistently in this run (${inconsistentPath}). ` +
        HUMAN_NEXT
    );
    return 1;
  }
  const attempt = Math.max(0, ...prior.map((r) => r.attempt)) + 1;
  if (prior.length >= MAX_ATTEMPTS || attempt > MAX_ATTEMPTS) {
    const used = prior.map((r) => `#${r.attempt} ${r.outcome}`).join(', ');
    const msg =
      (prior.length >= MAX_ATTEMPTS
        ? `All ${MAX_ATTEMPTS} submissions for this test in this run are used (${used}). `
        : `No attempt number up to ${MAX_ATTEMPTS} is left for this test in this run (${used}). `) +
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
    const run = (/** @type {string} */ label, /** @type {number} */ repeat) =>
      runSingleTest({
        workspace,
        configPath,
        testPath,
        unit,
        label,
        env,
        timeoutMs,
        repeat,
      });
    // One run of the candidate that records its action targets.
    const recordTargets = (/** @type {string} */ out) =>
      runSingleTest({
        workspace,
        configPath,
        testPath,
        unit,
        label: 'targets',
        env: recordingEnv(out, env),
        timeoutMs,
        repeat: 1,
      });

    console.log(`\nIsolated copy: ${workspace}`);
    // The original must fail every time, at the same place: a test that
    // passes on some runs, or fails in different places, is flaky or broken
    // in a way a locator change does not fix.
    const baseline = run('baseline', BASELINE_RUNS);
    const tally = (/** @type {typeof baseline} */ b, /** @type {number} */ n) =>
      `failed ${b.failed ?? 0}, passed ${b.passed ?? 0}` +
      (n - (b.failed ?? 0) - (b.passed ?? 0) > 0
        ? `, neither ${n - (b.failed ?? 0) - (b.passed ?? 0)}`
        : '') +
      ` of ${n}`;
    console.log(
      `  Baseline (original): ${tally(baseline, BASELINE_RUNS)}` +
        (baseline.failure_locations?.length
          ? ` at ${baseline.failure_locations.join(', ')}`
          : '')
    );
    const consistent =
      baseline.status === 'failed' &&
      baseline.failed === BASELINE_RUNS &&
      baseline.failure_locations?.length === 1;
    if (!consistent) {
      const why =
        baseline.status === 'failed' && baseline.failed === BASELINE_RUNS
          ? `it failed in ${baseline.failure_locations?.length ? `${baseline.failure_locations.length} different places (${baseline.failure_locations.join(', ')})` : 'no place the report names'}`
          : `${baseline.status}, ${tally(baseline, BASELINE_RUNS)}` +
            (baseline.error_excerpt ? `: ${baseline.error_excerpt}` : '');
      const msg =
        `The unchanged original did not fail ${BASELINE_RUNS} of ${BASELINE_RUNS} times at the same place in the isolated copy (${why}). ` +
        'A test that fails only sometimes, or in different places, is not a broken locator; ' +
        'there is nothing to validate the candidate against; no attempt was used.';
      console.error(`${msg} ${HUMAN_NEXT}`);
      // A runner error is not a sign of flakiness; anything else is kept,
      // so this run cannot be asked again until it happens to fail 3 of 3.
      if (baseline.status !== 'runner_error')
        writeTextAtomic(
          inconsistentPath,
          [
            `# ${failureId} — the original fails inconsistently`,
            '',
            msg,
            '',
            `- run: ${context.run_id}`,
            `- original: ${originalDigest}`,
            `- unit: ${unit.unit_id}`,
            '',
            HUMAN_NEXT,
            '',
            'This is not a validation result. The healer refuses this failure for the rest of the run.',
            '',
          ].join('\n')
        );
      return 1;
    }

    writeFileSync(join(workspace, testPath), candidate);
    const rerun = run('candidate', CANDIDATE_RUNS);
    console.log(
      `  Re-run (candidate): ${rerun.status}, passed ${rerun.passed ?? 0} of ${CANDIDATE_RUNS}`
    );

    if (sha256(readFileSync(testPath, 'utf8')) !== originalDigest) {
      console.error(
        'The live test file changed during validation. Nothing is recorded; try again.'
      );
      return 1;
    }

    if (
      rerun.status !== 'passed' ||
      rerun.passed !== CANDIDATE_RUNS ||
      rerun.tests_executed !== CANDIDATE_RUNS
    ) {
      return save({
        ...base,
        outcome: 'validation_failed',
        reason:
          `the test ${rerun.status} with the candidate, passing ${rerun.passed ?? 0} of ${CANDIDATE_RUNS} runs${rerun.error_excerpt ? `: ${rerun.error_excerpt}` : ''}`.slice(
            0,
            500
          ),
        baseline,
        rerun,
        patch: null,
      });
    }

    // The candidate must act on the same elements the test acted on when the
    // repeat check recorded it: the same role and accessible name. One more
    // run, not counted, records the candidate's targets.
    const recordedTargets = targetsOf(
      context.repeat_check?.targets,
      unit.test_title,
      unit.project ?? ''
    );
    const targetsOut = join(workspace, '.targets.jsonl');
    const recording = recordTargets(targetsOut);
    const candidateTargets = existsSync(targetsOut)
      ? targetsOf(
          readTargets(readFileSync(targetsOut, 'utf8')),
          unit.test_title,
          unit.project ?? ''
        )
      : null;
    const targets = compareTargets(recordedTargets, candidateTargets);
    console.log(
      `  Action targets: ${targets.verdict}` +
        (targets.verdict === 'not_recorded'
          ? ' (the repeat check recorded none for this test)'
          : ` over ${targets.actions_compared} action(s)`)
    );
    for (const d of targets.differences) console.log(`    - ${d.why}`);
    if (targets.verdict !== 'not_recorded' && !candidateTargets) {
      return save({
        ...base,
        outcome: 'validation_failed',
        reason:
          `the candidate's action targets could not be recorded (${recording.status}${recording.error_excerpt ? `: ${recording.error_excerpt}` : ''}), so it cannot be held to the elements the test acted on`.slice(
            0,
            500
          ),
        baseline,
        rerun,
        targets,
        patch: null,
      });
    }
    if (targets.verdict === 'different' || targets.verdict === 'yellow') {
      const first = targets.differences[0]?.why ?? '';
      return save({
        ...base,
        outcome: 'validation_failed',
        reason: (targets.verdict === 'yellow'
          ? `Yellow, not a locator repair: ${first}. A person decides whether the test should follow the app.`
          : `the candidate acts on another element than the test did: ${first}`
        ).slice(0, 500),
        baseline,
        rerun,
        targets,
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
        targets,
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
          `eligible under static checks; the original failed ${BASELINE_RUNS} of ${BASELINE_RUNS} runs at ${baseline.failure_locations?.[0]}, and passed ${CANDIDATE_RUNS} of ${CANDIDATE_RUNS} with the candidate, in isolation; ` +
          (targets.verdict === 'same'
            ? `every action acts on the element it acted on before (${targets.actions_compared} compared)`
            : 'no action targets were recorded for this test, so the elements it acts on were not compared'),
        baseline,
        rerun,
        targets,
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

  /**
   * @param {Record<string, any>} record
   * @param {string | null} [patchPath]
   */
  function save(record, patchPath = null) {
    /** @type {Record<string, any>} */
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
    const kept = addAttemptEntries(full.run_id, [
      attemptEntry(full, recordPath, sha256(readFileSync(recordPath))),
    ]);
    if (!kept.ok) {
      console.error(
        `\n${kept.message}\nThe record ${recordPath} is written` +
          (full.patch ? ` and the patch ${full.patch.path} is kept` : '') +
          `, but ${CONTEXT_PATH} does not show the attempt. The next --apply adds it ` +
          'from the record; until then this is not reported as validated.'
      );
      return 1;
    }
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

/**
 * Add healer attempts to context.json `healer_attempts[]`, the durable count
 * that travels with the run. The context is read again just before the write
 * so nothing recorded meanwhile is lost, and the whole file is validated
 * before it replaces the old one.
 * @param {string} runId
 * @param {Record<string, any>[]} entries from attemptEntry()
 * @returns {{ ok: true, context: any } | { ok: false, message: string }}
 */
function addAttemptEntries(runId, entries) {
  const read = readJson(CONTEXT_PATH);
  if (!read.ok) return { ok: false, message: read.message };
  const context = read.data;
  if (context?.run_id !== runId)
    return {
      ok: false,
      message: `${CONTEXT_PATH} no longer belongs to run ${runId}.`,
    };
  if (!Array.isArray(context.healer_attempts)) context.healer_attempts = [];
  context.healer_attempts.push(...entries);
  const wrote = writeJsonAtomic(CONTEXT_PATH, context, {
    schemaPath: CONTEXT_SCHEMA,
  });
  return wrote.ok
    ? { ok: true, context }
    : { ok: false, message: wrote.message };
}

/**
 * Why an earlier "validated" outcome cannot be reported as validated again:
 * its record must back it and its patch must be present with the digest the
 * record gives. Null when the evidence holds.
 * @param {import('./lib/healer-candidate.js').Attempt} a
 * @returns {string | null}
 */
function validatedEvidenceGap(a) {
  if (a.evidence === 'disagrees')
    return `the record of attempt ${a.attempt} (${a.file}) is not what ${CONTEXT_PATH} says`;
  if (a.evidence !== 'intact' && a.evidence !== 'record_only')
    return `the record of attempt ${a.attempt} (${a.file}) is ${a.evidence}`;
  const patch = a.record?.patch;
  if (!patch?.path || !existsSync(patch.path))
    return `the patch of attempt ${a.attempt} (${patch?.path ?? 'none named'}) is missing`;
  if (sha256(readFileSync(patch.path)) !== patch.sha256)
    return `the patch ${patch.path} changed after attempt ${a.attempt} was recorded`;
  return null;
}

/** @param {any} r a schema-valid healer-validation record */
function renderRecord(r) {
  /** @type {(label: string, x: any) => string} */
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
    ...r.static_check.violations.map((/** @type {string} */ v) => `- ${v}`),
    ...r.static_check.repairs.map(
      (/** @type {{ line: number, from: string, to: string }} */ x) =>
        `- line ${x.line}: \`${x.from}\` → \`${x.to}\``
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
