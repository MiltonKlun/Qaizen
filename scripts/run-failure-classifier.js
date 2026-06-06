#!/usr/bin/env node
// Rule-based failure pre-classifier (Phase 3 TG1). Reads the Playwright JSON
// report (+ optional Newman report) and produces a schema-valid
// analysis/failure-analysis.json by applying DETERMINISTIC signal rules —
// fast, zero LLM cost for the obvious cases. Genuinely ambiguous failures are
// marked `unknown_needs_human_review` (severity yellow): that is the
// "escalate" path. In a headless script there is no LLM to call, so escalation
// = flag-for-human; the Failure Classifier Agent (agents/failure-classifier.md)
// or a human resolves those. This script never invents a classification it is
// not confident about — when unsure, it escalates.
//
// It maps each failure to the closed taxonomy in
// schemas/failure-analysis.schema.json and respects the schema's conditional
// rules (red => bug_draft_path; test_case_id:null => traceability_unresolved;
// newman => request_id; playwright => playwright_test_id).
//
// Gate 4 precondition: like the Failure Classifier Agent, refuses unless
// context.json.review_gates.code_reviewed is passed.
//
// Usage:
//   node scripts/run-failure-classifier.js                 # write analysis/failure-analysis.json
//   node scripts/run-failure-classifier.js --blocking      # exit 1 if any product_bug found
//   node scripts/run-failure-classifier.js --dry-run       # print, do not write
//
// Exit codes: 0 ok · 1 --blocking with product_bug present · 2 usage/gate/file error

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

const BLOCKING = argv.includes('--blocking');
const DRY = argv.includes('--dry-run');

const PW_PATH = 'reports/results.json';
const NEWMAN_PATH = 'reports/newman-results.json';
const OUT = 'analysis/failure-analysis.json';

if (!existsSync('context.json')) {
  console.error('No context.json at root.');
  exit(2);
}
const context = JSON.parse(readFileSync('context.json', 'utf8'));

// Gate 4 precondition (same rule as the Failure Classifier Agent).
const g = context.review_gates?.code_reviewed;
if (!(g === true || (g && g.status === true))) {
  console.error(
    'Gate 4 (code_reviewed) is not passed; refusing to classify. Classifying ' +
      'unreviewed code is forbidden (agents/failure-classifier.md §2).'
  );
  exit(2);
}

if (!existsSync(PW_PATH)) {
  console.error(`No Playwright report at ${PW_PATH}. Run the suite first.`);
  exit(2);
}
const pw = JSON.parse(readFileSync(PW_PATH, 'utf8'));
const newman = existsSync(NEWMAN_PATH)
  ? JSON.parse(readFileSync(NEWMAN_PATH, 'utf8'))
  : null;

// ---- deterministic signal rules ----------------------------------------
// Returns { classification, severity } from an error message + context.
function classifyPlaywright(msg) {
  const m = (msg || '').toLowerCase();

  // locator / selector signals (no business assertion) -> green, auto-healable
  if (
    /locator|selector|getby|waiting for .*(locator|element)|element is not (visible|attached)|strict mode violation|no element/.test(
      m
    )
  ) {
    return { classification: 'locator_or_selector', severity: 'green' };
  }
  // explicit timeouts / waits -> green (unless it smells like environment)
  if (/timeout .*exceeded|timed out|exceeded.*timeout/.test(m)) {
    if (/net::|econnrefused|dns|getaddrinfo|socket hang up/.test(m)) {
      return { classification: 'environment_issue', severity: 'yellow' };
    }
    return { classification: 'wait_or_timeout', severity: 'green' };
  }
  // connection / network -> environment
  if (
    /net::err|econnrefused|enotfound|getaddrinfo|dns|socket hang up|tls|certificate/.test(
      m
    )
  ) {
    return { classification: 'environment_issue', severity: 'yellow' };
  }
  // a business assertion mismatch -> product bug (RED), but only when the
  // message clearly shows expected-vs-received business values.
  if (
    /expect\(received\)|expected:.*received:|toequal|tohavetext|tohavevalue|tohaveurl|tohavecount/.test(
      m
    )
  ) {
    return { classification: 'product_bug', severity: 'red' };
  }
  // setup / fixture failure -> test bug
  if (/beforeeach|beforeall|fixture|setup|hook/.test(m)) {
    return { classification: 'test_bug', severity: 'yellow' };
  }
  // nothing matched with confidence -> escalate
  return { classification: 'unknown_needs_human_review', severity: 'yellow' };
}

// Newman heuristics (agents/failure-classifier.md §3 table).
function classifyNewman(failure) {
  const name = (failure.error?.name || '').toLowerCase();
  const test = (failure.error?.test || '').toLowerCase();
  const msg = (failure.error?.message || '').toLowerCase();
  const blob = `${name} ${test} ${msg}`;
  if (/econnrefused|enotfound|getaddrinfo|socket|tls|certificate/.test(blob)) {
    return { classification: 'environment_issue', severity: 'yellow' };
  }
  if (/timed out|timeout|esockettimedout/.test(blob)) {
    return { classification: 'wait_or_timeout', severity: 'green' };
  }
  // assertion on a business field/status -> product bug
  if (/expected|status code|to have|to equal|to be/.test(blob)) {
    return { classification: 'product_bug', severity: 'red' };
  }
  return { classification: 'unknown_needs_human_review', severity: 'yellow' };
}

