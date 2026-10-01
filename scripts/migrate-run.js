#!/usr/bin/env node
// @ts-check
// Migrate the ACTIVE run's artifacts to the current contracts, in one
// explicit, idempotent command (task group 2.2b).
//
// Each contract change shipped its own migration script; this runs the ones
// that apply to the run at the repository root, in order, on the files its
// context.json names:
//
//   1. context.json   gate values to audit objects (migrate-context-v1-to-v2)
//                     and the gate_decisions[] log (migrate-context-gate-decisions)
//   2. test cases     testlink_id mirrored into external_ids
//                     (migrate-testcases-external-ids)
//   3. release report the derived rollups, for a 1.x report
//                     (migrate-release-report-tg12)
//
// What it never does:
//   * Bind an approval. A migrated gate keeps its decision but gains no digest
//     of reviewed inputs, so an approval made before binding is a LEGACY
//     approval: the runner returns it to pending, and a human re-reviews it
//     before anything executes. This command lists those gates.
//   * Rewrite evidence. A 1.x failure analysis or release report keeps its
//     original meaning; a 2.x analysis is produced from a ledger
//     (npm run normalize, npm run classify), never converted from 1.x.
//   * Touch runs/. Archives stay valid under the rules they were written
//     with and are not bulk-migrated.
//
// Running it twice changes nothing the second time.
//
// Usage:
//   node scripts/migrate-run.js            # dry run: what each step would change
//   node scripts/migrate-run.js --apply    # write the changes
//
// Exit codes: 0 done (or nothing to do) · 1 a step failed · 2 usage error,
//             no active run, or a new-story transition is pending

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

import { readJson } from './lib/artifact-io.js';
import { findInvalidations } from './lib/approval-binding.js';
import { parseCliOrExit } from './lib/cli.js';
import { readTransition, TRANSITION_FILE } from './lib/run-lifecycle.js';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

const cli = parseCliOrExit(argv.slice(2), {
  usage: 'Usage: node scripts/migrate-run.js [--apply]',
  options: { apply: { type: 'boolean' } },
});
const APPLY = cli.values.apply === true;

if (!existsSync('context.json')) {
  console.error('No context.json: there is no active run to migrate.');
  exit(2);
}
const pending = readTransition('.');
if (pending && pending.phase !== 'installed') {
  console.error(
    `A new-story transition is pending (${TRANSITION_FILE}). Finish or undo it first: npm run pipeline -- --resume`
  );
  exit(2);
}

/** @returns {import('./lib/approval-binding.js').Context} */
function loadContext() {
  const r = readJson('context.json');
  if (!r.ok) {
    console.error(`context.json: ${r.message}`);
    exit(2);
  }
  return r.data;
}

/**
 * Run one migration script, indenting its output.
 * @param {string} label
 * @param {string} script
 * @param {string[]} args
 */
function step(label, script, args) {
  console.log(`\n${label}`);
  const r = spawnSync(
    process.execPath,
    [join(SCRIPTS, script), ...args, ...(APPLY ? ['--apply'] : [])],
    { encoding: 'utf8' }
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd();
  if (out) console.log(out.replace(/^/gm, '  '));
  if (r.status !== 0) {
    console.error(`  ${script} exited ${r.status}.`);
    return false;
  }
  return true;
}

/** @param {string} label @param {string} why */
const skip = (label, why) => console.log(`\n${label}\n  skipped: ${why}`);

console.log(
  APPLY
    ? 'Migrating the active run (writing changes).'
    : 'Dry run: nothing is written. Re-run with --apply to write the changes.'
);

let ok = true;
ok =
  step('1. context.json: gate audit objects', 'migrate-context-v1-to-v2.js', [
    'context.json',
  ]) && ok;
ok =
  step(
    '   context.json: gate_decisions[] log',
    'migrate-context-gate-decisions.js',
    ['context.json']
  ) && ok;

const paths = loadContext().artifact_paths ?? {};
const tc = paths.test_cases;
if (typeof tc === 'string' && tc && existsSync(tc)) {
  ok =
    step(`2. ${tc}: external ids`, 'migrate-testcases-external-ids.js', [tc]) &&
    ok;
} else {
  skip('2. test cases', 'the run names no existing test-cases file');
}

const report = paths.release_report_json;
const reportDoc =
  typeof report === 'string' && report && existsSync(report)
    ? readJson(report)
    : null;
if (!reportDoc) {
  skip('3. release report', 'the run has no release report yet');
} else if (!reportDoc.ok) {
  skip(
    '3. release report',
    `${report} is not readable JSON (${reportDoc.message})`
  );
} else if (/^2\./.test(String(reportDoc.data.schema_version))) {
  skip('3. release report', `${report} is already 2.x`);
} else {
  ok =
    step(
      `3. ${report}: derived rollups (1.x)`,
      'migrate-release-report-tg12.js',
      [report, 'context.json']
    ) && ok;
}

const fa = paths.failure_analysis;
const faDoc =
  typeof fa === 'string' && fa && existsSync(fa) ? readJson(fa) : null;
if (faDoc?.ok && !/^2\./.test(String(faDoc.data.schema_version))) {
  console.log(
    `\n${fa} is a 1.x analysis. It stays valid with its original meaning; it is not` +
      '\nconverted. A 2.x analysis is produced from the execution ledger:' +
      '\n  npm run normalize -- --story <id> ... && npm run classify' +
      '\nand then finalized by the Failure Classifier.'
  );
}

// Approvals that need a human again: legacy (made before binding) and stale
// ones, with the gates downstream of them. Never re-bound here.
const reReview = findInvalidations(loadContext(), '.');
if (reReview.length) {
  console.log(
    `\n${reReview.length} approval(s) need human re-review before anything executes.` +
      '\nThe next `npm run pipeline -- --resume` returns them to pending; this migration' +
      '\nnever binds an approval to the current inputs:'
  );
  for (const r of reReview) console.log(`  - ${r.gate}: ${r.reason}`);
} else {
  console.log('\nNo approval needs re-review.');
}

if (!ok) {
  console.error(
    '\nA migration step failed (see above); the other steps still ran.'
  );
  exit(1);
}
exit(0);
