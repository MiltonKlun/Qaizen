// The AI reviewers' cases in the agent regression set: defects seeded into a
// faithful BENCH-2 spec and test, and a faithful control for each reviewer.
// A review passes a seeded case when it raises the defect above "info" and
// nothing above "info" about the faithful cases; it passes a control when it
// raises nothing above "info". The evaluation reports each reviewer's catch
// and false-alarm rates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateValue } from '../scripts/lib/artifact-io.js';
import {
  findingTypes,
  REVIEWER_AGENTS,
} from '../scripts/lib/regression-checks.js';
import {
  caseDigest,
  caseErrors,
  evaluateSet,
  INPUT_FILES,
  loadInput,
  MANIFEST,
  reportLines,
  scoreTrial,
  SET_DIR,
} from '../scripts/lib/regression-eval.js';

const REPO = process.cwd();
const SET = JSON.parse(readFileSync(join(REPO, MANIFEST), 'utf8'));
const MANIFEST_TEXT = readFileSync(join(REPO, MANIFEST), 'utf8');
const byId = (/** @type {string} */ id) => SET.cases.find((c) => c.id === id);
const input = (/** @type {string} */ id) => loadInput(REPO, byId(id));
const validate = (/** @type {any} */ v, /** @type {string} */ name) => {
  const r = validateValue(v, join(REPO, 'schemas', name));
  return { ok: r.ok, detail: r.ok ? '' : r.message };
};
const REVIEWER_CASES = SET.cases.filter((c) =>
  REVIEWER_AGENTS.includes(c.agent)
);
const SEEDED = REVIEWER_CASES.filter((c) =>
  c.checks.some((x) => x.check === 'finds')
);
const finds = (/** @type {any} */ c) =>
  c.checks.find((x) => x.check === 'finds');

const SPEC_TEMPLATE = JSON.parse(
  readFileSync(
    join(REPO, 'examples/expected/spec-review-bound.expected-spec-review.json'),
    'utf8'
  )
);
const TEST_TEMPLATE = JSON.parse(
  readFileSync(
    join(REPO, 'examples/expected/bench-shop.expected-test-review.json'),
    'utf8'
  )
);

/**
 * A review of a case's inputs, carrying its digest and round 1.
 * @param {string} id
 * @param {any[]} findings
 * @param {Record<string, unknown>} [over]
 */
function review(id, findings, over = {}) {
  const c = byId(id);
  const template = c.agent === 'spec-reviewer' ? SPEC_TEMPLATE : TEST_TEMPLATE;
  return JSON.stringify({
    ...template,
    story_id: 'BENCH-2',
    input_digest: input(id).digest,
    round: 1,
    findings,
    ...(c.agent === 'spec-reviewer'
      ? {
          risk_coverage: [],
          uncovered_risks: [],
          uncovered_high_severity_count: 0,
        }
      : {}),
    ...over,
  });
}
const finding = (
  /** @type {string} */ type,
  /** @type {string | undefined} */ tc_id,
  severity = 'warning'
) => ({ type, ...(tc_id ? { tc_id } : {}), severity, description: 'x' });
/** The review that raises exactly the case's seeded defect. */
const catching = (/** @type {string} */ id) => {
  const f = finds(byId(id));
  return review(id, [finding(f.types[0], f.tc_id)]);
};
const score = (/** @type {string} */ id, /** @type {string} */ out) =>
  scoreTrial(byId(id), input(id), out, validate);
const failed = (/** @type {string} */ id, /** @type {string} */ out) =>
  score(id, out).failed.map((f) => f.check);

test('the reviewer cases: inputs valid, each README carries its digest, one planted defect per seeded case', () => {
  assert.deepEqual(
    REVIEWER_CASES.map((c) => c.id),
    [
      'REG-011',
      'REG-012',
      'REG-013',
      'REG-014',
      'REG-015',
      'REG-016',
      'REG-017',
      'REG-018',
    ]
  );
  for (const c of REVIEWER_CASES) {
    const i = input(c.id);
    assert.deepEqual(caseErrors(c, i), [], c.id);
    assert.equal(c.source.kind, 'seeded-defect');
    assert.ok(validate(i.context, 'context.schema.json').ok, c.id);
    assert.ok(validate(i.cases, 'test-cases.schema.json').ok, c.id);
    assert.equal(i.context.story.id, 'BENCH-2');
    // The review the agent writes must carry this digest: the README prints
    // the runner's instruction with it.
    const readme = readFileSync(
      join(REPO, SET_DIR, c.input, 'README.md'),
      'utf8'
    );
    assert.ok(
      readme.includes(`input_digest: ${i.digest}`),
      `${c.id} README digest`
    );
    assert.ok(readme.includes('round: 1'), c.id);
    // Every input file counts: README is not one.
    assert.equal(INPUT_FILES.includes('README.md'), false);
  }
  // The seeded cases share the faithful approved cases and brief; each
  // changes only the reviewed artifact.
  const control = {
    'spec-reviewer': input('REG-014'),
    'test-reviewer': input('REG-018'),
  };
  for (const c of SEEDED) {
    const i = input(c.id);
    const base =
      control[/** @type {'spec-reviewer' | 'test-reviewer'} */ (c.agent)];
    assert.deepEqual(i.cases, base.cases, c.id);
    assert.equal(i.brief, base.brief, c.id);
    if (c.agent === 'spec-reviewer') assert.notEqual(i.spec, base.spec, c.id);
    else {
      assert.equal(i.spec, base.spec, c.id);
      assert.notEqual(i.test, base.test, c.id);
    }
    assert.notEqual(i.digest, base.digest);
  }
  // The digest reads names and text, in a fixed order.
  assert.notEqual(
    caseDigest({ 'spec.md': 'a', 'test.spec.ts': 'b' }),
    caseDigest({ 'spec.md': 'b', 'test.spec.ts': 'a' })
  );
});

