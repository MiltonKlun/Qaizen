// The agent regression set: its checks on the seeded cases, the statistics,
// the pre-registered decision rule, and the evaluator run end to end in a
// throwaway git repository (so the "committed before the run" refusal is real
// and no committed file is written). The last test checks that fixture mode
// leaves its results file alone when nothing changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';

import { validateValue } from '../scripts/lib/artifact-io.js';
import { CHECKS } from '../scripts/lib/regression-checks.js';
import {
  aggregate,
  caseErrors,
  caseResult,
  decide,
  evaluateSet,
  loadInput,
  MANIFEST,
  scoreTrial,
  SET_DIR,
  wilson,
} from '../scripts/lib/regression-eval.js';

const REPO = process.cwd();
const SCRIPT = join(REPO, 'scripts', 'evaluate-agents.js');
const SET = JSON.parse(readFileSync(join(REPO, MANIFEST), 'utf8'));
const byId = (/** @type {string} */ id) => SET.cases.find((c) => c.id === id);
const input = (/** @type {string} */ id) => loadInput(REPO, byId(id));
const validate = (/** @type {any} */ v, /** @type {string} */ name) => {
  const r = validateValue(v, join(REPO, 'schemas', name));
  return { ok: r.ok, detail: r.ok ? '' : r.message };
};
const story = (/** @type {string} */ id) =>
  /** @type {string} */ (input(id).story);
const criteriaOf = (/** @type {string} */ id) =>
  [...story(id).matchAll(/^\d+\. (.*)$/gm)].map((m) => m[1]);
const TEMPLATE_CTX = JSON.parse(
  readFileSync(join(REPO, SET_DIR, 'cases/REG-006/context.json'), 'utf8')
);
const TEMPLATE_TC = JSON.parse(
  readFileSync(
    join(REPO, 'examples/expected/login-success.expected-test-cases.json'),
    'utf8'
  )
).test_cases[0];

/** An Analyst output for a case: its story's criteria unless given. */
function analystOutput(
  /** @type {string} */ id,
  /** @type {{ criteria?: string[], track?: string }} */ {
    criteria = criteriaOf(id),
    track,
  } = {}
) {
  return JSON.stringify({
    ...TEMPLATE_CTX,
    story: {
      id: /\((STORY-\d+)\)/.exec(story(id))?.[1],
      title: 'A story',
      source: 'manual',
      path: 'story.md',
    },
    acceptance_criteria: criteria,
    risks: [{ ...TEMPLATE_CTX.risks[0], related_acs: [0] }],
    track,
    track_floor: undefined,
  });
}

/** A Test Designer output for a case: one case per criterion index given. */
function designerOutput(
  /** @type {string} */ id,
  /** @type {{ ref: number, decision?: string }[]} */ cases
) {
  const ctx = input(id).context;
  return JSON.stringify({
    schema_version: '1.0',
    run_id: ctx.run_id,
    story_id: ctx.story.id,
    test_cases: cases.map(({ ref, decision = 'automate_e2e' }, i) => ({
      ...TEMPLATE_TC,
      test_case_id: `TC-00${i + 1}`,
      risk_ids: [ctx.risks[0].risk_id],
      acceptance_criteria_refs: [ref],
      automation_decision: decision,
      external_ids: undefined,
    })),
  });
}

const trial = (/** @type {string} */ id, /** @type {string} */ out) =>
  scoreTrial(byId(id), input(id), out, validate);
const failedChecks = (/** @type {string} */ id, /** @type {string} */ out) =>
  trial(id, out).failed.map((f) => f.check);

test('Wilson 95% intervals match the published values', () => {
  assert.deepEqual(wilson(7, 10), [0.3968, 0.8922]); // "about 40% to 89%"
  assert.deepEqual(wilson(3, 3), [0.4385, 1]);
  assert.deepEqual(wilson(0, 3), [0, 0.5615]);
  assert.equal(wilson(0, 0), null);
});

test('the committed set is valid, and every case input satisfies its checks', () => {
  assert.ok(validate(SET, 'regression-set.schema.json').ok);
  // The schema names exactly the checks the evaluator has.
  const schema = JSON.parse(
    readFileSync(join(REPO, 'schemas/regression-set.schema.json'), 'utf8')
  );
  assert.deepEqual(
    [
      ...schema.properties.cases.items.properties.checks.items.properties.check
        .enum,
    ].sort(),
    Object.keys(CHECKS).sort()
  );
  for (const c of SET.cases) assert.deepEqual(caseErrors(c, input(c.id)), []);
  assert.deepEqual([...new Set(SET.cases.map((c) => c.source.kind))].sort(), [
    'audit-probe',
    'bench-shop-bug',
    'false-heal',
  ]);
});

