// Regression tests for the runner adapters and ledger assembly (task group 3.1).
//
// These run against REAL captured runner reports in test/fixtures/, produced by
// actually executing failing Playwright tests and a Newman collection against a
// local server. That matters: hand-written fixtures encode what we BELIEVE the
// runners emit, and the belief was wrong in two places --
//
//   * Playwright reports `timedOut` only on an ATTEMPT; the test status is
//     `unexpected`. Code matching attempt statuses drops the timeout (B2).
//   * Newman's `failures[]` had 4 entries for 3 failed assertions, because a
//     transport error adds a failure with no assertion of its own (B5).
//
// Both would have passed a test suite built on invented fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  adaptPlaywrightReport,
  adaptNewmanReport,
  playwrightOutcome,
  newmanOutcome,
} from '../scripts/lib/execution-results.js';
import {
  buildLedger,
  deriveCaseOutcomes,
  deriveTotals,
  resolveDomainLinks,
} from '../scripts/lib/build-ledger.js';
import {
  ledgerInvariants,
  legacySummaryProjection,
  LEDGER_SCHEMA,
} from '../scripts/lib/execution-ledger.js';
import { validateValue } from '../scripts/lib/artifact-io.js';

const PW_FIXTURE = 'test/fixtures/playwright-all-outcomes.json';
const NM_FIXTURE = 'test/fixtures/newman-mixed-outcomes.json';

/** The secret injected when the Newman fixture was captured. */
const FIXTURE_SECRET = 'SYNTHETIC-FIXTURE-SECRET-8f3a21c7bd94';

const pwReport = () => JSON.parse(readFileSync(PW_FIXTURE, 'utf8'));
const nmReport = () => JSON.parse(readFileSync(NM_FIXTURE, 'utf8'));

const pwUnits = (opts = {}) =>
  adaptPlaywrightReport(pwReport(), { executionId: 'exec-pw', ...opts });
const nmUnits = (opts = {}) =>
  adaptNewmanReport(nmReport(), { executionId: 'exec-nm', ...opts });

function tally(units) {
  const t = {};
  for (const u of units) t[u.outcome] = (t[u.outcome] || 0) + 1;
  return t;
}

// --- Playwright: every outcome survives ------------------------------------

test('every Playwright outcome is represented exactly once per project', () => {
  const { units } = pwUnits();
  assert.equal(units.length, 12); // 6 tests x 2 projects
  assert.deepEqual(tally(units), {
    passed: 2,
    failed: 4,
    flaky: 2,
    skipped: 2,
    expected_failure: 2,
  });
});

test('a timed-out test is a failure, not a silent disappearance (B2)', () => {
  const { units } = pwUnits();
  const timedOut = units.filter((u) =>
    (u.attempts || []).some((a) => a.status === 'timed_out')
  );
  assert.equal(timedOut.length, 2, 'both projects timed out');
  for (const u of timedOut) {
    assert.equal(u.outcome, 'failed');
  }
});

test("the adapter's failed count matches Playwright's own unexpected count", () => {
  const report = pwReport();
  const { units } = adaptPlaywrightReport(report, { executionId: 'e' });
  assert.equal(tally(units).failed, report.stats.unexpected);
});

test('a retried-then-passing test is flaky, never passed', () => {
  const { units } = pwUnits();
  const flaky = units.filter((u) => u.outcome === 'flaky');
  assert.equal(flaky.length, 2);
  for (const u of flaky) {
    // The LAST attempt passed; reading it alone would report a clean pass.
    assert.equal(u.attempts.at(-1).status, 'passed');
    assert.equal(u.attempts[0].status, 'failed');
  }
});

test('a declared expected failure is not passing coverage', () => {
  const { units } = pwUnits();
  const ef = units.filter((u) => u.outcome === 'expected_failure');
  assert.equal(ef.length, 2);
  // Playwright folds these into stats.expected alongside real passes...
  assert.equal(pwReport().stats.expected, 4);
  // ...the ledger keeps them apart.
  assert.equal(tally(units).passed, 2);
});

