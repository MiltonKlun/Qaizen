// The advisory AI review at Gates 3 and 4 (scripts/lib/ai-review.js,
// docs/review-gates.md "Advisory AI review").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { validateValue } from '../scripts/lib/artifact-io.js';
import {
  AI_REVIEW_GATES,
  MAX_ROUNDS,
  aiFindings,
  aiReviewMode,
  logRound,
  recordSection,
  reviewInstruction,
  reviewLines,
  reviewNeeded,
  reviewState,
} from '../scripts/lib/ai-review.js';
import { nextStep } from '../scripts/pipeline-state.js';
import { GUIDE_STEPS, applyGateDecision } from '../scripts/run-pipeline.js';

const DIGEST = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const context = (extra = {}) => ({ story: { id: 'BENCH-1' }, ...extra });

const testReview = (extra = {}) => ({
  schema_version: '1.0',
  story_id: 'BENCH-1',
  reviewed_at: '2026-11-15T10:00:00Z',
  input_digest: DIGEST,
  round: 1,
  findings: [
    {
      type: 'weak_assertion',
      tc_id: 'TC-002',
      line: 41,
      quote: 'await expect(sum).toBeVisible();',
      severity: 'blocker',
      description: 'A wrong total passes.',
    },
  ],
  recommendations: ['Assert the sum is $46.75.'],
  ...extra,
});
const state = (raw, ctx = context()) =>
  reviewState({
    context: ctx,
    gate: 'code_reviewed',
    digest: DIGEST,
    raw:
      raw === null ? null : typeof raw === 'string' ? raw : JSON.stringify(raw),
  });
const shown = (n, gate = 'code_reviewed') =>
  Array.from({ length: n }, (_, i) => ({
    gate,
    round: i + 1,
    review: 'analysis/test-reviews/BENCH-1.test-review.json',
    sha256: String(i).repeat(64).slice(0, 64),
    input_digest: DIGEST,
    shown_at: 't',
  }));

test('the team turns the review step on or off, and nothing else', () => {
  assert.deepEqual(aiReviewMode(null), { ok: true, mode: 'off' });
  assert.deepEqual(aiReviewMode({ ai_review: 'on' }), { ok: true, mode: 'on' });
  assert.equal(aiReviewMode({ ai_review: true }).ok, false);
  assert.equal(aiReviewMode({ ai_review: 'required' }).ok, false);
});

test('a review is used only for the current inputs, a valid file of this story, and the next round', () => {
  const s = state(testReview());
  assert.equal(s.usable, true);
  assert.equal(s.round, 1);
  assert.equal(s.logged, false);
  for (const [raw, want, ctx] of [
    [null, 'missing'],
    ['{not json', 'invalid'],
    [testReview({ input_digest: OTHER }), 'stale'],
    [testReview({ story_id: 'BENCH-2' }), 'invalid'],
    [testReview({ approved: true }), 'invalid'],
    [testReview({ round: 2 }), 'wrong_round'],
    [testReview({ schema_version: '2.0' }), 'legacy'],
    [
      testReview({ round: 3 }),
      'wrong_round',
      context({ ai_reviews: shown(1) }),
    ],
  ]) {
    const got = state(raw, ctx ?? context());
    assert.equal(got.usable, false, JSON.stringify(raw)?.slice(0, 60));
    assert.equal(got.state, want, JSON.stringify(raw)?.slice(0, 60));
  }
  // A 1.x spec review predates binding and is never used.
  const legacy = reviewState({
    context: context(),
    gate: 'specs_reviewed',
    digest: DIGEST,
    raw: JSON.stringify({ schema_version: '1.0', story_id: 'BENCH-1' }),
  });
  assert.equal(legacy.state, 'legacy');
});

test('rounds: one already shown is used again, and there is no fourth', () => {
  const raw = JSON.stringify(testReview());
  const first = state(raw);
  const ctx = context();
  assert.equal(logRound(ctx, 'code_reviewed', first, 't1'), true);
  assert.equal(ctx.ai_reviews.length, 1);
  const again = state(raw, ctx);
  assert.equal(again.usable, true);
  assert.equal(again.logged, true);
  assert.equal(logRound(ctx, 'code_reviewed', again, 't2'), false);

  const full = context({ ai_reviews: shown(MAX_ROUNDS) });
  const fourth = state(testReview({ round: 3 }), full);
  assert.equal(fourth.state, 'capped');
  assert.equal(state(null, full).state, 'capped');
  // Rounds of the other gate do not count here.
  assert.equal(
    state(testReview(), context({ ai_reviews: shown(3, 'specs_reviewed') }))
      .usable,
    true
  );
});

test('the runner stops for a review only when the team asks, none is usable and rounds are left', () => {
  assert.equal(reviewNeeded('off', state(null)), false);
  assert.equal(reviewNeeded('on', state(null)), true);
  assert.equal(
    reviewNeeded('on', state(testReview({ input_digest: OTHER }))),
    true
  );
  assert.equal(reviewNeeded('on', state(testReview())), false);
  assert.equal(
    reviewNeeded('on', state(null, context({ ai_reviews: shown(3) }))),
    false
  );
});

