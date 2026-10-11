// Going back to a gate: --reopen and --restore (scripts/lib/gate-checkpoints.js).
// Both only move a run backwards; neither ever records an approval. Decisions
// are recorded test-style in throwaway folders, through the same recorder the
// interactive gate prompt uses; the CLI's own prompts need a terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execPath } from 'node:process';

import { removeTempDir } from './helpers/cleanup.js';
import { runContext, scopeCases } from './helpers/valid-run.js';
import {
  bindingFor,
  bindingState,
  gateDigest,
} from '../scripts/lib/approval-binding.js';
import { validateValue } from '../scripts/lib/artifact-io.js';
import {
  applyRestore,
  earlierApprovalOf,
  reopenGate,
  restorePlan,
} from '../scripts/lib/gate-checkpoints.js';
import { recordGateDecision } from '../scripts/run-pipeline.js';

const REPO = process.cwd();
const RUNNER = join(REPO, 'scripts', 'run-pipeline.js');
const CONTEXT_SCHEMA = join(REPO, 'schemas', 'context.schema.json');
const STORY = 'GC-1';
const RUN = 'run-gc-1';
const GATES = [
  ['gate1', 'requirements_reviewed'],
  ['gate2', 'test_scope_reviewed'],
  ['gate3', 'specs_reviewed'],
  ['gate4', 'code_reviewed'],
];

function project(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-checkpoints-'));
  t.after(() => removeTempDir(dir));
  const put = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  const ctx = runContext({
    storyId: STORY,
    runId: RUN,
    status: 'draft',
    gates: false,
  });
  ctx.acceptance_criteria = ['The total equals the sum of the prices.'];
  put('story.md', '# GC-1\n\n1. The total equals the sum of the prices.\n');
  put(
    `test-cases/${STORY}.json`,
    JSON.stringify(scopeCases(STORY, RUN), null, 2) + '\n'
  );
  put(`planner-input/${STORY}.planner-brief.md`, 'Explore checkout.\n');
  put(`specs/${STORY}.md`, '# SPEC-001\n');
  put(`tests/${STORY}.spec.ts`, "test('x [TC-001]', () => {});\n");
  put('playwright.config.ts', 'export default {};\n');
  put('package-lock.json', '{"lockfileVersion":3}');
  put('context.json', JSON.stringify(ctx, null, 2));
  return { dir, put };
}

const readCtx = (dir) =>
  JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'));
const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');

function decide(dir, step, gateKey, decision = 'approved', notes = null) {
  const ctx = readCtx(dir);
  const r = recordGateDecision({
    root: dir,
    context: ctx,
    step,
    gateKey,
    decision,
    reviewer: 'Ada Reviewer',
    notes,
    openedAt: '2026-10-10T10:00:00.000Z',
    decidedAt: '2026-10-10T10:00:30.000Z',
    bindings: { [gateKey]: bindingFor(gateKey, ctx, dir) },
    brief: 'brief',
  });
  assert.equal(r.ok, true, r.message);
  return r;
}

const approveAll = (dir, upTo = 4) => {
  for (const [step, gate] of GATES.slice(0, upTo)) decide(dir, step, gate);
};

/** A restore, checked never to touch a gate's state or the decision log. */
function restore(plan, ctx, dir) {
  const gates = structuredClone({
    review_gates: ctx.review_gates,
    gate_decisions: ctx.gate_decisions ?? null,
    gate_invalidations: ctx.gate_invalidations ?? null,
  });
  const result = applyRestore(plan, ctx, dir);
  assert.deepEqual(
    {
      review_gates: ctx.review_gates,
      gate_decisions: ctx.gate_decisions ?? null,
      gate_invalidations: ctx.gate_invalidations ?? null,
    },
    gates,
    'a restore never records, withdraws or changes an approval'
  );
  return result;
}

const runner = (dir, ...args) =>
  spawnSync(execPath, [RUNNER, ...args], {
    cwd: dir,
    encoding: 'utf8',
    input: '',
  });

