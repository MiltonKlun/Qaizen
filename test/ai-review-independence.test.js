// The advisory AI review as the independence control at Gate 4
// (scripts/lib/review-independence.js, docs/review-gates.md "Independence at
// Gates 2 and 4").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { removeTempDir } from './helpers/cleanup.js';
import { runContext, scopeCases } from './helpers/valid-run.js';
import { bindingFor, gateDigest } from '../scripts/lib/approval-binding.js';
import { measuredAccuracy } from '../scripts/lib/ai-review.js';
import { stepOutputs, stepProvenance } from '../scripts/lib/provenance.js';
import {
  MAX_AI_FALSE_ALARM,
  MIN_AI_CATCH,
  MIN_DELAY_MINUTES,
  aiAccuracy,
  independenceLine,
  independenceLines,
  independenceMetrics,
  independenceOptions,
  refusalLines,
  resolveIndependence,
} from '../scripts/lib/review-independence.js';
import { wilson } from '../scripts/lib/stats.js';
import { recordGateDecision } from '../scripts/run-pipeline.js';

const DIGEST = 'a'.repeat(64);
const SHA = 'e'.repeat(64);
const DEFAULTS = { minDelayMinutes: MIN_DELAY_MINUTES, outsideRate: null };
const SHOWN = {
  path: 'analysis/test-reviews/S-1.test-review.json',
  sha256: SHA,
  round: 1,
};
const PRODUCED = { model: 'model-x', prompts_current: true };

/** Measured accuracy as measuredAccuracy() returns it. */
const measured = (
  /** @type {Record<string, any>} */ extra = {},
  caught = 9,
  alarmed = 1
) => ({
  agent: 'test-reviewer',
  results: 'evidence/regressions/test-reviewer.json',
  model: 'model-x',
  generated_at: '2026-11-16T10:00:00.000Z',
  current_prompt: true,
  committed: true,
  seeded: { checks: 9, caught, wilson_95: wilson(caught, 9) },
  no_alarm: { checks: 12, alarmed, wilson_95: wilson(alarmed, 12) },
  ...extra,
});

const input = (/** @type {Record<string, any>} */ extra = {}) => ({
  shown: SHOWN,
  measured: measured(),
  produced: PRODUCED,
  ...extra,
});

const options = (/** @type {Record<string, any>} */ extra = {}) =>
  independenceOptions({
    context: {},
    gate: 'code_reviewed',
    reviewer: 'Ada',
    digest: DIGEST,
    authored: DIGEST,
    at: '2026-11-17T12:00:00.000Z',
    config: DEFAULTS,
    aiReview: input(),
    ...extra,
  });

const reason = (/** @type {{ ok: boolean, reason?: string }} */ r) =>
  r.ok ? '' : String(r.reason);

// ------------------------------------------------------------ pure parts --

test('the bar: with three trials, every seeded check caught and at most one false alarm in twelve', () => {
  assert.equal(MIN_AI_CATCH, 0.7);
  assert.equal(MAX_AI_FALSE_ALARM, 0.4);
  assert.equal(aiAccuracy(input()).ok, true);
  assert.equal(aiAccuracy(input({ measured: measured({}, 9, 0) })).ok, true);
  assert.match(
    reason(aiAccuracy(input({ measured: measured({}, 8) }))),
    /catch rate at 8 of 9 seeded checks, lower bound 0.565, under 0.7/
  );
  assert.match(
    reason(aiAccuracy(input({ measured: measured({}, 9, 2) }))),
    /false alarms at 2 of 12 checks, upper bound 0.448, over 0.4/
  );
});

