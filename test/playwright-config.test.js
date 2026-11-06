// playwright.config.ts: in CI a test gets one retry, a pass only on the retry
// fails the run, and failing tests keep their traces; locally a run is one
// attempt. Traces and failure screenshots land in reports/test-results, the
// path the runner records, and CI never uploads them
// (docs/security-and-data-safety.md §4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

test('a pass only on the retry fails CI, and CI keeps the traces of failing tests', () => {
  // Playwright does not report these two in its resolved config, so the
  // source is read.
  const src = readFileSync(join(REPO, 'playwright.config.ts'), 'utf8');
  assert.match(src, /failOnFlakyTests: CI,/);
  assert.match(
    src,
    /trace: CI \? 'retain-on-failure-and-retries' : 'on-first-retry',/
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
