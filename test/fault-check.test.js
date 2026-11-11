// The fault check before Gate 4 (scripts/lib/fault-check.js): a kill is a
// failed `expect`, relevance follows a test's cases to the criteria each
// seeded bug breaks, a test that survives every relevant bug is a weak
// oracle (blocking on the full track), and the runner's faults step runs the
// generated test against a real Bench Shop with each bug switched on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  BENCH_SHOP_FAULTS,
  caseIdsOf,
  criterionIndex,
  faultBriefLine,
  faultProblem,
  faultRecord,
  faultState,
  faultsFor,
  faultsForStory,
  isAssertionError,
  runOutcome,
} from '../scripts/lib/fault-check.js';
import { validateValue } from '../scripts/lib/artifact-io.js';
import { nextStep } from '../scripts/pipeline-state.js';
import { writeCompletedRun } from './helpers/valid-run.js';
import { copyRuntimeConfig } from './helpers/runtime-config.js';

const REPO = process.cwd();
const BENCH2 = JSON.parse(
  readFileSync(
    'examples/evaluation/regressions/cases/REG-007/context.json',
    'utf8'
  )
).acceptance_criteria;

const pwTest = (status, message) => ({
  projectName: 'chromium',
  status,
  results: [
    {
      status: status === 'expected' ? 'passed' : 'failed',
      errors: message ? [{ message }] : [],
    },
  ],
});
const report = (tests) => ({
  suites: [
    {
      title: 'BENCH-2.spec.ts',
      file: 'BENCH-2.spec.ts',
      specs: tests.map(([title, status, message], i) => ({
        title,
        file: 'BENCH-2.spec.ts',
        line: 10 + i,
        column: 1,
        tests: [pwTest(status, message)],
      })),
    },
  ],
});
const EXPECT = 'Error: expect(received).toBe(expected) // Object.is equality';
// An action that failed, with the snippet and call log Playwright prints
// around it: they quote a neighbouring expect( line, which must not count.
const ACTION = [
  'Error: locator.click: Timeout 5000ms exceeded.',
  'Call log:',
  '  - waiting for locator(\'[data-qa="place-order"]\')',
  '',
  '  12 |   await qa(page, "review-order").click();',
  '> 13 |   await qa(page, "place-order").click();',
  '  14 |   expect(items).toBe(4675);',
].join('\n');
// An assertion with a custom message: the message is the first line, the
// matcher line follows (Playwright 1.60).
const CUSTOM = [
  'Error: Items total',
  '',
  'expect(received).toBe(expected) // Object.is equality',
  '',
  'Expected: 4675',
  'Received: 4775',
  '',
  '  20 |   expect(items, "Items total").toBe(4675);',
].join('\n');

test('a kill is a failed expect; an action that fails, a skip or a pass is not', () => {
  assert.equal(runOutcome(pwTest('expected')), 'passed');
  assert.equal(runOutcome(pwTest('unexpected', EXPECT)), 'assertion_failed');
  assert.equal(
    runOutcome(
      pwTest(
        'unexpected',
        'Error: Timed out 5000ms waiting for expect(locator).toHaveText(expected)'
      )
    ),
    'assertion_failed',
    'an expect that timed out is still an assertion'
  );
  assert.equal(
    runOutcome(
      pwTest('unexpected', '\u001b[31mError: expect(\u001b[39mreceived).toBe')
    ),
    'assertion_failed',
    'coloured error text'
  );
  assert.equal(
    runOutcome(pwTest('unexpected', CUSTOM)),
    'assertion_failed',
    'an assertion with its own message'
  );
  assert.equal(
    isAssertionError(
      'Error: Items figure\n\nexpect(locator).toHaveText(expected) failed\n\nLocator: locator(\'[data-qa="sum-items"]\')'
    ),
    true
  );
  assert.equal(
    isAssertionError('Error: Total\n\nexpect.poll(received).toBe(expected)'),
    true
  );
  // An expect( quoted in the snippet or call log of a failed action does not
  // make it an assertion.
  assert.equal(runOutcome(pwTest('unexpected', ACTION)), 'action_failed');
  assert.equal(
    isAssertionError(
      'Error: no amount in ""\n\n  9 |   if (!m) throw new Error(\'no amount\')\n> 10 |   expect(x).toBe(1)'
    ),
    false,
    'a thrown error is not an expect, even beside one'
  );
  assert.equal(
    runOutcome(pwTest('unexpected', 'Test timeout of 30000ms exceeded.')),
    'action_failed'
  );
  assert.equal(runOutcome({ status: 'skipped', results: [] }), 'not_run');
});

