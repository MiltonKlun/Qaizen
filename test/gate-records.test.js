// Gate records: every gate decision leaves a readable record and a copy of
// what it reviewed (scripts/lib/gate-records.js). Decisions here are recorded
// test-style in throwaway folders, as the other runner tests do with
// applyGateDecision; the runner's own prompt stays interactive-only.
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
import {
  bindingFor,
  gateFiles,
  gateInputs,
} from '../scripts/lib/approval-binding.js';
import {
  captureGateFiles,
  listGateRecords,
} from '../scripts/lib/gate-records.js';
import { classifyRootArtifacts } from '../scripts/lib/run-lifecycle.js';
import { recordGateDecision } from '../scripts/run-pipeline.js';

const STORY = 'GR-1';
const RUN = 'run-gr-1';
const ALL_GATES = [
  'requirements_reviewed',
  'test_scope_reviewed',
  'qa_scope_approved',
  'specs_reviewed',
  'code_reviewed',
  'collection_reviewed',
  'api_assertions_reviewed',
  'external_plan_reviewed',
  'external_evidence_reviewed',
];

/** A throwaway run with a file behind every gate input. */
function project(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-gates-'));
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
  put('story.md', '# GR-1\n\n1. The shopper sees the total.\n');
  put(
    `test-cases/${STORY}.json`,
    JSON.stringify(scopeCases(STORY, RUN), null, 2)
  );
  put(`planner-input/${STORY}.planner-brief.md`, 'Explore checkout.\n');
  put(`specs/${STORY}.md`, '# SPEC-001\n');
  put(`tests/${STORY}.spec.ts`, "test('x [TC-001]', () => {});\n");
  put('playwright.config.ts', 'export default {};\n');
  put('package-lock.json', '{"lockfileVersion":3}');
  put('tests/fixtures/user.json', '{"name":"u"}');
  put(`api-tests/collections/${STORY}.postman_collection.json`, '{"item":[]}');
  put(`api-tests/environments/${STORY}.postman_environment.json`, '{}');
  put('docs/api-spec.yaml', 'openapi: 3.0.0\n');
  put('scripts/run-newman.js', '// newman\n');
  put(`planner-input/${STORY}.external-plan.json`, '{"entries":[]}');
  put(
    `external-evidence/${STORY}.results.json`,
    JSON.stringify({
      results: [{ evidence: [{ path: `external-evidence/${STORY}/a.png` }] }],
    })
  );
  put(`external-evidence/${STORY}/a.png`, 'PNG');
  put('context.json', JSON.stringify(ctx, null, 2));
  return { dir, ctx, put };
}

/** Record one decision test-style, the way the gate prompt does. */
function decide(dir, ctx, step, gateKey, decision, extra = {}) {
  return recordGateDecision({
    root: dir,
    context: ctx,
    step,
    gateKey,
    decision,
    reviewer: 'Ada Reviewer',
    notes: null,
    openedAt: '2026-10-10T10:00:00.000Z',
    decidedAt: '2026-10-10T10:00:42.000Z',
    bindings: { [gateKey]: bindingFor(gateKey, ctx, dir) },
    brief: 'BRIEF AS SHOWN',
    ...extra,
  });
}

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');

test('each gate copies exactly the files its approval digest covers', (t) => {
  const { dir, ctx } = project(t);
  for (const gate of ALL_GATES) {
    const digested = Object.keys(gateInputs(gate, ctx, dir))
      .filter((k) => !k.startsWith('gate:'))
      .sort();
    const listed = gateFiles(gate, ctx, dir)
      .map((f) => f.input)
      .sort();
    assert.deepEqual(listed, digested, gate);
  }
});

test('a decision leaves a numbered record and a copy of what was reviewed', (t) => {
  const { dir, ctx, put } = project(t);
  const r = decide(dir, ctx, 'gate1', 'requirements_reviewed', 'approved');
  assert.equal(r.ok, true, r.message);
  assert.equal(r.record, 'gates/001-gate1-approved.md');
  assert.equal(r.dir, 'gates/001-gate1-approved');

  const md = read(dir, r.record);
  assert.match(md, /— APPROVED/);
  assert.match(md, /\| Reviewer \| Ada Reviewer \|/);
  assert.match(md, /\| Decided \| 2026-10-10T10:00:42\.000Z \(42 s\) \|/);
  const binding = bindingFor('requirements_reviewed', ctx, dir);
  assert.ok(md.includes(binding.input_digest));
  assert.match(
    md,
    /\| story \(story\.md\) \| `[0-9a-f]{12}` \| gates\/001-gate1-approved\/story\.md \|/
  );
  assert.match(md, /```text\nBRIEF AS SHOWN\n```/);

  // The decision itself is in context.json, as before.
  const saved = JSON.parse(read(dir, 'context.json'));
  assert.equal(saved.review_gates.requirements_reviewed.status, true);
  assert.equal(saved.gate_decisions.length, 1);

  // The copy is what was reviewed, and stays so when the run moves on.
  const original = read(dir, 'story.md');
  put('story.md', '# GR-1\n\nrewritten later\n');
  assert.equal(read(dir, `${r.dir}/story.md`), original);
  const snapCtx = JSON.parse(read(dir, `${r.dir}/context.json`));
  assert.equal(
    snapCtx.review_gates.requirements_reviewed,
    false,
    'context.json is copied as it was reviewed, before the decision'
  );
});

