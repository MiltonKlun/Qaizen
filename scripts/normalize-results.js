#!/usr/bin/env node
// Normalize runner reports into an execution ledger (task group 3.1).
//
// A thin CLI: it resolves inputs, calls the pure adapters, assembles the
// ledger, and writes it through the shared validated atomic writer. All the
// counting rules live in scripts/lib/ -- this file adds no semantics of its
// own, so there is exactly one place where an outcome is decided.
//
// Either runner may be supplied independently: an API-only story needs no
// fabricated Playwright report, and vice versa. With neither, this exits 2
// rather than writing an empty ledger that would read as "nothing failed".
//
// External work (task group 7.2) comes from the reviewed external plan and
// the results recorded by scripts/import-execution.js: one unit per recorded
// manual/component result, linked to its case. A skip-only plan is an input
// too: it yields a ledger with zero units whose approved cases are all
// not_run -- an explicit zero-execution summary, never a pass.
//
// Usage:
//   node scripts/normalize-results.js --story QA-1042 \
//     [--playwright reports/results.json] \
//     [--execution <execution-id>]   every Newman report for this story in
//                                    that execution (task group 3.2 layout)
//     [--newman <report.json> ...]   repeatable; explicit reports
//     [--out analysis/execution-ledger.json] [--run-id <id>] [--mapping <file>]
//     [--test-cases test-cases/<story>.json]   the approved scope: records the
//                                    approved case ids and the scope digest the
//                                    TestLink result sync checks (task group 5.3)
//     [--external-plan planner-input/<story>.external-plan.json]
//     [--external-results external-evidence/<story>.results.json]
//                                    (results need the plan and --test-cases)
//
// Exit codes:
//   0 — a valid ledger was written
//   1 — inputs were read but the ledger could not be written (validation,
//       invariant, or write failure)
//   2 — usage error, or no execution inputs exist

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  readJson,
  readValidatedJson,
  writeJsonAtomic,
  formatErrors,
} from './lib/artifact-io.js';
import { newmanStoryDir } from './lib/execution-paths.js';
import {
  adaptPlaywrightReport,
  adaptNewmanReport,
} from './lib/execution-results.js';
import { buildLedger } from './lib/build-ledger.js';
import {
  approvedScopeDigest,
  externalSource,
  ledgerInvariants,
  LEDGER_SCHEMA,
  legacySummaryProjection,
  TEST_CASES_SCHEMA,
} from './lib/execution-ledger.js';

const DEFAULT_OUT = 'analysis/execution-ledger.json';
const EXTERNAL_SCHEMA = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas',
  'external-execution.schema.json'
);

/** A recorded external outcome as a unit attempt (the ledger's vocabulary). */
const EXTERNAL_ATTEMPT = { failed: 'failed', blocked: 'interrupted' };

/**
 * Read and check the external plan and results against the story, run and
 * approved scope. Nothing here decides an outcome: a recorded result becomes
 * one unit with exactly the outcome the operator reported.
 * @returns {{ok: true, execution: object|null, units: object[]} |
 *           {ok: false, message: string}}
 */
