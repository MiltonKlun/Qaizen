#!/usr/bin/env node
// A stand-in for the Playwright CLI, used by test/run-healer.test.js through
// QAIZEN_PLAYWRIGHT_CLI so the healer's orchestration can be tested without a
// browser (CI's quality job installs none). It is not a test runner: it reads
// the selected test file and writes a Playwright-shaped JSON report to
// PLAYWRIGHT_JSON_OUTPUT_NAME, choosing the outcome from markers in the file:
//
//   '#missing-button'  -> failed (a locator that matches nothing)
//   FAKE_SKIP          -> skipped
//   FAKE_ZERO          -> no test executed
//   FAKE_TWO           -> two tests executed
//   otherwise          -> passed
//
// It also records every invocation (args) in FAKE_CLI_LOG (a JSONL file),
// so tests can assert what was run and that no snapshot update was requested.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const args = process.argv.slice(2);
appendFileSync(
  process.env.FAKE_CLI_LOG ?? 'fake-cli-calls.jsonl',
  JSON.stringify(args) + '\n'
);

const file = args[1];
const src = readFileSync(file, 'utf8');
const title = (src.match(/test\(\s*'([^']+)'/) || [])[1] ?? 'unknown';
const project = (() => {
  const i = args.indexOf('--project');
  return i === -1 ? '' : args[i + 1];
})();

const status = src.includes('#missing-button')
  ? 'failed'
  : src.includes('FAKE_SKIP')
    ? 'skipped'
    : 'passed';
const result = (s) => ({
  workerIndex: 0,
  status: s,
  duration: 12,
  errors:
    s === 'failed'
      ? [
          {
            message:
              "locator.click: Timeout 2000ms exceeded.\n  - waiting for locator('#missing-button')",
          },
        ]
      : [],
  retry: 0,
});
const testEntry = (s) => ({
  projectName: project,
  expectedStatus: 'passed',
  status:
    s === 'failed' ? 'unexpected' : s === 'skipped' ? 'skipped' : 'expected',
  results: [result(s)],
  annotations: [],
});
const spec = (t, s) => ({
  title: t,
  ok: s !== 'failed',
  tags: [],
  tests: [testEntry(s)],
  file: basename(file),
});

let specs = [spec(title, status)];
if (src.includes('FAKE_ZERO')) specs = [];
if (src.includes('FAKE_TWO'))
  specs = [spec(title, status), spec(`${title} (copy)`, status)];

const report = {
  config: {},
  suites: specs.length
    ? [{ title: basename(file), file: basename(file), specs }]
    : [],
  errors: [],
  stats: {},
};
writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify(report));
process.exit(status === 'failed' ? 1 : 0);
