// The active-run migration command (task group 2.2b): explicit, dry by
// default, idempotent, never binds an approval, never touches runs/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateValue } from '../scripts/lib/artifact-io.js';

const REPO = process.cwd();
const SCRIPT = join(REPO, 'scripts', 'migrate-run.js');
const CLEANUP = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 100,
};
const gold = (/** @type {string} */ p) =>
  JSON.parse(readFileSync(join(REPO, p), 'utf8'));

/** An active run written before the current contracts. */
function legacyRun() {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-migrate-'));
  const put = (/** @type {string} */ p, /** @type {any} */ v) => {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(
      join(dir, p),
      typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n'
    );
  };
  const ctx = gold('examples/expected/login-success.expected-context.json');
  // Boolean gates: approved before approvals had audit objects or bindings.
  ctx.review_gates = {
    requirements_reviewed: true,
    test_scope_reviewed: true,
    specs_reviewed: false,
    code_reviewed: false,
  };
  delete ctx.gate_decisions;
  Object.assign(ctx.artifact_paths, {
    test_cases: 'test-cases/STORY-001.json',
    failure_analysis: 'analysis/failure-analysis.json',
    release_report_json: 'release/release-report.json',
  });
  put('context.json', ctx);
  const tc = gold('examples/expected/login-success.expected-test-cases.json');
  tc.test_cases[0].testlink_id = '1234';
  put('test-cases/STORY-001.json', tc);
  const report = gold(
    'examples/expected/enhanced-report.expected-release-report.json'
  );
  for (const k of [
    'summary_by_risk_level',
    'open_bugs_summary',
    'untested_high_risk_items',
  ])
    delete report[k];
  put('release/release-report.json', report);
  put(
    'analysis/failure-analysis.json',
    readFileSync(
      join(
        REPO,
        'runs/STORY-010/2026-06-29T05-42-14-389Z/analysis/failure-analysis.json'
      ),
      'utf8'
    )
  );
  put('runs/OLD-1/archive-1/context.json', '{"archived": true}\n');
  return dir;
}

/** Every file under `dir` with its bytes, to prove what changed. */
function snapshot(/** @type {string} */ dir) {
  /** @type {Record<string, string>} */
  const out = {};
  const walk = (/** @type {string} */ rel) => {
    for (const name of readdirSync(join(dir, rel))) {
      const p = rel ? `${rel}/${name}` : name;
      if (statSync(join(dir, p)).isDirectory()) walk(p);
      else out[p] = readFileSync(join(dir, p), 'utf8');
    }
  };
  walk('');
  return out;
}

const migrate = (
  /** @type {string} */ dir,
  /** @type {string[]} */ args = []
) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: 'utf8',
  });

test('a dry run changes nothing and says what would change', () => {
  const dir = legacyRun();
  try {
    const before = snapshot(dir);
    const r = migrate(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Dry run: nothing is written/);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    rmSync(dir, CLEANUP);
  }
});

test('--apply migrates the active run, binds no approval, and leaves runs/ and 1.x evidence alone', () => {
  const dir = legacyRun();
  try {
    const before = snapshot(dir);
    const r = migrate(dir, ['--apply']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const after = snapshot(dir);

    const ctx = JSON.parse(after['context.json']);
    assert.equal(
      validateValue(ctx, join(REPO, 'schemas/context.schema.json')).ok,
      true
    );
    assert.deepEqual(ctx.gate_decisions, []);
    const g = ctx.review_gates.requirements_reviewed;
    assert.equal(g.status, true, 'the decision is carried forward');
    assert.equal(
      'input_digest' in g,
      false,
      'no approval is bound by a migration'
    );
    // ...so the human re-reviews it before anything executes.
    assert.match(
      r.stdout,
      /requirements_reviewed: approved before approvals were bound/
    );
    assert.match(
      r.stdout,
      /test_scope_reviewed: depends on requirements_reviewed/
    );

    const tc = JSON.parse(after['test-cases/STORY-001.json']);
    assert.equal(tc.test_cases[0].external_ids.testlink, '1234');
    const report = JSON.parse(after['release/release-report.json']);
    assert.ok(report.open_bugs_summary, 'the derivable rollup is added');
    assert.equal(
      report.schema_version,
      '1.0',
      'a 1.x report keeps its meaning'
    );

    assert.equal(
      after['analysis/failure-analysis.json'],
      before['analysis/failure-analysis.json']
    );
    assert.match(r.stdout, /is a 1\.x analysis\. It stays valid/);
    assert.equal(
      after['runs/OLD-1/archive-1/context.json'],
      before['runs/OLD-1/archive-1/context.json']
    );
  } finally {
    rmSync(dir, CLEANUP);
  }
});

test('running it again changes nothing', () => {
  const dir = legacyRun();
  try {
    assert.equal(migrate(dir, ['--apply']).status, 0);
    const once = snapshot(dir);
    const again = migrate(dir, ['--apply']);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.deepEqual(snapshot(dir), once);
  } finally {
    rmSync(dir, CLEANUP);
  }
});

test('no active run, a pending transition, or an unknown option is refused', () => {
  const empty = mkdtempSync(join(tmpdir(), 'qaizen-migrate-'));
  const dir = legacyRun();
  try {
    const none = migrate(empty);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /no active run/);

    mkdirSync(join(dir, '.qaizen'), { recursive: true });
    writeFileSync(
      join(dir, '.qaizen', 'transition.json'),
      JSON.stringify({ phase: 'staging' })
    );
    const mid = migrate(dir, ['--apply']);
    assert.equal(mid.status, 2);
    assert.match(mid.stderr, /transition is pending/);

    assert.equal(migrate(dir, ['--force']).status, 2);
  } finally {
    rmSync(empty, CLEANUP);
    rmSync(dir, CLEANUP);
  }
});
