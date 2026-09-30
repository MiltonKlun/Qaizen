#!/usr/bin/env node
// @ts-check
// Which runtime scripts the JSDoc type check covers (task group 10.1).
//
// tsconfig.scripts.json checks, under `strict`, every script that opts in with
// `// @ts-check` on its first line (after a shebang, when it has one).
// Coverage is being extended file by file; this prints exactly which files are
// checked and which are not yet, so a passing `npm run typecheck:scripts` is
// never read as "every script is type-checked".
//
// Usage: node scripts/typecheck-coverage.js [--json]
// Exit codes: 0 always (a report, not a gate); 2 on a usage error.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPTS = join(REPO, 'scripts');

const extra = argv.slice(2).filter((a) => a !== '--json');
if (extra.length) {
  console.error(`Unknown argument(s): ${extra.join(' ')}. Usage: [--json]`);
  exit(2);
}

/**
 * Every .js file under a directory, depth first, sorted.
 * @param {string} dir
 * @returns {string[]}
 */
function jsFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}

/** `// @ts-check` as the first line, or the second after a shebang. */
const OPT_IN = /^(?:#![^\n]*\r?\n)?[ \t]*\/\/[ \t]*@ts-check\b/;

/**
 * Does this file opt in to the type check?
 * @param {string} file
 */
export const optedIn = (file) => OPT_IN.test(readFileSync(file, 'utf8'));

const files = jsFiles(SCRIPTS).map((f) => ({
  path: relative(REPO, f).split(sep).join('/'),
  checked: optedIn(f),
}));
const checked = files.filter((f) => f.checked).map((f) => f.path);
const unchecked = files.filter((f) => !f.checked).map((f) => f.path);

if (argv.includes('--json')) {
  console.log(
    JSON.stringify({ total: files.length, checked, unchecked }, null, 2)
  );
} else {
  console.log(
    `JSDoc type check (strict) covers ${checked.length}/${files.length} runtime scripts:`
  );
  for (const f of checked) console.log(`  checked    ${f}`);
  console.log(
    `Not yet checked (${unchecked.length}): ${unchecked.join(', ') || '(none)'}`
  );
}
exit(0);
