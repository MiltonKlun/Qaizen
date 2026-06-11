// Smoke tests for the pipeline's own scripts — black-box: run each script as a
// subprocess and assert its exit code + observable output. No refactoring of the
// scripts; this is the fast "does the machinery still work" net that catches a
// broken script before CI's heavier jobs do. Run with `npm run test:smoke`.
//
// These run from the repo root, against the real committed fixtures (the 5
// archived runs, the expected examples). Migration tests use a temp copy so
// nothing in the repo is mutated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run a node script from the repo root; return { code, out }.
function run(args) {
  const r = spawnSync('node', args, { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('demo:healer — Green/Red boundary holds (exit 0)', () => {
  const r = run(['scripts/demo-healer-green-red.js']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /GREEN[\s\S]*SAFE/);
  assert.match(r.out, /RED[\s\S]*REJECTED/);
});

test('validate:examples — every gold example validates (exit 0)', () => {
  const r = run(['scripts/validate-examples.js']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\d+ passed, 0 failed/);
});

test('evaluate — agent dataset scores 100% (exit 0)', () => {
  const r = run(['scripts/evaluate-agents.js']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Overall: 100%/);
});

test('metrics — runs and reports gate-rejection honesty (exit 0)', () => {
  const r = run(['scripts/pipeline-metrics.js']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Gate rejections/);
});

test('list-runs — finds the archived runs as JSON (exit 0)', () => {
  const r = run(['scripts/list-runs.js', '--json']);
  assert.equal(r.code, 0, r.out);
  const rows = JSON.parse(r.out);
  assert.ok(
    Array.isArray(rows) && rows.length >= 1,
    'expected >=1 archived run'
  );
  assert.ok(
    rows.every((x) => x.story_id && x.run_id),
    'rows need story_id+run_id'
  );
});

test('validate-json — rejects an invalid artifact (exit non-zero)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiqa-smoke-'));
  try {
    const bad = join(dir, 'bad-context.json');
    writeFileSync(bad, JSON.stringify({ not: 'a valid context' }));
    const r = run([
      'scripts/validate-json.js',
      'schemas/context.schema.json',
      bad,
    ]);
    assert.notEqual(r.code, 0, 'invalid artifact must fail validation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate:gate-decisions — idempotent backfill of empty log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiqa-smoke-'));
  try {
    const ctx = join(dir, 'context.json');
    // start from a valid committed example, strip gate_decisions if present
    const src = JSON.parse(
      readFileSync(
        'examples/expected/login-success.expected-context.json',
        'utf8'
      )
    );
    delete src.gate_decisions;
    writeFileSync(ctx, JSON.stringify(src, null, 2));

    const first = run([
      'scripts/migrate-context-gate-decisions.js',
      ctx,
      '--apply',
    ]);
    assert.equal(first.code, 0, first.out);
    const after = JSON.parse(readFileSync(ctx, 'utf8'));
    assert.ok(Array.isArray(after.gate_decisions), 'should seed an empty log');

    // still valid against the schema
    const v = run([
      'scripts/validate-json.js',
      'schemas/context.schema.json',
      ctx,
    ]);
    assert.equal(v.code, 0, v.out);

    // idempotent: second run reports "left untouched", exit 0
    const second = run([
      'scripts/migrate-context-gate-decisions.js',
      ctx,
      '--apply',
    ]);
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /left untouched/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate:release-report-tg12 — backfills open_bugs_summary, idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiqa-smoke-'));
  try {
    const rep = join(dir, 'report.json');
    const src = JSON.parse(
      readFileSync(
        'examples/expected/uncovered-risk.expected-release-report.json',
        'utf8'
      )
    );
    delete src.open_bugs_summary;
    writeFileSync(rep, JSON.stringify(src, null, 2));

    const first = run([
      'scripts/migrate-release-report-tg12.js',
      rep,
      '--apply',
    ]);
    assert.equal(first.code, 0, first.out);
    const after = JSON.parse(readFileSync(rep, 'utf8'));
    assert.ok(after.open_bugs_summary, 'should backfill open_bugs_summary');
    const v = run([
      'scripts/validate-json.js',
      'schemas/release-report.schema.json',
      rep,
    ]);
    assert.equal(v.code, 0, v.out);

    const second = run([
      'scripts/migrate-release-report-tg12.js',
      rep,
      '--apply',
    ]);
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /Nothing to backfill/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session-summary — refuses with no content (exit 2)', () => {
  const r = run(['scripts/session-summary.js']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /Nothing to record/);
});

// --- thin gated runner: CI safety net (IMPROVEMENT-PLAN IP-2.6) ------------
// Proves BY CONSTRUCTION that no CI job can ever pass a gate: (a) the runner
// refuses gate decisions when stdin is not a TTY (and every CI stdin is a
// pipe), (b) it refuses gate-deciding flags outright, and (c) no workflow
// invokes the runner at all.

test('run-pipeline — non-TTY gate refusal (no CI job can approve a gate)', () => {
  // Mini-repo INSIDE the project root so the spawned validator resolves ajv.
  const dir = mkdtempSync(join(process.cwd(), '.tmp-runner-'));
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'schemas'), { recursive: true });
    for (const f of [
      'run-pipeline.js',
      'pipeline-state.js',
      'gate-briefs.js',
      'validate-json.js',
      'track-floor.js',
      'red-domains.js',
    ]) {
      copyFileSync(join('scripts', f), join(dir, 'scripts', f));
    }
    copyFileSync(
      join('schemas', 'context.schema.json'),
      join(dir, 'schemas', 'context.schema.json')
    );
    // A context sitting at Gate 1.
    writeFileSync(
      join(dir, 'context.json'),
      readFileSync(
        'examples/expected/login-success.expected-context.json',
        'utf8'
      ).replace(
        /"requirements_reviewed": true/,
        '"requirements_reviewed": false'
      )
    );
    const r = spawnSync('node', ['scripts/run-pipeline.js'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.notEqual(r.status, 0, 'gate with piped stdin must exit non-zero');
    assert.match(
      (r.stdout || '') + (r.stderr || ''),
      /GATE PENDING: requirements_reviewed/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run-pipeline — gate-deciding flags are refused (exit 2)', () => {
  const r = run(['scripts/run-pipeline.js', '--approve']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /interactive-only/);
});

test('no CI workflow invokes the pipeline runner', () => {
  for (const f of readdirSync('.github/workflows')) {
    const body = readFileSync(join('.github/workflows', f), 'utf8');
    assert.ok(
      !/run-pipeline|npm run pipeline\b/.test(body),
      `${f} must never invoke the runner — gates are human, local, TTY-only`
    );
  }
});

// --- demo pipeline (IMPROVEMENT-PLAN Phase 3) -----------------------------

test('demo:pipeline --dry-run lists stages and touches no network', () => {
  const r = run(['scripts/demo-pipeline.js', '--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /stage plan/i);
  // The four gates and the two REAL stages are all named.
  for (const s of ['gate1', 'gate4', 'execute', 'classify']) {
    assert.match(r.out, new RegExp(s));
  }
  assert.match(r.out, /no workspace created, no server started, no network/i);
});

test('metrics skips DEMO_RUN-sentinel runs (IP-3.3)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiqa-demo-metrics-'));
  try {
    // One real archived run + one demo run under the same story.
    const real = join(dir, 'runs', 'STORY-9', 'r1');
    const demo = join(dir, 'runs', 'STORY-9', 'd1');
    mkdirSync(real, { recursive: true });
    mkdirSync(demo, { recursive: true });
    const ctx = JSON.parse(
      readFileSync(
        'examples/expected/login-success.expected-context.json',
        'utf8'
      )
    );
    writeFileSync(join(real, 'context.json'), JSON.stringify(ctx));
    writeFileSync(join(demo, 'context.json'), JSON.stringify(ctx));
    // The sentinel that marks the demo run.
    writeFileSync(join(demo, 'DEMO_RUN'), 'demo');

    const metricsAbs = join(process.cwd(), 'scripts', 'pipeline-metrics.js');
    const r = spawnSync('node', [metricsAbs, '--dry-run'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
    // Only the one real run is counted; the demo run is skipped.
    assert.match(r.stdout, /Runs analyzed \(from runs\/\): \*\*1\*\*/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
