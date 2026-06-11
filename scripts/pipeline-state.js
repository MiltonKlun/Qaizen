// Pipeline state machine (IMPROVEMENT-PLAN Phase 2, IP-2.1). PURE module:
// no I/O, no side effects — `nextStep(context)` derives the next pipeline
// step from the run manifest alone (context.json IS the state source of
// truth; there is no separate state file, no DB, no queue).
//
// The sequence implements the vertical-slice order
// (docs/phase2-vertical-slice-runbook.md) and the binding gate rule
// (CLAUDE.md §3.5 / docs/review-gates.md "Reading a gate"): if a gate is not
// passed, the next agent must not run — the machine returns the GATE step,
// never the step behind it.
//
//   analyst → gate1 → test-designer → gate2 → planner → [api] → gate3 →
//   generator → gate4 → execute → classify → report → done
//
// `hints` carries facts that live OUTSIDE context.json (file existence, the
// automate_api split inside the test-cases file). The CLI gathers them with
// I/O and passes them in; this module stays pure. All hints are optional —
// without them the machine trusts artifact_paths ("" = not yet produced,
// docs/context-json-guide.md §4).

/**
 * A gate is passed when its value is boolean `true` or an audit object with
 * `status: true`. Anything else (false, { status: false }, absent) is NOT
 * passed. This is the binding rule from docs/review-gates.md.
 */
export function gatePassed(value) {
  return value === true || (!!value && value.status === true);
}

/**
 * Blocking ambiguities (CLAUDE.md §3.7) — the runner halts on these before
 * computing any step. Returns the list of blocking descriptions ([] if none).
 */
export function blockingAmbiguities(context) {
  if (!context || !Array.isArray(context.ambiguities)) return [];
  return context.ambiguities
    .filter((a) => a && a.blocking === true)
    .map((a) => a.description || '(no description)');
}

/** Runner step → the review_gates key it decides. */
export const GATE_KEYS = {
  gate1: 'requirements_reviewed',
  gate2: 'test_scope_reviewed',
  qa_scope: 'qa_scope_approved', // lite track: consolidates Gates 1+2
  gate3: 'specs_reviewed',
  gate4: 'code_reviewed',
};

/**
 * Derive the next step for a run.
 *
 * @param {object|null} context  Parsed context.json, or null when the run
 *                               has not started (no context.json yet).
 * @param {object} [hints]      Optional CLI-gathered facts (all optional):
 *   - hasApiCases:            true if test-cases contains automate_api cases.
 *   - apiCollectionExists:    true if the Postman collection file exists.
 *   - executionResultsExist:  file-existence override for execution_results.
 *   - failureAnalysisExists:  file-existence override for failure_analysis.
 *   - releaseReportExists:    file-existence override for release_report_json.
 * @returns {string} one of: analyst | gate1 | test-designer | gate2 |
 *   qa_scope | planner | api | gate3 | generator | gate4 | execute |
 *   classify | report | done   (qa_scope replaces gate1+gate2 on the lite
 *   track — context.track === "lite" or a passed qa_scope_approved)
 */
export function nextStep(context, hints = {}) {
  if (!context) return 'analyst';

  const paths = context.artifact_paths || {};
  const gates = context.review_gates || {};
  const filled = (p) => typeof p === 'string' && p.length > 0;
  // A path counts as "produced" when it is filled AND (if the CLI checked)
  // the file actually exists — a prefilled conventional path with no file
  // behind it is not a produced artifact.
  const produced = (p, exists) => filled(p) && exists !== false;

  // qa_scope_approved consolidates Gates 1+2 when passed (Phase 2 TG7);
  // it NEVER consolidates Gate 3 or Gate 4 (docs/review-gates.md).
  const consolidated = gatePassed(gates.qa_scope_approved);
  const g1 = consolidated || gatePassed(gates.requirements_reviewed);
  const g2 = consolidated || gatePassed(gates.test_scope_reviewed);

  // Track-aware gate path (Phase 4, lite track). On the lite track the
  // analyst's interpretation and the test scope are approved in ONE
  // qa_scope_approved decision (the runner records it once; both underlying
  // gates pass with it). On standard/full the two gates stay separate.
  // Gates 3 and 4 are unchanged in every track. A run that already carries a
  // passed qa_scope_approved follows the lite path regardless of `track`, so
  // an in-flight run is never stranded by a track edit.
  const lite = context.track === 'lite' || consolidated;

  if (lite) {
    // Lite path: analyst -> test-designer -> qa_scope (one decision covering
    // requirements AND scope) -> planner ... Scope can only be judged once
    // the cases exist, so the single consolidated gate sits after the Test
    // Designer — exactly where standard's Gate 2 sits.
    if (!filled(paths.test_cases)) return 'test-designer';
    if (!consolidated) return 'qa_scope';
  } else {
    if (!g1) return 'gate1';
    if (!filled(paths.test_cases)) return 'test-designer';
    if (!g2) return 'gate2';
  }
  if (!filled(paths.playwright_spec)) return 'planner';
  if (hints.hasApiCases === true && hints.apiCollectionExists !== true)
    return 'api';
  if (!gatePassed(gates.specs_reviewed)) return 'gate3';
  if (!filled(paths.generated_test)) return 'generator';
  if (!gatePassed(gates.code_reviewed)) return 'gate4';
  if (!produced(paths.execution_results, hints.executionResultsExist))
    return 'execute';
  if (!produced(paths.failure_analysis, hints.failureAnalysisExists))
    return 'classify';
  if (!produced(paths.release_report_json, hints.releaseReportExists))
    return 'report';
  return 'done';
}
