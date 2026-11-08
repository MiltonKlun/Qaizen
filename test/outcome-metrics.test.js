// Outcome metrics (gate time, rounds to approval, flake rate, heals per test,
// cost, escaped defects, the dual-judge trigger) and the outcome records a
// person enters through scripts/record-outcome.js.

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

import {
  costMetrics,
  decisionMinutes,
  dualJudgeTrigger,
  escapedMetrics,
  gateTime,
  repeatFlakes,
  roundsToApproval,
} from '../scripts/lib/outcome-metrics.js';
import {
  EARLIER_KEPT,
  earlierChecks,
  earlierDropped,
  ledgerRepeatCheck,
} from '../scripts/lib/repeat-check.js';
import { healerMetrics } from '../scripts/lib/run-metrics.js';
import {
  collectDefects,
  renderDefectHistory,
} from '../scripts/lib/defect-history.js';
import { validateValue } from '../scripts/lib/artifact-io.js';

const REPO = process.cwd();
const ESC_SCHEMA = 'schemas/escaped-defect.schema.json';
const COST_SCHEMA = 'schemas/story-cost.schema.json';

const d = (gate, decision, opened, decided) => ({
  gate,
  decision,
  ...(opened ? { opened_at: `2026-10-01T${opened}:00Z` } : {}),
  decided_at: `2026-10-01T${decided}:00Z`,
});

// ------------------------------------------------------------ gate time

test('gate time sums brief-to-decision minutes per gate and per run, and leaves out what it cannot time', () => {
  assert.equal(decisionMinutes(d('g', 'approved', '10:00', '10:30')), 30);
  assert.equal(decisionMinutes(d('g', 'approved', null, '10:30')), null);
  assert.equal(
    decisionMinutes(d('g', 'approved', '11:00', '10:30')),
    null,
    'a decision before its brief is not timed'
  );
  const t = gateTime([
    {
      gate_decisions: [
        d('requirements_reviewed', 'rejected', '10:00', '10:10'),
        d('requirements_reviewed', 'approved', '10:20', '10:25'),
        d('code_reviewed', 'approved', null, '12:00'),
      ],
    },
    { gate_decisions: [d('code_reviewed', 'approved', '09:00', '10:00')] },
    {},
  ]);
  assert.equal(t.runs_with_timing, 2);
  assert.equal(t.decisions_timed, 3);
  assert.equal(t.decisions_untimed, 1);
  assert.equal(t.total_minutes, 75);
  assert.equal(t.median_minutes_per_run, 37.5);
  assert.deepEqual(t.by_gate.requirements_reviewed, {
    timed: 2,
    total_minutes: 15,
    median_minutes: 7.5,
    max_minutes: 10,
  });
  assert.equal(gateTime([]).total_minutes, null, 'none timed is unknown');
});

// ------------------------------------------------------------ rounds

test('rounds to approval count the rejections before each approval, a re-approval and a gate left rejected apart', () => {
  const r = roundsToApproval([
    {
      gate_decisions: [
        d('test_scope_reviewed', 'rejected', null, '10:00'),
        d('test_scope_reviewed', 'rejected', null, '10:10'),
        d('test_scope_reviewed', 'approved', null, '10:20'),
        d('specs_reviewed', 'approved', null, '11:00'),
        // Invalidated and approved again: a re-approval, not another
        // first-time approval.
        d('specs_reviewed', 'approved', null, '12:00'),
        // Invalidated, rejected, approved: a round of two.
        d('specs_reviewed', 'rejected', null, '13:00'),
        d('specs_reviewed', 'approved', null, '13:30'),
      ],
    },
    {
      gate_decisions: [
        d('test_scope_reviewed', 'approved', null, '10:00'),
        d('code_reviewed', 'rejected', null, '11:00'),
      ],
    },
    { gate_decisions: [] },
  ]);
  assert.equal(r.runs_with_gate_log, 2);
  // Rounds: test_scope 3 and 1, specs 1 and 2; one specs re-approval apart.
  assert.equal(r.approvals, 4);
  assert.equal(r.reapprovals, 1);
  assert.equal(r.max_rounds, 3);
  assert.equal(r.mean_rounds, 1.75);
  assert.equal(r.first_time.count, 2);
  assert.equal(r.first_time.value, 0.5);
  assert.ok(r.first_time.wilson_95[0] < 0.5 && r.first_time.wilson_95[1] > 0.5);
  assert.equal(r.open_after_rejection, 1);
  assert.equal(r.by_gate.specs_reviewed.reapprovals, 1);
  assert.deepEqual(
    {
      approvals: r.by_gate.test_scope_reviewed.approvals,
      mean: r.by_gate.test_scope_reviewed.mean_rounds,
    },
    { approvals: 2, mean: 2 }
  );
  assert.equal(r.by_gate.code_reviewed.approvals, 0);
  assert.equal(r.by_gate.code_reviewed.mean_rounds, null);
  assert.equal(r.by_gate.code_reviewed.open_after_rejection, 1);
});

