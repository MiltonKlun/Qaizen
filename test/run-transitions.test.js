// Regression tests for validated transitions (task group 4.2, findings I6/B4).
//
// I6, reproduced with the committed runner: a valid, approved context whose
// test cases, execution results, failure analysis and release report were all
// `{}` made `--resume` exit 0 with "Run complete: release report produced,
// all gates passed". Every "produced" check was file EXISTENCE.
//
// B4: the execute step ignored the test runner's result. When the runner could
// not start or wrote no report, the state machine asked for `execute` again,
// forever (the review saw nine launches in 1.6 s).
//
// The executor is replaced by a fake `npx` first on PATH (a POSIX script and a
// .cmd, so this runs on Windows locally and Linux in CI). It counts its own
// launches and behaves on demand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';

import { runContext, writeCompletedRun } from './helpers/valid-run.js';
import { progressGuard } from '../scripts/run-pipeline.js';

const REPO = process.cwd();
const PW_REPORT = readFileSync(
  join(REPO, 'test', 'fixtures', 'playwright-all-outcomes.json'),
  'utf8'
);

function repo(prefix = '.tmp-runner-tx-') {
  const dir = mkdtempSync(join(REPO, prefix));
  cpSync(join(REPO, 'scripts'), join(dir, 'scripts'), { recursive: true });
  cpSync(join(REPO, 'schemas'), join(dir, 'schemas'), { recursive: true });
  return dir;
}

