#!/usr/bin/env node
// CI summary (Phase 2 TG8). Reads the Playwright JSON report
// (reports/results.json) and the Newman JSON report
// (reports/newman-results.json) if present, counts total/passed/failed/
// skipped per source, and writes a Markdown summary to stdout AND to
// $GITHUB_STEP_SUMMARY when that env var points at a file (it does inside
// GitHub Actions).
//
// This does NOT replace analysis/failure-analysis.json — that is the
// Failure Classifier Agent's classified, severity-bearing output. This is
// a mechanical pass/fail tally for the PR surface; it makes no judgment.
//
// Blocking semantics (TG8): by default this script exits 0 even when tests
// failed — the per-job pass/fail in the workflow decides blocking. The
// Playwright/Newman jobs are informational (continue-on-error) until the
// suite is stable, so a red test must not fail the summary step and block
// a PR on its own. Pass --fail-on-test-failure to make this script exit 1
// when any test failed (use only once the team promotes the suite to
// blocking).
//
// Usage:
//   node scripts/ci-summary.js
//   node scripts/ci-summary.js --fail-on-test-failure
//
// Exit codes: 0 ok · 1 only with --fail-on-test-failure and a failed test
//             · 2 a report file existed but was unreadable/invalid

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

const FAIL_ON_TEST_FAILURE = argv.includes('--fail-on-test-failure');

const PW_PATH = 'reports/results.json';
const NEWMAN_PATH = 'reports/newman-results.json';

function readReport(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`Report ${path} is not valid JSON: ${e.message}`);
    exit(2);
  }
}

// Playwright JSON reporter: stats = { expected, unexpected, skipped, flaky }.
// expected = passed, unexpected = failed.
function summarizePlaywright(report) {
  const s = report?.stats ?? {};
  const passed = s.expected ?? 0;
  const failed = s.unexpected ?? 0;
  const skipped = s.skipped ?? 0;
  const flaky = s.flaky ?? 0;
  const total = passed + failed + skipped + flaky;
  return { source: 'E2E (Playwright)', total, passed, failed, skipped, flaky };
}

// Newman JSON reporter: run.stats.assertions = { total, pending, failed }.
// We report at the assertion level (the meaningful pass/fail unit), and
// include request failures as part of failed.
function summarizeNewman(report) {
  const stats = report?.run?.stats ?? {};
  const a = stats.assertions ?? {};
  const reqFailedFromExec = Array.isArray(report?.run?.failures)
    ? report.run.failures.length
    : 0;
  const failed = (a.failed ?? 0) || reqFailedFromExec;
  const total = a.total ?? 0;
  const passed = Math.max(total - failed - (a.pending ?? 0), 0);
  const skipped = a.pending ?? 0;
  return {
    source: 'API (Newman)',
    total,
    passed,
    failed,
    skipped,
    flaky: 0,
  };
}

const rows = [];
const pw = readReport(PW_PATH);
if (pw) rows.push(summarizePlaywright(pw));
const newman = readReport(NEWMAN_PATH);
if (newman) rows.push(summarizeNewman(newman));

let md;
if (rows.length === 0) {
  md = [
    '## QA Pipeline — CI summary',
    '',
    '_No execution reports found (`reports/results.json`, `reports/newman-results.json`)._',
    'Quality checks may still have run; see the `quality-checks` job.',
    '',
  ].join('\n');
} else {
  const combined = rows.reduce(
    (acc, r) => ({
      total: acc.total + r.total,
      passed: acc.passed + r.passed,
      failed: acc.failed + r.failed,
      skipped: acc.skipped + r.skipped,
      flaky: acc.flaky + r.flaky,
    }),
    { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 }
  );
  const pct = (p, t) => (t > 0 ? `${Math.round((p / t) * 100)}%` : 'n/a');
  const line = (r) =>
    `| ${r.source} | ${r.total} | ${r.passed} | ${r.failed} | ${r.skipped} | ${r.flaky} | ${pct(r.passed, r.total)} |`;
  md = [
    '## QA Pipeline — CI summary',
    '',
    '| Source | Total | Passed | Failed | Skipped | Flaky | Pass rate |',
    '| ------ | ----- | ------ | ------ | ------- | ----- | --------- |',
    ...rows.map(line),
    rows.length > 1 ? line({ source: '**Combined**', ...combined }) : null,
    '',
    combined.failed > 0
      ? `> :red_circle: **${combined.failed} failed.** See the uploaded Playwright / Newman report artifacts. Classification + severity come from the Failure Classifier (\`analysis/failure-analysis.json\`), not this tally.`
      : '> :white_check_mark: No test failures in the executed suites.',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

console.log(md);

// Append to the GitHub Actions step summary when running in CI.
const summaryFile = env.GITHUB_STEP_SUMMARY;
if (summaryFile) {
  try {
    appendFileSync(summaryFile, md + '\n');
  } catch (e) {
    console.error(`Could not write GITHUB_STEP_SUMMARY: ${e.message}`);
    // Not fatal — the stdout summary still printed.
  }
}

const anyFailed = rows.some((r) => r.failed > 0);
exit(FAIL_ON_TEST_FAILURE && anyFailed ? 1 : 0);
