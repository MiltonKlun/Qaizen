#!/usr/bin/env node
// Rule-based failure pre-classifier (Phase 3 TG1; rebuilt on the execution
// ledger in task group 3.3).
//
// Reads the normalized execution ledger (analysis/execution-ledger.json, from
// `npm run normalize`) and writes a schema-valid DRAFT
// analysis/failure-analysis.json (schema_version 2.0). Every failed, blocked
// and flaky unit gets a cause, a severity and the evidence behind the call.
//
// What changed, and why (all verified on a real Chromium run first):
//
//   B1  A wrong business value ($100.00 expected, $1.00 shown) was classified
//       green/locator_or_selector -- eligible for auto-healing -- because the
//       error text contains "locator". Causes now come from what Playwright
//       says FAILED (scripts/lib/classify-failure.js), in the plan's order.
//   B2  A timed-out test disappeared: only 'unexpected'/'failed' attempt
//       statuses were read. The ledger normalizes every terminal outcome.
//   B5  Newman passes were `assertions.total - failures.length` (could go
//       negative), and the artifact was written with no validation. Counts now
//       come from the ledger and the file goes through the validated writer.
//   B6  PW-/REQ- ids were minted from a running failure counter. They now come
//       only from proven metadata; otherwise they are null WITH a reason.
//
// This is a PRE-classifier. It never finalizes: it writes status "draft",
// creates no bug drafts, and tells the human / Failure Classifier Agent what
// must happen before the Reporter step.
//
// Gate 4 precondition: like the Failure Classifier Agent, refuses unless
// context.json.review_gates.code_reviewed is passed.
//
// Usage:
//   node scripts/run-failure-classifier.js [--ledger <path>]   # write the draft
//   node scripts/run-failure-classifier.js --blocking          # exit 1 on a product_bug
//   node scripts/run-failure-classifier.js --dry-run           # print, do not write
//
// Exit codes: 0 ok · 1 --blocking with product_bug present, or the analysis
//             could not be written · 2 usage / gate / missing-or-invalid evidence

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

import { writeJsonAtomic, formatErrors } from './lib/artifact-io.js';
import {
  readLedger,
  legacySummaryProjection,
  UNIT_OUTCOMES,
} from './lib/execution-ledger.js';
import { classifyUnit } from './lib/classify-failure.js';

const OUT = 'analysis/failure-analysis.json';
// Resolved from this script's location, not the CWD: the pipeline runner may
// drive the classifier from an isolated run workspace.
const SCHEMA = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas',
  'failure-analysis.schema.json'
);
const DEFAULT_LEDGER = 'analysis/execution-ledger.json';

/** Units that belong in a failure analysis. Passes and skips do not. */
const ANALYZED = new Set(['failed', 'blocked', 'flaky']);

function flag(name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`Error: ${name} requires a value`);
    exit(2);
  }
  return v;
}

const BLOCKING = argv.includes('--blocking');
const DRY = argv.includes('--dry-run');
const LEDGER = flag('--ledger') || DEFAULT_LEDGER;

// ---- preconditions ------------------------------------------------------
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

const storyId = context.story?.id;
if (!storyId) {
  console.error(
    'context.json has no story.id; cannot tell which run to classify.'
  );
  exit(2);
}

// Missing or invalid evidence is an evidence error, never a green result.
if (!existsSync(LEDGER)) {
  console.error(`No execution ledger at ${LEDGER}.`);
  console.error(
    `  Normalize the run first:  npm run normalize -- --story ${storyId} ` +
      '--playwright reports/results.json [--execution <id>]'
  );
  exit(2);
}
const loaded = readLedger(LEDGER, {
  storyId,
  ...(context.run_id ? { runId: context.run_id } : {}),
});
if (!loaded.ok) {
  console.error(`Refusing to classify: ${loaded.message}`);
  for (const v of loaded.violations || []) console.error(`  - ${v}`);
  if (loaded.errors) {
    for (const line of formatErrors(loaded.errors, { includeParams: false })) {
      console.error(line);
    }
  }
  if (loaded.kind === 'identity_mismatch' && context.run_id) {
    console.error(
      `  Re-normalize with --run-id ${context.run_id} so the ledger belongs to this run.`
    );
  }
  exit(2);
}
const ledger = loaded.data;

const external = ledger.units.filter((u) => u.identity?.kind === 'external');
if (external.length) {
  console.error(
    `The ledger holds ${external.length} external/manual unit(s); classifying those arrives with ` +
      'manual result import (Phase 7). Refusing rather than mislabelling them.'
  );
  exit(2);
}

// ---- build the draft ----------------------------------------------------
const reportOf = new Map(
  ledger.source_executions.map((s) => [s.execution_id, s.report_reference])
);

/** First failing-attempt message, or the failed assertions for Newman. */
function errorMessage(unit) {
  const attempt = (unit.attempts || []).find(
    (a) => a.status !== 'passed' && a.error_message
  );
  if (attempt) return attempt.error_message;
  const failed = (unit.assertions || []).filter((a) => !a.passed);
  if (failed.length) {
    return failed
      .map((a) => `${a.name}${a.error_message ? `: ${a.error_message}` : ''}`)
      .join('\n')
      .slice(0, 600);
  }
  return `unit outcome: ${unit.outcome}`;
}

// Sorted by unit_id so FAIL numbering depends on WHICH units failed, not on
// the order a runner happened to report them.
const analyzed = ledger.units
  .filter((u) => ANALYZED.has(u.outcome))
  .sort((a, b) => (a.unit_id < b.unit_id ? -1 : a.unit_id > b.unit_id ? 1 : 0));