test('a rejection records what must change; the next decision is numbered after it', (t) => {
  const { dir, ctx } = project(t);
  const rej = decide(dir, ctx, 'gate1', 'requirements_reviewed', 'rejected', {
    notes: 'AC 2 is invented.\nRe-read the story.',
  });
  assert.equal(rej.record, 'gates/001-gate1-rejected.md');
  assert.match(
    read(dir, rej.record),
    /## What must change\n\n> AC 2 is invented\.\n> Re-read the story\./
  );

  const ok = decide(dir, ctx, 'gate1', 'requirements_reviewed', 'approved');
  assert.equal(ok.record, 'gates/002-gate1-approved.md');
  assert.match(
    read(dir, ok.record),
    /## Earlier decisions on this gate\n\n- rejected 2026-10-10T10:00:42\.000Z by Ada Reviewer: "AC 2 is invented\. Re-read the story\."/
  );
  assert.deepEqual(
    listGateRecords(dir).map((r) => [r.number, r.step, r.gate, r.decision]),
    [
      [1, 'gate1', 'requirements_reviewed', 'rejected'],
      [2, 'gate1', 'requirements_reviewed', 'approved'],
    ]
  );
});

test('Gate 4 keeps the scan; repository and outside files keep only their digest', (t) => {
  const { dir, ctx } = project(t);
  const r = decide(dir, ctx, 'gate4', 'code_reviewed', 'approved', {
    scan: 'Gate-4 static scan — 0 findings',
  });
  assert.equal(r.ok, true, r.message);
  const md = read(dir, r.record);
  assert.match(
    md,
    /## Gate 4 static scan\n\n```text\nGate-4 static scan — 0 findings\n```/
  );
  assert.match(
    md,
    /\| package-lock\.json \(package-lock\.json\) \| `[0-9a-f]{12}` \| repository file; digest only \|/
  );
  assert.match(
    md,
    /\| gate:specs_reviewed \| `[0-9a-f]{12}` \| the previous gate's approved inputs \|/
  );
  assert.ok(existsSync(join(dir, r.dir, 'tests/fixtures/user.json')));
  assert.ok(existsSync(join(dir, r.dir, `tests/${STORY}.spec.ts`)));
  assert.equal(existsSync(join(dir, r.dir, 'package-lock.json')), false);

  // A reviewed file outside the run (the demo's tests) is never copied out.
  const outside = mkdtempSync(join(tmpdir(), 'qaizen-outside-'));
  t.after(() => removeTempDir(outside));
  writeFileSync(join(outside, 'x.spec.ts'), 'test()\n');
  ctx.artifact_paths.generated_test = join(outside, 'x.spec.ts');
  const cap = captureGateFiles('code_reviewed', ctx, dir).find(
    (f) => f.input === 'generated_test'
  );
  assert.equal(cap.bytes, null);
  assert.equal(cap.note, 'outside the run folder; digest only');
});

test('the lite track records its consolidated gate under its own step name', (t) => {
  const { dir, ctx } = project(t);
  ctx.track = 'lite';
  const r = decide(dir, ctx, 'qa_scope', 'qa_scope_approved', 'approved');
  assert.equal(r.ok, true, r.message);
  assert.equal(r.record, 'gates/001-qa_scope-approved.md');
  assert.ok(existsSync(join(dir, r.dir, `test-cases/${STORY}.json`)));
  assert.ok(existsSync(join(dir, r.dir, 'story.md')));
  assert.deepEqual(
    listGateRecords(dir).map((x) => x.gate),
    ['qa_scope_approved']
  );
});

test('a context that does not validate is refused before anything is written', (t) => {
  const { dir, ctx } = project(t);
  const before = read(dir, 'context.json');
  ctx.run_id = 42;
  const r = decide(dir, ctx, 'gate1', 'requirements_reviewed', 'approved');
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'context');
  assert.equal(read(dir, 'context.json'), before);
  assert.equal(existsSync(join(dir, 'gates')), false);
});

test('a record that cannot be written is reported after the decision is saved', (t) => {
  const { dir, ctx, put } = project(t);
  put('gates', 'a file where the folder should be');
  const r = decide(dir, ctx, 'gate1', 'requirements_reviewed', 'approved');
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'record');
  const saved = JSON.parse(read(dir, 'context.json'));
  assert.equal(saved.review_gates.requirements_reviewed.status, true);
});

test('gate records belong to the run: they are archived with it', (t) => {
  const { dir, ctx } = project(t);
  const r = decide(dir, ctx, 'gate1', 'requirements_reviewed', 'approved');
  const { owned, unknown } = classifyRootArtifacts(ctx, dir);
  assert.ok(owned.includes(r.record));
  assert.ok(owned.includes(`${r.dir}/story.md`));
  assert.ok(owned.includes(`${r.dir}/context.json`));
  assert.deepEqual(
    unknown.filter((u) => u.startsWith('gates/')),
    []
  );
});
