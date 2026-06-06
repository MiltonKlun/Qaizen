#!/usr/bin/env node
// test-cases migration: testlink_id -> external_ids.testlink (Phase 2.6
// TG2.6-3). The schema now has a generic external_ids { tool: id } object;
// the legacy testlink_id field stays valid. This OPTIONAL migration copies an
// existing testlink_id into external_ids.testlink so all linkages live in one
// place going forward. It is NON-DESTRUCTIVE (keeps testlink_id too) and
// IDEMPOTENT (a case already mirrored is left alone).
//
// Usage:
//   node scripts/migrate-testcases-external-ids.js <path>            # dry-run
//   node scripts/migrate-testcases-external-ids.js <path> --apply    # write
//   node scripts/migrate-testcases-external-ids.js --all             # every test-cases/*.json (dry-run)
//   node scripts/migrate-testcases-external-ids.js --all --apply
//
// Exit codes: 0 ok (or nothing to do) · 1 error · 2 usage/file error

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { argv, exit } from 'node:process';

const APPLY = argv.includes('--apply');
const ALL = argv.includes('--all');
const explicit = argv.find((a, i) => i >= 2 && !a.startsWith('--'));

let targets = [];
if (ALL) {
  if (!existsSync('test-cases')) {
    console.error('No test-cases/ directory.');
    exit(2);
  }
  targets = readdirSync('test-cases')
    .filter((f) => f.endsWith('.json'))
    .map((f) => `test-cases/${f}`);
} else if (explicit) {
  targets = [explicit];
} else {
  console.error(
    'Usage: node scripts/migrate-testcases-external-ids.js <path> [--apply]  |  --all [--apply]'
  );
  exit(2);
}

let totalChanged = 0;
for (const path of targets) {
  if (!existsSync(path)) {
    console.error(`File not found: ${path}`);
    exit(2);
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`${path} is not valid JSON: ${e.message}`);
    exit(1);
  }
  let changed = 0;
  for (const tc of doc.test_cases || []) {
    if (tc.testlink_id) {
      tc.external_ids = tc.external_ids || {};
      if (tc.external_ids.testlink !== tc.testlink_id) {
        tc.external_ids.testlink = tc.testlink_id;
        changed += 1;
      }
    }
  }
  if (changed === 0) {
    console.log(
      `${path}: nothing to migrate (no testlink_id, or already mirrored).`
    );
    continue;
  }
  totalChanged += changed;
  if (APPLY) {
    writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
    console.log(
      `${path}: mirrored ${changed} testlink_id -> external_ids.testlink (written).`
    );
  } else {
    console.log(
      `${path}: would mirror ${changed} testlink_id -> external_ids.testlink.`
    );
  }
}

if (!APPLY && totalChanged > 0) {
  console.log('\nDRY RUN. Re-run with --apply to write.');
}
exit(0);
