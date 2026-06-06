#!/usr/bin/env node
// List run history (Phase 3 TG11, multi-feature support). Walks runs/ and
// prints one row per archived run: story_id, run_id, status, timestamp, label.
// It is the read-only companion to scripts/new-run.js (which WRITES runs/) —
// a "simple dashboard without a web UI", as the plan puts it.
//
// Multiple stories coexist in runs/<story-id>/<run-id>/ by construction (TG5),
// so this is also the proof that multi-feature support holds: many story IDs,
// no artifact collision, traceability local to each run. This script never
// writes anything.
//
// Status resolution, in order of trust:
//   1) the archived run's context.json `status`, if present (the real run state)
//   2) the run-manifest's `status_at_archive` (written by new-run.js)
//   3) "unknown" (e.g. a hand-archived run with neither)
//
// Tolerates both manifest shapes seen in the repo: the new-run.js shape
// (source_context_run_id, status_at_archive, archived_dirs) and hand-written
// archives (completeness, note). Missing fields are reported, never fatal.
//
// Usage:
//   node scripts/list-runs.js                 # table, newest first
//   node scripts/list-runs.js --story SK-16   # only one story's runs
//   node scripts/list-runs.js --json          # machine-readable array
//
// Exit codes: 0 ok (including "no runs yet") · 2 read error

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { argv, exit } from 'node:process';

const RUNS_DIR = 'runs';
const asJson = argv.includes('--json');
const storyIdx = argv.indexOf('--story');
const onlyStory = storyIdx !== -1 ? argv[storyIdx + 1] : null;

function loadJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// A directory entry that is a real subdirectory (not latest.json / .gitkeep).
function subdirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    try {
      return statSync(join(dir, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

if (!existsSync(RUNS_DIR)) {
  if (asJson) console.log('[]');
  else console.log(`No ${RUNS_DIR}/ directory yet — no archived runs.`);
  exit(0);
}

const rows = [];

const stories = subdirs(RUNS_DIR)
  .filter((s) => !onlyStory || s === onlyStory)
  .sort();

for (const story of stories) {
  const storyDir = join(RUNS_DIR, story);
  for (const runId of subdirs(storyDir)) {
    const runDir = join(storyDir, runId);
    const manifest = loadJson(join(runDir, 'run-manifest.json')) || {};
    const ctx = existsSync(join(runDir, 'context.json'))
      ? loadJson(join(runDir, 'context.json'))
      : null;

    const status =
      (ctx && ctx.status) || manifest.status_at_archive || 'unknown';
    const archivedAt = manifest.archived_at || null;

    rows.push({
      story_id: manifest.story_id || story,
      run_id: manifest.run_id || runId,
      status,
      label: manifest.label || null,
      archived_at: archivedAt,
      completeness: manifest.completeness || null,
      has_context: Boolean(ctx),
      path: runDir.replace(/\\/g, '/'),
    });
  }
}

// Newest first by archived_at (fall back to run_id, which is timestamp-ish).
rows.sort((a, b) => {
  const ka = a.archived_at || a.run_id || '';
  const kb = b.archived_at || b.run_id || '';
  return kb.localeCompare(ka);
});

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
  exit(0);
}

if (rows.length === 0) {
  console.log(
    onlyStory
      ? `No archived runs for story "${onlyStory}".`
      : 'No archived runs yet. Archive one with: node scripts/new-run.js <story-id>'
  );
  exit(0);
}

// Plain table. Pad columns to the widest cell so it reads in a terminal.
const cols = [
  { key: 'story_id', head: 'STORY' },
  { key: 'run_id', head: 'RUN ID' },
  { key: 'status', head: 'STATUS' },
  { key: 'archived_at', head: 'ARCHIVED AT' },
  { key: 'label', head: 'LABEL' },
];
const cell = (r, k) => String(r[k] ?? '-');
const widths = cols.map((c) =>
  Math.max(c.head.length, ...rows.map((r) => cell(r, c.key).length))
);
const line = (vals) =>
  vals.map((v, i) => String(v).padEnd(widths[i])).join('  ');

console.log(line(cols.map((c) => c.head)));
console.log(line(widths.map((w) => '-'.repeat(w))));
for (const r of rows) console.log(line(cols.map((c) => cell(r, c.key))));

const storyCount = new Set(rows.map((r) => r.story_id)).size;
console.log(
  `\n${rows.length} run(s) across ${storyCount} stor${storyCount === 1 ? 'y' : 'ies'} in ${RUNS_DIR}/.`
);
exit(0);
