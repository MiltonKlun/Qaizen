// Independence for full-track approvals at Gates 2 and 4
// (scripts/lib/review-independence.js, docs/review-gates.md "Independence
// at Gates 2 and 4").

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
import { bindingFor, gateDigest } from '../scripts/lib/approval-binding.js';
import {
  MIN_DELAY_MINUTES,
  authoredDigest,
  independenceConfig,
  independenceLine,
  independenceLines,
  independenceMetrics,
  independenceOptions,
  needsIndependence,
  recordBriefShown,
  recordOperator,
  refusalLines,
  resolveIndependence,
} from '../scripts/lib/review-independence.js';
import { recordGateDecision } from '../scripts/run-pipeline.js';

const DIGEST = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const AUTHORED = 'c'.repeat(64);
const DEFAULTS = { minDelayMinutes: MIN_DELAY_MINUTES, outsideRate: null };

const options = (context, extra = {}) =>
  independenceOptions({
    context,
    gate: 'test_scope_reviewed',
    reviewer: 'Ada Reviewer',
    digest: DIGEST,
    authored: AUTHORED,
    at: '2026-11-14T12:00:00.000Z',
    config: DEFAULTS,
    ...extra,
  });

const noted = (operator, authored = AUTHORED) => ({
  review_independence: {
    operators: {
      test_scope_reviewed: {
        operator,
        authored_digest: authored,
        at: '2026-11-14T09:00:00Z',
      },
    },
  },
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

test('the operator is the first session on these inputs; changed inputs get the next one', () => {
  const ctx = {};
  assert.equal(recordOperator(ctx, 'code_reviewed', DIGEST, 'Bo', 't1'), true);
  assert.equal(
    recordOperator(ctx, 'code_reviewed', DIGEST, 'Ada', 't2'),
    false
  );
  assert.deepEqual(ctx.review_independence.operators.code_reviewed, {
    operator: 'Bo',
    authored_digest: DIGEST,
    at: 't1',
  });
  assert.equal(recordOperator(ctx, 'code_reviewed', OTHER, 'Ada', 't3'), true);
  assert.equal(ctx.review_independence.operators.code_reviewed.operator, 'Ada');
  assert.equal(recordOperator(ctx, 'specs_reviewed', DIGEST, 'Bo', 't'), false);
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

test('a second reviewer is someone other than the operator noted for the same inputs', () => {
  assert.deepEqual(resolveIndependence(options(noted('Bo Operator'))), {
    control: 'second_reviewer',
    operator: 'Bo Operator',
    noted_at: '2026-11-14T09:00:00Z',
  });
  // The same person, however the name is spaced, cased or composed.
  for (const same of ['  ada   REVIEWER ', 'Ada Reviewer'.normalize('NFD')]) {
    const o = options(noted(same));
    assert.equal(resolveIndependence(o), null, same);
    assert.match(
      o.why.join('\n'),
      /the operator noted for these inputs, is deciding/
    );
  }
  // Noted for other inputs (an edit since): no operator for these.
  const moved = options(noted('Bo', OTHER));
  assert.equal(resolveIndependence(moved), null);
  assert.match(moved.why.join('\n'), /no operator is noted for these inputs/);
  // No reviewer name, or a reviewer who says they are the operator.
  assert.equal(
    resolveIndependence(options(noted('Bo'), { reviewer: null })),
    null
  );
  assert.equal(
    resolveIndependence(options(noted('Bo')), { notOperator: false }),
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
  assert.deepEqual(
    resolveIndependence(options(shown('2026-11-14T10:59:00.000Z'))),
    {
      control: 'delay',
      operator: null,
      brief_first_shown_at: '2026-11-14T10:59:00.000Z',
      minutes: 61,
    }
  );
  const early = options(shown('2026-11-14T11:30:00.000Z'));
  assert.equal(resolveIndependence(early), null);
  assert.equal(early.waitUntil, '2026-11-14T12:30:00.000Z');
  assert.match(early.why.join('\n'), /30 minute\(s\) ago, under 60/);
  assert.equal(
    resolveIndependence(options(shown('2026-11-14T08:00:00.000Z', OTHER))),
    null
  );
  assert.equal(
    resolveIndependence(
      options(shown('2026-11-14T10:59:00.000Z'), {
        config: { minDelayMinutes: 120, outsideRate: null },
      })
    ),
    null
  );
});

test('the outside review: chosen, with a rate, drawn once per gate and inputs', () => {
  const cfg = { config: { minDelayMinutes: 60, outsideRate: 0.25 } };
  const withRate = options({}, cfg);
  assert.equal(resolveIndependence(withRate), null);
  assert.deepEqual(
    resolveIndependence(withRate, {
      outside: true,
      digest: DIGEST,
      rng: () => 0.1,
    }),
    {
      control: 'outside_review',
      operator: null,
      rate: 0.25,
      selected: true,
      input_digest: DIGEST,
    }
  );
  assert.equal(
    resolveIndependence(withRate, { outside: true, rng: () => 0.25 }).selected,
    false
  );
  // No rate, no outside review.
  assert.equal(resolveIndependence(options({}), { outside: true }), null);
  // A draw made before for these inputs stands, whatever the dice say now.
  const drawnBefore = options(
    {
      gate_decisions: [
        {
          gate: 'test_scope_reviewed',
          decision: 'approved',
          independence: {
            control: 'outside_review',
            operator: null,
            rate: 0.25,
            selected: true,
            input_digest: DIGEST,
          },
        },
      ],
    },
    cfg
  );
  assert.equal(drawnBefore.earlierDraw, true);
  assert.equal(
    resolveIndependence(drawnBefore, {
      outside: true,
      digest: DIGEST,
      rng: () => 0.99,
    }).selected,
    true
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
      noted_at: 't',
    }),
    /^second reviewer: Bo is the operator of these inputs/
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
  for (const [selected, text] of [
    [true, /marked for outside review/],
    [false, /not drawn this time/],
  ])
    assert.match(
      independenceLine({
        control: 'outside_review',
        operator: null,
        rate: 0.25,
        selected,
        input_digest: DIGEST,
      }),
      text
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
const GATE2 = 'test_scope_reviewed';

const readCtx = (dir) =>
  JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'));
const save = (dir, ctx) =>
  writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));

function decide(dir, extra = {}) {
  const ctx = extra.context ?? readCtx(dir);
  const gate = extra.gate ?? GATE2;
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
      decidedAt: extra.decidedAt ?? '2026-11-14T12:00:00.000Z',
      bindings: { [gate]: bindingFor(gate, ctx, dir) },
      brief: 'brief',
      outsideReview: extra.outsideReview ?? false,
      notOperator: extra.notOperator ?? true,
      rng: extra.rng,
    }),
  };
}

/** Note Bo as the operator of what Gate 2 reviews now. */
function boOpened(dir) {
  const ctx = readCtx(dir);
  recordOperator(
    ctx,
    GATE2,
    authoredDigest(GATE2, ctx, dir),
    'Bo Operator',
    '2026-11-14T09:00:00Z'
  );
  save(dir, ctx);
  return ctx;
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
    boOpened(dir);
    const { r } = decide(dir);
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(readCtx(dir).gate_decisions.at(-1).independence, {
      control: 'second_reviewer',
      operator: 'Bo Operator',
      noted_at: '2026-11-14T09:00:00Z',
    });
    assert.match(
      readFileSync(join(dir, r.record), 'utf8'),
      /\| Independence \| second reviewer: Bo Operator is the operator of these inputs/
    );
  } finally {
    removeTempDir(dir);
  }
});

