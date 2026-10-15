// The risk matrix (schemas/context.schema.json, agents/analyst.md 3.0.0) and
// the defect history that grounds likelihood (scripts/lib/defect-history.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execPath } from 'node:process';

import { removeTempDir } from './helpers/cleanup.js';
import { runContext } from './helpers/valid-run.js';
import { validateValue } from '../scripts/lib/artifact-io.js';
import {
  collectDefects,
  renderDefectHistory,
} from '../scripts/lib/defect-history.js';

const REPO = process.cwd();
const SCHEMA = join(REPO, 'schemas', 'context.schema.json');
const LEVELS = ['low', 'medium', 'high'];
const MATRIX = {
  low: { low: 'low', medium: 'low', high: 'medium' },
  medium: { low: 'low', medium: 'medium', high: 'high' },
  high: { low: 'medium', medium: 'high', high: 'high' },
};

const withRisk = (risk) => {
  const ctx = runContext({
    storyId: 'RM-1',
    runId: 'run-rm-1',
    status: 'draft',
    gates: false,
  });
  ctx.risks = [
    { risk_id: 'RISK-001', description: 'd', related_acs: [0], ...risk },
  ];
  return ctx;
};
const valid = (risk) => validateValue(withRisk(risk), SCHEMA).ok;

test('every matrix cell accepts its severity and rejects the other two', () => {
  for (const likelihood of LEVELS) {
    for (const impact of LEVELS) {
      for (const severity of LEVELS) {
        assert.equal(
          valid({ likelihood, impact, severity }),
          severity === MATRIX[likelihood][impact],
          `${likelihood} × ${impact} = ${severity}`
        );
      }
    }
  }
});

test('likelihood and impact come together; a severity alone stays valid', () => {
  assert.equal(valid({ likelihood: 'high', severity: 'high' }), false);
  assert.equal(valid({ impact: 'high', severity: 'high' }), false);
  assert.equal(
    valid({ severity: 'medium' }),
    true,
    'contexts before the matrix'
  );
  assert.equal(
    valid({
      likelihood: 'medium',
      impact: 'high',
      severity: 'high',
      likelihood_basis: '',
    }),
    false,
    'an empty basis says nothing'
  );
  assert.equal(
    valid({
      likelihood: 'medium',
      impact: 'high',
      severity: 'high',
      likelihood_basis:
        'No defect history and no linked change; medium by default.',
    }),
    true
  );
});

/** A runs/ folder with one of each kind of archived run. */
function archive(t) {
  const runs = mkdtempSync(join(tmpdir(), 'qaizen-runs-'));
  t.after(() => removeTempDir(runs));
  const put = (rel, value) => {
    mkdirSync(dirname(join(runs, rel)), { recursive: true });
    writeFileSync(
      join(runs, rel),
      typeof value === 'string' ? value : JSON.stringify(value)
    );
  };
  // A demo run: never history.
  put('DEMO-1/r1/DEMO_RUN', 'demo');
  put('DEMO-1/r1/analysis/failure-analysis.json', {
    failures: [
      {
        failure_id: 'FAIL-001',
        classification: 'product_bug',
        test_case_id: 'TC-002',
      },
    ],
  });
  // A run that found a product bug, filed in Jira.
  put('SHOP-3/2026-10-01/context.json', {
    story: { id: 'SHOP-3', title: 'Cart badge' },
    artifact_paths: { test_cases: 'test-cases/SHOP-3.json' },
    risks: [
      {
        risk_id: 'RISK-001',
        description: 'The badge shows a stale count.',
        severity: 'high',
      },
    ],
  });
  put('SHOP-3/2026-10-01/test-cases/SHOP-3.json', {
    test_cases: [{ test_case_id: 'TC-002', risk_ids: ['RISK-001'] }],
  });
  put('SHOP-3/2026-10-01/analysis/failure-analysis.json', {
    failures: [
      {
        failure_id: 'FAIL-001',
        classification: 'product_bug',
        severity: 'red',
        test_case_id: 'TC-002',
        bug_draft_path: 'release/bug-drafts/BUG-001.md',
        classification_reason: 'observed 2 where 1 was required',
      },
      { failure_id: 'FAIL-002', classification: 'flaky', severity: 'yellow' },
    ],
  });
  put(
    'SHOP-3/2026-10-01/release/bug-drafts/BUG-001.md',
    '# BUG-001\n\n## Summary\n\nThe badge keeps a stale count after a remove.\n\n## Jira Issue Key\n\nSHOP-77\n'
  );
  // A run whose failures were not product bugs.
  put('SHOP-5/2026-10-02/analysis/failure-analysis.json', {
    failures: [
      { failure_id: 'FAIL-001', classification: 'environment_issue' },
      { failure_id: 'FAIL-002', classification: 'environment_issue' },
      { failure_id: 'FAIL-003', classification: 'locator_or_selector' },
    ],
  });
  // A partial archive with no analysis.
  put('SHOP-1/2026-09-30/test-cases/SHOP-1.json', { test_cases: [] });
  return runs;
}

