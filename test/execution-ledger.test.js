// Regression tests for the execution ledger (task group 2.2a).
//
// The ledger exists because raw runner reports cannot be trusted as a counting
// model: they disagree about what a "test" is, they drop timed-out results
// (B2), they let transport errors produce negative counts (B5), and they let
// IDs be invented from failure ordering (B6). AJV proves the SHAPE; these tests
// prove the invariants a JSON Schema cannot express.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ledgerInvariants,
  legacySummaryProjection,
  readLedger,
  UNIT_OUTCOMES,
  LEDGER_SCHEMA,
} from '../scripts/lib/execution-ledger.js';
import { validateValue } from '../scripts/lib/artifact-io.js';

const GOLD = 'examples/expected/mixed-run.expected-execution-ledger.json';

function gold() {
  return JSON.parse(readFileSync(GOLD, 'utf8'));
}

/** Recompute totals so a mutated fixture stays internally consistent. */
function retotal(ledger) {
  const counts = Object.fromEntries(UNIT_OUTCOMES.map((o) => [o, 0]));
  for (const u of ledger.units) counts[u.outcome] += 1;
  const passing = counts.passed;
  ledger.totals = {
    ...ledger.totals,
    ...counts,
    units: ledger.units.length,
    unit_pass_rate:
      ledger.units.length === 0 ? null : passing / ledger.units.length,
  };
  return ledger;
}

// --- the gold fixture is valid on both axes -------------------------------

test('gold ledger validates against the schema and the invariants', () => {
  const l = gold();
  assert.equal(validateValue(l, LEDGER_SCHEMA).ok, true);
  const inv = ledgerInvariants(l);
  assert.equal(inv.ok, true, JSON.stringify(inv.violations));
});

test('gold ledger exercises every runner and a source-level error', () => {
  const l = gold();
  const kinds = new Set(l.units.map((u) => u.identity.kind));
  assert.ok(kinds.has('playwright') && kinds.has('newman'));
  assert.equal(l.totals.source_error_count, 1);
});

