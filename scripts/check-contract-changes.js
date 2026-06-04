#!/usr/bin/env node
// Architecture Stability Rule CI check (Phase 2 TG12). Detects when a PR
// changes a contract (schemas/) without changing the things that must move
// WITH it in the same PR — the consuming agent prompts (agents/), the docs
// (docs/), and the expected examples (examples/expected/). See CLAUDE.md
// §3.10 and docs/pipeline-architecture.md §9.
//
// This is a WARNING, not a failure (the phase plan is explicit: it emits a
// ::warning:: annotation and exits 0). A schema change can be legitimately
// unaccompanied — e.g. a comment-only edit — so the human decides. Pass
// --strict to make it exit 1 (the team may promote it to blocking once the
// signal proves reliable), matching the ci-summary --fail-on-test-failure
// pattern.
//
// Usage:
//   node scripts/check-contract-changes.js                 # warn-only (default)
//   node scripts/check-contract-changes.js --base <ref>    # diff base (default: origin/main)
//   node scripts/check-contract-changes.js --strict        # exit 1 if unaccompanied
//
// Exit codes: 0 ok / warning emitted · 1 only with --strict and an
//             unaccompanied schema change · 2 git/usage error

import { spawnSync } from 'node:child_process';
import { argv, env, exit } from 'node:process';

const STRICT = argv.includes('--strict');
const baseIdx = argv.indexOf('--base');
const base =
  baseIdx !== -1 && argv[baseIdx + 1]
    ? argv[baseIdx + 1]
    : env.CONTRACT_BASE_REF || 'origin/main';

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

const touched = (prefix) => files.some((f) => f.startsWith(prefix));
const schemasChanged = files.filter((f) => f.startsWith('schemas/'));

if (schemasChanged.length === 0) {
  console.log(
    `No schemas/ changes in this diff (vs ${base}); Architecture Stability check not applicable.`
  );
  exit(0);
}

const companions = {
  'agents/': touched('agents/'),
  'docs/': touched('docs/'),
  'examples/expected/': touched('examples/expected/'),
};
const missing = Object.entries(companions)
  .filter(([, present]) => !present)
  .map(([k]) => k);

console.log(`schemas/ changed in this diff (vs ${base}):`);
for (const s of schemasChanged) console.log(`  - ${s}`);
console.log('Companion changes:');
for (const [k, present] of Object.entries(companions)) {
  console.log(`  ${present ? 'yes' : 'NO '}  ${k}`);
}

if (missing.length === 0) {
  console.log(
    '\nAll Architecture Stability companions changed alongside the schema. OK.'
  );
  exit(0);
}

const msg =
  `Schema changed but these were NOT updated in the same PR: ${missing.join(', ')}. ` +
  `The Architecture Stability Rule (CLAUDE.md §3.10) requires schema + consuming ` +
  `agent prompts + docs + expected examples (+ a migration script if not ` +
  `backward-compatible) to change together. If this schema edit is genuinely ` +
  `standalone (e.g. a comment), this warning can be acknowledged and ignored.`;

// GitHub Actions annotation (shows on the PR). Harmless locally.
console.log(`::warning title=Architecture Stability Rule::${msg}`);
console.log(`\n${msg}`);

exit(STRICT ? 1 : 0);
