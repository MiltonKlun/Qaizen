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
import { riskCoverage } from '../scripts/lib/risk-coverage.js';

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
const run = (r, failures = [red, green], cases = testCases) => ({
  report: r,
  context,
  testCases: cases,
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
  // No test case references RISK-001 in this run.
  const onlyTc2 = { test_cases: [testCases.test_cases[1]] };
  assert.deepEqual(releaseRuleProblems(run(quiet, [], onlyTc2)), [
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

// --- coverage comes from the ledger, not from the report -------------------
//
// Four reports a live run used to accept. Each claims more than the ledger
// shows: TC-001, the only case for the high-severity RISK-001, failed.

const approved = {
  test_cases: [
    {
      test_case_id: 'TC-001',
      risk_ids: ['RISK-001'],
      status: 'approved',
      automation_decision: 'automate_e2e',
    },
    {
      test_case_id: 'TC-002',
      risk_ids: ['RISK-002'],
      status: 'approved',
      automation_decision: 'automate_e2e',
    },
  ],
};
const ledger = {
  units: [],
  case_outcomes: [
    { test_case_id: 'TC-001', outcome: 'failed' },
    { test_case_id: 'TC-002', outcome: 'passed' },
  ],
};
const yellowOnTc1 = {
  failure_id: 'FAIL-001',
  severity: 'yellow',
  test_case_id: 'TC-001',
};
/** A pass report over the run above; `over` makes each false claim. */
const passReport = (over = {}) => ({
  ...report(),
  coverage_by_risk: [
    {
      risk_id: 'RISK-001',
      covered_by_tcs: ['TC-001'],
      status: 'covered_passing',
    },
    {
      risk_id: 'RISK-002',
      covered_by_tcs: ['TC-002'],
      status: 'covered_passing',
    },
  ],
  blocking_failures: [],
  non_blocking_failures: ['FAIL-001'],
  bug_drafts: [],
  release_recommendation: 'pass',
  ...over,
});
const live = (r, failures = [yellowOnTc1]) => ({
  report: r,
  context,
  testCases: approved,
  analysis: { schema_version: '2.0', failures },
  ledger,
});
const NOT_PASSING =
  'the recommendation is never pass while something blocks it (a high-severity risk not covered and passing (RISK-001: TC-001 failed))';

test('a failed case reported as covered_passing is refused, naming the risk and case', () => {
  assert.deepEqual(releaseRuleProblems(live(passReport())), [
    'each risk status is the one its cases in the ledger support (RISK-001 says covered_passing, but TC-001 failed)',
    NOT_PASSING,
  ]);
});

test('a failing high-severity risk left out of the coverage still blocks a pass', () => {
  const omitted = passReport({
    coverage_by_risk: [
      {
        risk_id: 'RISK-002',
        covered_by_tcs: ['TC-002'],
        status: 'covered_passing',
      },
    ],
  });
  assert.deepEqual(releaseRuleProblems(live(omitted)), [
    'one coverage entry per context risk (report RISK-002 vs context RISK-001,RISK-002)',
    NOT_PASSING,
  ]);
});

test('a conditional pass with a Red failure on a high-severity risk is refused', () => {
  const redOnTc1 = {
    failure_id: 'FAIL-001',
    severity: 'red',
    test_case_id: 'TC-001',
    bug_draft_path: 'release/bug-drafts/BUG-001.md',
  };
  const conditional = passReport({
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
    blocking_failures: ['FAIL-001'],
    non_blocking_failures: [],
    bug_drafts: [
      { bug_id: 'BUG-001', severity: 'red', path: redOnTc1.bug_draft_path },
    ],
    release_recommendation: 'conditional_pass',
    conditional_pass_criteria: ['BUG-001 accepted by the product owner'],
  });
  assert.deepEqual(releaseRuleProblems(live(conditional, [redOnTc1])), [
    'a conditional pass has no Red failure on a high-severity risk (FAIL-001 on RISK-001 (TC-001))',
  ]);
  // A Red failure traced to no case cannot be shown to be off the high risk.
  const untraced = { ...redOnTc1, test_case_id: null };
  assert.deepEqual(releaseRuleProblems(live(conditional, [untraced])), [
    'a conditional pass has no Red failure on a high-severity risk (FAIL-001 (traced to no risk, so it may be one))',
  ]);
});

test('crediting a risk to a case that does not reference it is refused', () => {
  const misattributed = passReport({
    coverage_by_risk: [
      {
        risk_id: 'RISK-001',
        covered_by_tcs: ['TC-002'],
        status: 'covered_passing',
      },
      {
        risk_id: 'RISK-002',
        covered_by_tcs: ['TC-002'],
        status: 'covered_passing',
      },
    ],
  });
  assert.deepEqual(releaseRuleProblems(live(misattributed)), [
    'covered_by_tcs lists exactly the test cases that reference each risk (RISK-001 lists TC-002, referenced by TC-001)',
    'each risk status is the one its cases in the ledger support (RISK-001 says covered_passing, but TC-001 failed)',
    NOT_PASSING,
  ]);
});

test('a report that says what the ledger shows keeps every rule', () => {
  const honest = passReport({
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
    release_recommendation: 'fail',
  });
  assert.deepEqual(releaseRuleProblems(live(honest)), []);
});

test('only approved, non-skip cases decide a risk; anything but passed is not passing', () => {
  const tcs = {
    test_cases: [
      ['TC-001', 'approved', 'automate_e2e'],
      ['TC-002', 'approved', 'automate_api'],
      ['TC-003', 'approved', 'skip'],
      ['TC-004', 'rejected', 'automate_e2e'],
      ['TC-005', 'approved', 'manual'],
    ].map(([id, status, decision]) => ({
      test_case_id: id,
      risk_ids: ['RISK-001'],
      status,
      automation_decision: decision,
    })),
  };
  const of = (/** @type {Record<string, string>} */ outcomes) =>
    riskCoverage({
      context: { risks: [{ risk_id: 'RISK-001', severity: 'high' }] },
      testCases: tcs,
      ledger: {
        case_outcomes: Object.entries(outcomes).map(([id, outcome]) => ({
          test_case_id: id,
          outcome,
        })),
      },
    })[0];

  const all = of({
    'TC-001': 'passed',
    'TC-002': 'passed',
    'TC-005': 'passed',
  });
  assert.deepEqual(all.covered_by_tcs, [
    'TC-001',
    'TC-002',
    'TC-003',
    'TC-004',
    'TC-005',
  ]);
  assert.deepEqual(
    all.cases.map((c) => c.test_case_id),
    ['TC-001', 'TC-002', 'TC-005']
  );
  assert.equal(all.passing, true);
  assert.deepEqual(all.statuses, ['covered_passing']);

  // A manual case with no recorded result did not run: partial, not passing.
  const unrecorded = of({ 'TC-001': 'passed', 'TC-002': 'passed' });
  assert.equal(unrecorded.passing, false);
  assert.deepEqual(unrecorded.statuses, ['covered_partial']);

  for (const outcome of ['blocked', 'skipped', 'expected_failure', 'not_run']) {
    const r = of({ 'TC-001': outcome, 'TC-002': 'passed', 'TC-005': 'passed' });
    assert.deepEqual(r.statuses, ['covered_partial'], outcome);
  }
  assert.deepEqual(of({ 'TC-001': 'failed', 'TC-002': 'blocked' }).statuses, [
    'covered_failing',
  ]);

  // Only skips: nothing covers the risk, so it is uncovered or accepted.
  const skipsOnly = riskCoverage({
    context: { risks: [{ risk_id: 'RISK-001' }] },
    testCases: { test_cases: [tcs.test_cases[2]] },
    ledger: { case_outcomes: [] },
  })[0];
  assert.deepEqual(skipsOnly.statuses, ['uncovered', 'accepted_without_test']);
});
