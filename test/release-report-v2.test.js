// Release report 2.0 (task group 2.2b): counts derived from the execution
// ledger, explained by an outcome breakdown, with a null pass rate when nothing
// ran; 1.x reports keep their meaning; the runner accepts a report only when
// its counts are the ledger's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  analysisCountProblems,
  releaseExecutionSummary,
} from '../scripts/lib/execution-ledger.js';
import { checkArtifact } from '../scripts/lib/run-artifacts.js';
import { validateValue } from '../scripts/lib/artifact-io.js';
import { writeCompletedRun } from './helpers/valid-run.js';

const SCHEMA = 'schemas/release-report.schema.json';
const read = (/** @type {string} */ p) => JSON.parse(readFileSync(p, 'utf8'));
const LEDGER = read(
  'examples/expected/mixed-run.expected-execution-ledger.json'
);
const REPORT_V2 = read(
  'examples/expected/mixed-run.expected-release-report.json'
);
const REPORT_V1 = read(
  'examples/expected/enhanced-report.expected-release-report.json'
);
const CLEANUP = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 100,
};

/** @param {string} id @param {string} kind @param {string} outcome */
const unit = (id, kind, outcome) => ({
  unit_id: id,
  execution_id: 'e',
  identity: { kind },
  outcome,
});

test('the summary is flat without Newman, grouped with it, and leaves external results out', () => {
  const flat = releaseExecutionSummary({
    units: [
      unit('a', 'playwright', 'passed'),
      unit('b', 'playwright', 'expected_failure'),
      unit('c', 'external', 'failed'),
    ],
  });
  assert.deepEqual(flat, {
    total: 2,
    passed: 1,
    failed: 0,
    skipped: 1,
    pass_rate: 0.5,
    outcome_breakdown: {
      passed: 1,
      failed: 0,
      flaky: 0,
      skipped: 0,
      blocked: 0,
      not_run: 0,
      expected_failure: 1,
    },
  });

  const grouped = /** @type {any} */ (releaseExecutionSummary(LEDGER));
  for (const k of ['total', 'passed', 'failed', 'skipped']) {
    assert.equal(grouped.combined[k], grouped.e2e[k] + grouped.api[k], k);
  }
  assert.equal(
    grouped.combined.pass_rate,
    grouped.combined.passed / grouped.combined.total
  );
  // A flaky and a blocked unit are visible, not hidden inside "failed".
  assert.equal(grouped.e2e.outcome_breakdown.flaky, 1);
  assert.equal(grouped.api.outcome_breakdown.blocked, 1);
});

test('nothing executed is a null pass rate, never 0', () => {
  const none = /** @type {any} */ (releaseExecutionSummary({ units: [] }));
  assert.equal(none.total, 0);
  assert.equal(none.pass_rate, null);
  const report = { ...REPORT_V2, execution_summary: none };
  assert.equal(validateValue(report, SCHEMA).ok, true);
  const zeroRate = {
    ...REPORT_V2,
    execution_summary: { ...none, pass_rate: 0 },
  };
  assert.equal(validateValue(zeroRate, SCHEMA).ok, false);
});

test('the 2.0 example is exactly what the ledger derives', () => {
  assert.deepEqual(
    REPORT_V2.execution_summary,
    releaseExecutionSummary(LEDGER)
  );
  assert.equal(validateValue(REPORT_V2, SCHEMA).ok, true);
});

test('each version keeps its own shape: no breakdown in 1.x, required in 2.x', () => {
  assert.equal(validateValue(REPORT_V1, SCHEMA).ok, true);
  const v2WithoutBreakdown = { ...REPORT_V1, schema_version: '2.0' };
  assert.equal(validateValue(v2WithoutBreakdown, SCHEMA).ok, false);
  const v1WithBreakdown = { ...REPORT_V2, schema_version: '1.0' };
  assert.equal(validateValue(v1WithBreakdown, SCHEMA).ok, false);
  const unknownVersion = { ...REPORT_V2, schema_version: '3.0' };
  assert.equal(validateValue(unknownVersion, SCHEMA).ok, false);
});

test("a 2.x analysis's flat totals must be its breakdown's projection", () => {
  const analysis = read(
    'examples/expected/classification-evidence.expected-failure-analysis.json'
  );
  assert.deepEqual(analysisCountProblems(analysis), []);
  const off = { ...analysis, failed: analysis.failed + 1 };
  assert.match(
    analysisCountProblems(off).join(),
    /failed is \d+ but the outcome breakdown projects \d+/
  );
  assert.deepEqual(
    analysisCountProblems({ schema_version: '1.0', failed: 99 }),
    []
  );
});

test('the runner accepts a report only when it is 2.0 and its counts are the ledger’s', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-rr2-'));
  try {
    const ctx = writeCompletedRun(dir);
    assert.equal(checkArtifact('release_report_json', ctx, dir).ok, true);

    const report = read(join(dir, 'release/release-report.json'));
    const write = (/** @type {any} */ doc) =>
      writeFileSync(
        join(dir, 'release/release-report.json'),
        JSON.stringify(doc)
      );

    write({ ...REPORT_V1, story_id: report.story_id, run_id: report.run_id });
    const v1 = checkArtifact('release_report_json', ctx, dir);
    assert.equal(v1.ok, false);
    assert.match(
      v1.ok ? '' : v1.reason,
      /1\.x report for a 2\.x failure analysis/
    );

    const tampered = structuredClone(report);
    tampered.execution_summary.e2e.outcome_breakdown.flaky = 0;
    tampered.execution_summary.e2e.outcome_breakdown.failed = 2;
    write(tampered);
    const differs = checkArtifact('release_report_json', ctx, dir);
    assert.equal(differs.ok, false);
    assert.match(differs.ok ? '' : differs.reason, /differs from the ledger's/);

    const fa = read(join(dir, 'analysis/failure-analysis.json'));
    writeFileSync(
      join(dir, 'analysis/failure-analysis.json'),
      JSON.stringify({ ...fa, passed: fa.passed + 1 })
    );
    const counts = checkArtifact('failure_analysis', ctx, dir);
    assert.equal(counts.ok, false);
    assert.match(
      counts.ok ? '' : counts.reason,
      /passed is \d+ but the outcome breakdown/
    );
  } finally {
    rmSync(dir, CLEANUP);
  }
});

test('report:summary prints the derived summary and refuses an inconsistent ledger', () => {
  const ok = spawnSync(
    process.execPath,
    [
      'scripts/report-summary.js',
      '--ledger',
      'examples/expected/mixed-run.expected-execution-ledger.json',
    ],
    { encoding: 'utf8' }
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), releaseExecutionSummary(LEDGER));

  const dir = mkdtempSync(join(tmpdir(), 'qaizen-rr2-'));
  try {
    const bad = structuredClone(LEDGER);
    bad.totals.passed += 1;
    writeFileSync(join(dir, 'ledger.json'), JSON.stringify(bad));
    const r = spawnSync(
      process.execPath,
      ['scripts/report-summary.js', '--ledger', join(dir, 'ledger.json')],
      { encoding: 'utf8' }
    );
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
  } finally {
    rmSync(dir, CLEANUP);
  }
});