function write(dir, rel, content) {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

/**
 * Install a fake `npx` that records each launch in launches.log and then,
 * depending on `mode`: writes nothing, writes `{}`, or writes a valid
 * (failing) Playwright report -- exiting 1 in every case, like a failing run.
 */
function fakeNpx(dir, mode) {
  const bin = join(dir, '.fakebin');
  mkdirSync(bin, { recursive: true });
  const js = join(bin, 'fake-npx.mjs');
  writeFileSync(
    js,
    `import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
appendFileSync('launches.log', 'launch\\n');
const mode = ${JSON.stringify(mode)};
mkdirSync('reports', { recursive: true });
if (mode === 'empty-report') writeFileSync('reports/results.json', '{}');
if (mode === 'valid-report') writeFileSync('reports/results.json', ${JSON.stringify(PW_REPORT)});
process.exit(1);
`
  );
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\nexec node "${js}" "$@"\n`);
  chmodSync(join(bin, 'npx'), 0o755);
  writeFileSync(join(bin, 'npx.cmd'), `@echo off\r\nnode "${js}" %*\r\n`);
  return { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
}

function pipeline(dir, args = [], env = process.env) {
  const r = spawnSync('node', ['scripts/run-pipeline.js', ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const launches = (dir) =>
  existsSync(join(dir, 'launches.log'))
    ? readFileSync(join(dir, 'launches.log'), 'utf8').trim().split('\n').length
    : 0;

/** A run approved through Gate 4 that has not executed yet. */
function readyToExecute(dir) {
  writeCompletedRun(
    dir,
    { status: 'in_progress' },
    {
      'reports/results.json': null,
      'analysis/failure-analysis.json': null,
      'analysis/execution-ledger.json': null,
      'release/release-report.json': null,
    }
  );
  const ctx = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'));
  ctx.artifact_paths.execution_results = '';
  ctx.artifact_paths.failure_analysis = '';
  ctx.artifact_paths.release_report_json = '';
  writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
}

// ------------------------------------------------------------------- I6 ---

test('I6: `{}` artifacts are never "produced", so the run is not complete', () => {
  const dir = repo();
  try {
    writeCompletedRun(
      dir,
      { status: 'in_progress' },
      {
        'test-cases/OLD-1.json': '{}',
        'analysis/failure-analysis.json': '{}',
        'release/release-report.json': '{}',
        'reports/results.json': '{}',
      }
    );
    const before = readFileSync(join(dir, 'context.json'), 'utf8');
    const r = pipeline(dir, ['--resume']);
    assert.doesNotMatch(r.out, /complete/i, r.out);
    for (const key of [
      'test_cases',
      'execution_results',
      'failure_analysis',
      'release_report_json',
    ]) {
      assert.match(r.out, new RegExp(`${key}: `), `${key} must be named`);
    }
    assert.match(r.out, /Next step: TEST-DESIGNER/);
    assert.equal(readFileSync(join(dir, 'context.json'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an artifact from another story or run does not count', () => {
  for (const [field, value, expected] of [
    ['story_id', 'OTHER-9', /belongs to story OTHER-9/],
    ['run_id', 'someone-elses-run', /belongs to run someone-elses-run/],
  ]) {
    const dir = repo();
    try {
      writeCompletedRun(dir);
      const p = join(dir, 'release', 'release-report.json');
      writeFileSync(
        p,
        JSON.stringify({
          ...JSON.parse(readFileSync(p, 'utf8')),
          [field]: value,
        })
      );
      const r = pipeline(dir, ['--resume']);
      assert.match(r.out, expected, r.out);
      assert.match(r.out, /Next step: REPORT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('an invalid context.json stops the runner before any step', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    const ctx = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'));
    delete ctx.acceptance_criteria;
    writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx));
    const r = pipeline(dir, ['--resume']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /context\.json does not validate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------- gate inputs ---

test('a gate does not prompt when an input it reviews is invalid', () => {
  // The state machine already routes an invalid test-cases file back to the
  // Test Designer, so it never reaches a gate. The gate check is the backstop
  // for inputs the state machine does NOT track: Gate 2 reviews the planner
  // brief, which nothing validated before this.
  const dir = repo();
  try {
    writeCompletedRun(
      dir,
      { status: 'in_progress' },
      {
        'planner-input/OLD-1.planner-brief.md': '   \n',
      }
    );
    const ctx = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'));
    // Positioned at Gate 2.
    ctx.review_gates.test_scope_reviewed = false;
    ctx.review_gates.specs_reviewed = false;
    ctx.review_gates.code_reviewed = false;
    writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
    const before = readFileSync(join(dir, 'context.json'), 'utf8');

    const r = pipeline(dir, ['--resume']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /cannot be reviewed yet/);
    assert.match(r.out, /planner_brief .*is empty/);
    assert.doesNotMatch(r.out, /GATE PENDING|Decision/);
    assert.equal(readFileSync(join(dir, 'context.json'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- execute (B4)

test('B4: a runner that produces no report stops after ONE launch', () => {
  const dir = repo();
  try {
    readyToExecute(dir);
    const r = pipeline(dir, ['--resume'], fakeNpx(dir, 'no-report'));
    assert.equal(r.code, 2, r.out);
    assert.equal(launches(dir), 1, 'exactly one launch');
    assert.match(r.out, /execution\/startup error/);
    assert.match(r.out, /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a `{}` report is a startup/report error, not a failing suite', () => {
  const dir = repo();
  try {
    readyToExecute(dir);
    const r = pipeline(dir, ['--resume'], fakeNpx(dir, 'empty-report'));
    assert.equal(r.code, 2, r.out);
    assert.equal(launches(dir), 1);
    assert.match(r.out, /not a Playwright JSON report/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing suite WITH a valid report is data: it proceeds to classification', () => {
  const dir = repo();
  try {
    readyToExecute(dir);
    const r = pipeline(dir, ['--resume'], fakeNpx(dir, 'valid-report'));
    assert.equal(launches(dir), 1, r.out);
    assert.match(r.out, /failures are data; continuing to classification/);
    // The classifier wrote a DRAFT; the next step finalizes it, not "done".
    assert.match(r.out, /Next step: FINALIZE/, r.out);
    assert.doesNotMatch(r.out, /Pipeline complete/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale report (older than the test it ran) is not accepted', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    const old = new Date('2026-09-01T00:00:00Z');
    utimesSync(join(dir, 'reports', 'results.json'), old, old);
    const r = pipeline(dir, ['--status']);
    assert.match(r.out, /is stale/);
    assert.match(r.out, /Next step: execute/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------- completion ---

test('a valid run completes, is marked completed, and says it is not a release verdict', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir, { status: 'in_progress' });
    const r = pipeline(dir, ['--resume']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Pipeline complete/);
    assert.match(r.out, /"Pipeline complete" is not "release passed"/);
    const ctx = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'));
    assert.equal(ctx.status, 'completed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resuming a completed run again changes nothing', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    pipeline(dir, ['--resume']);
    const before = readFileSync(join(dir, 'context.json'), 'utf8');
    const r = pipeline(dir, ['--resume']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Pipeline complete/);
    assert.equal(readFileSync(join(dir, 'context.json'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a DRAFT failure analysis is finalized before the Reporter step', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    const p = join(dir, 'analysis', 'failure-analysis.json');
    writeFileSync(
      p,
      JSON.stringify({
        ...JSON.parse(readFileSync(p, 'utf8')),
        status: 'draft',
      })
    );
    const r = pipeline(dir, ['--resume']);
    assert.match(r.out, /Next step: FINALIZE/);
    assert.doesNotMatch(r.out, /Pipeline complete/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Red failure whose bug draft is missing blocks completion', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    const p = join(dir, 'analysis', 'failure-analysis.json');
    const fa = JSON.parse(readFileSync(p, 'utf8'));
    fa.failures = [
      {
        failure_id: 'FAIL-001',
        unit_id: 'pw:chromium:x',
        execution_outcome: 'failed',
        runner_identity: { kind: 'playwright', test_title: 'x' },
        test_case_id: 'TC-001',
        source: 'playwright',
        playwright_test_id: 'PW-001',
        classification: 'product_bug',
        severity: 'red',
        classification_reason: 'observed $1.00 where $100.00 was required',
        error_message: 'x',
        evidence_paths: ['analysis/execution-ledger.json'],
        bug_draft_path: 'release/bug-drafts/BUG-001.md',
      },
    ];
    writeFileSync(p, JSON.stringify(fa));
    const r = pipeline(dir, ['--resume']);
    assert.match(r.out, /no bug draft on disk for Red failure\(s\) FAIL-001/);
    assert.match(r.out, /Next step: FINALIZE/);

    write(dir, 'release/bug-drafts/BUG-001.md', '# BUG-001\n');
    assert.match(pipeline(dir, ['--resume']).out, /Pipeline complete/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an API story is not complete until its Newman branch ran', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir, { status: 'in_progress' });
    const p = join(dir, 'test-cases', 'OLD-1.json');
    const tc = JSON.parse(readFileSync(p, 'utf8'));
    tc.test_cases[0].automation_decision = 'automate_api';
    writeFileSync(p, JSON.stringify(tc));
    write(dir, 'api-tests/collections/OLD-1.postman_collection.json', '{}');
    const r = pipeline(dir, ['--status']);
    assert.match(r.out, /Next step: execute-api/, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--status reports invalid artifacts and never writes', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir, {}, { 'release/release-report.json': '{}' });
    const before = readFileSync(join(dir, 'context.json'), 'utf8');
    const r = pipeline(dir, ['--status']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Not accepted: release_report_json/);
    assert.equal(readFileSync(join(dir, 'context.json'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------- progress guard --

test('the progress guard refuses the same step on unchanged state', () => {
  const guard = progressGuard();
  const ctx = runContext();
  assert.equal(guard('execute', { a: 1 }, ctx), false, 'first time is fine');
  assert.equal(guard('execute', { a: 1 }, ctx), true, 'exact repeat is caught');
  assert.equal(
    guard('execute', { a: 2 }, ctx),
    false,
    'changed hints are progress'
  );
  assert.equal(
    guard('classify', { a: 2 }, ctx),
    false,
    'a new step is progress'
  );
});