function externalInputs(flags, { storyId, runId, testCases, scopeDigest }) {
  const fail = (message) => ({ ok: false, message });
  const planPath = flags['external-plan'];
  const resultsPath = flags['external-results'];
  if (!planPath) {
    return resultsPath
      ? fail('--external-results needs the reviewed --external-plan')
      : { ok: true, execution: null, units: [] };
  }
  const plan = readValidatedJson(planPath, EXTERNAL_SCHEMA);
  if (!plan.ok || plan.data.document !== 'external_plan') {
    return fail(`${planPath} is not a valid external plan`);
  }
  if (plan.data.story_id !== storyId) {
    return fail(
      `${planPath} is for story ${plan.data.story_id}, not ${storyId}`
    );
  }
  if (runId && plan.data.run_id !== runId) {
    return fail(`${planPath} belongs to run ${plan.data.run_id}, not ${runId}`);
  }
  // Every planned case must still be an approved case of the same kind.
  if (testCases) {
    const approved = new Map(
      testCases.test_cases
        .filter((c) => c.status === 'approved')
        .map((c) => [c.test_case_id, externalSource(c.automation_decision)])
    );
    const off = plan.data.cases.filter(
      (c) => approved.get(c.test_case_id) !== c.source
    );
    if (off.length) {
      return fail(
        `${planPath} plans ${off.map((c) => c.test_case_id).join(', ')}, which the approved scope does not have as planned`
      );
    }
  }
  if (!resultsPath) return { ok: true, execution: null, units: [] };

  if (!testCases) {
    return fail('--external-results needs --test-cases (the approved scope)');
  }
  const res = readValidatedJson(resultsPath, EXTERNAL_SCHEMA);
  if (!res.ok || res.data.document !== 'external_results') {
    return fail(`${resultsPath} is not valid external results`);
  }
  if (res.data.story_id !== storyId || (runId && res.data.run_id !== runId)) {
    return fail(
      `${resultsPath} belongs to ${res.data.story_id}/${res.data.run_id}, not this run`
    );
  }
  if (res.data.approved_scope_digest !== scopeDigest) {
    return fail(
      `${resultsPath} was recorded against a different approved scope`
    );
  }
  const planned = new Map(plan.data.cases.map((c) => [c.test_case_id, c]));
  const seen = new Set();
  for (const r of res.data.results) {
    const p = planned.get(r.test_case_id);
    if (!p || p.source !== r.source) {
      return fail(
        `${resultsPath} records ${r.test_case_id} as ${r.source}, which the reviewed plan does not`
      );
    }
    if (seen.has(r.test_case_id)) {
      return fail(`${resultsPath} records ${r.test_case_id} more than once`);
    }
    seen.add(r.test_case_id);
  }

  const executionId = `exec-ext-${randomUUID().slice(0, 8)}`;
  const times = res.data.results.map((r) => r.executed_at).sort();
  const units = res.data.results.map((r) => {
    const attempt = EXTERNAL_ATTEMPT[r.outcome];
    const message = `Reported ${r.outcome} by ${r.operator}${r.notes ? `: ${r.notes}` : ''}`;
    return {
      unit_id: `external:${r.test_case_id}`,
      execution_id: executionId,
      identity: {
        kind: 'external',
        test_title: `${r.test_case_id} (${r.source})`,
        occurrence: 0,
      },
      domain_links: { test_case_id: r.test_case_id },
      outcome: r.outcome,
      ...(attempt
        ? {
            attempts: [
              { status: attempt, error_message: message.slice(0, 600) },
            ],
          }
        : {}),
    };
  });
  return {
    ok: true,
    units,
    execution: {
      execution_id: executionId,
      runner: 'external',
      started_at: times[0] ?? new Date().toISOString(),
      completed_at: times[times.length - 1] ?? null,
      command_identity: `import-execution (${[...new Set(res.data.results.map((r) => r.source))].sort().join(', ') || 'no results'})`,
      process_status: 'completed',
      report_reference: resultsPath,
      report_digest: createHash('sha256')
        .update(readFileSync(resultsPath))
        .digest('hex'),
      source_errors: [],
    },
  };
}

/**
 * Flags that may be given more than once; every other flag is single-valued.
 * Before task group 3.3 all flags were single-valued and a repeated `--newman`
 * silently kept only the LAST report, dropping the other collections.
 */
const REPEATABLE = new Set(['newman']);

function parseArgs(args) {
  const out = { flags: {}, errors: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('--')) {
      out.errors.push(`Unexpected argument: ${a}`);
      continue;
    }
    const key = a.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      out.errors.push(`Flag --${key} requires a value`);
      continue;
    }
    if (REPEATABLE.has(key)) {
      (out.flags[key] ??= []).push(value);
    } else if (key in out.flags) {
      out.errors.push(`Flag --${key} was given more than once`);
    } else {
      out.flags[key] = value;
    }
    i += 1;
  }
  return out;
}

function usage(message) {
  if (message) console.error(`Error: ${message}`);
  console.error(
    'Usage: node scripts/normalize-results.js --story <STORY-ID> ' +
      '[--playwright <report.json>] [--execution <id>] [--newman <report.json> ...] ' +
      '[--out <ledger.json>] [--run-id <id>] [--mapping <file>] [--test-cases <file>] ' +
      '[--external-plan <file>] [--external-results <file>]'
  );
}

/**
 * The collection id a Newman report stands for.
 *
 * Under the per-execution layout (reports/<exec>/newman/<story>/<collection>.json)
 * the file name IS the id the runner used, so it wins. Elsewhere -- a legacy
 * or hand-supplied report -- fall back to the collection's own id.
 */
function collectionIdFor(path, report) {
  const parts = path.split(/[\\/]/);
  const n = parts.length;
  const inLayout =
    n >= 5 &&
    parts[n - 5] === 'reports' &&
    parts[n - 4].startsWith('exec-') &&
    parts[n - 3] === 'newman';
  const fromName = basename(path, '.json');
  return inLayout
    ? fromName
    : report?.collection?.info?._postman_id || fromName;
}

