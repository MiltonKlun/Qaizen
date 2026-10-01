#!/usr/bin/env node
// @ts-check
// Print a release report's execution_summary, derived from the execution
// ledger (task group 2.2b).
//
// The Reporter used to compute the counts itself from the ledger, by hand. A
// release report 2.0 carries them as numbers the code derives: the legacy
// projection, the strict pass rate (null when nothing ran), and the
// per-outcome breakdown that explains it, split into e2e / api / combined when
// a Newman run happened. The Reporter copies this output verbatim, and the
// runner refuses a 2.0 report whose execution_summary differs from it
// (scripts/lib/run-artifacts.js).
//
// Usage:
//   node scripts/report-summary.js                      # the ledger the analysis names
//   node scripts/report-summary.js --ledger <path>      # a specific ledger
//   node scripts/report-summary.js --analysis <path>    # the ledger this analysis names
//
// Exit codes: 0 printed · 1 the ledger is invalid or inconsistent · 2 usage
//             or a missing input

import { existsSync } from 'node:fs';
import { argv, exit } from 'node:process';

import { readJson } from './lib/artifact-io.js';
import { parseCliOrExit } from './lib/cli.js';
import { readLedger, releaseExecutionSummary } from './lib/execution-ledger.js';

const DEFAULT_ANALYSIS = 'analysis/failure-analysis.json';
const DEFAULT_LEDGER = 'analysis/execution-ledger.json';

const cli = parseCliOrExit(argv.slice(2), {
  usage:
    'Usage: node scripts/report-summary.js [--ledger <path> | --analysis <path>]',
  options: { ledger: { type: 'string' }, analysis: { type: 'string' } },
  exclusive: [['ledger', 'analysis']],
});

/** The ledger to read: given, or the one the failure analysis names. */
function ledgerPath() {
  const given = /** @type {string | undefined} */ (cli.values.ledger);
  if (given) return given;
  const analysisPath =
    /** @type {string | undefined} */ (cli.values.analysis) ?? DEFAULT_ANALYSIS;
  if (!existsSync(analysisPath)) {
    if (cli.values.analysis) {
      console.error(`Error: ${analysisPath} does not exist.`);
      exit(2);
    }
    return DEFAULT_LEDGER;
  }
  const analysis = readJson(analysisPath);
  if (!analysis.ok) {
    console.error(`Error: ${analysis.message}`);
    exit(2);
  }
  return analysis.data.execution_ledger ?? DEFAULT_LEDGER;
}

const path = ledgerPath();
if (!existsSync(path)) {
  console.error(
    `Error: no execution ledger at ${path}. Normalize the run first (npm run normalize).`
  );
  exit(2);
}
const ledger = readLedger(path);
if (!ledger.ok) {
  console.error(`Error: ${path}: ${ledger.message}`);
  const violations = 'violations' in ledger ? ledger.violations : [];
  for (const v of violations) console.error(`  - ${v}`);
  exit(1);
}
console.log(JSON.stringify(releaseExecutionSummary(ledger.data), null, 2));
