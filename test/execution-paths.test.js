// Regression tests for the per-execution report layout and the CI summary's
// honesty rules (task group 3.2).
//
// The layout exists because raw reports went to ONE constant path
// (reports/newman-results.json) regardless of story, collection or run. CI
// loops collections calling `npm run test:api` per collection, so every
// collection's raw evidence but the last was destroyed, and a stale file from
// an unrelated story read as current evidence (finding I4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateComponent,
  newExecutionId,
  resolveExecutionId,
  newmanReportPaths,
  publishedPaths,
  LEGACY_NEWMAN_JSON,
} from '../scripts/lib/execution-paths.js';

const CI_SUMMARY = join(process.cwd(), 'scripts', 'ci-summary.js');

function workspace() {
  return mkdtempSync(join(tmpdir(), 'qz-exec-'));
}

/** Run ci-summary.js inside a throwaway workspace. */
function ciSummary(cwd, env = {}) {
  const r = spawnSync('node', [CI_SUMMARY], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function publish(cwd, executionId, collectionId, { total, failed }) {
  const dir = join(cwd, 'reports', executionId, 'published');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `newman-${collectionId}.json`),
    JSON.stringify({
      collection_id: collectionId,
      stats: { assertions: { total, failed, pending: 0 } },
      failures: Array.from({ length: failed }, () => ({
        error: { message: 'assertion failed' },
      })),
    })
  );
}

// --- path components are untrusted input -----------------------------------

test('a path component that could escape the execution directory is rejected', () => {
  for (const bad of [
    '..',
    '.',
    'a/b',
    'a\\b',
    '../../etc/passwd',
    'story id',
    'story:1',
    '',
    'x'.repeat(121),
  ]) {
    const r = validateComponent(bad, 'story id');
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
    assert.match(r.message, /story id/);
  }
});

test('ordinary ids are accepted', () => {
  for (const good of [
    'QA-1042',
    'STORY_1',
    'checkout.v2',
    'a',
    'x'.repeat(120),
  ]) {
    assert.equal(validateComponent(good, 'story id').ok, true, good);
  }
});

test('a rejection never echoes the offending value', () => {
  // The value can carry injected content; the message must name the field only.
  const sneaky = '../../$(whoami)';
  const r = validateComponent(sneaky, 'collection id');
  assert.equal(r.ok, false);
  assert.equal(r.message.includes(sneaky), false);
});

test('report paths separate collection, story and execution', () => {
  const a = newmanReportPaths('exec-1', 'QA-1042', 'checkout');
  const b = newmanReportPaths('exec-1', 'QA-1042', 'refunds');
  const c = newmanReportPaths('exec-2', 'QA-1042', 'checkout');
  const d = newmanReportPaths('exec-1', 'QA-2000', 'checkout');

  for (const p of [a, b, c, d]) assert.equal(p.ok, true);
  // Four distinct paths where the old layout produced ONE.
  const all = [a.json, b.json, c.json, d.json];
  assert.equal(new Set(all).size, 4);
  assert.notEqual(a.json, LEGACY_NEWMAN_JSON);

  assert.match(
    a.json.split('\\').join('/'),
    /^reports\/exec-1\/newman\/QA-1042\/checkout\.json$/
  );
  // HTML lives beside the JSON, inside the same ignored execution directory.
  assert.match(
    a.html.split('\\').join('/'),
    /^reports\/exec-1\/newman\/QA-1042\/checkout\.html$/
  );
});

test('a bad component propagates as a refusal, not a path', () => {
  const r = newmanReportPaths('exec-1', '../escape', 'checkout');
  assert.equal(r.ok, false);
  assert.equal(r.json, undefined);
});

test('published paths are grouped per execution', () => {
  const p = publishedPaths('exec-1', 'QA-1042', 'checkout');
  assert.equal(p.ok, true);
  assert.match(
    p.json.split('\\').join('/'),
    /^reports\/exec-1\/published\/newman-QA-1042-checkout\.json$/
  );
});

// --- execution identity -----------------------------------------------------

