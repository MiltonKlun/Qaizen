#!/usr/bin/env node
// Tiny static file server for the demo app (examples/demo-run/app/), run as
// its OWN process by scripts/demo-pipeline.js. It must be a separate process
// because the demo driver drives the runner with spawnSync (synchronous,
// blocks its event loop) — an in-process server could not answer requests
// while the runner runs Playwright. It listens on an ephemeral port and
// prints `PORT <n>` on its first stdout line so the driver can read it.
//
// Offline only: serves files under ./app, nothing else. No network egress.
// The serving itself is shared with the benchmark app
// (examples/shared/static-server.js).

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { serveStatic } from '../shared/static-server.js';

await serveStatic({
  root: join(dirname(fileURLToPath(import.meta.url)), 'app'),
  port: 0,
});
