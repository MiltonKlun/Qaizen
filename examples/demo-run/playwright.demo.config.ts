import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Demo-only Playwright config (examples/demo-run/, IMPROVEMENT-PLAN Phase 3).
 *
 * The demo driver references this config IN PLACE (it is never copied into the
 * root). `testDir` is pinned to this file's own ./tests, so the demo specs
 * (examples/demo-run/tests/) never touch the repo-root tests/ folder owned by
 * the Playwright Generator (CLAUDE.md §3.2) and are invisible to `npm test`
 * and CI's playwright-full job (root config testDir is ./tests at the root).
 *
 * Playwright runs with cwd = repo root (so it resolves @playwright/test from
 * node_modules). Reports go to PIPELINE_REPORT_DIR (the demo workspace's
 * reports/) when set, so the rule-based classifier reads them there; otherwise
 * a local ./reports next to this config (e.g. a direct `--config` invocation).
 */
const here = dirname(fileURLToPath(import.meta.url));
const reportDir = process.env.PIPELINE_REPORT_DIR || join(here, 'reports');

export default defineConfig({
  testDir: join(here, 'tests'),
  // One worker + no retries: deterministic order, deterministic FAIL-001.
  workers: 1,
  retries: 0,
  reporter: [
    ['json', { outputFile: join(reportDir, 'results.json') }],
    ['html', { outputFolder: join(reportDir, 'html'), open: 'never' }],
    ['list'],
  ],
  use: {
    baseURL: process.env.BASE_URL,
    screenshot: 'only-on-failure',
  },
});
