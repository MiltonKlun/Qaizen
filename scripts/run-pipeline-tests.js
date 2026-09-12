#!/usr/bin/env node
// Pipeline test discovery wrapper (IMPLEMENTATION_PLAN task group 0.2).
//
// WHY THIS EXISTS: `test:pipeline` used to hardcode a list of six filenames.
// Adding a regression test meant remembering to edit that list, and forgetting
// meant CI silently skipped the new test — a green build that proved less than
// it appeared to. This wrapper discovers the suite instead of trusting a list.
//
// Discovery rule: TOP-LEVEL `test/*.test.js` only, sorted for deterministic
// order. Subdirectories are deliberately NOT scanned, so `test/fixtures/` and
// `test/helpers/` can hold support files without them ever being mistaken for
// tests (a fixture named `*.test.js` in a subdir cannot accidentally run).
//
// It runs them in ONE `node --test` child and propagates that child's exit
// code, so a failing test fails the command. A signal-terminated child reports
// a nonzero status rather than a misleading 0.
//
// Usage:
//   node scripts/run-pipeline-tests.js            # run the discovered suite
//   node scripts/run-pipeline-tests.js --list     # print what would run, exit 0
//   TEST_DIR=<dir> node scripts/run-pipeline-tests.js   # discover elsewhere
//
// Exit codes: the child's code · 1 signal/spawn failure · 2 no tests found

import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { argv, env, execPath, exit } from 'node:process';

// TEST_DIR keeps the wrapper testable: the 0.2 regression test points it at a
// temp directory to prove a failing test really does fail this command.
const TEST_DIR = env.TEST_DIR || 'test';

if (!existsSync(TEST_DIR)) {
  console.error(`Test directory not found: ${TEST_DIR}`);
  exit(2);
}

// Top-level only. withFileTypes so a directory named `x.test.js` is skipped.
const files = readdirSync(TEST_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.test.js'))
  .map((e) => join(TEST_DIR, e.name))
  .sort();

if (files.length === 0) {
  console.error(
    `No test files found in ${TEST_DIR}/ (looked for top-level *.test.js).`
  );
  exit(2);
}

if (argv.includes('--list')) {
  for (const f of files) console.log(f);
  exit(0);
}

console.log(`Discovered ${files.length} test file(s) in ${TEST_DIR}/:`);
for (const f of files) console.log(`  ${f}`);

// Invoke this same Node binary with an argument array (no shell), so paths
// containing spaces are passed literally on every platform.
//
// NODE_TEST_CONTEXT is stripped deliberately: when this wrapper is itself
// invoked from inside a `node --test` child, Node sees that variable, decides
// the runner is recursive, and SKIPS running the files while still exiting 0 —
// a silent no-op that looks like a pass. Clearing it keeps the child a real
// test run in every context.
const childEnv = { ...env };
delete childEnv.NODE_TEST_CONTEXT;

const result = spawnSync(execPath, ['--test', ...files], {
  stdio: 'inherit',
  env: childEnv,
});

if (result.error) {
  console.error(`Failed to run tests: ${result.error.message}`);
  exit(1);
}
// A signal-killed child leaves status null; never report that as success.
if (result.status === null) {
  console.error(`Test process terminated by signal: ${result.signal}`);
  exit(1);
}
exit(result.status);
