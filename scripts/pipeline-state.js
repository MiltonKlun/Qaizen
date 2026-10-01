// @ts-check
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
//   analyst → gate1 → test-designer → gate2 →
//     [E2E]  planner → gate3 → generator → gate4
//     [API]  api → gate3-api (collection_reviewed) → gate4-api (api_assertions_reviewed)
//     [EXT]  external-plan → gate3-ext (external_plan_reviewed)
//   → [E2E] execute → [API] execute-api
//   → [EXT] external-results → gate4-ext (external_evidence_reviewed)
//   → classify → finalize → report → done
//
// A branch runs only when the approved scope has cases for it (task group
// 7.1): an API-only story never meets the E2E steps, and every applicable
// branch is fully reviewed before either suite executes. Manual, component
// and skip cases form the external branch (task group 7.2): its plan is
// reviewed with the other plans, its evidence after it exists, and a
// skip-only scope still passes both external reviews — nothing is executed,
// and nothing is approved by default.
//
// `hints` carries facts that live OUTSIDE context.json (file existence, the
// automate_api split inside the test-cases file). The CLI gathers them with
// I/O and passes them in; this module stays pure. All hints are optional —
// without them the machine trusts artifact_paths ("" = not yet produced,
// docs/context-json-guide.md §4).

/** @typedef {import('./lib/approval-binding.js').Context} Context */
/**
 * Facts the CLI gathers for nextStep (documented there).
 * @typedef {{ branches?: { e2e?: boolean, api?: boolean, external?: boolean,
 *     externalRuns?: boolean },
 *   hasApiCases?: boolean, apiCollectionExists?: boolean,
 *   apiExecuted?: boolean, externalPlanExists?: boolean,
 *   externalResultsExist?: boolean, testCasesExist?: boolean,
 *   plannerBriefExists?: boolean, specExists?: boolean,
 *   generatedTestExists?: boolean, executionResultsExist?: boolean,
 *   failureAnalysisExists?: boolean, failureAnalysisFinalized?: boolean,
 *   bugDraftsMissing?: number, releaseReportExists?: boolean }} StepHints
 */

/**
 * A gate is passed when its value is boolean `true` or an audit object with
 * `status: true`. Anything else (false, { status: false }, absent) is NOT
 * passed. This is the binding rule from docs/review-gates.md.
 * @param {unknown} value
 */
export function gatePassed(value) {
  return (
    value === true ||
    (!!value && /** @type {{ status?: unknown }} */ (value).status === true)
  );
}

/**
 * Blocking ambiguities (CLAUDE.md §3.7) — the runner halts on these before
 * computing any step. Returns the list of blocking descriptions ([] if none).
 * @param {Context | null} context
 * @returns {string[]}
 */
export function blockingAmbiguities(context) {
  if (!context || !Array.isArray(context.ambiguities)) return [];
  /** @type {{ blocking?: boolean, description?: string }[]} */
  const ambiguities = context.ambiguities;
  return ambiguities
    .filter((a) => a && a.blocking === true)
    .map((a) => a.description || '(no description)');
}

/**
 * Runner step → the review_gates key it decides.
 * @type {Record<string, string>}
 */
export const GATE_KEYS = {
  gate1: 'requirements_reviewed',
  gate2: 'test_scope_reviewed',
  qa_scope: 'qa_scope_approved', // lite track: consolidates Gates 1+2
  gate3: 'specs_reviewed',
  gate4: 'code_reviewed',
  // The API branch's own reviews (task group 7.1); never an E2E approval.
  'gate3-api': 'collection_reviewed',
  'gate4-api': 'api_assertions_reviewed',
  // The external branch's reviews (task group 7.2): plan, then evidence.
  'gate3-ext': 'external_plan_reviewed',
  'gate4-ext': 'external_evidence_reviewed',
};