test('the history reads every archived run except demos, and keeps product bugs apart', (t) => {
  const runs = archive(t);
  const h = collectDefects(runs);
  assert.deepEqual(
    h.runs.map((r) => [r.story, r.analysed, r.others]),
    [
      ['SHOP-1', false, {}],
      ['SHOP-3', true, { flaky: 1 }],
      ['SHOP-5', true, { environment_issue: 2, locator_or_selector: 1 }],
    ]
  );
  assert.deepEqual(h.bugs, [
    {
      story: 'SHOP-3',
      run: '2026-10-01',
      failure: 'FAIL-001',
      bug: 'BUG-001',
      jira: 'SHOP-77',
      testCase: 'TC-002',
      risks: [
        {
          id: 'RISK-001',
          description: 'The badge shows a stale count.',
          severity: 'high',
        },
      ],
      summary: 'The badge keeps a stale count after a remove.',
    },
  ]);
  const md = renderDefectHistory(h);
  assert.equal(
    md,
    renderDefectHistory(collectDefects(runs)),
    'the same archives give the same file'
  );
  assert.match(
    md,
    /Runs read: 3 · with a failure analysis: 2 · product bugs: 1/
  );
  assert.match(
    md,
    /\| SHOP-3 \| 2026-10-01 \| FAIL-001 \| BUG-001 \(SHOP-77\) \| TC-002 \| RISK-001 \(high\): The badge shows a stale count\. \| The badge keeps a stale count after a remove\. \|/
  );
  assert.match(
    md,
    /\| SHOP-5 \| 2026-10-02 \| environment_issue 2, locator_or_selector 1 \|/
  );
  assert.match(
    md,
    /\| SHOP-1 \| 2026-09-30 \| no failure analysis archived \|/
  );
  assert.doesNotMatch(md, /DEMO-1/);
});

test('no archives, or none with a bug, says so instead of inventing one', (t) => {
  const empty = mkdtempSync(join(tmpdir(), 'qaizen-runs-'));
  t.after(() => removeTempDir(empty));
  const md = renderDefectHistory(collectDefects(join(empty, 'missing')));
  assert.match(
    md,
    /Runs read: 0 · with a failure analysis: 0 · product bugs: 0/
  );
  assert.match(md, /No product bug is recorded in the archived runs yet\./);
});

test('npm run defect-history writes metrics/defect-history.md, or prints it', (t) => {
  const runs = archive(t);
  const out = join(dirname(runs), `qaizen-history-${process.pid}.md`);
  t.after(() => removeTempDir(out));
  const cli = (...args) =>
    spawnSync(
      execPath,
      [join(REPO, 'scripts', 'defect-history.js'), '--runs', runs, ...args],
      {
        encoding: 'utf8',
      }
    );
  const printed = cli('--print');
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, renderDefectHistory(collectDefects(runs)));
  const written = cli('--out', out);
  assert.equal(written.status, 0, written.stderr);
  assert.match(
    written.stdout,
    /Wrote .*: 3 run\(s\) read, 1 product bug\(s\)\./
  );
  assert.equal(readFileSync(out, 'utf8'), printed.stdout);
  assert.equal(cli('--print', '--out', out).status, 2);
  assert.ok(existsSync(out));
});
