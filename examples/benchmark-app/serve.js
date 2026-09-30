#!/usr/bin/env node
// Bench Shop server (IMPROVEMENT-PLAN-2 Phase 5). Serves a local, MUTABLE shop
// app so the benchmark can measure the two metrics public SauceDemo cannot:
// known_bug_catch_rate (inject a bug, a test catches it iff it goes red) and
// selector_survival_rate (serve the v1 baseline vs a drifted v2). Zero
// dependencies, localhost only; the static serving is shared with the demo app
// (examples/shared/static-server.js).
//
// One app (app/index.html + app/shop.js); the version differences live in
// app/versions.js, and bugs are applied at RUNTIME by injecting
// window.__BENCH__ into the served index.html, never by keeping a buggy copy.
//
// Usage:
//   node examples/benchmark-app/serve.js [--version v1|v2] [--port <n>] [--bug <id> ...]
//
// Flags:
//   --version <id>      which version to serve (default v1; see app/versions.js)
//   --port <n>          port to listen on (default 4173; 0 = ephemeral)
//   --bug <id>          inject a bug (repeatable). Known ids:
//                         stale-badge         cart badge stale on remove until reload
//                         wrong-item-total    overview item total = sum + 1.00
//                         inconsistent-total  total != item total + tax
//
// On listen it prints `PORT <n>` as its first stdout line (same contract as the
// demo server) so a driver can read the chosen port when --port 0 is used.
//
// Exit codes: 0 served (runs until killed) · 2 usage error

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { argv, exit } from 'node:process';

import { serveStatic } from '../shared/static-server.js';
import './app/versions.js';

// --- flags ----------------------------------------------------------------
function one(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')
    ? argv[i + 1]
    : fallback;
}
function many(name) {
  const out = [];
  for (let i = 2; i < argv.length; i++) {
    if (
      argv[i] === `--${name}` &&
      argv[i + 1] &&
      !argv[i + 1].startsWith('--')
    ) {
      out.push(argv[i + 1]);
    }
  }
  return out;
}

const VERSION = one('version', 'v1');
const PORT = Number(one('port', '4173'));
const BUGS = many('bug');

const VERSIONS = Object.keys(globalThis.BENCH_VERSIONS);
const KNOWN_BUGS = ['stale-badge', 'wrong-item-total', 'inconsistent-total'];
if (!VERSIONS.includes(VERSION)) {
  console.error(
    `Unknown --version "${VERSION}". Known: ${VERSIONS.join(', ')} (app/versions.js).`
  );
  exit(2);
}
const unknown = BUGS.filter((b) => !KNOWN_BUGS.includes(b));
if (unknown.length) {
  console.error(
    `Unknown --bug id(s): ${unknown.join(', ')}. Known: ${KNOWN_BUGS.join(', ')}.`
  );
  exit(2);
}
if (Number.isNaN(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`--port must be 0-65535 (got "${one('port', '4173')}").`);
  exit(2);
}

// The config the page reads, injected before its own scripts so the app sees
// the chosen version + bug switches.
const benchScript = `<script>window.__BENCH__ = ${JSON.stringify({ version: VERSION, bugs: BUGS })};</script>`;

const actual = await serveStatic({
  root: join(dirname(fileURLToPath(import.meta.url)), 'app'),
  port: PORT,
  transform: (file, body) =>
    file.endsWith('.html')
      ? Buffer.from(
          body
            .toString('utf8')
            .replace('<!-- __BENCH_INJECT__ -->', benchScript),
          'utf8'
        )
      : body,
});
console.error(
  `Bench Shop ${VERSION} on http://127.0.0.1:${actual}` +
    (BUGS.length ? `  (bugs: ${BUGS.join(', ')})` : '  (no bugs)')
);
