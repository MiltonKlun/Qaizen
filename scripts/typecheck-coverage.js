#!/usr/bin/env node
// @ts-check
// Every runtime script stays under the JSDoc type check (task group 10.1).
//
// tsconfig.scripts.json checks every scripts/**/*.js under `strict`
// (`checkJs: true`), so a new script is covered without opting in. The one
// way out is a `// @ts-nocheck` comment, which would silently drop a file from
// the check while `npm run typecheck:scripts` still passed. This fails when
// any script carries one, so full coverage cannot erode unnoticed.
//
// The `// @ts-check` line at the top of each script is kept for editors,
// which read the root tsconfig.json rather than tsconfig.scripts.json.
//
// Usage: node scripts/typecheck-coverage.js [--json]
// Exit codes: 0 every script is checked · 1 a script opts out · 2 usage error

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

/** A `// @ts-nocheck` comment anywhere in the file (TypeScript honours any line). */
const OPT_OUT = /^[ \t]*\/\/[ \t]*@ts-nocheck\b/m;

/**
 * Does this file opt out of the type check?
 * @param {string} file
 */
const optedOut = (file) => OPT_OUT.test(readFileSync(file, 'utf8'));

const files = jsFiles(SCRIPTS).map((f) => ({
  path: relative(REPO, f).split(sep).join('/'),
  checked: !optedOut(f),
}));
const checked = files.filter((f) => f.checked).map((f) => f.path);
const unchecked = files.filter((f) => !f.checked).map((f) => f.path);

if (argv.includes('--json')) {
  console.log(
    JSON.stringify({ total: files.length, checked, unchecked }, null, 2)
  );
} else {
  console.log(
    `JSDoc type check (strict) covers ${checked.length}/${files.length} runtime scripts.`
  );
  if (unchecked.length) {
    console.error(
      `Opted out with // @ts-nocheck (remove it and fix the types): ${unchecked.join(', ')}`
    );
  }
}
exit(unchecked.length ? 1 : 0);
