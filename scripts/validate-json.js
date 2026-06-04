#!/usr/bin/env node
// Generic JSON Schema validator. ONE script for the whole pipeline.
//
// Per Phase 1 TG8 and CLAUDE.md section 3.3: there is exactly one
// validator. Do not create per-schema scripts.
//
// Usage:
//   node scripts/validate-json.js <schema-path> <data-path>
//
// Examples:
//   node scripts/validate-json.js schemas/context.schema.json context.json
//   node scripts/validate-json.js schemas/test-cases.schema.json test-cases/JIRA-1234.json
//   node scripts/validate-json.js schemas/failure-analysis.schema.json analysis/failure-analysis.json
//   node scripts/validate-json.js schemas/release-report.schema.json release/release-report.json
//
// Exit codes:
//   0 — data validates against schema
//   1 — data does not validate
//   2 — usage / file / parse error (something is wrong with how the
//       script was called, not with the data per se)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

function usage() {
  console.error(
    'Usage: node scripts/validate-json.js <schema-path> <data-path>'
  );
}

const [, , schemaPath, dataPath] = argv;

if (!schemaPath || !dataPath) {
  usage();
  exit(2);
}

function loadJson(path, label) {
  let raw;
  try {
    raw = readFileSync(resolve(path), 'utf8');
  } catch (err) {
    console.error(`Could not read ${label} at ${path}: ${err.message}`);
    exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`${label} at ${path} is not valid JSON: ${err.message}`);
    exit(2);
  }
}

const schema = loadJson(schemaPath, 'schema');
const data = loadJson(dataPath, 'data');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

let validate;
try {
  validate = ajv.compile(schema);
} catch (err) {
  console.error(`Schema at ${schemaPath} failed to compile: ${err.message}`);
  exit(2);
}

if (validate(data)) {
  console.log(`OK  ${dataPath} validates against ${schemaPath}`);
  exit(0);
}

console.error(`FAIL ${dataPath} does NOT validate against ${schemaPath}`);
for (const err of validate.errors ?? []) {
  const where = err.instancePath || '(root)';
  const params = Object.keys(err.params ?? {}).length
    ? ' ' + JSON.stringify(err.params)
    : '';
  console.error(`  ${where}: ${err.message}${params}`);
}
exit(1);