test('each Bench Shop fault finds the criterion it breaks in its story', () => {
  assert.deepEqual(
    faultsForStory('BENCH-2').map((f) => f.bug),
    ['wrong-item-total', 'inconsistent-total']
  );
  assert.deepEqual(faultsForStory('STORY-020'), []);
  const indices = faultsForStory('BENCH-2').map((f) =>
    criterionIndex(f, BENCH2)
  );
  assert.deepEqual(indices, [1, 2]);
  const bench1 = JSON.parse(
    readFileSync(
      'examples/evaluation/regressions/cases/REG-006/context.json',
      'utf8'
    )
  ).acceptance_criteria;
  assert.equal(criterionIndex(BENCH_SHOP_FAULTS[0], bench1), 0);
  assert.equal(criterionIndex(BENCH_SHOP_FAULTS[1], ['nothing like it']), null);
  assert.deepEqual(caseIdsOf('the total [TC-002] and TC-003, TC-002'), [
    'TC-002',
    'TC-003',
  ]);
});

const CASES = [
  { test_case_id: 'TC-001', acceptance_criteria_refs: [0] },
  { test_case_id: 'TC-002', acceptance_criteria_refs: [1] },
  { test_case_id: 'TC-003', acceptance_criteria_refs: [2] },
];
const record = (clean, wrong, inconsistent, track = 'standard') =>
  faultRecord({
    inputDigest: 'a'.repeat(64),
    track,
    ranAt: '2026-11-10T10-00-00Z',
    faults: faultsForStory('BENCH-2'),
    criteria: BENCH2,
    cases: CASES,
    clean: report(clean),
    reports: {
      'wrong-item-total': report(wrong),
      'inconsistent-total': report(inconsistent),
    },
  });

test('the kill matrix: strong, weak oracle, no relevant fault, an untraced test, and a failing baseline', () => {
  const titles = [
    'items are the sum [TC-002]',
    'items shown, nothing checked [TC-002]',
    'both products listed [TC-001]',
    'checks the totals',
  ];
  const r = record(
    titles.map((t) => [t, 'expected']),
    [
      [titles[0], 'unexpected', EXPECT],
      [titles[1], 'expected'],
      [titles[2], 'expected'],
      [titles[3], 'expected'],
    ],
    [
      [titles[0], 'expected'],
      [titles[1], 'unexpected', ACTION],
      [titles[2], 'expected'],
      [titles[3], 'unexpected', EXPECT],
    ]
  );
  assert.deepEqual(
    r.units.map((u) => [u.verdict, u.relevant]),
    [
      ['strong', ['wrong-item-total']],
      // Its action failed under an irrelevant bug; it never checked the
      // figure its case is about.
      ['weak_oracle', ['wrong-item-total']],
      ['no_relevant_fault', []],
      // No case named: held to every fault of the story; one kill is enough.
      ['strong', ['wrong-item-total', 'inconsistent-total']],
    ]
  );
  assert.equal(r.outcome, 'weak');
  assert.deepEqual(r.faults, [
    { bug: 'wrong-item-total', criterion_index: 1 },
    { bug: 'inconsistent-total', criterion_index: 2 },
  ]);
  assert.equal(
    validateValue(r, 'schemas/context.schema.json', {
      fragment: '#/properties/fault_check',
    }).ok,
    true
  );

  const failing = record(
    [[titles[0], 'unexpected', EXPECT]],
    [[titles[0], 'unexpected', EXPECT]],
    [[titles[0], 'expected']]
  );
  assert.equal(failing.units[0].verdict, 'baseline_failed');
  assert.equal(failing.outcome, 'baseline_failed');
  assert.equal(
    record([], [], []).outcome,
    'baseline_failed',
    'no test ran at all proves nothing'
  );
});