/**
 * Derive the next step for a run.
 *
 * @param {Context|null} context  Parsed context.json, or null when the run
 *                               has not started (no context.json yet).
 * @param {StepHints} [hints]   Optional CLI-gathered facts (all optional):
 *   - branches:               { e2e, api, external, externalRuns } from the
 *                             APPROVED cases' automation decisions (task
 *                             groups 7.1, 7.2). Preferred. `external`: any
 *                             manual/component/skip case; `externalRuns`: any
 *                             manual/component case (skip is never executed).
 *   - hasApiCases:            legacy: true if test-cases has automate_api cases
 *                             (used only when `branches` is absent).
 *   - apiCollectionExists:    true if the Postman collection file exists.
 *   - apiExecuted:            true if a Newman execution of the approved
 *                             collection exists for this run.
 *   - externalPlanExists:     true if a valid external plan exists for this run.
 *   - externalResultsExist:   true if valid imported results exist for this run.
 *   - testCasesExist:         file-existence override for test_cases.
 *   - plannerBriefExists:     file-existence override for planner_brief.
 *   - specExists:             file-existence override for playwright_spec.
 *   - generatedTestExists:    file-existence override for generated_test.
 *   - executionResultsExist:  file-existence override for execution_results.
 *   - failureAnalysisExists:  file-existence override for failure_analysis.
 *   - releaseReportExists:    file-existence override for release_report_json.
 *
 * The Analyst pre-fills test_cases / planner_brief with their CONVENTIONAL
 * paths before those files exist (agents/analyst.md step 5). So a bare
 * `filled()` check on them is fooled — it reads "produced" off the prefilled
 * string and skips the step that should create the file. For every
 * artifact-producing step we therefore use `produced(path, existsHint)`:
 * filled AND (when the CLI checked) the file actually exists. Absent a hint,
 * behavior is unchanged (filled-only), so older callers are unaffected.
 * @returns {string} one of: analyst | gate1 | test-designer | gate2 |
 *   qa_scope | no-executable-scope | planner | gate3 | generator | gate4 |
 *   api | gate3-api | gate4-api | external-plan | gate3-ext | execute |
 *   execute-api | external-results | gate4-ext | classify |
 *   finalize | report | done   (qa_scope replaces gate1+gate2 on the lite
 *   track — context.track === "lite" or a passed qa_scope_approved)
 */
export function nextStep(context, hints = {}) {
  if (!context) return 'analyst';

  const paths = context.artifact_paths || {};
  const gates = context.review_gates || {};
  const filled = (/** @type {unknown} */ p) =>
    typeof p === 'string' && p.length > 0;
  // A path counts as "produced" when it is filled AND (if the CLI checked)
  // the file actually exists — a prefilled conventional path with no file
  // behind it is not a produced artifact.
  /** @type {(p: unknown, exists: boolean | undefined) => boolean} */
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
    if (!produced(paths.test_cases, hints.testCasesExist))
      return 'test-designer';
    if (!consolidated) return 'qa_scope';
  } else {
    if (!g1) return 'gate1';
    if (!produced(paths.test_cases, hints.testCasesExist))
      return 'test-designer';
    if (!g2) return 'gate2';
  }
  // Which branches the APPROVED scope activates (task group 7.1). The CLI
  // derives them from approved automation decisions; draft and rejected cases
  // activate nothing. Without the hint, E2E is assumed and API follows the
  // older hasApiCases hint, so callers that predate branches behave as before.
  const e2e = hints.branches ? hints.branches.e2e === true : true;
  const api = hints.branches
    ? hints.branches.api === true
    : hints.hasApiCases === true;
  const external = hints.branches?.external === true;
  const externalRuns = hints.branches?.externalRuns === true;
  if (!e2e && !api && !external) return 'no-executable-scope';

  // Every branch collects its own approvals before anything executes: a
  // mixed scope runs neither suite until both are fully reviewed.
  if (e2e) {
    if (!produced(paths.playwright_spec, hints.specExists)) return 'planner';
    if (!gatePassed(gates.specs_reviewed)) return 'gate3';
    if (!produced(paths.generated_test, hints.generatedTestExists))
      return 'generator';
    if (!gatePassed(gates.code_reviewed)) return 'gate4';
  }
  if (api) {
    if (hints.apiCollectionExists !== true) return 'api';
    if (!gatePassed(gates.collection_reviewed)) return 'gate3-api';
    if (!gatePassed(gates.api_assertions_reviewed)) return 'gate4-api';
  }
  if (external) {
    if (hints.externalPlanExists !== true) return 'external-plan';
    if (!gatePassed(gates.external_plan_reviewed)) return 'gate3-ext';
  }

  // Deterministic order: Playwright, then Newman. A run is not executed until
  // every applicable branch has evidence (an API story never completes on the
  // E2E half alone, task group 4.2).
  if (e2e && !produced(paths.execution_results, hints.executionResultsExist))
    return 'execute';
  if (api && hints.apiExecuted !== true) return 'execute-api';
  // External results are recorded after every plan is approved, and reviewed
  // once they exist. A skip-only scope has nothing to record, but its
  // unexecuted disposition is still reviewed at gate4-ext.
  if (external) {
    if (externalRuns && hints.externalResultsExist !== true)
      return 'external-results';
    if (!gatePassed(gates.external_evidence_reviewed)) return 'gate4-ext';
  }
  if (!produced(paths.failure_analysis, hints.failureAnalysisExists))
    return 'classify';
  // The pre-classifier writes a DRAFT. The Failure Classifier Agent (or a
  // human) finalizes it and writes a bug draft for every Red failure before
  // the Reporter may run on it.
  if (
    hints.failureAnalysisFinalized === false ||
    (hints.bugDraftsMissing ?? 0) > 0
  )
    return 'finalize';
  if (!produced(paths.release_report_json, hints.releaseReportExists))
    return 'report';
  return 'done';
}
