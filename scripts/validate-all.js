#!/usr/bin/env node
// Validate every committed pipeline artifact against its schema (Phase 2
// TG8, the CI "validate all JSON" step). Like validate-examples.js, this
// is NOT a second validator and NOT a per-schema validator — it is one
// discovery wrapper that maps artifact globs to schemas and runs the same
// AJV config. The actual rules live in the schemas; this only finds the
// files.
//
// Glob -> schema map (an artifact is validated only if it exists):
//   context.json                          schemas/context.schema.json
//   test-cases/*.json                     schemas/test-cases.schema.json
//   analysis/failure-analysis.json        schemas/failure-analysis.schema.json
//   release/release-report.json           schemas/release-report.schema.json
//   api-tests/collections/*.json          schemas/postman-collection.schema.json
//
// Examples under examples/expected/ are covered by validate-examples.js;
// this script covers the live, committed run artifacts AT THE ROOT and every
// archived run under runs/<story-id>/<run-id>/ (IMPROVEMENT-PLAN-2 T3.2) — the
// archives are what actually ship in the repo, so they are what CI must guard.
//
// Exit codes: 0 all present artifacts valid (or none present) · 1 a
//             validation failure · 2 schema missing / unreadable

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { exit } from 'node:process';
import { compileSchema, readJson, formatErrors } from './lib/artifact-io.js';

// The artifact set for ONE run, rooted at `base` (the repo root, or an
// archived run dir under runs/<story>/<run>/). Each target: a list of concrete
// files (or a directory + suffix) and the schema they validate against.
// Missing files are skipped silently — not every run produces every artifact.
function targetsFor(base = '.') {
  const at = (p) => join(base, p);
  return [
    { files: [at('context.json')], schema: 'schemas/context.schema.json' },
    {
      dir: at('test-cases'),
      suffix: '.json',
      schema: 'schemas/test-cases.schema.json',
    },
    {
      files: [at('analysis/failure-analysis.json')],
      schema: 'schemas/failure-analysis.schema.json',
    },
    {
      dir: at('analysis/spec-reviews'),
      suffix: '.json',
      schema: 'schemas/spec-review.schema.json',
    },
    {
      files: [at('release/release-report.json')],
      schema: 'schemas/release-report.schema.json',
    },
    {
      dir: at('api-tests/collections'),
      suffix: '.json',
      schema: 'schemas/postman-collection.schema.json',
    },
  ];
}

// Discover every archived run dir: runs/<story-id>/<run-id>/. `latest.json`
// and any stray files under runs/<story>/ are skipped.
function archivedRunDirs() {
  const root = 'runs';
  if (!existsSync(root)) return [];
  const dirs = [];
  for (const story of readdirSync(root)) {
    const storyDir = join(root, story);
    let entries;
    try {
      entries = readdirSync(storyDir, { withFileTypes: true });
    } catch {
      continue; // not a directory (e.g. runs/latest.json)
    }
    for (const e of entries) {
      if (e.isDirectory()) dirs.push(join(storyDir, e.name));
    }
  }
  return dirs;
}

// Root run (live) + every archived run. A missing artifact anywhere is skipped.
const TARGETS = [
  ...targetsFor('.'),
  ...archivedRunDirs().flatMap((d) => targetsFor(d)),
];

// Compilation + caching live in scripts/lib/artifact-io.js (task group 2.1).
// This wrapper's policy for an absent schema is FATAL: these are committed
// artifacts that CI must guard, so a schema we cannot load is a broken setup,
// not something to skip. (validate-examples.js deliberately treats the same
// condition as a skip — the shared module reports absence without deciding.)
function compileFor(schemaPath) {
  const compiled = compileSchema(schemaPath);
  if (compiled.ok) return compiled.validate;
  console.error(compiled.message);
  exit(2);
}

// Resolve a target into concrete file paths that actually exist.
function filesFor(target) {
  if (target.files) return target.files.filter((f) => existsSync(f));
  if (target.dir) {
    if (!existsSync(target.dir)) return [];
    return readdirSync(target.dir)
      .filter((n) => n.endsWith(target.suffix))
      .sort()
      .map((n) => join(target.dir, n));
  }
  return [];
}

let pass = 0;
let fail = 0;

for (const target of TARGETS) {
  const files = filesFor(target);
  if (files.length === 0) continue;
  const validate = compileFor(target.schema);
  for (const file of files) {
    const read = readJson(file);
    if (!read.ok) {
      console.error(`FAIL ${file} is not valid JSON: ${read.message}`);
      fail += 1;
      continue;
    }
    if (validate(read.data)) {
      console.log(`OK   ${file}  (against ${target.schema})`);
      pass += 1;
    } else {
      console.error(`FAIL ${file}  (against ${target.schema})`);
      // This wrapper prints paths+messages without AJV params (its historical
      // output shape); formatErrors keeps values out of diagnostics either way.
      for (const line of formatErrors(validate.errors, {
        includeParams: false,
      })) {
        console.error(line);
      }
      fail += 1;
    }
  }
}

if (pass === 0 && fail === 0) {
  console.log('(no committed artifacts present to validate)');
}
console.log(`\n${pass} passed, ${fail} failed`);
exit(fail > 0 ? 1 : 0);
