// The advisory AI review in the metrics: how often it was shown and used,
// how its answered findings fared per gate and type, its catch rate from the
// committed regression results, and the spend entered for it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  aiReviewLines,
  aiReviewMetrics,
  readReviewerAccuracy,
} from '../scripts/lib/ai-review.js';
import { costMetrics } from '../scripts/lib/outcome-metrics.js';
import { withCostEntry } from '../scripts/lib/outcomes.js';

const sha = (/** @type {string} */ c) => c.repeat(64);
const round = (
  /** @type {string} */ gate,
  /** @type {number} */ n,
  /** @type {string} */ c
) => ({
  gate,
  round: n,
  review: 'analysis/test-reviews/S-1.test-review.json',
  sha256: sha(c),
  input_digest: sha('f'),
  shown_at: '2026-11-01T10:00:00.000Z',
});
const decision = (
  /** @type {string} */ gate,
  /** @type {any} */ aiReview,
  decisionValue = 'approved'
) => ({
  gate,
  decision: decisionValue,
  decided_at: '2026-11-01T10:30:00.000Z',
  ...(aiReview ? { ai_review: aiReview } : {}),
});
const shown = (/** @type {number} */ findings, own = null) => ({
  review: 'analysis/test-reviews/S-1.test-review.json',
  sha256: sha('a'),
  round: 1,
  findings,
  own_concerns: own,
});

const CONTEXTS = [
  {
    // Gate 4: two rounds (one logged twice), a rejection then an approval,
    // both shown a review; own concerns noted once.
    ai_reviews: [
      round('code_reviewed', 1, 'a'),
      round('code_reviewed', 1, 'a'),
      round('code_reviewed', 2, 'b'),
    ],
    gate_decisions: [
      decision('specs_reviewed', null),
      decision(
        'code_reviewed',
        shown(3, 'The total looks unchecked.'),
        'rejected'
      ),
      decision('code_reviewed', shown(1, '   ')),
    ],
  },
  // An older run: no AI review at all.
  { gate_decisions: [decision('code_reviewed', null)] },
  {},
];
const DISPOSITIONS = {
  by_rule: {
    'ai-test:weak_assertion': { total: 3, wrong: 1, fixed: 1 },
    'ai-test:case_not_tested': { total: 1, wrong: 0, fixed: 1 },
    'ai-spec:weak_expected_outcome': { total: 2, wrong: 2, fixed: 0 },
    'hard-wait': { total: 5, wrong: 5, fixed: 0 },
  },
};

test('use, rounds and answers are counted per gate; scan checks stay out', () => {
  const m = aiReviewMetrics(CONTEXTS, DISPOSITIONS);
  const g4 = m.gates.code_reviewed;
  assert.equal(g4.reviewer, 'test-reviewer');
  assert.equal(g4.decisions, 3);
  assert.equal(g4.decisions_shown_a_review, 2);
  assert.equal(g4.own_concerns_noted, 1, 'blank concerns are none');
  assert.equal(g4.findings_shown, 4);
  assert.equal(g4.runs_with_rounds, 1);
  assert.equal(g4.rounds, 2, 'a round logged twice is one round');
  assert.equal(g4.answered, 4);
  assert.equal(g4.wrong, 1);
  assert.equal(g4.fixed, 2);
  assert.equal(g4.precision, 0.75);
  assert.deepEqual(Object.keys(g4.by_type).sort(), [
    'case_not_tested',
    'weak_assertion',
  ]);
  const g3 = m.gates.specs_reviewed;
  assert.equal(g3.decisions, 1);
  assert.equal(g3.decisions_shown_a_review, 0);
  assert.equal(g3.rounds, 0);
  assert.equal(g3.answered, 2);
  assert.equal(g3.precision, 0);
  // Nothing at all: zeros and unknown precision, never a crash.
  const none = aiReviewMetrics([], { by_rule: {} });
  assert.equal(none.gates.code_reviewed.precision, null);
});

