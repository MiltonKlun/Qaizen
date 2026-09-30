#!/usr/bin/env node
// Benchmark tooling check (task group 9.2). Serves the Bench Shop baseline (v1)
// and its drifted v2, runs the reviewed login-surface probes with
// scripts/selector-survival.js --probe, and compares the outcome with the
// ground truth in examples/benchmark-app/README.md (drift table): the
// login-button and title test-ids survive; username, password and the .title
// class do not. A mismatch means the app, the probes, or the survival rule
// changed — fix that before measuring a series.
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
  survived: ['login-button-test-id', 'title-test-id'],
  lost: ['password-test-id', 'title-class', 'username-test-id'],
};

async function browserInstalled() {
  try {
    const { chromium } = await import('@playwright/test');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

function serve(version) {
  const child = spawn(process.execPath, [
    SERVER,
    '--version',
    version,
    '--port',
    '0',
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
} finally {
  for (const s of servers) s.stop();
  rmSync(dir, { recursive: true, force: true });
}
exit(code);
