#!/usr/bin/env node
// @ts-check
// Check a run's gate trail: the chain of records (each names the one before
// it by digest, and its decision in context.json names it) and, where
// records are signed, each signature (scripts/lib/record-signing.js). Read
// only.
//
// A clean trail shows that no record was changed after the fact and, for a
// signed record, which key approved it. It does not show how carefully the
// reviewer read what they approved.
//
// Usage:
//   npm run verify:trail
//   npm run verify:trail -- --require-signatures       # an unsigned record is a problem
//   npm run verify:trail -- --allowed-signers <file>   # default config/allowed-signers
//   npm run verify:trail -- --root runs/<story>/<run>  # an archived run
//   npm run verify:trail -- --revoked <file>           # keys revoked since (ssh-keygen -r)
//
// Exit codes: 0 the trail holds · 1 a problem · 2 usage error, or no
//             context.json

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { argv, exit } from 'node:process';

import { readJson } from './lib/artifact-io.js';
import { parseCliOrExit } from './lib/cli.js';
import { listGateRecords, verifyGateTrail } from './lib/gate-records.js';
import { ALLOWED_SIGNERS } from './lib/record-signing.js';
import { trailSignatures } from './lib/trail-signatures.js';

const cli = parseCliOrExit(argv.slice(2), {
  usage:
    'Usage: node scripts/verify-gate-trail.js [--root <run folder>] [--allowed-signers <file>] [--revoked <file>] [--require-signatures]',
  positionals: [],
  options: {
    root: { type: 'string' },
    'allowed-signers': { type: 'string' },
    'require-signatures': { type: 'boolean' },
    revoked: { type: 'string' },
  },
});
const root = /** @type {string | undefined} */ (cli.values.root) ?? '.';
const allowed =
  /** @type {string | undefined} */ (cli.values['allowed-signers']) ??
  ALLOWED_SIGNERS;
const contextPath = join(root, 'context.json');
if (!existsSync(contextPath)) {
  console.error(`No context.json in ${root}.`);
  exit(2);
}
const read = readJson(contextPath);
if (!read.ok) {
  console.error(read.message);
  exit(2);
}

const chain = verifyGateTrail(read.data, root);
const sigs = trailSignatures(root, allowed, {
  require: cli.values['require-signatures'] === true,
  context: read.data,
  revoked: /** @type {string | undefined} */ (cli.values.revoked) ?? null,
});
const records = listGateRecords(root).length;
console.log(
  `Gate trail of ${root === '.' ? 'the current run' : root}: ${records} record(s).`
);
for (const line of sigs.lines) console.log(`  ${line}`);
const problems = [...chain, ...sigs.problems];
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  exit(1);
}
console.log(
  `\nThe trail holds: the chain is intact; ${sigs.signed} record(s) signed by their reviewer, ${sigs.unsigned} unsigned.` +
    ' A signature shows which key approved, not how carefully.'
);
exit(0);