test('Analyst cases: the story criteria pass; each probe fails its case', () => {
  for (const id of ['REG-001', 'REG-002', 'REG-003', 'REG-004', 'REG-005'])
    assert.deepEqual(trial(id, analystOutput(id)).failed, [], id);

  const flipped = criteriaOf('REG-001').map((c, i) =>
    i === 0 ? c.replace('more than', 'less than') : c
  );
  assert.match(
    trial('REG-001', analystOutput('REG-001', { criteria: flipped })).failed[0]
      .detail,
    /comparison/
  );
  const cut = [
    'Given a valid coupon code, when the shopper applies it on the cart page, then the discount is applied only when the item total is at least $20.00',
    criteriaOf('REG-002')[1],
  ];
  assert.match(
    trial('REG-002', analystOutput('REG-002', { criteria: cut })).failed[0]
      .detail,
    /cut short/
  );
  const scopeLine = /^- (.*)$/m.exec(story('REG-003'))?.[1] ?? '';
  assert.match(
    trial(
      'REG-003',
      analystOutput('REG-003', {
        criteria: [...criteriaOf('REG-003'), scopeLine],
      })
    ).failed[0].detail,
    /Out of scope/
  );
  assert.match(
    trial(
      'REG-004',
      analystOutput('REG-004', {
        criteria: [
          'the heading should also turn red when the cart holds more than ten items.',
        ],
      })
    ).failed[0].detail,
    /only in a comment/
  );
  // A repeated criterion, a dropped one, and a Description sentence passed off
  // as a criterion: each is a whole passage of the story, and each fails.
  const [a1, a2, a3] = criteriaOf('REG-001');
  const verbatim = (/** @type {string[]} */ criteria) =>
    trial('REG-001', analystOutput('REG-001', { criteria })).failed[0]?.detail;
  assert.match(verbatim([a1, a1, a3]), /AC 2 is not one of the story's/);
  assert.match(verbatim([a1, a2]), /criterion 3 is missing/);
  assert.match(
    verbatim([
      a1,
      a2,
      'The threshold is compared with the item total before tax, and an order of exactly $50.00 still pays for shipping.',
    ]),
    /AC 3 is not one of the story's/
  );
  assert.equal(verbatim([a1, a2, a3]), undefined);
});

test('the track floor: no track or standard is right for a Red-domain story; lite is not', () => {
  for (const track of [undefined, 'standard', 'full'])
    assert.deepEqual(
      failedChecks('REG-005', analystOutput('REG-005', { track })),
      [],
      String(track)
    );
  const lite = trial('REG-005', analystOutput('REG-005', { track: 'lite' }));
  assert.match(
    lite.failed[0].detail,
    /proposed lite, below its floor standard/
  );
  // What the Analyst wrote must carry the payment, so the runner holds it to
  // full: here the criteria are dropped, and with them the Red domain.
  const bare = trial('REG-005', analystOutput('REG-005', { criteria: [] }));
  assert.ok(bare.failed.some((f) => f.check === 'track_floor'));
  assert.equal(trial('REG-005', '{not json').pass, false);
  // A byte-order mark (Windows PowerShell's UTF-8) is not content.
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-bom-'));
  try {
    for (let n = 1; n <= SET.trials; n++) {
      mkdirSync(join(dir, 'REG-005', `trial-${n}`), { recursive: true });
      writeFileSync(
        join(dir, 'REG-005', `trial-${n}`, 'context.json'),
        '﻿' + analystOutput('REG-005')
      );
    }
    const r = evaluateSet({
      root: REPO,
      manifest: { ...SET, cases: [byId('REG-005')] },
      manifestText: '{}',
      setTree: '0'.repeat(40),
      trialsDir: dir,
      agent: null,
      previous: null,
      model: 'm',
      harness: 'h',
      now: '2026-11-07T00:00:00.000Z',
      validate,
    });
    assert.ok(r.ok);
    assert.equal(r.ok && r.doc.cases[0].passed, SET.trials);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Test Designer cases: an automated case for the named criterion is required', () => {
  assert.equal(
    trial('REG-006', designerOutput('REG-006', [{ ref: 0 }])).pass,
    true
  );
  const manual = trial(
    'REG-006',
    designerOutput('REG-006', [{ ref: 0, decision: 'manual' }])
  );
  assert.match(manual.failed[0].detail, /no automated case covers criterion 1/);
  // STORY-020: both money criteria (2 and 3) need one.
  assert.equal(
    trial('REG-007', designerOutput('REG-007', [{ ref: 1 }, { ref: 2 }])).pass,
    true
  );
  assert.deepEqual(
    failedChecks('REG-007', designerOutput('REG-007', [{ ref: 1 }])),
    ['automated_case_for_criterion']
  );
  const dangling = trial('REG-007', designerOutput('REG-007', [{ ref: 9 }]));
  assert.match(dangling.failed[0].detail, /references criterion 9/);
});

test('Healer cases: the false heals fail, declining passes, the control needs the repair', () => {
  const original = /** @type {string} */ (input('REG-008').original);
  assert.equal(trial('REG-008', original).pass, true);
  // Formatting and an explanatory comment are not a change.
  assert.equal(
    trial('REG-008', `// declined: a pricing bug\n${original}\n\n`).pass,
    true
  );
  assert.equal(
    trial('REG-008', original.replace('$39.98', '$40.98')).pass,
    false
  );
  assert.equal(
    trial('REG-008', original.replace("test('TC-002", "test.fixme('TC-002"))
      .pass,
    false
  );
  const badge = /** @type {string} */ (input('REG-009').original);
  assert.equal(
    trial('REG-009', badge.replace(':text-is("1")', ':text-is("2")')).pass,
    false
  );

  const v1 = /** @type {string} */ (input('REG-010').original);
  const repaired = v1.replace(
    'add-to-cart-sauce-labs-backpack',
    'add-sauce-labs-backpack'
  );
  assert.equal(trial('REG-010', repaired).pass, true);
  assert.equal(
    trial(
      'REG-010',
      repaired.replace(
        `'[data-test="add-sauce-labs-backpack"]'`,
        `"[data-test='add-sauce-labs-backpack']"`
      )
    ).pass,
    true,
    'single quotes are the same repair'
  );
  assert.deepEqual(failedChecks('REG-010', v1), [
    'candidate_eligible',
    'candidate_contains',
    'candidate_omits',
  ]);
  // The new id only in a comment, the locator unchanged otherwise.
  assert.deepEqual(
    failedChecks(
      'REG-010',
      v1.replace(
        'await page.locator(\'[data-test="add-to-cart',
        '// now add-sauce-labs-backpack\n  await page.locator(\'[data-test="add-to-cart'
      )
    ),
    ['candidate_eligible', 'candidate_contains', 'candidate_omits']
  );
  const body = trial(
    'REG-010',
    v1.replace('[data-test="add-to-cart-sauce-labs-backpack"]', 'body')
  );
  assert.match(body.failed[0].detail, /guardrails refuse it/);
});

test('a malformed case is refused before any trial is read', () => {
  const c = byId('REG-006');
  const errors = caseErrors(
    {
      ...c,
      checks: [
        { check: 'no_such_check' },
        { check: 'declines' },
        { check: 'automated_case_for_criterion', text: 'nothing like this' },
        { check: 'automated_case_for_criterion', text: 'Given' },
        { check: 'test_cases_valid', texts: ['x'] },
      ],
    },
    input('REG-006')
  );
  assert.equal(errors.length, 6, errors.join('\n'));
  assert.match(errors[0], /unknown check/);
  assert.match(errors[1], /not for the test-designer/);
  assert.match(errors[2], /"declines" needs original/);
  assert.match(errors[3], /names 0 criteria/);
  assert.match(errors[4], /names 3 criteria/);
  assert.match(errors[5], /takes no texts/);
});

test('a Healer trial without its output is missing work, not a decline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-healer-'));
  try {
    for (let n = 1; n <= SET.trials; n++)
      mkdirSync(join(dir, 'REG-008', `trial-${n}`), { recursive: true });
    const r = evaluateSet({
      root: REPO,
      manifest: { ...SET, cases: [byId('REG-008')] },
      manifestText: '{}',
      setTree: '0'.repeat(40),
      trialsDir: dir,
      agent: null,
      previous: null,
      model: 'm',
      harness: 'h',
      now: '2026-11-07T00:00:00.000Z',
      validate,
    });
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.errors[0], /REG-008: trial 1 has no output/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the decision rule: a case failing every trial, or a drop below a comparable previous lower bound, blocks', () => {
  const rule = SET.decision_rule;
  const c = byId('REG-001');
  const t = (/** @type {boolean} */ pass) => ({
    output_sha256: 'a'.repeat(64),
    pass,
    failed: [],
  });
  const good = caseResult(c, [t(true), t(true), t(true)]);
  const flaky = caseResult({ ...c, id: 'REG-002' }, [
    t(true),
    t(false),
    t(true),
  ]);
  const dead = caseResult({ ...c, id: 'REG-003' }, [
    t(false),
    t(false),
    t(false),
  ]);

  assert.equal(good.pass_k, true);
  assert.equal(flaky.pass_k, false);
  assert.deepEqual(flaky.pass_rate, {
    value: 0.6667,
    wilson_95: [0.2077, 0.9385],
  });

  const agg = aggregate([good, flaky]);
  assert.deepEqual(agg.pass_k, {
    cases: 2,
    passed: 1,
    value: 0.5,
    wilson_95: [0.0945, 0.9055],
  });
  assert.equal(decide(rule, 3, [good, flaky], agg, null).verdict, 'pass');
  assert.deepEqual(
    decide(rule, 3, [good, dead], aggregate([good, dead]), null).reasons,
    ['REG-003 failed all 3 trials']
  );
  const previous = {
    source: 'HEAD:x',
    pass_k: { value: 1, wilson_95: /** @type {[number, number]} */ ([0.7, 1]) },
    cases_added: [],
    cases_removed: [],
    set_changed: false,
    compared: true,
  };
  assert.match(
    decide(rule, 3, [good, flaky], agg, previous).reasons[0],
    /pass\^3 is 0.5, below the previous lower bound 0.7/
  );
  // Results scored on another set are not compared.
  assert.equal(
    decide(rule, 3, [good, flaky], agg, { ...previous, compared: false })
      .verdict,
    'pass'
  );
  assert.equal(
    decide(
      { ...rule, block_below_previous_lower_bound: false },
      3,
      [good, flaky],
      agg,
      previous
    ).verdict,
    'pass'
  );
});

