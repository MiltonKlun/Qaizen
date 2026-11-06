// The repeat check before Gate 4 (scripts/lib/repeat-check.js): the generated
// test runs N times on two workers, and a test that passes in one run and
// fails in another is flaky, which stops the run before Gate 4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { removeTempDir } from './helpers/cleanup.js';
import {
  REPEAT_EACH,
  REPEAT_WORKERS,
  repeatBriefLine,
  repeatCount,
  repeatLines,
  repeatProblem,
  repeatState,
  summarizeRepeat,
} from '../scripts/lib/repeat-check.js';
import { runRepeatCheck } from '../scripts/run-pipeline.js';

const REPO = process.cwd();

/** A Playwright JSON report: one spec entry per repetition, as --repeat-each writes. */
const report = (/** @type {[string, string][]} */ runs) => ({
  suites: [
    {
      file: 'a.spec.ts',
      specs: runs.map(([title, status]) => ({
        title,
        file: 'a.spec.ts',
        tests: [{ projectName: 'chromium', status }],
      })),
    },
  ],
});

test('the count is 10 on lite and standard, 20 on full, on two workers', () => {
  assert.deepEqual(REPEAT_EACH, { lite: 10, standard: 10, full: 20 });
  assert.equal(repeatCount('full'), 20);
  assert.equal(repeatCount('standard'), 10);
  assert.equal(repeatCount('bogus'), 10);
  assert.ok(REPEAT_WORKERS >= 2);
});

test('each test is judged across its repetitions: stable, failing or flaky', () => {
  const stable = summarizeRepeat(
    report([
      ['ok', 'expected'],
      ['ok', 'expected'],
    ])
  );
  assert.equal(stable.outcome, 'stable');
  assert.deepEqual(stable.units[0], {
    file: 'a.spec.ts',
    title: 'ok',
    project: 'chromium',
    runs: 2,
    passed: 2,
    failed: 0,
    flaky: 0,
    skipped: 0,
  });
  // Fails every run: the app or the test is wrong, not flaky.
  assert.equal(
    summarizeRepeat(
      report([
        ['bug', 'unexpected'],
        ['bug', 'unexpected'],
        ['ok', 'expected'],
        ['ok', 'expected'],
      ])
    ).outcome,
    'failing'
  );
  // Passes once, fails once: flaky, even though Playwright counts no flake.
  const mixed = summarizeRepeat(
    report([
      ['t', 'expected'],
      ['t', 'unexpected'],
      ['bug', 'unexpected'],
      ['bug', 'unexpected'],
    ])
  );
  assert.equal(mixed.outcome, 'flaky');
  // Passing only on a retry is flaky too.
  assert.equal(
    summarizeRepeat(
      report([
        ['t', 'expected'],
        ['t', 'flaky'],
      ])
    ).outcome,
    'flaky'
  );
  assert.deepEqual(summarizeRepeat(null), {
    units: [],
    outcome: 'stable',
    errors: [],
  });
});

const record = (outcome, digest = 'a'.repeat(64)) => ({
  input_digest: digest,
  track: 'standard',
  repeat_each: 10,
  workers: 2,
  ran_at: '2026-11-06T00:00:00Z',
  report: 'reports/repeat/results.json',
  outcome,
  units: [
    {
      file: 'a.spec.ts',
      title: 'checkout [TC-001]',
      project: 'chromium',
      runs: 10,
      passed: outcome === 'stable' ? 10 : outcome === 'flaky' ? 7 : 0,
      failed: outcome === 'stable' ? 0 : outcome === 'flaky' ? 3 : 10,
      flaky: 0,
      skipped: 0,
    },
  ],
});

test('the record holds only while the Gate 4 inputs are what it ran against', () => {
  assert.equal(repeatState({}, 'a'.repeat(64)).state, 'missing');
  const ctx = { repeat_check: record('stable') };
  assert.equal(repeatState(ctx, 'a'.repeat(64)).state, 'current');
  assert.equal(repeatState(ctx, 'b'.repeat(64)).state, 'stale');
});

