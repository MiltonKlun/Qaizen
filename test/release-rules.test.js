// The release rules (scripts/lib/report-checks.js): what a release report may
// conclude, enforced when a live run accepts it (scripts/lib/run-artifacts.js)
// as well as when a Reporter prompt is evaluated.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RELEASE_RULES,
  releaseReportChecks,
  releaseRuleProblems,
} from '../scripts/lib/report-checks.js';

const context = {
  story: { id: 'REL-1' },
  run_id: 'run-rel-1',
  risks: [
    { risk_id: 'RISK-001', severity: 'high' },
    { risk_id: 'RISK-002', severity: 'low' },
  ],
};
const testCases = {
  test_cases: [
    { test_case_id: 'TC-001', risk_ids: ['RISK-001'] },
    { test_case_id: 'TC-002', risk_ids: ['RISK-002'] },
  ],
};
const red = {
  failure_id: 'FAIL-001',
  severity: 'red',
  bug_draft_path: 'release/bug-drafts/BUG-001.md',
};
const green = { failure_id: 'FAIL-002', severity: 'green' };

/** A report that keeps every rule for a run with one Red, one Green failure. */
function report(overrides = {}) {
  return {
    schema_version: '2.0',
    story_id: 'REL-1',
    run_id: 'run-rel-1',
    coverage_by_risk: [
      {
        risk_id: 'RISK-001',
        covered_by_tcs: ['TC-001'],
        status: 'covered_failing',
      },
      {
        risk_id: 'RISK-002',
        covered_by_tcs: ['TC-002'],
        status: 'covered_passing',
      },
    ],
    uncovered_risks: [],
    uncovered_high_severity_count: 0,
    blocking_failures: ['FAIL-001'],
    non_blocking_failures: ['FAIL-002'],
    bug_drafts: [
      { bug_id: 'BUG-001', severity: 'red', path: red.bug_draft_path },
    ],
    execution_summary: { total: 2, passed: 0, failed: 2 },
    release_recommendation: 'fail',
    ...overrides,
  };
}
const run = (r, failures = [red, green]) => ({
  report: r,
  context,
  testCases,
  analysis: { schema_version: '2.0', failures },
  ledger: null,
});

test('the rules are a subset of the checks, by name', () => {
  const names = releaseReportChecks(run(report())).map((c) => c.name);
  for (const rule of RELEASE_RULES) assert.ok(names.includes(rule), rule);
});

test('a consistent report keeps every rule', () => {
  assert.deepEqual(releaseRuleProblems(run(report())), []);
});

test('no pass while a Red failure or an uncovered high risk blocks it', () => {
  assert.deepEqual(
    releaseRuleProblems(run(report({ release_recommendation: 'pass' }))),
    [
      'the recommendation is never pass while something blocks it (a blocking failure, a high-severity risk not covered and passing)',
    ]
  );
  // With nothing failing, an uncovered high risk alone still blocks a pass.
  const quiet = report({
    coverage_by_risk: [
      { risk_id: 'RISK-001', covered_by_tcs: [], status: 'uncovered' },
      {
        risk_id: 'RISK-002',
        covered_by_tcs: ['TC-002'],
        status: 'covered_passing',
      },
    ],
    uncovered_risks: ['RISK-001'],
    uncovered_high_severity_count: 1,
    blocking_failures: [],
    non_blocking_failures: [],
    bug_drafts: [],
    execution_summary: { total: 1, passed: 1, failed: 0 },
    release_recommendation: 'pass',
  });
  assert.deepEqual(releaseRuleProblems(run(quiet, [])), [
    'the recommendation is never pass while something blocks it (a high-severity risk not covered and passing)',
  ]);
});

test('a report that hides a Red failure or its bug draft is refused', () => {
  const hidden = report({
    blocking_failures: [],
    non_blocking_failures: ['FAIL-001', 'FAIL-002'],
    bug_drafts: [],
  });
  assert.deepEqual(releaseRuleProblems(run(hidden)), [
    'blocking failures are exactly the Red ones, the rest are non-blocking (red FAIL-001)',
    "every Red failure's bug draft is listed (release/bug-drafts/BUG-001.md)",
  ]);
});

test('a conditional pass must state its conditions; the risk counts must match', () => {
  const noConditions = report({
    blocking_failures: [],
    non_blocking_failures: ['FAIL-001', 'FAIL-002'],
    release_recommendation: 'conditional_pass',
  });
  assert.ok(
    releaseRuleProblems(run(noConditions, [green])).includes(
      'a conditional pass lists its conditions'
    )
  );
  const miscounted = report({ uncovered_high_severity_count: 2 });
  assert.deepEqual(releaseRuleProblems(run(miscounted)), [
    'uncovered risks and their high-severity count match the coverage (uncovered (none), high 0)',
  ]);
});