/** A run folder whose staged story is `text`. */
function storyDir(t, text) {
  const dir = mkdtempSync(join(REPO, '.tmp-runner-tx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'story.md'), text);
  return dir;
}
const BENCH2_STORY = readFileSync(
  'examples/benchmark-app/stories/BENCH-2.md',
  'utf8'
);
const manual = (extra = {}) => ({
  story: { id: 'BENCH-2', source: 'manual', path: 'story.md' },
  ...extra,
});

test('only the Bench Shop story itself has a fault check, not another story with its id', (t) => {
  const same = storyDir(t, BENCH2_STORY.replace(/\n/g, '\r\n') + '\n\n');
  assert.equal(faultsFor(manual(), same).length, 2, 'line endings aside');
  const other = storyDir(
    t,
    '# BENCH-2\nA Jira story in a project keyed BENCH.\n'
  );
  assert.deepEqual(faultsFor(manual(), other), []);
  assert.deepEqual(
    faultsFor(
      { story: { id: 'BENCH-2', source: 'jira', path: 'story.md' } },
      same
    ),
    [],
    'a Jira story is never the toy shop'
  );
  assert.deepEqual(
    faultsFor(
      { story: { ...manual().story, jira_issue_key: 'BENCH-2' } },
      same
    ),
    []
  );
  assert.equal(faultState(manual(), 'x', other).state, 'not_applicable');
});

test('a criterion is found with its quotes and dashes changed; one that is gone holds every test to its fault', () => {
  const fault = faultsForStory('BENCH-2')[1];
  assert.equal(
    criterionIndex(fault, [
      'a',
      'b',
      'then the “Order total” equals the shown “Items” figure   plus the shown “Sales tax”.',
    ]),
    2
  );
  const r = faultRecord({
    inputDigest: 'a'.repeat(64),
    track: 'standard',
    ranAt: '2026-11-10T10:00:00Z',
    faults: faultsForStory('BENCH-2'),
    criteria: ['nothing', 'like', 'the story'],
    cases: CASES,
    clean: report([['lists both [TC-001]', 'expected']]),
    reports: {
      'wrong-item-total': report([['lists both [TC-001]', 'expected']]),
      'inconsistent-total': report([['lists both [TC-001]', 'expected']]),
    },
  });
  assert.deepEqual(r.units[0].relevant, [
    'wrong-item-total',
    'inconsistent-total',
  ]);
  assert.equal(r.units[0].verdict, 'weak_oracle', 'fails closed');
  assert.match(
    faultBriefLine({ state: 'current', record: r }) ?? '',
    /wrong-item-total, inconsistent-total: the criterion it breaks is not in this run's criteria, so every test was held to it/
  );
});

test('Gate 4: a missing, outdated or failing-baseline check blocks; a weak oracle blocks on full only', (t) => {
  const root = storyDir(t, BENCH2_STORY);
  const state = (ctx, digest) => faultState(ctx, digest, root);
  const ctx = (extra = {}) => manual(extra);
  assert.equal(
    state({ story: { id: 'STORY-020' } }, 'x').state,
    'not_applicable'
  );
  assert.equal(
    faultProblem(state({ story: { id: 'OLD-1' } }, 'x'), 'full'),
    null
  );
  assert.equal(
    faultBriefLine(state({ story: { id: 'OLD-1' } }, 'x')),
    null,
    'no fault line for a story the Bench Shop does not model'
  );
  assert.match(
    faultProblem(state(ctx(), 'a'.repeat(64)), 'lite') ?? '',
    /no fault check has run/
  );
  const weak = record(
    [['shown [TC-002]', 'expected']],
    [['shown [TC-002]', 'expected']],
    [['shown [TC-002]', 'expected']]
  );
  const stale = state(ctx({ fault_check: weak }), 'b'.repeat(64));
  assert.equal(stale.state, 'stale');
  assert.match(faultProblem(stale, 'standard') ?? '', /other inputs/);
  const current = state(ctx({ fault_check: weak }), 'a'.repeat(64));
  assert.equal(current.state, 'current');
  assert.equal(faultProblem(current, 'standard'), null);
  assert.match(
    faultProblem(current, 'full') ?? '',
    /weak oracle on the full track: shown \[TC-002\] survives wrong-item-total/
  );
  assert.match(faultBriefLine(current) ?? '', /^ATTENTION: fault check/);
  assert.match(
    faultBriefLine(current) ?? '',
    /weak oracle \(wrong-item-total survived, passed\)/
  );
  const failing = record(
    [['t [TC-002]', 'unexpected', ACTION]],
    [['t [TC-002]', 'unexpected', ACTION]],
    [['t [TC-002]', 'unexpected', ACTION]]
  );
  // A record that could not judge the test is run again on --resume.
  const rerun = state(ctx({ fault_check: failing }), 'a'.repeat(64));
  assert.equal(rerun.state, 'rerun');
  assert.match(
    faultProblem(rerun, 'lite') ?? '',
    /does not pass on the Bench Shop without a seeded bug/
  );
  assert.match(faultBriefLine(rerun) ?? '', /runs again on --resume/);
  const missingRun = record(
    [['shown [TC-002]', 'expected']],
    [],
    [['shown [TC-002]', 'expected']]
  );
  const notRun = state(ctx({ fault_check: missingRun }), 'a'.repeat(64));
  assert.equal(notRun.state, 'rerun', 'a relevant run that did not run');
  assert.match(faultProblem(notRun, 'lite') ?? '', /did not run/);

  // Tests no seeded bug can prove are said, not passed over.
  const unproven = record(
    [['lists both [TC-001]', 'expected']],
    [['lists both [TC-001]', 'expected']],
    [['lists both [TC-001]', 'expected']]
  );
  const line =
    faultBriefLine(state(ctx({ fault_check: unproven }), 'a'.repeat(64))) ?? '';
  assert.match(line, /^ATTENTION: /);
  assert.match(line, /1 test\(s\) not proven by any fault/);
});

test('the faults step comes after the repeat check and before Gate 4, only when asked for', () => {
  const ctx = /** @type {any} */ ({
    status: 'in_progress',
    story: { id: 'BENCH-2' },
    artifact_paths: {
      test_cases: 't',
      planner_brief: 'b',
      playwright_spec: 's',
      generated_test: 'g',
    },
    review_gates: {
      requirements_reviewed: true,
      test_scope_reviewed: true,
      specs_reviewed: true,
      code_reviewed: false,
    },
  });
  const branches = { e2e: true, api: false, external: false };
  assert.equal(
    nextStep(ctx, { branches, repeatCurrent: false, faultCurrent: false }),
    'repeat'
  );
  assert.equal(
    nextStep(ctx, { branches, repeatCurrent: true, faultCurrent: false }),
    'faults'
  );
  assert.equal(
    nextStep(ctx, { branches, repeatCurrent: true, faultCurrent: true }),
    'gate4'
  );
  assert.equal(nextStep(ctx, { branches, repeatCurrent: true }), 'gate4');
});

// ------------------------------------------------------------- the runner

/**
 * A stand-in Playwright CLI. A repeat run gets a stable report; a fault run
 * reads which bug the served Bench Shop has switched on (its page injects
 * window.__BENCH__) and fails, passes or fails an action, by `mode`.
 */
function fakePlaywright(dir, mode) {
  const js = join(dir, '.fakebin', 'fake-pw.mjs');
  mkdirSync(join(dir, '.fakebin'), { recursive: true });
  writeFileSync(
    js,
    `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
const out = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
const spec = (status, message) => ({ title: 'checks the totals', file: 'tests/BENCH-2.spec.ts', line: 3, column: 1,
  tests: [{ projectName: '', status, results: [{ status: status === 'expected' ? 'passed' : 'failed', errors: message ? [{ message }] : [] }] }] });
const write = (specs) => writeFileSync(out, JSON.stringify({ suites: [{ file: 'tests/BENCH-2.spec.ts', specs }], errors: [] }));
if (args.includes('--repeat-each')) {
  const n = Number(args[args.indexOf('--repeat-each') + 1]);
  write(Array.from({ length: n }, () => spec('expected')));
  process.exit(0);
}
const page = await (await fetch(process.env.BASE_URL)).text();
const bugs = JSON.parse(/window\\.__BENCH__ = (\\{.*?\\});/.exec(page)[1]).bugs;
const on = bugs.includes('wrong-item-total');
if (mode === 'strong' && on) write([spec('unexpected', 'Error: expect(received).toBe(expected)')]);
else if (mode === 'action' && bugs.length) write([spec('unexpected', 'Error: locator.click: Timeout 5000ms exceeded.')]);
else if (mode === 'no-tests' && bugs.length) writeFileSync(out, JSON.stringify({ suites: [], errors: [{ message: 'Error: No tests found' }] }));
else write([spec('expected')]);
process.exit(0);
`
  );
  return { ...process.env, QAIZEN_PLAYWRIGHT_CLI: js };
}

function workspace() {
  const dir = mkdtempSync(join(REPO, '.tmp-runner-tx-'));
  cpSync(join(REPO, 'scripts'), join(dir, 'scripts'), { recursive: true });
  cpSync(join(REPO, 'schemas'), join(dir, 'schemas'), { recursive: true });
  for (const d of ['benchmark-app', 'shared'])
    cpSync(join(REPO, 'examples', d), join(dir, 'examples', d), {
      recursive: true,
    });
  copyRuntimeConfig(dir, REPO);
  // The Bench Shop's own story, staged as the run's story: only then does
  // the run have a fault check.
  writeCompletedRun(
    dir,
    { storyId: 'BENCH-2', status: 'in_progress' },
    { 'story.md': BENCH2_STORY }
  );
  const ctxPath = join(dir, 'context.json');
  const ctx = JSON.parse(readFileSync(ctxPath, 'utf8'));
  ctx.review_gates.code_reviewed = false;
  delete ctx.repeat_check;
  delete ctx.fault_check;
  writeFileSync(ctxPath, JSON.stringify(ctx, null, 2));
  return { dir, ctxPath };
}
const run = (dir, args, env) => {
  const r = spawnSync(process.execPath, ['scripts/run-pipeline.js', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

test('the runner runs the fault check against a served Bench Shop and records the kills', () => {
  const { dir, ctxPath } = workspace();
  try {
    const r = run(dir, [], fakePlaywright(dir, 'strong'));
    assert.match(
      r.out,
      /Fault check: tests\/BENCH-2\.spec\.ts against the Bench Shop, clean and with wrong-item-total, inconsistent-total/
    );
    const fc = JSON.parse(readFileSync(ctxPath, 'utf8')).fault_check;
    assert.equal(fc.outcome, 'strong');
    assert.deepEqual(fc.units[0].results, {
      'wrong-item-total': 'assertion_failed',
      'inconsistent-total': 'passed',
    });
    assert.equal(
      validateValue(fc, join(REPO, 'schemas/context.schema.json'), {
        fragment: '#/properties/fault_check',
      }).ok,
      true
    );
    // The check is current, so the run stands at Gate 4.
    assert.match(run(dir, ['--status'], process.env).out, /Next step: gate4/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a weak oracle stops a full-track run before Gate 4, and Gate 4 will not open on it', () => {
  const { dir, ctxPath } = workspace();
  try {
    // The fixture's criteria are about login, so the story is on full.
    const r = run(dir, [], fakePlaywright(dir, 'action'));
    assert.equal(r.code, 1, r.out);
    assert.match(
      r.out,
      /weak oracle on the full track: checks the totals survives wrong-item-total, inconsistent-total/
    );
    const fc = JSON.parse(readFileSync(ctxPath, 'utf8')).fault_check;
    assert.deepEqual(fc.units[0].results, {
      'wrong-item-total': 'action_failed',
      'inconsistent-total': 'action_failed',
    });
    const gate = run(dir, [], process.env);
    assert.equal(gate.code, 2, gate.out);
    assert.match(gate.out, /fault check: weak oracle on the full track/);
    assert.doesNotMatch(gate.out, /GATE PENDING/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run under a fault that loaded no test is an execution error, never a survival', () => {
  const { dir, ctxPath } = workspace();
  try {
    const r = run(dir, [], fakePlaywright(dir, 'no-tests'));
    assert.equal(r.code, 2, r.out);
    assert.match(
      r.out,
      /The run with wrong-item-total reported no test \(Error: No tests found\); this is an execution error/
    );
    assert.equal(
      JSON.parse(readFileSync(ctxPath, 'utf8')).fault_check,
      undefined,
      'nothing is recorded'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
