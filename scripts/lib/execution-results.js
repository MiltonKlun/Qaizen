// Runner-report adapters (task group 3.1).
//
// Pure functions: JSON report in, ledger units out. No file I/O, no clock, no
// process state -- so every rule below is testable against a REAL captured
// report rather than a hand-written approximation.
//
// These exist because the raw reports cannot be counted directly:
//
//   B2  Playwright's `timedOut` is an ATTEMPT status, never a test status. Code
//       that matches on the last attempt's status and checks only
//       'unexpected'/'failed' silently drops a hung test -- a false green.
//   B5  Newman's `failures[]` includes transport errors that produced no
//       assertion, so `assertions.total - failures.length` is not a pass count
//       and can go negative.
//   B6  A domain ID is proven from metadata or it is null with a reason. It is
//       NEVER derived from failure ordering.
//
// Outcome vocabulary and invariants live in ./execution-ledger.js.

import { redactText } from './report-sanitization.js';

/** Max characters of any error excerpt carried into durable evidence. */
const ERROR_EXCERPT_LIMIT = 600;

/**
 * Playwright test-level statuses. `timedOut` is deliberately ABSENT: it appears
 * only on attempts. Kept as documentation of the real shape (see B2).
 */
const PW_TEST_STATUS = ['expected', 'unexpected', 'flaky', 'skipped'];

/**
 * Playwright's attempt statuses, mapped to the ledger's attempt vocabulary.
 * Playwright emits camelCase `timedOut`; the ledger schema names it
 * `timed_out`. Passing the raw value straight through produces a ledger that
 * fails validation, so the translation belongs here, at the boundary.
 */
const PW_ATTEMPT_STATUS = {
  passed: 'passed',
  failed: 'failed',
  timedOut: 'timed_out',
  interrupted: 'interrupted',
  skipped: 'skipped',
};

