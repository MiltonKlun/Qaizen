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
// this script covers the live, committed run artifacts.
//
// Exit codes: 0 all present artifacts valid (or none present) · 1 a
//             validation failure · 2 schema missing / unreadable

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { exit } from 'node:process';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

// Each target: a list of concrete files (or a directory + suffix) and the
// schema they validate against. Missing files are skipped silently —
// not every run produces every artifact.
const TARGETS = [
  { files: ['context.json'], schema: 'schemas/context.schema.json' },
  {
    dir: 'test-cases',
    suffix: '.json',
    schema: 'schemas/test-cases.schema.json',
  },
  {
    files: ['analysis/failure-analysis.json'],
    schema: 'schemas/failure-analysis.schema.json',
  },
  {
    dir: 'analysis/spec-reviews',
    suffix: '.json',
    schema: 'schemas/spec-review.schema.json',
  },
  {
    files: ['release/release-report.json'],
    schema: 'schemas/release-report.schema.json',
  },
  {
    dir: 'api-tests/collections',
    suffix: '.json',
    schema: 'schemas/postman-collection.schema.json',
  },
];

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const compiledSchemas = new Map();
function compileFor(schemaPath) {
  if (compiledSchemas.has(schemaPath)) return compiledSchemas.get(schemaPath);
  if (!existsSync(schemaPath)) {
    console.error(`Schema not found: ${schemaPath}`);
    exit(2);
  }
  let v;
  try {
    v = ajv.compile(JSON.parse(readFileSync(resolve(schemaPath), 'utf8')));
  } catch (e) {
    console.error(`Schema ${schemaPath} failed to compile: ${e.message}`);
    exit(2);
  }
  compiledSchemas.set(schemaPath, v);
  return v;
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
    let data;
    try {
      data = JSON.parse(readFileSync(resolve(file), 'utf8'));
    } catch (e) {
      console.error(`FAIL ${file} is not valid JSON: ${e.message}`);
      fail += 1;
      continue;
    }
    if (validate(data)) {
      console.log(`OK   ${file}  (against ${target.schema})`);
      pass += 1;
    } else {
      console.error(`FAIL ${file}  (against ${target.schema})`);
      for (const err of validate.errors ?? []) {
        const where = err.instancePath || '(root)';
        console.error(`  ${where}: ${err.message}`);
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