test('a reviewer who says they are the operator is no second reviewer', () => {
  const { dir } = fixture(RED);
  try {
    boOpened(dir);
    const { r } = decide(dir, { notOperator: false });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'independence');
  } finally {
    removeTempDir(dir);
  }
});

test('deciding the cases is not authoring them; editing them is', () => {
  const { dir, put } = fixture(RED);
  try {
    const ctx = boOpened(dir);
    const path = `test-cases/${STORY}.json`;
    const doc = JSON.parse(readFileSync(join(dir, path), 'utf8'));
    // The reviewer decides each case: Bo is still the operator.
    for (const c of doc.test_cases) c.status = 'rejected';
    put(path, JSON.stringify(doc, null, 2));
    assert.equal(
      authoredDigest(GATE2, ctx, dir),
      ctx.review_independence.operators[GATE2].authored_digest
    );
    // The reviewer edits a case after a rejection: Bo is not the operator of
    // that, so it is no second review.
    doc.test_cases[0].title = 'An edited title';
    put(path, JSON.stringify(doc, null, 2));
    const { r } = decide(dir);
    assert.equal(r.ok, false);
    assert.match(r.message, /no operator is noted for these inputs/);
  } finally {
    removeTempDir(dir);
  }
});

test('notes on independence leave every gate digest as it was', () => {
  const { dir } = fixture(RED);
  try {
    const ctx = readCtx(dir);
    const gates = [
      'requirements_reviewed',
      GATE2,
      'specs_reviewed',
      'code_reviewed',
    ];
    const before = gates.map((g) => gateDigest(g, ctx, dir));
    recordOperator(ctx, GATE2, AUTHORED, 'Bo', 't');
    recordBriefShown(ctx, 'code_reviewed', DIGEST, 't');
    assert.deepEqual(
      gates.map((g) => gateDigest(g, ctx, dir)),
      before
    );
  } finally {
    removeTempDir(dir);
  }
});

