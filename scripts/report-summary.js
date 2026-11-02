#!/usr/bin/env node
// @ts-check
// Print what a release report must say about execution, derived from the
// execution ledger: its execution_summary, or (with --coverage) its
// coverage_by_risk.
//
// The Reporter used to compute both by hand. A release report 2.0 carries the
// counts as numbers the code derives: the legacy projection, the strict pass
// rate (null when nothing ran), and the per-outcome breakdown that explains it,
// split into e2e / api / combined when a Newman run happened. Each risk's
// coverage comes from the approved test cases that reference it and their
// outcomes in the ledger (scripts/lib/risk-coverage.js). The Reporter copies
// this output, and the runner refuses a 2.0 report that contradicts it
// (scripts/lib/run-artifacts.js).
//
// Usage:
//   node scripts/report-summary.js                      # the ledger the analysis names
//   node scripts/report-summary.js --ledger <path>      # a specific ledger
//   node scripts/report-summary.js --analysis <path>    # the ledger this analysis names
//   node scripts/report-summary.js --coverage [--context <path>] [--test-cases <path>]
//       # coverage_by_risk; risks from context.json, cases from the test cases
//       # the context names
//
// Exit codes: 0 printed · 1 the ledger is invalid or inconsistent · 2 usage
//             or a missing input

import { existsSync } from 'node:fs';
import { argv, exit } from 'node:process';

import { readJson } from './lib/artifact-io.js';
import { parseCliOrExit } from './lib/cli.js';
import { readLedger, releaseExecutionSummary } from './lib/execution-ledger.js';
import { notPassingReason, riskCoverage } from './lib/risk-coverage.js';

const DEFAULT_ANALYSIS = 'analysis/failure-analysis.json';
const DEFAULT_LEDGER = 'analysis/execution-ledger.json';
const DEFAULT_CONTEXT = 'context.json';

const cli = parseCliOrExit(argv.slice(2), {
  usage:
    'Usage: node scripts/report-summary.js [--ledger <path> | --analysis <path>] ' +
    '[--coverage [--context <path>] [--test-cases <path>]]',
  options: {
    ledger: { type: 'string' },
    analysis: { type: 'string' },
    coverage: { type: 'boolean' },
    context: { type: 'string' },
    'test-cases': { type: 'string' },
  },
  exclusive: [['ledger', 'analysis']],
});

/**
 * Read a JSON input or stop with exit 2.
 * @param {string} path
 * @returns {any}
 */
function readInput(path) {
  if (!existsSync(path)) {
    console.error(`Error: ${path} does not exist.`);
    exit(2);
  }
  const read = readJson(path);
  if (!read.ok) {
    console.error(`Error: ${read.message}`);
    exit(2);
  }
  return read.data;
}

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
  return readInput(analysisPath).execution_ledger ?? DEFAULT_LEDGER;
}

if (!cli.values.coverage && (cli.values.context || cli.values['test-cases'])) {
  console.error('Error: --context and --test-cases go with --coverage.');
  exit(2);
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

if (!cli.values.coverage) {
  console.log(JSON.stringify(releaseExecutionSummary(ledger.data), null, 2));
  exit(0);
}

const contextPath =
  /** @type {string | undefined} */ (cli.values.context) ?? DEFAULT_CONTEXT;
const context = readInput(contextPath);
const casesPath =
  /** @type {string | undefined} */ (cli.values['test-cases']) ??
  context.artifact_paths?.test_cases;
if (typeof casesPath !== 'string' || !casesPath) {
  console.error(
    `Error: ${contextPath} names no test cases (artifact_paths.test_cases); pass --test-cases.`
  );
  exit(2);
}
const testCases = readInput(casesPath);
if (!ledger.data.approved_scope_digest) {
  // Without an approved scope the ledger lists no case outcomes, so nothing
  // can be shown to pass; say why rather than print every case as not run.
  console.error(
    `Note: ${path} records no approved scope; normalize with --test-cases so each case's outcome is recorded.`
  );
}

// One entry per risk: what coverage_by_risk must say (`status`; when no case
// covers the risk, `uncovered` unless a reviewed note accepts it, then
// `accepted_without_test`), and the cases behind it.
const view = riskCoverage({ context, testCases, ledger: ledger.data }).map(
  (r) => ({
    risk_id: r.risk_id,
    severity: r.severity ?? null,
    covered_by_tcs: r.covered_by_tcs,
    status: r.statuses[0],
    ...(r.statuses.length > 1 ? { or: r.statuses.slice(1) } : {}),
    cases: r.cases,
    ...(r.passing ? {} : { not_passing: notPassingReason(r) }),
  })
);
console.log(JSON.stringify(view, null, 2));
