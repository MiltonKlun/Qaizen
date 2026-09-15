// Regression tests for the test-discovery wrapper (task group 0.2).
//
// The wrapper is the thing that decides WHAT runs in CI, so its own failure
// modes matter: if it silently skipped a file, or reported success while a
// test failed, every downstream "green" would be worth less than it looks.
// These tests drive it against throwaway suites in temp directories via
// TEST_DIR, so nothing here depends on — or pollutes — the real test/ suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';

const WRAPPER = join('scripts', 'run-pipeline-tests.js');

// Run the wrapper against a scratch suite. Returns { code, out }.
function runWrapper(testDir, args = []) {
  const r = spawnSync(execPath, [WRAPPER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TEST_DIR: testDir },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const passing = `import { test } from 'node:test';
test('passes', () => {});`;
const failing = `import { test } from 'node:test';
import assert from 'node:assert/strict';
test('fails on purpose', () => { assert.equal(1, 2); });`;

function scratchSuite(files) {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-wrapper-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

test('wrapper: a newly added failing test makes the command fail', () => {
  // The whole point of 0.2 — a test file nobody registered by hand must still
  // run, and must still be able to fail the build.
  const dir = scratchSuite({
    'a.test.js': passing,
    'zz-new-regression.test.js': failing,
  });
  try {
    const r = runWrapper(dir);
    assert.notEqual(
      r.code,
      0,
      `expected nonzero exit, got ${r.code}:\n${r.out}`
    );
    assert.match(r.out, /zz-new-regression\.test\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wrapper: an all-passing suite exits 0 and runs every file', () => {
  const dir = scratchSuite({ 'a.test.js': passing, 'b.test.js': passing });
  try {
    const r = runWrapper(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Discovered 2 test file\(s\)/);
    assert.match(r.out, /# pass 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wrapper: subdirectory files are never discovered as tests', () => {
  // Fixtures/helpers live in subdirectories. A *.test.js file down there must
  // not run, or a fixture could fail the build (or worse, quietly pass).
  const dir = scratchSuite({ 'a.test.js': passing });
  mkdirSync(join(dir, 'fixtures'));
  writeFileSync(join(dir, 'fixtures', 'trap.test.js'), failing);
  try {
    const r = runWrapper(dir);
    assert.equal(r.code, 0, `subdir test must not run:\n${r.out}`);
    assert.doesNotMatch(r.out, /trap\.test\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wrapper: --list prints discovered files without running them', () => {
  const dir = scratchSuite({ 'a.test.js': passing, 'b.test.js': failing });
  try {
    const r = runWrapper(dir, ['--list']);
    // Exits 0 even though b.test.js fails, because --list does not run tests.
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /a\.test\.js/);
    assert.match(r.out, /b\.test\.js/);
    assert.doesNotMatch(r.out, /# pass/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wrapper: an empty or missing test directory is a usage error (exit 2)', () => {
  const empty = mkdtempSync(join(tmpdir(), 'qaizen-wrapper-empty-'));
  try {
    assert.equal(runWrapper(empty).code, 2);
    assert.equal(runWrapper(join(empty, 'does-not-exist')).code, 2);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
