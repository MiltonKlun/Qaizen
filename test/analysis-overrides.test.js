// A finalized failure analysis keeps its rule-based draft and records every
// change it makes to a classification or severity
// (scripts/lib/analysis-overrides.js). The Healer takes eligibility from the
// draft, so a finalized analysis cannot make a failure Green.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  downgradesOf,
  overrideProblems,
  unconfirmed,
} from '../scripts/lib/analysis-overrides.js';
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

test('a repeated failure id cannot hide a changed copy', () => {
  const changed = final();
  changed.failures = [
    { ...draft.failures[0], severity: 'yellow' },
    draft.failures[0],
    draft.failures[1],
  ];
  assert.deepEqual(overrideProblems(draft, changed), [
    'FAIL-001 appears more than once in the analysis',
  ]);
});

test('what the ledger fixes never changes; a test case id is only filled in', () => {
  const ledgerDraft = {
    failures: [
      {
        failure_id: 'FAIL-001',
        classification: 'product_bug',
        severity: 'red',
        unit_id: 'u-red',
        execution_outcome: 'failed',
        source: 'playwright',
        runner_identity: { kind: 'playwright', test_title: 'pays' },
        test_case_id: 'TC-001',
      },
      {
        failure_id: 'FAIL-002',
        classification: 'locator_or_selector',
        severity: 'green',
        unit_id: 'u-green',
        execution_outcome: 'failed',
        source: 'playwright',
        runner_identity: { kind: 'playwright', test_title: 'opens help' },
        test_case_id: null,
      },
    ],
  };
  // The Green failure moved onto the Red failure's unit: the Healer would
  // otherwise be pointed at the test behind the Red one.
  const moved = structuredClone(ledgerDraft);
  moved.failures[1].unit_id = 'u-red';
  moved.failures[1].runner_identity.test_title = 'pays';
  assert.deepEqual(overrideProblems(ledgerDraft, moved), [
    'FAIL-002 unit_id differs from the rule-based draft; the ledger fixes it',
    'FAIL-002 runner_identity differs from the rule-based draft; the ledger fixes it',
  ]);

  const resolved = structuredClone(ledgerDraft);
  resolved.failures[1].test_case_id = 'TC-004'; // unresolved -> resolved: fine
  assert.deepEqual(overrideProblems(ledgerDraft, resolved), []);

  const retargeted = structuredClone(ledgerDraft);
  retargeted.failures[0].test_case_id = 'TC-009';
  assert.deepEqual(overrideProblems(ledgerDraft, retargeted), [
    'FAIL-001 test_case_id changed from TC-001 to TC-009; only an unresolved one may be filled in',
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

// --- which lowered severities a person must confirm -------------------------

const run = {
  context: {
    risks: [
      { risk_id: 'RISK-001', severity: 'high', description: 'login works' },
      {
        risk_id: 'RISK-002',
        severity: 'low',
        description: 'the payment total is wrong',
      },
      { risk_id: 'RISK-003', severity: 'low', description: 'tooltip text' },
    ],
  },
  testCases: {
    test_cases: [
      { test_case_id: 'TC-001', risk_ids: ['RISK-001'] },
      { test_case_id: 'TC-002', risk_ids: ['RISK-002'] },
      { test_case_id: 'TC-003', risk_ids: ['RISK-003'] },
    ],
  },
};
/** @param {[string, string, string | null][]} rows id, severity, case */
const failures = (rows) =>
  rows.map(([id, severity, tc]) => ({
    failure_id: id,
    severity,
    test_case_id: tc,
  }));

test('a lowered Red, or a lowering on a high, Red-domain or untraced risk, needs confirming', () => {
  const draft = {
    failures: failures([
      ['FAIL-001', 'red', 'TC-003'],
      ['FAIL-002', 'yellow', 'TC-001'],
      ['FAIL-003', 'yellow', 'TC-002'],
      ['FAIL-004', 'yellow', 'TC-003'],
      ['FAIL-005', 'yellow', null],
      ['FAIL-006', 'green', 'TC-001'],
      ['FAIL-007', 'yellow', null],
    ]),
  };
  const final = {
    failures: failures([
      ['FAIL-001', 'yellow', 'TC-003'],
      ['FAIL-002', 'green', 'TC-001'],
      ['FAIL-003', 'green', 'TC-002'],
      ['FAIL-004', 'green', 'TC-003'], // low, not a Red domain: no confirmation
      ['FAIL-005', 'green', null],
      ['FAIL-006', 'yellow', 'TC-001'], // raised, not lowered
      // The finalizing step filled in a low, non-Red case: the draft could not
      // trace it, so a person still confirms.
      ['FAIL-007', 'green', 'TC-003'],
    ]),
  };
  assert.deepEqual(downgradesOf({ ...run, draft, final }), [
    {
      failure_id: 'FAIL-001',
      from: 'red',
      to: 'yellow',
      why: 'a Red failure lowered',
    },
    {
      failure_id: 'FAIL-002',
      from: 'yellow',
      to: 'green',
      // "login" is a security keyword (config/red-domains.json).
      why: 'on high-severity RISK-001; on RISK-001, a Red domain (security)',
    },
    {
      failure_id: 'FAIL-003',
      from: 'yellow',
      to: 'green',
      why: 'on RISK-002, a Red domain (business_logic, payment)',
    },
    {
      failure_id: 'FAIL-005',
      from: 'yellow',
      to: 'green',
      why: "not traced to a test case's risk in the rule-based draft",
    },
    {
      failure_id: 'FAIL-007',
      from: 'yellow',
      to: 'green',
      why: "not traced to a test case's risk in the rule-based draft",
    },
  ]);
  // On the full track every lowered severity needs a person, FAIL-004 (low,
  // not a Red domain) included; a raised one still does not.
  const full = downgradesOf({ ...run, draft, final, track: 'full' });
  assert.deepEqual(
    full.map((d) => d.failure_id),
    ['FAIL-001', 'FAIL-002', 'FAIL-003', 'FAIL-004', 'FAIL-005', 'FAIL-007']
  );
  assert.equal(
    full.find((d) => d.failure_id === 'FAIL-004')?.why,
    'on a full-track story'
  );
  assert.deepEqual(
    downgradesOf({ ...run, draft, final, track: 'standard' }),
    downgradesOf({ ...run, draft, final })
  );
});

test('a confirmation counts only for the same change and the same analysis bytes', () => {
  const d = { failure_id: 'FAIL-001', from: 'red', to: 'yellow', why: 'x' };
  const c = {
    failure_id: 'FAIL-001',
    from: 'red',
    to: 'yellow',
    analysis_sha256: 'a'.repeat(64),
  };
  assert.deepEqual(unconfirmed([d], [c], 'a'.repeat(64)), []);
  assert.deepEqual(unconfirmed([d], [c], 'b'.repeat(64)), [d]);
  assert.deepEqual(unconfirmed([d], [{ ...c, to: 'green' }], 'a'.repeat(64)), [
    d,
  ]);
});
