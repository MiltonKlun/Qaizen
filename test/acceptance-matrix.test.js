// docs/acceptance-matrix.md names the regression tests behind each
// acceptance scenario (task group 11.1). Every name must be a test the suite
// actually declares, in a file `npm run test:pipeline` discovers, so the
// matrix cannot point at a renamed or deleted test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const DOC = 'docs/acceptance-matrix.md';
const text = readFileSync(DOC, 'utf8');

/** `## N. Scenario` sections, each with its listed tests. */
const sections = text
  .split(/^## /m)
  .slice(1)
  .map((block) => ({
    title: block.split('\n')[0].trim(),
    tests: [...block.matchAll(/^- `(test\/[\w.-]+\.test\.js)`: "(.+)"$/gm)].map(
      (m) => ({ file: m[1], name: m[2] })
    ),
  }));

const escapeRe = (/** @type {string} */ s) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('every scenario names at least one regression test', () => {
  assert.equal(sections.length, 19, 'the plan lists 19 acceptance scenarios');
  for (const s of sections) {
    assert.ok(s.tests.length > 0, `${s.title} names no test`);
  }
});

test('every named test is declared, in a file the pipeline suite runs', () => {
  /** @type {string[]} */
  const missing = [];
  for (const s of sections) {
    for (const { file, name } of s.tests) {
      if (!existsSync(file)) {
        missing.push(`${file} does not exist (${s.title})`);
        continue;
      }
      const declared = new RegExp(
        `\\btest\\(\\s*(['"\`])${escapeRe(name)}\\1`
      ).test(readFileSync(file, 'utf8'));
      if (!declared) missing.push(`${file}: "${name}" (${s.title})`);
    }
  }
  assert.deepEqual(missing, []);
});
