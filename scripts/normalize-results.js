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
// Usage:
//   node scripts/normalize-results.js --story QA-1042 \
//     [--playwright reports/results.json] \
//     [--execution <execution-id>]   every Newman report for this story in
//                                    that execution (task group 3.2 layout)
//     [--newman <report.json> ...]   repeatable; explicit reports
//     [--out analysis/execution-ledger.json] [--run-id <id>] [--mapping <file>]
//
// Exit codes:
//   0 — a valid ledger was written
//   1 — inputs were read but the ledger could not be written (validation,
//       invariant, or write failure)
//   2 — usage error, or no execution inputs exist

import { existsSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { readJson, writeJsonAtomic, formatErrors } from './lib/artifact-io.js';
import { newmanStoryDir } from './lib/execution-paths.js';
import {
  adaptPlaywrightReport,
  adaptNewmanReport,
} from './lib/execution-results.js';
import { buildLedger } from './lib/build-ledger.js';
import {
  ledgerInvariants,
  LEDGER_SCHEMA,
  legacySummaryProjection,
} from './lib/execution-ledger.js';

const DEFAULT_OUT = 'analysis/execution-ledger.json';

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
      '[--out <ledger.json>] [--run-id <id>] [--mapping <file>]'
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
  if (!pwPath && nmPaths.length === 0) {
    console.error(
      'Error: no execution inputs. Pass --playwright, --execution and/or --newman.'
    );
    console.error(
      '  Manual/external result import is task group 7.x; it is not available yet.'
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

  const { ledger, unmapped, ambiguous } = buildLedger({
    runId,
    storyId,
    generatedAt,
    sourceExecutions,
    units,
    approvedCaseIds,
    mapping,
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
