// Unit tests for the lite-track floor. Table-driven.
// The load-bearing property: a story touching a Red-taxonomy domain (or a
// high-severity risk, or too large to be "routine") can NEVER be lite — the
// floor raises it to standard with a written reason. A genuinely small, benign
// story stays lite-eligible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  effectiveTrack,
  liteByDefault,
  minimumTrack,
  trackAllowed,
  trackRank,
  MAX_LITE_ACS,
  MAX_LITE_RISKS,
} from '../scripts/track-floor.js';
import { redDomainLabel } from '../scripts/red-domains.js';

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

test('red domains each floor a story to full', () => {
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
    assert.equal(minimum, 'full', `${name} must floor to full`);
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
  assert.equal(fromAc.minimum, 'full');

  const fromRisk = minimumTrack(
    ctx({
      title: 'Generic feature',
      risks: [
        { description: 'A payment could be double-charged.', severity: 'low' },
      ],
    })
  );
  assert.equal(fromRisk.minimum, 'full');
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

test('trackAllowed allows only a track at or above the floor', () => {
  const redCtx = ctx({ title: 'Process a refund payment' });
  assert.equal(trackAllowed(redCtx, 'lite').allowed, false);
  assert.equal(trackAllowed(redCtx, 'standard').allowed, false);
  assert.equal(trackAllowed(redCtx, 'full').allowed, true);
  const bigCtx = ctx({ title: 'Footer', acs: ['a', 'b', 'c', 'd', 'e'] });
  assert.equal(trackAllowed(bigCtx, 'lite').allowed, false);
  assert.equal(trackAllowed(bigCtx, 'standard').allowed, true);

  const benign = ctx({ title: 'Footer year', acs: ['shows year'] });
  assert.equal(trackAllowed(benign, 'lite').allowed, true);
});

test('trackRank orders lite < standard < full; unknown treated as standard', () => {
  assert.ok(trackRank('lite') < trackRank('standard'));
  assert.ok(trackRank('standard') < trackRank('full'));
  assert.equal(trackRank('weird'), trackRank('standard'));
});

test('identifiers, inflections and Spanish keep a story off lite (config/red-domains.json)', () => {
  for (const [title, domain] of [
    ['Pagar con tarjeta guardada', 'payment'],
    ['El subtotal se actualiza al quitar un producto', 'business_logic'],
    ['The submitPayment button is shown on mobile', 'payment'],
    ['Users can log in with a magic link', 'security'],
    ['Apply a promo code at the basket', 'pricing'],
    ['Iniciar sesión con correo', 'security'],
  ]) {
    const { minimum, reasons } = minimumTrack(ctx({ title }));
    assert.notEqual(minimum, 'lite', title);
    assert.ok(
      reasons.some((r) => r.includes(redDomainLabel(domain))),
      `${title}: ${reasons.join('; ')}`
    );
  }
});

test('ordinary Spanish and English stay lite-eligible', () => {
  for (const title of [
    'La página de inicio muestra las cifras de ventas',
    'Sort products by name',
    'Points of interest appear on the map',
  ]) {
    assert.equal(minimumTrack(ctx({ title })).minimum, 'lite', title);
  }
});

test('the story file floors the story on its own: "pagar", "subtotal", submitPayment', () => {
  const benign = ctx({ title: 'Footer year', acs: ['shows year'] });
  assert.equal(minimumTrack(benign).minimum, 'lite');
  for (const story of [
    '# S\n\nEl cliente puede pagar con tarjeta.\n',
    '# S\n\nThe cart shows the subtotal.\n',
    '# S\n\nThe button calls `submitPayment`.\n',
  ]) {
    const { minimum, reasons } = minimumTrack(benign, story);
    assert.equal(minimum, 'full', story);
    assert.ok(
      reasons.some((r) => /^red-domain: .+ \(in the story\)$/.test(r)),
      JSON.stringify(reasons)
    );
  }
});

test('an Analyst omission no longer lowers the floor', () => {
  // The Analyst wrote a benign context and recorded a lite floor; the story
  // says otherwise.
  const context = {
    ...ctx({ title: 'Footer year', acs: ['shows year'] }),
    track: 'lite',
    track_floor: { minimum: 'lite', reasons: [] },
  };
  const story = '# S\n\nOnly an admin may refund an order.\n';
  assert.equal(trackAllowed(context, 'lite', story).allowed, false);
  const t = effectiveTrack(context, story);
  assert.equal(t.declared, 'lite');
  assert.equal(t.minimum, 'full');
  assert.equal(t.track, 'full');
  // Both sources are named when both mention a domain.
  const both = minimumTrack(
    ctx({ title: 'Refund a payment' }),
    '# S\n\nRefund a payment.\n'
  );
  assert.ok(
    both.reasons.some((r) =>
      r.endsWith("(in the story and the Analyst's context)")
    ),
    JSON.stringify(both.reasons)
  );
});

test('the effective track is the highest of declared, computed and recorded', () => {
  const benign = ctx({ title: 'Footer year', acs: ['shows year'] });
  // No track declared: lite, the lowest track the floor allows.
  assert.equal(effectiveTrack(benign, '').track, 'lite');
  assert.equal(effectiveTrack(benign, '').defaulted, true);
  // Without the story's text there is no default.
  assert.equal(effectiveTrack(benign).track, 'standard');
  assert.equal(
    effectiveTrack({ ...benign, track: 'standard' }).track,
    'standard'
  );
  assert.equal(effectiveTrack({ ...benign, track: 'lite' }).track, 'lite');
  assert.equal(effectiveTrack({ ...benign, track: 'full' }).track, 'full');
  assert.equal(
    effectiveTrack({
      ...benign,
      track: 'standard',
      track_floor: { minimum: 'full', reasons: [] },
    }).track,
    'full'
  );
  assert.equal(effectiveTrack({ ...benign, track: 'bogus' }).track, 'standard');
});

test('a run with no declared track starts on lite only when its floor allows it and Gate 1 was not decided on its own', () => {
  const benign = ctx({ title: 'Footer year', acs: ['shows year'] });
  // The story's text, empty unless a case gives one.
  const lbd = (/** @type {any} */ c, story = '') => liteByDefault(c, story);
  assert.equal(lbd(benign, ''), true);
  assert.equal(liteByDefault(null), false);
  // A declared track is kept, an unknown one included.
  for (const track of ['lite', 'standard', 'full', 'bogus'])
    assert.equal(lbd({ ...benign, track }, ''), false, track);
  // The floor holds it higher: a Red domain in the story file or the
  // context, its size, a high-severity risk, or a floor the Analyst recorded.
  assert.equal(lbd(benign, 'Users pay by card.'), false);
  assert.equal(
    lbd(ctx({ acs: ['The total equals the sum of the prices.'] }), ''),
    false
  );
  assert.equal(lbd(ctx({ acs: ['a', 'b', 'c', 'd', 'e'] }), ''), false);
  assert.equal(
    lbd(
      ctx({
        risks: [{ risk_id: 'RISK-001', description: 'x', severity: 'high' }],
      })
    ),
    false
  );
  assert.equal(
    lbd({
      ...benign,
      track_floor: { minimum: 'standard', reasons: [] },
    }),
    false
  );
  assert.equal(
    lbd({ ...benign, track_floor: { minimum: 'lite', reasons: [] } }),
    true
  );
  // An older run that took the standard path keeps it: Gate 1 decided on
  // its own, approved or rejected, logged or only in review_gates.
  assert.equal(
    lbd({
      ...benign,
      gate_decisions: [
        {
          gate: 'requirements_reviewed',
          decision: 'rejected',
          decided_at: 't',
        },
      ],
    }),
    false
  );
  assert.equal(
    lbd({ ...benign, review_gates: { requirements_reviewed: true } }),
    false
  );
  assert.equal(
    lbd({
      ...benign,
      review_gates: {
        requirements_reviewed: { status: false, reviewed_at: 't' },
      },
    }),
    false
  );
  // The lite gate approves Gate 1 with it: that run stays on lite.
  assert.equal(
    lbd({
      ...benign,
      gate_decisions: [
        { gate: 'qa_scope_approved', decision: 'approved', decided_at: 't' },
      ],
      review_gates: {
        qa_scope_approved: { status: true },
        requirements_reviewed: { status: true, reviewed_at: 't' },
      },
    }),
    true
  );
  assert.equal(
    lbd({
      ...benign,
      review_gates: { requirements_reviewed: false },
    }),
    true
  );
});

test('the lite-default example is held to lite by default', () => {
  const c = JSON.parse(
    readFileSync('examples/expected/lite-default.expected-context.json', 'utf8')
  );
  assert.equal(c.track, undefined);
  assert.deepEqual(
    {
      track: effectiveTrack(c, '').track,
      defaulted: effectiveTrack(c, '').defaulted,
    },
    { track: 'lite', defaulted: true }
  );
});

test('without the story text there is no default, and a reopen keeps a lite run on lite', () => {
  const benign = ctx({ title: 'Footer year', acs: ['shows year'] });
  assert.equal(liteByDefault(benign, null), false);
  assert.equal(liteByDefault(benign), false);
  // --reopen gate2 after the lite gate: Gate 2 and qa_scope_approved are
  // reset, Gate 1 keeps its consolidated approval. The log shows the run
  // took the lite path, so it stays there (back to the lite gate).
  const reopened = {
    ...benign,
    gate_decisions: [
      { gate: 'qa_scope_approved', decision: 'approved', decided_at: 't' },
    ],
    review_gates: {
      qa_scope_approved: { status: false, reviewer: null, reviewed_at: null },
      requirements_reviewed: {
        status: true,
        reviewed_at: 't',
        notes: 'Consolidated via qa_scope_approved (lite track).',
      },
      test_scope_reviewed: { status: false, reviewed_at: null },
    },
  };
  assert.equal(liteByDefault(reopened, ''), true);
  assert.equal(effectiveTrack(reopened, '').track, 'lite');
});
