// @ts-check
// Candidate processing for the Healer.
//
// The Healer does not write fixes; a person or an agent proposes a candidate
// file. This module is the explicit boundary that processes it:
//
//   resolveTarget   which live test file and which single test a failure is,
//                   from the current run's context, ledger and analysis;
//   attempts        the three-submission cap, counted from context.json and
//                   the record files together, and outcome reuse;
//   workspace       a task-owned copy of just the sources the test needs;
//   runSingleTest   run exactly that one test there and read the outcome;
//   buildPatch      a unified diff, proven by applying it to a copy.
//
// Nothing here edits the live suite, commits, or approves anything. The
// workspace is a filesystem separation, not a security sandbox: the test code
// runs with the caller's privileges and environment.

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { playwrightCli } from './cli.js';
import { adaptPlaywrightReport } from './execution-results.js';
import { sanitizeDiagnostic } from './integration-io.js';
import { importClosure } from './import-closure.js';

export const MAX_ATTEMPTS = 3;
export const VALIDATION_DIR = 'analysis/healer-validation';
export const PATCH_DIR = 'release/healer-patches';
export const WORKSPACE_ROOT = '.healer-workspace';

/** @typedef {import('./execution-ledger.js').Unit} Unit */
/** @typedef {import('./execution-ledger.js').Ledger} Ledger */
/**
 * The single unit a candidate is validated against.
 * @typedef {{ unit_id: string, file: string, project: string,
 *   test_title: string, repeat_index: number }} TargetUnit
 */

export const sha256 = (/** @type {string | Buffer} */ buf) =>
  createHash('sha256').update(buf).digest('hex');
const posix = (/** @type {string} */ p) => p.split(sep).join('/');

// ---------------------------------------------------------------- target

/**
 * Resolve a failure to the live test file and the single unit it names.
 * Every check here happens before anything runs.
 *
 * @param {object} args
 * @param {import('./approval-binding.js').Context} args.context
 * @param {{ failures?: any[] }} args.analysis parsed failure analysis
 * @param {{ failures?: any[] } | null} [args.draft] its rule-based draft, when
 *   the analysis names one: eligibility comes from the draft, so a finalized
 *   analysis cannot make a failure Green
 * @param {Pick<Ledger, 'units'>} args.ledger
 * @param {string} args.failureId
 * @param {string} [args.root]
 * @returns {{ok: true, failure: any, unit: TargetUnit, testPath: string}
 *   | {ok: false, reason: string}}
 */
export function resolveTarget({
  context,
  analysis,
  draft = null,
  ledger,
  failureId,
  root = '.',
}) {
  const failure = (analysis.failures ?? []).find(
    (f) => f.failure_id === failureId
  );
  if (!failure) {
    return {
      ok: false,
      reason: `${failureId} is not a failure of the current analysis`,
    };
  }
  if (failure.source !== 'playwright') {
    return {
      ok: false,
      reason: `${failureId} is a ${failure.source ?? 'non-Playwright'} failure; the Healer never touches API/Newman tests`,
    };
  }
  if (failure.severity !== 'green') {
    return {
      ok: false,
      reason: `${failureId} is ${failure.severity ?? 'unclassified'}, not Green; only Green failures take a candidate (Yellow is a suggestion, Red is a bug draft)`,
    };
  }
  if (draft) {
    const rule = (draft.failures ?? []).find((f) => f.failure_id === failureId);
    if (rule?.severity !== 'green') {
      return {
        ok: false,
        reason: `${failureId} is ${rule?.severity ?? 'absent'} in the rule-based draft; a finalized analysis cannot make a failure Green for the Healer`,
      };
    }
  }
  if (!failure.unit_id) {
    return {
      ok: false,
      reason: `${failureId} is not linked to an executed unit`,
    };
  }
  const matches = (ledger.units ?? []).filter(
    (u) => u.unit_id === failure.unit_id
  );
  if (matches.length !== 1) {
    return {
      ok: false,
      reason: `${failureId} names unit ${failure.unit_id}, which the ledger holds ${matches.length} times; the test to re-run is ambiguous`,
    };
  }
  const unit = matches[0];
  const id = unit.identity ?? {};
  if (id.kind !== 'playwright' || !id.file || !id.test_title) {
    return {
      ok: false,
      reason: `unit ${unit.unit_id} has no Playwright file and title to re-run`,
    };
  }
  if ((id.repeat_index ?? 0) !== 0) {
    return {
      ok: false,
      reason: `unit ${unit.unit_id} is repeat ${id.repeat_index}; only the first repeat can be re-run exactly`,
    };
  }
  const testPath = context.artifact_paths?.generated_test;
  if (!testPath || !existsSync(join(root, testPath))) {
    return {
      ok: false,
      reason: 'context.json names no existing generated test',
    };
  }
  if (!posix(testPath).endsWith(posix(id.file))) {
    return {
      ok: false,
      reason: `unit ${unit.unit_id} ran ${id.file}, which is not the run's generated test ${testPath}`,
    };
  }
  return {
    ok: true,
    failure,
    testPath,
    unit: {
      unit_id: unit.unit_id,
      file: id.file,
      project: id.project ?? '',
      test_title: id.test_title,
      repeat_index: 0,
    },
  };
}