// ------------------------------------------------------------ flakes

const unit = (passed, failed, flaky = 0) => ({
  file: 'tests/S.spec.ts',
  title: `t${passed}${failed}${flaky}`,
  project: '',
  runs: passed + failed + flaky,
  passed,
  failed,
  flaky,
  skipped: 0,
});
const record = (outcome, units, extra = {}) => ({
  input_digest: 'a'.repeat(64),
  track: 'standard',
  repeat_each: 10,
  workers: 2,
  ran_at: '2026-10-01T10-00-00Z',
  report: 'reports/repeat/results.json',
  outcome,
  units,
  ...extra,
});

test('a new repeat check keeps a summary of the one it replaces, up to the cap', () => {
  const flaky = record('flaky', [unit(10, 0), unit(7, 3)]);
  const first = earlierChecks(flaky);
  assert.deepEqual(first, [
    {
      ran_at: flaky.ran_at,
      input_digest: flaky.input_digest,
      repeat_each: 10,
      outcome: 'flaky',
      units: 2,
      flaky_units: 1,
    },
  ]);
  const second = earlierChecks(
    record('stable', [unit(10, 0)], { earlier: first })
  );
  assert.equal(second.length, 2);
  assert.equal(second[0].outcome, 'flaky', 'oldest first');
  // Twenty-five checks: the record keeps twenty earlier ones and counts the
  // rest, so the metrics can say what they leave out.
  let chain = null;
  for (let i = 0; i < EARLIER_KEPT + 5; i += 1) {
    const dropped = earlierDropped(chain);
    chain = record('stable', [unit(10, 0)], {
      earlier: earlierChecks(chain),
      ...(dropped ? { earlier_dropped: dropped } : {}),
    });
  }
  assert.equal(chain.earlier.length, EARLIER_KEPT);
  assert.equal(chain.earlier_dropped, 4);
  assert.equal(earlierChecks(chain).length, EARLIER_KEPT);
  assert.equal(earlierDropped(chain), 5);
  assert.equal(repeatFlakes([{ repeat_check: chain }]).checks_not_kept, 4);
  assert.deepEqual(earlierChecks(null), []);
  assert.equal(earlierDropped(null), 0);

  // The ledger copy carries the check itself, valid against the ledger's
  // schema, and nothing of the history.
  const copy = ledgerRepeatCheck(chain);
  assert.equal('earlier' in copy, false);
  assert.equal('earlier_dropped' in copy, false);
  assert.equal(
    validateValue(copy, 'schemas/execution-ledger.schema.json', {
      fragment: '#/properties/repeat_check',
    }).ok,
    true
  );
  assert.equal(
    validateValue(chain, 'schemas/execution-ledger.schema.json', {
      fragment: '#/properties/repeat_check',
    }).ok,
    false,
    'the ledger schema refuses the history, which is why it is left out'
  );
});

test('the flake rate counts the earlier checks of a run, not only its last one', () => {
  const ctx = {
    repeat_check: record('stable', [unit(10, 0), unit(10, 0)], {
      earlier: earlierChecks(record('flaky', [unit(10, 0), unit(9, 0, 1)])),
    }),
  };
  const f = repeatFlakes([
    ctx,
    { repeat_check: record('stable', [unit(10, 0)]) },
    {},
  ]);
  assert.equal(f.runs_with_check, 2);
  assert.equal(f.checks, 3);
  assert.equal(f.flaky_checks.count, 1);
  assert.equal(f.flaky_checks.value, 0.3333);
  assert.equal(f.tests_checked, 5);
  assert.equal(f.flaky_tests.count, 1);
  assert.equal(
    repeatFlakes([]).flaky_checks.value,
    null,
    'no check is unknown'
  );
});

