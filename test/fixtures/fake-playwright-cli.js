#!/usr/bin/env node
// A stand-in for the Playwright CLI, used by test/run-healer.test.js through
// QAIZEN_PLAYWRIGHT_CLI so the healer's orchestration can be tested without a
// browser (CI's quality job installs none). It is not a test runner: it reads
// the selected test file and writes a Playwright-shaped JSON report to
// PLAYWRIGHT_JSON_OUTPUT_NAME, choosing the outcome of each run from markers
// in the file:
//
//   '#missing-button'  -> failed (a locator that matches nothing), every run,
//                         at the line that names it
//   FAKE_FLAKY         -> fails on the first of every two runs, passes on the
//                         other (a flaky test, not a broken locator)
//   FAKE_ELSEWHERE     -> fails every run, alternating between two lines
//   FAKE_SOMETIMES     -> passes, except the third run fails (once the
//                         missing button is fixed)
//   FAKE_SKIP          -> skipped
//   FAKE_ZERO          -> no test executed
//   FAKE_TWO           -> two tests executed
//   otherwise          -> passed
//
// --repeat-each N writes N runs, one spec entry per run, as Playwright does.
// It also records every invocation (args) in FAKE_CLI_LOG (a JSONL file),
// so tests can assert what was run and that no snapshot update was requested.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const args = process.argv.slice(2);
appendFileSync(
  process.env.FAKE_CLI_LOG ?? 'fake-cli-calls.jsonl',
  JSON.stringify(args) + '\n'
);

const file = args[1];
const src = readFileSync(file, 'utf8');
const title = (src.match(/test\(\s*'([^']+)'/) || [])[1] ?? 'unknown';
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const project = flag('--project', '');
const repeat = Number(flag('--repeat-each', '1'));

const lines = src.split('\n');
const lineOf = (needle) =>
  Math.max(1, lines.findIndex((l) => l.includes(needle)) + 1);
const failLine = lineOf('#missing-button');

/** The outcome of run i, and the line it failed at. */
const outcome = (i) => {
  if (src.includes('FAKE_FLAKY'))
    return i % 2 === 0 ? ['failed', failLine] : ['passed', 0];
  if (src.includes('FAKE_ELSEWHERE'))
    return ['failed', i % 2 === 0 ? failLine : failLine + 1];
  if (src.includes('#missing-button')) return ['failed', failLine];
  if (src.includes('FAKE_SOMETIMES'))
    return i === 2 ? ['failed', 1] : ['passed', 0];
  if (src.includes('FAKE_SKIP')) return ['skipped', 0];
  return ['passed', 0];
};

const result = (s, line) => {
  const error =
    s === 'failed'
      ? {
          message:
            "locator.click: Timeout 2000ms exceeded.\n  - waiting for locator('#missing-button')",
          location: { file: resolve(file), line, column: 5 },
        }
      : null;
  return {
    workerIndex: 0,
    status: s,
    duration: 12,
    errors: error ? [error] : [],
    ...(error ? { error } : {}),
    retry: 0,
  };
};
const testEntry = (s, line) => ({
  projectName: project,
  expectedStatus: 'passed',
  status:
    s === 'failed' ? 'unexpected' : s === 'skipped' ? 'skipped' : 'expected',
  results: [result(s, line)],
  annotations: [],
});
const spec = (t, i) => {
  const [s, line] = outcome(i);
  return {
    title: t,
    ok: s !== 'failed',
    tags: [],
    tests: [testEntry(s, line)],
    file: basename(file),
    line: 3,
    column: 1,
  };
};

let specs = Array.from({ length: repeat }, (_, i) => spec(title, i));
if (src.includes('FAKE_ZERO')) specs = [];
if (src.includes('FAKE_TWO'))
  specs = [spec(title, 0), spec(`${title} (copy)`, 0)];

const report = {
  config: {},
  suites: specs.length
    ? [{ title: basename(file), file: basename(file), specs }]
    : [],
  errors: [],
  stats: {},
};
writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify(report));
process.exit(specs.some((x) => !x.ok) ? 1 : 0);