test('the results count only when scored on the current prompt, committed as they are, and possible', () => {
  assert.match(
    reason(aiAccuracy(input({ measured: null }))),
    /no regression results/
  );
  assert.match(
    reason(
      aiAccuracy(input({ measured: measured({ current_prompt: false }) }))
    ),
    /earlier prompt/
  );
  assert.match(
    reason(aiAccuracy(input({ measured: measured({ committed: false }) }))),
    /not committed as they are/
  );
  // The intervals are recounted from the counts, never taken as written.
  assert.match(
    reason(
      aiAccuracy(
        input({
          measured: measured({
            seeded: { checks: 0, caught: 0, wilson_95: null },
          }),
        })
      )
    ),
    /lower bound none/
  );
  // Counts edited past their checks make no interval, and pass nothing.
  for (const m of [
    measured({ seeded: { checks: 1, caught: 2, wilson_95: wilson(2, 1) } }),
    measured({
      no_alarm: { checks: 1, alarmed: 5, wilson_95: wilson(5, 1) },
    }),
  ])
    assert.match(
      reason(aiAccuracy(input({ measured: m }))),
      /more catches or alarms than checks/
    );
});

test('the review counts only when recorded as written with the measured prompt by the measured model', () => {
  assert.match(
    reason(aiAccuracy(input({ produced: null }))),
    /recorded nothing about what wrote the review/
  );
  assert.match(
    reason(
      aiAccuracy(
        input({ produced: { model: 'model-x', prompts_current: false } })
      )
    ),
    /another test-reviewer prompt than the one measured/
  );
  assert.match(
    reason(
      aiAccuracy(
        input({ produced: { model: 'unknown', prompts_current: true } })
      )
    ),
    /no model was declared \(QAIZEN_MODEL\)/
  );
  assert.match(
    reason(
      aiAccuracy(
        input({ produced: { model: 'model-y', prompts_current: true } })
      )
    ),
    /written by model-y, and the results measured model-x/
  );
});

test('a measured review shown before the decision is a control at Gate 4 only', () => {
  const o = options();
  assert.equal(o.aiGate, true);
  assert.deepEqual(o.ai, {
    control: 'ai_review',
    operator: null,
    review: SHOWN,
    accuracy: {
      results: 'evidence/regressions/test-reviewer.json',
      model: 'model-x',
      generated_at: '2026-11-16T10:00:00.000Z',
      seeded: { checks: 9, caught: 9, wilson_95: [0.7009, 1] },
      no_alarm: { checks: 12, alarmed: 1, wilson_95: [0.0149, 0.3539] },
    },
  });
  assert.equal(resolveIndependence(o)?.control, 'ai_review');

  // Not usable: no control, and the brief says why.
  const unseen = options({
    aiReview: input({ shown: null, unusable: 'the review is round 2' }),
  });
  assert.equal(unseen.ai, null);
  assert.match(unseen.why.join('\n'), /the review is round 2/);
  // Below the bar: why says so, and the refusal names the way to it.
  const weak = options({ aiReview: input({ measured: measured({}, 8) }) });
  assert.equal(resolveIndependence(weak), null);
  assert.match(weak.why.join('\n'), /under 0.7/);
  assert.match(
    refusalLines(weak, 60).join('\n'),
    /after an advisory AI review of these inputs, once the test-reviewer's committed regression results/
  );

  // Gate 2 and the API branch's Gate 4 have no AI review.
  for (const gate of ['test_scope_reviewed', 'api_assertions_reviewed']) {
    const other = options({ gate });
    assert.equal(other.aiGate, false, gate);
    assert.equal(other.ai, null, gate);
    assert.doesNotMatch(refusalLines(other, 60).join('\n'), /AI review/);
  }
  const without = options({ aiReview: null });
  assert.equal(without.aiGate, false);
  assert.doesNotMatch(without.why.join('\n'), /AI review/);
});

test('a second reviewer and the delay come before the AI review, the outside review after it', () => {
  const second = options({
    context: {
      review_independence: {
        operators: {
          code_reviewed: { operator: 'Bo', authored_digest: DIGEST, at: 't' },
        },
      },
    },
  });
  assert.equal(resolveIndependence(second)?.control, 'second_reviewer');
  assert.equal(
    resolveIndependence(second, { notOperator: false })?.control,
    'ai_review'
  );
  const late = options({
    context: {
      review_independence: {
        briefs: {
          code_reviewed: {
            input_digest: DIGEST,
            first_shown_at: '2026-11-17T10:00:00.000Z',
          },
        },
      },
    },
  });
  assert.equal(resolveIndependence(late)?.control, 'delay');
  const sampled = options({
    config: { ...DEFAULTS, outsideRate: 0.5 },
  });
  assert.equal(
    resolveIndependence(sampled, { outside: true, rng: () => 0 })?.control,
    'ai_review'
  );
});

