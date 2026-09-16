#!/usr/bin/env node
// Generic JSON Schema validator. ONE script for the whole pipeline.
//
// Per Phase 1 TG8 and CLAUDE.md section 3.3: there is exactly one
// validator. Do not create per-schema scripts.
//
// The AJV configuration, schema cache and diagnostics now live in
// scripts/lib/artifact-io.js so this CLI and the two discovery wrappers
// (validate-all.js, validate-examples.js) cannot drift apart
// (IMPLEMENTATION_PLAN task group 2.1). This file is the CLI surface; the
// behaviour it prints and the codes it exits with are unchanged.
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

import { argv, exit } from 'node:process';
import {
  readJson,
  compileSchema,
  formatErrors,
  IO_ERROR,
} from './lib/artifact-io.js';

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

// A schema problem (missing, unparseable, uncompilable) is a usage error (2),
// never a data verdict (1) — the distinction the shared module preserves.
const compiled = compileSchema(schemaPath);
if (!compiled.ok) {
  console.error(
    compiled.kind === IO_ERROR.MISSING_SCHEMA
      ? `Could not read schema at ${schemaPath}: ${compiled.message}`
      : compiled.message
  );
  exit(2);
}

const read = readJson(dataPath);
if (!read.ok) {
  console.error(
    read.kind === IO_ERROR.MALFORMED_JSON
      ? `data at ${dataPath} is not valid JSON: ${read.message}`
      : `Could not read data at ${dataPath}: ${read.message}`
  );
  exit(2);
}

if (compiled.validate(read.data)) {
  console.log(`OK  ${dataPath} validates against ${schemaPath}`);
  exit(0);
}

console.error(`FAIL ${dataPath} does NOT validate against ${schemaPath}`);
for (const line of formatErrors(compiled.validate.errors)) {
  console.error(line);
}
exit(1);
