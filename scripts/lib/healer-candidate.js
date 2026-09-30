// @ts-check
// Candidate processing for the Healer (task group 6.3, review finding S3).
//
// The Healer does not write fixes; a person or an agent proposes a candidate
// file. This module is the explicit boundary that processes it:
//
//   resolveTarget   which live test file and which single test a failure is,
//                   from the current run's context, ledger and analysis;
//   attempts        the persisted three-submission cap and outcome reuse;
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
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import { playwrightCli } from './cli.js';
import { adaptPlaywrightReport } from './execution-results.js';
import { sanitizeDiagnostic } from './integration-io.js';
import { parseTestSource, ts, visit } from './test-source.js';

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
 * @param {Pick<Ledger, 'units'>} args.ledger
 * @param {string} args.failureId
 * @param {string} [args.root]
 * @returns {{ok: true, failure: any, unit: TargetUnit, testPath: string}
 *   | {ok: false, reason: string}}
 */
export function resolveTarget({
  context,
  analysis,
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
 * Every candidate record already written for this failure's unit.
 * @param {string} root
 * @param {{ runId: string, originalDigest: string, unitId: string }} key
 * @returns {any[]} the parsed records, each with its `file`
 */
export function readAttempts(root, key) {
  const dir = join(root, VALIDATION_DIR);
  if (!existsSync(dir)) return [];
  /** @type {any[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!/\.attempt-\d+\.json$/.test(name)) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (
        r.record_type === 'candidate_validation' &&
        r.run_id === key.runId &&
        r.original?.sha256 === key.originalDigest &&
        r.unit?.unit_id === key.unitId
      ) {
        out.push({ ...r, file: join(VALIDATION_DIR, name) });
      }
    } catch {
      // A record that does not parse is not evidence either way; the
      // validators report it. It does not grant or consume attempts.
    }
  }
  return out.sort((a, b) => a.attempt - b.attempt);
}

// ---------------------------------------------------------------- workspace

const CODE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/**
 * Relative module specifiers a source file imports (static, dynamic, re-export).
 * @param {string} text
 * @param {string} fileName
 * @returns {string[]}
 */
function relativeImports(text, fileName) {
  const parsed = parseTestSource(text, fileName);
  if (!parsed.ok) return [];
  /** @type {string[]} */
  const specs = [];
  visit(parsed.sourceFile, (/** @type {import('typescript').Node} */ n) => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      specs.push(n.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === 'require')) &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      specs.push(n.arguments[0].text);
    }
  });
  return specs.filter((s) => s.startsWith('./') || s.startsWith('../'));
}

/**
 * @param {string} fromFile
 * @param {string} spec
 * @returns {string | null}
 */
function resolveModule(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const tries = [
    base,
    ...CODE_EXT.map((e) => base + e),
    ...CODE_EXT.map((e) => join(base, `index${e}`)),
  ];
  // `./x.js` written for a TS source compiled on the fly.
  if (extname(base) === '.js') tries.push(base.slice(0, -3) + '.ts');
  return tries.find((p) => existsSync(p) && !readdirSafe(p)) ?? null;
}

/** @param {string} p */
function readdirSafe(p) {
  try {
    readdirSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The files a single test needs: the config, the test, everything they import
 * relatively (transitively), and package.json for module resolution. Only
 * code inside the repository is copied; secrets and state never are.
 * @param {string} root
 * @param {string} configPath
 * @param {string} testPath
 */
export function collectSources(root, configPath, testPath) {
  const rootAbs = resolve(root);
  /** @type {Set<string>} */
  const wanted = new Set();
  const queue = [resolve(rootAbs, configPath), resolve(rootAbs, testPath)];
  /** @type {string[]} */
  const problems = [];
  for (let abs = queue.shift(); abs !== undefined; abs = queue.shift()) {
    const rel = relative(rootAbs, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      problems.push(`${abs} is outside the repository`);
      continue;
    }
    if (/^\.env/.test(basename(abs))) {
      problems.push(
        `${rel} looks like an environment file and is never copied`
      );
      continue;
    }
    if (wanted.has(rel)) continue;
    wanted.add(rel);
    for (const spec of relativeImports(readFileSync(abs, 'utf8'), abs)) {
      const target = resolveModule(abs, spec);
      if (target) queue.push(target);
      else problems.push(`${rel} imports ${spec}, which cannot be resolved`);
    }
  }
  if (existsSync(join(rootAbs, 'package.json'))) wanted.add('package.json');
  return { files: [...wanted].map(posix), problems };
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

/**
 * Run exactly one test in the workspace, with retries, repeats and snapshot
 * updates pinned off, and read its outcome from the JSON report.
 *
 * @param {object} args
 * @param {string} args.workspace
 * @param {string} args.configPath
 * @param {string} args.testPath
 * @param {TargetUnit} args.unit
 * @param {string} args.label
 * @param {Record<string, string | undefined>} [args.env]
 * @param {number} [args.timeoutMs]
 * @returns {{status: string, tests_executed: number, command: string,
 *   exit_code: number|null, error_excerpt?: string}}
 */
export function runSingleTest({
  workspace,
  configPath,
  testPath,
  unit,
  label,
  env = process.env,
  timeoutMs = 300000,
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
    '1',
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
  if (units.length !== 1 || units[0].identity.test_title !== unit.test_title) {
    return {
      ...base,
      status: 'no_single_test',
      tests_executed: units.length,
      error_excerpt: sanitizeDiagnostic(
        `expected exactly "${unit.test_title}", got ${units.map((u) => `"${u.identity.test_title}"`).join(', ') || 'no test'}`
      ),
    };
  }
  const u = units[0];
  const message = (u.attempts ?? []).map((a) => a.error_message).find(Boolean);
  return {
    ...base,
    status: u.outcome,
    tests_executed: executed.length,
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
