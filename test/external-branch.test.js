// Manual, component and skip scopes: the external branch (task group 7.2).
//
// The real runner and import script drive each run on synthetic fixtures.
// Gates are recorded with the same binding the runner uses at a human
// decision (test/helpers), never through the runner or the import: importing
// results records claims, and only a human review approves them.
//
// Acceptance (IMPLEMENTATION_PLAN 7.2): an approved non-E2E scope has an
// honest completion path with its own reviews, and no "not applicable" gate is
// silently turned into an approval.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
import { execPath } from 'node:process';

import {
  bindGate,
  scopeCases,
  writeCompletedRun,
} from './helpers/valid-run.js';
import {
  externalSource,
  testCaseOutcome,
} from '../scripts/lib/execution-ledger.js';
import { validateValue } from '../scripts/lib/artifact-io.js';

const REPO = process.cwd();
const STORY = 'SK-72';
const RUN = 'run-ext-1';
const PLAN = `planner-input/${STORY}.external-plan.json`;
const RESULTS = `external-evidence/${STORY}.results.json`;
const COL_PATH = `api-tests/collections/${STORY}.postman_collection.json`;
const ENV_PATH = `api-tests/environments/${STORY}.postman_environment.json`;
const HOUR = 3600 * 1000;
/** After every fixture approval (2026-09-01), before now. */
const executedAt = () => new Date(Date.now() - HOUR).toISOString();

// ------------------------------------------------------------ fixtures

function write(dir, rel, content) {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), content);
}
const readJson = (dir, rel) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));
const readCtx = (dir) => readJson(dir, 'context.json');
const writeCtx = (dir, ctx) =>
  writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));

/**
 * A run approved through Gate 2 whose approved cases decide the branches, with
 * no E2E artifacts. `decisions`: the automation decision of TC-001, TC-002 and
 * TC-004, each approved.
 */
function run(decisions) {
  const dir = mkdtempSync(join(REPO, '.tmp-runner-ext-'));
  for (const d of ['scripts', 'schemas'])
    cpSync(join(REPO, d), join(dir, d), { recursive: true });
  const tc = scopeCases(STORY, RUN);
  decisions.forEach((d, i) => {
    tc.test_cases[i].automation_decision = d;
  });
  writeCompletedRun(
    dir,
    { storyId: STORY, runId: RUN, status: 'in_progress' },
    {
      [`test-cases/${STORY}.json`]: JSON.stringify(tc),
      [`specs/${STORY}.md`]: null,
      [`tests/${STORY}.spec.ts`]: null,
      'reports/results.json': null,
      'analysis/execution-ledger.json': null,
      'analysis/failure-analysis.json': null,
      'release/release-report.json': null,
      'release/release-report.md': null,
    }
  );
  const ctx = readCtx(dir);
  for (const k of [
    'playwright_spec',
    'generated_test',
    'execution_results',
    'failure_analysis',
    'release_report_md',
    'release_report_json',
  ]) {
    ctx.artifact_paths[k] = '';
  }
  ctx.review_gates.specs_reviewed = false;
  ctx.review_gates.code_reviewed = false;
  writeCtx(dir, ctx);
  return dir;
}

/** The Test Designer's plan: one entry per approved external case. */
function writePlan(dir, { runId = RUN } = {}) {
  const tc = readJson(dir, `test-cases/${STORY}.json`);
  const cases = tc.test_cases
    .filter((c) => externalSource(c.automation_decision) !== null)
    .map((c) =>
      c.automation_decision === 'skip'
        ? {
            test_case_id: c.test_case_id,
            source: 'skip',
            exclusion_reason: 'Covered by another approved case.',
          }
        : {
            test_case_id: c.test_case_id,
            source: externalSource(c.automation_decision),
            ...(c.automation_decision === 'manual'
              ? { procedure: 'Follow the steps of the test case.' }
              : { command: 'npm run test:component -- login' }),
            expected_outcome: 'The expected results of the test case hold.',
            evidence_required: ['a screenshot or the suite output'],
          }
    );
  write(
    dir,
    PLAN,
    JSON.stringify({
      schema_version: '1.0',
      document: 'external_plan',
      story_id: STORY,
      run_id: runId,
      cases,
    })
  );
}

