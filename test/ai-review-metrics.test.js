// The advisory AI review in the metrics: how often it was shown and used,
// how its answered findings fared per gate and type, its catch rate from the
// regression results, and the spend entered for it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  aiReviewLines,
  aiReviewMetrics,
  readReviewerAccuracy,
} from '../scripts/lib/ai-review.js';
import { costLines, costMetrics } from '../scripts/lib/outcome-metrics.js';
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
const shown = (
  /** @type {string} */ c,
  /** @type {number} */ findings,
  /** @type {string | null} */ own = null
) => ({
  review: 'analysis/test-reviews/S-1.test-review.json',
  sha256: sha(c),
  round: c === 'a' ? 1 : 2,
  findings,
  own_concerns: own,
});

const CONTEXTS = [
  {
    // Gate 4: round 1 shown at a rejection with concerns noted first, then
    // shown again at a second rejection on the same inputs (no longer blind:
    // its concerns and findings do not count again); round 2 shown at the
    // approval, with blank concerns.
    ai_reviews: [
      round('code_reviewed', 1, 'a'),
      round('code_reviewed', 2, 'b'),
    ],
    gate_decisions: [
      decision('specs_reviewed', null),
      decision(
        'code_reviewed',
        shown('a', 3, 'The total looks unchecked.'),
        'rejected'
      ),
      decision(
        'code_reviewed',
        shown('a', 3, 'Same as the review says.'),
        'rejected'
      ),
      decision('code_reviewed', shown('b', 1, '   ')),
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
  assert.equal(g4.decisions, 4);
  assert.equal(g4.decisions_shown_a_review, 3);
  assert.equal(g4.first_showings, 2, 'a review shown again is not new');
  assert.equal(
    g4.own_concerns_noted,
    1,
    'concerns after seeing the review, and blank ones, are not counted'
  );
  assert.equal(g4.findings_shown, 4, 'each review counted once');
  assert.equal(g4.runs_with_rounds, 1);
  assert.equal(g4.rounds, 2);
  assert.equal(m.runs_with_rounds, 1);
  assert.deepEqual(g4.wilson_95, [0.3006, 0.9544]);
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
    /Catch rate unknown: no regression results for the test-reviewer in evidence\/regressions\//
  );
  assert.match(unused.at(-1) ?? '', /Cost: none entered/);
  assert.match(
    unused[0],
    /asks for one only when config\/gate-checks.json sets ai_review "on"/
  );

  const used = aiReviewLines(
    aiReviewMetrics(CONTEXTS, DISPOSITIONS),
    {
      'test-reviewer': {
        source: 'evidence/regressions/test-reviewer.json',
        model: 'model-x',
        generated_at: '2026-11-15T12:00:00.000Z',
        current_prompt: false,
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
    { USD: { runs: 1, total: 0.75, per_run: 0.75 } },
    3
  ).join('\n');
  assert.match(
    used,
    /Gate 4 \(test-reviewer\): shown at 3 of 4 decision\(s\), 2 review\(s\) shown for the first time; 2 round\(s\) over 1 run\(s\); own concerns noted before the review at 1 of 2 first showing\(s\); 4 finding\(s\) in the reviews shown\./
  );
  assert.match(
    used,
    /Answered 4: precision 75% \[30%, 95%\] \(fixed 2, wrong 1\); weak_assertion 67% of 3, case_not_tested 100% of 1\./
  );
  assert.match(
    used,
    /seeded defects found 8\/9 = 89% \[56%, 98%\]; false alarms 1\/12 = 8% \[1%, 35%\]/
  );
  assert.match(
    used,
    /2026-11-15T12:00:00.000Z; scored on an earlier prompt, re-run it\)/
  );
  assert.match(used, /Gate 3 \(spec-reviewer\): shown at 0 of 1/);
  assert.match(
    used,
    /Cost: 0.75 USD over 1 run\(s\), 0.75 per run; entered for 1 of the 1 run\(s\) that log a round\./
  );
});

test('the catch rate comes from the results scored on the current prompt, then the newest; invalid files skipped', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-accuracy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readReviewerAccuracy(dir), {});
  const example = JSON.parse(
    readFileSync(
      'examples/expected/test-reviewer.expected-regression-results.json',
      'utf8'
    )
  );
  // The example was scored on the prompt in this checkout.
  const current = {
    ...example,
    generated_at: '2026-11-15T12:00:00.000Z',
  };
  const older = {
    ...example,
    generated_at: '2026-11-20T12:00:00.000Z',
    provenance: {
      ...example.provenance,
      prompts: {
        'test-reviewer': [
          { path: 'agents/test-reviewer.md', sha256: sha('c') },
        ],
      },
    },
  };
  writeFileSync(join(dir, 'spec-reviewer.json'), '{"not":"results"}');
  // Only all.json: the fallback.
  writeFileSync(join(dir, 'all.json'), JSON.stringify(current));
  let a = readReviewerAccuracy(dir);
  assert.deepEqual(Object.keys(a), ['test-reviewer']);
  assert.equal(a['test-reviewer'].source, `${dir}/all.json`);
  assert.equal(a['test-reviewer'].current_prompt, true);
  assert.equal(a['test-reviewer'].seeded.caught, 8);
  assert.equal(a['test-reviewer'].no_alarm.alarmed, 1);
  // A newer reviewer file scored on another prompt does not win over it.
  writeFileSync(join(dir, 'test-reviewer.json'), JSON.stringify(older));
  a = readReviewerAccuracy(dir);
  assert.equal(a['test-reviewer'].source, `${dir}/all.json`);
  // With all.json unreadable, it is shown, marked.
  writeFileSync(join(dir, 'all.json'), 'not json');
  a = readReviewerAccuracy(dir);
  assert.equal(a['test-reviewer'].source, `${dir}/test-reviewer.json`);
  assert.equal(a['test-reviewer'].current_prompt, false);
  // Both on the current prompt: the newer wins.
  writeFileSync(
    join(dir, 'all.json'),
    JSON.stringify({ ...current, generated_at: '2026-11-21T12:00:00.000Z' })
  );
  writeFileSync(join(dir, 'test-reviewer.json'), JSON.stringify(current));
  assert.equal(
    readReviewerAccuracy(dir)['test-reviewer'].source,
    `${dir}/all.json`
  );
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
  assert.equal(c.ai_review_spend_not_counted, 0);
  assert.match(
    costLines(c, 2).join('\n'),
    /3 USD spent \(3 per run over 1\), of which 1.25 USD the AI review \(1.25 per run over 1\)/
  );

  // An entry edited by hand past the intake rules is left out and said so.
  const edited = [
    {
      story_id: 'S-3',
      runs: [
        {
          run_id: 'run-c',
          spend: { amount: 1, currency: 'USD' },
          ai_review_spend: { amount: 2, currency: 'USD' },
        },
        {
          run_id: 'run-d',
          spend: { amount: 1, currency: 'USD' },
          ai_review_spend: { amount: 0.5, currency: 'EUR' },
        },
      ],
    },
  ];
  const bad = costMetrics(edited, new Set(['S-3|run-c', 'S-3|run-d']));
  assert.deepEqual(bad.overall.ai_review_spend, {});
  assert.equal(bad.ai_review_spend_not_counted, 2);
  assert.match(
    costLines(bad, 2).join('\n'),
    /2 AI review spend\(s\) left out: not in the run spend's currency, or above it/
  );
});