test('Gate 4 opens on a current stable or failing check, never on a flaky, stale or missing one', () => {
  const at = (outcome, digest) =>
    repeatProblem(
      repeatState({ repeat_check: record(outcome) }, digest ?? 'a'.repeat(64))
    );
  assert.equal(at('stable'), null);
  assert.equal(at('failing'), null);
  assert.match(
    at('flaky'),
    /flaky in the repeat check \(checkout \[TC-001\] \[chromium\]: 7\/10 passed, 3 failed\); fix the test/
  );
  assert.match(at('stable', 'b'.repeat(64)), /other inputs/);
  assert.match(repeatProblem(repeatState({}, 'x')), /no repeat check has run/);
});

test('the Gate 4 brief says how each test fared', () => {
  const brief = (outcome) =>
    repeatBriefLine(
      repeatState({ repeat_check: record(outcome) }, 'a'.repeat(64))
    );
  assert.equal(
    brief('stable'),
    'repeat check: 10 run(s) of each test on 2 workers (standard track): stable\n  - checkout [TC-001] [chromium]: 10/10 passed'
  );
  assert.match(
    brief('failing'),
    /^ATTENTION: repeat check: .*failing \(a test that fails every run points at the app or at the test: judge which\)/
  );
  assert.match(
    repeatBriefLine(
      repeatState({ repeat_check: record('stable') }, 'b'.repeat(64))
    ),
    /^ATTENTION: the repeat check ran against other inputs/
  );
  assert.equal(repeatLines(record('flaky')).length, 2);
});

