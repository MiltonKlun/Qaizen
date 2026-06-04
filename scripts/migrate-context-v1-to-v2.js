#!/usr/bin/env node
// context.json migration v1 -> v2: review-gate audit fields (Phase 2 TG6).
//
// v1 (Phase 1): each review_gates.<gate> is a bare boolean.
// v2 (Phase 2): each gate MAY be the richer object
//   { status: <boolean>, reviewer: null, reviewed_at: null, notes: null }.
// The schema's gateValue oneOf accepts BOTH forms, so this migration is
// optional — it only matters if the team wants the audit slots present
// (e.g. to fill reviewer/notes by hand later). Booleans stay valid.
//
// This script wraps any boolean gate value into the object form, carrying
// the boolean into `status` and seeding the audit fields to null. It is
// IDEMPOTENT: a gate already in object form is left untouched, so running
// it twice changes nothing.
//
// Usage:
//   node scripts/migrate-context-v1-to-v2.js                 # dry-run (default)
//   node scripts/migrate-context-v1-to-v2.js --apply         # write back
//   node scripts/migrate-context-v1-to-v2.js <path> [--apply] # custom file
//
// Exit codes: 0 ok (or already migrated) · 1 migration error · 2 usage/file error

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { argv, exit } from 'node:process';

const APPLY = argv.includes('--apply');
const target =
  argv.find((a, i) => i >= 2 && !a.startsWith('--')) || 'context.json';

if (!existsSync(target)) {
  console.error(`File not found: ${target}`);
  exit(2);
}

let doc;
try {
  doc = JSON.parse(readFileSync(target, 'utf8'));
} catch (e) {
  console.error(`${target} is not valid JSON: ${e.message}`);
  exit(2);
}

const gates = doc.review_gates;
if (!gates || typeof gates !== 'object') {
  console.error(`${target} has no review_gates object; nothing to migrate.`);
  exit(1);
}

// Wrap a single gate value into the v2 object form. Idempotent: an object
// already in v2 shape is returned unchanged.
function wrap(value) {
  if (typeof value === 'boolean') {
    return { status: value, reviewer: null, reviewed_at: null, notes: null };
  }
  // Already an object (v2). Leave as-is — do not clobber existing audit data.
  return value;
}

let changed = 0;
const after = {};
for (const [gate, value] of Object.entries(gates)) {
  const wrapped = wrap(value);
  if (wrapped !== value) {
    changed += 1;
    console.log(`  ${gate}: boolean(${value}) -> { status: ${value}, ... }`);
  } else {
    console.log(`  ${gate}: already object form (left unchanged)`);
  }
  after[gate] = wrapped;
}

if (changed === 0) {
  console.log(`\n${target}: all gates already in v2 object form. No change.`);
  exit(0);
}

if (!APPLY) {
  console.log(
    `\nDRY RUN: ${changed} gate(s) would be migrated. Re-run with --apply to write ${target}.`
  );
  exit(0);
}

doc.review_gates = after;
writeFileSync(target, JSON.stringify(doc, null, 2) + '\n');
console.log(`\nMigrated ${changed} gate(s); wrote ${target}.`);
console.log(
  'Validate it: node scripts/validate-json.js schemas/context.schema.json ' +
    target
);
