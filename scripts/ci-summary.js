#!/usr/bin/env node
// CI summary (Phase 2 TG8; execution scoping + honest zero from task group
// 3.2). Reads, in order of preference:
//
//   1. a normalized execution ledger (analysis/execution-ledger.json), which
//      already separates flaky/blocked/expected_failure from passes;
//   2. the SANITIZED Newman summaries for ONE execution
//      (reports/<execution-id>/published/newman-*.json);
//   3. the Playwright JSON report (reports/results.json).
//
// It counts total/passed/failed/skipped per source and writes a Markdown
// summary to stdout AND to $GITHUB_STEP_SUMMARY when that env var points at a
// file (it does inside GitHub Actions).
//
// Two things this must never do (task group 3.2):
//   * count a report from an unrelated execution as current evidence, which
//     the old flat reports/published/ glob did (finding I4);
//   * report zero verified units as success. A published summary of all zeros
//     used to render as ":white_check_mark: No test failures".
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

import { readFileSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { argv, env, exit } from 'node:process';

const FAIL_ON_TEST_FAILURE = argv.includes('--fail-on-test-failure');

const PW_PATH = 'reports/results.json';
const LEDGER_PATH = env.QAIZEN_LEDGER || 'analysis/execution-ledger.json';
// Sanitized Newman summaries live under ONE execution directory (task group
// 3.2). CI uploads only this subtree; the raw reporter output is
// secret-bearing and stays on the runner.
const REPORTS_ROOT = 'reports';
// Legacy flat locations. Kept as EXPLICIT compatibility reads for local runs
// that predate the per-execution layout — never the CI write path.
const LEGACY_PUBLISHED_DIR = 'reports/published';
const LEGACY_NEWMAN_PATH = 'reports/newman-results.json';

/**
 * Find the published directory for the execution being summarized.
 *
 * An explicit execution id wins. Otherwise the most recent execution
 * directory is used -- and, crucially, only ONE of them: globbing every
 * reports/published/*.json let a stale file from an unrelated story
 * contribute passing assertions to the current run's totals (I4).
 */
function resolvePublishedDir() {
  const explicit = env.QAIZEN_EXECUTION_ID;
  if (explicit) {
    const dir = join(REPORTS_ROOT, explicit, 'published');
    return existsSync(dir)
      ? { dir, executionId: explicit }
      : { dir: null, executionId: explicit };
  }
  if (!existsSync(REPORTS_ROOT)) return { dir: null, executionId: null };
  const executions = readdirSync(REPORTS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('exec-'))
    .map((e) => e.name)
    .sort();
  if (executions.length === 0) return { dir: null, executionId: null };
  const latest = executions[executions.length - 1];
  const dir = join(REPORTS_ROOT, latest, 'published');
  return existsSync(dir)
    ? { dir, executionId: latest }
    : { dir: null, executionId: latest };
}

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

// Sanitized published summary (the CI path). Same assertion-level unit as the
// raw reader, but one row PER COLLECTION so a failing collection is never
// hidden behind a later passing one.
function summarizePublishedNewman(view, label) {
  const a = view?.stats?.assertions ?? {};
  const total = a.total ?? 0;
  const failed = (a.failed ?? 0) || (view?.failures?.length ?? 0);
  const skipped = a.pending ?? 0;
  return {
    source: `API (Newman: ${label})`,
    total,
    passed: Math.max(total - failed - skipped, 0),
    failed,
    skipped,
    flaky: 0,
  };
}

function readPublishedFrom(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isFile() && e.name.startsWith('newman-') && e.name.endsWith('.json')
    )
    .map((e) => e.name)
    .sort()
    .map((name) => {
      const view = readReport(join(dir, name));
      if (!view) return null;
      const label =
        view.collection_id ||
        name.replace(/^newman-|\.json$/g, '') ||
        'unknown';
      return summarizePublishedNewman(view, label);
    })
    .filter(Boolean);
}