test('reopening a gate returns it and every approval after it to pending, with the reason', (t) => {
  const { dir } = project(t);
  approveAll(dir);
  const ctx = readCtx(dir);
  const decisionsBefore = structuredClone(ctx.gate_decisions);

  const reopened = reopenGate(ctx, 'test_scope_reviewed', {
    reviewer: 'Ada Reviewer',
    reason: 'The scope misses tax.',
    root: dir,
    now: new Date('2026-10-11T09:00:00Z'),
  });
  assert.deepEqual(reopened, [
    'test_scope_reviewed',
    'specs_reviewed',
    'code_reviewed',
  ]);
  assert.equal(ctx.review_gates.requirements_reviewed.status, true);
  for (const g of reopened) assert.equal(ctx.review_gates[g].status, false);
  assert.deepEqual(
    ctx.gate_invalidations.map((i) => [i.gate, i.reason, i.previous_reviewer]),
    [
      [
        'test_scope_reviewed',
        'reopened by Ada Reviewer: The scope misses tax.',
        'Ada Reviewer',
      ],
      [
        'specs_reviewed',
        'depends on test_scope_reviewed, which was reopened',
        'Ada Reviewer',
      ],
      [
        'code_reviewed',
        'depends on test_scope_reviewed, which was reopened',
        'Ada Reviewer',
      ],
    ]
  );
  // No decision is invented, and the result is a valid context.
  assert.deepEqual(ctx.gate_decisions, decisionsBefore);
  assert.equal(validateValue(ctx, CONTEXT_SCHEMA).ok, true);
});

test('a gate that is not approved has nothing to reopen', (t) => {
  const { dir } = project(t);
  approveAll(dir, 1);
  const ctx = readCtx(dir);
  const before = JSON.stringify(ctx);
  assert.deepEqual(
    reopenGate(ctx, 'specs_reviewed', {
      reviewer: 'Ada',
      reason: 'x',
      root: dir,
    }),
    []
  );
  assert.equal(JSON.stringify(ctx), before);
});

test('restoring puts back exactly the approved files; a standing approval stands again', (t) => {
  const { dir, put } = project(t);
  approveAll(dir, 2);
  const approvedCases = read(dir, `test-cases/${STORY}.json`);
  const approvedBrief = read(dir, `planner-input/${STORY}.planner-brief.md`);
  put(`test-cases/${STORY}.json`, approvedCases.replace('"P0"', '"P3"'));
  rmSync(join(dir, `planner-input/${STORY}.planner-brief.md`));
  assert.equal(
    bindingState('test_scope_reviewed', readCtx(dir), dir).state,
    'stale'
  );

  const ctx = readCtx(dir);
  const plan = restorePlan('test_scope_reviewed', ctx, dir);
  assert.equal(plan.record.record, 'gates/002-gate2-approved.md');
  assert.deepEqual(
    plan.restore.map((r) => [r.input, r.from]),
    [
      ['test_cases', `gates/002-gate2-approved/test-cases/${STORY}.json`],
      [
        'planner_brief',
        `gates/002-gate2-approved/planner-input/${STORY}.planner-brief.md`,
      ],
    ]
  );
  const done = restore(plan, ctx, dir);
  assert.deepEqual(done, [
    `test-cases/${STORY}.json`,
    `planner-input/${STORY}.planner-brief.md`,
  ]);
  assert.equal(read(dir, `test-cases/${STORY}.json`), approvedCases);
  assert.equal(
    read(dir, `planner-input/${STORY}.planner-brief.md`),
    approvedBrief
  );
  // The approval was never withdrawn, and now matches again.
  assert.equal(
    bindingState('test_scope_reviewed', readCtx(dir), dir).state,
    'current'
  );
  assert.deepEqual(
    restorePlan('test_scope_reviewed', readCtx(dir), dir).restore,
    []
  );
});

test('restoring never approves: a reopened gate stays pending, and its brief can say it was approved before', (t) => {
  const { dir, put } = project(t);
  approveAll(dir, 2);
  const approvedBrief = read(dir, `planner-input/${STORY}.planner-brief.md`);
  const ctx = readCtx(dir);
  reopenGate(ctx, 'test_scope_reviewed', {
    reviewer: 'Ada',
    reason: 'Rework.',
    root: dir,
  });
  writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
  put(`planner-input/${STORY}.planner-brief.md`, 'A reworked brief.\n');
  assert.equal(
    earlierApprovalOf(
      'test_scope_reviewed',
      gateDigest('test_scope_reviewed', readCtx(dir), dir),
      dir
    ),
    null
  );

  const now = readCtx(dir);
  restore(restorePlan('test_scope_reviewed', now, dir), now, dir);
  assert.equal(
    read(dir, `planner-input/${STORY}.planner-brief.md`),
    approvedBrief
  );
  assert.equal(
    bindingState('test_scope_reviewed', readCtx(dir), dir).state,
    'pending'
  );
  assert.deepEqual(
    earlierApprovalOf(
      'test_scope_reviewed',
      gateDigest('test_scope_reviewed', readCtx(dir), dir),
      dir
    ),
    {
      record: 'gates/002-gate2-approved.md',
      reviewer: 'Ada Reviewer',
      decided: '2026-10-10T10:00:30.000Z',
    }
  );
});

