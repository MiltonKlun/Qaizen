#!/usr/bin/env node
// @ts-check
// Run one Node command against a freshly served Bench Shop
// (examples/benchmark-app/serve.js), then stop the server. The fault check
// (scripts/lib/fault-check.js) uses it to run the generated test against the
// Bench Shop with one seeded bug switched on: the server starts on an
// ephemeral port, the command runs with BASE_URL pointing at it, and the
// server stops however the command ends.
//
// Usage:
//   node scripts/bench-shop-run.js [--version v1] [--bug <id> ...] -- <script> [args ...]
//
// <script> runs under this Node (no shell). Its stdout and stderr pass
// through.
//
// Exit codes: the command's own · 2 usage error, or the server did not start

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { argv, env, execPath, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

const SERVER = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  'examples',
  'benchmark-app',
  'serve.js'
);

const sep = argv.indexOf('--');
const own = sep === -1 ? argv.slice(2) : argv.slice(2, sep);
const command = sep === -1 ? [] : argv.slice(sep + 1);
if (!command.length) {
  console.error(
    'Usage: node scripts/bench-shop-run.js [--version v1] [--bug <id> ...] -- <script> [args ...]'
  );
  exit(2);
}
/** @type {string[]} */
const serverArgs = ['--port', '0'];
for (let i = 0; i < own.length; i += 2) {
  if ((own[i] !== '--version' && own[i] !== '--bug') || !own[i + 1]) {
    console.error(`Unknown or incomplete option: ${own[i]}`);
    exit(2);
  }
  serverArgs.push(own[i], own[i + 1]);
}

const server = spawn(execPath, [SERVER, ...serverArgs], {
  stdio: ['ignore', 'pipe', 'ignore'],
});
/** @type {number} */
let port;
try {
  port = await new Promise((resolve, reject) => {
    server.stdout.on('data', (b) => {
      const m = String(b).match(/PORT (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    server.on('error', reject);
    server.on('exit', (code) =>
      reject(new Error(`the Bench Shop server exited (${code})`))
    );
  });
} catch (err) {
  console.error(
    `Could not serve the Bench Shop: ${err instanceof Error ? err.message : err}`
  );
  exit(2);
}

const child = spawn(execPath, command, {
  stdio: 'inherit',
  env: { ...env, BASE_URL: `http://127.0.0.1:${port}/` },
});
const code = await new Promise((resolve) => {
  child.on('close', (c) => resolve(c ?? 1));
  child.on('error', () => resolve(2));
});
server.kill();
exit(code);
