// The offline demo (npm run demo:pipeline) end to end, against the real
// runner, the real Playwright run and the real pre-classifier.
//
// The demo's gates and case decisions are interactive and stay that way. To
// prove the demo still completes under the current contracts, this test
// replays the demo's stages exactly as scripts/demo-pipeline.js does
// (scripts/lib/demo-stages.js) and records the decisions itself, test-style,
// in a throwaway workspace. That is not a demo path: the demo has no
// non-interactive approval and refuses to start without a terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { execPath } from 'node:process';

import { removeTempDir } from './helpers/cleanup.js';
import {
  DEMO_FIXTURES,
  draftCases,
  recordCaseDecisions,
  replayStage,
  startWorkspace,
} from '../scripts/lib/demo-stages.js';
import { GATE_KEYS } from '../scripts/pipeline-state.js';
import { bindingFor } from '../scripts/lib/approval-binding.js';
import { listGateRecords } from '../scripts/lib/gate-records.js';
import { recordGateDecision } from '../scripts/run-pipeline.js';
import { releaseExecutionSummary } from '../scripts/lib/execution-ledger.js';

const REPO = process.cwd();
const RUNNER = join(REPO, 'scripts', 'run-pipeline.js');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

async function browserInstalled() {
  try {
    const { chromium } = await import('@playwright/test');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/** A throwaway workspace seeded the way the demo seeds its own. */
function workspace() {
  const ws = mkdtempSync(join(REPO, 'runs', 'demo-test-'));
  const dirs = { fixtures: DEMO_FIXTURES, workspace: ws };
  startWorkspace(dirs);
  return dirs;
}

test('the demo fixtures stay inside the four E2E gates: every case is automate_e2e', () => {
  const tc = readJson(join(DEMO_FIXTURES, 'test-cases', 'DEMO-1.json'));
  assert.deepEqual(
    tc.test_cases.map((c) => [c.test_case_id, c.automation_decision]),
    [
      ['TC-001', 'automate_e2e'],
      ['TC-002', 'automate_e2e'],
    ]
  );
});

test('every draft case needs a decision before Gate 2', (t) => {
  const dirs = workspace();
  t.after(() => removeTempDir(dirs.workspace));
  replayStage('test-designer', dirs);
  assert.deepEqual(
    draftCases(dirs.workspace).map((c) => c.test_case_id),
    ['TC-001', 'TC-002']
  );
  assert.throws(
    () => recordCaseDecisions(dirs.workspace, { 'TC-001': 'approved' }),
    /no decision for draft case TC-002/
  );
  recordCaseDecisions(dirs.workspace, {
    'TC-001': 'approved',
    'TC-002': 'rejected',
  });
  assert.deepEqual(draftCases(dirs.workspace), []);
});

test('the Failure Classifier replay refuses an analysis that is not the planted bug', (t) => {
  const dirs = workspace();
  t.after(() => removeTempDir(dirs.workspace));
  const p = join(dirs.workspace, 'analysis', 'failure-analysis.json');
  const analysis = {
    failures: [
      {
        failure_id: 'FAIL-001',
        classification: 'locator_drift',
        severity: 'green',
        test_case_id: 'TC-002',
      },
    ],
    status: 'draft',
  };
  mkdirSync(join(dirs.workspace, 'analysis'));
  writeFileSync(p, JSON.stringify(analysis));
  assert.throws(
    () => replayStage('finalize', dirs),
    /exactly one Red product_bug on TC-002.*FAIL-001 locator_drift\/green/
  );
  assert.equal(readJson(p).status, 'draft');
  assert.equal(
    existsSync(join(dirs.workspace, 'release', 'bug-drafts', 'BUG-001.md')),
    false
  );
});

test('the demo completes: real run, finalized Red analysis, BUG-001, a 2.0 report from the ledger', async (t) => {
  if (!(await browserInstalled())) {
    t.skip(
      'no Playwright browser installed (CI quality job); run locally for the real acceptance'
    );
    return;
  }
  const dirs = workspace();
  const ws = dirs.workspace;
  const server = spawn(execPath, [join(DEMO_FIXTURES, 'serve.js')]);
  t.after(() => {
    server.kill();
    removeTempDir(ws);
  });
  const port = await new Promise((resolve, reject) => {
    server.stdout.on('data', (b) => {
      const m = String(b).match(/PORT (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  const env = {
    ...process.env,
    BASE_URL: `http://127.0.0.1:${port}`,
    PIPELINE_PW_CONFIG: join(DEMO_FIXTURES, 'playwright.demo.config.ts'),
  };
  const run = (arg) =>
    spawnSync(execPath, [RUNNER, arg], {
      cwd: ws,
      encoding: 'utf8',
      env,
      input: '',
    });
  const ctxPath = join(ws, 'context.json');

  const visited = [];
  for (let i = 0; i < 30; i++) {
    const status = run('--status').stdout;
    const step = /Next step:\s*(\S+)/.exec(status)?.[1];
    assert.ok(step, `no next step in:\n${status}`);
    if (step === 'done') break;
    assert.notEqual(step, visited.at(-1), `stuck at ${step}:\n${status}`);
    visited.push(step);
    const gate = GATE_KEYS[step];
    if (gate) {
      // The human's decisions, recorded test-style (see the header),
      // through the same recorder the gate prompt uses.
      const ctx = readJson(ctxPath);
      const now = new Date().toISOString();
      const recorded = recordGateDecision({
        root: ws,
        context: ctx,
        step,
        gateKey: gate,
        decision: 'approved',
        reviewer: 'test (not a human decision)',
        notes: null,
        openedAt: now,
        decidedAt: now,
        bindings: { [gate]: bindingFor(gate, ctx, ws) },
        brief: `brief for ${step}`,
      });
      assert.equal(recorded.ok, true, recorded.message);
      continue;
    }
    replayStage(step, dirs);
    // The human's case decisions, before the runner reaches Gate 2.
    if (draftCases(ws).length) {
      recordCaseDecisions(ws, { 'TC-001': 'approved', 'TC-002': 'approved' });
    }
    const r = run('--resume');
    assert.notEqual(r.status, 2, `${step}: ${r.stdout}${r.stderr}`);
  }
  assert.deepEqual(visited, [
    'gate1',
    'test-designer',
    'gate2',
    'planner',
    'gate3',
    'generator',
    'gate4',
    'execute',
    'finalize',
    'report',
  ]);

  const done = run('--resume');
  assert.equal(done.status, 0, done.stdout + done.stderr);

  const fa = readJson(join(ws, 'analysis', 'failure-analysis.json'));
  assert.equal(fa.status, 'finalized');
  assert.equal(fa.failures.length, 1);
  const [fail] = fa.failures;
  assert.equal(fail.failure_id, 'FAIL-001');
  assert.equal(fail.classification, 'product_bug');
  assert.equal(fail.severity, 'red');
  assert.equal(fail.test_case_id, 'TC-002');
  assert.equal(fail.playwright_test_id, 'PW-002');
  assert.equal(fail.bug_draft_path, 'release/bug-drafts/BUG-001.md');
  assert.ok(existsSync(join(ws, fail.bug_draft_path)));

  const report = readJson(join(ws, 'release', 'release-report.json'));
  const ledger = readJson(join(ws, fa.execution_ledger));
  assert.equal(report.schema_version, '2.0');
  assert.equal(report.run_id, readJson(ctxPath).run_id);
  assert.deepEqual(report.execution_summary, releaseExecutionSummary(ledger));
  assert.equal(report.execution_summary.passed, 1);
  assert.equal(report.execution_summary.failed, 1);
  assert.deepEqual(report.blocking_failures, ['FAIL-001']);
  assert.equal(report.release_recommendation, 'fail');
  assert.ok(existsSync(join(ws, 'release', 'release-report.md')));

  // Every decision left its record and a copy of what it reviewed.
  assert.deepEqual(
    listGateRecords(ws).map((g) => g.record),
    [
      'gates/001-gate1-approved.md',
      'gates/002-gate2-approved.md',
      'gates/003-gate3-approved.md',
      'gates/004-gate4-approved.md',
    ]
  );
  assert.ok(
    existsSync(join(ws, 'gates/002-gate2-approved/test-cases/DEMO-1.json'))
  );
  assert.ok(
    existsSync(join(ws, 'gates/003-gate3-approved/specs/DEMO-1.spec.md'))
  );
  assert.match(
    readFileSync(join(ws, 'gates/004-gate4-approved.md'), 'utf8'),
    /outside the run folder; digest only/
  );
});

test('the demo asks its questions in a prompt process: the reviewer once, then each case', (t) => {
  const dirs = workspace();
  t.after(() => removeTempDir(dirs.workspace));
  replayStage('test-designer', dirs);
  const ask = (args, input) =>
    spawnSync(
      execPath,
      [join(REPO, 'scripts', 'demo-pipeline.js'), '--ask', ...args],
      {
        input,
        encoding: 'utf8',
      }
    );

  const named = ask(['reviewer', 'Default Name'], '\n');
  assert.deepEqual(JSON.parse(named.stdout), { reviewer: 'Default Name' });
  const other = ask(['reviewer', 'Default Name'], 'Alex\n');
  assert.deepEqual(JSON.parse(other.stdout), { reviewer: 'Alex' });

  // An unclear answer is asked again; answers typed ahead are kept.
  const cases = ask(['cases', dirs.workspace], 'x\na\nr\n');
  assert.equal(cases.status, 0, cases.stderr);
  assert.deepEqual(JSON.parse(cases.stdout), {
    'TC-001': 'approved',
    'TC-002': 'rejected',
  });
  // No answer at all records nothing.
  const none = ask(['cases', dirs.workspace], '');
  assert.equal(none.status, 1);
  assert.equal(none.stdout, '');
  assert.equal(draftCases(dirs.workspace).length, 2, 'nothing was written');
});
