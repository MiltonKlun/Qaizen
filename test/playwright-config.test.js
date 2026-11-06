// playwright.config.ts: in CI a test gets one retry, a pass only on the retry
// fails the run, and failing tests keep their traces; locally a run is one
// attempt. Traces and failure screenshots land in reports/test-results, the
// path the runner records, and CI never uploads them
// (docs/security-and-data-safety.md §4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { removeTempDir } from './helpers/cleanup.js';

const REPO = process.cwd();

/** The config as Playwright resolves it, with or without CI set. */
function resolved(ci) {
  const env = { ...process.env };
  if (ci) env.CI = '1';
  else delete env.CI;
  const r = spawnSync(
    process.execPath,
    [
      join(REPO, 'node_modules', '@playwright', 'test', 'cli.js'),
      'test',
      '--list',
      '--reporter=json',
    ],
    { cwd: REPO, env, encoding: 'utf8' }
  );
  return JSON.parse(r.stdout).config;
}

test('CI gets one retry, local runs none; both write to reports/test-results', () => {
  const ci = resolved(true);
  const local = resolved(false);
  assert.deepEqual(
    ci.projects.map((p) => p.retries),
    [1]
  );
  assert.deepEqual(
    local.projects.map((p) => p.retries),
    [0]
  );
  for (const c of [ci, local])
    assert.ok(
      c.projects.every((p) =>
        p.outputDir.replace(/\\/g, '/').endsWith('/reports/test-results')
      ),
      JSON.stringify(c.projects.map((p) => p.outputDir))
    );
});

test('in CI a pass only on the retry fails the run, and both attempts keep their trace', (t) => {
  // A config that is the root one with its own test folder and output.
  const dir = mkdtempSync(join(REPO, '.tmp-pwconfig-'));
  t.after(() => removeTempDir(dir));
  writeFileSync(
    join(dir, 'pw.config.ts'),
    [
      "import { defineConfig } from '@playwright/test';",
      "import base from '../playwright.config';",
      'export default defineConfig({',
      '  ...base,',
      "  testDir: '.',",
      "  outputDir: './out',",
      "  reporter: [['json', { outputFile: './out/report.json' }]],",
      '});',
      '',
    ].join('\n')
  );
  // Fails on the first attempt, passes on the retry.
  writeFileSync(
    join(dir, 'retry.spec.ts'),
    "import { test, expect } from '@playwright/test';\ntest('passes on retry', async ({}, info) => {\n  expect(info.retry).toBe(1);\n});\n"
  );
  const run = (ci) => {
    const env = { ...process.env };
    if (ci) env.CI = '1';
    else delete env.CI;
    const r = spawnSync(
      process.execPath,
      [
        join(REPO, 'node_modules', '@playwright', 'test', 'cli.js'),
        'test',
        '--config',
        join(dir, 'pw.config.ts'),
      ],
      { cwd: REPO, env, encoding: 'utf8' }
    );
    const report = JSON.parse(
      readFileSync(join(dir, 'out', 'report.json'), 'utf8')
    );
    return { status: r.status, stats: report.stats };
  };
  const ci = run(true);
  assert.notEqual(ci.status, 0, 'a flaky pass must fail the run in CI');
  assert.equal(ci.stats.flaky, 1);
  const traces = readdirSync(join(dir, 'out'), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('trace.zip'));
  assert.equal(traces.length, 2, JSON.stringify(traces));
  // Locally there is no retry: the same test simply fails, untraced.
  const local = run(false);
  assert.notEqual(local.status, 0);
  assert.equal(local.stats.unexpected, 1);
  assert.equal(local.stats.flaky, 0);
  assert.equal(
    readdirSync(join(dir, 'out'), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('trace.zip')).length,
    0
  );
});

test('CI uploads the JSON report only: no traces, no HTML report that embeds them', () => {
  const wf = readFileSync(
    join(REPO, '.github', 'workflows', 'qa-pipeline.yml'),
    'utf8'
  );
  const upload = wf.slice(wf.indexOf('name: Upload Playwright report'));
  const step = upload.slice(0, upload.indexOf('retention-days'));
  assert.match(step, /path: reports\/results\.json\n/);
  assert.doesNotMatch(step, /reports\/html|test-results|trace/);
});