test('playwrightOutcome maps each status without inventing a pass', () => {
  assert.equal(playwrightOutcome({ status: 'flaky', results: [{}] }), 'flaky');
  assert.equal(
    playwrightOutcome({ status: 'skipped', results: [{}] }),
    'skipped'
  );
  assert.equal(
    playwrightOutcome({ status: 'unexpected', results: [{}] }),
    'failed'
  );
  assert.equal(
    playwrightOutcome({
      status: 'expected',
      expectedStatus: 'passed',
      results: [{}],
    }),
    'passed'
  );
  assert.equal(
    playwrightOutcome({
      status: 'expected',
      expectedStatus: 'failed',
      results: [{}],
    }),
    'expected_failure'
  );
  // No attempts at all: nothing ran.
  assert.equal(
    playwrightOutcome({ status: 'expected', results: [] }),
    'not_run'
  );
  // An unknown status is unverified evidence.
  assert.equal(
    playwrightOutcome({ status: 'martian', results: [{}] }),
    'blocked'
  );
});

test('an interrupted attempt blocks the unit rather than failing it', () => {
  assert.equal(
    playwrightOutcome({
      status: 'unexpected',
      results: [{ status: 'interrupted' }],
    }),
    'blocked'
  );
});

test('report-level errors survive even when no tests ran', () => {
  const { units, sourceErrors } = adaptPlaywrightReport(
    {
      suites: [],
      errors: [{ message: 'global setup failed: port in use' }],
      stats: {},
    },
    { executionId: 'e' }
  );
  assert.equal(units.length, 0);
  assert.equal(sourceErrors.length, 1);
  assert.match(sourceErrors[0].message, /global setup failed/);
});

test('an empty suite produces no units and no invented failures', () => {
  const { units, sourceErrors } = adaptPlaywrightReport(
    { suites: [], errors: [], stats: {} },
    { executionId: 'e' }
  );
  assert.deepEqual(units, []);
  assert.deepEqual(sourceErrors, []);
});

test('unit identity is stable across projects and independent of outcome', () => {
  const { units } = pwUnits();
  const ids = units.map((u) => u.unit_id);
  assert.equal(new Set(ids).size, ids.length, 'all unit ids are unique');
  // Same title, different project => different id, same outcome-independent form.
  const plain = units.filter((u) =>
    u.identity.test_title.endsWith('plain pass')
  );
  assert.equal(plain.length, 2);
  assert.notEqual(plain[0].unit_id, plain[1].unit_id);
  // The property that matters: an id is a function of runner identity alone,
  // so re-running with different results produces the SAME ids. (A title may
  // legitimately contain the word "pass"; that is data, not an encoded outcome.)
  const report = pwReport();
  const flip = { expected: 'unexpected', unexpected: 'expected' };
  (function mutate(suites) {
    for (const s of suites || []) {
      for (const sp of s.specs || []) {
        for (const t of sp.tests || []) t.status = flip[t.status] || t.status;
      }
      if (s.suites) mutate(s.suites);
    }
  })(report.suites);

  const after = adaptPlaywrightReport(report, { executionId: 'exec-pw' }).units;
  assert.deepEqual(
    after.map((u) => u.unit_id),
    ids,
    'ids must not change when outcomes change'
  );
  assert.notDeepEqual(
    after.map((u) => u.outcome),
    units.map((u) => u.outcome),
    'the mutation really did change outcomes'
  );
});

// --- Newman: transport vs business, and the B5 arithmetic ------------------

test('newman units are one per request, with assertions nested', () => {
  const { units } = nmUnits();
  assert.equal(units.length, 4);
  const byName = Object.fromEntries(
    units.map((u) => [u.identity.request_name, u])
  );

  assert.equal(byName['Passing request with assertions'].outcome, 'passed');
  assert.equal(byName['Passing request with assertions'].assertions.length, 2);

  assert.equal(
    byName['Request with multiple failing assertions'].outcome,
    'failed'
  );
  // Three assertions in ONE unit -- never three units.
  assert.equal(
    byName['Request with multiple failing assertions'].assertions.length,
    3
  );
  assert.equal(
    byName['Request with multiple failing assertions'].assertions.filter(
      (a) => !a.passed
    ).length,
    2
  );
});