// ------------------------------------------------------------ heals

test('heals per test: validated heals across runs, and the tests healed more than once', () => {
  const rec = JSON.parse(
    readFileSync(
      'examples/expected/locator-repair.expected-healer-validation.json',
      'utf8'
    )
  );
  const submission = (
    runId,
    sha,
    outcome = 'validated',
    unitId = rec.unit.unit_id
  ) =>
    JSON.stringify({
      ...rec,
      run_id: runId,
      outcome,
      unit: { ...rec.unit, unit_id: unitId },
      candidate: { ...rec.candidate, sha256: sha.repeat(64) },
    });
  const h = healerMetrics(
    [
      {
        story: rec.story_id,
        runId: 'r1',
        files: [
          { name: 'FAIL-001.attempt-1.json', text: submission('r1', 'a') },
          {
            name: 'FAIL-002.attempt-1.json',
            text: submission('r1', 'b', 'validation_failed', 'pw:other'),
          },
        ],
      },
      {
        story: rec.story_id,
        runId: 'r2',
        files: [
          { name: 'FAIL-001.attempt-1.json', text: submission('r2', 'c') },
        ],
      },
    ],
    () => true
  ).heals_per_test;
  assert.equal(h.tests_with_submissions, 2);
  assert.equal(h.tests_healed, 1);
  assert.equal(h.validated_heals, 2);
  assert.equal(h.heals_per_healed_test, 2);
  assert.deepEqual(h.healed_more_than_once, [
    {
      story: rec.story_id,
      test: rec.unit.unit_id,
      heals: 2,
      runs: ['r1', 'r2'],
    },
  ]);
  assert.equal(
    healerMetrics([], () => true).heals_per_test.heals_per_healed_test,
    null
  );
});

// ------------------------------------------------------------ cost, escapes, trigger

test('cost per story totals what was entered per currency, and leaves out runs that are not counted', () => {
  const c = costMetrics(
    [
      {
        story_id: 'S-1',
        runs: [
          {
            run_id: 'r1',
            operator_minutes: 60,
            spend: { amount: 2, currency: 'USD' },
          },
          { run_id: 'r2', operator_minutes: 30 },
          { run_id: 'demo', operator_minutes: 999 },
        ],
      },
      {
        story_id: 'S-2',
        runs: [{ run_id: 'r3', spend: { amount: 5, currency: 'EUR' } }],
      },
    ],
    new Set(['S-1|r1', 'S-1|r2', 'S-2|r3'])
  );
  assert.equal(c.runs_with_cost, 3);
  assert.equal(c.entries_not_counted, 1);
  assert.deepEqual(c.overall.operator_minutes, {
    runs: 2,
    total: 90,
    per_run: 45,
  });
  assert.deepEqual(Object.keys(c.overall.spend), ['EUR', 'USD']);
  assert.equal(c.by_story['S-1'].spend.USD.total, 2);
  assert.equal(c.by_story['S-2'].operator_minutes.total, null);
});

const escape = (n, why, extra = {}) => ({
  escaped_defect_id: `ESC-${String(n).padStart(3, '0')}`,
  story_id: 'S-1',
  run_id: `r${n % 2}`,
  risk_ids: ['RISK-001'],
  test_case_ids: why === 'no_case' ? [] : ['TC-001'],
  severity: 'high',
  why_missed: why,
  found_in: 'staging',
  found_at: '2026-10-02',
  ...extra,
});
const canaries = (planted, caught, wilson) => ({
  canaries: { planted, caught, wilson_95: wilson },
});