test('a deliberately flaky test is caught by a real repeat run; a stable one is not', (t) => {
  const dir = mkdtempSync(join(REPO, '.tmp-repeat-'));
  t.after(() => removeTempDir(dir));
  writeFileSync(
    join(dir, 'pw.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: '.', reporter: [['list']] });\n"
  );
  // Fails on every other repetition: the same code, a different result.
  writeFileSync(
    join(dir, 'flaky.spec.ts'),
    "import { test, expect } from '@playwright/test';\ntest('flaky [TC-001]', async ({}, info) => {\n  expect(info.repeatEachIndex % 2).toBe(0);\n});\n"
  );
  writeFileSync(
    join(dir, 'stable.spec.ts'),
    "import { test, expect } from '@playwright/test';\ntest('stable [TC-002]', async () => {\n  expect(1 + 1).toBe(2);\n});\n"
  );
  const run = (file) =>
    runRepeatCheck({
      cwd: REPO,
      pwArgs: ['test', '--config', join(dir, 'pw.config.ts')],
      testPath: join(dir, file),
      repeatEach: 4,
      reportPath: join(dir, 'out', `${file}.json`),
      outputDir: join(dir, 'out', 'test-results'),
    });
  const flaky = run('flaky.spec.ts');
  assert.ok(flaky.ok, !flaky.ok ? flaky.reason : '');
  assert.equal(flaky.ok && flaky.summary.outcome, 'flaky');
  assert.deepEqual(
    flaky.ok &&
      flaky.summary.units.map((u) => [u.title, u.runs, u.passed, u.failed]),
    [['flaky [TC-001]', 4, 2, 2]]
  );
  // Only the named file ran.
  const stable = run('stable.spec.ts');
  assert.equal(stable.ok && stable.summary.outcome, 'stable');
  assert.deepEqual(
    stable.ok && stable.summary.units.map((u) => [u.title, u.passed]),
    [['stable [TC-002]', 4]]
  );
  assert.ok(
    JSON.parse(readFileSync(join(dir, 'out', 'flaky.spec.ts.json'), 'utf8'))
      .suites.length
  );
});

test('tests with the same name in different describe blocks stay two tests', () => {
  const r = summarizeRepeat({
    suites: [
      {
        title: 'a.spec.ts',
        file: 'a.spec.ts',
        suites: ['A', 'B'].flatMap((block, k) => [
          {
            title: block,
            file: 'a.spec.ts',
            specs: [1, 2].map(() => ({
              title: 'works',
              file: 'a.spec.ts',
              line: 3 + k * 5,
              column: 3,
              tests: [
                {
                  projectName: '',
                  status: k === 0 ? 'expected' : 'unexpected',
                },
              ],
            })),
          },
        ]),
      },
    ],
  });
  assert.deepEqual(
    r.units.map((u) => [u.title, u.passed, u.failed]),
    [
      ['A › works', 2, 0],
      ['B › works', 0, 2],
    ]
  );
  assert.equal(r.outcome, 'failing');
});

test('a test skipped every run and an error Playwright reported are said in the brief', () => {
  const r = summarizeRepeat({
    errors: [
      {
        message:
          '\u001b[31mError: global setup failed\u001b[39m\n    at setup.ts:3',
      },
    ],
    suites: [
      {
        file: 'a.spec.ts',
        specs: [
          {
            title: 'skipped',
            file: 'a.spec.ts',
            tests: [{ status: 'skipped' }],
          },
          { title: 'ok', file: 'a.spec.ts', tests: [{ status: 'expected' }] },
        ],
      },
    ],
  });
  assert.deepEqual(r.errors, ['Error: global setup failed']);
  const line = repeatBriefLine(
    repeatState(
      {
        repeat_check: {
          ...record('stable'),
          units: r.units,
          outcome: r.outcome,
          errors: r.errors,
        },
      },
      'a'.repeat(64)
    )
  );
  assert.match(line, /^ATTENTION: repeat check: .*: stable/);
  assert.match(line, /ATTENTION: skipped was skipped in every run/);
  assert.match(
    line,
    /ATTENTION: Playwright reported an error in the repeat run: Error: global setup failed/
  );
});

test('a missing snapshot fails the repeat run and writes no baseline into the test folder', (t) => {
  const dir = mkdtempSync(join(REPO, '.tmp-repeat-snap-'));
  t.after(() => removeTempDir(dir));
  writeFileSync(
    join(dir, 'pw.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: '.' });\n"
  );
  writeFileSync(
    join(dir, 'snap.spec.ts'),
    "import { test, expect } from '@playwright/test';\ntest('snap [TC-001]', async () => {\n  expect('value').toMatchSnapshot('v.txt');\n});\n"
  );
  const r = runRepeatCheck({
    cwd: REPO,
    pwArgs: ['test', '--config', join(dir, 'pw.config.ts')],
    testPath: join(dir, 'snap.spec.ts'),
    repeatEach: 3,
    reportPath: join(dir, 'out', 'r.json'),
    outputDir: join(dir, 'out', 'test-results'),
  });
  assert.ok(r.ok, !r.ok ? r.reason : '');
  assert.equal(r.ok && r.summary.outcome, 'failing');
  assert.equal(existsSync(join(dir, 'snap.spec.ts-snapshots')), false);
});

test('a file that does not load is an execution error that names the cause', (t) => {
  const dir = mkdtempSync(join(REPO, '.tmp-repeat-err-'));
  t.after(() => removeTempDir(dir));
  writeFileSync(
    join(dir, 'pw.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: '.' });\n"
  );
  writeFileSync(
    join(dir, 'broken.spec.ts'),
    "import { test } from '@playwright/test';\ntest('x', async () => {\n"
  );
  const r = runRepeatCheck({
    cwd: REPO,
    pwArgs: ['test', '--config', join(dir, 'pw.config.ts')],
    testPath: join(dir, 'broken.spec.ts'),
    repeatEach: 2,
    reportPath: join(dir, 'out', 'r.json'),
    outputDir: join(dir, 'out', 'test-results'),
  });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /without a report of any test .*: .+/);
});
