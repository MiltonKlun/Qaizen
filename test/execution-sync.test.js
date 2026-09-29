// Evidence-supported TestLink execution results (task group 5.3, finding I1).
//
// The real sync script runs in a throwaway workspace against a fake TestLink.
// Every ledger here is assembled by the real buildLedger and checked by the
// real readLedger, so no fixture can hold evidence the pipeline could not
// produce. No real service is contacted.
//
// Acceptance (IMPLEMENTATION_PLAN 5.3): a Pass always has complete positive
// execution evidence; array order cannot change the result; source artifacts
// remain unchanged by result reporting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { execPath } from 'node:process';

import { bindGate, runContext } from './helpers/valid-run.js';
import { buildLedger } from '../scripts/lib/build-ledger.js';
import {
  approvedScopeDigest,
  readLedger,
  testCaseOutcome,
} from '../scripts/lib/execution-ledger.js';
import { validateValue } from '../scripts/lib/artifact-io.js';

const REPO = process.cwd();
const STORY = 'SK-20';
const RUN = 'run-exec-1';
const DEVKEY = 'testlink-devkey-exec-7c6d';
const gold = (p) => JSON.parse(readFileSync(join(REPO, p), 'utf8'));

// ------------------------------------------------------------ fixtures

/**
 * Approved, TestLink-linked cases: TC-001/TC-002 E2E, TC-003 API, TC-004
 * manual, TC-005 intentionally skipped.
 */
function testCases() {
  const base = gold('examples/expected/login-success.expected-test-cases.json');
  const cases = base.test_cases.map((c) => ({ ...c, status: 'approved' }));
  const skip = {
    ...cases.find((c) => c.test_case_id === 'TC-004'),
    test_case_id: 'TC-005',
    title: 'Legacy copy check no longer relevant',
    automation_decision: 'skip',
    automation_decision_reason: 'Superseded by TC-002; kept for the record.',
  };
  const all = [...cases, skip].map((c, i) => {
    const tc = { ...c, testlink_id: String(101 + i) };
    delete tc.external_ids;
    delete tc.sync_state;
    return tc;
  });
  return { ...base, story_id: STORY, run_id: RUN, test_cases: all };
}

function workspace() {
  const dir = mkdtempSync(join(REPO, '.tmp-runner-exec-'));
  for (const d of ['scripts', 'schemas', 'config']) {
    cpSync(join(REPO, d), join(dir, d), { recursive: true });
  }
  mkdirSync(join(dir, 'test-cases'));
  mkdirSync(join(dir, 'analysis'));
  const doc = testCases();
  writeFileSync(
    join(dir, 'test-cases', `${STORY}.json`),
    JSON.stringify(doc, null, 2)
  );
  // The manual and skip cases have their own reviewed plan (task group 7.2);
  // TC-004's result was never recorded, so it stays Not Run.
  mkdirSync(join(dir, 'planner-input'));
  writeFileSync(
    join(dir, 'planner-input', `${STORY}.external-plan.json`),
    JSON.stringify(externalPlan())
  );
  let ctx = runContext({ storyId: STORY, runId: RUN, status: 'draft' });
  ctx = bindGate(ctx, 'test_scope_reviewed', dir);
  ctx = bindGate(ctx, 'code_reviewed', dir);
  ctx = bindGate(ctx, 'external_plan_reviewed', dir);
  ctx = bindGate(ctx, 'external_evidence_reviewed', dir);
  writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
  return { dir, doc };
}

function externalPlan() {
  return {
    schema_version: '1.0',
    document: 'external_plan',
    story_id: STORY,
    run_id: RUN,
    cases: [
      {
        test_case_id: 'TC-004',
        source: 'manual',
        procedure: 'Open the login page and review the error styling.',
        expected_outcome: 'The error is readable and on-brand.',
        evidence_required: ['a screenshot of the error state'],
      },
      {
        test_case_id: 'TC-005',
        source: 'skip',
        exclusion_reason: 'Superseded by TC-002.',
      },
    ],
  };
}

const EXEC = 'exec-pw-1';
function execution(overrides = {}) {
  return {
    execution_id: EXEC,
    runner: 'playwright',
    started_at: '2026-09-28T10:00:00.000Z',
    completed_at: '2026-09-28T10:02:00.000Z',
    command_identity: 'npx playwright test',
    config_identity: 'playwright.config.ts',
    process_status: 'completed',
    exit_code: 0,
    report_reference: `reports/${EXEC}/playwright/${STORY}.json`,
    report_digest: 'a'.repeat(64),
    source_errors: [],
    ...overrides,
  };
}

