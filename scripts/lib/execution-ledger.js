// Execution-ledger reader + semantic invariants (task group 2.2a).
//
// The ledger is the canonical cross-runner counting model for a run. AJV proves
// its SHAPE; this module proves the things a JSON Schema cannot express:
//
//   - counts equal the sum of mutually exclusive unit outcomes,
//   - a null domain link carries a reason (IDs are never invented — B6),
//   - unit_pass_rate is null for zero units, never 0 or 1,
//   - flaky / expected_failure are never counted as passing coverage,
//   - case coverage comes only from POSITIVELY linked units,
//   - every unit references a declared source execution,
//   - a unit from an errored/interrupted/not-started execution cannot be
//     `passed` — missing provenance is unverified evidence, never a pass.
//
// Read-only by design. Phase 3 (task groups 3.1-3.3) adds the adapters that
// WRITE ledgers; nothing writes one yet, which is why this ships with readers
// and fixtures rather than a writer (the plan's sequencing note).

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, semanticCase } from './approval-binding.js';
import { readValidatedJson } from './artifact-io.js';

// Resolved from THIS module's location, not the working directory, so the
// normalizer and classifier work when the pipeline runner drives them from an
// isolated run workspace (scripts/run-pipeline.js, the demo) -- task group 3.3.
export const LEDGER_SCHEMA = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'schemas',
  'execution-ledger.schema.json'
);

/** The test-case schema, resolved the same way as the ledger schema. */
export const TEST_CASES_SCHEMA = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'schemas',
  'test-cases.schema.json'
);

/** The mutually exclusive unit outcomes, in the order totals declare them. */
export const UNIT_OUTCOMES = [
  'passed',
  'failed',
  'flaky',
  'skipped',
  'blocked',
  'not_run',
  'expected_failure',
];

/** Outcomes that count as passing coverage. Deliberately ONLY `passed`. */
const PASSING = new Set(['passed']);

/** Execution states that cannot yield trustworthy per-unit results. */
const UNTRUSTWORTHY = new Set(['errored', 'interrupted', 'not_started']);

/**
 * Check the invariants AJV cannot express.
 * @returns {{ok: true} | {ok: false, violations: string[]}}
 */