test('a seeded case passes only when the defect is raised above info on its case, with no false alarm', () => {
  for (const c of SEEDED) {
    const f = finds(c);
    assert.deepEqual(score(c.id, catching(c.id)).failed, [], c.id);
    // Any of the fitting types counts; info does not; another case does not.
    for (const type of f.types)
      assert.equal(
        score(c.id, review(c.id, [finding(type, f.tc_id, 'blocker')])).pass,
        true
      );
    assert.deepEqual(
      failed(c.id, review(c.id, [finding(f.types[0], f.tc_id, 'info')])),
      ['finds']
    );
    const other = c.checks.find((x) => x.check === 'no_alarm').tc_ids[0];
    assert.deepEqual(failed(c.id, review(c.id, [finding(f.types[0], other)])), [
      'finds',
      'no_alarm',
    ]);
    // An unrelated type on the right case is not the defect.
    const wrongType = findingTypes(c.agent).find((t) => !f.types.includes(t));
    assert.deepEqual(
      failed(c.id, review(c.id, [finding(wrongType, f.tc_id)])),
      ['finds']
    );
    // A catch with a false alarm beside it fails; an info note beside it does not.
    assert.deepEqual(
      failed(
        c.id,
        review(c.id, [
          finding(f.types[0], f.tc_id),
          finding('traceability_gap', other),
        ])
      ),
      ['no_alarm']
    );
    assert.equal(
      score(
        c.id,
        review(c.id, [
          finding(f.types[0], f.tc_id),
          finding('traceability_gap', other, 'info'),
        ])
      ).pass,
      true
    );
    // An empty review misses the defect.
    assert.deepEqual(failed(c.id, review(c.id, [])), ['finds']);
  }
  // A spec-review finding without a severity weighs on the gate.
  const noSeverity = /** @type {any} */ (
    finding('weak_expected_outcome', 'TC-002')
  );
  delete noSeverity.severity;
  assert.equal(score('REG-011', review('REG-011', [noSeverity])).pass, true);
});

test('a control passes with nothing above info, and fails on any alarm', () => {
  for (const id of ['REG-014', 'REG-018']) {
    assert.equal(score(id, review(id, [])).pass, true);
    assert.equal(
      score(id, review(id, [finding('traceability_gap', 'TC-003', 'info')]))
        .pass,
      true
    );
    assert.deepEqual(
      failed(id, review(id, [finding('traceability_gap', 'TC-003')])),
      ['no_alarm']
    );
    // An alarm about no case is an alarm too.
    assert.deepEqual(
      failed(id, review(id, [finding('traceability_gap', undefined)])),
      ['no_alarm']
    );
  }
});

test('the review must be one the gate would show: schema, version, story, digest, round', () => {
  const id = 'REG-015';
  assert.equal(score(id, catching(id)).pass, true);
  const wrong = (/** @type {Record<string, unknown>} */ over) =>
    score(id, review(id, [finding('weak_assertion', 'TC-002')], over)).failed;
  assert.match(
    wrong({ input_digest: 'a'.repeat(64) })[0].detail,
    /input_digest is not the one the case gives/
  );
  assert.match(wrong({ round: 2 })[0].detail, /round 2, the case is round 1/);
  assert.match(wrong({ story_id: 'BENCH-1' })[0].detail, /story_id BENCH-1/);
  assert.match(wrong({ input_digest: 'x' })[0].detail, /does not validate/);
  // A 1.x spec review is never shown, so it is not a valid trial.
  const legacy = score(
    'REG-011',
    JSON.stringify({
      ...JSON.parse(catching('REG-011')),
      schema_version: '1.1',
      input_digest: undefined,
      round: undefined,
      auto_approval_eligible: false,
    })
  );
  assert.deepEqual(
    legacy.failed.map((f) => f.check),
    ['review_valid']
  );
  assert.match(
    legacy.failed[0].detail,
    /schema_version 1.1 is not one the gate shows/
  );
  // Unreadable: no catch, and not quiet either.
  assert.deepEqual(failed(id, 'not json'), [
    'review_valid',
    'finds',
    'no_alarm',
  ]);
});