test('the dual-judge trigger fires on three escaped false negatives, or on missed canaries with a low upper bound', () => {
  const two = escapedMetrics([
    escape(1, 'test_passed_wrongly'),
    escape(2, 'test_passed_wrongly'),
    escape(3, 'no_case'),
  ]);
  assert.equal(two.recorded, 3);
  assert.equal(two.runs_with_escape, 2);
  assert.equal(two.by_why_missed.test_passed_wrongly, 2);
  assert.equal(dualJudgeTrigger(two, canaries(0, 0, null)).fired, false);

  const three = escapedMetrics(
    [1, 2, 3].map((n) => escape(n, 'test_passed_wrongly'))
  );
  const t = dualJudgeTrigger(three, canaries(0, 0, null));
  assert.equal(t.fired, true);
  assert.deepEqual(
    t.signals.map((s) => s.met),
    [true, false]
  );

  // 7 of 10 caught: three missed, upper bound about 89%.
  const none = escapedMetrics([]);
  assert.equal(
    dualJudgeTrigger(none, canaries(10, 7, [0.3968, 0.8922])).fired,
    true
  );
  // Three missed out of thirty: the upper bound is well above 90%.
  assert.equal(
    dualJudgeTrigger(none, canaries(30, 27, [0.7347, 0.9654])).fired,
    false
  );
  // Two missed is too few, whatever the bound.
  assert.equal(
    dualJudgeTrigger(none, canaries(4, 2, [0.15, 0.85])).fired,
    false
  );
  // Nothing recorded and nothing planted: unknown, not "not fired".
  assert.equal(dualJudgeTrigger(none, canaries(0, 0, null)).fired, null);

  // A record of a run the metrics do not count is left out, and said.
  const counted = escapedMetrics(
    [escape(1, 'test_passed_wrongly'), escape(2, 'test_passed_wrongly')],
    0,
    new Set(['S-1|r1'])
  );
  assert.equal(counted.recorded, 1);
  assert.equal(counted.not_counted, 1);
});

// ------------------------------------------------------------ the records

test('the schemas hold an escape to its run and its risks, and a cost entry to time or spend', () => {
  const ok = JSON.parse(
    readFileSync(
      'examples/expected/sample.expected-escaped-defect.json',
      'utf8'
    )
  );
  assert.equal(validateValue(ok, ESC_SCHEMA).ok, true);
  assert.equal(
    validateValue(
      { ...ok, risk_ids: [], traceability_unresolved: 'a new area' },
      ESC_SCHEMA
    ).ok,
    true
  );
  assert.equal(
    validateValue({ ...ok, traceability_unresolved: 'both' }, ESC_SCHEMA).ok,
    false,
    'a reason with a risk is a contradiction'
  );
  assert.equal(
    validateValue({ ...ok, test_case_ids: [] }, ESC_SCHEMA).ok,
    false,
    'a test that passed wrongly names its case'
  );
  assert.equal(
    validateValue({ ...ok, why_missed: 'no_case' }, ESC_SCHEMA).ok,
    false,
    'no case, yet a case is named'
  );
  const cost = JSON.parse(
    readFileSync('examples/expected/sample.expected-story-cost.json', 'utf8')
  );
  assert.equal(validateValue(cost, COST_SCHEMA).ok, true);
  const { spend: _s, ...minutesOnly } = cost.runs[0];
  void _s;
  assert.equal(
    validateValue({ ...cost, runs: [minutesOnly] }, COST_SCHEMA).ok,
    true
  );
});

// ------------------------------------------------------------ the CLI