const ANSI = /\u001b\[[0-9;]*m/g;

function excerpt(text, secrets) {
  if (!text) return undefined;
  // Terminal colour codes are stripped BEFORE truncation: real Playwright
  // messages carry dozens of them, which both pollute durable evidence and eat
  // into the excerpt budget ahead of the `Received:` line (task group 3.3).
  const clean = redactText(String(text).replace(ANSI, ''), secrets);
  return clean.length > ERROR_EXCERPT_LIMIT
    ? clean.slice(0, ERROR_EXCERPT_LIMIT)
    : clean;
}

/**
 * Collect every test in a Playwright JSON report, flattening nested suites.
 * Each entry keeps its spec title path, project and attempts.
 */
function collectPlaywrightTests(report) {
  const found = [];
  const walk = (suites, titlePath) => {
    for (const suite of suites || []) {
      const path = suite.title ? [...titlePath, suite.title] : titlePath;
      for (const spec of suite.specs || []) {
        for (const t of spec.tests || []) {
          found.push({
            spec,
            test: t,
            file: spec.file || suite.file,
            titlePath: [...path, spec.title],
          });
        }
      }
      if (suite.suites) walk(suite.suites, path);
    }
  };
  walk(report.suites, []);
  return found;
}

/**
 * Map one Playwright test onto exactly one ledger outcome.
 *
 * Uses the AGGREGATE test status, not the last attempt -- that is what makes a
 * retried-then-passing test `flaky` rather than `passed`, and what stops a
 * timed-out test from vanishing (B2).
 */
export function playwrightOutcome(test) {
  const attempts = test.results || [];
  const statuses = attempts.map((a) => a.status);

  // Nothing ran at all: not_run, never passed.
  if (attempts.length === 0) return 'not_run';

  // An interrupted attempt means we have no trustworthy result for this test.
  if (statuses.includes('interrupted') && test.status !== 'expected') {
    return 'blocked';
  }

  switch (test.status) {
    case 'flaky':
      return 'flaky';
    case 'skipped':
      return 'skipped';
    case 'expected':
      // A declared expected failure (test.fail()) reports status `expected`
      // with expectedStatus `failed`. It is NOT passing coverage.
      return test.expectedStatus === 'failed' ? 'expected_failure' : 'passed';
    case 'unexpected':
      // Covers assertion failures AND timeouts: `timedOut` lives on the
      // attempt, so matching attempt statuses here would drop it (B2).
      return 'failed';
    default:
      // An unrecognized status is unverified evidence, never a pass.
      return 'blocked';
  }
}

/**
 * Adapt a Playwright JSON report into ledger units.
 *
 * @param {object} report     parsed Playwright JSON report
 * @param {object} opts
 * @param {string} opts.executionId  the source execution these units belong to
 * @param {string[]} [opts.secrets]  values to redact from error excerpts
 * @returns {{units: object[], sourceErrors: object[]}}
 */
export function adaptPlaywrightReport(report, { executionId, secrets = [] }) {
  if (!report || typeof report !== 'object') {
    throw new TypeError('adaptPlaywrightReport: report must be an object');
  }
  if (!executionId) {
    throw new TypeError('adaptPlaywrightReport: executionId is required');
  }

  const units = [];
  const seen = new Map();

  for (const { test, spec, file, titlePath } of collectPlaywrightTests(
    report
  )) {
    const project = test.projectName || '';
    const repeatIndex = test.repeatEachIndex ?? 0;

    // Runner-native identity. Deterministic and independent of outcome, so a
    // unit keeps the same id whether it passes or fails (contrast B6).
    const key = `${file}::${titlePath.join(' > ')}::${project}::${repeatIndex}`;
    const ordinal = (seen.get(key) ?? -1) + 1;
    seen.set(key, ordinal);

    const attempts = (test.results || []).map((a) => {
      const message =
        (a.errors && a.errors[0]?.message) || a.error?.message || '';
      const out = {
        // An unrecognized attempt status is recorded as a failure rather than
        // dropped: unknown evidence is never silently favourable.
        status: PW_ATTEMPT_STATUS[a.status] ?? 'failed',
      };
      if (typeof a.duration === 'number' && a.duration >= 0) {
        out.duration_ms = Math.round(a.duration);
      }
      const ex = excerpt(message, secrets);
      if (ex) out.error_message = ex;
      return out;
    });

    units.push({
      unit_id: `pw:${project || 'default'}:${titlePath.join(' > ')}${ordinal ? `#${ordinal}` : ''}`,
      execution_id: executionId,
      identity: {
        kind: 'playwright',
        test_title: titlePath.join(' > '),
        ...(file ? { file } : {}),
        ...(project ? { project } : {}),
        repeat_index: repeatIndex,
      },
      // Domain links are resolved by the caller from test metadata. Never
      // invented here (B6).
      domain_links: {
        test_case_id: null,
        playwright_test_id: null,
        spec_id: null,
        unresolved_reason:
          'Adapter reads the runner report only; domain IDs come from test metadata resolved by the caller.',
      },
      outcome: playwrightOutcome(test),
      ...(attempts.length ? { attempts } : {}),
    });

    void spec;
  }

  // Report-level errors survive even when zero tests appear.
  const sourceErrors = (report.errors || [])
    .map((e) => {
      const message = excerpt(e?.message || String(e ?? ''), secrets);
      return message ? { message, phase: 'run' } : null;
    })
    .filter(Boolean);

  return { units, sourceErrors };
}

/**
 * Map one Newman execution onto exactly one ledger outcome.
 *
 * Order matters: transport failure is checked FIRST, because a test script that
 * ran against no response can still emit a failed assertion, and counting that
 * as a business failure would misreport a blocked request.
 */
export function newmanOutcome(execution) {
  if (execution.requestError) return 'blocked';
  if (!execution.response) return 'blocked';

  const assertions = execution.assertions || [];
  // A request that asserted nothing verified nothing, however well the
  // transport went.
  if (assertions.length === 0) return 'blocked';

  const skipped = assertions.filter((a) => a.skipped);
  if (skipped.length === assertions.length) return 'skipped';

  return assertions.some((a) => a.error) ? 'failed' : 'passed';
}

/**
 * Adapt a Newman JSON report into ledger units: one unit per request per
 * iteration, with assertions NESTED as evidence rather than counted as units.
 *
 * @param {object} report parsed Newman JSON report
 * @param {object} opts
 * @param {string} opts.executionId
 * @param {string} [opts.collectionId]
 * @param {string[]} [opts.secrets]
 * @returns {{units: object[], sourceErrors: object[]}}
 */
export function adaptNewmanReport(
  report,
  { executionId, collectionId, secrets = [] }
) {
  if (!report || typeof report !== 'object') {
    throw new TypeError('adaptNewmanReport: report must be an object');
  }
  if (!executionId) {
    throw new TypeError('adaptNewmanReport: executionId is required');
  }

  const run = report.run || {};
  const collection =
    collectionId || report.collection?.info?._postman_id || 'collection';
  const units = [];
  const seen = new Map();

  for (const e of run.executions || []) {
    const name = e.item?.name || '(unnamed request)';
    const iteration = e.cursor?.iteration ?? 0;

    const key = `${collection}::${name}::${iteration}`;
    const ordinal = (seen.get(key) ?? -1) + 1;
    seen.set(key, ordinal);

    const assertions = (e.assertions || []).map((a) => {
      const out = {
        name: a.assertion || '(unnamed assertion)',
        passed: !a.error && !a.skipped,
      };
      const ex = excerpt(a.error?.message, secrets);
      if (ex) out.error_message = ex;
      return out;
    });

    const unit = {
      unit_id: `newman:${collection}:${name}:${iteration}${ordinal ? `#${ordinal}` : ''}`,
      execution_id: executionId,
      identity: {
        kind: 'newman',
        collection_id: collection,
        request_name: name,
        iteration,
      },
      domain_links: {
        api_test_case_id: null,
        request_id: null,
        unresolved_reason:
          'Adapter reads the runner report only; domain IDs come from collection metadata resolved by the caller.',
      },
      outcome: newmanOutcome(e),
      ...(assertions.length ? { assertions } : {}),
    };

    // A transport failure is evidence about the request, recorded as an
    // attempt -- NOT subtracted from assertion totals (B5).
    if (e.requestError) {
      const code =
        typeof e.requestError === 'object'
          ? e.requestError.code || e.requestError.errno
          : String(e.requestError);
      const message = excerpt(
        typeof e.requestError === 'object'
          ? `${code}: request to ${e.request?.url?.raw ?? 'the target host'} did not complete`
          : String(e.requestError),
        secrets
      );
      unit.attempts = [
        { status: 'failed', ...(message ? { error_message: message } : {}) },
      ];
    }

    units.push(unit);
  }

  return { units, sourceErrors: [] };
}

export const __testing = {
  PW_TEST_STATUS,
  PW_ATTEMPT_STATUS,
  ERROR_EXCERPT_LIMIT,
};
