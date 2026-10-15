// Gate 2 scope coverage (scripts/lib/scope-coverage.js): every acceptance
// criterion and every risk should have an approved case. config/gate-checks.json
// decides whether a gap warns in the brief or keeps the gate closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { execPath } from 'node:process';

import { removeTempDir } from './helpers/cleanup.js';
import { bindGate, runContext, scopeCases } from './helpers/valid-run.js';
import {
  coverageGaps,
  coverageLine,
  coverageMode,
  scopeCoverage,
} from '../scripts/lib/scope-coverage.js';

const REPO = process.cwd();

const context = {
  acceptance_criteria: ['a', 'b', 'c'],
  risks: [
    { risk_id: 'RISK-001' },
    { risk_id: 'RISK-002' },
    { risk_id: 'RISK-003' },
  ],
};
const tc = (id, acs, risks, extra = {}) => ({
  test_case_id: id,
  status: 'approved',
  automation_decision: 'automate_e2e',
  acceptance_criteria_refs: acs,
  risk_ids: risks,
  ...extra,
});

test('criteria and risks without an approved case are named; rejected cases do not count', () => {
  const cov = scopeCoverage(context, {
    test_cases: [
      tc('TC-001', [0], ['RISK-001']),
      tc('TC-002', [1], ['RISK-002'], { status: 'rejected' }),
    ],
  });
  assert.deepEqual(cov.uncoveredAcs, [2, 3]);
  assert.deepEqual(cov.uncoveredRisks, ['RISK-002', 'RISK-003']);
  assert.equal(
    coverageGaps(cov),
    'AC 2, AC 3, RISK-002, RISK-003 have no approved test case'
  );
  assert.equal(
    coverageLine(cov),
    'ATTENTION: AC 2, AC 3, RISK-002, RISK-003 have no approved test case'
  );
});

test('a risk only skip cases address is covered, and shown as accepted without a test', () => {
  const cov = scopeCoverage(context, {
    test_cases: [
      tc('TC-001', [0, 1], ['RISK-001']),
      tc('TC-002', [2], ['RISK-002', 'RISK-003'], {
        automation_decision: 'skip',
      }),
      tc('TC-003', [2], ['RISK-003'], { automation_decision: 'manual' }),
    ],
  });
  assert.equal(coverageGaps(cov), '');
  assert.deepEqual(cov.skipOnlyRisks, ['RISK-002']);
  assert.equal(
    coverageLine(cov),
    'every acceptance criterion (3) and risk (3) has at least one approved case; RISK-002 is accepted without a test (only skip cases)'
  );
  assert.equal(
    coverageGaps(scopeCoverage({ acceptance_criteria: ['x'] }, null)),
    'AC 1 has no approved test case'
  );
});

test('the repository examples cover their own stories', () => {
  const dir = join(REPO, 'examples', 'expected');
  let checked = 0;
  for (const f of readdirSync(dir).filter((n) =>
    n.endsWith('.expected-test-cases.json')
  )) {
    const ctxFile = join(
      dir,
      f.replace('.expected-test-cases.json', '.expected-context.json')
    );
    let ctx;
    try {
      ctx = JSON.parse(readFileSync(ctxFile, 'utf8'));
    } catch {
      continue;
    }
    const doc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    assert.equal(coverageGaps(scopeCoverage(ctx, doc)), '', f);
    checked += 1;
  }
  assert.ok(checked >= 2, `only ${checked} example pairs were checked`);
});

test('the mode is warn unless config/gate-checks.json says block; a bad value is an error', (t) => {
  const root = mkdtempSync(join(REPO, '.tmp-coverage-mode-'));
  t.after(() => removeTempDir(root));
  assert.deepEqual(coverageMode(root), { ok: true, mode: 'warn' });
  mkdirSync(join(root, 'config'));
  const put = (text) =>
    writeFileSync(join(root, 'config', 'gate-checks.json'), text);
  put('{}');
  assert.deepEqual(coverageMode(root), { ok: true, mode: 'warn' });
  put('{"scope_coverage":"block"}');
  assert.deepEqual(coverageMode(root), { ok: true, mode: 'block' });
  put('{"scope_coverage":"strict"}');
  assert.match(coverageMode(root).message, /use "warn" or "block"/);
  put('{not json');
  assert.match(coverageMode(root).message, /not valid JSON/);
  // The shipped setting.
  assert.deepEqual(coverageMode(), { ok: true, mode: 'warn' });
});

/**
 * A run waiting at Gate 2, in a copy of the scripts so its own
 * config/gate-checks.json applies. The scope leaves AC 2 and RISK-009 open.
 */
function gate2Run(t, mode) {
  const dir = mkdtempSync(join(REPO, '.tmp-coverage-run-'));
  t.after(() => removeTempDir(dir));
  for (const d of ['scripts', 'schemas', 'config']) {
    cpSync(join(REPO, d), join(dir, d), { recursive: true });
  }
  writeFileSync(
    join(dir, 'config', 'gate-checks.json'),
    JSON.stringify({ scope_coverage: mode })
  );
  const story = 'COV-1';
  const run = 'run-cov-1';
  const ctx = runContext({
    storyId: story,
    runId: run,
    status: 'in_progress',
    gates: false,
  });
  ctx.acceptance_criteria = ['first', 'second'];
  ctx.risks = [
    {
      risk_id: 'RISK-001',
      description: 'r',
      severity: 'high',
      related_acs: [0],
    },
    {
      risk_id: 'RISK-009',
      description: 'r',
      severity: 'low',
      related_acs: [1],
    },
  ];
  const doc = scopeCases(story, run);
  doc.test_cases = doc.test_cases.map((c) => ({
    ...c,
    acceptance_criteria_refs: [0],
    risk_ids: ['RISK-001'],
  }));
  mkdirSync(join(dir, 'test-cases'));
  mkdirSync(join(dir, 'planner-input'));
  writeFileSync(join(dir, 'story.md'), '# COV-1\n\n1. first\n2. second\n');
  writeFileSync(
    join(dir, 'test-cases', `${story}.json`),
    JSON.stringify(doc, null, 2)
  );
  writeFileSync(
    join(dir, 'planner-input', `${story}.planner-brief.md`),
    'Brief.\n'
  );
  writeFileSync(
    join(dir, 'context.json'),
    JSON.stringify(bindGate(ctx, 'requirements_reviewed', dir), null, 2)
  );
  return spawnSync(execPath, [join(dir, 'scripts', 'run-pipeline.js')], {
    cwd: dir,
    encoding: 'utf8',
    input: '',
  });
}

test('warn: the gate still opens (here: pending, no terminal)', (t) => {
  const r = gate2Run(t, 'warn');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /GATE PENDING: test_scope_reviewed/);
  assert.doesNotMatch(r.stderr, /scope coverage/);
});

test('block: the gate stays closed and says what is missing', (t) => {
  const r = gate2Run(t, 'block');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(
    r.stderr,
    /scope coverage: AC 2, RISK-009 have no approved test case \(config\/gate-checks\.json scope_coverage is "block"\)/
  );
  assert.doesNotMatch(r.stderr, /GATE PENDING/);
});