/** Record a human review the way the runner binds it (never via the CLI). */
function approve(dir, ...gates) {
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
const step = (dir) =>
  pipeline(dir, ['--status']).out.match(/Next step: (\S+)/)[1];

function importResult(dir, args) {
  const r = spawnSync(execPath, ['scripts/import-execution.js', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function evidence(dir, name, content = 'screenshot bytes') {
  const rel = `external-evidence/${STORY}/${name}`;
  write(dir, rel, content);
  return rel;
}

const manual = (caseId, outcome, extra = []) => [
  '--case',
  caseId,
  '--outcome',
  outcome,
  '--executed-at',
  executedAt(),
  '--operator',
  'Synthetic Operator',
  ...extra,
];

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

// ------------------------------------------------------------ import

test('manual pass with evidence: recorded with its digest, approves nothing, then classified as passed', () => {
  const dir = run(['manual', 'automate_e2e', 'automate_e2e']);
  try {
    // Only the external branch is under test: drop the E2E cases.
    const tc = readJson(dir, `test-cases/${STORY}.json`);
    tc.test_cases = tc.test_cases.slice(0, 1);
    write(dir, `test-cases/${STORY}.json`, JSON.stringify(tc));
    approve(dir, 'test_scope_reviewed');

    assert.equal(step(dir), 'external-plan');
    writePlan(dir);
    assert.equal(step(dir), 'gate3-ext');

    // Nothing is recorded against an unreviewed plan.
    const early = importResult(
      dir,
      manual('TC-001', 'passed', ['--evidence', evidence(dir, 'tc1.png')])
    );
    assert.equal(early.code, 2, early.out);
    assert.match(early.out, /external_plan_reviewed is not approved/);
    assert.equal(existsSync(join(dir, RESULTS)), false);

    approve(dir, 'external_plan_reviewed');
    assert.equal(step(dir), 'external-results');
    const ok = importResult(
      dir,
      manual('TC-001', 'passed', ['--evidence', evidence(dir, 'tc1.png')])
    );
    assert.equal(ok.code, 0, ok.out);
    const results = readJson(dir, RESULTS);
    assert.equal(results.results[0].outcome, 'passed');
    assert.match(results.results[0].evidence[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(
      readCtx(dir).review_gates.external_evidence_reviewed,
      undefined,
      'importing sets no gate'
    );
    assert.equal(step(dir), 'gate4-ext', 'importing results approves nothing');
    const pending = pipeline(dir, ['--resume']);
    assert.match(pending.out, /GATE PENDING: external_evidence_reviewed/);

    approve(dir, 'external_evidence_reviewed');
    // Evidence replaced after the review: the review no longer stands.
    evidence(dir, 'tc1.png', 'a different screenshot');
    assert.match(
      pipeline(dir, ['--status']).out,
      /Stale approval: external_evidence_reviewed/
    );
    evidence(dir, 'tc1.png');

    const r = pipeline(dir, ['--resume']);
    assert.match(r.out, /Next step: FINALIZE/, r.out);
    const ledger = readJson(dir, 'analysis/execution-ledger.json');
    assert.deepEqual(
      ledger.source_executions.map((e) => e.runner),
      ['external']
    );
    assert.deepEqual(ledger.case_outcomes, [
      {
        test_case_id: 'TC-001',
        outcome: 'passed',
        linked_unit_ids: ['external:TC-001'],
      },
    ]);
    const outcome = testCaseOutcome({ testCase: tc.test_cases[0], ledger });
    assert.equal(outcome.outcome, 'passed');
    assert.equal(
      readJson(dir, 'analysis/failure-analysis.json').failures.length,
      0
    );
    assert.equal(
      readCtx(dir).review_gates.code_reviewed,
      false,
      'no code, no code review'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a claimed pass without evidence, missing evidence, or evidence outside the repo is refused', () => {
  const dir = run(['manual', 'manual', 'skip']);
  try {
    writePlan(dir);
    approve(dir, 'external_plan_reviewed');
    for (const [args, reason] of [
      [manual('TC-001', 'passed'), /a pass needs evidence/],
      [
        manual('TC-001', 'passed', [
          '--evidence',
          'external-evidence/nope.png',
        ]),
        /does not exist/,
      ],
      [
        manual('TC-001', 'passed', ['--evidence', '../outside.png']),
        /outside the repository/,
      ],
      [
        manual('TC-004', 'passed', ['--evidence', evidence(dir, 'x.png')]),
        /never executed/,
      ],
      [manual('TC-003', 'failed'), /not in the reviewed plan/],
      [
        [
          ...manual('TC-001', 'failed').slice(0, 4),
          '--executed-at',
          '2026-08-01T00:00:00Z',
          '--operator',
          'x',
        ],
        /before the plan was approved/,
      ],
      [
        [
          ...manual('TC-001', 'failed').slice(0, 4),
          '--executed-at',
          new Date(Date.now() + 24 * HOUR).toISOString(),
          '--operator',
          'x',
        ],
        /in the future/,
      ],
    ]) {
      const r = importResult(dir, args);
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, reason);
      assert.match(r.out, /Nothing was written/);
    }
    assert.equal(existsSync(join(dir, RESULTS)), false);
    // A failure needs no evidence to be recorded (it is not a claim of success).
    assert.equal(importResult(dir, manual('TC-001', 'failed')).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a wrong-run import is refused, whether the import file or the existing results are foreign', () => {
  const dir = run(['automate_component', 'manual', 'skip']);
  try {
    writePlan(dir);
    approve(dir, 'external_plan_reviewed');
    const doc = (runId) => ({
      schema_version: '1.0',
      document: 'external_import',
      story_id: STORY,
      run_id: runId,
      results: [
        {
          test_case_id: 'TC-001',
          outcome: 'failed',
          executed_at: executedAt(),
          operator: 'component-ci',
        },
      ],
    });
    write(dir, 'component.json', JSON.stringify(doc('another-run')));
    let r = importResult(dir, ['--from', 'component.json']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /not SK-72\/run-ext-1/);

    // Results already on disk from another run are never merged into.
    write(
      dir,
      RESULTS,
      JSON.stringify({
        schema_version: '1.0',
        document: 'external_results',
        story_id: STORY,
        run_id: 'another-run',
        approved_scope_digest: '0'.repeat(64),
        results: [],
      })
    );
    write(dir, 'component.json', JSON.stringify(doc(RUN)));
    const before = readFileSync(join(dir, RESULTS), 'utf8');
    r = importResult(dir, ['--from', 'component.json']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /holds results of SK-72\/another-run/);
    assert.equal(readFileSync(join(dir, RESULTS), 'utf8'), before);
    // Nor does the runner accept them as this run's results.
    assert.match(
      pipeline(dir, ['--status']).out,
      /external_results: .*belongs to run another-run/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a component failure is imported from normalized JSON and left to a human to classify', () => {
  const dir = run(['automate_component', 'manual', 'skip']);
  try {
    writePlan(dir);
    approve(dir, 'external_plan_reviewed');
    write(
      dir,
      'component.json',
      JSON.stringify({
        schema_version: '1.0',
        document: 'external_import',
        story_id: STORY,
        run_id: RUN,
        results: [
          {
            test_case_id: 'TC-001',
            outcome: 'failed',
            executed_at: executedAt(),
            operator: 'component-ci',
            evidence: [evidence(dir, 'component-output.json', '{"failed":1}')],
            notes: 'LoginForm rejects a valid password with a trailing space.',
          },
        ],
      })
    );
    const r = importResult(dir, ['--from', 'component.json']);
    assert.equal(r.code, 0, r.out);
    // TC-002 (manual) was never recorded: it stays Not Run.
    approve(dir, 'external_evidence_reviewed');
    const done = pipeline(dir, ['--resume']);
    assert.match(done.out, /Next step: FINALIZE/, done.out);

    const analysis = readJson(dir, 'analysis/failure-analysis.json');
    assert.equal(analysis.failures.length, 1);
    const [f] = analysis.failures;
    assert.equal(f.source, 'external');
    assert.equal(f.test_case_id, 'TC-001');
    assert.equal(f.classification, 'unknown_needs_human_review');
    assert.equal(f.severity, 'yellow');
    assert.equal('playwright_test_id' in f, false, 'no id is minted');
    assert.match(f.error_message, /trailing space/);

    const ledger = readJson(dir, 'analysis/execution-ledger.json');
    const tc = readJson(dir, `test-cases/${STORY}.json`).test_cases;
    const outcomeOf = (i, confirmed = new Set()) =>
      testCaseOutcome({
        testCase: tc[i],
        ledger,
        confirmedProductFailureUnits: confirmed,
      }).outcome;
    assert.equal(outcomeOf(0), 'blocked', 'unconfirmed failure');
    assert.equal(
      outcomeOf(0, new Set(['external:TC-001'])),
      'product_failure',
      'once a human confirms it'
    );
    assert.equal(outcomeOf(1), 'not_run', 'absent manual result');
    assert.equal(outcomeOf(2), 'not_run', 'approved skip');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an absent manual result stays Not Run: nothing is inferred from silence', () => {
  const dir = run(['manual', 'manual', 'skip']);
  try {
    writePlan(dir);
    approve(dir, 'external_plan_reviewed');
    assert.equal(
      importResult(
        dir,
        manual('TC-001', 'passed', ['--evidence', evidence(dir, 'a.png')])
      ).code,
      0
    );
    approve(dir, 'external_evidence_reviewed');
    assert.match(pipeline(dir, ['--resume']).out, /Next step: FINALIZE/);
    const ledger = readJson(dir, 'analysis/execution-ledger.json');
    const byCase = Object.fromEntries(
      ledger.case_outcomes.map((c) => [c.test_case_id, c.outcome])
    );
    assert.deepEqual(byCase, {
      'TC-001': 'passed',
      'TC-002': 'not_run',
      'TC-004': 'not_run',
    });
    assert.equal(ledger.units.length, 1, 'no unit is invented for TC-002');
    const r = testCaseOutcome({
      testCase: readJson(dir, `test-cases/${STORY}.json`).test_cases[1],
      ledger,
    });
    assert.equal(r.outcome, 'not_run');
    assert.match(r.reason, /no recorded result/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ scopes

test('a skip-only scope passes both external reviews and yields an explicit zero-execution ledger', () => {
  const dir = run(['skip', 'skip', 'skip']);
  try {
    assert.equal(step(dir), 'external-plan');
    writePlan(dir);
    let r = pipeline(dir, ['--resume']);
    assert.match(r.out, /GATE PENDING: external_plan_reviewed/, r.out);
    approve(dir, 'external_plan_reviewed');
    r = pipeline(dir, ['--resume']);
    assert.match(
      r.out,
      /GATE PENDING: external_evidence_reviewed/,
      'the unexecuted disposition is still reviewed'
    );
    assert.equal(
      existsSync(join(dir, 'analysis/execution-ledger.json')),
      false
    );
    approve(dir, 'external_evidence_reviewed');
    r = pipeline(dir, ['--resume']);
    assert.match(r.out, /Next step: FINALIZE/, r.out);

    const ledger = readJson(dir, 'analysis/execution-ledger.json');
    assert.equal(ledger.units.length, 0);
    assert.deepEqual(ledger.source_executions, []);
    assert.equal(ledger.totals.unit_pass_rate, null);
    assert.equal(ledger.totals.approved_case_coverage, 0, 'nothing passed');
    assert.ok(ledger.case_outcomes.every((c) => c.outcome === 'not_run'));
    const ctx = readCtx(dir);
    assert.equal(ctx.review_gates.code_reviewed, false);
    assert.equal(ctx.artifact_paths.external_plan, PLAN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mixed manual/API scope reviews every plan before Newman, and the evidence after it', async () => {
  const dir = run(['automate_api', 'manual', 'skip']);
  const api = await apiServer();
  try {
    write(
      dir,
      COL_PATH,
      readFileSync(
        join(
          REPO,
          'examples/expected/api-create-user.expected-collection.json'
        ),
        'utf8'
      )
    );
    write(
      dir,
      ENV_PATH,
      JSON.stringify({
        name: STORY,
        values: [{ key: 'base_url', value: api.url, enabled: true }],
      })
    );
    writePlan(dir);
    approve(dir, 'collection_reviewed', 'api_assertions_reviewed');

    let r = pipeline(dir, ['--resume']);
    assert.match(r.out, /GATE PENDING: external_plan_reviewed/, r.out);
    assert.doesNotMatch(
      r.out,
      /run-newman/,
      'Newman waits for every plan review'
    );

    approve(dir, 'external_plan_reviewed');
    r = pipeline(dir, ['--resume']);
    assert.match(r.out, /Executing: node scripts\/run-newman\.js SK-72/, r.out);
    assert.match(r.out, /Next step: EXTERNAL-RESULTS/, r.out);

    assert.equal(
      importResult(
        dir,
        manual('TC-002', 'passed', ['--evidence', evidence(dir, 'tc2.png')])
      ).code,
      0
    );
    r = pipeline(dir, ['--resume']);
    assert.match(r.out, /GATE PENDING: external_evidence_reviewed/, r.out);
    assert.equal(
      existsSync(join(dir, 'analysis/failure-analysis.json')),
      false
    );

    approve(dir, 'external_evidence_reviewed');
    r = pipeline(dir, ['--resume']);
    assert.match(r.out, /Next step: FINALIZE/, r.out);
    const ledger = readJson(dir, 'analysis/execution-ledger.json');
    assert.deepEqual(ledger.source_executions.map((e) => e.runner).sort(), [
      'external',
      'newman',
    ]);

    // A result recorded after classification changes the reviewed evidence:
    // the review returns to pending and the analysis is redone after it.
    assert.equal(importResult(dir, manual('TC-002', 'failed')).code, 0);
    r = pipeline(dir, ['--status']);
    assert.match(r.out, /Stale approval: external_evidence_reviewed/);
  } finally {
    api.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ contract

test('the schema itself refuses an evidence-less pass and an incomplete plan entry', () => {
  const schema = join(REPO, 'schemas', 'external-execution.schema.json');
  const results = JSON.parse(
    readFileSync(
      join(
        REPO,
        'examples/expected/login-success.expected-external-results.json'
      ),
      'utf8'
    )
  );
  assert.equal(validateValue(results, schema).ok, true);
  results.results[0].evidence = [];
  assert.equal(
    validateValue(results, schema).ok,
    false,
    'a pass needs evidence'
  );
  results.results[0].outcome = 'failed';
  assert.equal(validateValue(results, schema).ok, true, 'a failure does not');
  results.results[0].source = 'skip';
  assert.equal(
    validateValue(results, schema).ok,
    false,
    'a skip has no result'
  );

  const plan = JSON.parse(
    readFileSync(
      join(REPO, 'examples/expected/login-success.expected-external-plan.json'),
      'utf8'
    )
  );
  assert.equal(validateValue(plan, schema).ok, true);
  delete plan.cases[0].evidence_required;
  assert.equal(validateValue(plan, schema).ok, false, 'manual needs evidence');
  plan.cases[0] = { test_case_id: 'TC-004', source: 'skip' };
  assert.equal(validateValue(plan, schema).ok, false, 'skip needs a reason');
});

test('an automated unit never stands in for a manual case, nor an external one for an automated case', () => {
  const tc = scopeCases(STORY, RUN).test_cases;
  const manualCase = { ...tc[0], automation_decision: 'manual' };
  const e2eCase = { ...tc[1], automation_decision: 'automate_e2e' };
  const exec = (id, runner) => ({
    execution_id: id,
    runner,
    started_at: '2026-09-02T00:00:00Z',
    process_status: 'completed',
    source_errors: [],
  });
  const ledger = {
    source_executions: [
      exec('exec-pw-1', 'playwright'),
      exec('exec-ext-1', 'external'),
    ],
    units: [
      {
        unit_id: 'pw:1',
        execution_id: 'exec-pw-1',
        identity: {
          kind: 'playwright',
          test_title: `login ${manualCase.test_case_id}`,
        },
        domain_links: { test_case_id: manualCase.test_case_id },
        outcome: 'passed',
      },
      {
        unit_id: `external:${e2eCase.test_case_id}`,
        execution_id: 'exec-ext-1',
        identity: { kind: 'external', occurrence: 0 },
        domain_links: { test_case_id: e2eCase.test_case_id },
        outcome: 'passed',
      },
    ],
  };
  assert.equal(
    testCaseOutcome({ testCase: manualCase, ledger }).outcome,
    'not_run'
  );
  assert.equal(
    testCaseOutcome({ testCase: e2eCase, ledger }).outcome,
    'not_run'
  );
});

test('the classifier refuses external results whose evidence review is not current', () => {
  const dir = run(['manual', 'manual', 'skip']);
  try {
    writePlan(dir);
    approve(dir, 'external_plan_reviewed');
    assert.equal(importResult(dir, manual('TC-001', 'failed')).code, 0);
    approve(dir, 'external_evidence_reviewed');
    assert.match(pipeline(dir, ['--resume']).out, /Next step: FINALIZE/);

    const ctx = readCtx(dir);
    ctx.review_gates.external_evidence_reviewed = false;
    writeCtx(dir, ctx);
    const r = spawnSync(execPath, ['scripts/run-failure-classifier.js'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(
      r.stderr,
      /External Gate 4: external_evidence_reviewed is not approved/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('results recorded before a later plan re-approval no longer count', () => {
  const dir = run(['manual', 'manual', 'skip']);
  try {
    writePlan(dir);
    approve(dir, 'external_plan_reviewed');
    assert.equal(importResult(dir, manual('TC-001', 'failed')).code, 0);
    assert.equal(step(dir), 'gate4-ext');
    // The plan is reviewed again now, after the work was recorded.
    const ctx = readCtx(dir);
    ctx.review_gates.external_plan_reviewed.reviewed_at =
      new Date().toISOString();
    writeCtx(dir, ctx);
    const out = pipeline(dir, ['--status']).out;
    assert.match(out, /predate the external plan approval/);
    assert.match(out, /Next step: external-results/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