// ---------------------------------------------------------------- attempts

/**
 * One used attempt, from context.json, a record file, or both. `evidence`
 * says how far its record backs it: intact (the record exists, matches the
 * digest in context.json and agrees with the entry), record_only (no context
 * entry yet), missing, changed (the bytes differ from the recorded digest) or
 * disagrees (the bytes match but the entry says something else).
 * @typedef {{ attempt: number, candidate_sha256: string, outcome: string,
 *   reason: string, file: string,
 *   evidence: 'intact' | 'record_only' | 'missing' | 'changed' | 'disagrees',
 *   record: any }} Attempt
 */

/**
 * A record file that has no context entry yet, with what an entry needs.
 * @typedef {{ record: any, path: string, sha256: string }} RecordOnly
 */

/**
 * Every attempt already used for this failure's unit. Two stores count: the
 * entries in context.json `healer_attempts[]` (archived with the run) and the
 * record files in analysis/healer-validation/. An attempt in either one is
 * used. Where both have an attempt, the context entry is what counts, and a
 * record that no longer backs it is reported. A record with no entry is
 * returned in `recordOnly`, so the caller can add it to context.json before
 * it uses another attempt.
 * @param {string} root
 * @param {{ runId: string, originalDigest: string, unitId: string }} key
 * @param {any} context the run's parsed context.json
 * @returns {{ attempts: Attempt[], problems: string[], recordOnly: RecordOnly[] }}
 */
