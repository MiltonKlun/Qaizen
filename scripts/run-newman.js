#!/usr/bin/env node
// Newman runner for the API branch (Phase 1.5+; report layout from task
// group 3.2).
//
// Reports go to a PER-EXECUTION path:
//
//   reports/<execution-id>/newman/<story-id>/<collection-id>.json
//
// The previous constant path (reports/newman-results.json) was independent of
// story, collection and run, so CI's per-collection loop destroyed every
// collection's raw evidence but the last, and a stale file from an unrelated
// story read as current evidence (finding I4).
//
// Newman is invoked through its Node API rather than `spawnSync('npx', ...,
// {shell: true})`: secrets are passed as values, never interpolated into a
// command line, and there is no shell to quote them wrongly.
//
// Usage:
//   STORY_ID=QA-1042 npm run test:api
//   node scripts/run-newman.js QA-1042 [--collection <id>] [--execution-id <id>]
//
// Exit codes:
//   0 — newman ran, requests executed, and all assertions passed
//   1 — newman ran and at least one assertion / request failed, OR the run
//       verified nothing (zero executed requests is not a pass)
//   2 — usage error, collection missing, or publication refused

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { argv, env, exit } from 'node:process';
import newman from 'newman';

import {
  buildPublishedNewmanView,
  assertNoSecrets,
} from './lib/report-sanitization.js';
import {
  newmanReportPaths,
  publishedPaths,
  ensureReportDir,
  resolveExecutionId,
  validateComponent,
} from './lib/execution-paths.js';

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        console.error(`Error: --${key} requires a value`);
        exit(2);
      }
      flags[key] = value;
      i += 1;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const { flags, positional } = parseFlags(argv.slice(2));
const storyId = flags.story || env.STORY_ID || positional[0];

if (!storyId) {
  console.error(
    'Usage: STORY_ID=<id> npm run test:api   (or: node scripts/run-newman.js <id>)'
  );
  exit(2);
}

const storyCheck = validateComponent(storyId, 'story id');
if (!storyCheck.ok) {
  console.error(`Error: ${storyCheck.message}`);
  exit(2);
}

// The pipeline passes its execution id down so every step's evidence lands in
// one directory; a standalone run mints its own so it can never be confused
// with, or write into, another run's directory.
const execution = resolveExecutionId(flags['execution-id'], env);
if (!execution.ok) {
  console.error(`Error: ${execution.message}`);
  exit(2);
}
const executionId = execution.value;

const collection = `api-tests/collections/${storyId}.postman_collection.json`;
const environment = `api-tests/environments/${storyId}.postman_environment.json`;

if (!existsSync(collection)) {
  console.error(`Collection not found: ${collection}`);
  console.error(
    'The API Agent (agents/api-agent.md) produces this from automate_api test cases.'
  );
  exit(2);
}

// Verify the file is actually a Postman collection BEFORE invoking newman.
//
// Two reasons this cannot be left to newman:
//   * newman accepts arbitrary JSON, reports no error, and returns a summary
//     with zero executions -- which a status-only check reads as a pass;
//   * newman-reporter-htmlextra dereferences `summary.collection.name`
//     unguarded (lib/index.js:377), so a collection without a name crashes the
//     reporter and the process dies before any of our own diagnostics run.
// Checking here turns both into one actionable message.
try {
  const parsed = JSON.parse(readFileSync(collection, 'utf8'));
  const problems = [];
  if (!parsed || typeof parsed !== 'object')
    problems.push('it is not an object');
  if (!parsed?.info?.name) problems.push('info.name is missing');
  if (!Array.isArray(parsed?.item)) problems.push('item[] is missing');
  else if (parsed.item.length === 0) problems.push('item[] is empty');

  if (problems.length) {
    console.error(`Not a usable Postman collection: ${collection}`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '  A collection that cannot run verifies nothing; this is not a pass.'
    );
    exit(2);
  }
} catch {
  console.error(`Collection is not valid JSON: ${collection}`);
  exit(2);
}

// A story may hold several collections; the id distinguishes their reports so
// one never overwrites another.
const collectionId =
  flags.collection || basename(collection, '.postman_collection.json');