test('the AI review control reads as one line, and the metrics count it', () => {
  const o = options();
  assert.equal(
    independenceLine(/** @type {any} */ (o.ai)),
    'advisory AI review: analysis/test-reviews/S-1.test-review.json (round 1) shown before the decision, its findings answered; measured in evidence/regressions/test-reviewer.json (model-x, 2026-11-16T10:00:00.000Z): caught 9 of 9 seeded checks [0.7009, 1], false alarms 1 of 12 [0.0149, 0.3539]'
  );
  const m = independenceMetrics([
    {
      gate_decisions: [
        { decision: 'approved', independence: { control: 'ai_review' } },
        { decision: 'approved', independence: { control: 'delay' } },
      ],
    },
  ]);
  assert.equal(m.ai_review, 1);
  assert.match(
    independenceLines(m).join('\n'),
    /2 full-track approval\(s\) at Gate 2 or Gate 4: 0 by a second reviewer, 1 after the delay, 1 after a measured AI review, 0 on the sampled outside review/
  );
});

// ------------------------------------------------- through the recorder --

const STORY = 'AI-1';
const RUN = 'run-ai-1';
const REVIEW = `analysis/test-reviews/${STORY}.test-review.json`;
const RESULTS = 'evidence/regressions/test-reviewer.json';
const FINDING = {
  type: 'weak_assertion',
  tc_id: 'TC-001',
  line: 3,
  quote: "test('total [TC-001]', async () => {});",
  severity: 'blocker',
  description: 'The test asserts nothing about the total.',
};

const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) =>
  spawnSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, encoding: 'utf8' }
  );

/**
 * A full-track run at Gate 4 in a git repository, with the Test Reviewer's
 * prompt and its regression results (`caught` of 9, 1 alarm in 12)
 * committed, unless `results` is false. With `review`, a review of the
 * gate's inputs is written, shown (logged as its round) and recorded as
 * written by `model`.
 */
