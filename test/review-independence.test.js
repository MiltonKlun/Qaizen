// Independence for full-track approvals at Gates 2 and 4
// (scripts/lib/review-independence.js, docs/review-gates.md "The full track").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
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
import { bindingFor } from '../scripts/lib/approval-binding.js';
import {
  MIN_DELAY_MINUTES,
  drawOutsideReview,
  independenceConfig,
  independenceLine,
  independenceLines,
  independenceMetrics,
  independenceOptions,
  needsIndependence,
  recordBriefShown,
  recordHandoff,
  refusalLines,
  resolveIndependence,
} from '../scripts/lib/review-independence.js';
import { recordGateDecision } from '../scripts/run-pipeline.js';

const DIGEST = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const DEFAULTS = { minDelayMinutes: MIN_DELAY_MINUTES, outsideRate: null };

const options = (context, extra = {}) =>
  independenceOptions({
    context,
    gate: 'test_scope_reviewed',
    reviewer: 'Ada Reviewer',
    digest: DIGEST,
    at: '2026-11-14T12:00:00.000Z',
    config: DEFAULTS,
    ...extra,
  });

// ------------------------------------------------------------ pure parts --

test('only full-track approvals at Gate 2 and Gate 4 need independence', () => {
  for (const g of [
    'test_scope_reviewed',
    'code_reviewed',
    'api_assertions_reviewed',
  ]) {
    assert.equal(needsIndependence('full', g), true, g);
    assert.equal(needsIndependence('standard', g), false, g);
    assert.equal(needsIndependence('lite', g), false, g);
  }
  for (const g of [
    'requirements_reviewed',
    'specs_reviewed',
    'collection_reviewed',
    'external_evidence_reviewed',
  ])
    assert.equal(needsIndependence('full', g), false, g);
});

