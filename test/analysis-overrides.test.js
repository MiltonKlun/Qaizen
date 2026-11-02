// A finalized failure analysis keeps its rule-based draft and records every
// change it makes to a classification or severity
// (scripts/lib/analysis-overrides.js). The Healer takes eligibility from the
// draft, so a finalized analysis cannot make a failure Green.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { overrideProblems } from '../scripts/lib/analysis-overrides.js';
import { resolveTarget } from '../scripts/lib/healer-candidate.js';

const draft = {
  failures: [
    { failure_id: 'FAIL-001', classification: 'product_bug', severity: 'red' },
    {
      failure_id: 'FAIL-002',
      classification: 'locator_or_selector',
      severity: 'green',
    },
  ],
};
/** @param {any} [over] */
const final = (over = {}) => ({
  failures: structuredClone(draft.failures),
  overrides: [],
  ...over,
});

test('an unchanged analysis has nothing to record', () => {
  assert.deepEqual(overrideProblems(draft, final()), []);
});

test('each changed field needs exactly one override that matches it', () => {
  const changed = final();
  changed.failures[0].severity = 'yellow';
  changed.failures[0].classification = 'test_bug';
  assert.deepEqual(overrideProblems(draft, changed), [
    'FAIL-001 classification changed from product_bug to test_bug with no override recording it',
    'FAIL-001 severity changed from red to yellow with no override recording it',
  ]);

  const recorded = structuredClone(changed);
  recorded.overrides = [
    {
      failure_id: 'FAIL-001',
      field: 'severity',
      from: 'red',
      to: 'yellow',
      reason: 'the test asserts the old price',
    },
    {
      failure_id: 'FAIL-001',
      field: 'classification',
      from: 'product_bug',
      to: 'test_bug',
      reason: 'the test asserts the old price',
    },
  ];
  assert.deepEqual(overrideProblems(draft, recorded), []);

  // An override whose from/to do not match the change does not count.
  const wrong = structuredClone(recorded);
  wrong.overrides[0].from = 'green';
  assert.deepEqual(overrideProblems(draft, wrong), [
    'FAIL-001 severity changed from red to yellow with no override recording it',
  ]);
});

test('overrides for changes that did not happen, or twice, are refused', () => {
  const o = {
    failure_id: 'FAIL-002',
    field: 'severity',
    from: 'green',
    to: 'yellow',
    reason: 'x',
  };
  assert.deepEqual(overrideProblems(draft, final({ overrides: [o] })), [
    'FAIL-002 severity override records a change the analysis does not make',
  ]);
  const changed = final({ overrides: [o, o] });
  changed.failures[1].severity = 'yellow';
  assert.deepEqual(overrideProblems(draft, changed), [
    'FAIL-002 severity is overridden more than once',
  ]);
});

test('failures are neither added nor removed while finalizing', () => {
  const changed = final();
  changed.failures = [
    draft.failures[0],
    { failure_id: 'FAIL-009', classification: 'test_bug', severity: 'yellow' },
  ];
  assert.deepEqual(overrideProblems(draft, changed), [
    'FAIL-009 not in the rule-based draft',
    'FAIL-002 from the draft is missing',
  ]);
});

test('the Healer reads eligibility from the draft, never from an upgraded final', () => {
  const analysis = final();
  analysis.failures[0].severity = 'green';
  analysis.failures[0].source = 'playwright';
  analysis.failures[0].unit_id = 'u1';
  const target = resolveTarget({
    context: /** @type {any} */ ({}),
    analysis,
    draft,
    ledger: { units: [] },
    failureId: 'FAIL-001',
  });
  assert.equal(target.ok, false);
  assert.match(
    target.ok ? '' : target.reason,
    /FAIL-001 is red in the rule-based draft; a finalized analysis cannot make a failure Green/
  );
});