/** A workspace with two archived runs of S-1 (one completed) and a demo. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-outcomes-'));
  const put = (rel, value) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const ctx = (status, runId) => ({
    status,
    run_id: runId,
    risks: [
      {
        risk_id: 'RISK-001',
        description: 'The total is wrong.',
        severity: 'high',
      },
    ],
    artifact_paths: { test_cases: 'test-cases/S-1.json' },
    gate_decisions: [
      d('requirements_reviewed', 'rejected', '09:00', '09:20'),
      d('requirements_reviewed', 'approved', '09:30', '09:40'),
      d('code_reviewed', 'approved', '10:00', '10:30'),
    ],
    repeat_check: record('stable', [unit(10, 0)], {
      earlier: earlierChecks(record('flaky', [unit(9, 0, 1)])),
    }),
  });
  put('runs/S-1/a/context.json', ctx('completed', 'run-a'));
  const tc = (id, automation_decision, status = 'approved') => ({
    test_case_id: id,
    risk_ids: ['RISK-001'],
    automation_decision,
    status,
  });
  put('runs/S-1/a/test-cases/S-1.json', {
    test_cases: [
      tc('TC-001', 'automate_e2e'),
      tc('TC-002', 'manual'),
      tc('TC-003', 'automate_e2e', 'draft'),
      tc('TC-004', 'automate_api'),
    ],
  });
  put('runs/S-1/a/analysis/execution-ledger.json', {
    case_outcomes: [
      { test_case_id: 'TC-001', outcome: 'passed' },
      { test_case_id: 'TC-004', outcome: 'failed' },
    ],
  });
  put('runs/S-1/b/context.json', ctx('in_progress', 'run-b'));
  // A run whose context records no id, but whose failure analysis does: the
  // metrics and the outcome records must know it by the same one.
  const { run_id: _id, ...noId } = ctx('completed', 'unused');
  void _id;
  put('runs/S-2/c/context.json', noId);
  put('runs/S-2/c/analysis/failure-analysis.json', { run_id: 'run-c' });
  put('runs/DEMO-1/x/context.json', ctx('completed', 'demo'));
  put('runs/DEMO-1/x/DEMO_RUN', '');
  return dir;
}
const cli = (dir, ...args) =>
  spawnSync(execPath, [join(REPO, 'scripts', 'record-outcome.js'), ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
const ESCAPE_ARGS = [
  '--summary',
  'The total ignored the discount.',
  '--severity',
  'high',
  '--found-in',
  'production',
  '--found-at',
  '2026-10-05',
  '--by',
  'QA lead',
];

test('record-outcome escaped-defect refuses what it cannot tie to a completed run, and numbers what it records', (t) => {
  const dir = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const refused = (args, pattern) => {
    const r = cli(dir, 'escaped-defect', ...args);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, pattern);
    assert.equal(existsSync(join(dir, 'outcomes')), false, 'nothing written');
  };
  const base = ['--story', 'S-1', ...ESCAPE_ARGS];
  const tied = (why, ...more) => [
    ...base,
    '--run',
    'a',
    '--risk',
    'RISK-001',
    ...more,
    '--why-missed',
    why,
  ];
  refused(
    [
      ...base,
      '--run',
      'b',
      '--risk',
      'RISK-001',
      '--case',
      'TC-001',
      '--why-missed',
      'test_passed_wrongly',
    ],
    /not a completed run/
  );
  refused(
    [...base, '--run', 'nope', '--risk', 'RISK-001', '--why-missed', 'unknown'],
    /no archived run "nope"/
  );
  refused(
    [
      '--story',
      'DEMO-1',
      '--run',
      'x',
      ...ESCAPE_ARGS,
      '--risk',
      'RISK-001',
      '--why-missed',
      'unknown',
    ],
    /demo runs do not count/
  );
  refused(
    [...base, '--run', 'a', '--risk', 'RISK-009', '--why-missed', 'unknown'],
    /RISK-009 is not a risk of runs\/S-1\/a/
  );
  refused(tied('not_run', '--case', 'TC-404'), /TC-404 is not a test case/);
  refused([...base, '--run', 'a', '--why-missed', 'no_case'], /--unresolved/);
  refused(tied('test_passed_wrongly'), /test_case_ids/);
  // A case must have been in scope, and decided in a way that fits.
  refused(
    tied('test_passed_wrongly', '--case', 'TC-003'),
    /TC-003 is draft .*only an approved case/
  );
  refused(
    tied('test_passed_wrongly', '--case', 'TC-002'),
    /TC-002 was decided manual, which does not fit test_passed_wrongly/
  );
  refused(
    tied('not_automated', '--case', 'TC-001'),
    /TC-001 was decided automate_e2e, which does not fit not_automated/
  );
  // A test the ledger records as failed did not pass wrongly.
  refused(
    tied('test_passed_wrongly', '--case', 'TC-004'),
    /ledger records TC-004 as failed, not passed/
  );
  refused(
    [
      '--story',
      'S-1',
      '--run',
      'a',
      '--risk',
      'RISK-001',
      '--why-missed',
      'unknown',
      ...ESCAPE_ARGS.slice(0, 6),
      '--found-at',
      '2999-01-01',
      '--by',
      'x',
    ],
    /after today/
  );

  /** Run the CLI and expect it to succeed. */
  const recorded = (...args) => {
    const r = cli(dir, 'escaped-defect', ...args);
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  const read = (id) =>
    JSON.parse(
      readFileSync(join(dir, `outcomes/escaped-defects/${id}.json`), 'utf8')
    );
  recorded(
    ...base,
    '--run',
    'run-a',
    '--risk',
    'RISK-001',
    '--case',
    'TC-001',
    '--why-missed',
    'test_passed_wrongly',
    '--jira',
    'SHOP-9'
  );
  const first = read('ESC-001');
  assert.equal(validateValue(first, ESC_SCHEMA).ok, true);
  assert.equal(first.run_id, 'run-a');
  assert.equal(first.run_archive, 'runs/S-1/a');
  recorded(
    '--story',
    'S-1',
    '--summary',
    'Tax rounded the wrong way.',
    ...ESCAPE_ARGS.slice(2),
    '--run',
    'a',
    '--unresolved',
    'no risk covered tax rounding',
    '--why-missed',
    'no_case'
  );
  assert.ok(existsSync(join(dir, 'outcomes/escaped-defects/ESC-002.json')));

  // The same defect twice is refused: by its summary in the same run, or by
  // its Jira key.
  const again = cli(dir, 'escaped-defect', ...tied('unknown'));
  assert.equal(again.status, 2);
  assert.match(again.stderr, /ESC-001 already records this defect/);
  const sameKey = cli(
    dir,
    'escaped-defect',
    '--story',
    'S-1',
    '--summary',
    'Something else.',
    ...ESCAPE_ARGS.slice(2),
    '--run',
    'a',
    '--risk',
    'RISK-001',
    '--why-missed',
    'unknown',
    '--jira',
    'SHOP-9'
  );
  assert.equal(sameKey.status, 2);
  assert.match(sameKey.stderr, /ESC-001 already records SHOP-9/);
  // Another defect that only looks the same is recorded on request.
  recorded(...tied('unknown'), '--force-new');
  assert.equal(read('ESC-003').why_missed, 'unknown');
  // Once more is known, the record is replaced under its own id.
  recorded(
    '--story',
    'S-1',
    '--summary',
    'The total ignored a second discount.',
    ...ESCAPE_ARGS.slice(2),
    '--run',
    'a',
    '--risk',
    'RISK-001',
    '--why-missed',
    'no_case',
    '--replace',
    'ESC-003'
  );
  assert.equal(read('ESC-003').why_missed, 'no_case');
  assert.ok(!existsSync(join(dir, 'outcomes/escaped-defects/ESC-004.json')));
  const missing = cli(
    dir,
    'escaped-defect',
    ...tied('unknown'),
    '--replace',
    'ESC-099'
  );
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--replace ESC-099: no valid record/);

  const dry = cli(
    dir,
    'escaped-defect',
    '--story',
    'S-1',
    '--summary',
    'A dry run.',
    ...ESCAPE_ARGS.slice(2),
    '--run',
    'a',
    '--risk',
    'RISK-001',
    '--why-missed',
    'unknown',
    '--dry-run'
  );
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(!existsSync(join(dir, 'outcomes/escaped-defects/ESC-004.json')));

  // The defect history lists them, with the risk as the run described it.
  const md = renderDefectHistory(
    collectDefects(join(dir, 'runs'), join(dir, 'outcomes/escaped-defects'))
  );
  assert.match(md, /product bugs: 0 · escaped defects: 3/);
  assert.match(
    md,
    /\| S-1 \| run-a \| ESC-001 \(SHOP-9\) \| RISK-001 \(high\): The total is wrong\. \| test_passed_wrongly \(TC-001\) \| production, 2026-10-05 \| high: The total ignored the discount\. \|/
  );
  assert.match(
    md,
    /\| ESC-002 \| \(no risk: no risk covered tax rounding\) \| no_case \|/
  );
  assert.doesNotMatch(md, /DEMO-1/);
});