// ------------------------------------------------------------ end to end --
const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) =>
  spawnSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, encoding: 'utf8' }
  );

/** A git repository holding the regression set, committed. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-regressions-'));
  cpSync(join(REPO, SET_DIR), join(dir, SET_DIR), { recursive: true });
  for (const p of ['agents/analyst.md', 'skills/receiving-tickets/SKILL.md'])
    cpSync(join(REPO, p), join(dir, p));
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'set']);
  return dir;
}

/** Analyst trials for every Analyst case, all passing unless overridden. */
function analystTrials(
  /** @type {string} */ dir,
  /** @type {Record<string, (n: number) => string>} */ override = {}
) {
  const trials = join(dir, 'trials');
  for (const c of SET.cases.filter((x) => x.agent === 'analyst'))
    for (let n = 1; n <= SET.trials; n++) {
      mkdirSync(join(trials, c.id, `trial-${n}`), { recursive: true });
      writeFileSync(
        join(trials, c.id, `trial-${n}`, 'context.json'),
        override[c.id]?.(n) ?? analystOutput(c.id)
      );
    }
  return trials;
}

const evaluate = (
  /** @type {string} */ dir,
  /** @type {string[]} */ args,
  env = { QAIZEN_MODEL: 'model-x', QAIZEN_HARNESS: 'harness-y' }
) =>
  spawnSync(execPath, [SCRIPT, '--regressions', 'trials', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, QAIZEN_MODEL: '', QAIZEN_HARNESS: '', ...env },
  });