test('readLedger loads the gold file and refuses a wrong-run request', () => {
  const ok = readLedger(GOLD, { storyId: 'STORY-020' });
  assert.equal(ok.ok, true, ok.message);

  const wrong = readLedger(GOLD, { storyId: 'STORY-999' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.kind, 'identity_mismatch');
});

// --- counts are derived, never asserted -----------------------------------

test('a totals count that disagrees with the units is rejected', () => {
  const l = gold();
  l.totals.passed += 1; // claim one more pass than exists
  const inv = ledgerInvariants(l);
  assert.equal(inv.ok, false);
  assert.match(inv.violations.join('\n'), /totals\.passed/);
});

test('run-level errors are counted separately, never folded into unit totals', () => {
  const l = gold();
  l.totals.source_error_count = 0; // hide the setup error
  const inv = ledgerInvariants(l);
  assert.equal(inv.ok, false);
  assert.match(inv.violations.join('\n'), /source_error_count/);
});

// --- pass rate ------------------------------------------------------------

test('unit_pass_rate must be null for zero units, never 0', () => {
  const l = gold();
  l.units = [];
  l.case_outcomes = [];
  retotal(l);
  l.totals.approved_case_coverage = null;

  l.totals.unit_pass_rate = 0; // the tempting wrong answer
  let inv = ledgerInvariants(l);
  assert.equal(inv.ok, false);
  assert.match(
    inv.violations.join('\n'),
    /must be null when there are zero units/
  );

  l.totals.unit_pass_rate = null;
  inv = ledgerInvariants(l);
  assert.equal(inv.ok, true, JSON.stringify(inv.violations));
});

test('flaky and expected_failure never count as passing coverage', () => {
  const l = gold();
  // Three units: one passed, one flaky, one expected_failure.
  l.units = [
    { ...l.units[0], unit_id: 'a', outcome: 'passed' },
    { ...l.units[0], unit_id: 'b', outcome: 'flaky' },
    { ...l.units[0], unit_id: 'c', outcome: 'expected_failure' },
  ];
  l.case_outcomes = [];
  retotal(l);
  l.totals.approved_case_coverage = null;

  const inv = ledgerInvariants(l);
  assert.equal(inv.ok, true, JSON.stringify(inv.violations));
  // Strictly 1 of 3 — flaky and expected_failure are NOT passes.
  assert.ok(Math.abs(l.totals.unit_pass_rate - 1 / 3) < 1e-9);
});

// --- provenance: unverified evidence is never a pass ----------------------

test('a unit from an errored execution cannot be passed', () => {
  const l = gold();
  l.source_executions[0].process_status = 'errored';
  const inv = ledgerInvariants(l);
  assert.equal(inv.ok, false);
  assert.match(inv.violations.join('\n'), /did not complete trustworthily/);
});

test('a unit referencing an unknown execution is rejected', () => {
  const l = gold();
  l.units[0].execution_id = 'exec-does-not-exist';
  const inv = ledgerInvariants(l);
  assert.equal(inv.ok, false);
  assert.match(inv.violations.join('\n'), /unknown execution_id/);
});

test('duplicate unit and execution identities are rejected', () => {
  const dupUnit = gold();
  dupUnit.units[1].unit_id = dupUnit.units[0].unit_id;
  assert.match(
    ledgerInvariants(dupUnit).violations.join('\n'),
    /duplicate unit_id/
  );

  const dupExec = gold();
  dupExec.source_executions[1].execution_id =
    dupExec.source_executions[0].execution_id;
  assert.match(
    ledgerInvariants(dupExec).violations.join('\n'),
    /duplicate execution_id/
  );
});

// --- IDs are never invented (B6) ------------------------------------------

test('a null domain link without an unresolved_reason is rejected', () => {
  const l = gold();
  l.units[3].domain_links.unresolved_reason = null; // the seed test
  const inv = ledgerInvariants(l);
  assert.equal(inv.ok, false);
  assert.match(inv.violations.join('\n'), /without an unresolved_reason/);
});

test('an unresolved identity is representable WITH a reason', () => {
  const l = gold();
  const seed = l.units.find((u) => u.unit_id === 'u-pw-4');
  assert.equal(seed.domain_links.test_case_id, null);
  assert.ok(seed.domain_links.unresolved_reason.length > 0);
  assert.equal(ledgerInvariants(l).ok, true);
});

// --- Newman: zero assertions is blocked, not passed -----------------------

test('a newman request with zero assertions cannot be passed', () => {
  const l = gold();
  const blocked = l.units.find((u) => u.unit_id === 'u-newman-2');
  blocked.outcome = 'passed'; // transport succeeded, but nothing was asserted
  retotal(l);
  const inv = ledgerInvariants(l);
  assert.equal(inv.ok, false);
  assert.match(inv.violations.join('\n'), /zero assertions/);
});

// --- approved-case coverage is separate from unit totals ------------------

test('an approved case with no executable unit is not_run and inflates nothing', () => {
  const l = gold();
  const manual = l.case_outcomes.find((c) => c.test_case_id === 'TC-004');
  assert.equal(manual.outcome, 'not_run');
  assert.deepEqual(manual.linked_unit_ids, []);
  // It must NOT appear among runner units.
  assert.equal(l.units.length, l.totals.units);
  assert.equal(ledgerInvariants(l).ok, true);
});

test('a case cannot be passed without a positively linked passing unit', () => {
  const noLink = gold();
  noLink.case_outcomes.push({
    test_case_id: 'TC-009',
    outcome: 'passed',
    linked_unit_ids: [],
  });
  noLink.totals.approved_case_coverage = 3 / 7;
  assert.match(
    ledgerInvariants(noLink).violations.join('\n'),
    /'passed' with no linked unit/
  );

  const badLink = gold();
  const failing = badLink.case_outcomes.find(
    (c) => c.test_case_id === 'TC-002'
  );
  failing.outcome = 'passed'; // linked unit actually failed
  badLink.totals.approved_case_coverage = 3 / 6;
  assert.match(
    ledgerInvariants(badLink).violations.join('\n'),
    /not every linked unit strictly passed/
  );
});

test('a case linking an unknown unit is rejected', () => {
  const l = gold();
  l.case_outcomes[0].linked_unit_ids = ['u-nope'];
  assert.match(
    ledgerInvariants(l).violations.join('\n'),
    /links unknown unit_id/
  );
});

test('approved_case_coverage must agree with the case outcomes', () => {
  const l = gold();
  l.totals.approved_case_coverage = 1; // claim full coverage
  const inv = ledgerInvariants(l);
  assert.equal(inv.ok, false);
  assert.match(inv.violations.join('\n'), /approved_case_coverage/);
});

// --- the legacy flat projection is stated once ----------------------------

test('legacy projection folds blocked and flaky into failed, not into passed', () => {
  const p = legacySummaryProjection(gold().totals);
  assert.deepEqual(p, {
    passed: 2,
    failed: 3, // 1 failed + 1 blocked + 1 flaky
    skipped: 1, // 1 skipped + 0 not_run + 0 expected_failure
    total_tests: 6,
  });
});

test('legacy projection never reports a negative count (guards B5)', () => {
  const totals = {
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    blocked: 1,
    not_run: 0,
    expected_failure: 0,
  };
  const p = legacySummaryProjection(totals);
  for (const [k, v] of Object.entries(p)) {
    assert.ok(v >= 0, `${k} must never be negative, got ${v}`);
  }
  assert.equal(p.passed, 0);
  assert.equal(p.failed, 1);
});

// --- schema-level rejections ----------------------------------------------

test('the schema rejects an unknown outcome and a wrong schema_version', () => {
  const badOutcome = gold();
  badOutcome.units[0].outcome = 'probably_fine';
  assert.equal(validateValue(badOutcome, LEDGER_SCHEMA).ok, false);

  const badVersion = gold();
  badVersion.schema_version = '2.0';
  assert.equal(validateValue(badVersion, LEDGER_SCHEMA).ok, false);
});

test('the schema rejects an out-of-range pass rate', () => {
  const l = gold();
  l.totals.unit_pass_rate = 1.5;
  assert.equal(validateValue(l, LEDGER_SCHEMA).ok, false);
});