test('a fresh execution id is unique and path-safe', () => {
  const a = newExecutionId();
  const b = newExecutionId();
  assert.notEqual(a, b);
  for (const id of [a, b]) {
    assert.equal(validateComponent(id, 'execution id').ok, true, id);
    assert.match(id, /^exec-/);
  }
});

test('an explicit execution id wins; an inherited one is used; a bad one is refused', () => {
  const explicit = resolveExecutionId('exec-abc', {
    QAIZEN_EXECUTION_ID: 'exec-env',
  });
  assert.deepEqual(explicit, { ok: true, value: 'exec-abc', created: false });

  const inherited = resolveExecutionId(undefined, {
    QAIZEN_EXECUTION_ID: 'exec-env',
  });
  assert.equal(inherited.value, 'exec-env');
  assert.equal(inherited.created, false);

  const created = resolveExecutionId(undefined, {});
  assert.equal(created.ok, true);
  assert.equal(created.created, true);

  // A malformed inherited id is refused rather than silently rewritten: the
  // caller would otherwise not know where its reports went.
  const bad = resolveExecutionId(undefined, { QAIZEN_EXECUTION_ID: '../x' });
  assert.equal(bad.ok, false);
});

// --- the CI summary counts one execution, not all of history ---------------

test('a stale execution does not contribute to the current summary (I4)', () => {
  const cwd = workspace();
  publish(cwd, 'exec-2026-09-01T00-00-00-000Z-old', 'OLD-STORY', {
    total: 5,
    failed: 0,
  });
  publish(cwd, 'exec-2026-09-22T00-00-00-000Z-new', 'QA-1042', {
    total: 4,
    failed: 2,
  });

  const r = ciSummary(cwd);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /QA-1042/);
  // The old story's 5 passing assertions must not appear at all.
  assert.equal(r.out.includes('OLD-STORY'), false, r.out);
  assert.match(r.out, /2 failed/);
});

test('an explicit execution id selects that execution', () => {
  const cwd = workspace();
  publish(cwd, 'exec-2026-09-01T00-00-00-000Z-old', 'OLD-STORY', {
    total: 5,
    failed: 0,
  });
  publish(cwd, 'exec-2026-09-22T00-00-00-000Z-new', 'QA-1042', {
    total: 4,
    failed: 2,
  });

  const r = ciSummary(cwd, {
    QAIZEN_EXECUTION_ID: 'exec-2026-09-01T00-00-00-000Z-old',
  });
  assert.match(r.out, /OLD-STORY/);
  assert.equal(r.out.includes('QA-1042'), false);
});

test('every collection in one execution contributes exactly once', () => {
  const cwd = workspace();
  publish(cwd, 'exec-1', 'checkout', { total: 3, failed: 0 });
  publish(cwd, 'exec-1', 'refunds', { total: 2, failed: 1 });

  const r = ciSummary(cwd);
  assert.match(r.out, /checkout/);
  assert.match(r.out, /refunds/);
  // One row each, plus a combined row.
  const rows = r.out.split('\n').filter((l) => l.startsWith('| API (Newman'));
  assert.equal(rows.length, 2, r.out);
  assert.match(r.out, /\*\*Combined\*\*/);
});

test('an earlier failure survives a later passing collection, in both orders', () => {
  for (const [first, second] of [
    [
      { id: 'a-fails', total: 2, failed: 2 },
      { id: 'b-passes', total: 2, failed: 0 },
    ],
    [
      { id: 'a-passes', total: 2, failed: 0 },
      { id: 'b-fails', total: 2, failed: 2 },
    ],
  ]) {
    const cwd = workspace();
    publish(cwd, 'exec-1', first.id, first);
    publish(cwd, 'exec-1', second.id, second);
    const r = ciSummary(cwd);
    assert.match(
      r.out,
      /2 failed/,
      `order ${first.id} then ${second.id}: ${r.out}`
    );
  }
});