test('an evaluation writes per-case pass^k; an identical re-run leaves the file; the baseline is the committed one', () => {
  const dir = workspace();
  try {
    analystTrials(dir);
    const out = join(dir, 'evidence/regressions/analyst.json');
    const first = evaluate(dir, ['--agent', 'analyst']);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(
      first.stdout,
      /REG-001 \(analyst, audit-probe\): 3\/3, pass\^3 yes/
    );
    assert.match(first.stdout, /Cases passing every trial \(pass\^3\): 5\/5/);
    assert.match(first.stdout, /Decision: PASS/);
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    assert.ok(validate(doc, 'regression-results.schema.json').ok);
    assert.equal(doc.provenance.model, 'model-x');
    assert.equal(doc.provenance.prompts.analyst[0].path, 'agents/analyst.md');
    assert.match(doc.provenance.prompts.analyst[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(
      doc.decision_rule.set_tree,
      git(dir, ['rev-parse', `HEAD:${SET_DIR}`]).stdout.trim()
    );
    assert.equal(doc.previous, null);

    const bytes = readFileSync(out, 'utf8');
    const again = evaluate(dir, ['--agent', 'analyst']);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /unchanged: .* already records these results/);
    assert.equal(readFileSync(out, 'utf8'), bytes);

    // Without a declared model, nothing runs (and nothing is rewritten).
    const anonymous = evaluate(dir, ['--agent', 'analyst'], {});
    assert.equal(anonymous.status, 2);
    assert.match(anonymous.stderr, /Set QAIZEN_MODEL/);
    assert.equal(readFileSync(out, 'utf8'), bytes);

    // The passing results become the committed baseline; a regression is
    // compared with them.
    git(dir, ['add', 'evidence']);
    git(dir, ['commit', '-q', '-m', 'baseline']);
    const drop = (/** @type {string} */ id) => () =>
      analystOutput(id, { criteria: [criteriaOf(id)[0]] });
    analystTrials(dir, {
      'REG-001': drop('REG-001'),
      'REG-002': drop('REG-002'),
      'REG-003': drop('REG-003'),
    });
    const worse = evaluate(dir, ['--agent', 'analyst']);
    assert.equal(worse.status, 1, worse.stdout);
    assert.match(
      worse.stdout,
      /pass\^3 is 0.4, below the previous lower bound 0.5655/
    );
    const next = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(
      next.previous.source,
      'HEAD:evidence/regressions/analyst.json'
    );
    assert.equal(next.previous.compared, true);

    // Re-running the blocked change, its outputs reformatted, still compares
    // with the committed baseline, not with the blocked run.
    analystTrials(dir, {
      'REG-001': () => JSON.stringify(JSON.parse(drop('REG-001')()), null, 2),
      'REG-002': drop('REG-002'),
      'REG-003': drop('REG-003'),
    });
    const rerun = evaluate(dir, ['--agent', 'analyst']);
    assert.equal(rerun.status, 1, rerun.stdout);
    assert.match(rerun.stdout, /wrote evidence\/regressions\/analyst.json/);
    assert.match(rerun.stdout, /below the previous lower bound 0.5655/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the evaluator refuses an uncommitted set, an untracked case, a missing trial and stray arguments, and writes nothing', () => {
  const dir = workspace();
  try {
    const trials = analystTrials(dir);
    const out = join(dir, 'evidence/regressions/analyst.json');

    const manifest = join(dir, MANIFEST);
    writeFileSync(
      manifest,
      readFileSync(manifest, 'utf8').replace('"trials": 3', '"trials": 2')
    );
    const dirty = evaluate(dir, ['--agent', 'analyst']);
    assert.equal(dirty.status, 2);
    assert.match(dirty.stderr, /uncommitted changes/);
    git(dir, ['checkout', '--', MANIFEST]);

    // An untracked file is a change too, whatever git's display setting.
    git(dir, ['config', 'status.showUntrackedFiles', 'no']);
    writeFileSync(join(dir, SET_DIR, 'cases/REG-001/notes.md'), 'x');
    const untracked = evaluate(dir, ['--agent', 'analyst']);
    assert.equal(untracked.status, 2);
    assert.match(untracked.stderr, /uncommitted changes/);
    rmSync(join(dir, SET_DIR, 'cases/REG-001/notes.md'));

    rmSync(join(trials, 'REG-002', 'trial-3'), { recursive: true });
    const missing = evaluate(dir, ['--agent', 'analyst']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /REG-002: trial 3 has no output/);

    for (const args of [
      ['--candidate-dir', 'x'],
      ['--agent', 'analyst', '--agent', 'healer'],
      ['stray'],
    ]) {
      const r = evaluate(dir, args);
      assert.equal(r.status, 2, args.join(' '));
    }
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixture validation leaves its results file alone when the results are the same', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-fixture-results-'));
  try {
    const out = join(dir, 'results.json');
    const run = () =>
      spawnSync(execPath, [SCRIPT, '--out', out], {
        cwd: REPO,
        encoding: 'utf8',
      });
    assert.equal(run().status, 0);
    const bytes = readFileSync(out, 'utf8');
    const second = run();
    assert.equal(second.status, 0);
    assert.match(second.stdout, /unchanged \(same results\)/);
    assert.equal(readFileSync(out, 'utf8'), bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
