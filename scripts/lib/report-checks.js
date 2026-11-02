// @ts-check
// Structural checks of a release report against the run it reports on:
// the Reporter stage of scripts/evaluate-agents.js.
//
// Each check restates a rule agents/reporter.md gives the Reporter, using only
// the run's own artifacts: the context's risks, the approved test cases, the
// finalized failure analysis and its execution ledger. Like the Analyst and
// Designer checks, they are structural: they prove the report says what the
// artifacts say, not that its prose is good. Pure: values in, checks out.

import { isDeepStrictEqual } from 'node:util';

import { releaseExecutionSummary } from './execution-ledger.js';
import { notPassingReason, riskCoverage } from './risk-coverage.js';

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
  const wrongTcs = coverage
    .map((c) => {
      const want = cases
        .filter((t) => (t.risk_ids ?? []).includes(c.risk_id))
        .map((t) => t.test_case_id);
      return { risk: c.risk_id, listed: c.covered_by_tcs ?? [], want };
    })
    .filter((w) => !sameSet(w.listed, w.want));
  add(
    'covered_by_tcs lists exactly the test cases that reference each risk',
    wrongTcs.length === 0,
    wrongTcs
      .map(
        (w) =>
          `${w.risk} lists ${sorted(w.listed).join(',') || '(none)'}, ` +
          `referenced by ${sorted(w.want).join(',') || '(none)'}`
      )
      .join('; ')
  );

  // What the ledger says about each risk: the approved cases that reference
  // it and their recorded outcomes (scripts/lib/risk-coverage.js).
  const derived = ledger ? riskCoverage({ context, testCases, ledger }) : null;
  // A ledger normalized without --test-cases records no case outcomes, so
  // every case reads as not run; say so instead of leaving that unexplained.
  const noScope =
    ledger && !ledger.approved_scope_digest
      ? ' [the ledger records no approved scope; normalize with --test-cases]'
      : '';
  if (derived) {
    const byId = new Map(derived.map((d) => [d.risk_id, d]));
    const contradicted = coverage
      .map((c) => ({ c, d: byId.get(c.risk_id) }))
      .filter(
        ({ c, d }) => d && !d.statuses.includes(/** @type {any} */ (c.status))
      );
    add(
      'each risk status is the one its cases in the ledger support',
      contradicted.length === 0,
      contradicted
        .map(({ c, d }) => {
          const why = d?.passing
            ? `${d.cases.map((k) => k.test_case_id).join(', ')} passed`
            : notPassingReason(/** @type {any} */ (d));
          return `${c.risk_id} says ${c.status}, but ${why}`;
        })
        .join('; ') + (contradicted.length ? noScope : '')
    );
  } else {
    // A 1.x analysis has no ledger; its report's statuses cannot be checked.
    add(
      'each risk status is the one its cases in the ledger support',
      true,
      'no ledger to check against'
    );
  }

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

  // With a ledger, a high-severity risk blocks a pass unless its cases
  // passed, whatever the report says about it, and even when the report
  // leaves it out. Without one (a 1.x analysis), the report's own statuses
  // are all there is.
  const highNotPassing = derived
    ? derived
        .filter((d) => d.severity === 'high' && !d.passing)
        .map((d) => `${d.risk_id}: ${notPassingReason(d)}${noScope}`)
    : coverage
        .filter(
          (c) =>
            severity.get(c.risk_id) === 'high' && c.status !== 'covered_passing'
        )
        .map((c) => c.risk_id);
  const summary = report.execution_summary ?? {};
  const executed = (summary.combined ?? summary).total ?? 0;
  const passBlockers = [
    red.length ? 'a blocking failure' : null,
    highNotPassing.length
      ? 'a high-severity risk not covered and passing' +
        (derived ? ` (${highNotPassing.join('; ')})` : '')
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

  // A Red failure on a high-severity risk is a product bug in what matters
  // most; no listed condition turns that into a release. A Red failure that
  // cannot be traced to a risk counts too: nothing shows it is not one.
  /** @type {Map<string, string[]>} */
  const risksOf = new Map(cases.map((t) => [t.test_case_id, t.risk_ids ?? []]));
  const redOnHigh = red.flatMap((f) => {
    const tc = /** @type {{ test_case_id?: string | null }} */ (f).test_case_id;
    const traced = tc ? (risksOf.get(tc) ?? []) : [];
    if (traced.length === 0)
      return [
        `${f.failure_id} (not traced to a test case's risk, so it may be on a high-severity one)`,
      ];
    return traced
      .filter((r) => severity.get(r) === 'high')
      .map((r) => `${f.failure_id} on ${r} (${tc})`);
  });
  add(
    'a conditional pass has no Red failure on a high-severity risk',
    report.release_recommendation !== 'conditional_pass' ||
      redOnHigh.length === 0,
    redOnHigh.join(', ')
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

/**
 * The release rules: the checks about what a report concludes, enforced
 * when a live run accepts its release report (scripts/lib/run-artifacts.js),
 * not only when a Reporter prompt is evaluated. The other checks concern how
 * the report is laid out, and stay with the evaluation.
 */
export const RELEASE_RULES = [
  'one coverage entry per context risk',
  'covered_by_tcs lists exactly the test cases that reference each risk',
  'each risk status is the one its cases in the ledger support',
  'blocking failures are exactly the Red ones, the rest are non-blocking',
  "every Red failure's bug draft is listed",
  'uncovered risks and their high-severity count match the coverage',
  'the recommendation is never pass while something blocks it',
  'a conditional pass lists its conditions',
  'a conditional pass has no Red failure on a high-severity risk',
];

/**
 * The release rules a report breaks, each with what it found.
 * @param {Parameters<typeof releaseReportChecks>[0]} run
 * @returns {string[]} empty when the report keeps every rule
 */
export function releaseRuleProblems(run) {
  return releaseReportChecks(run)
    .filter((c) => RELEASE_RULES.includes(c.name) && !c.pass)
    .map((c) => (c.detail ? `${c.name} (${c.detail})` : c.name));
}
