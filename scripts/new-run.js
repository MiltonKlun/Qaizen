#!/usr/bin/env node
// Run history — archive the current root run into runs/<story-id>/<run-id>/
// (Phase 3 TG5). The single-occupancy artifact layout (context.json,
// test-cases/, analysis/, release/, ... all at the repo root) means each
// story overwrites the previous one. This script SNAPSHOTS the current root
// run into runs/ so nothing is lost, addressing the Phase 2 retrospective's
// top pain point.
//
// Model (Option A from phase3 TG5): the repo ROOT is always the *current*
// run; runs/ is the immutable history. You run this AFTER a run is done (or
// before starting a new story) to archive what's at the root. It copies, it
// does not delete the root — so re-running is safe and the root keeps working
// exactly as today for the agents.
//
// What gets archived (durable artifacts only): context.json, story.md,
// test-cases/, planner-input/, specs/, tests/, api-tests/, analysis/,
// release/. Heavy regenerable outputs (reports/, traces/, screenshots/) are
// NOT archived — they are gitignored and reproducible by re-running.
//
// Usage:
//   node scripts/new-run.js <story-id>                 # archive root run for this story
//   node scripts/new-run.js <story-id> <label>         # + a human label (e.g. sprint-42)
//   node scripts/new-run.js <story-id> --dry-run       # show what would be archived
//
// Exit codes: 0 ok · 2 usage/file error

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  cpSync,
  readdirSync,
} from 'node:fs';
import { argv, exit } from 'node:process';

const DRY = argv.includes('--dry-run');
const positional = argv.filter((a, i) => i >= 2 && !a.startsWith('--'));
const storyId = positional[0];
const label = positional[1] || null;

if (!storyId) {
  console.error(
    'Usage: node scripts/new-run.js <story-id> [label] [--dry-run]'
  );
  exit(2);
}

if (!existsSync('context.json')) {
  console.error(
    'No context.json at the repo root — nothing to archive. Run a pipeline first.'
  );
  exit(2);
}

// Sanity: the root context should match the story being archived.
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

// run-id: ISO-ish timestamp + the root context's run_id tail (if any) for a
// stable, sortable, unique id.
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
const runId = stamp;

const runDir = `runs/${storyId}/${runId}`;

// Durable artifacts to archive (files + dirs). Missing ones are skipped.
const FILES = ['context.json', 'story.md'];
const DIRS = [
  'test-cases',
  'planner-input',
  'specs',
  'tests',
  'api-tests',
  'analysis',
  'release',
];
// Heavy/regenerable — intentionally NOT archived.
const SKIPPED = ['reports', 'traces', 'screenshots'];

const plannedFiles = FILES.filter((f) => existsSync(f));
const plannedDirs = DIRS.filter((d) => existsSync(d));

console.log(`Archive root run for ${storyId}`);
console.log(`  Run id: ${runId}${label ? `  ·  label: ${label}` : ''}`);
console.log(`  Destination: ${runDir}/`);
console.log(`  Files: ${plannedFiles.join(', ') || '(none)'}`);
console.log(`  Dirs:  ${plannedDirs.join(', ') || '(none)'}`);
console.log(`  Skipped (regenerable, gitignored): ${SKIPPED.join(', ')}`);

if (DRY) {
  console.log('\nDRY RUN (nothing written).');
  exit(0);
}

mkdirSync(runDir, { recursive: true });

// Copy files.
for (const f of plannedFiles) {
  cpSync(f, `${runDir}/${f}`);
}
// Copy dirs (recursively), skipping the heavy ones if nested anywhere.
for (const d of plannedDirs) {
  cpSync(d, `${runDir}/${d}`, {
    recursive: true,
    filter: (src) => !SKIPPED.some((s) => src.split(/[\\/]/).includes(s)),
  });
}

// Run manifest — traceability for this archived run.
const manifest = {
  run_id: runId,
  story_id: storyId,
  label,
  archived_at: new Date().toISOString(),
  source_context_run_id: rootCtx.run_id ?? null,
  status_at_archive: rootCtx.status ?? null,
  archived_files: plannedFiles,
  archived_dirs: plannedDirs,
};
writeFileSync(
  `${runDir}/run-manifest.json`,
  JSON.stringify(manifest, null, 2) + '\n'
);

// Update the per-project latest pointer.
const latestPath = 'runs/latest.json';
let latest = {};
if (existsSync(latestPath)) {
  try {
    latest = JSON.parse(readFileSync(latestPath, 'utf8'));
  } catch {
    latest = {};
  }
}
latest[storyId] = { run_id: runId, label, archived_at: manifest.archived_at };
writeFileSync(latestPath, JSON.stringify(latest, null, 2) + '\n');

const archivedRuns = readdirSync(`runs/${storyId}`).filter(
  (n) => n !== 'latest.json'
);
console.log(`\nArchived to ${runDir}/`);
console.log(`Updated ${latestPath} -> ${storyId}: ${runId}`);
console.log(
  `Story ${storyId} now has ${archivedRuns.length} archived run(s) in runs/${storyId}/.`
);
console.log(
  'The repo root is unchanged and remains the current run; start the next ' +
    'run normally (the root will be overwritten, but this snapshot is safe).'
);
exit(0);