test('record-outcome cost adds one entry per run, and replaces it only when asked', (t) => {
  const dir = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = ['--story', 'S-1', '--run', 'a', '--by', 'QA lead'];
  assert.match(
    cli(dir, 'cost', ...base).stderr,
    /give --minutes, --spend, or both/
  );
  assert.match(
    cli(dir, 'cost', ...base, '--spend', '3').stderr,
    /--spend and --currency go together/
  );
  assert.match(
    cli(dir, 'cost', ...base, '--minutes', 'ninety').stderr,
    /non-negative number/
  );
  assert.match(
    cli(dir, 'cost', ...base, '--spend', '3', '--currency', 'usd').stderr,
    /ISO 4217/
  );
  assert.equal(
    cli(
      dir,
      'cost',
      ...base,
      '--minutes',
      '95',
      '--spend',
      '3.40',
      '--currency',
      'USD'
    ).status,
    0
  );
  const again = cli(dir, 'cost', ...base, '--minutes', '50');
  assert.equal(again.status, 2);
  assert.match(again.stderr, /pass --replace/);
  assert.equal(
    cli(dir, 'cost', ...base, '--minutes', '50', '--replace').status,
    0
  );
  const doc = JSON.parse(
    readFileSync(join(dir, 'outcomes/costs/S-1.json'), 'utf8')
  );
  assert.equal(validateValue(doc, COST_SCHEMA).ok, true);
  assert.equal(doc.runs.length, 1);
  assert.equal(doc.runs[0].operator_minutes, 50);
  assert.equal(
    'spend' in doc.runs[0],
    false,
    'a replaced entry is the new one'
  );
  assert.match(cli(dir, 'nothing').stderr, /escaped-defect or cost/);
});

