// Ledger assembly (task group 3.1).
//
// Turns adapter output into a complete, schema-valid execution ledger:
// derives every total from the units (never asserts a count), maps approved
// cases onto units through PROVEN links only, and records what could not be
// mapped instead of guessing.
//
// The adapters (./execution-results.js) never resolve domain IDs; that is this
// module's job, and it does it from exact metadata, never from ordering.

import { UNIT_OUTCOMES } from './execution-ledger.js';

/** Outcomes that count as passing coverage. Only a strict pass qualifies. */
const PASSING = new Set(['passed']);

const LINK_KEYS = [
  'test_case_id',
  'api_test_case_id',
  'playwright_test_id',
  'request_id',
  'spec_id',
];

/** Exact id syntax per link. Anything looser would be a guess. */
const ID_PATTERN = {
  test_case_id: /\bTC-\d+\b/g,
  api_test_case_id: /\bAPI-\d+\b/g,
  playwright_test_id: /\bPW-\d+\b/g,
  request_id: /\bREQ-\d+\b/g,
  spec_id: /\bSPEC-\d+\b/g,
};

/**
 * Domain ids the RUNNER REPORT itself proves for a unit (task group 3.3).
 *
 * The documented conventions put ids where the report carries them:
 *   - Playwright: the test title, e.g. `valid login shows the inventory [TC-001]`;
 *   - Newman:     the item name, `REQ-001 Create user returns 201 (TC-001)`
 *                 (agents/api-agent.md).
 * Header comments such as `PW-001 — ...` are NOT read: they never reach the
 * report, and pairing a comment with one test in a multi-test file would be a
 * guess.
 *
 * @returns {{ids: object, conflicts: string[]}} one value per key, or a
 *   conflict when the text names two DIFFERENT ids of the same kind.
 */
export function idsFromMetadata(unit) {
  const text =
    unit.identity?.kind === 'newman'
      ? (unit.identity?.request_name ?? '')
      : (unit.identity?.test_title ?? '');
  const ids = {};
  const conflicts = [];
  for (const key of LINK_KEYS) {
    const found = [...new Set(text.match(ID_PATTERN[key]) ?? [])];
    if (found.length === 1) ids[key] = found[0];
    else if (found.length > 1) conflicts.push(`${key} (${found.join(' vs ')})`);
  }
  return { ids, conflicts };
}

/**
 * Resolve domain links for every unit.
 *
 * Two sources, both exact: ids the report itself carries (idsFromMetadata) and
 * an optional caller-supplied mapping. When they DISAGREE the link stays null
 * and the conflict is recorded -- never an arbitrary selection. Nothing is
 * ever inferred from position or failure ordering (finding B6).
 *
 * @param {object[]} units
 * @param {object} mapping  { [unit_id]: {test_case_id?, ...} | Array (ambiguous) }
 * @returns {{units: object[], unmapped: string[], ambiguous: string[]}}
 */
export function resolveDomainLinks(units, mapping = {}) {
  const unmapped = [];
  const ambiguous = [];

  const resolved = units.map((u) => {
    const m = mapping[u.unit_id];

    // An entry claiming several cases for one unit is ambiguous, not a coin
    // flip.
    if (Array.isArray(m)) {
      ambiguous.push(u.unit_id);
      return {
        ...u,
        domain_links: {
          ...u.domain_links,
          unresolved_reason: `Ambiguous mapping: ${m.length} candidate cases claim this unit; a human must disambiguate.`,
        },
      };
    }

    const meta = idsFromMetadata(u);
    const conflicts = [...meta.conflicts];
    const links = { ...u.domain_links };
    let any = false;

    for (const key of LINK_KEYS) {
      const fromMeta = meta.ids[key];
      const fromMap = m?.[key];
      if (fromMeta && fromMap && fromMeta !== fromMap) {
        conflicts.push(
          `${key} (report says ${fromMeta}, mapping says ${fromMap})`
        );
        links[key] = null;
        continue;
      }
      const value = fromMap || fromMeta;
      if (value) {
        links[key] = value;
        any = true;
      }
    }
    // A key named in a conflict is never kept, whichever source set it.
    for (const c of meta.conflicts) links[c.split(' ')[0]] = null;

    if (conflicts.length) ambiguous.push(u.unit_id);
    else if (!any) unmapped.push(u.unit_id);

    // The schema requires a reason whenever ANY present link is still null.
    const missing = LINK_KEYS.filter((k) => k in links && links[k] === null);
    if (missing.length === 0) {
      delete links.unresolved_reason;
    } else if (conflicts.length) {
      links.unresolved_reason = `Conflicting metadata, left unresolved for a human: ${conflicts.join('; ')}.`;
    } else if (any) {
      links.unresolved_reason = `Partially resolved from metadata; no exact id for: ${missing.join(', ')}.`;
    }
    // (Nothing proven at all: the adapter's own reason is kept.)

    return { ...u, domain_links: links };
  });

  return { units: resolved, unmapped, ambiguous };
}