test('the settings: an hour by default, longer allowed, shorter or a bad rate refused', () => {
  assert.deepEqual(independenceConfig(null), { ok: true, config: DEFAULTS });
  assert.deepEqual(independenceConfig({ scope_coverage: 'warn' }), {
    ok: true,
    config: DEFAULTS,
  });
  assert.deepEqual(
    independenceConfig({
      independence: { min_delay_minutes: 240, outside_review_rate: 0.25 },
    }),
    { ok: true, config: { minDelayMinutes: 240, outsideRate: 0.25 } }
  );
  for (const bad of [
    { min_delay_minutes: 30 },
    { min_delay_minutes: '60' },
    { outside_review_rate: 0 },
    { outside_review_rate: 0.05 },
    { outside_review_rate: 1.5 },
    { outside_review_rate: '0.5' },
  ]) {
    const r = independenceConfig({ independence: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  assert.equal(independenceConfig({ independence: [] }).ok, false);
});

test('a handoff keeps the latest operator, and the first time while the operator stays', () => {
  const ctx = {};
  assert.equal(recordHandoff(ctx, 'test-designer', 'Op', 't1'), true);
  assert.equal(recordHandoff(ctx, 'test-designer', ' op ', 't2'), false);
  assert.deepEqual(ctx.review_independence.handoffs['test-designer'], {
    operator: 'Op',
    at: 't1',
  });
  assert.equal(recordHandoff(ctx, 'test-designer', 'Ada', 't3'), true);
  assert.deepEqual(ctx.review_independence.handoffs['test-designer'], {
    operator: 'Ada',
    at: 't3',
  });
  // A step no independent gate reviews is not noted.
  assert.equal(recordHandoff(ctx, 'planner', 'Op', 't4'), false);
  assert.equal(ctx.review_independence.handoffs.planner, undefined);
});

test('the first showing of a brief counts, and changed inputs start the clock again', () => {
  const ctx = {};
  assert.equal(recordBriefShown(ctx, 'code_reviewed', DIGEST, 't1'), true);
  assert.equal(recordBriefShown(ctx, 'code_reviewed', DIGEST, 't2'), false);
  assert.equal(
    ctx.review_independence.briefs.code_reviewed.first_shown_at,
    't1'
  );
  assert.equal(recordBriefShown(ctx, 'code_reviewed', OTHER, 't3'), true);
  assert.deepEqual(ctx.review_independence.briefs.code_reviewed, {
    input_digest: OTHER,
    first_shown_at: 't3',
  });
  assert.equal(recordBriefShown(ctx, 'specs_reviewed', DIGEST, 't'), false);
});

test('a second reviewer is someone other than the operator the step was handed to', () => {
  const handed = (operator) => ({
    review_independence: {
      handoffs: { 'test-designer': { operator, at: '2026-11-14T09:00:00Z' } },
    },
  });
  const second = resolveIndependence(options(handed('Bo Operator')));
  assert.deepEqual(second, {
    control: 'second_reviewer',
    operator: 'Bo Operator',
    handed_over_at: '2026-11-14T09:00:00Z',
  });
  // The same person, however the name is spaced or cased, is not a second
  // reviewer.
  const same = options(handed('  ada   REVIEWER '));
  assert.equal(resolveIndependence(same), null);
  assert.match(same.why.join('\n'), /handed to .* who is deciding/);
  // Nobody recorded, or nobody deciding, is not one either.
  assert.match(
    options({}).why.join('\n'),
    /who ran test-designer is not recorded/
  );
  assert.equal(
    resolveIndependence(options(handed('Bo')), null).control,
    'second_reviewer'
  );
  assert.equal(
    resolveIndependence(options(handed('Bo'), { reviewer: null })),
    null
  );
});

test('the delay counts from the first showing for the same inputs', () => {
  const shown = (at, digest = DIGEST) => ({
    review_independence: {
      briefs: {
        test_scope_reviewed: { input_digest: digest, first_shown_at: at },
      },
    },
  });
  const met = resolveIndependence(options(shown('2026-11-14T10:59:00.000Z')));
  assert.deepEqual(met, {
    control: 'delay',
    operator: null,
    brief_first_shown_at: '2026-11-14T10:59:00.000Z',
    minutes: 61,
  });
  const early = options(shown('2026-11-14T11:30:00.000Z'));
  assert.equal(resolveIndependence(early), null);
  assert.equal(early.waitUntil, '2026-11-14T12:30:00.000Z');
  assert.match(early.why.join('\n'), /30 minute\(s\) ago, under 60/);
  // Shown for other inputs: the clock did not start for these.
  assert.equal(
    resolveIndependence(options(shown('2026-11-14T08:00:00.000Z', OTHER))),
    null
  );
  // A team that asks for longer gets longer.
  assert.equal(
    resolveIndependence(
      options(shown('2026-11-14T10:59:00.000Z'), {
        config: { minDelayMinutes: 120, outsideRate: null },
      })
    ),
    null
  );
});

test('the outside review applies only when chosen and the team has one', () => {
  const withRate = options(
    {},
    { config: { minDelayMinutes: 60, outsideRate: 0.25 } }
  );
  assert.equal(resolveIndependence(withRate), null);
  assert.deepEqual(resolveIndependence(withRate, { selected: true }), {
    control: 'outside_review',
    operator: null,
    rate: 0.25,
    selected: true,
  });
  assert.equal(resolveIndependence(options({}), { selected: true }), null);
  assert.deepEqual(
    drawOutsideReview(0.25, () => 0.1),
    { selected: true }
  );
  assert.deepEqual(
    drawOutsideReview(0.25, () => 0.25),
    { selected: false }
  );
  assert.match(
    refusalLines(options({}), 60).join('\n'),
    /once the team sets independence\.outside_review_rate/
  );
  assert.match(refusalLines(withRate, 60).join('\n'), /which you declined/);
});

test('each control reads as one line, and the metrics count them', () => {
  assert.match(
    independenceLine({
      control: 'second_reviewer',
      operator: 'Bo',
      handed_over_at: 't',
    }),
    /^second reviewer: the step was handed to Bo/
  );
  assert.match(
    independenceLine({
      control: 'delay',
      operator: null,
      brief_first_shown_at: 't',
      minutes: 75,
    }),
    /^delay: decided 75 minute/
  );
  assert.match(
    independenceLine({
      control: 'outside_review',
      operator: null,
      rate: 0.25,
      selected: false,
    }),
    /not selected this time/
  );
  const m = independenceMetrics([
    {
      gate_decisions: [
        { decision: 'approved', independence: { control: 'delay' } },
        {
          decision: 'approved',
          independence: { control: 'outside_review', selected: true },
        },
        { decision: 'rejected' },
        { decision: 'approved' },
      ],
    },
    {
      gate_decisions: [
        { decision: 'approved', independence: { control: 'second_reviewer' } },
      ],
    },
  ]);
  assert.deepEqual(m, {
    second_reviewer: 1,
    delay: 1,
    outside_review: 1,
    outside_selected: 1,
  });
  assert.match(independenceLines(m).join('\n'), /3 full-track approval/);
  assert.match(
    independenceLines(independenceMetrics([])).join('\n'),
    /No full-track approval/
  );
});

// ------------------------------------------------- through the recorder --

const STORY = 'RI-1';
const RUN = 'run-ri-1';

function fixture(storyText) {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-ri-'));
  const put = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  const ctx = runContext({
    storyId: STORY,
    runId: RUN,
    status: 'in_progress',
    gates: false,
  });
  ctx.acceptance_criteria = [storyText];
  put('story.md', `# ${STORY}\n\n1. ${storyText}\n`);
  put(
    `test-cases/${STORY}.json`,
    JSON.stringify(scopeCases(STORY, RUN), null, 2) + '\n'
  );
  put(`planner-input/${STORY}.planner-brief.md`, 'Explore the page.\n');
  put('context.json', JSON.stringify(ctx, null, 2));
  return { dir, put };
}
const RED = 'The total equals the sum of the prices.';
const PLAIN = 'The page shows a greeting.';

const readCtx = (dir) =>
  JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'));

function decide(dir, extra = {}) {
  const ctx = extra.context ?? readCtx(dir);
  const gate = extra.gate ?? 'test_scope_reviewed';
  return {
    ctx,
    r: recordGateDecision({
      root: dir,
      context: ctx,
      step: extra.step ?? 'gate2',
      gateKey: gate,
      decision: extra.decision ?? 'approved',
      reviewer: 'Ada Reviewer',
      notes: extra.decision === 'rejected' ? 'Add a negative case.' : null,
      openedAt: '2026-11-14T11:59:00.000Z',
      decidedAt: '2026-11-14T12:00:00.000Z',
      bindings: { [gate]: bindingFor(gate, ctx, dir) },
      brief: 'brief',
      outsideReview: extra.outsideReview ?? null,
    }),
  };
}

test('a full-track approval with neither a second reviewer nor a control is refused, and nothing is written', () => {
  const { dir } = fixture(RED);
  try {
    const before = readFileSync(join(dir, 'context.json'), 'utf8');
    const { r } = decide(dir);
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'independence');
    assert.match(
      r.message,
      /needs a second reviewer or a compensating control/
    );
    assert.equal(readFileSync(join(dir, 'context.json'), 'utf8'), before);
    assert.equal(existsSync(join(dir, 'gates')), false);
  } finally {
    removeTempDir(dir);
  }
});

test('a second reviewer is recorded in the decision and in its gate record', () => {
  const { dir } = fixture(RED);
  try {
    const ctx = readCtx(dir);
    recordHandoff(ctx, 'test-designer', 'Bo Operator', '2026-11-14T09:00:00Z');
    const { r } = decide(dir, { context: ctx });
    assert.equal(r.ok, true, r.message);
    const saved = readCtx(dir);
    assert.deepEqual(saved.gate_decisions.at(-1).independence, {
      control: 'second_reviewer',
      operator: 'Bo Operator',
      handed_over_at: '2026-11-14T09:00:00Z',
    });
    assert.match(
      readFileSync(join(dir, r.record), 'utf8'),
      /\| Independence \| second reviewer: the step was handed to Bo Operator/
    );
  } finally {
    removeTempDir(dir);
  }
});

test('the delay is met an hour after the brief for the same inputs was first shown', () => {
  const { dir, put } = fixture(RED);
  try {
    const ctx = readCtx(dir);
    const digest = bindingFor('test_scope_reviewed', ctx, dir).input_digest;
    recordBriefShown(
      ctx,
      'test_scope_reviewed',
      digest,
      '2026-11-14T10:45:00.000Z'
    );
    put('context.json', JSON.stringify(ctx, null, 2));
    const { r } = decide(dir);
    assert.equal(r.ok, true, r.message);
    const ind = readCtx(dir).gate_decisions.at(-1).independence;
    assert.equal(ind.control, 'delay');
    assert.equal(ind.minutes, 75);
    assert.match(
      readFileSync(join(dir, r.record), 'utf8'),
      /\| Independence \| delay: decided 75 minute/
    );
  } finally {
    removeTempDir(dir);
  }
});

test('the delay does not carry over to changed inputs', () => {
  const { dir, put } = fixture(RED);
  try {
    const ctx = readCtx(dir);
    const digest = bindingFor('test_scope_reviewed', ctx, dir).input_digest;
    recordBriefShown(
      ctx,
      'test_scope_reviewed',
      digest,
      '2026-11-14T09:00:00.000Z'
    );
    put('context.json', JSON.stringify(ctx, null, 2));
    // The brief changes after it was shown.
    put(`planner-input/${STORY}.planner-brief.md`, 'Explore checkout.\n');
    const { r } = decide(dir);
    assert.equal(r.ok, false);
    assert.match(r.message, /first shown is not recorded/);
  } finally {
    removeTempDir(dir);
  }
});

test('the sampled outside review applies only when the team sets a rate', () => {
  const { dir, put } = fixture(RED);
  try {
    const refused = decide(dir, { outsideReview: { selected: true } });
    assert.equal(refused.r.ok, false);
    put(
      'config/gate-checks.json',
      JSON.stringify({ independence: { outside_review_rate: 0.25 } })
    );
    const { r } = decide(dir, { outsideReview: { selected: true } });
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(readCtx(dir).gate_decisions.at(-1).independence, {
      control: 'outside_review',
      operator: null,
      rate: 0.25,
      selected: true,
    });
    put(
      'config/gate-checks.json',
      JSON.stringify({ independence: { min_delay_minutes: 5 } })
    );
    const bad = decide(dir, { outsideReview: { selected: true } });
    assert.equal(bad.r.ok, false);
    assert.equal(bad.r.stage, 'context');
    assert.match(bad.r.message, /min_delay_minutes/);
  } finally {
    removeTempDir(dir);
  }
});

test('a rejection, another gate, or another track needs no control', () => {
  const red = fixture(RED);
  const plain = fixture(PLAIN);
  try {
    const rejected = decide(red.dir, { decision: 'rejected' });
    assert.equal(rejected.r.ok, true, rejected.r.message);
    assert.equal(
      readCtx(red.dir).gate_decisions.at(-1).independence,
      undefined
    );
    const gate1 = decide(red.dir, {
      gate: 'requirements_reviewed',
      step: 'gate1',
    });
    assert.equal(gate1.r.ok, true, gate1.r.message);
    const standard = decide(plain.dir);
    assert.equal(standard.r.ok, true, standard.r.message);
    assert.equal(
      readCtx(plain.dir).gate_decisions.at(-1).independence,
      undefined
    );
  } finally {
    removeTempDir(red.dir);
    removeTempDir(plain.dir);
  }
});