test('npm run metrics renders every outcome section on fixture runs, and /evolve reports a fired trigger', (t) => {
  const dir = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const n of [1, 2, 3]) {
    const r = cli(
      dir,
      'escaped-defect',
      '--story',
      'S-1',
      '--run',
      'a',
      '--summary',
      `Defect number ${n} slipped past TC-001.`,
      ...ESCAPE_ARGS.slice(2),
      '--risk',
      'RISK-001',
      '--case',
      'TC-001',
      '--why-missed',
      'test_passed_wrongly'
    );
    assert.equal(r.status, 0, `${n}: ${r.stderr}`);
  }
  assert.equal(
    cli(
      dir,
      'cost',
      '--story',
      'S-1',
      '--run',
      'a',
      '--minutes',
      '95',
      '--by',
      'x'
    ).status,
    0
  );
  // S-2's run is known by the id its failure analysis records; its cost
  // entry must be counted against that same run.
  assert.equal(
    cli(
      dir,
      'cost',
      '--story',
      'S-2',
      '--run',
      'run-c',
      '--minutes',
      '5',
      '--by',
      'x'
    ).status,
    0
  );
  // An invalid record is left out and counted, never read.
  writeFileSync(
    join(dir, 'outcomes/escaped-defects/ESC-009.json'),
    '{"escaped_defect_id":"ESC-009"}'
  );

  const m = spawnSync(
    execPath,
    [join(REPO, 'scripts', 'pipeline-metrics.js')],
    { cwd: dir, encoding: 'utf8' }
  );
  assert.equal(m.status, 0, m.stderr);
  const json = JSON.parse(
    readFileSync(join(dir, 'metrics/pipeline-metrics.json'), 'utf8')
  );
  const md = readFileSync(join(dir, 'metrics/pipeline-metrics.md'), 'utf8');
  for (const heading of [
    'Gate time',
    'Rounds to approval',
    'Gate 2 canaries',
    'Gate 4 scan findings answered',
    'Flake rate in the repeat checks',
    'Heals per test',
    'Escaped defects',
    'Cost and time per story',
    'Dual-judge re-evaluation trigger',
  ])
    assert.match(md, new RegExp(`^## ${heading}$`, 'm'), heading);

  // Three runs (the demo is not one): 60 min at the gates in each.
  assert.equal(json.total_runs, 3);
  assert.equal(json.gate_time.decisions_timed, 9);
  assert.equal(json.gate_time.median_minutes_per_run, 60);
  assert.equal(
    json.rounds_to_approval.by_gate.requirements_reviewed.mean_rounds,
    2
  );
  assert.equal(json.repeat_check_flakes.checks, 6);
  assert.equal(json.repeat_check_flakes.flaky_checks.count, 3);
  assert.equal(json.escaped_defects.recorded, 3);
  assert.equal(json.escaped_defects.invalid_records, 1);
  assert.equal(json.cost_per_story.overall.operator_minutes.total, 100);
  assert.equal(json.cost_per_story.entries_not_counted, 0);
  assert.equal(json.dual_judge_trigger.fired, true);
  assert.match(md, /- FIRED: re-open the evaluation/);
  assert.match(md, /1 record\(s\) left out: they do not validate/);
  assert.match(md, /Repeat checks that found a flaky test: 3\/6 = 50%/);

  const e = spawnSync(
    execPath,
    [join(REPO, 'scripts', 'evolve.js'), '--json'],
    { cwd: dir, encoding: 'utf8' }
  );
  assert.match(e.stdout, /"theme": "dual-judge-trigger-fired"/);
});
