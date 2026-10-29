// A workflow job that runs one of our scripts must install the npm packages
// that script imports. Without `npm ci` the job fails with
// ERR_MODULE_NOT_FOUND, and an informational job fails quietly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, normalize } from 'node:path';

const IMPORT = /^\s*import\s[^;]*?from\s+'([^']+)'/gm;

/**
 * The npm packages a script imports, directly or through its relative imports.
 * @param {string} file
 * @param {Set<string>} [seen]
 * @returns {Set<string>}
 */
function packagesOf(file, seen = new Set()) {
  const found = new Set();
  if (seen.has(file)) return found;
  seen.add(file);
  for (const [, spec] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
    if (spec.startsWith('.')) {
      for (const p of packagesOf(normalize(join(dirname(file), spec)), seen)) {
        found.add(p);
      }
    } else if (!spec.startsWith('node:') && !builtinModules.includes(spec)) {
      found.add(
        spec.startsWith('@')
          ? spec.split('/').slice(0, 2).join('/')
          : spec.split('/')[0]
      );
    }
  }
  return found;
}

/**
 * Each job's name and body text, from the `jobs:` map of a workflow.
 * @param {string} text
 * @returns {Array<[string, string]>}
 */
function jobsOf(text) {
  const lf = text.replace(/\r\n/g, '\n');
  const start = lf.indexOf('\njobs:\n');
  assert.notEqual(start, -1, 'the workflow has a jobs: map');
  const body = lf.slice(start);
  return body
    .split(/\n(?=  [A-Za-z0-9_-]+:\s*$)/m)
    .slice(1)
    .map((chunk) => [chunk.split(':')[0].trim(), chunk]);
}

test('packagesOf follows relative imports to npm packages', () => {
  assert.ok(packagesOf('scripts/gate4-scan.js').has('typescript'));
});

test('every job that runs a script needing npm packages runs npm ci first', () => {
  const dir = '.github/workflows';
  let checked = 0;
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    for (const [job, text] of jobsOf(readFileSync(`${dir}/${file}`, 'utf8'))) {
      for (const [at, script] of [
        ...text.matchAll(/node (scripts\/[\w./-]+\.js)/g),
      ].map((m) => /** @type {[number, string]} */ ([m.index ?? 0, m[1]]))) {
        const needs = packagesOf(script);
        if (needs.size === 0) continue;
        checked++;
        const install = text.search(/npm ci\b/);
        assert.ok(
          install !== -1 && install < at,
          `${file} job ${job} runs ${script}, which imports ${[...needs].join(', ')}, without npm ci before it`
        );
      }
    }
  }
  assert.ok(checked > 0, 'at least one job runs a script that needs packages');
});