test('the steps come before Gates 3 and 4, after the repeat and fault checks', () => {
  const ctx = (gates, paths) => ({
    review_gates: {
      requirements_reviewed: true,
      test_scope_reviewed: true,
      ...gates,
    },
    artifact_paths: {
      test_cases: 'tc.json',
      playwright_spec: 'spec.md',
      ...paths,
    },
  });
  assert.equal(nextStep(ctx({}), { aiReviewSpec: false }), 'ai-review-spec');
  assert.equal(nextStep(ctx({}), { aiReviewSpec: true }), 'gate3');
  assert.equal(nextStep(ctx({}), {}), 'gate3');
  const g3 = ctx({ specs_reviewed: true }, { generated_test: 't.spec.ts' });
  assert.equal(
    nextStep(g3, { repeatCurrent: false, aiReviewTest: false }),
    'repeat'
  );
  assert.equal(
    nextStep(g3, { faultCurrent: false, aiReviewTest: false }),
    'faults'
  );
  assert.equal(nextStep(g3, { aiReviewTest: false }), 'ai-review-test');
  assert.equal(nextStep(g3, { aiReviewTest: true }), 'gate4');
});

test('findings are answered like scan findings, and shown with no verdict', () => {
  const s = /** @type {any} */ (state(testReview()));
  assert.deepEqual(aiFindings(s.review), [
    {
      rule: 'ai:weak_assertion',
      line: 41,
      test: 'TC-002',
      excerpt: 'await expect(sum).toBeVisible();',
      note: '[blocker] A wrong total passes.',
    },
  ]);
  const lines = reviewLines('code_reviewed', s).join('\n');
  assert.match(lines, /round 1 of 3/);
  assert.match(lines, /1\. \[blocker\] weak_assertion TC-002 line 41/);
  const empty = /** @type {any} */ (state(testReview({ findings: [] })));
  const none = reviewLines('code_reviewed', empty).join('\n');
  assert.match(
    none,
    /reported no findings\. That does not mean the generated test is right/
  );
  assert.doesNotMatch(
    none,
    /\b(pass(ed)?|clean|approve[ds]?|looks good|LGTM)\b/i
  );
  const section = recordSection({
    round: 1,
    review: s.path,
    sha256: s.sha256,
    own_concerns: 'The discount path.',
    lines: ['x'],
  }).join('\n');
  assert.match(section, /## Advisory AI review/);
  assert.match(section, /> The discount path\./);
});

test('the step instruction prints the digest and round, and asks for the change only after round 1', () => {
  const one = reviewInstruction('specs_reviewed', context(), {
    digest: DIGEST,
    round: 1,
    previous: null,
  });
  assert.match(one, new RegExp(`input_digest: ${DIGEST}`));
  assert.match(one, /round: 1/);
  assert.match(one, /agents\/spec-reviewer\.md/);
  assert.match(one, /analysis\/spec-reviews\/BENCH-1\.spec-review\.json/);
  const two = reviewInstruction('code_reviewed', context(), {
    digest: DIGEST,
    round: 2,
    previous: 'gates/004-gate4-rejected',
  });
  assert.match(two, /review only what changed since round 1/);
  assert.match(two, /gates\/004-gate4-rejected\//);
  // The runner's own step, with its launch line (no MCP servers).
  const text = GUIDE_STEPS['ai-review-test']({
    story: { id: 'BENCH-1' },
    artifact_paths: {},
    review_gates: {},
  });
  assert.match(text, /input_digest: [a-f0-9]{64}/);
  assert.match(text, /agents\/test-reviewer\.md/);
  assert.match(text, /config\/mcp\/none\.json/);
});

test('no review has a field that could approve, and a decision is the same with one or without', () => {
  for (const gate of Object.keys(AI_REVIEW_GATES)) {
    const schema = JSON.parse(
      readFileSync(AI_REVIEW_GATES[gate].schema, 'utf8')
    );
    const fields = Object.keys(schema.properties);
    const approving = fields.filter((f) =>
      /approv|eligible|verdict|pass|accept|decision/i.test(f)
    );
    // The 1.x spec review's hint is the one exception, refused in 2.x.
    assert.deepEqual(
      approving,
      gate === 'specs_reviewed' ? ['auto_approval_eligible'] : [],
      gate
    );
  }
  const v2 = JSON.parse(
    readFileSync(
      'examples/expected/spec-review-bound.expected-spec-review.json',
      'utf8'
    )
  );
  assert.equal(validateValue(v2, 'schemas/spec-review.schema.json').ok, true);
  for (const hint of [true, false])
    assert.equal(
      validateValue(
        { ...v2, auto_approval_eligible: hint },
        'schemas/spec-review.schema.json'
      ).ok,
      false
    );

  const decide = (aiReview) => {
    const c = { review_gates: {}, status: 'in_progress' };
    applyGateDecision(c, 'code_reviewed', {
      decision: 'approved',
      reviewer: 'Ada',
      notes: null,
      openedAt: 't0',
      decidedAt: 't1',
      bindings: { code_reviewed: { input_digest: DIGEST } },
      aiReview,
    });
    return c;
  };
  const without = decide(null);
  const withReview = decide({
    review: 'analysis/test-reviews/BENCH-1.test-review.json',
    sha256: OTHER,
    round: 1,
    findings: 1,
    own_concerns: null,
  });
  assert.deepEqual(withReview.review_gates, without.review_gates);
  assert.equal(withReview.gate_decisions[0].ai_review.round, 1);
  assert.equal(without.gate_decisions[0].ai_review, undefined);
});