export function readAttempts(root, key, context) {
  /** @type {Map<number, Attempt & { record_sha256?: string, failure_id?: string }>} */
  const byNumber = new Map();
  /** @type {string[]} */
  const problems = [];
  /** @type {RecordOnly[]} */
  const recordOnly = [];
  const entries = Array.isArray(context?.healer_attempts)
    ? context.healer_attempts
    : [];
  for (const e of entries) {
    if (
      e?.run_id !== key.runId ||
      e.original_sha256 !== key.originalDigest ||
      e.unit_id !== key.unitId ||
      !Number.isInteger(e.attempt)
    )
      continue;
    if (byNumber.has(e.attempt)) {
      problems.push(
        `context.json healer_attempts[] has attempt ${e.attempt} more than once; the first counts`
      );
      continue;
    }
    byNumber.set(e.attempt, {
      attempt: e.attempt,
      candidate_sha256: e.candidate_sha256,
      outcome: e.outcome,
      reason: e.reason,
      file: e.record?.path ?? '(no record named)',
      record_sha256: e.record?.sha256,
      failure_id: e.failure_id,
      evidence: 'missing',
      record: null,
    });
  }

  const dir = join(root, VALIDATION_DIR);
  for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
    const named = /\.attempt-(\d+)\.json$/.exec(name);
    if (!named) continue;
    const file = posix(join(VALIDATION_DIR, name));
    let bytes;
    let r;
    try {
      bytes = readFileSync(join(dir, name));
      r = JSON.parse(bytes.toString('utf8'));
    } catch {
      // A record that does not parse is not evidence either way; the
      // validators report it. It does not grant or consume attempts.
      continue;
    }
    if (
      r?.record_type !== 'candidate_validation' ||
      r.run_id !== key.runId ||
      r.original?.sha256 !== key.originalDigest ||
      r.unit?.unit_id !== key.unitId ||
      !Number.isInteger(r.attempt)
    )
      continue;
    if (Number(named[1]) !== r.attempt)
      problems.push(
        `${file} says it is attempt ${r.attempt}; it counts as attempt ${r.attempt}`
      );
    const entry = byNumber.get(r.attempt);
    if (!entry) {
      problems.push(
        `attempt ${r.attempt} is in ${file} but not in context.json healer_attempts[]`
      );
      byNumber.set(r.attempt, {
        attempt: r.attempt,
        candidate_sha256: r.candidate?.sha256,
        outcome: r.outcome,
        reason: r.reason,
        file,
        evidence: 'record_only',
        record: r,
      });
      recordOnly.push({ record: r, path: file, sha256: sha256(bytes) });
    } else if (entry.file !== file) {
      problems.push(
        `${file} also claims attempt ${r.attempt}, which context.json gives to ${entry.file}`
      );
    } else if (entry.record_sha256 !== sha256(bytes)) {
      entry.evidence = 'changed';
      problems.push(
        `${file} changed after attempt ${r.attempt} was recorded; context.json is what counts`
      );
    } else {
      /** @type {[string, unknown, unknown][]} */
      const fields = [
        ['candidate', r.candidate?.sha256, entry.candidate_sha256],
        ['outcome', r.outcome, entry.outcome],
        ['failure', r.failure_id, entry.failure_id],
      ];
      const differs = fields.filter(([, a, b]) => a !== b);
      entry.record = r;
      if (differs.length) {
        entry.evidence = 'disagrees';
        problems.push(
          `context.json disagrees with ${file} on attempt ${r.attempt} (${differs.map(([k]) => k).join(', ')})`
        );
      } else entry.evidence = 'intact';
    }
  }
  /** @type {Attempt[]} */
  const attempts = [];
  for (const a of byNumber.values()) {
    if (a.evidence === 'missing')
      problems.push(
        `the record of attempt ${a.attempt} (${a.file}) is missing; the attempt still counts`
      );
    attempts.push({
      attempt: a.attempt,
      candidate_sha256: a.candidate_sha256,
      outcome: a.outcome,
      reason: a.reason,
      file: a.file,
      evidence: a.evidence,
      record: a.record,
    });
  }
  attempts.sort((a, b) => a.attempt - b.attempt);
  return { attempts, problems, recordOnly };
}

/**
 * The context.json entry for a saved healer-validation record.
 * @param {any} record a schema-valid healer-validation record
 * @param {string} path the record file, repository-relative
 * @param {string} digest SHA-256 of the record file's bytes
 */
export function attemptEntry(record, path, digest) {
  return {
    run_id: record.run_id,
    failure_id: record.failure_id,
    unit_id: record.unit.unit_id,
    original_sha256: record.original.sha256,
    candidate_sha256: record.candidate.sha256,
    attempt: record.attempt,
    outcome: record.outcome,
    reason: record.reason,
    record: { path: posix(path), sha256: digest },
    recorded_at: record.created_at,
  };
}

/**
 * Keep the healer attempts another process wrote to context.json since this
 * copy was read. The runner holds context.json in memory across prompts; run
 * in another terminal, the Healer may add an attempt meanwhile, and writing
 * the older copy back would drop it. Mutates and returns `context`.
 * @param {any} context the copy about to be written
 * @param {any} onDisk the current context.json, parsed (or null)
 */
export function keepHealerAttempts(context, onDisk) {
  const theirs = Array.isArray(onDisk?.healer_attempts)
    ? onDisk.healer_attempts
    : [];
  if (!theirs.length || onDisk?.run_id !== context?.run_id) return context;
  if (!Array.isArray(context.healer_attempts)) context.healer_attempts = [];
  const id = (/** @type {any} */ e) =>
    JSON.stringify([e?.run_id, e?.unit_id, e?.original_sha256, e?.attempt]);
  const have = new Set(context.healer_attempts.map(id));
  for (const e of theirs) {
    if (!have.has(id(e))) {
      context.healer_attempts.push(e);
      have.add(id(e));
    }
  }
  return context;
}

// ---------------------------------------------------------------- workspace

