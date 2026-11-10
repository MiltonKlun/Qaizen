#!/usr/bin/env node
// @ts-check
// Benchmark tooling check. Serves the Bench Shop baseline (v1)
// and its drifted v2, runs the reviewed login-surface probes with
// scripts/selector-survival.js --probe, and compares the outcome with the
// ground truth in examples/benchmark-app/README.md (drift table): the
// sign-in submit and page-heading hooks survive; the user and passphrase hooks
// and the .heading class do not. A mismatch means the app, the probes, or the
// survival rule changed — fix that before measuring a series.
//
// Then it drives one purchase on v1, clean and with each seeded bug, and
// checks that every bug changes exactly the symptom the README documents
// (scripts/lib/bench-shop-check.js), so known_bug_catch_rate has something to
// catch.
//
// Usage: npm run benchmark:check
// Exit codes: 0 matches the ground truth · 1 differs · 3 not measurable here
//   (no Playwright browser, or the harness reported no rate)

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { exit } from 'node:process';
import { fileURLToPath } from 'node:url';

import { BUGS, bugProblems, observePurchase } from './lib/bench-shop-check.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(REPO, 'examples', 'benchmark-app', 'serve.js');
const PROBES = join(
  REPO,
  'examples',
  'benchmark-app',
  'probes',
  'login-surface.probe.mjs'
);
const EXPECTED = {
  survived: ['heading-hook', 'submit-hook'],
  lost: ['heading-class', 'pass-hook', 'user-hook'],
};

async function browserInstalled() {
  try {
    const { chromium } = await import('@playwright/test');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/**
 * @param {string} version
 * @param {string[]} [bugs]
 * @returns {Promise<{ port: number, stop: () => boolean }>}
 */
function serve(version, bugs = []) {
  const child = spawn(process.execPath, [
    SERVER,
    '--version',
    version,
    '--port',
    '0',
    ...bugs.flatMap((b) => ['--bug', b]),
  ]);
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (b) => {
      const m = String(b).match(/PORT (\d+)/);
      if (m) resolve({ port: Number(m[1]), stop: () => child.kill() });
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      reject(new Error(`the ${version} server exited (${code})`))
    );
  });
}

/**
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, out: string }>}
 */
function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: REPO });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    child.on('close', (code) => resolve({ code, out }));
  });
}

if (!(await browserInstalled())) {
  console.log(
    'benchmark:check not run: no Playwright browser installed (npx playwright install chromium).'
  );
  exit(3);
}

const servers = [];
const dir = mkdtempSync(join(tmpdir(), 'qaizen-benchmark-check-'));
let code = 1;
try {
  const v1 = await serve('v1');
  servers.push(v1);
  const v2 = await serve('v2');
  servers.push(v2);
  const out = join(dir, 'survival.json');
  const r = await run([
    join(REPO, 'scripts', 'selector-survival.js'),
    '--probe',
    PROBES,
    '--baseline',
    `v1=http://127.0.0.1:${v1.port}/`,
    '--version',
    `v2=http://127.0.0.1:${v2.port}/`,
    '--out',
    out,
  ]);
  process.stdout.write(r.out);
  if (r.code !== 0 || !existsSync(out)) {
    console.error('benchmark:check: the harness reported no rate (above).');
    code = 3;
  } else {
    const res = JSON.parse(readFileSync(out, 'utf8'));
    /** @type {(a: Iterable<string>, b: Iterable<string>) => boolean} */
    const same = (a, b) => [...a].sort().join() === [...b].sort().join();
    if (
      same(res.survived, EXPECTED.survived) &&
      same(res.lost, EXPECTED.lost)
    ) {
      console.log(
        `\nbenchmark:check OK: ${res.numerator}/${res.denominator} survive, matching the README drift table.`
      );
      code = 0;
    } else {
      console.error(
        `\nbenchmark:check FAILED: survived ${res.survived.join(', ') || '(none)'}; ` +
          `expected ${EXPECTED.survived.join(', ')} (examples/benchmark-app/README.md).`
      );
    }
  }
  if (code === 0) code = await checkBugs();
} finally {
  for (const s of servers) s.stop();
  rmSync(dir, { recursive: true, force: true });
}
exit(code);

/**
 * Every seeded bug toggles its own symptom and nothing else.
 * @returns {Promise<number>} the exit code
 */
async function checkBugs() {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  /** @type {Record<string, import('./lib/bench-shop-check.js').Observation>} */
  const seen = {};
  try {
    for (const bug of ['clean', ...BUGS]) {
      const server = await serve('v1', bug === 'clean' ? [] : [bug]);
      const page = await browser.newPage();
      try {
        seen[bug] = await observePurchase(
          page,
          `http://127.0.0.1:${server.port}/`
        );
      } catch (err) {
        // A hook that moved or a screen that no longer leads on: the
        // purchase could not be made, which is a failure, not a crash.
        const first = String(err instanceof Error ? err.message : err).split(
          '\n'
        )[0];
        console.error(
          `\nbenchmark:check FAILED: the purchase could not be made (${bug}): ${first}`
        );
        return 1;
      } finally {
        await page.close();
        server.stop();
      }
    }
  } finally {
    await browser.close();
  }
  const problems = bugProblems(seen);
  if (problems.length) {
    console.error(
      '\nbenchmark:check FAILED: a seeded bug does not toggle as documented:'
    );
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  const c = seen.clean;
  console.log(
    `benchmark:check OK: clean purchase Items ${c.items / 100}, Sales tax ${c.tax / 100}, Order total ${c.total / 100}; ` +
      `each of ${BUGS.join(', ')} changes only its own symptom.`
  );
  return 0;
}