function workspace({
  caught = 9,
  results = true,
  review = /** @type {Record<string, any> | null} */ ({}),
  model = 'model-x',
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-ai-control-'));
  const put = (/** @type {string} */ rel, /** @type {string} */ text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  const ctx = runContext({
    storyId: STORY,
    runId: RUN,
    status: 'in_progress',
    gates: false,
  });
  const red = 'The total equals the sum of the prices.';
  ctx.acceptance_criteria = [red];
  put('story.md', `# ${STORY}\n\n1. ${red}\n`);
  put(
    `test-cases/${STORY}.json`,
    JSON.stringify(scopeCases(STORY, RUN), null, 2)
  );
  put(`planner-input/${STORY}.planner-brief.md`, 'Explore the basket.\n');
  put(`specs/${STORY}.md`, '# SPEC-001\n\nTC-001: the total is the sum.\n');
  put(
    `tests/${STORY}.spec.ts`,
    "import { test } from '@playwright/test';\n// SPEC-001 TC-001\ntest('total [TC-001]', async () => {});\n"
  );
  // The example results were scored on the prompt in this checkout.
  cpSync('agents/test-reviewer.md', join(dir, 'agents/test-reviewer.md'));
  if (results) {
    const doc = JSON.parse(
      readFileSync(
        'examples/expected/test-reviewer.expected-regression-results.json',
        'utf8'
      )
    );
    doc.reviewer_accuracy['test-reviewer'].seeded.caught = caught;
    put(RESULTS, JSON.stringify(doc, null, 2) + '\n');
  }
  put('context.json', JSON.stringify(ctx, null, 2));
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'run']);
  /** @type {any} */
  let shown = null;
  if (review) {
    const doc = {
      schema_version: '1.0',
      story_id: STORY,
      reviewed_at: '2026-11-17T10:00:00Z',
      input_digest: gateDigest('code_reviewed', ctx, dir),
      round: 1,
      findings: [],
      recommendations: [],
      ...review,
    };
    const raw = JSON.stringify(doc, null, 2);
    put(REVIEW, raw);
    const sha256 = createHash('sha256').update(raw).digest('hex');
    // Earlier rounds of other reviews, then this one, as the gate logs it.
    ctx.ai_reviews = [
      ...Array.from({ length: doc.round - 1 }, (_, i) => ({
        gate: 'code_reviewed',
        round: i + 1,
        review: REVIEW,
        sha256: String(i).repeat(64),
        input_digest: doc.input_digest,
        shown_at: '2026-11-17T09:00:00Z',
      })),
      {
        gate: 'code_reviewed',
        round: doc.round,
        review: REVIEW,
        sha256,
        input_digest: doc.input_digest,
        shown_at: '2026-11-17T11:59:30Z',
      },
    ];
    ctx.provenance = {
      'ai-review-test': stepProvenance('ai-review-test', {
        root: dir,
        output: { path: REVIEW, sha256 },
        env: { QAIZEN_MODEL: model },
        now: '2026-11-17T11:59:00Z',
      }),
    };
    put('context.json', JSON.stringify(ctx, null, 2));
    shown = {
      review: REVIEW,
      sha256,
      round: doc.round,
      findings: doc.findings.length,
      own_concerns: null,
      lines: [],
    };
  }
  return { dir, put, shown };
}

const readCtx = (/** @type {string} */ dir) =>
  JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'));

/** The answer to the one finding of a review with FINDING. */
const answer = (disposition = 'wrong') => [
  {
    rule: 'ai-test:weak_assertion',
    line: 3,
    test: 'TC-001',
    excerpt: FINDING.quote,
    note: `[blocker] ${FINDING.description}`,
    disposition,
    reason: 'TC-001 asserts the total in the next step.',
  },
];

function decide(
  /** @type {string} */ dir,
  /** @type {any} */ aiReview,
  /** @type {{ decision?: string, dispositions?: any[] }} */ extra = {}
) {
  const ctx = readCtx(dir);
  const decision = extra.decision ?? 'approved';
  return recordGateDecision({
    root: dir,
    repoRoot: dir,
    context: ctx,
    step: 'gate4',
    gateKey: 'code_reviewed',
    decision: /** @type {'approved' | 'rejected'} */ (decision),
    reviewer: 'Ada Reviewer',
    notes: decision === 'rejected' ? 'Assert the total.' : null,
    openedAt: '2026-11-17T11:59:00.000Z',
    decidedAt: '2026-11-17T12:00:00.000Z',
    bindings: { code_reviewed: bindingFor('code_reviewed', ctx, dir) },
    brief: 'brief',
    dispositions: extra.dispositions ?? [],
    aiReview,
  });
}

const message = (/** @type {{ ok: boolean, message?: string }} */ r) =>
  r.ok ? '' : String(r.message);

test('measured accuracy is read from the committed results, recounted', (t) => {
  const { dir, put } = workspace({ review: null });
  t.after(() => removeTempDir(dir));
  const m = measuredAccuracy('code_reviewed', dir);
  assert.equal(m?.results, RESULTS);
  assert.equal(m?.current_prompt, true);
  assert.equal(m?.committed, true);
  assert.deepEqual(m?.seeded, { checks: 9, caught: 9, wilson_95: [0.7009, 1] });
  assert.equal(measuredAccuracy('test_scope_reviewed', dir), null);
  put(RESULTS, readFileSync(join(dir, RESULTS), 'utf8') + '\n');
  assert.equal(measuredAccuracy('code_reviewed', dir)?.committed, false);
});

