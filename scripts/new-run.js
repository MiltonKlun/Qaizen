#!/usr/bin/env node
// Run history — archive the current root run into runs/<story-id>/<run-id>/
// (Phase 3 TG5; rebuilt on scripts/lib/run-lifecycle.js in task group 4.1).
//
// Model: the repo ROOT is always the *current* run; runs/ is the immutable
// history. The runner archives a COMPLETED run automatically when the next
// story starts (`npm run pipeline -- --story ...`). Use this script to archive
// by hand, or with --clear to deliberately set aside a run that is NOT complete
// so a new story can start.
//
// What gets archived: only the run's OWN artifacts — context.json, story.md,
// the files its artifact_paths name, files named for the story, and the
// run-scoped singletons (failure analysis, execution ledger, release report,
// bug drafts, healer output). Never the reusable seed test, fixtures or
// .gitkeep files, and never another story's files. A file inside the run
// directories that cannot be attributed to this run STOPS the archive.
//
// Every copy is verified byte-for-byte (SHA-256, recorded in the manifest) and
// copied JSON is schema-validated. Nothing is reformatted: an archive is
// evidence, so it stays identical to what the run produced (the previous
// version ran Prettier over it, which rewrote the archived bytes).
//
// Usage:
//   node scripts/new-run.js <story-id>                 # archive the root run
//   node scripts/new-run.js <story-id> <label>         # + a human label
//   node scripts/new-run.js <story-id> --clear         # archive, then remove the
//                                                        archived files from the root
//   node scripts/new-run.js <story-id> --dry-run       # show what would happen
//
// Exit codes: 0 ok · 1 files could not be attributed, or changed during the
//             archive · 2 usage / file / archive error

import { readFileSync, existsSync } from 'node:fs';
import { argv, exit } from 'node:process';

import {
  archiveRun,
  classifyRootArtifacts,
  clearArchived,
  readTransition,
  TRANSITION_FILE,
} from './lib/run-lifecycle.js';

const DRY = argv.includes('--dry-run');
const CLEAR = argv.includes('--clear');
const positional = argv.filter((a, i) => i >= 2 && !a.startsWith('--'));
const storyId = positional[0];
const label = positional[1] || null;

if (!storyId) {
  console.error(
    'Usage: node scripts/new-run.js <story-id> [label] [--clear] [--dry-run]'
  );
  exit(2);
}

const pending = readTransition('.');
if (pending && pending.phase !== 'installed') {
  console.error(
    `A new-story transition is in progress (${TRANSITION_FILE}, phase "${pending.phase}"). ` +
      'Finish or undo it first: npm run pipeline -- --resume'
  );
  exit(2);
}

if (!existsSync('context.json')) {
  console.error(
    'No context.json at the repo root — nothing to archive. Run a pipeline first.'
  );
  exit(2);
}

let rootCtx;
try {
  rootCtx = JSON.parse(readFileSync('context.json', 'utf8'));
} catch (e) {
  console.error(`Root context.json is not valid JSON: ${e.message}`);
  exit(2);
}
const rootStory = rootCtx.story?.id;
if (rootStory && rootStory !== storyId) {
  console.error(
    `Root context.json is for story "${rootStory}", not "${storyId}". ` +
      `Archive the right story, or pass ${rootStory}.`
  );
  exit(2);
}

const { owned, unknown, outside } = classifyRootArtifacts(rootCtx, '.');

console.log(`Archive root run for ${storyId}`);
console.log(`  Status at archive: ${rootCtx.status ?? 'unknown'}`);
console.log(`  Files (${owned.length}):`);
for (const f of owned) console.log(`    ${f}`);
console.log(
  '  Never archived: reusable seed/fixtures/.gitkeep, other stories, reports/ (regenerable).'
);

if (unknown.length || outside.length) {
  console.error(
    '\nThese files cannot be attributed to this run, so nothing was archived:\n  ' +
      [...unknown, ...outside.map((o) => `${o} (outside the repo)`)].join(
        '\n  '
      ) +
      '\nMove them (or archive the run they belong to), then retry.'
  );
  exit(1);
}

if (DRY) {
  console.log(
    `\nDRY RUN (nothing written${CLEAR ? '; --clear would then remove these files from the root' : ''}).`
  );
  exit(0);
}

const archived = archiveRun({
  root: '.',
  storyId,
  context: rootCtx,
  files: owned,
  label,
});
if (!archived.ok) {
  console.error(`\n${archived.message}`);
  exit(2);
}

const invalid = archived.manifest.files.filter((f) => f.valid === false);
console.log(`\nArchived ${owned.length} file(s) to ${archived.archiveDir}/`);
console.log(
  '  Every copy verified by SHA-256 (recorded in run-manifest.json).'
);
if (invalid.length) {
  console.warn(
    `  warning: ${invalid.length} archived JSON artifact(s) do not validate against their ` +
      `schema (archived as-is; the manifest records it): ${invalid.map((f) => f.path).join(', ')}`
  );
}

if (CLEAR) {
  const { removed, changed } = clearArchived('.', archived.manifest.files);
  console.log(`  Removed ${removed.length} archived file(s) from the root.`);
  if (changed.length) {
    console.error(
      `  These changed after they were archived and were left in place:\n    ${changed.join('\n    ')}`
    );
    exit(1);
  }
  console.log(
    'The root is clear for the next story: npm run pipeline -- --story <path|JIRA-KEY>'
  );
} else {
  console.log(
    'The root is unchanged and remains the current run. Starting the next story with\n' +
      '  npm run pipeline -- --story <path|JIRA-KEY>\n' +
      'archives a completed run automatically; use --clear to set aside an incomplete one.'
  );
}
exit(0);
