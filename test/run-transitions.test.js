// Regression tests for validated transitions.
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
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  bindGate,
  runContext,
  writeCompletedRun,
  validTestCases,
} from './helpers/valid-run.js';
import {
  applyDowngradeConfirmation,
  confirmAnswer,
  executionLine,
  progressGuard,
} from '../scripts/run-pipeline.js';
import { copyRuntimeConfig } from './helpers/runtime-config.js';

const REPO = process.cwd();
const PW_REPORT = readFileSync(
  join(REPO, 'test', 'fixtures', 'playwright-all-outcomes.json'),
  'utf8'
);

function repo(prefix = '.tmp-runner-tx-') {
  const dir = mkdtempSync(join(REPO, prefix));
  cpSync(join(REPO, 'scripts'), join(dir, 'scripts'), { recursive: true });
  cpSync(join(REPO, 'schemas'), join(dir, 'schemas'), { recursive: true });
  copyRuntimeConfig(dir, REPO);
  return dir;
}

function write(dir, rel, content) {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

/**
 * A stand-in Playwright CLI that records each launch in launches.log and then,
 * depending on `mode`: writes nothing, writes `{}`, or writes a valid
 * (failing) Playwright report -- exiting 1 in every case, like a failing run.
 * The runner starts Playwright's CLI directly under Node (no shell, no npx);
 * QAIZEN_PLAYWRIGHT_CLI points it here instead.
 */
function fakePlaywright(dir, mode) {
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
  return { ...process.env, QAIZEN_PLAYWRIGHT_CLI: js };
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

test('`{}` artifacts are never "produced", so the run is not complete', () => {
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

test('a runner that produces no report stops after ONE launch', () => {
  const dir = repo();
  try {
    readyToExecute(dir);
    const r = pipeline(dir, ['--resume'], fakePlaywright(dir, 'no-report'));
    assert.equal(r.code, 2, r.out);
    assert.equal(launches(dir), 1, 'exactly one launch');
    assert.match(r.out, /execution\/startup error/);
    assert.match(r.out, /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a report already on disk is not taken for this run’s when the runner writes none', () => {
  const dir = repo();
  try {
    readyToExecute(dir);
    write(
      dir,
      'reports/results.json',
      readFileSync(
        join(process.cwd(), 'test/fixtures/playwright-all-outcomes.json')
      )
    );
    const r = pipeline(dir, ['--resume'], fakePlaywright(dir, 'no-report'));
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /does not exist/);
    assert.doesNotMatch(r.out, /Recorded the execution/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a ledger from an earlier execution is re-classified, not reported on', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    // A new execution was recorded (after a re-approval, say): the ledger and
    // the analysis built from the old one no longer describe this evidence.
    const ctxPath = join(dir, 'context.json');
    const ctx = JSON.parse(readFileSync(ctxPath, 'utf8'));
    ctx.execution_identity.playwright.execution_id = 'exec-pw-new';
    writeFileSync(ctxPath, JSON.stringify(ctx, null, 2));
    const r = pipeline(dir, ['--status']);
    assert.match(
      r.out,
      /execution_ledger: was normalized from a different Playwright execution than the one recorded; re-classify/
    );
    assert.match(r.out, /Next step: classify/);
    assert.doesNotMatch(r.out, /Pipeline complete/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a `{}` report is a startup/report error, not a failing suite', () => {
  const dir = repo();
  try {
    readyToExecute(dir);
    const r = pipeline(dir, ['--resume'], fakePlaywright(dir, 'empty-report'));
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
    const r = pipeline(dir, ['--resume'], fakePlaywright(dir, 'valid-report'));
    assert.equal(launches(dir), 1, r.out);
    assert.match(r.out, /failures are data; continuing to classification/);
    // The classifier wrote a DRAFT; the next step finalizes it, not "done".
    assert.match(r.out, /Next step: FINALIZE/, r.out);
    assert.doesNotMatch(r.out, /Pipeline complete/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a report dropped in after execution, or run under another config, is not this run’s evidence', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    const reportPath = join(dir, 'reports', 'results.json');
    // An all-pass report written over the recorded one, with a fresh mtime:
    // the old file-time check would have accepted it.
    const allPass = JSON.parse(readFileSync(reportPath, 'utf8'));
    allPass.stats = { ...allPass.stats, unexpected: 0, flaky: 0 };
    writeFileSync(reportPath, JSON.stringify(allPass));
    let r = pipeline(dir, ['--status']);
    assert.match(
      r.out,
      /changed after the execute step recorded it \(digest mismatch\)/
    );
    assert.match(r.out, /Next step: execute/);

    // The recorded report, but the config it ran with has changed since.
    writeCompletedRun(dir);
    writeFileSync(join(dir, 'playwright.config.ts'), 'export default {};\n');
    r = pipeline(dir, ['--status']);
    assert.match(
      r.out,
      /was produced with playwright\.config\.ts, which has changed since/
    );
    // Gate 4 reviewed that config too, so the run goes back to Gate 4 first,
    // through the repeat check, which runs again on the changed inputs.
    assert.match(r.out, /Next step: repeat/);
    rmSync(join(dir, 'playwright.config.ts'));

    // A report with no recorded identity was not produced by this run's
    // execute step.
    writeCompletedRun(dir);
    const ctxPath = join(dir, 'context.json');
    const ctx = JSON.parse(readFileSync(ctxPath, 'utf8'));
    delete ctx.execution_identity;
    writeFileSync(ctxPath, JSON.stringify(ctx, null, 2));
    r = pipeline(dir, ['--status']);
    assert.match(r.out, /has no recorded execution identity/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the report step names the app build, and says when it is unknown', () => {
  const id = {
    execution_id: 'exec-pw-1',
    app_build: 'unknown',
    base_url: null,
  };
  assert.equal(
    executionLine(
      /** @type {any} */ ({ execution_identity: { playwright: id } })
    ),
    '  Evidence: exec-pw-1 · app build unknown (QAIZEN_APP_BUILD was not set at execution) · base URL not set\n'
  );
  const named = executionLine(
    /** @type {any} */ ({
      execution_identity: {
        playwright: {
          ...id,
          app_build: '2.4.1+88',
          base_url: 'https://shop.test',
        },
      },
    })
  );
  assert.ok(
    named.includes('app build 2.4.1+88 · base URL https://shop.test'),
    named
  );
  assert.equal(executionLine(/** @type {any} */ ({})), '');
});

test('PIPELINE_PW_CONFIG is refused outside the demo workspace', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    const ctxPath = join(dir, 'context.json');
    const ctx = JSON.parse(readFileSync(ctxPath, 'utf8'));
    delete ctx.execution_identity; // so the next step is execute
    writeFileSync(ctxPath, JSON.stringify(ctx, null, 2));
    const r = pipeline(dir, ['--resume'], {
      ...process.env,
      PIPELINE_PW_CONFIG: 'other.config.ts',
    });
    assert.equal(r.code, 2);
    assert.match(
      r.out,
      /PIPELINE_PW_CONFIG is honoured only in the demo workspace/
    );
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
    assert.match(
      r.out,
      /no bug draft with content on disk for Red failure\(s\) FAIL-001/
    );
    assert.match(r.out, /Next step: FINALIZE/);

    // An empty draft is not a report of a bug.
    write(dir, 'release/bug-drafts/BUG-001.md', '  \n');
    assert.match(
      pipeline(dir, ['--resume']).out,
      /no bug draft with content on disk for Red failure\(s\) FAIL-001/
    );

    write(dir, 'release/bug-drafts/BUG-001.md', '# BUG-001\n');
    // The report still says nothing blocks: the release rules refuse it.
    const hidden = pipeline(dir, ['--resume']).out;
    assert.match(
      hidden,
      /breaks the release rules: blocking failures are exactly the Red ones.*\(red FAIL-001\); every Red failure's bug draft is listed/
    );
    assert.doesNotMatch(hidden, /Pipeline complete/);

    const rp = join(dir, 'release', 'release-report.json');
    const report = JSON.parse(readFileSync(rp, 'utf8'));
    report.blocking_failures = ['FAIL-001'];
    report.bug_drafts = [
      {
        bug_id: 'BUG-001',
        severity: 'red',
        path: 'release/bug-drafts/BUG-001.md',
      },
    ];
    report.release_recommendation = 'fail';
    writeFileSync(rp, JSON.stringify(report));
    assert.match(pipeline(dir, ['--resume']).out, /Pipeline complete/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only the exact words confirm or quit a downgrade', () => {
  for (const a of ['c', 'C', ' confirm '])
    assert.equal(confirmAnswer(a), 'confirm', a);
  for (const a of ['q', 'quit']) assert.equal(confirmAnswer(a), 'quit', a);
  // An answer that merely starts with c or q asks again.
  for (const a of ['cancel', 'continue', "can't", 'quiet', 'yes', ''])
    assert.equal(confirmAnswer(a), null, a);
});

test('a finalized analysis that changes a severity without recording it stays at FINALIZE', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    const p = join(dir, 'analysis', 'failure-analysis.json');
    const fa = JSON.parse(readFileSync(p, 'utf8'));
    const failure = {
      failure_id: 'FAIL-001',
      unit_id: 'pw:chromium:x',
      execution_outcome: 'failed',
      runner_identity: { kind: 'playwright', test_title: 'x' },
      test_case_id: 'TC-002',
      source: 'playwright',
      playwright_test_id: 'PW-002',
      classification: 'product_bug',
      severity: 'red',
      classification_reason: 'observed $1.00 where $100.00 was required',
      error_message: 'x',
      evidence_paths: ['analysis/execution-ledger.json'],
    };
    // The rule-based draft calls it Red, exactly as the pre-classifier writes.
    const draft = { ...fa, failures: [failure], status: 'draft' };
    write(
      dir,
      'analysis/failure-analysis.draft.json',
      JSON.stringify(draft, null, 2) + '\n'
    );
    const sha256 = createHash('sha256')
      .update(readFileSync(join(dir, 'analysis/failure-analysis.draft.json')))
      .digest('hex');
    // The finalized analysis lowers it to Yellow, in place.
    const lowered = {
      ...fa,
      failures: [
        { ...failure, classification: 'test_bug', severity: 'yellow' },
      ],
      rule_draft: { path: 'analysis/failure-analysis.draft.json', sha256 },
      overrides: [],
    };
    writeFileSync(p, JSON.stringify(lowered));
    const rp = join(dir, 'release', 'release-report.json');
    const report = JSON.parse(readFileSync(rp, 'utf8'));
    writeFileSync(
      rp,
      JSON.stringify({ ...report, non_blocking_failures: ['FAIL-001'] })
    );

    const out = pipeline(dir, ['--resume']).out;
    assert.match(
      out,
      /failure_analysis: FAIL-001 classification changed from product_bug to test_bug with no override recording it/
    );
    assert.match(out, /Next step: FINALIZE/);
    assert.doesNotMatch(out, /Pipeline complete/);

    // Recorded, with a reason: the overrides are accepted, but a Red failure
    // lowered on the high-severity RISK-001 waits for a person to confirm it,
    // and a non-interactive run cannot.
    const because = 'the test asserts the old price list';
    lowered.overrides = [
      ['classification', 'product_bug', 'test_bug'],
      ['severity', 'red', 'yellow'],
    ].map(([field, from, to]) => ({
      failure_id: 'FAIL-001',
      field,
      from,
      to,
      reason: because,
    }));
    writeFileSync(p, JSON.stringify(lowered));
    const pending = pipeline(dir, ['--resume']).out;
    assert.match(
      pending,
      /FAIL-001: red -> yellow {2}\(a Red failure lowered; on high-severity RISK-001;/
    );
    assert.match(pending, new RegExp(`reason given: ${because}`));
    assert.match(pending, /DOWNGRADE CONFIRMATION PENDING/);
    assert.doesNotMatch(pending, /Pipeline complete/);

    // Confirmed for exactly these analysis bytes (as the runner records it at
    // the terminal): the run completes.
    const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
    const ctxPath = join(dir, 'context.json');
    const ctx = JSON.parse(readFileSync(ctxPath, 'utf8'));
    applyDowngradeConfirmation(
      ctx,
      [{ failure_id: 'FAIL-001', from: 'red', to: 'yellow', why: 'x' }],
      { reviewer: 'h', confirmedAt: '2026-11-02T10:00:00Z', sha256: sha }
    );
    writeFileSync(ctxPath, JSON.stringify(ctx, null, 2));
    assert.match(pipeline(dir, ['--resume']).out, /Pipeline complete/);

    // A later change to the analysis needs a new confirmation.
    writeFileSync(
      p,
      JSON.stringify({
        ...lowered,
        overrides: [...lowered.overrides].reverse(),
      })
    );
    assert.match(
      pipeline(dir, ['--resume']).out,
      /DOWNGRADE CONFIRMATION PENDING/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an API story is not complete until its Newman branch ran', () => {
  const dir = repo();
  try {
    // The API case is part of the APPROVED scope, so it is written before the
    // gates are bound (editing it afterwards would make Gate 2 stale).
    const tc = validTestCases('OLD-1', 'old-run-1');
    tc.test_cases[0].automation_decision = 'automate_api';
    writeCompletedRun(
      dir,
      { status: 'in_progress' },
      { 'test-cases/OLD-1.json': JSON.stringify(tc) }
    );
    // A valid collection that both API gates approved: only
    // the Newman execution is missing, so that is the next step.
    write(
      dir,
      'api-tests/collections/OLD-1.postman_collection.json',
      readFileSync(
        join(
          REPO,
          'examples/expected/api-create-user.expected-collection.json'
        ),
        'utf8'
      )
    );
    const p = join(dir, 'context.json');
    let ctx = JSON.parse(readFileSync(p, 'utf8'));
    ctx = bindGate(ctx, 'collection_reviewed', dir);
    ctx = bindGate(ctx, 'api_assertions_reviewed', dir);
    writeFileSync(p, JSON.stringify(ctx));
    const r = pipeline(dir, ['--status']);
    assert.match(r.out, /Next step: execute-api/, r.out);
    assert.match(r.out, /API: {4}G3' PASSED · G4' PASSED/);
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

/**
 * A stand-in Playwright CLI for the repeat check: it logs its arguments and
 * writes a JSON report where one test passes in some runs and fails in others
 * (or, with `stable`, passes in all of them).
 */
function fakeRepeat(dir, mode) {
  const bin = join(dir, '.fakebin');
  mkdirSync(bin, { recursive: true });
  const js = join(bin, 'fake-repeat.mjs');
  writeFileSync(
    js,
    `import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync('repeat-args.log', JSON.stringify(args) + '\\n');
const n = Number(args[args.indexOf('--repeat-each') + 1]);
const specs = Array.from({ length: n }, (_, i) => ({
  title: 'checkout [TC-001]',
  file: 'tests/OLD-1.spec.ts',
  line: 3,
  column: 1,
  tests: [{ projectName: '', status: ${JSON.stringify(mode)} === 'stable' || i % 2 === 0 ? 'expected' : 'unexpected' }],
}));
writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({ suites: [{ file: 'tests/OLD-1.spec.ts', specs }], errors: [] }));
process.exit(1);
`
  );
  return { ...process.env, QAIZEN_PLAYWRIGHT_CLI: js };
}

test('a flaky generated test stops the run before Gate 4, and Gate 4 will not open on it', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir, { status: 'in_progress' });
    const ctxPath = join(dir, 'context.json');
    const ctx = JSON.parse(readFileSync(ctxPath, 'utf8'));
    ctx.review_gates.code_reviewed = false;
    delete ctx.repeat_check;
    writeFileSync(ctxPath, JSON.stringify(ctx, null, 2));

    let r = pipeline(dir, ['--status']);
    assert.match(r.out, /Next step: repeat/);

    r = pipeline(dir, [], fakeRepeat(dir, 'flaky'));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /The generated test is flaky/);
    const args = JSON.parse(
      readFileSync(join(dir, 'repeat-args.log'), 'utf8').trim()
    );
    // The fixture's criteria are about login (security), so the story is
    // held to the full track: 20 runs.
    assert.deepEqual(
      args.slice(
        args.indexOf('--repeat-each'),
        args.indexOf('--repeat-each') + 2
      ),
      ['--repeat-each', '20']
    );
    assert.deepEqual(
      args.slice(args.indexOf('--workers'), args.indexOf('--workers') + 2),
      ['--workers', '2']
    );
    assert.deepEqual(
      args.slice(
        args.indexOf('--update-snapshots'),
        args.indexOf('--update-snapshots') + 2
      ),
      ['--update-snapshots', 'none']
    );
    const saved = JSON.parse(readFileSync(ctxPath, 'utf8')).repeat_check;
    assert.equal(saved.outcome, 'flaky');
    assert.equal(saved.units[0].passed, 10);
    assert.equal(saved.units[0].failed, 10);

    // The record is current, so the run is at Gate 4, which refuses it.
    r = pipeline(dir, ['--status']);
    assert.match(r.out, /Next step: gate4/);
    r = pipeline(dir, []);
    assert.equal(r.code, 2, r.out);
    assert.match(
      r.out,
      /repeat check: the generated test is flaky in the repeat check/
    );
    assert.doesNotMatch(r.out, /GATE PENDING/);

    // A stable re-run lets Gate 4 open (pending here: no terminal).
    r = pipeline(dir, ['--resume'], fakeRepeat(dir, 'stable'));
    assert.match(
      r.out,
      /GATE PENDING: code_reviewed|Next step: gate4|cannot be reviewed yet/
    );
    // Once the test is fixed (its digest changes), the check runs again; the
    // stable check replaces the flaky one and keeps a summary of it, so the
    // metrics still count the flaky check.
    const testPath = join(
      dir,
      JSON.parse(readFileSync(ctxPath, 'utf8')).artifact_paths.generated_test
    );
    writeFileSync(
      testPath,
      readFileSync(testPath, 'utf8') + '\n// fixed: no shared state\n'
    );
    r = pipeline(dir, ['--resume'], fakeRepeat(dir, 'stable'));
    const rerun = JSON.parse(readFileSync(ctxPath, 'utf8')).repeat_check;
    assert.equal(rerun.outcome, 'stable');
    assert.deepEqual(
      rerun.earlier.map((/** @type {any} */ e) => [
        e.outcome,
        e.units,
        e.flaky_units,
      ]),
      [['flaky', 1, 1]]
    );
    // The stable check made one more run to record the action targets (the
    // stand-in Playwright records none, and the record says so); the flaky
    // one made none.
    const launches = readFileSync(join(dir, 'repeat-args.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      launches.map((a) => a[a.indexOf('--repeat-each') + 1]),
      ['20', '20', '1']
    );
    assert.equal(rerun.targets_error, 'the recording run recorded no action');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run past Gate 4 never meets the repeat step', () => {
  const dir = repo();
  try {
    writeCompletedRun(dir);
    const r = pipeline(dir, ['--status']);
    assert.doesNotMatch(r.out, /Next step: repeat/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
