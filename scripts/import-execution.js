#!/usr/bin/env node
// Record manual or component results against the reviewed external plan
// (task group 7.2).
//
// Manual and component cases are not executed by this pipeline. A person (or
// a component suite run outside it) does the work; this script records what
// they report, with a digest of every evidence file, into
//
//   external-evidence/<story-id>.results.json   (schemas/external-execution.schema.json)
//
// It records claims; it approves nothing. The results are reviewed at the
// external Gate 4 (external_evidence_reviewed), which this script never sets,
// and which any later import returns to pending (the results it was bound to
// changed). Refused, with nothing written:
//
//   * no reviewed external plan, or its approval is stale;
//   * a case the plan does not list, a skip case (never executed), or a case
//     whose approved automation decision is no longer the planned one;
//   * a pass without evidence, evidence outside the repository or missing;
//   * an execution time before the plan approval or in the future;
//   * an existing results file, or an import file, of another story, run or
//     approved scope.
//
// One case from flags, or many from the documented normalized JSON (the
// `external_import` document of the same schema) -- a component suite's output
// is converted to that outside the pipeline; no suite format is parsed here.
// Every entry is checked before anything is written. Re-importing a case
// replaces its previous result; a case never imported stays Not Run.
//
// Usage:
//   node scripts/import-execution.js --case TC-004 --outcome passed \
//     --executed-at 2026-09-29T10:15:00Z --operator "A. Tester" \
//     --evidence external-evidence/QA-1042/tc-004-confirmation.png \
//     [--evidence <file> ...] [--notes "..."]
//   node scripts/import-execution.js --from component-results.json
//
// Exit codes: 0 recorded · 2 usage error or refusal (nothing written)

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  readValidatedJson,
  writeJsonAtomic,
  formatErrors,
} from './lib/artifact-io.js';
import { externalPaths, requireCurrentGate } from './lib/approval-binding.js';
import {
  approvedScopeDigest,
  externalSource,
  TEST_CASES_SCHEMA,
} from './lib/execution-ledger.js';

const SCHEMA = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas',
  'external-execution.schema.json'
);
const OUTCOMES = new Set(['passed', 'failed', 'blocked', 'not_run']);
const REPEATABLE = new Set(['evidence']);
const ENTRY_FLAGS = ['case', 'outcome', 'executed-at', 'operator'];
/** Clock skew tolerated for an execution time "now" on another machine. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

function parseArgs(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('--')) return { error: `Unexpected argument: ${a}` };
    const key = a.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      return { error: `--${key} requires a value` };
    }
    if (REPEATABLE.has(key)) (flags[key] ??= []).push(value);
    else if (key in flags)
      return { error: `--${key} was given more than once` };
    else flags[key] = value;
    i += 1;
  }
  return { flags };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** When a gate was approved, or null when the audit object does not say. */
function approvedAt(context, gate) {
  const g = context?.review_gates?.[gate];
  const t = g && typeof g === 'object' ? Date.parse(g.reviewed_at ?? '') : NaN;
  return Number.isNaN(t) ? null : t;
}

/** The entries to record: one from flags, or every entry of --from. */
function entriesFrom(flags, root, storyId, runId) {
  if (flags.from) {
    const extra = Object.keys(flags).filter((k) => k !== 'from');
    if (extra.length) {
      return { error: `--from cannot be combined with --${extra[0]}` };
    }
    const doc = readValidatedJson(join(root, flags.from), SCHEMA);
    if (!doc.ok || doc.data.document !== 'external_import') {
      return {
        error: `${flags.from} is not an external_import document (schemas/external-execution.schema.json)`,
      };
    }
    if (doc.data.story_id !== storyId || doc.data.run_id !== runId) {
      return {
        error: `${flags.from} is for ${doc.data.story_id}/${doc.data.run_id}, not ${storyId}/${runId}`,
      };
    }
    return { entries: doc.data.results };
  }
  for (const k of ENTRY_FLAGS) {
    if (!flags[k]) return { error: `--${k} is required (or use --from)` };
  }
  if (flags.notes && flags.notes.length > 1000) {
    return { error: '--notes is longer than 1000 characters' };
  }
  return {
    entries: [
      {
        test_case_id: flags.case,
        outcome: flags.outcome,
        executed_at: flags['executed-at'],
        operator: flags.operator,
        evidence: flags.evidence ?? [],
        ...(flags.notes ? { notes: flags.notes } : {}),
      },
    ],
  };
}

/**
 * Record results. Pure over the working directory `root` and `now`, so the
 * tests drive it directly.
 * @returns {{ok: true, path: string, results: object[]} | {ok: false, reason: string}}
 */