test('a second invocation in the same workspace does not double-count', () => {
  const cwd = workspace();
  publish(cwd, 'exec-1', 'checkout', { total: 3, failed: 1 });
  const first = ciSummary(cwd);
  const second = ciSummary(cwd);
  // Reading is idempotent: the same evidence yields the same tally.
  const tally = (out) =>
    out.split('\n').filter((l) => l.startsWith('| API (Newman')).length;
  assert.equal(tally(first.out), 1);
  assert.equal(tally(second.out), 1);
});

// --- zero verified units is never a pass -----------------------------------

test('reports with zero counted units warn instead of reporting success', () => {
  const cwd = workspace();
  const dir = join(cwd, 'reports', 'exec-1', 'published');
  mkdirSync(dir, { recursive: true });
  // A shape the summary cannot count (or a genuinely empty run): the old code
  // rendered this as ":white_check_mark: No test failures".
  writeFileSync(
    join(dir, 'newman-QA-1042.json'),
    JSON.stringify({
      collection_id: 'QA-1042',
      totals: { assertions: { total: 9 } },
    })
  );

  const r = ciSummary(cwd);
  assert.match(r.out, /Zero verified units/);
  assert.equal(r.out.includes('white_check_mark'), false, r.out);
});

test('a genuinely clean run still reports success', () => {
  const cwd = workspace();
  publish(cwd, 'exec-1', 'checkout', { total: 4, failed: 0 });
  const r = ciSummary(cwd);
  assert.match(r.out, /white_check_mark/);
  assert.match(r.out, /4 unit\(s\) passed/);
});

test('missing reports never claim that all tests passed', () => {
  const cwd = workspace();
  const r = ciSummary(cwd);
  assert.match(r.out, /No execution reports found/);
  assert.equal(r.out.includes('white_check_mark'), false, r.out);
});

test('an execution directory with no published summaries says so', () => {
  const cwd = workspace();
  // The runner refuses to publish for a collection that verified nothing, so
  // an execution directory can legitimately exist with no summaries in it.
  mkdirSync(join(cwd, 'reports', 'exec-1', 'newman', 'QA-1042'), {
    recursive: true,
  });
  const r = ciSummary(cwd);
  assert.equal(r.out.includes('white_check_mark'), false, r.out);
});

// --- the ledger is preferred, and its outcomes are not conflated -----------

test('a normalized ledger is preferred and keeps flaky out of passes', () => {
  const cwd = workspace();
  mkdirSync(join(cwd, 'analysis'), { recursive: true });
  writeFileSync(
    join(cwd, 'analysis', 'execution-ledger.json'),
    JSON.stringify({
      schema_version: '1.0',
      run_id: 'run-1',
      story_id: 'STORY-042',
      generated_at: '2026-09-22T00:00:00.000Z',
      source_executions: [],
      units: [],
      case_outcomes: [],
      totals: {
        units: 6,
        passed: 2,
        failed: 1,
        flaky: 1,
        skipped: 1,
        blocked: 1,
        not_run: 0,
        expected_failure: 0,
        source_error_count: 0,
        unit_pass_rate: 0.3333333333333333,
      },
    })
  );
  // A raw report that would disagree; the ledger must win.
  publish(cwd, 'exec-1', 'checkout', { total: 99, failed: 0 });

  const r = ciSummary(cwd);
  assert.match(r.out, /Execution ledger \(STORY-042\)/);
  assert.equal(r.out.includes('checkout'), false, r.out);
  // failed = failed + blocked + flaky = 3; passed stays strictly 2.
  assert.match(r.out, /\| 6 \| 2 \| 3 \| 1 \| 1 \|/, r.out);
});

