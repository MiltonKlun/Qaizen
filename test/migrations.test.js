// The single-artifact migration scripts (scripts/migrate-*.js): what each
// prints, how it exits, and what it leaves on disk, for a missing file, a
// malformed one, a dry run and an apply. migrate-run.js, which runs them in
// order, has its own tests (test/migrate-run.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { removeTempDir } from './helpers/cleanup.js';

const SCRIPTS = resolve('scripts');

/**
 * Run one migration in a fresh folder holding `files`.
 * @param {import('node:test').TestContext} t
 * @param {string} script
 * @param {Record<string, string>} files
 * @param {string[]} [args]
 */
function migrate(t, script, files, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-migrate-'));
  t.after(() => removeTempDir(dir));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  const r = spawnSync('node', [join(SCRIPTS, script), ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    read: (/** @type {string} */ p) => readFileSync(join(dir, p), 'utf8'),
  };
}

const V1 = JSON.stringify({
  review_gates: { requirements_reviewed: true, test_scope_reviewed: false },
});
const CASES = JSON.stringify({
  test_cases: [{ test_case_id: 'TC-001', testlink_id: 'TL-1' }],
});

test('context migrations: a missing or malformed file exits 2 with its reason, and nothing is written', (t) => {
  for (const script of [
    'migrate-context-v1-to-v2.js',
    'migrate-context-gate-decisions.js',
  ]) {
    const missing = migrate(t, script, {});
    assert.equal(missing.status, 2, script);
    assert.equal(missing.stderr, 'File not found: context.json\n');
    assert.equal(
      migrate(t, script, {}, ['other.json']).stderr,
      'File not found: other.json\n'
    );
    const bad = migrate(t, script, { 'context.json': '{ nope' });
    assert.equal(bad.status, 2, script);
    assert.match(bad.stderr, /^context\.json is not valid JSON: /);
    assert.equal(bad.read('context.json'), '{ nope');
  }
});

test('context migrations: a dry run writes nothing, --apply writes the migrated file', (t) => {
  const dry = migrate(t, 'migrate-context-v1-to-v2.js', { 'context.json': V1 });
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /DRY RUN: 2 gate\(s\) would be migrated/);
  assert.equal(dry.read('context.json'), V1);
  const applied = migrate(
    t,
    'migrate-context-v1-to-v2.js',
    { 'context.json': V1 },
    ['--apply']
  );
  assert.equal(applied.status, 0);
  assert.deepEqual(
    JSON.parse(applied.read('context.json')).review_gates.requirements_reviewed,
    { status: true, reviewer: null, reviewed_at: null, notes: null }
  );
  const log = migrate(
    t,
    'migrate-context-gate-decisions.js',
    { 'c.json': V1 },
    ['c.json', '--apply']
  );
  assert.equal(log.status, 0);
  assert.equal(
    log.read('c.json'),
    JSON.stringify({ ...JSON.parse(V1), gate_decisions: [] }, null, 2) + '\n'
  );
});

test('test-case migration: a missing file exits 2, a malformed one 1, and --apply mirrors the id', (t) => {
  const script = 'migrate-testcases-external-ids.js';
  const missing = migrate(t, script, {}, ['x.json']);
  assert.equal(missing.status, 2);
  assert.equal(missing.stderr, 'File not found: x.json\n');
  const bad = migrate(t, script, { 'x.json': 'nope' }, ['x.json']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^x\.json is not valid JSON: /);
  const applied = migrate(t, script, { 'x.json': CASES }, [
    'x.json',
    '--apply',
  ]);
  assert.equal(applied.status, 0);
  assert.deepEqual(
    JSON.parse(applied.read('x.json')).test_cases[0].external_ids,
    { testlink: 'TL-1' }
  );
});

test('release-report migration: a missing or malformed report exits 2, and a dry run backfills nothing on disk', (t) => {
  const script = 'migrate-release-report-tg12.js';
  const missing = migrate(t, script, {});
  assert.equal(missing.status, 2);
  assert.equal(
    missing.stderr,
    'Report not found: release/release-report.json\n'
  );
  const bad = migrate(t, script, { 'release/release-report.json': 'nope' });
  assert.equal(bad.status, 2);
  assert.match(
    bad.stderr,
    /^release\/release-report\.json is not valid JSON: /
  );
  const report = JSON.stringify({
    bug_drafts: [{ bug_id: 'BUG-001', severity: 'high', status: 'draft' }],
  });
  const dry = migrate(t, script, { 'release/release-report.json': report });
  assert.equal(dry.status, 0);
  assert.match(
    dry.stdout,
    /Backfill for release\/release-report\.json: open_bugs_summary/
  );
  assert.equal(dry.read('release/release-report.json'), report);
});