export function importExecution(args, { root = '.', now = new Date() } = {}) {
  const refuse = (reason) => ({ ok: false, reason });
  const parsed = parseArgs(args);
  if (parsed.error) return refuse(parsed.error);

  // ---- the run --------------------------------------------------------
  const at = (rel) => join(root, rel);
  if (!existsSync(at('context.json'))) return refuse('no context.json');
  let context;
  try {
    context = JSON.parse(readFileSync(at('context.json'), 'utf8'));
  } catch {
    return refuse('context.json is not valid JSON');
  }
  const storyId = context?.story?.id;
  const runId = context?.run_id;
  if (!storyId || !runId) return refuse('context.json has no story.id/run_id');

  const gate = requireCurrentGate(context, 'external_plan_reviewed', root);
  if (!gate.ok) {
    return refuse(
      `${gate.reason}. Results are recorded only against a reviewed plan`
    );
  }

  const tcPath = context.artifact_paths?.test_cases;
  if (!tcPath) return refuse('context.json names no test cases file');
  const tc = readValidatedJson(at(tcPath), TEST_CASES_SCHEMA);
  if (!tc.ok) return refuse(`${tcPath} is not valid test cases`);
  if (tc.data.story_id !== storyId) {
    return refuse(`${tcPath} is for story ${tc.data.story_id}, not ${storyId}`);
  }

  const ext = externalPaths(context);
  const plan = readValidatedJson(at(ext.plan), SCHEMA);
  if (!plan.ok || plan.data.document !== 'external_plan') {
    return refuse(`${ext.plan} is not a valid external plan`);
  }
  if (plan.data.story_id !== storyId || plan.data.run_id !== runId) {
    return refuse(
      `${ext.plan} belongs to ${plan.data.story_id}/${plan.data.run_id}, not ${storyId}/${runId}`
    );
  }

  const got = entriesFrom(parsed.flags, root, storyId, runId);
  if (got.error) return refuse(got.error);
  const ids = got.entries.map((e) => e.test_case_id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) return refuse(`${dup} is given more than once`);

  const planApproved = approvedAt(context, 'external_plan_reviewed');
  const rootAbs = resolve(root);
  const recorded = [];

  // ---- every entry, before anything is written --------------------------
  for (const e of got.entries) {
    const caseId = e.test_case_id;
    const no = (reason) => refuse(`${caseId}: ${reason}`);
    if (!OUTCOMES.has(e.outcome)) {
      return no(
        `outcome must be one of ${[...OUTCOMES].join(', ')} (got "${e.outcome}")`
      );
    }
    const planned = plan.data.cases.find((c) => c.test_case_id === caseId);
    if (!planned) return no('not in the reviewed plan');
    if (planned.source === 'skip') {
      return no(
        'an approved skip is never executed and has no result (it is reported Not Run)'
      );
    }
    const approved = tc.data.test_cases.find(
      (c) => c.test_case_id === caseId && c.status === 'approved'
    );
    if (
      !approved ||
      externalSource(approved.automation_decision) !== planned.source
    ) {
      return no(`not an approved ${planned.source} case in ${tcPath}`);
    }

    const executed = Date.parse(e.executed_at);
    if (
      Number.isNaN(executed) ||
      !/^\d{4}-\d{2}-\d{2}T/.test(String(e.executed_at))
    ) {
      return no('the execution time must be an ISO 8601 date-time');
    }
    if (executed > now.getTime() + FUTURE_SKEW_MS) {
      return no('the execution time is in the future');
    }
    if (planApproved !== null && executed < planApproved) {
      return no(
        'executed before the plan was approved: that work was not done against the reviewed plan'
      );
    }

    const evidence = [];
    for (const p of e.evidence ?? []) {
      const abs = resolve(rootAbs, p);
      if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
        return no(`evidence ${p} is outside the repository`);
      }
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        return no(`evidence ${p} does not exist`);
      }
      evidence.push({
        path: relative(rootAbs, abs).split(sep).join('/'),
        sha256: sha256(readFileSync(abs)),
      });
    }
    if (e.outcome === 'passed' && evidence.length === 0) {
      return no(
        `a pass needs evidence (the plan requires: ${planned.evidence_required.join('; ')})`
      );
    }

    recorded.push({
      test_case_id: caseId,
      source: planned.source,
      outcome: e.outcome,
      executed_at: new Date(executed).toISOString(),
      operator: e.operator,
      evidence,
      ...(e.notes ? { notes: e.notes } : {}),
      imported_at: now.toISOString(),
    });
  }

  // ---- the results file -----------------------------------------------
  const scope = approvedScopeDigest(tc.data);
  let doc = {
    schema_version: '1.0',
    document: 'external_results',
    story_id: storyId,
    run_id: runId,
    approved_scope_digest: scope,
    results: [],
  };
  if (existsSync(at(ext.results))) {
    const cur = readValidatedJson(at(ext.results), SCHEMA);
    if (!cur.ok || cur.data.document !== 'external_results') {
      return refuse(`${ext.results} exists but is not valid external results`);
    }
    if (cur.data.story_id !== storyId || cur.data.run_id !== runId) {
      return refuse(
        `${ext.results} holds results of ${cur.data.story_id}/${cur.data.run_id}, not ${storyId}/${runId}; ` +
          'archive it before recording this run'
      );
    }
    if (cur.data.approved_scope_digest !== scope) {
      return refuse(
        `${ext.results} was recorded against a different approved scope; archive it and re-record`
      );
    }
    doc = cur.data;
  }

  const replaced = new Set(recorded.map((r) => r.test_case_id));
  doc.results = [
    ...doc.results.filter((r) => !replaced.has(r.test_case_id)),
    ...recorded,
  ].sort((a, b) => a.test_case_id.localeCompare(b.test_case_id));

  const written = writeJsonAtomic(at(ext.results), doc, {
    schemaPath: SCHEMA,
    root: rootAbs,
  });
  if (!written.ok) {
    return refuse(
      [written.message, ...formatErrors(written.errors ?? [])].join('\n')
    );
  }
  return { ok: true, path: ext.results, results: recorded };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const r = importExecution(argv.slice(2));
  if (!r.ok) {
    console.error(`Refusing to record: ${r.reason}. Nothing was written.`);
    exit(2);
  }
  for (const x of r.results) {
    console.log(
      `Recorded ${x.test_case_id} (${x.source}): ${x.outcome}, ${x.evidence.length} evidence file(s).`
    );
  }
  console.log(`Results: ${r.path}.`);
  console.log(
    'Nothing is approved by this: the results are reviewed at the external Gate 4 (npm run pipeline).'
  );
  exit(0);
}