test('run-level errors dominate the verdict', () => {
  const cwd = workspace();
  mkdirSync(join(cwd, 'analysis'), { recursive: true });
  writeFileSync(
    join(cwd, 'analysis', 'execution-ledger.json'),
    JSON.stringify({
      schema_version: '1.0',
      run_id: 'run-1',
      story_id: 'STORY-042',
      generated_at: '2026-09-22T00:00:00.000Z',
      source_executions: [],
      units: [],
      case_outcomes: [],
      totals: {
        units: 2,
        passed: 2,
        failed: 0,
        flaky: 0,
        skipped: 0,
        blocked: 0,
        not_run: 0,
        expected_failure: 0,
        source_error_count: 2,
        unit_pass_rate: 1,
      },
    })
  );
  const r = ciSummary(cwd);
  // Every unit passed, but setup failed: that is not a green run.
  assert.match(r.out, /run-level error\(s\)/);
  assert.equal(r.out.includes('white_check_mark'), false, r.out);
});

// --- the runner writes per-execution paths ---------------------------------

test('run-newman refuses a file that is not a usable collection', () => {
  const cwd = workspace();
  mkdirSync(join(cwd, 'api-tests', 'collections'), { recursive: true });
  // Valid JSON, but not a collection. Left to newman this reports NO error and
  // zero executions (a status-only check would call it a pass), and
  // newman-reporter-htmlextra crashes on the missing collection name before
  // any of our diagnostics can run.
  writeFileSync(
    join(cwd, 'api-tests', 'collections', 'ZERO-1.postman_collection.json'),
    JSON.stringify({ not: 'a collection' })
  );

  const r = spawnSync(
    'node',
    [join(process.cwd(), 'scripts', 'run-newman.js'), 'ZERO-1'],
    { cwd, encoding: 'utf8', env: { ...process.env } }
  );
  const out = (r.stdout || '') + (r.stderr || '');
  assert.equal(r.status, 2, out);
  assert.match(out, /Not a usable Postman collection/);
  assert.match(out, /verifies nothing; this is not a pass/);
  // Refused before any report directory was created.
  assert.equal(existsSync(join(cwd, 'reports')), false, out);
});

test('run-newman writes per-execution paths and publishes nothing on failure', () => {
  const cwd = workspace();
  mkdirSync(join(cwd, 'api-tests', 'collections'), { recursive: true });
  // A real collection whose single request cannot connect: newman runs, the
  // request errors, and the assertion fails. Evidence must land under this
  // execution only.
  writeFileSync(
    join(cwd, 'api-tests', 'collections', 'DEAD-1.postman_collection.json'),
    JSON.stringify({
      info: {
        name: 'dead',
        schema:
          'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: 'unreachable',
          event: [
            {
              listen: 'test',
              script: {
                exec: [
                  "pm.test('status is 200', function () { pm.response.to.have.status(200); });",
                ],
              },
            },
          ],
          request: {
            method: 'GET',
            url: {
              raw: 'http://127.0.0.1:39998/x',
              protocol: 'http',
              host: ['127', '0', '0', '1'],
              port: '39998',
              path: ['x'],
            },
          },
        },
      ],
    })
  );

  const r = spawnSync(
    'node',
    [join(process.cwd(), 'scripts', 'run-newman.js'), 'DEAD-1'],
    { cwd, encoding: 'utf8', env: { ...process.env } }
  );
  const out = (r.stdout || '') + (r.stderr || '');
  // A failed request is exit 1, never 0.
  assert.equal(r.status, 1, out);

  const execDirs = readdirSync(join(cwd, 'reports')).filter((d) =>
    d.startsWith('exec-')
  );
  assert.equal(execDirs.length, 1, 'exactly one execution directory');
  // Raw report at the per-execution path, not the legacy constant path.
  assert.equal(
    existsSync(
      join(cwd, 'reports', execDirs[0], 'newman', 'DEAD-1', 'DEAD-1.json')
    ),
    true,
    out
  );
  assert.equal(existsSync(join(cwd, 'reports', 'newman-results.json')), false);
});

test('run-newman rejects an unsafe story id before touching the filesystem', () => {
  const cwd = workspace();
  const r = spawnSync(
    'node',
    [join(process.cwd(), 'scripts', 'run-newman.js'), '../escape'],
    { cwd, encoding: 'utf8', env: { ...process.env } }
  );
  assert.equal(r.status, 2);
  assert.equal(existsSync(join(cwd, 'reports')), false);
});