const failures = analyzed.map((unit, i) => {
  const links = unit.domain_links || {};
  const isNewman = unit.identity.kind === 'newman';
  const c = classifyUnit(unit);
  const caseId = links.test_case_id || links.api_test_case_id || null;
  const linkReason =
    links.unresolved_reason ||
    'No exact id in the test title / request name, and none in the normalizer mapping.';

  const id = isNewman
    ? (links.request_id ?? null)
    : (links.playwright_test_id ?? null);
  const report = reportOf.get(unit.execution_id);

  const f = {
    failure_id: `FAIL-${String(i + 1).padStart(3, '0')}`,
    unit_id: unit.unit_id,
    execution_outcome: unit.outcome,
    runner_identity: unit.identity,
    test_case_id: caseId,
    source: isNewman ? 'newman' : 'playwright',
    [isNewman ? 'request_id' : 'playwright_test_id']: id,
    classification: c.classification,
    severity: c.severity,
    classification_reason: c.reason,
    error_message: errorMessage(unit),
    evidence_paths: [LEDGER, ...(report ? [report] : [])],
  };
  if (id === null) f.id_unresolved_reason = linkReason;
  if (caseId === null) {
    f.traceability_unresolved = true;
    f.traceability_unresolved_reason = linkReason;
  }
  return f;
});

const t = ledger.totals;
const legacy = legacySummaryProjection(t);
const startedAt = ledger.source_executions
  .map((s) => s.started_at)
  .filter(Boolean)
  .sort()[0];

const doc = {
  schema_version: '2.0',
  run_id: context.run_id || ledger.run_id,
  story_id: storyId,
  execution_date: startedAt || ledger.generated_at,
  execution_ledger: LEDGER,
  // Flat fields are the legacy projection, explained by the breakdown below.
  total_tests: legacy.total_tests,
  passed: legacy.passed,
  failed: legacy.failed,
  skipped: legacy.skipped,
  outcome_breakdown: {
    units: t.units,
    ...Object.fromEntries(UNIT_OUTCOMES.map((o) => [o, t[o] ?? 0])),
    source_error_count: t.source_error_count,
  },
  source_errors: ledger.source_executions.flatMap((s) =>
    (s.source_errors || []).map((e) => ({
      execution_id: s.execution_id,
      runner: s.runner,
      message: e.message,
      ...(e.phase ? { phase: e.phase } : {}),
    }))
  ),
  failures,
  // A pre-classifier never finalizes. No bug drafts are created or referenced.
  status: 'draft',
};

// Every failed/blocked/flaky unit must appear exactly once.
const expected = (t.failed ?? 0) + (t.blocked ?? 0) + (t.flaky ?? 0);
if (failures.length !== expected) {
  console.error(
    `Internal error: ${failures.length} failure(s) built for ${expected} failed/blocked/flaky unit(s).`
  );
  exit(1);
}

// ---- report -------------------------------------------------------------
const bySeverity = { red: 0, yellow: 0, green: 0 };
const byClass = {};
for (const f of failures) {
  bySeverity[f.severity] += 1;
  byClass[f.classification] = (byClass[f.classification] || 0) + 1;
}
const unresolved = failures.filter(
  (f) => f.test_case_id === null || f.id_unresolved_reason
).length;

console.log(`Pre-classification (DRAFT) from ${LEDGER}`);
console.log(
  `  ${t.units} unit(s): passed ${t.passed} | failed ${t.failed} | flaky ${t.flaky} | ` +
    `blocked ${t.blocked} | skipped ${t.skipped} | not_run ${t.not_run} | expected_failure ${t.expected_failure}`
);
if (t.source_error_count) {
  console.log(
    `  ${t.source_error_count} run-level error(s) recorded separately.`
  );
}
console.log(
  `  ${failures.length} failure(s): red ${bySeverity.red} | yellow ${bySeverity.yellow} | green ${bySeverity.green}`
);
for (const [c, n] of Object.entries(byClass)) console.log(`    ${c}: ${n}`);

if (DRY) {
  console.log('\nDRY RUN (not written).');
  console.log(JSON.stringify(doc, null, 2));
  exit(0);
}

const written = writeJsonAtomic(OUT, doc, { schemaPath: SCHEMA });
if (!written.ok) {
  console.error(`\n${written.message}`);
  for (const line of formatErrors(written.errors, { includeParams: false })) {
    console.error(line);
  }
  exit(1);
}

console.log(`\nWrote ${OUT} (status: draft).`);
console.log(
  'Before the Reporter step, the Failure Classifier Agent or a human must:'
);
console.log(
  '  1. confirm or correct each classification (the reason is recorded on each failure);'
);
if (bySeverity.red) {
  console.log(
    `  2. write a bug draft for each of the ${bySeverity.red} Red failure(s) and set bug_draft_path;`
  );
} else {
  console.log('  2. (no Red failures, so no bug drafts are required);');
}
if (unresolved) {
  console.log(
    `  3. resolve or explicitly acknowledge ${unresolved} unresolved link(s) (TC / PW / REQ ids);`
  );
} else {
  console.log('  3. (every failure is linked to its test case);');
}
console.log('  4. set status to "finalized".');
console.log(
  'Only green failures are eligible for the Healer, and only as reviewable patches.'
);

const productBugs = failures.filter(
  (f) => f.classification === 'product_bug'
).length;
if (BLOCKING && productBugs > 0) {
  console.log(
    `\n--blocking: ${productBugs} product bug(s) found. This is a CI gate on product bugs only, ` +
      'not a release recommendation; the Reporter owns that.'
  );
  exit(1);
}
exit(0);