const collectionCheck = validateComponent(collectionId, 'collection id');
if (!collectionCheck.ok) {
  console.error(`Error: ${collectionCheck.message}`);
  exit(2);
}

const paths = newmanReportPaths(executionId, storyId, collectionId);
if (!paths.ok) {
  console.error(`Error: ${paths.message}`);
  exit(2);
}
ensureReportDir(paths);

// Inject secrets at run time so they never live in the committed environment
// file. Passed as API values, not shell arguments: nothing is interpolated
// into a command line. The raw reports below still contain these values --
// they stay under reports/ (gitignored) and are never uploaded.
const injectedSecrets = [];
const envVars = [];
if (env.REQRES_API_KEY) {
  envVars.push({ key: 'api_key', value: env.REQRES_API_KEY });
  injectedSecrets.push(env.REQRES_API_KEY);
}

const runOptions = {
  collection,
  reporters: ['cli', 'json', 'htmlextra'],
  reporter: {
    json: { export: paths.json },
    htmlextra: { export: paths.html },
  },
};
if (existsSync(environment)) {
  runOptions.environment = environment;
} else {
  console.warn(`Environment not found (continuing without it): ${environment}`);
}
if (envVars.length) runOptions.envVar = envVars;

console.log(
  `Execution ${executionId} | story ${storyId} | collection ${collectionId}`
);

newman.run(runOptions, (err, summary) => {
  if (err) {
    // Never echo the raw error: newman errors can quote request detail.
    console.error(
      `Failed to run newman: ${err instanceof Error ? err.message : 'unknown error'}`
    );
    exit(2);
  }

  const run = summary?.run ?? {};
  const executed = (run.executions || []).length;
  const assertions = run.stats?.assertions ?? {};
  const failures = (run.failures || []).length;

  // ---- a run that verified nothing is not evidence -----------------------
  // Newman accepts a JSON file that is not a collection, reports no error, and
  // returns a summary with zero executions. Under a status-only check that is
  // exit 0 -- "all assertions passed" -- for a run that verified nothing.
  //
  // This is checked BEFORE publication: a published all-zeros summary is worse
  // than no summary, because ci-summary.js reads zero failures as a green
  // check. Nothing verified must leave nothing publishable.
  if (executed === 0) {
    console.error(
      `No requests executed for ${storyId}/${collectionId}. This verified nothing and is not a pass.`
    );
    console.error(
      '  Check that the collection contains requests and that it is a valid Postman collection.'
    );
    console.error(
      `  Raw reporter output (if any) is under ${paths.dir}; no summary was published.`
    );
    exit(1);
  }

  // ---- publication (task group 1.1, I3) ---------------------------------
  // Published summaries are grouped per execution too, so a CI upload cannot
  // pick up an unrelated run's file.
  const published = publishedPaths(executionId, storyId, collectionId);
  if (!published.ok) {
    console.error(`Error: ${published.message}`);
    exit(2);
  }

  if (existsSync(paths.json)) {
    try {
      const report = JSON.parse(readFileSync(paths.json, 'utf8'));
      const view = buildPublishedNewmanView(report, {
        secrets: injectedSecrets,
        collectionId,
      });
      // Throws if any injected secret survived in any encoded form.
      assertNoSecrets(view, injectedSecrets);
      mkdirSync(published.dir, { recursive: true });
      writeFileSync(published.json, JSON.stringify(view, null, 2) + '\n');
      console.log(`Published sanitized summary: ${published.json}`);
    } catch (e) {
      // Never echo the raw exception: it can carry the secret.
      console.error(
        `Refusing to publish a summary for ${storyId}/${collectionId}: ${
          e instanceof Error ? e.message : 'sanitization failed'
        }`
      );
      console.error(
        'Raw reports remain under reports/ (local only, secret-bearing).'
      );
      exit(2);
    }
  } else {
    console.warn(
      `No raw Newman JSON at ${paths.json}; nothing to publish for ${storyId}/${collectionId}.`
    );
  }

  // ---- exit status -------------------------------------------------------
  console.log(
    `  ${executed} request(s) | assertions: ${assertions.total ?? 0} total, ${assertions.failed ?? 0} failed | ${failures} failure(s)`
  );

  exit(failures > 0 || (assertions.failed ?? 0) > 0 ? 1 : 0);
});
