// @ts-check
// Each risk's coverage, derived from the execution ledger instead of taken
// from what a release report claims about itself.
//
// A risk is covered by the approved test cases that reference it. Each case
// counts by its outcome in the ledger's case_outcomes: `passed` is passing;
// `failed` (a flaky unit is already folded into failed), `blocked`,
// `skipped`, `expected_failure` and `not_run` are not. A case the ledger does
// not list did not run. An approved `skip` case never covers a risk, and a
// draft or rejected case is not part of the approved scope.
//
// Pure: values in, coverage out.

/**
 * @typedef {'covered_passing' | 'covered_failing' | 'covered_partial'
 *   | 'uncovered' | 'accepted_without_test'} CoverageStatus
 * @typedef {{ test_case_id: string, outcome: string }} CaseResult
 * @typedef {{
 *   risk_id: string,
 *   severity: string | undefined,
 *   covered_by_tcs: string[],
 *   cases: CaseResult[],
 *   statuses: CoverageStatus[],
 *   passing: boolean,
 * }} RiskCoverage
 *   `covered_by_tcs`: every test case that references the risk, whatever its
 *   decision or status (what the report lists). `cases`: the approved,
 *   non-skip ones with their ledger outcome (what decides the status).
 *   `statuses`: the statuses a report may give the risk; two only when no
 *   case covers it, since accepting a risk without a test is a human note the
 *   ledger cannot see.
 */

/**
 * @param {object} run
 * @param {{ risks?: { risk_id: string, severity?: string }[] }} run.context
 * @param {{ test_cases?: { test_case_id: string, risk_ids?: string[],
 *   status?: string, automation_decision?: string }[] }} run.testCases
 * @param {{ case_outcomes?: CaseResult[] } | null} run.ledger
 * @returns {RiskCoverage[]} one entry per context risk, in context order
 */
export function riskCoverage({ context, testCases, ledger }) {
  const outcomeOf = new Map(
    (ledger?.case_outcomes ?? []).map((c) => [c.test_case_id, c.outcome])
  );
  const all = testCases?.test_cases ?? [];
  return (context?.risks ?? []).map((risk) => {
    const referencing = all.filter((t) =>
      (t.risk_ids ?? []).includes(risk.risk_id)
    );
    const cases = referencing
      .filter(
        (t) => t.status === 'approved' && t.automation_decision !== 'skip'
      )
      .map((t) => ({
        test_case_id: t.test_case_id,
        outcome: outcomeOf.get(t.test_case_id) ?? 'not_run',
      }));
    const passing =
      cases.length > 0 && cases.every((c) => c.outcome === 'passed');
    /** @type {CoverageStatus[]} */
    let statuses;
    if (cases.length === 0) statuses = ['uncovered', 'accepted_without_test'];
    else if (cases.some((c) => c.outcome === 'failed'))
      statuses = ['covered_failing'];
    else if (passing) statuses = ['covered_passing'];
    else statuses = ['covered_partial'];
    return {
      risk_id: risk.risk_id,
      severity: risk.severity,
      covered_by_tcs: referencing.map((t) => t.test_case_id),
      cases,
      statuses,
      passing,
    };
  });
}

/**
 * Why a risk is not passing, naming its cases: "TC-001 failed, TC-003 not_run",
 * or "no approved case covers it".
 * @param {RiskCoverage} risk
 * @returns {string}
 */
export function notPassingReason(risk) {
  if (risk.cases.length === 0) return 'no approved case covers it';
  return risk.cases
    .filter((c) => c.outcome !== 'passed')
    .map((c) => `${c.test_case_id} ${c.outcome}`)
    .join(', ');
}
