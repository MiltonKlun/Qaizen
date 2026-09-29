// API-only and mixed scopes (task group 7.1).
//
// The real runner drives each run; Newman runs for real against an offline
// stand-in API (test/fixtures/fake-api-server.js). Gates are recorded with the
// same binding the runner uses at a human decision (test/helpers), never
// through the runner: agents and CI never approve a gate.
//
// Acceptance (IMPLEMENTATION_PLAN 7.1): API-only runs traverse their own human
// reviews and complete with real Newman evidence, without E2E artifacts or
// borrowed approvals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { execPath } from 'node:process';

import {
  bindGate,
  scopeCases,
  writeCompletedRun,
} from './helpers/valid-run.js';

const REPO = process.cwd();
const STORY = 'SK-40';
const RUN = 'run-api-1';
const COLLECTION = readFileSync(
  join(REPO, 'examples/expected/api-create-user.expected-collection.json'),
  'utf8'
);
const COL_PATH = `api-tests/collections/${STORY}.postman_collection.json`;
const ENV_PATH = `api-tests/environments/${STORY}.postman_environment.json`;

// ------------------------------------------------------------ fixtures

function write(dir, rel, content) {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), content);
}
const ctxPath = (dir) => join(dir, 'context.json');
const readCtx = (dir) => JSON.parse(readFileSync(ctxPath(dir), 'utf8'));
const writeCtx = (dir, ctx) =>
  writeFileSync(ctxPath(dir), JSON.stringify(ctx, null, 2));

/**
 * A run approved through Gate 2 whose approved cases decide the branches.
 * `cases`: [automation_decision, status] per test case (TC-001, TC-002, TC-004).
 * E2E artifacts, gates and reports are removed unless `e2e` is kept.
 */
function run(cases, { keepE2E = false } = {}) {
  const dir = mkdtempSync(join(REPO, '.tmp-runner-api-'));
  for (const d of ['scripts', 'schemas'])
    cpSync(join(REPO, d), join(dir, d), { recursive: true });
  const tc = scopeCases(STORY, RUN);
  cases.forEach(([decision, status], i) => {
    tc.test_cases[i].automation_decision = decision;
    tc.test_cases[i].status = status;
  });
  writeCompletedRun(
    dir,
    { storyId: STORY, runId: RUN, status: 'in_progress' },
    {
      [`test-cases/${STORY}.json`]: JSON.stringify(tc),
      'reports/results.json': null,
      'analysis/execution-ledger.json': null,
      'analysis/failure-analysis.json': null,
      'release/release-report.json': null,
      'release/release-report.md': null,
      ...(keepE2E
        ? {}
        : { [`specs/${STORY}.md`]: null, [`tests/${STORY}.spec.ts`]: null }),
    }
  );
  const ctx = readCtx(dir);
  for (const k of [
    'execution_results',
    'failure_analysis',
    'release_report_md',
    'release_report_json',
    'execution_ledger',
  ]) {
    ctx.artifact_paths[k] = '';
  }
  if (!keepE2E) {
    ctx.artifact_paths.playwright_spec = '';
    ctx.artifact_paths.generated_test = '';
    ctx.review_gates.specs_reviewed = false;
    ctx.review_gates.code_reviewed = false;
  }
  writeCtx(dir, ctx);
  return dir;
}

function withCollection(dir, baseUrl = 'http://127.0.0.1:9') {
  write(dir, COL_PATH, COLLECTION);
  write(
    dir,
    ENV_PATH,
    JSON.stringify({
      name: STORY,
      values: [{ key: 'base_url', value: baseUrl, enabled: true }],
    })
  );
}

function approveApi(
  dir,
  gates = ['collection_reviewed', 'api_assertions_reviewed']
) {
  let ctx = readCtx(dir);
  for (const g of gates) ctx = bindGate(ctx, g, dir);
  writeCtx(dir, ctx);
}