export function ledgerInvariants(ledger) {
  const v = [];
  const units = ledger.units || [];
  const totals = ledger.totals || {};

  // --- counts are derived, not asserted ------------------------------------
  const counted = Object.fromEntries(UNIT_OUTCOMES.map((o) => [o, 0]));
  for (const u of units) {
    if (Object.prototype.hasOwnProperty.call(counted, u.outcome)) {
      counted[u.outcome] += 1;
    }
  }
  for (const outcome of UNIT_OUTCOMES) {
    if ((totals[outcome] ?? 0) !== counted[outcome]) {
      v.push(
        `totals.${outcome} is ${totals[outcome] ?? 0} but ${counted[outcome]} unit(s) have that outcome`
      );
    }
  }
  if ((totals.units ?? 0) !== units.length) {
    v.push(
      `totals.units is ${totals.units ?? 0} but there are ${units.length} unit(s)`
    );
  }

  // Run-level errors are counted separately and never folded into unit totals.
  const sourceErrors = (ledger.source_executions || []).reduce(
    (n, s) => n + (s.source_errors || []).length,
    0
  );
  if ((totals.source_error_count ?? 0) !== sourceErrors) {
    v.push(
      `totals.source_error_count is ${totals.source_error_count ?? 0} but ${sourceErrors} source error(s) are recorded`
    );
  }

  // --- pass rate ------------------------------------------------------------
  const passing = units.filter((u) => PASSING.has(u.outcome)).length;
  if (units.length === 0) {
    if (totals.unit_pass_rate !== null) {
      v.push(
        'unit_pass_rate must be null when there are zero units, never a number'
      );
    }
  } else {
    const expected = passing / units.length;
    const actual = totals.unit_pass_rate;
    if (typeof actual !== 'number' || Math.abs(actual - expected) > 1e-9) {
      v.push(
        `unit_pass_rate is ${actual} but ${passing}/${units.length} units strictly passed`
      );
    }
  }

  // --- identity and provenance ---------------------------------------------
  const executionIds = new Set(
    (ledger.source_executions || []).map((s) => s.execution_id)
  );
  const seenExecIds = new Set();
  for (const s of ledger.source_executions || []) {
    if (seenExecIds.has(s.execution_id)) {
      v.push(`duplicate execution_id: ${s.execution_id}`);
    }
    seenExecIds.add(s.execution_id);
  }

  const untrustworthy = new Set(
    (ledger.source_executions || [])
      .filter((s) => UNTRUSTWORTHY.has(s.process_status))
      .map((s) => s.execution_id)
  );

  const seenUnitIds = new Set();
  for (const u of units) {
    if (seenUnitIds.has(u.unit_id)) {
      v.push(`duplicate unit_id: ${u.unit_id}`);
    }
    seenUnitIds.add(u.unit_id);

    if (!executionIds.has(u.execution_id)) {
      v.push(
        `unit ${u.unit_id} references unknown execution_id ${u.execution_id}`
      );
    }

    // Missing provenance means unverified evidence, never a pass.
    if (untrustworthy.has(u.execution_id) && u.outcome === 'passed') {
      v.push(
        `unit ${u.unit_id} is 'passed' but its execution did not complete trustworthily`
      );
    }

    // A null link needs a stated reason; IDs are never invented (B6).
    const links = u.domain_links;
    if (links) {
      const idKeys = [
        'test_case_id',
        'api_test_case_id',
        'playwright_test_id',
        'request_id',
        'spec_id',
      ];
      const present = idKeys.filter((k) => k in links);
      const anyNull = present.some((k) => links[k] === null);
      if (anyNull && !links.unresolved_reason) {
        v.push(
          `unit ${u.unit_id} has a null domain link without an unresolved_reason`
        );
      }
    }

    // Newman: zero business assertions is blocked, however the transport went.
    if (
      u.identity &&
      u.identity.kind === 'newman' &&
      Array.isArray(u.assertions) &&
      u.assertions.length === 0 &&
      u.outcome === 'passed'
    ) {
      v.push(
        `unit ${u.unit_id} is a newman request with zero assertions and cannot be 'passed'`
      );
    }
  }

  // --- approved-case coverage ----------------------------------------------
  const unitById = new Map(units.map((u) => [u.unit_id, u]));
  const cases = ledger.case_outcomes || [];
  for (const c of cases) {
    for (const id of c.linked_unit_ids || []) {
      if (!unitById.has(id)) {
        v.push(`case ${c.test_case_id} links unknown unit_id ${id}`);
      }
    }
    // Coverage comes only from positively linked units.
    if (c.outcome === 'passed') {
      const linked = (c.linked_unit_ids || []).map((id) => unitById.get(id));
      if (linked.length === 0) {
        v.push(`case ${c.test_case_id} is 'passed' with no linked unit`);
      } else if (!linked.every((u) => u && PASSING.has(u.outcome))) {
        v.push(
          `case ${c.test_case_id} is 'passed' but not every linked unit strictly passed`
        );
      }
    }
  }

  if (cases.length === 0) {
    if (
      totals.approved_case_coverage !== null &&
      totals.approved_case_coverage !== undefined
    ) {
      v.push(
        'approved_case_coverage must be null when no approved cases are tracked'
      );
    }
  } else if (totals.approved_case_coverage !== undefined) {
    const passedCases = cases.filter((c) => c.outcome === 'passed').length;
    const expected = passedCases / cases.length;
    const actual = totals.approved_case_coverage;
    if (typeof actual !== 'number' || Math.abs(actual - expected) > 1e-9) {
      v.push(
        `approved_case_coverage is ${actual} but ${passedCases}/${cases.length} approved cases passed`
      );
    }
  }

  return v.length ? { ok: false, violations: v } : { ok: true };
}

/**
 * The legacy flat projection, for reports that still carry flat fields.
 * Defined by the plan so the projection is stated once rather than re-derived
 * (and mis-derived) per consumer.
 */
export function legacySummaryProjection(totals) {
  const n = (k) => totals[k] ?? 0;
  return {
    passed: n('passed'),
    failed: n('failed') + n('blocked') + n('flaky'),
    skipped: n('skipped') + n('not_run') + n('expected_failure'),
    total_tests: UNIT_OUTCOMES.reduce((sum, k) => sum + n(k), 0),
  };
}

/**
 * Load a ledger: schema-validate, then check semantic invariants, then confirm
 * it belongs to the run the caller asked about.
 */
export function readLedger(path, expect = {}) {
  const read = readValidatedJson(path, LEDGER_SCHEMA);
  if (!read.ok) return read;

  const ledger = read.data;

  if (expect.storyId && ledger.story_id !== expect.storyId) {
    return {
      ok: false,
      kind: 'identity_mismatch',
      message: `${path} belongs to story ${ledger.story_id}, not ${expect.storyId}`,
    };
  }
  if (expect.runId && ledger.run_id !== expect.runId) {
    return {
      ok: false,
      kind: 'identity_mismatch',
      message: `${path} belongs to run ${ledger.run_id}, not ${expect.runId}`,
    };
  }

  const inv = ledgerInvariants(ledger);
  if (!inv.ok) {
    return {
      ok: false,
      kind: 'ledger_invariant',
      message: `${path} violates ledger invariants`,
      violations: inv.violations,
    };
  }

  return { ok: true, data: ledger };
}

// ---------------------------------------------------------------- scope

/**
 * Digest of the approved test-case scope a ledger was built against
 * (task group 5.3). Only approved cases count, without the linkage fields
 * adapters write back, so syncing a case never changes the scope.
 */
