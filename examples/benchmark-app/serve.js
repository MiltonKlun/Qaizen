#!/usr/bin/env node
// Bench Shop server (IMPROVEMENT-PLAN-2 Phase 5). Serves a local, MUTABLE shop
// app so the benchmark can measure the two metrics public SauceDemo cannot:
// known_bug_catch_rate (inject a bug, a test catches it iff it goes red) and
// selector_survival_rate (serve v1 vs a drifted v2). Extends the zero-dependency
// static-server pattern from examples/demo-run/serve.js — vanilla node:http, no
// npm deps, no network egress beyond localhost.
//
// One app source per version; bugs are applied at RUNTIME by injecting
// window.__BENCH__ into the served index.html, never by keeping a buggy copy.
//
// Usage:
//   node examples/benchmark-app/serve.js [--version v1|v2] [--port <n>] [--bug <id> ...]
//
// Flags:
//   --version <v1|v2>   which app dir to serve (default v1)
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

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, resolve } from 'node:path';
import { argv, exit } from 'node:process';

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

const KNOWN_BUGS = ['stale-badge', 'wrong-item-total', 'inconsistent-total'];
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

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(join(HERE, VERSION));
if (!existsSync(APP_DIR)) {
  console.error(
    `No app version at ${APP_DIR} (expected examples/benchmark-app/${VERSION}/).`
  );
  exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

// The config the page reads. Injected before the app's own scripts so the app
// sees the chosen version + bug switches.
function benchScript() {
  const cfg = JSON.stringify({ version: VERSION, bugs: BUGS });
  return `<script>window.__BENCH__ = ${cfg};</script>`;
}

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = resolve(join(APP_DIR, rel));
  if (!file.startsWith(APP_DIR) || !existsSync(file)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  let body = readFileSync(file);
  const ext = extname(file);
  if (ext === '.html') {
    // Inject __BENCH__ just before the page's own inline config script, which
    // is marked by the sentinel comment below in each index.html.
    const html = body
      .toString('utf8')
      .replace('<!-- __BENCH_INJECT__ -->', benchScript());
    body = Buffer.from(html, 'utf8');
  }
  res.writeHead(200, {
    'content-type': MIME[ext] || 'text/plain',
    'content-length': body.length,
  });
  res.end(body);
});

server.listen(PORT, '127.0.0.1', () => {
  const actual = server.address().port;
  process.stdout.write(`PORT ${actual}\n`);
  console.error(
    `Bench Shop ${VERSION} on http://127.0.0.1:${actual}` +
      (BUGS.length ? `  (bugs: ${BUGS.join(', ')})` : '  (no bugs)')
  );
});
