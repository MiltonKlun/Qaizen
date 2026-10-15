#!/usr/bin/env node
// @ts-check
// The defect history: what past runs found, for the Analyst's risk matrix
// (agents/analyst.md). Reads the archived runs under runs/ and writes
// metrics/defect-history.md, regenerable like the rest of metrics/. Read-only
// towards the runs; nothing else is written.
//
// Usage:
//   npm run defect-history                    # write metrics/defect-history.md
//   npm run defect-history -- --print         # print it instead
//   npm run defect-history -- --runs <dir>    # read another archive folder
//
// Exit codes: 0 ok · 2 usage error

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit } from 'node:process';

import { parseCliOrExit } from './lib/cli.js';
import { collectDefects, renderDefectHistory } from './lib/defect-history.js';

const cli = parseCliOrExit(argv.slice(2), {
  usage:
    'Usage: node scripts/defect-history.js [--runs runs] [--out metrics/defect-history.md | --print]',
  positionals: [],
  options: {
    runs: { type: 'string' },
    out: { type: 'string' },
    print: { type: 'boolean' },
  },
  exclusive: [['out', 'print']],
});

const runsDir = /** @type {string | undefined} */ (cli.values.runs) ?? 'runs';
const out =
  /** @type {string | undefined} */ (cli.values.out) ??
  'metrics/defect-history.md';
const history = collectDefects(runsDir);
const md = renderDefectHistory(history);

if (cli.values.print === true) {
  process.stdout.write(md);
  exit(0);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, md);
console.log(
  `Wrote ${out}: ${history.runs.length} run(s) read, ${history.bugs.length} product bug(s).`
);