/**
 * The files a single test needs: the config, the test, everything they import
 * relatively (transitively), and package.json for module resolution. Only
 * code inside the repository is copied; secrets and state never are.
 * @param {string} root
 * @param {string} configPath
 * @param {string} testPath
 */
export function collectSources(root, configPath, testPath) {
  const { files, problems } = importClosure(root, [configPath, testPath]);
  if (existsSync(join(root, 'package.json')) && !files.includes('package.json'))
    files.push('package.json');
  return { files, problems };
}

/**
 * Create a task-owned workspace inside the repository and copy the sources.
 * @param {string} root
 * @param {string} label
 * @param {string[]} files
 */
export function createWorkspace(root, label, files) {
  // Absolute: the runner's child process works inside it, so a relative path
  // would be resolved twice.
  const dir = resolve(
    root,
    WORKSPACE_ROOT,
    `${label}-${randomUUID().slice(0, 8)}`
  );
  for (const rel of files) {
    const dst = join(dir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(root, rel), dst);
  }
  return dir;
}

/** @param {string} dir */
export function removeWorkspace(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover workspace is ignored by git and harmless.
  }
}

// ---------------------------------------------------------------- run

// The Playwright CLI to invoke (QAIZEN_PLAYWRIGHT_CLI, or the installed one),
// shared with the pipeline runner.
export { playwrightCli };

const escapeRe = (/** @type {string} */ s) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Runs of the unchanged original: each must fail, at the same place. */
export const BASELINE_RUNS = 3;
/** Runs with the candidate: each must pass. */
export const CANDIDATE_RUNS = 5;

/**
 * Where each failing run of a report failed, as `file:line:column` relative to
 * the workspace, in order of first appearance.
 * @param {any} report parsed Playwright JSON report
 * @param {string} workspace
 * @returns {string[]}
 */
export function failureLocations(report, workspace) {
  /** @type {string[]} */
  const out = [];
  /** @param {any} suite */
  const walk = (suite) => {
    for (const spec of suite?.specs ?? [])
      for (const t of spec.tests ?? [])
        for (const r of t.results ?? []) {
          const loc = r.error?.location ?? r.errors?.[0]?.location;
          if (!loc?.file) continue;
          const where = `${posix(relative(workspace, loc.file))}:${loc.line}:${loc.column}`;
          if (!out.includes(where)) out.push(where);
        }
    for (const child of suite?.suites ?? []) walk(child);
  };
  for (const s of report?.suites ?? []) walk(s);
  return out;
}

/**
 * Run exactly one test in the workspace `repeat` times, with retries and
 * snapshot updates pinned off, and read its outcome from the JSON report: the
 * status across the runs (passed or failed when every run did, flaky when they
 * disagree), how many passed and failed, and where the failing runs failed.
 *
 * @param {object} args
 * @param {string} args.workspace
 * @param {string} args.configPath
 * @param {string} args.testPath
 * @param {TargetUnit} args.unit
 * @param {string} args.label
 * @param {Record<string, string | undefined>} [args.env]
 * @param {number} [args.timeoutMs]
 * @param {number} [args.repeat] how many times to run it (default 1)
 * @returns {{status: string, tests_executed: number, command: string,
 *   exit_code: number|null, error_excerpt?: string, runs?: number,
 *   passed?: number, failed?: number, failure_locations?: string[]}}
 */