export function approvedScopeDigest(testCasesDoc) {
  const cases = (testCasesDoc.test_cases ?? [])
    .filter((tc) => tc.status === 'approved')
    .map(semanticCase)
    .sort((a, b) => a.test_case_id.localeCompare(b.test_case_id));
  return createHash('sha256')
    .update(
      canonicalJson({ story_id: testCasesDoc.story_id, approved_cases: cases })
    )
    .digest('hex');
}

// ---------------------------------------------------- per-case outcome

/** The outcomes a test case can be reported with (config/testlink-status-map.json). */
export const CASE_REPORT_OUTCOMES = [
  'passed',
  'product_failure',
  'blocked',
  'not_run',
];

const NOT_EXECUTED = new Set(['skipped', 'not_run']);
const NON_PASSING = new Set(['failed', 'blocked', 'flaky', 'expected_failure']);

const linksTo = (unit, caseId) => {
  const l = unit.domain_links || {};
  return l.test_case_id === caseId || l.api_test_case_id === caseId;
};
const unattributed = (unit) => {
  const l = unit.domain_links || {};
  return !l.test_case_id && !l.api_test_case_id;
};

/**
 * One reportable outcome for one test case, from ALL of its linked units.
 *
 * Precedence (IMPLEMENTATION_PLAN 5.3):
 *   intentionally skipped / manual / no linked unit           -> not_run
 *   a failed unit the finalized analysis confirms as product_bug -> product_failure
 *   any other failure, block, flake, expected failure, an
 *   unattributed non-passing unit of the same runner, evidence
 *   from an execution with source errors, or partial execution -> blocked
 *   every linked unit skipped / not run                        -> not_run
 *   every linked unit explicitly passed                        -> passed
 *
 * Set-based throughout, so the order of units or failures cannot change the
 * result. A manual case never borrows another case's units: its outcome needs
 * a human evidence record, which does not exist yet.
 *
 * @param {object} args
 * @param {object} args.testCase   one test case
 * @param {object} args.ledger     a validated ledger of the current run
 * @param {Set<string>} [args.confirmedProductFailureUnits] unit ids a
 *   finalized failure analysis classifies as product_bug
 * @returns {{outcome: string, reason: string, unitIds: string[]}}
 */
export function testCaseOutcome({
  testCase,
  ledger,
  confirmedProductFailureUnits = new Set(),
}) {
  const id = testCase.test_case_id;
  const notRun = (reason, unitIds = []) => ({
    outcome: 'not_run',
    reason,
    unitIds,
  });

  if (testCase.automation_decision === 'skip') {
    return notRun('intentionally skipped (automation_decision: skip)');
  }
  if (testCase.automation_decision === 'manual') {
    return notRun(
      'manual case: its result needs a human evidence record, and no automated result is borrowed'
    );
  }

  const units = ledger.units ?? [];
  const linked = units.filter((u) => linksTo(u, id));
  const unitIds = linked.map((u) => u.unit_id).sort();
  if (linked.length === 0) {
    return notRun('no executed unit links to this case', unitIds);
  }

  const confirmed = linked.filter(
    (u) => u.outcome === 'failed' && confirmedProductFailureUnits.has(u.unit_id)
  );
  if (confirmed.length) {
    return {
      outcome: 'product_failure',
      reason: `confirmed product failure in ${confirmed
        .map((u) => u.unit_id)
        .sort()
        .join(', ')}`,
      unitIds,
    };
  }

  const blocked = (reason) => ({ outcome: 'blocked', reason, unitIds });

  const nonPassing = linked.filter((u) => NON_PASSING.has(u.outcome));
  if (nonPassing.length) {
    const kinds = [...new Set(nonPassing.map((u) => u.outcome))].sort();
    return blocked(
      `linked unit(s) ${kinds.join('/')} without a confirmed product failure`
    );
  }

  const executions = new Map(
    (ledger.source_executions ?? []).map((e) => [e.execution_id, e])
  );
  const troubled = linked.filter((u) => {
    const e = executions.get(u.execution_id);
    return (
      !e || e.process_status !== 'completed' || (e.source_errors ?? []).length
    );
  });
  if (troubled.length) {
    return blocked(
      'its evidence comes from an execution that did not complete cleanly'
    );
  }

  const kinds = new Set(linked.map((u) => u.identity?.kind));
  const stray = units.filter(
    (u) =>
      unattributed(u) &&
      kinds.has(u.identity?.kind) &&
      !NOT_EXECUTED.has(u.outcome) &&
      u.outcome !== 'passed'
  );
  if (stray.length) {
    return blocked(
      `${stray.length} unattributed non-passing unit(s) from the same runner may belong to this case`
    );
  }

  const ran = linked.filter((u) => u.outcome === 'passed');
  if (ran.length === 0) {
    return notRun('its linked units did not execute', unitIds);
  }
  if (ran.length < linked.length) {
    return blocked('partially executed: some linked units did not run');
  }
  return {
    outcome: 'passed',
    reason: `all ${linked.length} linked unit(s) passed`,
    unitIds,
  };
}