test('a zero-assertion request is blocked, never passed', () => {
  const { units } = nmUnits();
  const zero = units.find(
    (u) => u.identity.request_name === 'Request with zero assertions'
  );
  assert.equal(zero.outcome, 'blocked');
  assert.ok(!zero.assertions, 'no assertions recorded');
});

test('a transport error is blocked, not a business failure', () => {
  const { units } = nmUnits();
  const dead = units.find(
    (u) => u.identity.request_name === 'Request that cannot connect'
  );
  assert.equal(dead.outcome, 'blocked');
  // Newman still recorded a FAILED assertion for it (the script ran with no
  // response). Counting that as a business failure would be wrong.
  assert.equal(dead.assertions.length, 1);
  assert.equal(dead.assertions[0].passed, false);
  assert.match(dead.attempts[0].error_message, /ECONNREFUSED/);
});

test('transport errors are never subtracted from assertion totals (B5)', () => {
  const report = nmReport();
  // The raw report's own numbers disagree: 3 failed assertions, 4 failures.
  assert.equal(report.run.stats.assertions.failed, 3);
  assert.equal(report.run.failures.length, 4);
  // The old formula: assertions.total - failures.length.
  const oldPassed =
    report.run.stats.assertions.total - report.run.failures.length;
  assert.equal(oldPassed, 2, 'the discarded formula under-counts here');

  // The adapter counts units, so no subtraction happens at all.
  const { units } = nmUnits();
  const counts = tally(units);
  assert.equal(counts.passed, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.blocked, 2);
  for (const n of Object.values(counts)) assert.ok(n >= 0);
});

test('newmanOutcome checks transport before assertions', () => {
  // A failed assertion produced against no response must not read as `failed`.
  assert.equal(
    newmanOutcome({
      requestError: { code: 'ECONNREFUSED' },
      assertions: [{ error: {} }],
    }),
    'blocked'
  );
  assert.equal(
    newmanOutcome({ response: { code: 200 }, assertions: [] }),
    'blocked'
  );
  assert.equal(
    newmanOutcome({ response: { code: 200 }, assertions: [{}, {}] }),
    'passed'
  );
  assert.equal(
    newmanOutcome({ response: { code: 500 }, assertions: [{}, { error: {} }] }),
    'failed'
  );
  assert.equal(
    newmanOutcome({ response: { code: 200 }, assertions: [{ skipped: true }] }),
    'skipped'
  );
});

// --- secrets never reach durable evidence ----------------------------------

test('the fixture really does contain the injected secret', () => {
  // Guards the test below from silently passing on a secret-free fixture.
  const raw = readFileSync(NM_FIXTURE, 'utf8');
  assert.equal(
    (raw.match(new RegExp(FIXTURE_SECRET, 'g')) || []).length,
    3,
    'fixture must retain the captured secret in all 3 leak sites'
  );
});

test('no secret survives into adapter output or the assembled ledger', () => {
  const a = pwUnits({ secrets: [FIXTURE_SECRET] });
  const b = nmUnits({ secrets: [FIXTURE_SECRET] });
  const { ledger } = buildLedger({
    runId: 'run-1',
    storyId: 'STORY-042',
    generatedAt: '2026-09-21T00:00:00.000Z',
    sourceExecutions: [
      {
        execution_id: 'exec-pw',
        runner: 'playwright',
        started_at: '2026-09-21T00:00:00.000Z',
        process_status: 'completed',
        source_errors: a.sourceErrors,
      },
      {
        execution_id: 'exec-nm',
        runner: 'newman',
        started_at: '2026-09-21T00:00:00.000Z',
        process_status: 'completed',
        source_errors: b.sourceErrors,
      },
    ],
    units: [...a.units, ...b.units],
  });
  const blob = JSON.stringify(ledger);
  assert.equal(blob.includes(FIXTURE_SECRET), false);
  assert.equal(blob.includes('SYNTHETIC-FIXTURE-SECRET'), false);
});

// --- domain links are proven, never invented (B6) --------------------------

test('unmapped units keep null links WITH a reason', () => {
  const { units } = pwUnits();
  const { units: resolved, unmapped } = resolveDomainLinks(units, {});
  assert.equal(unmapped.length, units.length);
  for (const u of resolved) {
    assert.equal(u.domain_links.test_case_id, null);
    assert.ok(u.domain_links.unresolved_reason.length > 0);
  }
});