// ---- walk the Playwright report -----------------------------------------
const failures = [];
let failSeq = 0;
const stats = pw.stats || {};
const total =
  (stats.expected || 0) +
  (stats.unexpected || 0) +
  (stats.skipped || 0) +
  (stats.flaky || 0);

function walkSuites(suites, titlePath = []) {
  for (const suite of suites || []) {
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        const result = (t.results || [])[t.results.length - 1] || {};
        const status = result.status;
        if (status === 'unexpected' || status === 'failed') {
          const err =
            (result.errors && result.errors[0]?.message) ||
            result.error?.message ||
            '';
          const { classification, severity } = classifyPlaywright(err);
          failSeq += 1;
          const id = `FAIL-${String(failSeq).padStart(3, '0')}`;
          const f = {
            failure_id: id,
            // No reliable TC mapping from the raw report alone — escalate the
            // linkage honestly rather than fake it (schema rule 1).
            test_case_id: null,
            traceability_unresolved: true,
            traceability_unresolved_reason:
              'Rule-based pre-classifier cannot map a raw Playwright failure to a TC-XXX; the Failure Classifier Agent resolves the linkage from test metadata.',
            playwright_test_id: `PW-${String(failSeq).padStart(3, '0')}`,
            source: 'playwright',
            classification,
            severity,
            error_message: String(err).slice(0, 600),
            evidence_paths: ['reports/html', 'reports/results.json'],
          };
          // schema rule 0: red => bug_draft_path required.
          if (severity === 'red')
            f.bug_draft_path = `release/bug-drafts/BUG-${String(failSeq).padStart(3, '0')}.md`;
          failures.push(f);
        }
      }
    }
    if (suite.suites) walkSuites(suite.suites, titlePath);
  }
}
walkSuites(pw.suites);

// ---- Newman failures -----------------------------------------------------
let apiTotal = 0;
if (newman?.run) {
  const a = newman.run.stats?.assertions || {};
  apiTotal = a.total || 0;
  for (const failure of newman.run.failures || []) {
    const { classification, severity } = classifyNewman(failure);
    failSeq += 1;
    const f = {
      failure_id: `FAIL-${String(failSeq).padStart(3, '0')}`,
      test_case_id: null,
      traceability_unresolved: true,
      traceability_unresolved_reason:
        'Rule-based pre-classifier cannot map a Newman failure to an API-XXX; the Failure Classifier Agent resolves it from the collection.',
      source: 'newman',
      request_id: `REQ-${String(failSeq).padStart(3, '0')}`,
      classification,
      severity,
      error_message: String(failure.error?.message || '').slice(0, 600),
      evidence_paths: ['reports/newman-html', 'reports/newman-results.json'],
    };
    if (severity === 'red')
      f.bug_draft_path = `release/bug-drafts/BUG-${String(failSeq).padStart(3, '0')}.md`;
    failures.push(f);
  }
}

const doc = {
  schema_version: '1.0',
  run_id: context.run_id || new Date().toISOString(),
  story_id: context.story?.id || 'UNKNOWN',
  execution_date: new Date().toISOString(),
  total_tests: total + apiTotal,
  passed:
    (stats.expected || 0) +
    (newman
      ? (newman.run.stats?.assertions?.total || 0) -
        (newman.run.failures?.length || 0)
      : 0),
  failed: failures.length,
  skipped: stats.skipped || 0,
  failures,
  status: 'draft',
};

// ---- report -------------------------------------------------------------
const counts = failures.reduce((acc, f) => {
  acc[f.classification] = (acc[f.classification] || 0) + 1;
  return acc;
}, {});
console.log('Rule-based pre-classification');
console.log(`  Total tests: ${doc.total_tests} | failed: ${doc.failed}`);
for (const [c, n] of Object.entries(counts)) console.log(`    ${c}: ${n}`);
const escalated = failures.filter(
  (f) => f.classification === 'unknown_needs_human_review'
).length;
if (escalated) console.log(`  ${escalated} escalated to human/LLM review.`);

if (DRY) {
  console.log('\nDRY RUN (not written).');
  console.log(JSON.stringify(doc, null, 2));
  exit(0);
}

if (!existsSync('analysis')) mkdirSync('analysis', { recursive: true });
writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
console.log(
  `\nWrote ${OUT}. Validate + resolve TC linkage via the Failure Classifier Agent.`
);
console.log(
  'Note: this is the deterministic PRE-classifier. It maps obvious failures ' +
    'and escalates ambiguous ones; it does NOT resolve TC linkage or call an ' +
    'LLM (a headless script cannot). The agent finishes the job.'
);

const productBugs = failures.filter(
  (f) => f.classification === 'product_bug'
).length;
exit(BLOCKING && productBugs > 0 ? 1 : 0);