export function runSingleTest({
  workspace,
  configPath,
  testPath,
  unit,
  label,
  env = process.env,
  timeoutMs = 300000,
  repeat = 1,
}) {
  const reportPath = join(workspace, `.report-${label}.json`);
  const title = unit.test_title.split(' > ').pop() ?? unit.test_title;
  const args = [
    'test',
    posix(testPath),
    '--config',
    posix(configPath),
    '--grep',
    `${escapeRe(title)}$`,
    '--repeat-each',
    String(repeat),
    '--retries',
    '0',
    '--workers',
    '1',
    '--reporter',
    'json',
  ];
  if (unit.project) args.push('--project', unit.project);
  const command = `playwright ${args.join(' ')}`;

  const r = spawnSync(process.execPath, [playwrightCli(env), ...args], {
    cwd: workspace,
    env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
    encoding: 'utf8',
    shell: false,
    timeout: timeoutMs,
  });
  const base = { command, exit_code: r.status };
  if (r.error) {
    return {
      ...base,
      status: 'runner_error',
      tests_executed: 0,
      error_excerpt: sanitizeDiagnostic(r.error.message),
    };
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    return {
      ...base,
      status: 'runner_error',
      tests_executed: 0,
      error_excerpt: sanitizeDiagnostic(
        r.stderr || r.stdout || 'no report was written'
      ),
    };
  }
  /** @type {Unit[]} */
  const units = adaptPlaywrightReport(report, { executionId: label }).units;
  const executed = units.filter((u) => u.outcome !== 'not_run');
  if (
    units.length !== repeat ||
    units.some((u) => u.identity.test_title !== unit.test_title)
  ) {
    return {
      ...base,
      status: 'no_single_test',
      tests_executed: units.length,
      error_excerpt: sanitizeDiagnostic(
        `expected exactly ${repeat} run(s) of "${unit.test_title}", got ${units.map((u) => `"${u.identity.test_title}"`).join(', ') || 'no test'}`
      ),
    };
  }
  const passed = units.filter((u) => u.outcome === 'passed').length;
  const failed = units.filter((u) => u.outcome === 'failed').length;
  const status =
    repeat === 1
      ? units[0].outcome
      : passed === repeat
        ? 'passed'
        : failed === repeat
          ? 'failed'
          : passed > 0 && failed > 0
            ? 'flaky'
            : (units.find((u) => u.outcome !== 'passed')?.outcome ?? 'failed');
  const message = units
    .flatMap((u) => u.attempts ?? [])
    .map((a) => a.error_message)
    .find(Boolean);
  return {
    ...base,
    status,
    tests_executed: executed.length,
    runs: repeat,
    passed,
    failed,
    failure_locations: failureLocations(report, workspace).slice(0, 5),
    ...(message
      ? { error_excerpt: sanitizeDiagnostic(message).slice(0, 400) }
      : {}),
  };
}

// ---------------------------------------------------------------- patch

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function git(args, cwd) {
  // The workspace lives inside the repository. Without a ceiling, git would
  // find the enclosing repo and resolve patch paths from its root, silently
  // skipping files outside `cwd`. With it, `cwd` is a plain directory.
  return spawnSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(resolve(cwd)) },
  });
}

/**
 * A unified diff from original to candidate for `relPath`, proven by applying
 * it to a copy of the original and comparing the result with the candidate.
 * @param {{ workspace: string, relPath: string, original: string,
 *   candidate: string }} args
 * @returns {{ok: true, patch: string} | {ok: false, reason: string}}
 */
export function buildPatch({ workspace, relPath, original, candidate }) {
  const dir = join(workspace, '.patch');
  const a = join(dir, 'a');
  const b = join(dir, 'b');
  mkdirSync(dir, { recursive: true });
  writeFileSync(a, original);
  writeFileSync(b, candidate);
  const d = git(
    ['diff', '--no-index', '--no-color', '--full-index', '--', 'a', 'b'],
    dir
  );
  if (d.status !== 1 || !d.stdout) {
    return {
      ok: false,
      reason: `could not produce a diff (git exit ${d.status})`,
    };
  }
  const p = posix(relPath);
  const patch = d.stdout
    .replace(/^diff --git a\/a b\/b$/m, `diff --git a/${p} b/${p}`)
    .replace(/^--- a\/a$/m, `--- a/${p}`)
    .replace(/^\+\+\+ b\/b$/m, `+++ b/${p}`);

  const applyDir = join(dir, 'apply');
  mkdirSync(join(applyDir, dirname(p)), { recursive: true });
  writeFileSync(join(applyDir, p), original);
  const patchFile = join(dir, 'candidate.patch');
  writeFileSync(patchFile, patch);
  const check = git(['apply', '--check', patchFile], applyDir);
  if (check.status !== 0) {
    return {
      ok: false,
      reason: `the patch does not apply: ${sanitizeDiagnostic(check.stderr)}`,
    };
  }
  const applied = git(['apply', patchFile], applyDir);
  if (
    applied.status !== 0 ||
    !readFileSync(join(applyDir, p)).equals(Buffer.from(candidate))
  ) {
    return {
      ok: false,
      reason: 'applying the patch does not reproduce the candidate exactly',
    };
  }
  return { ok: true, patch };
}
