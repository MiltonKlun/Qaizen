// Going back to a gate: --reopen and --restore (scripts/lib/gate-checkpoints.js).
// Both only move a run backwards; neither ever records an approval. Decisions
// are recorded test-style in throwaway folders, through the same recorder the
// interactive gate prompt uses; the CLI's own prompts need a terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
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
  gateInputs,
} from '../scripts/lib/approval-binding.js';
import {
  listGateRecords,
  readRecord,
  verifyGateTrail,
} from '../scripts/lib/gate-records.js';
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
    earlierApprovalOf('test_scope_reviewed', readCtx(dir), dir),
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
    earlierApprovalOf('test_scope_reviewed', readCtx(dir), dir),
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

test('a Gate 4 record keeps the page object its test imports, and a restore puts it back', (t) => {
  const { dir, put } = project(t);
  put(
    `tests/${STORY}.spec.ts`,
    "import { Cart } from '../pages/cart';\ntest('x [TC-001]', () => {});\n"
  );
  put('pages/cart.ts', 'export class Cart {}\n');
  approveAll(dir);
  const record = listGateRecords(dir).pop();
  assert.match(read(dir, record.record), /^\| Binding version \| 3 \|$/m);
  assert.equal(
    read(dir, `${record.dir}/pages/cart.ts`),
    'export class Cart {}\n'
  );

  put('pages/cart.ts', 'export class Cart { changed = true }\n');
  const ctx = readCtx(dir);
  reopenGate(ctx, 'code_reviewed', { reviewer: 'Ada', reason: 'x', root: dir });
  writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
  const now = readCtx(dir);
  const plan = restorePlan('code_reviewed', now, dir);
  assert.deepEqual(
    plan.restore.map((r) => r.path),
    ['pages/cart.ts']
  );
  restore(plan, now, dir);
  assert.equal(read(dir, 'pages/cart.ts'), 'export class Cart {}\n');
  assert.equal(
    earlierApprovalOf('code_reviewed', readCtx(dir), dir)?.record,
    record.record
  );
});