test('the lines say when the review was never used, and what is unknown', () => {
  const unused = aiReviewLines(
    aiReviewMetrics([{}], { by_rule: {} }),
    {},
    {},
    4
  );
  assert.match(unused[0], /No run logs an AI review round \(0\/4 run\(s\)\)/);
  assert.ok(unused.includes('- Gate 3 (spec-reviewer):'));
  assert.match(
    unused.join('\n'),
    /Catch rate unknown: no committed regression results for the test-reviewer/
  );
  assert.match(unused.at(-1) ?? '', /Cost: none entered/);

  const used = aiReviewLines(
    aiReviewMetrics(CONTEXTS, DISPOSITIONS),
    {
      'test-reviewer': {
        source: 'evidence/regressions/test-reviewer.json',
        model: 'model-x',
        generated_at: '2026-11-15T12:00:00.000Z',
        seeded: {
          checks: 9,
          caught: 8,
          value: 0.8889,
          wilson_95: [0.565, 0.9801],
        },
        no_alarm: {
          checks: 12,
          alarmed: 1,
          value: 0.0833,
          wilson_95: [0.0149, 0.3539],
        },
      },
    },
    { USD: { runs: 2, total: 1.5, per_run: 0.75 } },
    3
  ).join('\n');
  assert.match(
    used,
    /Gate 4 \(test-reviewer\): shown at 2 of 3 decision\(s\); 2 round\(s\) over 1 run\(s\); own concerns noted first at 1 of 2; 4 finding\(s\) shown\./
  );
  assert.match(
    used,
    /Answered 4: precision 75% \(fixed 2, wrong 1\); weak_assertion 67% of 3, case_not_tested 100% of 1\./
  );
  assert.match(
    used,
    /seeded defects found 8\/9 = 89% \[56%, 98%\]; false alarms 1\/12 = 8% \[1%, 35%\]/
  );
  assert.match(used, /Gate 3 \(spec-reviewer\): shown at 0 of 1/);
  assert.match(used, /Cost: 1.5 USD over 2 run\(s\), 0.75 per run/);
});

test('the catch rate comes from the committed results: the reviewer file first, invalid files skipped', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-accuracy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readReviewerAccuracy(dir), {});
  copyFileSync(
    'examples/expected/test-reviewer.expected-regression-results.json',
    join(dir, 'test-reviewer.json')
  );
  writeFileSync(join(dir, 'spec-reviewer.json'), '{"not":"results"}');
  writeFileSync(join(dir, 'all.json'), 'not json');
  const a = readReviewerAccuracy(dir);
  assert.deepEqual(Object.keys(a), ['test-reviewer']);
  assert.equal(a['test-reviewer'].source, `${dir}/test-reviewer.json`);
  assert.equal(a['test-reviewer'].seeded.caught, 8);
  assert.equal(a['test-reviewer'].no_alarm.alarmed, 1);
});

test('the AI review spend is part of the run spend: one currency, at most the spend, tallied apart', () => {
  const entry = (/** @type {any} */ ai) => ({
    run_id: 'run-a',
    run_archive: 'runs/S-1/a',
    spend: { amount: 3, currency: 'USD' },
    ai_review_spend: ai,
    recorded_at: '2026-11-01T10:00:00.000Z',
    recorded_by: 'QA lead',
  });
  const eur = withCostEntry(
    null,
    'S-1',
    entry({ amount: 1, currency: 'EUR' }),
    false
  );
  assert.equal(eur.ok, false);
  assert.match(
    /** @type {any} */ (eur).errors[0],
    /enter both in one currency/
  );
  const over = withCostEntry(
    null,
    'S-1',
    entry({ amount: 3.5, currency: 'USD' }),
    false
  );
  assert.match(/** @type {any} */ (over).errors[0], /cannot exceed it/);
  const ok = withCostEntry(
    null,
    'S-1',
    entry({ amount: 1.25, currency: 'USD' }),
    false
  );
  assert.equal(ok.ok, true);

  const docs = [
    /** @type {any} */ (ok).doc,
    {
      story_id: 'S-2',
      runs: [{ run_id: 'run-b', spend: { amount: 2, currency: 'USD' } }],
    },
  ];
  const c = costMetrics(docs, new Set(['S-1|run-a', 'S-2|run-b']));
  assert.deepEqual(c.overall.spend.USD, { runs: 2, total: 5, per_run: 2.5 });
  assert.deepEqual(c.overall.ai_review_spend.USD, {
    runs: 1,
    total: 1.25,
    per_run: 1.25,
  });
  assert.deepEqual(c.by_story['S-2'].ai_review_spend, {});
});
