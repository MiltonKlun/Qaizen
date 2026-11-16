// The advisory AI review at Gates 3 and 4 (scripts/lib/ai-review.js,
// docs/review-gates.md "Advisory AI review").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execPath } from 'node:process';

import { removeTempDir } from './helpers/cleanup.js';
import { copyRuntimeConfig } from './helpers/runtime-config.js';
import { runContext, scopeCases } from './helpers/valid-run.js';
import { validateValue } from '../scripts/lib/artifact-io.js';
import { bindingFor, gateDigest } from '../scripts/lib/approval-binding.js';
import {
  AI_REVIEW_GATES,
  MAX_ROUNDS,
  aiFindings,
  aiReviewMode,
  blindFirst,
  printable,
  logRound,
  recordSection,
  reviewInstruction,
  reviewLines,
  reviewNeeded,
  reviewState,
} from '../scripts/lib/ai-review.js';
import { nextStep } from '../scripts/pipeline-state.js';
import {
  GUIDE_STEPS,
  applyGateDecision,
  recordGateDecision,
} from '../scripts/run-pipeline.js';

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
  assert.deepEqual(aiFindings('code_reviewed', s.review), [
    {
      rule: 'ai-test:weak_assertion',
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

test('with the rounds used, any review is past the cap and none is asked for', () => {
  const full = context({ ai_reviews: shown(MAX_ROUNDS) });
  for (const raw of [
    testReview({ input_digest: OTHER }),
    testReview({ schema_version: '2.0' }),
    '{not json',
    testReview({ round: 1 }),
  ]) {
    const s = state(raw, full);
    assert.equal(s.state, 'capped', String(raw).slice(0, 40));
    assert.equal(reviewNeeded('on', s), false);
  }
  // A review already shown is shown again, even with the rounds used.
  const ctx = context();
  const raw = JSON.stringify(testReview());
  logRound(ctx, 'code_reviewed', state(raw, ctx), 't');
  ctx.ai_reviews.push(...shown(2).map((r, i) => ({ ...r, round: i + 2 })));
  assert.equal(state(raw, ctx).usable, true);
});

test('a review with converted line endings is the same review', () => {
  const lf = JSON.stringify(testReview(), null, 2);
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.equal(state(lf).sha256, state(crlf).sha256);
});

test('blind first: the question carries nothing the AI wrote, and AI text is printed safely', () => {
  const s = state(testReview());
  const shownFirst = blindFirst('code_reviewed', s);
  assert.doesNotMatch(
    `${shownFirst.question}\n${shownFirst.prompt}`,
    /wrong total|weak_assertion|TC-002|\$46/
  );
  assert.match(shownFirst.review.join('\n'), /A wrong total passes/);
  assert.equal(printable('a\u001b[2Jb\u0007c\nd'), 'a [2Jb c d');
  const nasty = state(
    testReview({
      findings: [
        {
          type: 'weak_assertion',
          severity: 'info',
          description: 'x\u001b[31mred',
        },
      ],
    })
  );
  const ESC = String.fromCharCode(0x1b);
  assert.equal(
    reviewLines('code_reviewed', nasty).join('\n').includes(ESC),
    false
  );
  assert.equal(
    aiFindings('code_reviewed', nasty.review)[0].note.includes(ESC),
    false
  );
  assert.equal(
    aiFindings('specs_reviewed', s.review)[0].rule,
    'ai-spec:weak_assertion'
  );
});

test('the runner asks for a review before Gate 3, takes one for the printed digest, and records it with the decision', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-ai-review-'));
  t.after(() => removeTempDir(dir));
  const put = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  copyRuntimeConfig(dir);
  const ctx = runContext({
    storyId: 'AR-1',
    runId: 'run-ar-1',
    status: 'in_progress',
    gates: false,
  });
  ctx.acceptance_criteria = ['The page shows a greeting.'];
  put('story.md', '# AR-1\n\n1. The page shows a greeting.\n');
  put(
    'test-cases/AR-1.json',
    JSON.stringify(scopeCases('AR-1', 'run-ar-1'), null, 2)
  );
  put('planner-input/AR-1.planner-brief.md', 'Explore the page.\n');
  put('specs/AR-1.md', '# SPEC-001\n\nTC-001: the greeting is shown.\n');
  put('context.json', JSON.stringify(ctx, null, 2));
  put('config/gate-checks.json', JSON.stringify({ ai_review: 'on' }));
  const readCtx = () =>
    JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'));
  const decide = (step, gateKey, extra = {}) => {
    const c = readCtx();
    const r = recordGateDecision({
      root: dir,
      context: c,
      step,
      gateKey,
      decision: 'approved',
      reviewer: 'Ada',
      notes: null,
      openedAt: '2026-11-15T10:00:00.000Z',
      decidedAt: '2026-11-15T10:01:00.000Z',
      bindings: { [gateKey]: bindingFor(gateKey, c, dir) },
      brief: 'brief',
      ...extra,
    });
    assert.equal(r.ok, true, r.message);
    return r;
  };
  decide('gate1', 'requirements_reviewed');
  decide('gate2', 'test_scope_reviewed');
  const run = () =>
    spawnSync(
      execPath,
      [join(process.cwd(), 'scripts', 'run-pipeline.js'), '--resume'],
      {
        cwd: dir,
        encoding: 'utf8',
        input: '',
      }
    );
  const asked = run();
  assert.match(
    asked.stdout,
    /Next step: AI-REVIEW-SPEC/,
    asked.stdout + asked.stderr
  );
  const digest = /input_digest: ([a-f0-9]{64})/.exec(asked.stdout)?.[1];
  assert.equal(digest, gateDigest('specs_reviewed', readCtx(), dir));
  assert.match(asked.stdout, /round: 1/);
  const review = JSON.parse(
    readFileSync(
      'examples/expected/spec-review-bound.expected-spec-review.json',
      'utf8'
    )
  );
  put(
    'analysis/spec-reviews/AR-1.spec-review.json',
    JSON.stringify(
      { ...review, story_id: 'AR-1', input_digest: digest },
      null,
      2
    )
  );
  const gate = run();
  assert.match(
    gate.stderr,
    /GATE PENDING: specs_reviewed/,
    gate.stdout + gate.stderr
  );

  // The decision as the gate records it, with the review it was shown.
  const r = decide('gate3', 'specs_reviewed', {
    aiReview: {
      review: 'analysis/spec-reviews/AR-1.spec-review.json',
      sha256: 'd'.repeat(64),
      round: 1,
      findings: 4,
      own_concerns: 'The empty-name case.',
      lines: ['AI review of the spec (round 1 of 3).'],
    },
  });
  const saved = readCtx();
  assert.equal(validateValue(saved, 'schemas/context.schema.json').ok, true);
  assert.equal(
    saved.gate_decisions.at(-1).ai_review.own_concerns,
    'The empty-name case.'
  );
  assert.match(
    readFileSync(join(dir, r.record), 'utf8'),
    /## Advisory AI review[\s\S]*> The empty-name case\./
  );
});