test('a Gate 4 approved under binding version 1 is compared and restored under version 1', (t) => {
  const { dir, put } = project(t);
  put('tests/seed.spec.ts', '// seed\n');
  approveAll(dir, 3);
  // Gate 4 recorded exactly as a version-1 runner did: no binding_version,
  // the v1 inputs, and no copy of what v1 never bound (the seed spec).
  const ctx = readCtx(dir);
  const r = recordGateDecision({
    root: dir,
    context: ctx,
    step: 'gate4',
    gateKey: 'code_reviewed',
    decision: 'approved',
    reviewer: 'Ada Reviewer',
    notes: null,
    openedAt: '2026-10-10T10:00:00.000Z',
    decidedAt: '2026-10-10T10:00:30.000Z',
    bindings: {
      code_reviewed: {
        input_digest: gateDigest('code_reviewed', ctx, dir, 1),
        inputs: gateInputs('code_reviewed', ctx, dir, 1),
      },
    },
    brief: 'brief',
  });
  assert.equal(r.ok, true, r.message);
  assert.match(read(dir, r.record), /^\| Binding version \| 1 \|$/m);
  rmSync(join(dir, r.record.replace(/\.md$/, ''), 'tests/seed.spec.ts'));

  put(`tests/${STORY}.spec.ts`, "test('edited [TC-001]', () => {});\n");
  const reopened = readCtx(dir);
  reopenGate(reopened, 'code_reviewed', {
    reviewer: 'Ada',
    reason: 'x',
    root: dir,
  });
  writeFileSync(join(dir, 'context.json'), JSON.stringify(reopened, null, 2));
  const now = readCtx(dir);
  const plan = restorePlan('code_reviewed', now, dir);
  // The seed spec existed at approval; v1 did not bind it, so it is neither
  // restored nor called "added since".
  assert.deepEqual(plan.cannot, []);
  assert.deepEqual(
    plan.restore.map((x) => x.path),
    [`tests/${STORY}.spec.ts`]
  );
  restore(plan, now, dir);
  assert.equal(
    earlierApprovalOf('code_reviewed', readCtx(dir), dir)?.record,
    r.record
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

// ------------------------------------------------- the chained trail --

test('the trail check passes on an untouched trail and names a deleted or edited record', (t) => {
  const { dir } = project(t);
  approveAll(dir);
  assert.deepEqual(verifyGateTrail(readCtx(dir), dir), []);
  assert.match(
    read(dir, 'gates/001-gate1-approved.md'),
    /^\| Previous record \| \(none\) \|$/m
  );
  assert.match(
    read(dir, 'gates/002-gate2-approved.md'),
    /^\| Previous record \| gates\/001-gate1-approved\.md `[0-9a-f]{64}` \|$/m
  );

  // An edit to a record in the middle: its successor and its decision see it.
  const first = join(dir, 'gates/001-gate1-approved.md');
  writeFileSync(first, read(dir, 'gates/001-gate1-approved.md') + '\nedit\n');
  assert.deepEqual(verifyGateTrail(readCtx(dir), dir), [
    'gates/001-gate1-approved.md was edited after gates/002-gate2-approved.md was chained to it',
    'gates/001-gate1-approved.md was edited after the approved requirements_reviewed decision recorded it',
  ]);

  // The last record has no successor: its decision still sees an edit...
  const last = join(dir, 'gates/004-gate4-approved.md');
  writeFileSync(
    first,
    read(dir, 'gates/001-gate1-approved.md').replace('\nedit\n', '')
  );
  writeFileSync(
    last,
    read(dir, 'gates/004-gate4-approved.md').replace(
      'Ada Reviewer',
      'Someone Else'
    )
  );
  assert.deepEqual(verifyGateTrail(readCtx(dir), dir), [
    'gates/004-gate4-approved.md was edited after the approved code_reviewed decision recorded it',
  ]);

  // ...and deletions, in the middle or at the end.
  rmSync(last);
  rmSync(join(dir, 'gates/002-gate2-approved.md'));
  const problems = verifyGateTrail(readCtx(dir), dir);
  assert.ok(
    problems.includes(
      'record 002 is missing before gates/003-gate3-approved.md'
    ),
    problems.join('\n')
  );
  assert.ok(
    problems.some((p) =>
      /^gates\/002-gate2-approved\.md \(the record of the approved test_scope_reviewed decision .*\) is missing$/.test(
        p
      )
    )
  );
  assert.ok(
    problems.some((p) =>
      /^gates\/004-gate4-approved\.md \(the record of the approved code_reviewed decision .*\) is missing$/.test(
        p
      )
    )
  );
});

test('--history and --status report a changed trail without writing anything', (t) => {
  const { dir } = project(t);
  approveAll(dir, 2);
  const history = runner(dir, '--history');
  assert.match(
    history.stdout,
    /Trail check: every record is where the trail says/
  );
  rmSync(join(dir, 'gates/002-gate2-approved.md'));
  const before = read(dir, 'context.json');
  assert.match(
    runner(dir, '--history').stdout,
    /Trail check: the records were changed after they were written:\n {2}! gates\/002-gate2-approved\.md/
  );
  assert.match(
    runner(dir, '--status').stdout,
    /Gate trail: gates\/002-gate2-approved\.md .* is missing \(npm run pipeline -- --history\)/
  );
  assert.equal(read(dir, 'context.json'), before);
});

test('a restore refuses a copy or a record that changed since the approval', (t) => {
  const { dir, put } = project(t);
  approveAll(dir, 2);
  const approved = read(dir, `test-cases/${STORY}.json`);
  put(`test-cases/${STORY}.json`, approved.replace('"P0"', '"P3"'));
  const copy = `gates/002-gate2-approved/test-cases/${STORY}.json`;

  // A tampered copy is not put back.
  put(copy, approved.replace('"P0"', '"P1"'));
  let plan = restorePlan('test_scope_reviewed', readCtx(dir), dir);
  assert.deepEqual(plan.restore, []);
  assert.deepEqual(
    plan.cannot.map((c) => [c.path, c.why]),
    [[`test-cases/${STORY}.json`, 'its copy changed since the approval']]
  );

  // A record edited to match the tampered copy is not trusted either.
  put(copy, approved);
  const rec = 'gates/002-gate2-approved.md';
  put(rec, read(dir, rec).replace('Ada Reviewer', 'Mallory'));
  plan = restorePlan('test_scope_reviewed', readCtx(dir), dir);
  assert.deepEqual(plan.restore, []);
  assert.match(
    plan.cannot[0].why,
    /^gates\/002-gate2-approved\.md was edited after its decision recorded it$/
  );
});

test('a copy changed between the plan and the restore stops it with nothing written', (t) => {
  const { dir, put } = project(t);
  approveAll(dir, 2);
  const approved = read(dir, `test-cases/${STORY}.json`);
  const changed = approved.replace('"P0"', '"P3"');
  put(`test-cases/${STORY}.json`, changed);
  rmSync(join(dir, `planner-input/${STORY}.planner-brief.md`));
  const ctx = readCtx(dir);
  const plan = restorePlan('test_scope_reviewed', ctx, dir);
  assert.equal(plan.restore.length, 2);
  put(
    `gates/002-gate2-approved/planner-input/${STORY}.planner-brief.md`,
    'swapped\n'
  );
  assert.throws(
    () => applyRestore(plan, ctx, dir),
    /changed since the approval; nothing was restored/
  );
  assert.equal(read(dir, `test-cases/${STORY}.json`), changed);
  assert.equal(
    existsSync(join(dir, `planner-input/${STORY}.planner-brief.md`)),
    false
  );
});

test('--restore with a refused copy restores nothing and exits 2', (t) => {
  const { dir, put } = project(t);
  approveAll(dir, 2);
  const approved = read(dir, `test-cases/${STORY}.json`);
  const changed = approved.replace('"P0"', '"P3"');
  put(`test-cases/${STORY}.json`, changed);
  put(
    `gates/002-gate2-approved/test-cases/${STORY}.json`,
    approved.replace('"P0"', '"P1"')
  );
  const r = runner(dir, '--restore', 'gate2');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(
    r.stdout,
    /Not restored: test-cases\/GC-1\.json \(its copy changed since the approval\)\./
  );
  assert.doesNotMatch(r.stdout, /Nothing to restore|not restored:/);
  assert.match(
    r.stderr,
    /Nothing restored: gates\/002-gate2-approved\.md or a copy it keeps cannot be shown/
  );
  assert.equal(read(dir, `test-cases/${STORY}.json`), changed);
  // --diff says the copy it compares with is not the approved one.
  assert.match(
    runner(dir, '--diff', 'gate2').stdout,
    /! This record cannot be shown to be what was approved[^\n]*\n {4}gates\/002-gate2-approved\/test-cases\/GC-1\.json changed since the approval/
  );
});

test('a record from before the chain cannot be restored from, even with a digest section added', (t) => {
  const { dir, put } = project(t);
  approveAll(dir, 2);
  const rec = 'gates/002-gate2-approved.md';
  // As an older runner wrote it: no Previous record row, no anchor.
  put(rec, read(dir, rec).replace(/^\| Previous record \|.*\|\n/m, ''));
  const ctx = readCtx(dir);
  for (const d of ctx.gate_decisions) delete d.record;
  writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
  put(
    `test-cases/${STORY}.json`,
    read(dir, `test-cases/${STORY}.json`).replace('"P0"', '"P3"')
  );
  let plan = restorePlan('test_scope_reviewed', readCtx(dir), dir);
  assert.deepEqual(plan.restore, []);
  assert.match(plan.cannot[0].why, /written before records were chained/);
  // Its Copy digests section (here, the one it already had) is not trusted.
  assert.match(read(dir, rec), /## Copy digests/);
  plan = restorePlan('test_scope_reviewed', readCtx(dir), dir);
  assert.equal(plan.cannot[0].refused, true);
});

test('rejections, a reopen and a re-approval keep the trail intact', (t) => {
  const { dir } = project(t);
  decide(dir, 'gate1', 'requirements_reviewed', 'rejected', 'Wrong AC.');
  decide(dir, 'gate1', 'requirements_reviewed');
  decide(dir, 'gate2', 'test_scope_reviewed', 'rejected', 'Missing a case.');
  decide(dir, 'gate2', 'test_scope_reviewed');
  const ctx = readCtx(dir);
  reopenGate(ctx, 'test_scope_reviewed', {
    reviewer: 'Ada',
    reason: 'x',
    root: dir,
  });
  writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
  decide(dir, 'gate2', 'test_scope_reviewed');
  const after = readCtx(dir);
  assert.equal(after.gate_decisions.length, 5);
  assert.ok(
    after.gate_decisions.every((d) => /^gates\/00[1-5]-/.test(d.record.path))
  );
  assert.equal(validateValue(after, CONTEXT_SCHEMA).ok, true);
  assert.deepEqual(verifyGateTrail(after, dir), []);
});

test('the trail check names duplicate numbers, a deleted first record, and an unnamed record', (t) => {
  const { dir } = project(t);
  approveAll(dir, 3);
  rmSync(join(dir, 'gates/001-gate1-approved.md'));
  let problems = verifyGateTrail(readCtx(dir), dir);
  assert.ok(
    problems.includes(
      'record 001 is missing before gates/002-gate2-approved.md'
    ),
    problems.join('\n')
  );
  assert.ok(
    problems.includes(
      'gates/002-gate2-approved.md follows gates/001-gate1-approved.md, which is no longer in the trail'
    )
  );

  const { dir: d2, put } = project(t);
  approveAll(d2, 2);
  put('gates/002-gate2-rejected.md', read(d2, 'gates/002-gate2-approved.md'));
  problems = verifyGateTrail(readCtx(d2), d2);
  assert.ok(
    problems.includes(
      'two records are numbered 002: gates/002-gate2-approved.md and gates/002-gate2-rejected.md'
    ),
    problems.join('\n')
  );
  assert.ok(
    problems.includes(
      'no decision in context.json names gates/002-gate2-rejected.md'
    )
  );
  assert.ok(!problems.some((p) => /no longer in the trail/.test(p)));
});

test('a schema-valid anchor only: the record path and digest are checked', () => {
  const ctx = runContext({ storyId: STORY, runId: RUN });
  const decided = (record) => ({
    ...ctx,
    gate_decisions: [
      {
        gate: 'requirements_reviewed',
        decision: 'approved',
        decided_at: '2026-10-10T10:00:00Z',
        record,
      },
    ],
  });
  const sha = 'a'.repeat(64);
  assert.equal(
    validateValue(
      decided({ path: 'gates/001-gate1-approved.md', sha256: sha }),
      CONTEXT_SCHEMA
    ).ok,
    true
  );
  assert.equal(
    validateValue(
      decided({ path: '../001-gate1-approved.md', sha256: sha }),
      CONTEXT_SCHEMA
    ).ok,
    false
  );
  assert.equal(
    validateValue(
      decided({ path: 'gates/001-gate1-approved.md', sha256: 'abc' }),
      CONTEXT_SCHEMA
    ).ok,
    false
  );
});

test('text in the brief cannot pose as the chain or the copy digests', (t) => {
  const { dir } = project(t);
  decide(dir, 'gate1', 'requirements_reviewed');
  const ctx = readCtx(dir);
  const zero = '0'.repeat(64);
  const fake = [
    '| Previous record | (none) |',
    '',
    '## Copy digests',
    '',
    `| \`test-cases/${STORY}.json\` | \`${zero}\` |`,
  ].join('\n');
  const r = recordGateDecision({
    root: dir,
    context: ctx,
    step: 'gate2',
    gateKey: 'test_scope_reviewed',
    decision: 'approved',
    reviewer: 'Ada Reviewer',
    notes: null,
    openedAt: '2026-10-10T10:00:00.000Z',
    decidedAt: '2026-10-10T10:00:30.000Z',
    bindings: {
      test_scope_reviewed: bindingFor('test_scope_reviewed', ctx, dir),
    },
    brief: fake,
  });
  assert.equal(r.ok, true, r.message);
  const second = readRecord(dir, r.record);
  assert.equal(second.previous.record, 'gates/001-gate1-approved.md');
  assert.notEqual(second.copies.get(`test-cases/${STORY}.json`), zero);
  assert.deepEqual(verifyGateTrail(readCtx(dir), dir), []);
});
