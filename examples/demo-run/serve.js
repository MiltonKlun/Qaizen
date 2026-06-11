#!/usr/bin/env node
// Tiny static file server for the demo app (examples/demo-run/app/), run as
// its OWN process by scripts/demo-pipeline.js. It must be a separate process
// because the demo driver drives the runner with spawnSync (synchronous,
// blocks its event loop) — an in-process server could not answer requests
// while the runner runs Playwright. It listens on an ephemeral port and
// prints `PORT <n>` on its first stdout line so the driver can read it.
//
// Offline only: serves files under ./app, nothing else. No network egress.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, resolve } from 'node:path';

const APP_DIR = resolve(join(dirname(fileURLToPath(import.meta.url)), 'app'));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = resolve(join(APP_DIR, rel));
  if (!file.startsWith(APP_DIR) || !existsSync(file)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, {
    'content-type': MIME[extname(file)] || 'text/plain',
    'content-length': body.length,
  });
  res.end(body);
});

server.listen(0, '127.0.0.1', () => {
  // First stdout line is the contract the driver parses.
  process.stdout.write(`PORT ${server.address().port}\n`);
});
