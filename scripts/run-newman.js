#!/usr/bin/env node
// Cross-platform Newman runner for the API branch (Phase 1.5+).
//
// The phase plan's literal `test:api` script used `$STORY_ID` shell
// expansion, which does not work when npm runs scripts through cmd on
// Windows. This wrapper reads STORY_ID from an env var or the first CLI
// arg, builds the collection + environment paths, and shells out to
// newman with the json + htmlextra reporters. Same behaviour on Windows,
// macOS, Linux, and CI.
//
// Usage:
//   STORY_ID=QA-1042 npm run test:api
//   node scripts/run-newman.js QA-1042
//
// Exit codes:
//   0 — newman ran and all assertions passed
//   1 — newman ran and at least one assertion / request failed
//   2 — usage error, or collection/environment file missing

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { argv, env, exit, platform } from 'node:process';

const storyId = env.STORY_ID || argv[2];

if (!storyId) {
  console.error(
    'Usage: STORY_ID=<id> npm run test:api   (or: node scripts/run-newman.js <id>)'
  );
  exit(2);
}

const collection = `api-tests/collections/${storyId}.postman_collection.json`;
const environment = `api-tests/environments/${storyId}.postman_environment.json`;

if (!existsSync(collection)) {
  console.error(`Collection not found: ${collection}`);
  console.error(
    'The API Agent (agents/api-agent.md) produces this from automate_api test cases.'
  );
  exit(2);
}

// The environment is optional: a collection may not need one (e.g. when
// all variables are baked into the collection or pulled from env). Warn
// but proceed without -e if the environment file is absent.
const args = ['run', collection];
if (existsSync(environment)) {
  args.push('-e', environment);
} else {
  console.warn(`Environment not found (continuing without it): ${environment}`);
}

// Inject secrets at run time via --env-var so they never live in the
// committed environment file. The collection references {{api_key}};
// the real value comes from REQRES_API_KEY in the process env (loaded
// from .env). Add more mappings here as other API targets need keys.
if (env.REQRES_API_KEY) {
  args.push('--env-var', `api_key=${env.REQRES_API_KEY}`);
}

args.push(
  '--reporters',
  'cli,json,htmlextra',
  '--reporter-json-export',
  'reports/newman-results.json',
  '--reporter-htmlextra-export',
  'reports/newman-html'
);

// On Windows, npx resolves through newman.cmd; spawnSync needs shell:true
// to find it on PATH. On POSIX, shell:false with the npx binary works.
const isWindows = platform === 'win32';
const result = spawnSync('npx', ['newman', ...args], {
  stdio: 'inherit',
  shell: isWindows,
});

if (result.error) {
  console.error(`Failed to run newman: ${result.error.message}`);
  exit(2);
}

exit(result.status ?? 1);
