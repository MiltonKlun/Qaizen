#!/usr/bin/env node
// @ts-check
// Architecture Stability Rule CI check (Phase 2 TG12; companions made exact
// in task group 10.2). Detects when a PR changes a contract (schemas/) without
// changing the files that must move WITH it in the same PR (CLAUDE.md §3.10).
//
// Which files count is declared per schema in scripts/lib/schema-contracts.js:
// every agent prompt that produces the artifact, docs/artifact-boundaries.md,
// one of the schema's own docs, and one of its own examples. A change to some
// other agent, doc or example no longer satisfies a missing companion.
// Consumer prompts are listed for review, not required: whether they change
// depends on which field moved.
//
// This is a WARNING, not a failure: it emits a ::warning:: annotation and
// exits 0. A schema change can be legitimately unaccompanied (a comment-only
// edit), so the human decides. --strict makes it exit 1, for when the team
// chooses to make it blocking.
//
// Usage:
//   node scripts/check-contract-changes.js                 # warn-only (default)
//   node scripts/check-contract-changes.js --base <ref>    # diff base (default: origin/main)
//   node scripts/check-contract-changes.js --strict        # exit 1 if a companion is missing
//
// Exit codes: 0 ok / warning emitted · 1 only with --strict and a missing
//             companion · 2 git/usage error

import { spawnSync } from 'node:child_process';
import { argv, env, exit } from 'node:process';

import { missingCompanions } from './lib/schema-contracts.js';

const STRICT = argv.includes('--strict');
const baseIdx = argv.indexOf('--base');
const base =
  baseIdx !== -1 && argv[baseIdx + 1]
    ? argv[baseIdx + 1]
    : env.CONTRACT_BASE_REF || 'origin/main';

/** @param {string[]} args */
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    return { ok: false, out: '', err: (r.stderr || '').trim() };
  }
  return { ok: true, out: (r.stdout || '').trim(), err: '' };
}

// Prefer a three-dot diff (changes on HEAD since the merge-base with base),
// which is what a PR actually introduces. Fall back to a two-dot diff if the
// merge-base can't be found (e.g. shallow clone without the base).
function changedFiles() {
  let r = git(['diff', '--name-only', `${base}...HEAD`]);
  if (!r.ok) {
    r = git(['diff', '--name-only', base, 'HEAD']);
  }
  if (!r.ok) {
    console.error(
      `Could not diff against "${base}": ${r.err}\n` +
        `Ensure the base ref is fetched (CI: actions/checkout with fetch-depth: 0).`
    );
    exit(2);
  }
  return r.out ? r.out.split('\n').filter(Boolean) : [];
}

const files = changedFiles();

const results = missingCompanions(files.map((f) => f.split('\\').join('/')));

if (results.length === 0) {
  console.log(
    `No schema changes in this diff (vs ${base}); Architecture Stability check not applicable.`
  );
  exit(0);
}

let incomplete = 0;
for (const { schema, missing, review } of results) {
  console.log(`${schema} changed (vs ${base}).`);
  if (missing.length === 0) {
    console.log('  All required companions changed with it.');
  } else {
    incomplete += 1;
    console.log('  Missing companions:');
    for (const m of missing) console.log(`    - ${m}`);
    const msg =
      `${schema} changed without: ${missing.join('; ')}. The Architecture ` +
      `Stability Rule (CLAUDE.md §3.10) moves a schema with its producing ` +
      `prompts, its docs and its examples (and a migration script when old ` +
      `artifacts must stay valid). If this edit is genuinely standalone ` +
      `(e.g. a comment), acknowledge and ignore this warning.`;
    // GitHub Actions annotation (shows on the PR). Harmless locally.
    console.log(`::warning title=Architecture Stability Rule::${msg}`);
  }
  if (review.length) {
    console.log(
      `  Review (consumers; change them if the moved field affects them): ${review.join(', ')}`
    );
  }
}

exit(STRICT && incomplete ? 1 : 0);
