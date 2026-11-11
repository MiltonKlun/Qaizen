// @ts-check
// Run Playwright against a freshly served Bench Shop, clean or with one
// seeded bug, and return its JSON report (the runs behind the fault check,
// scripts/lib/fault-check.js). Used by the runner's fault step and by
// `npm run benchmark:check`.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { playwrightCli } from './cli.js';

const HELPER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'bench-shop-run.js'
);

/** The longest one run of the generated test may take. */
export const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * One run of Playwright against the Bench Shop.
 * @param {{ bug: string | null, pwArgs: string[], cwd: string,
 *   reportPath: string, outputDir: string,
 *   runEnv?: Record<string, string | undefined> }} input
 *   `pwArgs` starts with `test` and holds the config and file filter; `bug`
 *   null serves the Bench Shop clean
 * @returns {{ ok: true, report: any } | { ok: false, reason: string }}
 */
export function runAgainstBenchShop({
  bug,
  pwArgs,
  cwd,
  reportPath,
  outputDir,
  runEnv = process.env,
}) {
  rmSync(reportPath, { force: true });
  mkdirSync(dirname(reportPath), { recursive: true });
  const run = spawnSync(
    process.execPath,
    [
      HELPER,
      ...(bug ? ['--bug', bug] : []),
      '--',
      playwrightCli(runEnv),
      ...pwArgs,
      '--reporter',
      'json',
      '--output',
      outputDir,
      // A missing snapshot is a failure, never a baseline written here.
      '--update-snapshots',
      'none',
      // One attempt: a retry would hide the failure the fault caused.
      '--retries',
      '0',
      '--workers',
      '1',
    ],
    {
      cwd,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...runEnv, PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath },
      // A run that hangs is stopped: the step reports it, never waits forever.
      timeout: RUN_TIMEOUT_MS,
    }
  );
  if (run.error)
    return {
      ok: false,
      reason: /ETIMEDOUT/.test(String(run.error.message))
        ? `the run ${bug ? `with ${bug}` : 'on the clean app'} took longer than ${RUN_TIMEOUT_MS / 60000} minutes and was stopped`
        : `could not launch the run (${run.error.message})`,
    };
  try {
    return { ok: true, report: JSON.parse(readFileSync(reportPath, 'utf8')) };
  } catch {
    return {
      ok: false,
      reason: `the run ${bug ? `with ${bug}` : 'on the clean app'} exited ${run.status ?? `by signal ${run.signal}`} without a report (${reportPath})`,
    };
  }
}
