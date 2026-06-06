#!/usr/bin/env node
// session-summary — capture a short "what rubbed today" note after a run
// (Phase 3 TG10, optional helper). These notes are the highest-signal source
// /evolve reads, because they are friction in the human's own words. Stored as
// session-summaries/[date].md, versioned (small, durable, intentional).
//
// Non-interactive by design (the harness runs scripts with no TTY): pass the
// notes as flags. A human can also just write the .md file by hand — this
// script only standardizes the name and a light template.
//
// Usage:
//   node scripts/session-summary.js --friction "stacked PRs orphaned again" \
//        --timesink "rebuilding SK-13 after a clobber" --note "metrics helped"
//   node scripts/session-summary.js --story SK-16 --friction "..."
//
// Repeated flags accumulate. Writes session-summaries/YYYY-MM-DD.md, appending
// a timestamped block if the file for today already exists (never overwrites).
//
// Exit codes: 0 ok · 2 usage (no content given)

import { appendFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { argv, exit } from 'node:process';

const DIR = 'session-summaries';

// Collect all values for a repeatable flag.
function collect(flag) {
  const out = [];
  for (let i = 2; i < argv.length - 1; i++) {
    if (argv[i] === flag) out.push(argv[i + 1]);
  }
  return out;
}
function one(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : null;
}

const story = one('--story');
const frictions = collect('--friction');
const timesinks = collect('--timesink');
const notes = collect('--note');

if (frictions.length + timesinks.length + notes.length === 0) {
  console.error(
    'Nothing to record. Pass at least one of --friction / --timesink / --note.\n' +
      'Example: node scripts/session-summary.js --friction "X" --timesink "Y"'
  );
  exit(2);
}

const now = new Date();
const date = now.toISOString().slice(0, 10);
const path = `${DIR}/${date}.md`;
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

const block = [];
block.push(`## Session note ${now.toISOString()}${story ? ` · ${story}` : ''}`);
block.push('');
if (frictions.length) {
  block.push('**What rubbed / friction:**');
  for (const f of frictions) block.push(`- ${f}`);
  block.push('');
}
if (timesinks.length) {
  block.push('**What cost time:**');
  for (const t of timesinks) block.push(`- ${t}`);
  block.push('');
}
if (notes.length) {
  block.push('**Notes:**');
  for (const n of notes) block.push(`- ${n}`);
  block.push('');
}
const text = block.join('\n') + '\n';

if (existsSync(path)) {
  appendFileSync(path, '\n' + text);
  console.log(`Appended a note to ${path}.`);
} else {
  writeFileSync(path, `# Session summary — ${date}\n\n${text}`);
  console.log(`Wrote ${path}.`);
}
console.log('/evolve will read this on its next run.');
exit(0);