test('a declared mapping resolves links; an ambiguous one refuses to guess', () => {
  const { units } = pwUnits();
  const { units: resolved, ambiguous } = resolveDomainLinks(units, {
    [units[0].unit_id]: {
      test_case_id: 'TC-001',
      spec_id: 'SPEC-001',
      playwright_test_id: 'PW-001',
    },
    [units[1].unit_id]: [
      { test_case_id: 'TC-002' },
      { test_case_id: 'TC-003' },
    ],
  });

  assert.equal(resolved[0].domain_links.test_case_id, 'TC-001');
  assert.equal(resolved[0].domain_links.unresolved_reason, undefined);

  assert.deepEqual(ambiguous, [units[1].unit_id]);
  assert.equal(resolved[1].domain_links.test_case_id, null);
  assert.match(resolved[1].domain_links.unresolved_reason, /[Aa]mbiguous/);
});

test('ids are not derived from failure ordering', () => {
  const { units } = pwUnits();
  const failing = units.filter((u) => u.outcome === 'failed');
  // Under the old scheme these would be PW-001, PW-002... assigned by the order
  // failures were encountered. Here every link is null until proven.
  for (const u of failing) {
    assert.equal(u.domain_links.playwright_test_id, null);
  }
});

// --- approved-scope coverage -----------------------------------------------

test('an approved case with no linked unit is not_run and invents nothing', () => {
  const { units } = pwUnits();
  const cases = deriveCaseOutcomes(['TC-001', 'TC-404'], units);
  const orphan = cases.find((c) => c.test_case_id === 'TC-404');
  assert.equal(orphan.outcome, 'not_run');
  assert.deepEqual(orphan.linked_unit_ids, []);
  assert.match(orphan.reason, /no executed unit/i);
});

test('a case passes only when every linked unit strictly passed', () => {
  const units = [
    { unit_id: 'a', outcome: 'passed', domain_links: { test_case_id: 'TC-1' } },
    { unit_id: 'b', outcome: 'passed', domain_links: { test_case_id: 'TC-1' } },
    { unit_id: 'c', outcome: 'passed', domain_links: { test_case_id: 'TC-2' } },
    { unit_id: 'd', outcome: 'failed', domain_links: { test_case_id: 'TC-2' } },
    { unit_id: 'e', outcome: 'flaky', domain_links: { test_case_id: 'TC-3' } },
    {
      unit_id: 'f',
      outcome: 'blocked',
      domain_links: { test_case_id: 'TC-4' },
    },
  ];
  const cases = deriveCaseOutcomes(['TC-1', 'TC-2', 'TC-3', 'TC-4'], units);
  const by = Object.fromEntries(cases.map((c) => [c.test_case_id, c.outcome]));
  assert.equal(by['TC-1'], 'passed');
  assert.equal(by['TC-2'], 'failed');
  assert.equal(by['TC-3'], 'failed', 'an unstable case is not covered');
  assert.equal(by['TC-4'], 'blocked');
});

test('a nonempty approved scope with zero executed units has zero coverage', () => {
  const cases = deriveCaseOutcomes(['TC-1', 'TC-2'], []);
  const totals = deriveTotals([], cases, 0);
  // No units: the pass RATE is unknown...
  assert.equal(totals.unit_pass_rate, null);
  // ...but coverage is definitively zero, not unknown.
  assert.equal(totals.approved_case_coverage, 0);
});

test('totals are derived from units and never negative', () => {
  const { units } = nmUnits();
  const totals = deriveTotals(units, [], 0);
  assert.equal(totals.units, units.length);
  const sum =
    totals.passed +
    totals.failed +
    totals.flaky +
    totals.skipped +
    totals.blocked +
    totals.not_run +
    totals.expected_failure;
  assert.equal(sum, units.length);
  for (const [k, v] of Object.entries(totals)) {
    if (typeof v === 'number') assert.ok(v >= 0, `${k} must not be negative`);
  }
});

// --- the assembled ledger satisfies its own contract -----------------------

