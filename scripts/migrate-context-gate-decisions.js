#!/usr/bin/env node
// context.json migration: seed the optional gate_decisions[] log
// (continuous improvement). The field is OPTIONAL, so every pre-existing
// context.json is already valid without it — no migration is required for
// validity. This script is a safe, idempotent convenience: it adds an EMPTY
// gate_decisions: [] to a context that lacks one, so the run is "ready to log"
// gate approvals/rejections into. It NEVER touches an existing log.
//
// Usage:
//   node scripts/migrate-context-gate-decisions.js                 # dry-run, context.json
//   node scripts/migrate-context-gate-decisions.js --apply         # write back
//   node scripts/migrate-context-gate-decisions.js <path> [--apply] # custom file
//
// Exit codes: 0 ok (or nothing to do) · 2 usage/file error

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

if (Array.isArray(doc.gate_decisions)) {
  console.log(
    `${target} already has a gate_decisions log (${doc.gate_decisions.length} entr` +
      `${doc.gate_decisions.length === 1 ? 'y' : 'ies'}) — left untouched.`
  );
  exit(0);
}

doc.gate_decisions = [];
console.log(`${target}: would add an empty gate_decisions: [] (ready to log).`);

if (!APPLY) {
  console.log('\nDRY RUN (nothing written). Re-run with --apply to save.');
  exit(0);
}

writeFileSync(target, JSON.stringify(doc, null, 2) + '\n');
console.log(`\nWrote ${target}. Validate with:`);
console.log(
  `  node scripts/validate-json.js schemas/context.schema.json ${target}`
);
exit(0);