test('a solo full-track approval at Gate 4 rests on a measured AI review it was shown and answered, and the record names it', (t) => {
  const { dir, shown } = workspace({ review: { findings: [FINDING] } });
  t.after(() => removeTempDir(dir));
  const r = decide(dir, shown, { dispositions: answer() });
  assert.equal(r.ok, true, message(r));
  if (!r.ok) return;
  const ind = readCtx(dir).gate_decisions.at(-1).independence;
  assert.equal(ind.control, 'ai_review');
  assert.deepEqual(ind.review, {
    path: REVIEW,
    sha256: shown.sha256,
    round: 1,
  });
  assert.equal(ind.accuracy.results, RESULTS);
  assert.equal(ind.accuracy.model, 'model-x');
  assert.match(
    readFileSync(join(dir, r.record), 'utf8'),
    /\| Independence \| advisory AI review: analysis\/test-reviews\/AI-1.test-review.json \(round 1\)/
  );
});

test('a review not shown, changed since, unanswered, of a later round or by another model is no control', (t) => {
  const { dir, put, shown } = workspace({ review: { findings: [FINDING] } });
  t.after(() => removeTempDir(dir));
  const before = readFileSync(join(dir, 'context.json'), 'utf8');
  assert.match(
    message(decide(dir, null, { dispositions: answer() })),
    /the AI review of these inputs was not shown before this decision/
  );
  assert.match(
    message(decide(dir, shown)),
    /the findings of the AI review shown are not all answered/
  );
  // Not logged as shown.
  const unlogged = readCtx(dir);
  unlogged.ai_reviews = [];
  put('context.json', JSON.stringify(unlogged, null, 2));
  assert.match(
    message(decide(dir, shown, { dispositions: answer() })),
    /not logged as shown/
  );
  put('context.json', before);
  // The review file changed after it was shown: what was shown is gone.
  put(REVIEW, readFileSync(join(dir, REVIEW), 'utf8') + '\n\n');
  assert.match(
    message(decide(dir, shown, { dispositions: answer() })),
    /no usable AI review of these inputs: .*round/
  );
  assert.equal(readFileSync(join(dir, 'context.json'), 'utf8'), before);
  assert.equal(existsSync(join(dir, 'gates')), false);
  // A rejection needs no control.
  assert.equal(decide(dir, null, { decision: 'rejected' }).ok, true);

  const later = workspace({ review: { round: 2 } });
  t.after(() => removeTempDir(later.dir));
  assert.match(
    message(decide(later.dir, later.shown)),
    /round 2, which reviews only a change; only round 1 is measured/
  );
  const other = workspace({ model: 'model-y' });
  t.after(() => removeTempDir(other.dir));
  assert.match(
    message(decide(other.dir, other.shown)),
    /written by model-y, and the results measured model-x/
  );
  const weak = workspace({ caught: 8 });
  t.after(() => removeTempDir(weak.dir));
  assert.match(
    message(decide(weak.dir, weak.shown)),
    /lower bound 0.565, under 0.7/
  );
});

test('with neither a review nor measured results, the refusal says nothing about an AI review', (t) => {
  const { dir } = workspace({ results: false, review: null });
  t.after(() => removeTempDir(dir));
  const r = decide(dir, null);
  assert.equal(r.ok, false);
  assert.match(message(r), /needs a second reviewer or a compensating control/);
  assert.doesNotMatch(message(r), /AI review/);
});

test('provenance names a review by the same digest the gate shows it by', (t) => {
  const { dir, put, shown } = workspace();
  t.after(() => removeTempDir(dir));
  const ctx = readCtx(dir);
  const out = stepOutputs(ctx, dir, { aiReviewTest: REVIEW });
  assert.deepEqual(out['ai-review-test'], {
    path: REVIEW,
    sha256: shown.sha256,
  });
  assert.equal(out['ai-review-spec'], null);
  // Converted line endings are the same review.
  put(REVIEW, readFileSync(join(dir, REVIEW), 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(
    stepOutputs(ctx, dir, { aiReviewTest: REVIEW })['ai-review-test']?.sha256,
    shown.sha256
  );
});