let unitSeq = 0;
/** A Playwright unit linked to `tc` (or unattributed when tc is null). */
function unit(tc, outcome, { project = 'chromium', attempts } = {}) {
  unitSeq += 1;
  const attemptsFor = {
    passed: [{ status: 'passed', duration_ms: 1000 }],
    failed: [{ status: 'failed', duration_ms: 1000, error_message: 'boom' }],
    flaky: [
      { status: 'failed', duration_ms: 1000, error_message: 'first try' },
      { status: 'passed', duration_ms: 900 },
    ],
    skipped: [{ status: 'skipped' }],
    not_run: [],
    blocked: [],
    expected_failure: [{ status: 'failed', duration_ms: 1000 }],
  };
  return {
    unit_id: `u-${unitSeq}`,
    execution_id: EXEC,
    identity: {
      kind: 'playwright',
      test_title: `${tc ?? 'orphan'} ${project} ${unitSeq}`,
      file: `e2e/${STORY}.spec.ts`,
      project,
      repeat_index: 0,
    },
    domain_links: tc
      ? {
          test_case_id: tc,
          playwright_test_id: `PW-${tc.slice(3)}`,
          unresolved_reason: null,
        }
      : {
          test_case_id: null,
          playwright_test_id: null,
          unresolved_reason: 'no TC id in the title',
        },
    outcome,
    attempts: attempts ?? attemptsFor[outcome],
  };
}

/** A real ledger through buildLedger, checked by readLedger. */
function writeLedger(dir, doc, units, { runId = RUN, scope, exec } = {}) {
  const { ledger } = buildLedger({
    runId,
    storyId: STORY,
    generatedAt: '2026-09-28T10:03:00.000Z',
    sourceExecutions: [execution(exec)],
    units,
    approvedCaseIds: doc.test_cases.map((c) => c.test_case_id),
    approvedScopeDigest: scope === undefined ? approvedScopeDigest(doc) : scope,
  });
  const path = join(dir, 'analysis', 'execution-ledger.json');
  writeFileSync(path, JSON.stringify(ledger, null, 2));
  const check = readLedger(path, { storyId: STORY, runId });
  assert.ok(
    check.ok,
    `fixture ledger must be valid: ${check.message} ${check.violations ?? ''}`
  );
  return ledger;
}

/** A finalized 2.0 analysis confirming product bugs on the given units. */
function writeAnalysis(
  dir,
  ledger,
  productBugUnits,
  { status = 'finalized' } = {}
) {
  const base = gold(
    'examples/expected/classification-evidence.expected-failure-analysis.json'
  );
  const failed = ledger.units.filter((u) => u.outcome === 'failed');
  const failures = failed.map((u, i) => {
    const bug = productBugUnits.includes(u.unit_id);
    return {
      failure_id: `FAIL-00${i + 1}`,
      unit_id: u.unit_id,
      execution_outcome: 'failed',
      runner_identity: u.identity,
      test_case_id: u.domain_links.test_case_id,
      playwright_test_id: u.domain_links.playwright_test_id,
      source: 'playwright',
      classification: bug ? 'product_bug' : 'test_bug',
      severity: bug ? 'red' : 'yellow',
      classification_reason: bug ? 'business assertion failed' : 'test defect',
      error_message: 'boom',
      evidence_paths: ['analysis/execution-ledger.json'],
      ...(bug
        ? { bug_draft_path: `release/bug-drafts/BUG-00${i + 1}.md` }
        : {}),
    };
  });
  const fa = {
    ...base,
    story_id: STORY,
    run_id: RUN,
    status,
    failures,
  };
  const valid = validateValue(
    fa,
    join(REPO, 'schemas/failure-analysis.schema.json')
  );
  return { fa, valid };
}

// ------------------------------------------------------------ running

function runCli(dir, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      execPath,
      [join('scripts', 'sync-testlink-execution.js'), STORY, ...args],
      {
        cwd: dir,
        env: {
          ...process.env,
          TEST_MANAGEMENT_TOOL: 'testlink',
          TESTLINK_URL: '',
          TESTLINK_API_KEY: '',
          TESTLINK_TEST_PLAN_ID: '',
          QAIZEN_HTTP_TIMEOUT_MS: '3000',
          ...env,
        },
      }
    );
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** { 'TC-001': 'Pass (p)', ... } from the printed plan. */
function planOf(out) {
  const plan = {};
  for (const m of out.matchAll(
    /^ {4}- (TC-\d+) \(TestLink \d+\): \w+ -> ([\w ]+ \([pfbn]\))/gm
  )) {
    plan[m[1]] = m[2];
  }
  return plan;
}