/** Read a report, returning null when the path was not supplied. */
function loadReport(path, label) {
  if (!path) return null;
  if (!existsSync(path)) {
    console.error(`Error: ${label} report not found at ${path}`);
    exit(2);
  }
  const read = readJson(path);
  if (!read.ok) {
    console.error(`Error: ${label} report at ${path} is not readable JSON.`);
    console.error(`  ${read.message}`);
    exit(2);
  }
  return read.data;
}

export function main(args = argv.slice(2)) {
  const { flags, errors } = parseArgs(args);
  if (errors.length) {
    usage(errors[0]);
    return 2;
  }

  const storyId = flags.story || env.STORY_ID;
  if (!storyId) {
    usage('a story id is required (--story or STORY_ID)');
    return 2;
  }

  const pwPath = flags.playwright;

  // Newman inputs: every report for THIS story in one execution, plus any
  // explicit paths. Nothing is globbed across executions (finding I4).
  const nmPaths = [...(flags.newman || [])];
  if (flags.execution) {
    const dir = newmanStoryDir(flags.execution, storyId);
    if (!dir.ok) {
      usage(dir.message);
      return 2;
    }
    if (!existsSync(dir.value)) {
      console.error(
        `Error: execution ${flags.execution} has no Newman reports for ${storyId} (looked in ${dir.value}).`
      );
      return 2;
    }
    const found = readdirSync(dir.value)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => join(dir.value, f));
    if (found.length === 0) {
      console.error(
        `Error: ${dir.value} holds no Newman JSON reports; nothing to normalize.`
      );
      return 2;
    }
    nmPaths.push(...found);
  }

  // The same report twice would count every unit in it twice.
  const seen = new Set();
  for (const p of nmPaths) {
    const key = resolve(p).toLowerCase();
    if (seen.has(key)) {
      usage(`the Newman report ${p} was supplied more than once`);
      return 2;
    }
    seen.add(key);
  }

  // Neither runner supplied: an empty ledger would be indistinguishable from a
  // clean run, so refuse instead of manufacturing one.
  if (!pwPath && nmPaths.length === 0 && !flags['external-plan']) {
    console.error(
      'Error: no execution inputs. Pass --playwright, --execution, --newman and/or --external-plan.'
    );
    return 2;
  }

  const secrets = (env.QAIZEN_REDACT_VALUES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const runId = flags['run-id'] || env.RUN_ID || `run-${randomUUID()}`;
  const generatedAt = new Date().toISOString();

  const sourceExecutions = [];
  const units = [];

  if (pwPath) {
    const report = loadReport(pwPath, 'Playwright');
    const executionId = `exec-pw-${randomUUID().slice(0, 8)}`;
    const { units: u, sourceErrors } = adaptPlaywrightReport(report, {
      executionId,
      secrets,
    });
    sourceExecutions.push({
      execution_id: executionId,
      runner: 'playwright',
      started_at: report.stats?.startTime || generatedAt,
      completed_at: generatedAt,
      process_status: 'completed',
      report_reference: pwPath,
      source_errors: sourceErrors,
    });
    units.push(...u);
  }

  // Resolve every collection's identity BEFORE counting anything, so two
  // reports claiming one collection are refused rather than double-counted.
  const newmanInputs = nmPaths.map((nmPath) => {
    const report = loadReport(nmPath, 'Newman');
    return { nmPath, report, collectionId: collectionIdFor(nmPath, report) };
  });
  const byCollection = new Map();
  for (const { nmPath, collectionId } of newmanInputs) {
    if (byCollection.has(collectionId)) {
      usage(
        `two reports claim collection "${collectionId}" (${byCollection.get(collectionId)} and ${nmPath}); ` +
          'each collection must contribute exactly once'
      );
      return 2;
    }
    byCollection.set(collectionId, nmPath);
  }

  for (const { nmPath, report, collectionId } of newmanInputs) {
    const executionId = `exec-nm-${randomUUID().slice(0, 8)}`;
    const { units: u, sourceErrors } = adaptNewmanReport(report, {
      executionId,
      collectionId,
      secrets,
    });
    sourceExecutions.push({
      execution_id: executionId,
      runner: 'newman',
      started_at: report.run?.timings?.started
        ? new Date(report.run.timings.started).toISOString()
        : generatedAt,
      completed_at: generatedAt,
      process_status: 'completed',
      report_reference: nmPath,
      source_errors: sourceErrors,
    });
    units.push(...u);
  }

  // Optional caller-supplied mapping of unit_id -> domain IDs. Absent means
  // every link stays null WITH a reason; it never means "guess".
  let mapping = {};
  let approvedCaseIds = [];
  if (flags.mapping) {
    const read = readJson(flags.mapping);
    if (!read.ok) {
      console.error(`Error: mapping file ${flags.mapping} is not readable.`);
      console.error(`  ${read.message}`);
      return 2;
    }
    mapping = read.data.units || {};
    approvedCaseIds = read.data.approved_case_ids || [];
  }

  // The approved scope, when given, is the authority on which cases count and
  // is recorded as a digest, so a ledger cannot later be reported against a
  // different scope (task group 5.3).
  let scopeDigest = null;
  let testCases = null;
  if (flags['test-cases']) {
    const tc = readValidatedJson(flags['test-cases'], TEST_CASES_SCHEMA);
    if (!tc.ok) {
      console.error(`Error: ${tc.message}`);
      for (const line of formatErrors(tc.errors)) console.error(line);
      return 2;
    }
    if (tc.data.story_id !== storyId) {
      console.error(
        `Error: ${flags['test-cases']} is for story ${tc.data.story_id}, not ${storyId}.`
      );
      return 2;
    }
    const approved = tc.data.test_cases
      .filter((c) => c.status === 'approved')
      .map((c) => c.test_case_id);
    const fromMapping = [...approvedCaseIds].sort().join(',');
    if (
      approvedCaseIds.length &&
      fromMapping !== [...approved].sort().join(',')
    ) {
      console.error(
        'Error: the mapping file lists different approved_case_ids than the test cases approve.'
      );
      return 2;
    }
    approvedCaseIds = approved;
    scopeDigest = approvedScopeDigest(tc.data);
    testCases = tc.data;
  }

  const ext = externalInputs(flags, {
    storyId,
    runId: flags['run-id'] || env.RUN_ID || null,
    testCases,
    scopeDigest,
  });
  if (!ext.ok) {
    console.error(`Error: ${ext.message}`);
    return 2;
  }
  if (ext.execution) {
    sourceExecutions.push(ext.execution);
    units.push(...ext.units);
  }

  const { ledger, unmapped, ambiguous } = buildLedger({
    runId,
    storyId,
    generatedAt,
    sourceExecutions,
    units,
    approvedCaseIds,
    mapping,
    approvedScopeDigest: scopeDigest,
  });

  const inv = ledgerInvariants(ledger);
  if (!inv.ok) {
    console.error('Error: the assembled ledger violates its own invariants.');
    for (const v of inv.violations) console.error(`  - ${v}`);
    return 1;
  }

  const out = flags.out || DEFAULT_OUT;
  const written = writeJsonAtomic(out, ledger, { schemaPath: LEDGER_SCHEMA });
  if (!written.ok) {
    console.error(`Error: ${written.message}`);
    // Field paths only, never values (the shared diagnostics rule). Printing
    // the raw AJV objects rendered as "[object Object]".
    for (const line of formatErrors(written.errors, {
      includeParams: false,
    }).slice(0, 10)) {
      console.error(line);
    }
    return 1;
  }

  const t = ledger.totals;
  const legacy = legacySummaryProjection(t);
  console.log(`Wrote ${out}`);
  console.log(`  run ${runId} | story ${storyId} | ${t.units} unit(s)`);
  console.log(
    `  passed ${t.passed} | failed ${t.failed} | flaky ${t.flaky} | ` +
      `skipped ${t.skipped} | blocked ${t.blocked} | not_run ${t.not_run} | ` +
      `expected_failure ${t.expected_failure}`
  );
  console.log(
    `  unit pass rate: ${t.unit_pass_rate === null ? 'n/a (no units)' : `${(t.unit_pass_rate * 100).toFixed(1)}%`}` +
      `  |  approved-case coverage: ${
        t.approved_case_coverage === null
          ? 'n/a (no approved scope supplied)'
          : `${(t.approved_case_coverage * 100).toFixed(1)}%`
      }`
  );
  console.log(
    `  legacy projection: passed ${legacy.passed} | failed ${legacy.failed} | ` +
      `skipped ${legacy.skipped} | total ${legacy.total_tests}`
  );
  if (t.source_error_count > 0) {
    console.log(
      `  ${t.source_error_count} run-level error(s) recorded separately (not unit outcomes).`
    );
  }
  if (unmapped.length) {
    console.log(
      `  ${unmapped.length} unit(s) have no declared domain mapping; their links stay null with a reason.`
    );
  }
  if (ambiguous.length) {
    console.log(
      `  ${ambiguous.length} unit(s) have an AMBIGUOUS mapping and need human disambiguation.`
    );
  }

  return 0;
}

// Only run when invoked directly, so tests can import main().
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  exit(main());
}