test('the delay is met an hour after the brief for the same inputs was first shown, and not by a future time', () => {
  const { dir } = fixture(RED);
  try {
    const ctx = readCtx(dir);
    const digest = bindingFor(GATE2, ctx, dir).input_digest;
    recordBriefShown(ctx, GATE2, digest, '2026-11-14T10:45:00.000Z');
    save(dir, ctx);
    // A decision dated a week ahead is held to now.
    const ahead = new Date(Date.now() + 7 * 864e5).toISOString();
    const recent = readCtx(dir);
    recordBriefShown(
      recent,
      GATE2,
      'f'.repeat(64),
      new Date(Date.now() - 60000).toISOString()
    );
    recordBriefShown(
      recent,
      GATE2,
      digest,
      new Date(Date.now() - 60000).toISOString()
    );
    const future = decide(dir, { context: recent, decidedAt: ahead });
    assert.equal(future.r.ok, false, 'a future decision time is not a delay');

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
    const digest = bindingFor(GATE2, ctx, dir).input_digest;
    recordBriefShown(ctx, GATE2, digest, '2026-11-14T09:00:00.000Z');
    save(dir, ctx);
    put(`planner-input/${STORY}.planner-brief.md`, 'Explore checkout.\n');
    const { r } = decide(dir);
    assert.equal(r.ok, false);
    assert.match(r.message, /first shown is not recorded/);
  } finally {
    removeTempDir(dir);
  }
});

test('the sampled outside review applies only when the team sets a rate, and is drawn once per inputs', () => {
  const { dir, put } = fixture(RED);
  try {
    const refused = decide(dir, { outsideReview: true });
    assert.equal(refused.r.ok, false);
    put(
      'config/gate-checks.json',
      JSON.stringify({ independence: { outside_review_rate: 0.25 } })
    );
    const { r } = decide(dir, { outsideReview: true, rng: () => 0.1 });
    assert.equal(r.ok, true, r.message);
    const first = readCtx(dir).gate_decisions.at(-1).independence;
    assert.equal(first.control, 'outside_review');
    assert.equal(first.rate, 0.25);
    assert.equal(first.selected, true);
    assert.equal(
      first.input_digest,
      bindingFor(GATE2, readCtx(dir), dir).input_digest
    );
    // Approving the same inputs again (after a reopen, say) does not draw
    // again.
    const again = decide(dir, { outsideReview: true, rng: () => 0.99 });
    assert.equal(again.r.ok, true, again.r.message);
    assert.equal(
      readCtx(dir).gate_decisions.at(-1).independence.selected,
      true
    );

    put(
      'config/gate-checks.json',
      JSON.stringify({ independence: { min_delay_minutes: 5 } })
    );
    const bad = decide(dir, { outsideReview: true });
    assert.equal(bad.r.ok, false);
    assert.equal(bad.r.stage, 'context');
    assert.match(bad.r.message, /min_delay_minutes/);
    // A setting that cannot apply does not stop a rejection.
    const rejected = decide(dir, { decision: 'rejected' });
    assert.equal(rejected.r.ok, true, rejected.r.message);
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
