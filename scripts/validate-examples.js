#!/usr/bin/env node
// Iterate over every examples/expected/*.json and validate each against
// the schema implied by its filename suffix.
//
// Per Phase 1 TG8: this is NOT a second validator. The filename-pattern
// map below is the only thing it adds on top of scripts/validate-json.js.
// The actual validation logic uses the same AJV configuration so they
// cannot drift apart.
//
// Filename → schema map:
//   *.expected-context.json          schemas/context.schema.json
//   *.expected-test-cases.json       schemas/test-cases.schema.json
//   *.expected-failure-analysis.json schemas/failure-analysis.schema.json
//   *.expected-release-report.json   schemas/release-report.schema.json
//   *.expected-collection.json       schemas/postman-collection.schema.json
//                                    (Phase 1.5+; skipped if the schema
//                                    file does not yet exist)
//   *.expected-spec-review.json      schemas/spec-review.schema.json (Phase 3)
//   *.expected-benchmark-record.json schemas/benchmark-record.schema.json (Phase 5)
//
// Files in examples/expected/ that do not match any pattern are flagged
// as warnings — not failures — so the team can land a file before
// declaring a pattern for it.
//
// Exit codes:
//   0 — every file matched a known pattern and validated successfully
//   1 — at least one file failed validation
//   2 — usage / read / schema-compile error

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { exit } from 'node:process';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const EXAMPLES_DIR = 'examples/expected';

// Ordered most-specific-first. The first matching suffix wins.
const PATTERNS = [
  { suffix: '.expected-context.json', schema: 'schemas/context.schema.json' },
  {
    suffix: '.expected-test-cases.json',
    schema: 'schemas/test-cases.schema.json',
  },
  {
    suffix: '.expected-failure-analysis.json',
    schema: 'schemas/failure-analysis.schema.json',
  },
  {
    suffix: '.expected-release-report.json',
    schema: 'schemas/release-report.schema.json',
  },
  {
    suffix: '.expected-collection.json',
    schema: 'schemas/postman-collection.schema.json',
  },
  {
    suffix: '.expected-spec-review.json',
    schema: 'schemas/spec-review.schema.json',
  },
  {
    suffix: '.expected-benchmark-record.json',
    schema: 'schemas/benchmark-record.schema.json',
  },
];

if (!existsSync(EXAMPLES_DIR)) {
  console.error(`Examples directory not found: ${EXAMPLES_DIR}`);
  exit(2);
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

// Cache compiled schemas. If a schema file is missing (e.g. the Phase
// 1.5 postman-collection schema in Phase 1), we record that and skip
// matching examples with a warning rather than failing.
const compiledSchemas = new Map();
const missingSchemas = new Set();

function compileFor(schemaPath) {
  if (compiledSchemas.has(schemaPath)) return compiledSchemas.get(schemaPath);
  if (missingSchemas.has(schemaPath)) return null;

  if (!existsSync(schemaPath)) {
    missingSchemas.add(schemaPath);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolve(schemaPath), 'utf8'));
  } catch (err) {
    console.error(`Schema ${schemaPath} is not valid JSON: ${err.message}`);
    exit(2);
  }

  let v;
  try {
    v = ajv.compile(parsed);
  } catch (err) {
    console.error(`Schema ${schemaPath} failed to compile: ${err.message}`);
    exit(2);
  }
  compiledSchemas.set(schemaPath, v);
  return v;
}

function matchPattern(filename) {
  for (const p of PATTERNS) {
    if (filename.endsWith(p.suffix)) return p;
  }
  return null;
}

let entries;
try {
  entries = readdirSync(EXAMPLES_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort();
} catch (err) {
  console.error(`Could not read ${EXAMPLES_DIR}: ${err.message}`);
  exit(2);
}

let pass = 0;
let fail = 0;
let skipped = 0;
let unknown = 0;

if (entries.length === 0) {
  console.log(`(no .json files under ${EXAMPLES_DIR}; nothing to validate)`);
  exit(0);
}

for (const name of entries) {
  const path = join(EXAMPLES_DIR, name);
  const matched = matchPattern(name);

  if (!matched) {
    console.warn(`?? ${path} — no filename pattern matched; skipped`);
    unknown += 1;
    continue;
  }

  const validate = compileFor(matched.schema);
  if (!validate) {
    console.warn(
      `-- ${path} — schema ${matched.schema} not present yet; skipped`
    );
    skipped += 1;
    continue;
  }

  let data;
  try {
    data = JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (err) {
    console.error(`FAIL ${path} is not valid JSON: ${err.message}`);
    fail += 1;
    continue;
  }

  if (validate(data)) {
    console.log(`OK   ${path}  (against ${matched.schema})`);
    pass += 1;
    continue;
  }

  console.error(`FAIL ${path}  (against ${matched.schema})`);
  for (const err of validate.errors ?? []) {
    const where = err.instancePath || '(root)';
    const params = Object.keys(err.params ?? {}).length
      ? ' ' + JSON.stringify(err.params)
      : '';
    console.error(`  ${where}: ${err.message}${params}`);
  }
  fail += 1;
}

console.log(
  `\n${pass} passed, ${fail} failed, ${skipped} skipped (schema not present), ${unknown} with no matching pattern`
);

// Unknown patterns are a warning, not a failure — TG8 says examples
// must declare implicitly or explicitly, and the warning surfaces the
// declaration gap without breaking the build.
exit(fail > 0 ? 1 : 0);