function fakeTestLink() {
  const reports = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const get = (name) =>
        (body.match(
          new RegExp(`<name>${name}</name><value><(?:string|int)>([^<]*)<`)
        ) || [])[1];
      reports.push({
        method: (body.match(/<methodName>([^<]+)</) || [])[1],
        testcaseid: get('testcaseid'),
        status: get('status'),
        notes: get('notes'),
      });
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(
        '<?xml version="1.0"?><methodResponse><params><param><value><array><data>' +
          '<value><struct><member><name>status</name><value><boolean>1</boolean></value></member></struct></value>' +
          '</data></array></value></param></params></methodResponse>'
      );
    });
  });
  return { server, reports };
}

function digestTree(dir) {
  const out = {};
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(join(dir, r)).isDirectory()) walk(r);
      else
        out[r] = createHash('sha256')
          .update(readFileSync(join(dir, r)))
          .digest('hex');
    }
  };
  for (const d of ['test-cases', 'analysis']) walk(d);
  out['context.json'] = createHash('sha256')
    .update(readFileSync(join(dir, 'context.json')))
    .digest('hex');
  return out;
}

// ------------------------------------------------------------ tests

test('fixtures are valid artifacts', () => {
  const { dir, doc } = workspace();
  try {
    const ledger = writeLedger(dir, doc, [unit('TC-001', 'failed')]);
    const { valid } = writeAnalysis(dir, ledger, [ledger.units[0].unit_id]);
    assert.ok(valid.ok, JSON.stringify(valid.errors));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manual, skipped and no-result cases are Not Run; a fully covered passing case is Pass; API is withheld', async () => {
  const { dir, doc } = workspace();
  try {
    writeLedger(dir, doc, [
      unit('TC-001', 'passed'),
      unit('TC-001', 'passed', { project: 'firefox' }),
    ]);
    const r = await runCli(dir, []);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(planOf(r.out), {
      'TC-001': 'Pass (p)',
      'TC-002': 'Not Run (n)',
      'TC-004': 'Not Run (n)',
      'TC-005': 'Not Run (n)',
    });
    assert.match(r.out, /TC-004 .*manual case/);
    assert.match(r.out, /TC-005 .*intentionally skipped/);
    assert.match(r.out, /TC-002 .*no executed unit links to this case/);
    assert.match(
      r.out,
      /TC-003: API results wait for the API branch review gates/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two projects, one failure: Blocked unless the finalized analysis confirms a product bug, then Fail', async () => {
  const { dir, doc } = workspace();
  try {
    const failing = unit('TC-001', 'failed', { project: 'firefox' });
    const ledger = writeLedger(dir, doc, [unit('TC-001', 'passed'), failing]);

    const unconfirmed = await runCli(dir, []);
    assert.equal(
      planOf(unconfirmed.out)['TC-001'],
      'Blocked (b)',
      unconfirmed.out
    );

    const { fa, valid } = writeAnalysis(dir, ledger, [failing.unit_id]);
    assert.ok(valid.ok);
    writeFileSync(
      join(dir, 'analysis', 'failure-analysis.json'),
      JSON.stringify(fa)
    );
    const confirmed = await runCli(dir, []);
    assert.equal(planOf(confirmed.out)['TC-001'], 'Fail (f)', confirmed.out);

    // A failure classified as something other than a product bug stays Blocked.
    const { fa: other } = writeAnalysis(dir, ledger, []);
    writeFileSync(
      join(dir, 'analysis', 'failure-analysis.json'),
      JSON.stringify(other)
    );
    const testBug = await runCli(dir, []);
    assert.equal(planOf(testBug.out)['TC-001'], 'Blocked (b)', testBug.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mixed retries and partial execution are Blocked, never Pass', async () => {
  const { dir, doc } = workspace();
  try {
    writeLedger(dir, doc, [
      unit('TC-001', 'flaky'),
      unit('TC-002', 'passed'),
      unit('TC-002', 'skipped', { project: 'firefox' }),
    ]);
    const r = await runCli(dir, []);
    assert.equal(r.code, 0, r.out);
    assert.equal(planOf(r.out)['TC-001'], 'Blocked (b)');
    assert.match(r.out, /TC-001 .*flaky without a confirmed product failure/);
    assert.equal(planOf(r.out)['TC-002'], 'Blocked (b)');
    assert.match(r.out, /TC-002 .*partially executed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unattributed failing unit or an unclean execution blocks an otherwise passing case', async () => {
  const { dir, doc } = workspace();
  try {
    writeLedger(dir, doc, [unit('TC-001', 'passed'), unit(null, 'failed')]);
    const orphan = await runCli(dir, []);
    assert.equal(planOf(orphan.out)['TC-001'], 'Blocked (b)', orphan.out);
    assert.match(orphan.out, /unattributed non-passing unit/);

    writeLedger(dir, doc, [unit('TC-001', 'passed')], {
      exec: {
        source_errors: [{ message: 'report truncated', phase: 'report' }],
      },
    });
    const unclean = await runCli(dir, []);
    assert.equal(planOf(unclean.out)['TC-001'], 'Blocked (b)', unclean.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a wrong-run, wrong-scope, scope-less or missing ledger: dry run says Not Run, apply is refused with no request', async () => {
  const { server, reports } = fakeTestLink();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const env = {
    TESTLINK_URL: url,
    TESTLINK_API_KEY: DEVKEY,
    TESTLINK_TEST_PLAN_ID: '7',
  };
  try {
    for (const [arrange, why] of [
      [
        (dir, doc) =>
          writeLedger(dir, doc, [unit('TC-001', 'passed')], {
            runId: 'another-run',
          }),
        /belongs to run another-run/,
      ],
      [
        (dir, doc) =>
          writeLedger(dir, doc, [unit('TC-001', 'passed')], {
            scope: 'b'.repeat(64),
          }),
        /different approved scope/,
      ],
      [
        (dir, doc) =>
          writeLedger(dir, doc, [unit('TC-001', 'passed')], { scope: null }),
        /does not record the approved scope/,
      ],
      [() => {}, /does not exist/],
    ]) {
      const { dir, doc } = workspace();
      try {
        arrange(dir, doc);
        const dry = await runCli(dir, []);
        assert.equal(dry.code, 0, dry.out);
        assert.match(dry.out, why);
        assert.equal(planOf(dry.out)['TC-001'], 'Not Run (n)', dry.out);
        const apply = await runCli(dir, ['--apply-testlink-execution'], env);
        assert.equal(apply.code, 1, apply.out);
        assert.match(
          apply.out,
          /Refusing to report results without valid execution evidence/
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  assert.equal(reports.length, 0);
});

test('array order cannot change any outcome', () => {
  const doc = testCases();
  const failing = unit('TC-001', 'failed', { project: 'firefox' });
  const units = [
    unit('TC-001', 'passed'),
    failing,
    unit('TC-002', 'passed'),
    unit('TC-002', 'flaky', { project: 'firefox' }),
    unit(null, 'skipped'),
  ];
  const { ledger } = buildLedger({
    runId: RUN,
    storyId: STORY,
    generatedAt: '2026-09-28T10:03:00.000Z',
    sourceExecutions: [execution()],
    units,
    approvedScopeDigest: approvedScopeDigest(doc),
  });
  const confirmed = new Set([failing.unit_id]);
  const outcomes = (l) =>
    doc.test_cases.map((tc) =>
      testCaseOutcome({
        testCase: tc,
        ledger: l,
        confirmedProductFailureUnits: confirmed,
      })
    );
  const forward = outcomes(ledger);
  const reversed = outcomes({
    ...ledger,
    units: [...ledger.units].reverse(),
    source_executions: [...ledger.source_executions].reverse(),
  });
  assert.deepEqual(reversed, forward);
  assert.deepEqual(
    forward.map((o) => o.outcome),
    ['product_failure', 'blocked', 'not_run', 'not_run', 'not_run']
  );
});

test('apply reports each case with its status and leaves every source artifact unchanged', async () => {
  const { dir, doc } = workspace();
  const { server, reports } = fakeTestLink();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const failing = unit('TC-002', 'failed');
    const ledger = writeLedger(dir, doc, [unit('TC-001', 'passed'), failing]);
    const { fa } = writeAnalysis(dir, ledger, [failing.unit_id]);
    writeFileSync(
      join(dir, 'analysis', 'failure-analysis.json'),
      JSON.stringify(fa)
    );
    const before = digestTree(dir);

    const r = await runCli(dir, ['--apply-testlink-execution'], {
      TESTLINK_URL: url,
      TESTLINK_API_KEY: DEVKEY,
      TESTLINK_TEST_PLAN_ID: '7',
    });
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.out.includes(DEVKEY));
    assert.deepEqual(
      reports.map((x) => [x.method, x.testcaseid, x.status]),
      [
        ['tl.reportTCResult', '101', 'p'],
        ['tl.reportTCResult', '102', 'f'],
        ['tl.reportTCResult', '104', 'n'],
        ['tl.reportTCResult', '105', 'n'],
      ]
    );
    assert.match(reports[0].notes, /Qaizen run run-exec-1: passed/);
    assert.deepEqual(
      digestTree(dir),
      before,
      'reporting changes no source artifact'
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a draft analysis is refused; a status map that lets a non-pass reach Pass is refused', async () => {
  const { dir, doc } = workspace();
  try {
    const ledger = writeLedger(dir, doc, [unit('TC-001', 'failed')]);
    const { fa } = writeAnalysis(dir, ledger, [ledger.units[0].unit_id], {
      status: 'draft',
    });
    writeFileSync(
      join(dir, 'analysis', 'failure-analysis.json'),
      JSON.stringify(fa)
    );
    const draft = await runCli(dir, []);
    assert.equal(draft.code, 1, draft.out);
    assert.match(
      draft.out,
      /draft 2\.0 analysis; refusing to sync execution results/
    );
    assert.doesNotMatch(draft.out, /\(f\)/);

    rmSync(join(dir, 'analysis', 'failure-analysis.json'));
    const mapPath = join(dir, 'config', 'testlink-status-map.json');
    const map = JSON.parse(readFileSync(mapPath, 'utf8'));
    map.outcome_to_testlink_status.blocked = 'Pass';
    writeFileSync(mapPath, JSON.stringify(map));
    const tampered = await runCli(dir, []);
    assert.equal(tampered.code, 2, tampered.out);
    assert.match(tampered.out, /"blocked" must not map to a passing status/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manual and skip cases need their own current reviews; Gate 4 never stands in for them', async () => {
  const { dir, doc } = workspace();
  try {
    writeLedger(dir, doc, [unit('TC-001', 'passed')]);
    for (const gate of [
      'external_plan_reviewed',
      'external_evidence_reviewed',
    ]) {
      const ctxPath = join(dir, 'context.json');
      const ctx = JSON.parse(readFileSync(ctxPath, 'utf8'));
      const saved = ctx.review_gates[gate];
      ctx.review_gates[gate] = false;
      writeFileSync(ctxPath, JSON.stringify(ctx, null, 2));
      const r = await runCli(dir, []);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, new RegExp(`${gate} is not approved`));
      ctx.review_gates[gate] = saved;
      writeFileSync(ctxPath, JSON.stringify(ctx, null, 2));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shipped status map: only passed reaches Pass, only a confirmed product failure reaches Fail', () => {
  const map = JSON.parse(
    readFileSync(join(REPO, 'config', 'testlink-status-map.json'), 'utf8')
  );
  const codeOf = (outcome) =>
    map.testlink_statuses[map.outcome_to_testlink_status[outcome]];
  assert.deepEqual(
    ['passed', 'product_failure', 'blocked', 'not_run'].map(codeOf),
    ['p', 'f', 'b', 'n']
  );
});

test('normalize --test-cases records the approved scope; another story is refused', async () => {
  const { dir, doc } = workspace();
  try {
    cpSync(
      join(REPO, 'test', 'fixtures', 'playwright-all-outcomes.json'),
      join(dir, 'pw.json')
    );
    const norm = (args) =>
      new Promise((resolve) => {
        const child = spawn(
          execPath,
          [join('scripts', 'normalize-results.js'), ...args],
          { cwd: dir }
        );
        let out = '';
        child.stdout.on('data', (b) => (out += b));
        child.stderr.on('data', (b) => (out += b));
        child.on('close', (code) => resolve({ code, out }));
      });
    const ok = await norm([
      '--story',
      STORY,
      '--run-id',
      RUN,
      '--playwright',
      'pw.json',
      '--test-cases',
      `test-cases/${STORY}.json`,
      '--out',
      'analysis/execution-ledger.json',
    ]);
    assert.equal(ok.code, 0, ok.out);
    const ledger = JSON.parse(
      readFileSync(join(dir, 'analysis', 'execution-ledger.json'), 'utf8')
    );
    assert.equal(ledger.approved_scope_digest, approvedScopeDigest(doc));
    assert.deepEqual(
      ledger.case_outcomes.map((c) => c.test_case_id).sort(),
      doc.test_cases.map((c) => c.test_case_id).sort()
    );

    const other = { ...doc, story_id: 'SK-99' };
    writeFileSync(join(dir, 'other.json'), JSON.stringify(other));
    const refused = await norm([
      '--story',
      STORY,
      '--run-id',
      RUN,
      '--playwright',
      'pw.json',
      '--test-cases',
      'other.json',
      '--out',
      'analysis/other-ledger.json',
    ]);
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /is for story SK-99, not SK-20/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