/**
 * Derive approved-case outcomes from units.
 *
 * Coverage flows ONLY through positive links: an approved case with no linked
 * unit is `not_run` and creates no fictional unit. A case is `passed` only when
 * every linked unit strictly passed.
 *
 * @param {string[]} approvedCaseIds
 * @param {object[]} units  units with resolved domain_links
 */
export function deriveCaseOutcomes(approvedCaseIds, units) {
  return approvedCaseIds.map((caseId) => {
    const linked = units.filter((u) => {
      const l = u.domain_links || {};
      return l.test_case_id === caseId || l.api_test_case_id === caseId;
    });

    if (linked.length === 0) {
      return {
        test_case_id: caseId,
        outcome: 'not_run',
        linked_unit_ids: [],
        reason:
          'No executed unit links to this approved case; it contributes no coverage.',
      };
    }

    const ids = linked.map((u) => u.unit_id);
    const outcomes = new Set(linked.map((u) => u.outcome));

    let outcome;
    if (linked.every((u) => PASSING.has(u.outcome))) outcome = 'passed';
    else if (outcomes.has('failed')) outcome = 'failed';
    else if (outcomes.has('blocked')) outcome = 'blocked';
    else if (outcomes.has('flaky'))
      outcome = 'failed'; // unstable is not covered
    else if (outcomes.has('expected_failure')) outcome = 'expected_failure';
    else if (outcomes.has('skipped')) outcome = 'skipped';
    else outcome = 'not_run';

    return { test_case_id: caseId, outcome, linked_unit_ids: ids };
  });
}

/** Derive totals from units. Counts are never supplied by a caller. */
export function deriveTotals(units, caseOutcomes, sourceErrorCount) {
  const counts = Object.fromEntries(UNIT_OUTCOMES.map((o) => [o, 0]));
  for (const u of units) {
    if (Object.prototype.hasOwnProperty.call(counts, u.outcome)) {
      counts[u.outcome] += 1;
    }
  }

  const passing = units.filter((u) => PASSING.has(u.outcome)).length;

  const totals = {
    units: units.length,
    ...counts,
    source_error_count: sourceErrorCount,
    // Null for zero units: "we ran nothing" is not a pass rate of 0 or 1.
    unit_pass_rate: units.length === 0 ? null : passing / units.length,
  };

  if (caseOutcomes.length === 0) {
    totals.approved_case_coverage = null;
  } else {
    const passed = caseOutcomes.filter((c) => c.outcome === 'passed').length;
    totals.approved_case_coverage = passed / caseOutcomes.length;
  }

  return totals;
}

/**
 * Assemble a complete ledger.
 *
 * @param {object} input
 * @param {string} input.runId
 * @param {string} input.storyId
 * @param {string} input.generatedAt   ISO timestamp
 * @param {object[]} input.sourceExecutions
 * @param {object[]} input.units
 * @param {string[]} [input.approvedCaseIds]
 * @param {object} [input.mapping]
 * @param {string|null} [input.approvedScopeDigest]
 */
export function buildLedger({
  runId,
  storyId,
  generatedAt,
  sourceExecutions,
  units,
  approvedCaseIds = [],
  mapping = {},
  approvedScopeDigest = null,
}) {
  const {
    units: linked,
    unmapped,
    ambiguous,
  } = resolveDomainLinks(units, mapping);

  const caseOutcomes = deriveCaseOutcomes(approvedCaseIds, linked);

  const sourceErrorCount = sourceExecutions.reduce(
    (n, s) => n + (s.source_errors || []).length,
    0
  );

  const ledger = {
    schema_version: '1.0',
    run_id: runId,
    story_id: storyId,
    generated_at: generatedAt,
    approved_scope_digest: approvedScopeDigest,
    source_executions: sourceExecutions,
    units: linked,
    case_outcomes: caseOutcomes,
    totals: deriveTotals(linked, caseOutcomes, sourceErrorCount),
  };

  return { ledger, unmapped, ambiguous };
}