test('a malformed reviewer check is refused before any trial is read', () => {
  const c = byId('REG-011');
  const errors = (/** @type {any[]} */ checks) =>
    caseErrors({ ...c, checks }, input('REG-011'));
  assert.match(
    errors([{ check: 'finds', types: ['weak_assertion'], tc_id: 'TC-002' }])[0],
    /types must be a non-empty list of spec-reviewer finding types/
  );
  assert.match(
    errors([
      { check: 'finds', types: ['weak_expected_outcome'], tc_id: 'TC-009' },
    ])[0],
    /TC-009 is not a case of the input/
  );
  assert.match(
    errors([{ check: 'no_alarm', tc_ids: ['TC-009'] }])[0],
    /TC-009 not in the input/
  );
  assert.match(errors([{ check: 'no_alarm', text: 'x' }])[0], /takes no text/);
  assert.match(
    caseErrors(
      {
        ...byId('REG-001'),
        checks: [{ check: 'finds', types: ['x'], tc_id: 'TC-001' }],
      },
      input('REG-001')
    )[0],
    /not for the analyst/
  );
});

test("an evaluation reports each reviewer's catch and false-alarm rates, and the results validate", () => {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-reviewer-trials-'));
  try {
    // Trial 1 catches everything cleanly; trial 2 misses REG-011 and raises
    // an alarm on REG-018; trial 3 is unreadable for REG-015.
    for (const c of REVIEWER_CASES)
      for (let n = 1; n <= SET.trials; n++) {
        const quiet = review(c.id, []);
        let out = finds(c) ? catching(c.id) : quiet;
        if (n === 2 && c.id === 'REG-011') out = quiet;
        if (n === 2 && c.id === 'REG-018')
          out = review(c.id, [finding('weak_assertion', 'TC-001')]);
        if (n === 3 && c.id === 'REG-015') out = '{';
        const file =
          c.agent === 'spec-reviewer' ? 'spec-review.json' : 'test-review.json';
        mkdirSync(join(dir, c.id, `trial-${n}`), { recursive: true });
        writeFileSync(join(dir, c.id, `trial-${n}`, file), out);
      }
    const run = (/** @type {string | null} */ agent) =>
      evaluateSet({
        root: REPO,
        manifest: SET,
        manifestText: MANIFEST_TEXT,
        setTree: 'a'.repeat(40),
        trialsDir: dir,
        agent,
        previous: null,
        model: 'model-x',
        harness: 'harness-y',
        now: '2026-11-15T12:00:00.000Z',
        validate,
      });
    const res = run('test-reviewer');
    assert.equal(res.ok, true);
    const doc = /** @type {any} */ (res).doc;
    assert.deepEqual(Object.keys(doc.reviewer_accuracy), ['test-reviewer']);
    const r = doc.reviewer_accuracy['test-reviewer'];
    // 3 seeded cases x 3 trials, one unreadable; 4 no_alarm checks x 3
    // trials, one alarm and one unreadable.
    assert.equal(r.seeded.checks, 9);
    assert.equal(r.seeded.caught, 8);
    assert.equal(r.controls.checks, 12);
    assert.equal(r.controls.alarmed, 2);
    assert.ok(validate(doc, 'regression-results.schema.json').ok);
    assert.deepEqual(
      doc.provenance.prompts['test-reviewer'].map(
        (/** @type {any} */ p) => p.path
      ),
      ['agents/test-reviewer.md']
    );
    const lines = reportLines(doc).join('\n');
    assert.match(lines, /test-reviewer: seeded defects found 8\/9 = 0\.89 \[/);
    assert.match(lines, /false alarms 2\/12 = 0\.17 \[/);
    // REG-015 passes 2 of 3; REG-018 too; no case failed every trial.
    assert.equal(doc.decision.verdict, 'pass');

    // The spec cases: one miss (REG-011, trial 2), no alarm.
    const spec = /** @type {any} */ (run('spec-reviewer')).doc;
    assert.deepEqual(Object.keys(spec.reviewer_accuracy), ['spec-reviewer']);
    assert.equal(spec.reviewer_accuracy['spec-reviewer'].seeded.caught, 8);
    assert.equal(spec.reviewer_accuracy['spec-reviewer'].controls.alarmed, 0);
    // Without --agent every case needs its trials, the other agents' too.
    const all = run(null);
    assert.equal(all.ok, false);
    assert.match(
      /** @type {any} */ (all).errors.join('\n'),
      /REG-001: trial 1 has no output/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