test('a ledger built from both real reports is schema-valid and invariant-clean', () => {
  const a = pwUnits();
  const b = nmUnits();
  const { ledger } = buildLedger({
    runId: 'run-1',
    storyId: 'STORY-042',
    generatedAt: '2026-09-21T00:00:00.000Z',
    sourceExecutions: [
      {
        execution_id: 'exec-pw',
        runner: 'playwright',
        started_at: '2026-09-21T00:00:00.000Z',
        process_status: 'completed',
        source_errors: a.sourceErrors,
      },
      {
        execution_id: 'exec-nm',
        runner: 'newman',
        started_at: '2026-09-21T00:00:00.000Z',
        process_status: 'completed',
        source_errors: b.sourceErrors,
      },
    ],
    units: [...a.units, ...b.units],
    approvedCaseIds: ['TC-001'],
    mapping: { [a.units[0].unit_id]: { test_case_id: 'TC-001' } },
  });

  const v = validateValue(ledger, LEDGER_SCHEMA);
  assert.equal(v.ok, true, JSON.stringify(v.errors?.slice(0, 3)));
  const inv = ledgerInvariants(ledger);
  assert.equal(inv.ok, true, JSON.stringify(inv.violations));

  assert.equal(ledger.totals.units, 16);
  assert.equal(ledger.totals.approved_case_coverage, 1);
});

test('the legacy projection of a real run stays consistent and nonnegative', () => {
  const a = pwUnits();
  const b = nmUnits();
  const totals = deriveTotals([...a.units, ...b.units], [], 0);
  const legacy = legacySummaryProjection(totals);
  assert.deepEqual(legacy, {
    passed: 3,
    failed: 9, // 5 failed + 2 blocked + 2 flaky
    skipped: 4, // 2 skipped + 0 not_run + 2 expected_failure
    total_tests: 16,
  });
  assert.equal(
    legacy.passed + legacy.failed + legacy.skipped,
    legacy.total_tests
  );
});

test('API-only normalization needs no Playwright report', () => {
  const b = nmUnits();
  const { ledger } = buildLedger({
    runId: 'run-api',
    storyId: 'STORY-042',
    generatedAt: '2026-09-21T00:00:00.000Z',
    sourceExecutions: [
      {
        execution_id: 'exec-nm',
        runner: 'newman',
        started_at: '2026-09-21T00:00:00.000Z',
        process_status: 'completed',
        source_errors: [],
      },
    ],
    units: b.units,
  });
  assert.equal(validateValue(ledger, LEDGER_SCHEMA).ok, true);
  assert.equal(ledgerInvariants(ledger).ok, true);
  assert.equal(ledger.totals.units, 4);
});

test('a unit from an errored execution cannot be passed', () => {
  const b = nmUnits();
  const { ledger } = buildLedger({
    runId: 'run-x',
    storyId: 'STORY-042',
    generatedAt: '2026-09-21T00:00:00.000Z',
    sourceExecutions: [
      {
        execution_id: 'exec-nm',
        runner: 'newman',
        started_at: '2026-09-21T00:00:00.000Z',
        process_status: 'errored',
        source_errors: [
          { message: 'collection failed to load', phase: 'setup' },
        ],
      },
    ],
    units: b.units,
  });
  // The fixture contains one passing request; under an errored execution the
  // ledger's own invariant must reject it as unverified evidence.
  const inv = ledgerInvariants(ledger);
  assert.equal(inv.ok, false);
  assert.match(inv.violations.join('\n'), /did not complete trustworthily/);
});

test('source errors are counted separately from unit outcomes', () => {
  const { ledger } = buildLedger({
    runId: 'run-y',
    storyId: 'STORY-042',
    generatedAt: '2026-09-21T00:00:00.000Z',
    sourceExecutions: [
      {
        execution_id: 'e1',
        runner: 'playwright',
        started_at: '2026-09-21T00:00:00.000Z',
        process_status: 'completed',
        source_errors: [
          { message: 'global setup failed', phase: 'setup' },
          { message: 'teardown warning', phase: 'teardown' },
        ],
      },
    ],
    units: [],
  });
  assert.equal(ledger.totals.source_error_count, 2);
  assert.equal(ledger.totals.units, 0);
  assert.equal(ledger.totals.unit_pass_rate, null);
  assert.equal(ledgerInvariants(ledger).ok, true);
});
