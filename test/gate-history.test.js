// Reading the gate trail: --history and --diff (scripts/lib/gate-history.js).
// Both are read-only. Decisions are recorded test-style in throwaway folders,
// through the same recorder the interactive gate prompt uses.
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
import { bindingFor } from '../scripts/lib/approval-binding.js';
import {
  gateDiff,
  gateTimeline,
  renderDiff,
  renderHistory,
  resolveGate,
} from '../scripts/lib/gate-history.js';
import { listGateRecords } from '../scripts/lib/gate-records.js';
import { recordGateDecision } from '../scripts/run-pipeline.js';

const REPO = process.cwd();
const RUNNER = join(REPO, 'scripts', 'run-pipeline.js');
const STORY = 'GH-1';
const RUN = 'run-gh-1';

function project(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-history-'));
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
  put('story.md', '# GH-1\n\n1. The total equals the sum of the prices.\n');
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

function decide(dir, step, gateKey, decision, notes = null, at = '10:00') {
  const ctx = readCtx(dir);
  const r = recordGateDecision({
    root: dir,
    context: ctx,
    step,
    gateKey,
    decision,
    reviewer: 'Ada Reviewer',
    notes,
    openedAt: `2026-10-10T${at}:00.000Z`,
    decidedAt: `2026-10-10T${at}:30.000Z`,
    bindings: { [gateKey]: bindingFor(gateKey, ctx, dir) },
    brief: 'brief',
  });
  assert.equal(r.ok, true, r.message);
  return r;
}

const runner = (dir, ...args) =>
  spawnSync(execPath, [RUNNER, ...args], { cwd: dir, encoding: 'utf8' });

test('a gate is named by its step or its key; anything else names none', () => {
  assert.equal(resolveGate('gate2'), 'test_scope_reviewed');
  assert.equal(resolveGate('qa_scope'), 'qa_scope_approved');
  assert.equal(resolveGate('gate3-api'), 'collection_reviewed');
  assert.equal(resolveGate('code_reviewed'), 'code_reviewed');
  assert.equal(resolveGate('gate9'), null);
  assert.equal(resolveGate(null), null);
});

test('the timeline matches records to the latest decisions; older ones have none', () => {
  const context = {
    gate_decisions: [
      {
        gate: 'requirements_reviewed',
        decision: 'rejected',
        decided_at: '2026-10-01T10:00:00Z',
      },
      {
        gate: 'requirements_reviewed',
        decision: 'approved',
        decided_at: '2026-10-02T10:00:00Z',
      },
      {
        gate: 'test_scope_reviewed',
        decision: 'approved',
        decided_at: '2026-10-04T10:00:00Z',
      },
    ],
    gate_invalidations: [
      {
        gate: 'test_scope_reviewed',
        invalidated_at: '2026-10-05T10:00:00Z',
        reason: 'reviewed inputs changed since approval: test_cases',
      },
      {
        gate: 'requirements_reviewed',
        invalidated_at: '2026-10-03T10:00:00Z',
        reason: 'reopened',
      },
    ],
  };
  // Only the last Gate 1 decision and the Gate 2 decision have records.
  const records = [
    {
      number: 1,
      step: 'gate1',
      gate: 'requirements_reviewed',
      decision: 'approved',
      record: 'gates/001-gate1-approved.md',
      dir: '',
    },
    {
      number: 2,
      step: 'gate2',
      gate: 'test_scope_reviewed',
      decision: 'approved',
      record: 'gates/002-gate2-approved.md',
      dir: '',
    },
  ];
  const rows = gateTimeline(context, records);
  assert.deepEqual(
    rows.map((r) => [
      r.kind,
      r.gate,
      r.kind === 'decision' ? r.record : r.reason,
    ]),
    [
      ['decision', 'requirements_reviewed', null],
      ['decision', 'requirements_reviewed', 'gates/001-gate1-approved.md'],
      ['reset', 'requirements_reviewed', 'reopened'],
      ['decision', 'test_scope_reviewed', 'gates/002-gate2-approved.md'],
      [
        'reset',
        'test_scope_reviewed',
        'reviewed inputs changed since approval: test_cases',
      ],
    ]
  );
});

test('--history shows each decision with its record, and where every gate stands now', (t) => {
  const { dir, put } = project(t);
  decide(
    dir,
    'gate1',
    'requirements_reviewed',
    'rejected',
    'AC 1 is invented.',
    '09:00'
  );
  decide(dir, 'gate1', 'requirements_reviewed', 'approved', null, '09:30');
  decide(dir, 'gate2', 'test_scope_reviewed', 'approved', null, '10:00');
  put(`planner-input/${STORY}.planner-brief.md`, 'Explore checkout and tax.\n');

  const text = renderHistory(readCtx(dir), dir);
  assert.match(text, /Gate history: GH-1 · run run-gh-1/);
  assert.match(
    text,
    /Gate 1 +REJECTED +Ada Reviewer \(30 s\)\n +"AC 1 is invented\."\n +gates\/001-gate1-rejected\.md/
  );
  assert.match(
    text,
    /Gate 1 +APPROVED +Ada Reviewer \(30 s\)\n +gates\/002-gate1-approved\.md/
  );
  assert.match(text, /Gate 2 +APPROVED .*\n +gates\/003-gate2-approved\.md/);
  assert.match(
    text,
    /Now:\n +Gate 1 +approved\n +Gate 2 +approved, but changed since: planner_brief/
  );
  assert.match(text, /Gate 3 +pending/);
});

test('--diff shows what changed since the approved copy, line by line', (t) => {
  const { dir, put } = project(t);
  decide(dir, 'gate1', 'requirements_reviewed', 'approved');
  decide(dir, 'gate2', 'test_scope_reviewed', 'approved');

  // Nothing changed: the decision itself (in context.json) is not a change.
  let d = gateDiff('test_scope_reviewed', readCtx(dir), dir);
  assert.equal(d.record.record, 'gates/002-gate2-approved.md');
  assert.deepEqual(
    d.entries.map((e) => [e.input, e.state]),
    [
      ['test_cases', 'unchanged'],
      ['planner_brief', 'unchanged'],
    ]
  );
  assert.match(
    renderDiff('test_scope_reviewed', readCtx(dir), dir),
    /Everything this gate reviewed is as it was approved\./
  );

  // A test case edited, the brief deleted.
  const doc = JSON.parse(
    readFileSync(join(dir, `test-cases/${STORY}.json`), 'utf8')
  );
  const oldTitle = doc.test_cases[0].title;
  doc.test_cases[0].title = 'A different case';
  put(`test-cases/${STORY}.json`, JSON.stringify(doc, null, 2) + '\n');
  rmSync(join(dir, `planner-input/${STORY}.planner-brief.md`));
  d = gateDiff('test_scope_reviewed', readCtx(dir), dir);
  assert.deepEqual(
    d.entries.map((e) => [e.input, e.state]),
    [
      ['test_cases', 'changed'],
      ['planner_brief', 'missing now'],
    ]
  );
  const text = renderDiff('test_scope_reviewed', readCtx(dir), dir);
  const lines = text.split('\n').map((l) => l.trim());
  assert.ok(lines.includes(`-      "title": "${oldTitle}",`), text);
  assert.ok(lines.includes('+      "title": "A different case",'), text);
  assert.match(
    text,
    /2 of 2 reviewed input\(s\) differ from the approved copy\./
  );
});

test('Gate 1 compares only the interpretation inside context.json', (t) => {
  const { dir } = project(t);
  decide(dir, 'gate1', 'requirements_reviewed', 'approved');
  const ctx = readCtx(dir);
  // Later decisions and statuses change context.json, not what Gate 1 read.
  ctx.status = 'in_progress';
  writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
  assert.equal(
    gateDiff('requirements_reviewed', readCtx(dir), dir).entries.find(
      (e) => e.input === 'interpretation'
    ).state,
    'unchanged'
  );
  ctx.acceptance_criteria = ['The total is shown.'];
  writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
  const text = renderDiff('requirements_reviewed', readCtx(dir), dir);
  assert.match(text, /interpretation \(context\.json\): changed/);
  assert.ok(
    text.includes('-    "The total equals the sum of the prices."'),
    text
  );
  assert.ok(text.includes('+    "The total is shown."'), text);
});

test('a file kept only as a digest is compared by its digest', (t) => {
  const { dir, put } = project(t);
  for (const [step, gate] of [
    ['gate1', 'requirements_reviewed'],
    ['gate2', 'test_scope_reviewed'],
    ['gate3', 'specs_reviewed'],
    ['gate4', 'code_reviewed'],
  ]) {
    decide(dir, step, gate, 'approved');
  }
  const lock = () =>
    gateDiff('code_reviewed', readCtx(dir), dir).entries.find(
      (e) => e.input === 'package-lock.json'
    ).state;
  assert.equal(lock(), 'unchanged (by digest)');
  put('package-lock.json', '{"lockfileVersion":3,"packages":{"x":{}}}');
  assert.equal(lock(), 'changed (by digest)');
});

test('a gate without an approved record says so', (t) => {
  const { dir } = project(t);
  decide(dir, 'gate1', 'requirements_reviewed', 'rejected', 'No.');
  assert.equal(listGateRecords(dir).length, 1);
  assert.equal(
    renderDiff('requirements_reviewed', readCtx(dir), dir),
    'Gate 1 (gate1): no approved gate record to compare with yet.'
  );
});

test('the CLI views write nothing, even when an approval has gone stale', (t) => {
  const { dir, put } = project(t);
  decide(dir, 'gate1', 'requirements_reviewed', 'approved');
  decide(dir, 'gate2', 'test_scope_reviewed', 'approved');
  put(`planner-input/${STORY}.planner-brief.md`, 'Changed after approval.\n');
  const before = readFileSync(join(dir, 'context.json'), 'utf8');

  const h = runner(dir, '--history');
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /Gate 2 +approved, but changed since: planner_brief/);
  const d = runner(dir, '--diff', 'gate2');
  assert.equal(d.status, 0, d.stderr);
  assert.match(
    d.stdout,
    /planner_brief \(planner-input\/GH-1\.planner-brief\.md\): changed/
  );
  assert.equal(readFileSync(join(dir, 'context.json'), 'utf8'), before);

  assert.equal(runner(dir, '--diff').status, 2);
  assert.equal(runner(dir, '--diff', 'gate9').status, 2);
  assert.equal(runner(dir, '--history', '--resume').status, 2);
  assert.equal(runner(dir, '--history', '--diff', 'gate1').status, 2);
});