/**
 * Summarize a normalized execution ledger.
 *
 * Preferred over raw reports because the ledger already distinguishes the
 * outcomes the raw reports conflate: flaky is not a pass, a declared expected
 * failure is not a pass, and a blocked unit is not a skip.
 */
function summarizeLedger(ledger) {
  const t = ledger?.totals ?? {};
  const n = (k) => t[k] ?? 0;
  return {
    source: `Execution ledger (${ledger.story_id ?? 'unknown story'})`,
    // The projection defined once in scripts/lib/execution-ledger.js.
    total:
      n('passed') +
      n('failed') +
      n('flaky') +
      n('skipped') +
      n('blocked') +
      n('not_run') +
      n('expected_failure'),
    passed: n('passed'),
    failed: n('failed') + n('blocked') + n('flaky'),
    skipped: n('skipped') + n('not_run') + n('expected_failure'),
    flaky: n('flaky'),
    sourceErrors: n('source_error_count'),
  };
}

/**
 * The one-line verdict.
 *
 * `combined.failed === 0` is NOT sufficient for a green check: a run that
 * verified nothing also has zero failures. Zero counted units means the
 * evidence is missing, which is a problem to surface, not a pass.
 */
function verdict(combined) {
  if (combined.sourceErrors > 0) {
    return (
      `> :red_circle: **${combined.sourceErrors} run-level error(s)** occurred ` +
      '(setup/teardown/report). Per-unit results for the affected execution are ' +
      'incomplete, so this tally understates what was left unverified.'
    );
  }
  if (combined.total === 0) {
    return (
      '> :warning: **Zero verified units.** Reports were found but contain no ' +
      'counted test units, so nothing was verified. This is not a pass — check ' +
      'that the suites actually ran.'
    );
  }
  if (combined.failed > 0) {
    return (
      `> :red_circle: **${combined.failed} failed.** See the uploaded Playwright / ` +
      'Newman report artifacts. Classification + severity come from the Failure ' +
      'Classifier (`analysis/failure-analysis.json`), not this tally.'
    );
  }
  return `> :white_check_mark: ${combined.passed} unit(s) passed, no failures.`;
}

const rows = [];
const notes = [];

// 1) A normalized ledger is the most trustworthy source: it has already
//    separated flaky/blocked/expected_failure from real passes.
const ledger = readReport(LEDGER_PATH);
if (ledger) {
  rows.push(summarizeLedger(ledger));
} else {
  // 2) Otherwise fall back to the raw reports for this execution only.
  const pw = readReport(PW_PATH);
  if (pw) rows.push(summarizePlaywright(pw));

  const { dir, executionId } = resolvePublishedDir();
  const published = readPublishedFrom(dir);
  if (published.length > 0) {
    rows.push(...published);
    if (executionId)
      notes.push(`Newman summaries from execution \`${executionId}\`.`);
  } else {
    if (executionId && !dir) {
      notes.push(
        `No published Newman summaries for execution \`${executionId}\`. ` +
          'A collection that verified nothing publishes nothing, by design.'
      );
    }
    // Compatibility: a local run that predates the per-execution layout.
    const legacy = readPublishedFrom(LEGACY_PUBLISHED_DIR);
    if (legacy.length > 0) {
      rows.push(...legacy);
      notes.push(
        'Read legacy `reports/published/` (flat layout). Newer runs write ' +
          '`reports/<execution-id>/published/`.'
      );
    } else {
      const newman = readReport(LEGACY_NEWMAN_PATH);
      if (newman) {
        rows.push(summarizeNewman(newman));
        notes.push('Read legacy `reports/newman-results.json`.');
      }
    }
  }
}

let md;
if (rows.length === 0) {
  md = [
    '## QA Pipeline — CI summary',
    '',
    '_No execution reports found (`reports/results.json`, `reports/published/newman-*.json`)._',
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
      sourceErrors: acc.sourceErrors + (r.sourceErrors ?? 0),
    }),
    { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, sourceErrors: 0 }
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
    verdict(combined),
    notes.length ? '' : null,
    ...notes.map((n) => `> _${n}_`),
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
