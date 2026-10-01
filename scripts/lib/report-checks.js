// @ts-check
// Structural checks of a release report against the run it reports on (task
// group 2.2b): the Reporter stage of scripts/evaluate-agents.js.
//
// Each check restates a rule agents/reporter.md gives the Reporter, using only
// the run's own artifacts: the context's risks, the approved test cases, the
// finalized failure analysis and its execution ledger. Like the Analyst and
// Designer checks, they are structural: they prove the report says what the
// artifacts say, not that its prose is good. Pure: values in, checks out.

import { isDeepStrictEqual } from 'node:util';

import { releaseExecutionSummary } from './execution-ledger.js';

/** @typedef {{ name: string, pass: boolean, detail: string }} Check */

/** Sorted, de-duplicated copy, for set comparison in details. */
const sorted = (/** @type {Iterable<string>} */ xs) => [...new Set(xs)].sort();
const sameSet = (/** @type {string[]} */ a, /** @type {string[]} */ b) =>
  sorted(a).join() === sorted(b).join();

/**
 * @param {object} run
 * @param {any} run.report     release/release-report.json
 * @param {any} run.context    context.json
 * @param {any} run.testCases  test-cases/[story].json
 * @param {any} run.analysis   analysis/failure-analysis.json
 * @param {any} run.ledger     the ledger the analysis names (2.x), or null
 * @returns {Check[]}
 */
export function releaseReportChecks({
  report,
  context,
  testCases,
  analysis,
  ledger,
}) {
  /** @type {Check[]} */
  const checks = [];
  const add = (
    /** @type {string} */ name,
    /** @type {boolean} */ pass,
    detail = ''
  ) => checks.push({ name, pass, detail });

  add(
    'story and run match the context',
    report.story_id === context.story?.id && report.run_id === context.run_id,
    `${report.story_id}/${report.run_id} vs ${context.story?.id}/${context.run_id}`
  );

  const analysisV2 = /^2\./.test(String(analysis.schema_version));
  const reportV2 = /^2\./.test(String(report.schema_version));
  add(
    'report version follows the analysis (a 2.x analysis gets a 2.x report)',
    analysisV2 === reportV2,
    `analysis ${analysis.schema_version}, report ${report.schema_version}`
  );

  if (analysisV2 && ledger) {
    const want = releaseExecutionSummary(ledger);
    add(
      'execution_summary is the one derived from the ledger',
      isDeepStrictEqual(report.execution_summary, want),
      'compare with npm run report:summary'
    );
  } else {
    add(
      'execution_summary is the one derived from the ledger',
      false,
      'no 2.x analysis with a ledger to derive it from'
    );
  }

  /** @type {{ risk_id: string, severity?: string }[]} */
  const risks = context.risks ?? [];
  /** @type {{ risk_id: string, covered_by_tcs: string[], status: string }[]} */
  const coverage = report.coverage_by_risk ?? [];
  const coverageIds = coverage.map((c) => c.risk_id);
  add(
    'one coverage entry per context risk',
    coverageIds.length === new Set(coverageIds).size &&
      sameSet(
        coverageIds,
        risks.map((r) => r.risk_id)
      ),
    `report ${sorted(coverageIds).join(',')} vs context ${sorted(risks.map((r) => r.risk_id)).join(',')}`
  );

  /** @type {{ test_case_id: string, risk_ids?: string[] }[]} */
  const cases = testCases.test_cases ?? [];
  const wrongTcs = coverage.filter(
    (c) =>
      !sameSet(
        c.covered_by_tcs ?? [],
        cases
          .filter((t) => (t.risk_ids ?? []).includes(c.risk_id))
          .map((t) => t.test_case_id)
      )
  );
  add(
    'covered_by_tcs lists exactly the test cases that reference each risk',
    wrongTcs.length === 0,
    wrongTcs.map((c) => c.risk_id).join(', ')
  );

  const severity = new Map(risks.map((r) => [r.risk_id, r.severity]));
  const uncovered = coverage
    .filter((c) => c.status === 'uncovered')
    .map((c) => c.risk_id);
  const uncoveredHigh = uncovered.filter((id) => severity.get(id) === 'high');
  add(
    'uncovered risks and their high-severity count match the coverage',
    sameSet(report.uncovered_risks ?? [], uncovered) &&
      (report.uncovered_high_severity_count ?? 0) === uncoveredHigh.length,
    `uncovered ${uncovered.join(',') || '(none)'}, high ${uncoveredHigh.length}`
  );

  /** @type {{ failure_id: string, severity: string, bug_draft_path?: string }[]} */
  const failures = analysis.failures ?? [];
  const red = failures.filter((f) => f.severity === 'red');
  add(
    'blocking failures are exactly the Red ones, the rest are non-blocking',
    sameSet(
      report.blocking_failures ?? [],
      red.map((f) => f.failure_id)
    ) &&
      sameSet(
        report.non_blocking_failures ?? [],
        failures.filter((f) => f.severity !== 'red').map((f) => f.failure_id)
      ),
    `red ${red.map((f) => f.failure_id).join(',') || '(none)'}`
  );

  /** @type {{ path: string }[]} */
  const drafts = report.bug_drafts ?? [];
  const listed = new Set(drafts.map((d) => d.path));
  const unlisted = red
    .map((f) => f.bug_draft_path)
    .filter((p) => !p || !listed.has(p));
  add(
    "every Red failure's bug draft is listed",
    unlisted.length === 0,
    unlisted.join(', ')
  );

  if (ledger) {
    /** @type {{ outcome: string }[]} */
    const units = ledger.units ?? [];
    const flaky = units.filter((u) => u.outcome === 'flaky').length;
    add(
      'flaky_tests names every flaky unit, and nothing else',
      (report.flaky_tests ?? []).length === flaky,
      `${(report.flaky_tests ?? []).length} listed, ${flaky} flaky unit(s)`
    );
  }

  const highNotPassing = coverage.filter(
    (c) => severity.get(c.risk_id) === 'high' && c.status !== 'covered_passing'
  );
  const summary = report.execution_summary ?? {};
  const executed = (summary.combined ?? summary).total ?? 0;
  const passBlockers = [
    red.length ? 'a blocking failure' : null,
    highNotPassing.length
      ? 'a high-severity risk not covered and passing'
      : null,
    executed === 0 ? 'nothing executed' : null,
  ].filter(Boolean);
  add(
    'the recommendation is never pass while something blocks it',
    report.release_recommendation !== 'pass' || passBlockers.length === 0,
    passBlockers.join(', ')
  );

  add(
    'a conditional pass lists its conditions',
    report.release_recommendation !== 'conditional_pass' ||
      (report.conditional_pass_criteria ?? []).length > 0,
    ''
  );

  /** @type {Record<string, Record<string, number>>} */
  const rollup = report.summary_by_risk_level ?? {};
  const unbalanced = Object.entries(rollup).filter(
    ([, r]) =>
      r.total !==
      (r.covered_passing ?? 0) +
        (r.covered_failing ?? 0) +
        (r.covered_partial ?? 0) +
        (r.accepted_without_test ?? 0) +
        (r.uncovered ?? 0)
  );
  add(
    'each risk-level rollup adds up to its total',
    unbalanced.length === 0,
    unbalanced.map(([level]) => level).join(', ')
  );

  return checks;
}