test("Gate 1's restore puts back the interpretation and leaves the rest of context.json", (t) => {
  const { dir } = project(t);
  approveAll(dir, 1);
  const ctx = readCtx(dir);
  ctx.acceptance_criteria = ['A rewritten criterion.'];
  ctx.track = 'standard';
  ctx.status = 'in_progress';
  writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));

  const now = readCtx(dir);
  const plan = restorePlan('requirements_reviewed', now, dir);
  assert.deepEqual(
    plan.restore.map((r) => r.input),
    ['interpretation']
  );
  assert.deepEqual(restore(plan, now, dir), ['interpretation (context.json)']);
  assert.deepEqual(now.acceptance_criteria, [
    'The total equals the sum of the prices.',
  ]);
  assert.equal('track' in now, false);
  assert.equal(
    now.status,
    'in_progress',
    'only the interpretation is restored'
  );
  assert.equal(
    bindingState('requirements_reviewed', now, dir).state,
    'current'
  );
});

test('what was kept only as a digest, or added since, is listed and never touched', (t) => {
  const { dir, put } = project(t);
  approveAll(dir);
  put('package-lock.json', '{"lockfileVersion":3,"packages":{"x":{}}}');
  put('tests/fixtures/new.json', '{}');
  const plan = restorePlan('code_reviewed', readCtx(dir), dir);
  assert.deepEqual(plan.restore, []);
  assert.deepEqual(
    plan.cannot.map((c) => [c.path, c.why]),
    [
      ['package-lock.json', 'changed, but only its digest was kept'],
      [
        'tests/fixtures/new.json',
        'added since the approval; a restore does not delete files',
      ],
    ]
  );
});

test('an approved record says how to go back; a rejected one does not', (t) => {
  const { dir } = project(t);
  const rej = decide(dir, 'gate1', 'requirements_reviewed', 'rejected', 'No.');
  const ok = decide(dir, 'gate1', 'requirements_reviewed');
  assert.doesNotMatch(read(dir, rej.record), /## Going back/);
  assert.match(
    read(dir, ok.record),
    /## Going back\n\n- What changed since this approval: `npm run pipeline -- --diff gate1`\n- Put back the files it approved: `npm run pipeline -- --restore gate1`\n- Send the run back to this gate: `npm run pipeline -- --reopen gate1`/
  );
});

test('the CLI changes nothing without a terminal, and refuses misuse', (t) => {
  const { dir, put } = project(t);
  approveAll(dir, 2);
  put(`planner-input/${STORY}.planner-brief.md`, 'Changed.\n');
  const ctxBefore = read(dir, 'context.json');

  const reopen = runner(dir, '--reopen', 'gate2');
  assert.equal(reopen.status, 1);
  assert.match(reopen.stderr, /Reopening a gate is interactive-only/);
  const restore = runner(dir, '--restore', 'gate2');
  assert.equal(restore.status, 1);
  assert.match(
    restore.stdout,
    /planner_brief \(planner-input\/GC-1\.planner-brief\.md\): changed/
  );
  assert.match(restore.stderr, /Restoring files is interactive-only/);
  assert.equal(read(dir, 'context.json'), ctxBefore);
  assert.equal(
    read(dir, `planner-input/${STORY}.planner-brief.md`),
    'Changed.\n'
  );

  const pending = runner(dir, '--reopen', 'gate3');
  assert.equal(pending.status, 0);
  assert.match(
    pending.stdout,
    /Gate 3 is not approved; there is nothing to reopen\./
  );
  assert.equal(runner(dir, '--reopen').status, 2);
  assert.equal(runner(dir, '--restore', 'gate9').status, 2);
  assert.equal(runner(dir, '--reopen', 'gate2', '--resume').status, 2);
  assert.equal(runner(dir, '--restore', 'gate2', '--diff', 'gate2').status, 2);
});