function pipeline(dir, args, env = {}) {
  const r = spawnSync(execPath, ['scripts/run-pipeline.js', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      REQRES_API_KEY: '',
      QAIZEN_EXECUTION_ID: '',
      ...env,
    },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

async function apiServer() {
  const child = spawn(execPath, [
    join(REPO, 'test', 'fixtures', 'fake-api-server.js'),
  ]);
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', (b) => {
      const m = String(b).match(/PORT (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on('error', reject);
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

/** A fake `npx` whose Playwright run writes a failing report. */
function failingPlaywright(dir) {
  const report = readFileSync(
    join(REPO, 'test', 'fixtures', 'playwright-all-outcomes.json'),
    'utf8'
  );
  const bin = join(dir, '.fakebin');
  mkdirSync(bin, { recursive: true });
  const js = join(bin, 'fake-npx.mjs');
  writeFileSync(
    js,
    `import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
appendFileSync('launches.log', 'playwright\\n');
mkdirSync('reports', { recursive: true });
writeFileSync('reports/results.json', ${JSON.stringify(report)});
process.exit(1);
`
  );
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\nexec node "${js}" "$@"\n`);
  chmodSync(join(bin, 'npx'), 0o755);
  writeFileSync(join(bin, 'npx.cmd'), `@echo off\r\nnode "${js}" %*\r\n`);
  return { PATH: `${bin}${delimiter}${process.env.PATH}` };
}

const newmanReports = (dir) => {
  const reports = join(dir, 'reports');
  if (!existsSync(reports)) return [];
  return readdirSync(reports).filter((d) =>
    existsSync(join(reports, d, 'newman', STORY))
  );
};

// ------------------------------------------------------------ sequencing

test('API-only: its own reviews in order, no E2E step, no borrowed approval', () => {
  const dir = run([
    ['automate_api', 'approved'],
    ['automate_api', 'approved'],
    ['manual', 'rejected'],
  ]);
  try {
    const step = () =>
      pipeline(dir, ['--status']).out.match(/Next step: (\S+)/)[1];
    assert.equal(step(), 'api');
    withCollection(dir);
    assert.equal(step(), 'gate3-api');
    // An E2E approval is never taken for an API one.
    const ctx = readCtx(dir);
    ctx.review_gates.specs_reviewed = { status: true, reviewer: 'h' };
    writeCtx(dir, ctx);
    assert.equal(step(), 'gate3-api');
    approveApi(dir, ['collection_reviewed']);
    assert.equal(step(), 'gate4-api');
    approveApi(dir, ['api_assertions_reviewed']);
    assert.equal(step(), 'execute-api');
    assert.equal(
      existsSync(join(dir, 'tests', `${STORY}.spec.ts`)),
      false,
      'no E2E placeholder was needed'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('draft or rejected cases activate nothing; no approved case has nothing to run', () => {
  const dir = run([
    ['automate_api', 'rejected'],
    ['automate_api', 'rejected'],
    ['manual', 'rejected'],
  ]);
  try {
    const r = pipeline(dir, ['--resume']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /NO-EXECUTABLE-SCOPE/);
    assert.match(r.out, /has no approved test case/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the two API approvals go stale independently', () => {
  const dir = run([
    ['automate_api', 'approved'],
    ['automate_api', 'approved'],
    ['manual', 'rejected'],
  ]);
  try {
    withCollection(dir);
    approveApi(dir);
    const col = JSON.parse(COLLECTION);

    // An assertion change: only Gate 4' is stale.
    col.item[0].event[0].script.exec[1] = '  pm.response.to.have.status(200);';
    write(dir, COL_PATH, JSON.stringify(col));
    let out = pipeline(dir, ['--status']).out;
    assert.match(out, /Stale approval: api_assertions_reviewed/);
    assert.doesNotMatch(out, /Stale approval: collection_reviewed/);

    // A request change: Gate 3' is stale too.
    col.item[0].request.url = '{{base_url}}/people';
    write(dir, COL_PATH, JSON.stringify(col));
    out = pipeline(dir, ['--status']).out;
    assert.match(out, /Stale approval: collection_reviewed/);
    assert.match(out, /Stale approval: api_assertions_reviewed/);

    // An environment VALUE (e.g. a secret or the base URL) binds nothing.
    write(dir, COL_PATH, COLLECTION);
    approveApi(dir);
    write(
      dir,
      ENV_PATH,
      JSON.stringify({
        values: [{ key: 'base_url', value: 'http://elsewhere', enabled: true }],
      })
    );
    assert.doesNotMatch(pipeline(dir, ['--status']).out, /Stale approval/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ execution

test('API-only run: the runner executes Newman and classifies without a Playwright report', async () => {
  const dir = run([
    ['automate_api', 'approved'],
    ['automate_api', 'approved'],
    ['manual', 'rejected'],
  ]);
  const api = await apiServer();
  try {
    withCollection(dir, api.url);
    approveApi(dir);
    const r = pipeline(dir, ['--resume']);
    assert.match(r.out, /Executing: node scripts\/run-newman\.js SK-40/, r.out);
    assert.match(r.out, /Next step: FINALIZE/, r.out);
    assert.equal(newmanReports(dir).length, 1);
    assert.match(newmanReports(dir)[0], /^exec-/);

    const ledger = JSON.parse(
      readFileSync(join(dir, 'analysis', 'execution-ledger.json'), 'utf8')
    );
    assert.deepEqual(
      ledger.source_executions.map((e) => e.runner),
      ['newman']
    );
    assert.ok(ledger.units.length >= 2);
    assert.equal(
      existsSync(join(dir, 'reports', 'results.json')),
      false,
      'no Playwright report was needed'
    );
    const ctx = readCtx(dir);
    assert.equal(ctx.artifact_paths.api_collection, COL_PATH);
    assert.equal(ctx.artifact_paths.generated_test, '');
  } finally {
    api.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mixed scope: a failing Playwright suite is data, then Newman runs, then both are classified', async () => {
  const dir = run(
    [
      ['automate_e2e', 'approved'],
      ['automate_api', 'approved'],
      ['manual', 'rejected'],
    ],
    { keepE2E: true }
  );
  const api = await apiServer();
  try {
    withCollection(dir, api.url);
    approveApi(dir);
    const r = pipeline(dir, ['--resume'], failingPlaywright(dir));
    assert.match(
      r.out,
      /suite exited 1 with a valid report: failures are data/,
      r.out
    );
    assert.match(r.out, /Executing: node scripts\/run-newman\.js/);
    assert.ok(
      r.out.indexOf('failures are data') < r.out.indexOf('run-newman.js'),
      'Playwright first'
    );
    assert.match(r.out, /Next step: FINALIZE/, r.out);
    const ledger = JSON.parse(
      readFileSync(join(dir, 'analysis', 'execution-ledger.json'), 'utf8')
    );
    assert.deepEqual(ledger.source_executions.map((e) => e.runner).sort(), [
      'newman',
      'playwright',
    ]);
  } finally {
    api.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mixed scope does not execute either suite until every branch is reviewed', () => {
  const dir = run(
    [
      ['automate_e2e', 'approved'],
      ['automate_api', 'approved'],
      ['manual', 'rejected'],
    ],
    { keepE2E: true }
  );
  try {
    withCollection(dir);
    const env = failingPlaywright(dir);
    const r = pipeline(dir, ['--resume'], env);
    assert.match(r.out, /GATE PENDING: collection_reviewed/, r.out);
    assert.equal(
      existsSync(join(dir, 'launches.log')),
      false,
      'Playwright did not run'
    );
    assert.deepEqual(newmanReports(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run-newman: the live story needs its API approvals; a repository check is never run evidence', async () => {
  const dir = run([
    ['automate_api', 'approved'],
    ['automate_api', 'approved'],
    ['manual', 'rejected'],
  ]);
  const api = await apiServer();
  try {
    withCollection(dir, api.url);
    const newman = (args) =>
      spawnSync(execPath, ['scripts/run-newman.js', STORY, ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, REQRES_API_KEY: '', QAIZEN_EXECUTION_ID: '' },
      });
    const refused = newman([]);
    assert.equal(refused.status, 2, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /collection_reviewed is not approved/);
    assert.deepEqual(newmanReports(dir), []);

    const check = newman(['--repository-check']);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /no human-approved release provenance/);
    assert.match(newmanReports(dir)[0], /^repo-/);

    // The repository check is not the run's evidence, even once approved.
    approveApi(dir);
    assert.match(pipeline(dir, ['--status']).out, /Next step: execute-api/);
  } finally {
    api.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
