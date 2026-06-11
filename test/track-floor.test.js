// Unit tests for the lite-track floor (IMPROVEMENT-PLAN IP-4.2). Table-driven.
// The load-bearing property: a story touching a Red-taxonomy domain (or a
// high-severity risk, or too large to be "routine") can NEVER be lite — the
// floor raises it to standard with a written reason. A genuinely small, benign
// story stays lite-eligible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  minimumTrack,
  trackAllowed,
  trackRank,
  MAX_LITE_ACS,
  MAX_LITE_RISKS,
} from '../scripts/track-floor.js';

function ctx({ title = 't', description = '', acs = ['AC'], risks = [] } = {}) {
  return {
    story: {
      id: 'STORY-1',
      title,
      source: 'manual',
      path: 'story.md',
      description,
    },
    acceptance_criteria: acs,
    risks: risks.map((r, i) => ({
      risk_id: `RISK-00${i + 1}`,
      description: r.description,
      severity: r.severity || 'low',
      related_acs: [0],
    })),
  };
}

test('benign small story is lite-eligible (floor = lite)', () => {
  const { minimum, reasons } = minimumTrack(
    ctx({
      title: 'Footer copyright year updates automatically',
      acs: ['The footer shows the current year.'],
      risks: [
        { description: 'Stale year looks unmaintained.', severity: 'low' },
      ],
    })
  );
  assert.equal(minimum, 'lite');
  assert.deepEqual(reasons, []);
});

test('red domains each force at least standard', () => {
  const cases = [
    [
      'business logic',
      'Order total calculation with discount',
      'business_logic',
    ],
    ['permission', 'Only an admin role may delete a record', 'permission_role'],
    ['security', 'Login form must sanitize against XSS', 'security'],
    ['pricing', 'Checkout invoice shows the right price', 'pricing'],
    ['payment', 'Process a credit card payment', 'payment'],
    ['compliance', 'Capture user consent for GDPR audit', 'compliance'],
    [
      'data integrity',
      'Ensure the record persists without data loss',
      'data_integrity',
    ],
  ];
  for (const [name, title] of cases) {
    const { minimum, reasons } = minimumTrack(ctx({ title }));
    assert.equal(minimum, 'standard', `${name} must floor to standard`);
    assert.ok(
      reasons.some((r) => r.startsWith('red-domain:')),
      `${name} must cite a red-domain reason; got ${JSON.stringify(reasons)}`
    );
  }
});

test('a red keyword in an AC or risk (not just the title) still floors', () => {
  const fromAc = minimumTrack(
    ctx({
      title: 'Generic feature',
      acs: ['The system applies the correct tax.'],
    })
  );
  assert.equal(fromAc.minimum, 'standard');

  const fromRisk = minimumTrack(
    ctx({
      title: 'Generic feature',
      risks: [
        { description: 'A payment could be double-charged.', severity: 'low' },
      ],
    })
  );
  assert.equal(fromRisk.minimum, 'standard');
});

test('size heuristics: too many ACs or risks leaves lite', () => {
  const manyAcs = minimumTrack(
    ctx({ title: 'Plain UI tweak', acs: Array(MAX_LITE_ACS + 1).fill('an AC') })
  );
  assert.equal(manyAcs.minimum, 'standard');
  assert.ok(manyAcs.reasons.some((r) => /acceptance criteria/.test(r)));

  const manyRisks = minimumTrack(
    ctx({
      title: 'Plain UI tweak',
      acs: ['one'],
      risks: Array(MAX_LITE_RISKS + 1).fill({
        description: 'minor',
        severity: 'low',
      }),
    })
  );
  assert.equal(manyRisks.minimum, 'standard');
  assert.ok(manyRisks.reasons.some((r) => /risks/.test(r)));
});

test('a high-severity risk alone leaves lite', () => {
  const { minimum, reasons } = minimumTrack(
    ctx({
      title: 'Plain UI tweak',
      risks: [{ description: 'A subtle layout issue.', severity: 'high' }],
    })
  );
  assert.equal(minimum, 'standard');
  assert.ok(reasons.some((r) => /high-severity/.test(r)));
});

test('trackAllowed refuses lite below the floor, allows standard/full', () => {
  const redCtx = ctx({ title: 'Process a refund payment' });
  assert.equal(trackAllowed(redCtx, 'lite').allowed, false);
  assert.equal(trackAllowed(redCtx, 'standard').allowed, true);
  assert.equal(trackAllowed(redCtx, 'full').allowed, true);

  const benign = ctx({ title: 'Footer year', acs: ['shows year'] });
  assert.equal(trackAllowed(benign, 'lite').allowed, true);
});

test('trackRank orders lite < standard < full; unknown treated as standard', () => {
  assert.ok(trackRank('lite') < trackRank('standard'));
  assert.ok(trackRank('standard') < trackRank('full'));
  assert.equal(trackRank('weird'), trackRank('standard'));
});
