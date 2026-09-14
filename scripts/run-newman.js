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

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { argv, env, exit, platform } from 'node:process';
import {
  buildPublishedNewmanView,
  assertNoSecrets,
} from './lib/report-sanitization.js';

// Raw reporter outputs: local only, gitignored, and secret-bearing by design.
const RAW_JSON = join('reports', 'newman-results.json');
const RAW_HTML = join('reports', 'newman-html');

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
// Track every literal value injected this run so the published summary can
// redact it. The raw reports below intentionally still contain these values;
// they stay local and gitignored. Only reports/published/ is safe to upload.
const injectedSecrets = [];
if (env.REQRES_API_KEY) {
  args.push('--env-var', `api_key=${env.REQRES_API_KEY}`);
  injectedSecrets.push(env.REQRES_API_KEY);
}

args.push(
  '--reporters',
  'cli,json,htmlextra',
  '--reporter-json-export',
  RAW_JSON,
  '--reporter-htmlextra-export',
  RAW_HTML
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

// ---- publication (task group 1.1, I3) -----------------------------------
// The raw reports above are secret-bearing: Newman records the live x-api-key
// header and resolved environment values. They stay under reports/ (gitignored,
// never uploaded). Build a sanitized, allowlisted summary for publication and
// write it to reports/published/ — the ONLY subtree CI uploads.
//
// A sanitizer failure must prevent publication, so the stale file for this
// collection is removed FIRST: a failed run can never leave an older published
// result behind to be uploaded as if it were current.
const publishedDir = join('reports', 'published');
const publishedPath = join(publishedDir, `newman-${storyId}.json`);

try {
  rmSync(publishedPath, { force: true });
} catch {
  // Nothing to remove; publication below still governs the outcome.
}

if (existsSync(RAW_JSON)) {
  try {
    const report = JSON.parse(readFileSync(RAW_JSON, 'utf8'));
    const view = buildPublishedNewmanView(report, {
      secrets: injectedSecrets,
      collectionId: storyId,
    });
    // Throws if any injected secret survived in any encoded form.
    assertNoSecrets(view, injectedSecrets);
    mkdirSync(publishedDir, { recursive: true });
    writeFileSync(publishedPath, JSON.stringify(view, null, 2) + '\n');
    console.log(`Published sanitized summary: ${publishedPath}`);
  } catch (e) {
    // Never echo the raw exception: it can carry the secret.
    console.error(
      `Refusing to publish a summary for ${storyId}: ${e instanceof Error ? e.message : 'sanitization failed'}`
    );
    console.error(
      'Raw reports remain under reports/ (local only, secret-bearing).'
    );
    exit(2);
  }
} else {
  console.warn(
    `No raw Newman JSON at ${RAW_JSON}; nothing to publish for ${storyId}.`
  );
}

exit(result.status ?? 1);
