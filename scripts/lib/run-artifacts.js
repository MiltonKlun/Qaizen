// @ts-check
// Run-artifact checks at transition boundaries (task group 4.2, findings I6/B4).
//
// The state machine (scripts/pipeline-state.js) decides the next step from
// "has this artifact been produced?". That used to mean "does the file
// exist?", so a valid, approved context pointing at `{}` for its test cases,
// execution results, failure analysis and release report made `--resume`
// print "Run complete" (finding I6). Here "produced" means: the file exists,
// is well-formed, validates against its schema, and belongs to THIS run (same
// story id, same run id). Every real archived run already satisfies that
// exactly, so the stricter rule rejects only broken or foreign files.
//
// Pure reads. The pure state machine stays pure: the runner computes these
// facts and passes them in as hints.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { validateValue } from './artifact-io.js';
import {
  analysisCountProblems,
  releaseExecutionSummary,
} from './execution-ledger.js';

/** @typedef {import('./approval-binding.js').Context} Context */
/**
 * `absent` marks "not produced yet" rather than a defect.
 * @typedef {{ ok: true, data?: any }
 *   | { ok: false, reason: string, absent?: boolean }} ArtifactCheck
 * @typedef {{ kind: 'json' | 'text' | 'playwright-report' | 'collection',
 *   schema?: string, document?: string }} Rule
 */

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = (/** @type {string} */ name) => join(REPO_DIR, 'schemas', name);

export const CONTEXT_SCHEMA = schema('context.schema.json');

/**
 * How each artifact_paths entry is checked.
 * @type {Record<string, Rule>}
 */
const RULES = {
  test_cases: { kind: 'json', schema: 'test-cases.schema.json' },
  planner_brief: { kind: 'text' },
  playwright_spec: { kind: 'text' },
  generated_test: { kind: 'text' },
  execution_results: { kind: 'playwright-report' },
  execution_ledger: { kind: 'json', schema: 'execution-ledger.schema.json' },
  failure_analysis: { kind: 'json', schema: 'failure-analysis.schema.json' },
  release_report_json: { kind: 'json', schema: 'release-report.schema.json' },
  // A Postman collection carries no story/run ids; its path names the story.
  api_collection: {
    kind: 'collection',
    schema: 'postman-collection.schema.json',
  },
  // One schema, two documents (task group 7.2): each path must hold its own.
  external_plan: {
    kind: 'json',
    schema: 'external-execution.schema.json',
    document: 'external_plan',
  },
  external_results: {
    kind: 'json',
    schema: 'external-execution.schema.json',
    document: 'external_results',
  },
};

/** @type {(data?: any) => ArtifactCheck} */
const ok = (data) => ({ ok: true, data });
/** @type {(reason: string) => ArtifactCheck} */
const bad = (reason) => ({ ok: false, reason });
/**
 * Not produced YET: not a defect to report, just not done.
 * @type {(reason: string) => ArtifactCheck}
 */
const absent = (reason) => ({ ok: false, reason, absent: true });

/**
 * @param {string} path
 * @returns {{ ok: true, data: any } | { ok: false }}
 */
function readJson(path) {
  try {
    return { ok: true, data: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { ok: false };
  }
}

/**
 * The moment a gate was approved, when the audit object records it.
 * @param {Context} context
 * @param {string} gate
 */
function gateApprovedAt(context, gate) {
  const g = context?.review_gates?.[gate];
  const t = g && typeof g === 'object' ? Date.parse(g.reviewed_at ?? '') : NaN;
  return Number.isNaN(t) ? null : t;
}

/**
 * A Playwright JSON report that can stand as THIS run's execution evidence:
 * well-formed, with suites and counts, and produced AFTER the code it ran was
 * last changed and approved. `{}` is not a report; a report older than the
 * generated test (or than the Gate 4 approval) is stale evidence of other code.
 * @param {string} path
 * @param {Context} context
 * @param {string} root
 * @returns {ArtifactCheck}
 */
function checkPlaywrightReport(path, context, root) {
  const r = readJson(path);
  if (!r.ok) return bad('is not valid JSON');
  const rep = r.data;
  if (!rep || typeof rep !== 'object' || !Array.isArray(rep.suites)) {
    return bad('is not a Playwright JSON report (no suites[])');
  }
  const stats = rep.stats;
  const counts = ['expected', 'unexpected', 'skipped', 'flaky'];
  if (!stats || counts.some((k) => typeof stats[k] !== 'number')) {
    return bad('is not a Playwright JSON report (no stats counts)');
  }
  const reportTime = statSync(path).mtimeMs;
  const test = context?.artifact_paths?.generated_test;
  if (test && existsSync(join(root, test))) {
    if (statSync(join(root, test)).mtimeMs > reportTime) {
      return bad(`is stale: ${test} changed after this report was written`);
    }
  }
  const approved = gateApprovedAt(context, 'code_reviewed');
  if (approved !== null && approved > reportTime) {
    return bad('is stale: it predates the Gate 4 approval of the code it ran');
  }
  return ok(rep);
}

/**
 * Check one artifact_paths entry.
 * @param {string} key
 * @param {Context} context
 * @param {string} [root]
 * @returns {ArtifactCheck}
 */
export function checkArtifact(key, context, root = '.') {
  const rel = context?.artifact_paths?.[key];
  if (typeof rel !== 'string' || !rel) return absent('is not set');
  const path = join(root, rel);
  if (!existsSync(path)) return absent(`${rel} does not exist`);
  const rule = RULES[key];
  if (!rule) return ok();

  if (rule.kind === 'text') {
    return readFileSync(path, 'utf8').trim().length > 0
      ? ok()
      : bad(`${rel} is empty`);
  }
  if (rule.kind === 'playwright-report') {
    const r = checkPlaywrightReport(path, context, root);
    return r.ok ? r : bad(`${rel} ${r.reason}`);
  }

  const r = readJson(path);
  if (!r.ok) return bad(`${rel} is not valid JSON`);
  // Every rule that reaches here (json, collection) names a schema.
  const schemaName = /** @type {string} */ (rule.schema);
  const v = validateValue(r.data, schema(schemaName));
  if (rule.kind === 'collection') {
    return v.ok
      ? ok(r.data)
      : bad(`${rel} does not validate against schemas/${rule.schema}`);
  }
  if (!v.ok) {
    const first = (v.errors ?? [])[0];
    const where = first
      ? ` (${first.instancePath || '(root)'} ${first.message})`
      : '';
    return bad(
      `${rel} does not validate against schemas/${rule.schema}${where}`
    );
  }
  // Belongs to THIS run: a file from another story or run is not our work.
  const story = context?.story?.id;
  if (story && r.data.story_id !== story) {
    return bad(`${rel} belongs to story ${r.data.story_id}, not ${story}`);
  }
  if (context?.run_id && r.data.run_id !== context.run_id) {
    return bad(`${rel} belongs to run ${r.data.run_id}, not ${context.run_id}`);
  }
  if (rule.document && r.data.document !== rule.document) {
    return bad(`${rel} is an ${r.data.document}, not an ${rule.document}`);
  }
  // Work recorded before the plan was approved was not done against the
  // reviewed plan (the external counterpart of a pre-Gate-4 report).
  if (key === 'external_results') {
    const approved = gateApprovedAt(context, 'external_plan_reviewed');
    /** @type {{ test_case_id: string, executed_at: string }[]} */
    const results = r.data.results ?? [];
    const early = results.filter(
      (x) => approved !== null && Date.parse(x.executed_at) < approved
    );
    if (early.length) {
      return bad(
        `${rel} is stale: ${early.map((x) => x.test_case_id).join(', ')} predate the external plan approval`
      );
    }
  }
  // A 2.x analysis's flat totals must be the projection of its breakdown.
  if (key === 'failure_analysis') {
    const problems = analysisCountProblems(r.data);
    if (problems.length) return bad(`${rel}: ${problems.join('; ')}`);
  }
  if (key === 'release_report_json') {
    const problem = releaseReportProblem(r.data, context, root);
    if (problem) return bad(`${rel} ${problem}`);
  }
  return ok(r.data);
}

/**
 * A release report written for a 2.x failure analysis is a 2.x report whose
 * execution_summary is exactly the one derived from that analysis's ledger
 * (task group 2.2b). A 1.x analysis keeps 1.x reports and their meaning.
 * @param {any} report
 * @param {Context} context
 * @param {string} root
 * @returns {string | null} why the report is not produced, or null
 */
function releaseReportProblem(report, context, root) {
  const reportV2 = /^2\./.test(String(report.schema_version));
  const faRel = context?.artifact_paths?.failure_analysis;
  const fa =
    typeof faRel === 'string' && faRel ? readJson(join(root, faRel)) : null;
  const analysisV2 =
    fa?.ok === true && /^2\./.test(String(fa.data?.schema_version));
  if (!analysisV2) {
    return reportV2
      ? 'is a 2.x report, but there is no 2.x failure analysis to derive its counts from'
      : null;
  }
  if (!reportV2) {
    return 'is a 1.x report for a 2.x failure analysis; write a 2.0 report (agents/reporter.md)';
  }
  const ledgerRel = fa.data.execution_ledger;
  const ledger = ledgerRel ? readJson(join(root, ledgerRel)) : null;
  if (!ledger?.ok) {
    return `cannot be checked: the ledger ${ledgerRel ?? '(unnamed)'} is not readable`;
  }
  const expected = releaseExecutionSummary(ledger.data);
  return isDeepStrictEqual(report.execution_summary, expected)
    ? null
    : `has an execution_summary that differs from the ledger's (npm run report:summary prints the one to use)`;
}

/**
 * Validate context.json itself; everything else depends on it.
 * @param {unknown} context
 * @returns {ArtifactCheck}
 */
export function checkContext(context) {
  if (!context || typeof context !== 'object')
    return bad('is not a JSON object');
  const v = validateValue(context, CONTEXT_SCHEMA);
  if (v.ok) return ok(context);
  const first = (v.errors ?? [])[0];
  return bad(
    `does not validate against schemas/context.schema.json` +
      (first ? ` (${first.instancePath || '(root)'} ${first.message})` : '')
  );
}

/**
 * Red failures in a FINALIZED analysis that have no bug draft on disk.
 * A 1.x analysis keeps its own rule (every Red must name a draft) and is held
 * to the same "the draft exists" check.
 * @param {any} analysis parsed failure analysis
 * @param {string} [root]
 * @returns {string[]}
 */
export function missingBugDrafts(analysis, root = '.') {
  /** @type {{ severity?: string, bug_draft_path?: string, failure_id: string }[]} */
  const failures = analysis?.failures ?? [];
  return failures
    .filter((f) => f.severity === 'red')
    .filter(
      (f) => !f.bug_draft_path || !existsSync(join(root, f.bug_draft_path))
    )
    .map((f) => f.failure_id);
}

/**
 * Does the ledger show a Newman execution for this story? Required before an
 * API story can complete: a run that never executed its API branch must not
 * read as finished.
 * @param {Partial<import('./execution-ledger.js').Ledger> | null | undefined} ledger
 */
export function ledgerHasApiExecution(ledger) {
  return (ledger?.source_executions ?? []).some((s) => s.runner === 'newman');
}

/**
 * Newman evidence that can stand for THIS run's approved API branch (task
 * group 7.1): the newest execution for the story, with at least one executed
 * request, written after the collection last changed and after the Gate 4'
 * approval. An older execution is evidence of other assertions.
 * @param {Context} context
 * @param {string | null | undefined} collectionPath
 * @param {string} [root]
 * @returns {{ok: true, executionId: string} | {ok: false, reason: string}}
 */
export function newmanEvidence(context, collectionPath, root = '.') {
  /** @type {string} */
  const story = context?.story?.id;
  const id = latestNewmanExecution(story, root);
  if (!id) return { ok: false, reason: 'no Newman execution for this story' };
  const dir = join(root, 'reports', id, 'newman', story);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  let executed = 0;
  let newest = 0;
  for (const f of files) {
    const r = readJson(join(dir, f));
    if (!r.ok) {
      return {
        ok: false,
        reason: `reports/${id}/newman/${story}/${f} is not valid JSON`,
      };
    }
    executed += (r.data?.run?.executions ?? []).length;
    newest = Math.max(newest, statSync(join(dir, f)).mtimeMs);
  }
  if (executed === 0) {
    return { ok: false, reason: `execution ${id} executed no request` };
  }
  const col = collectionPath ? join(root, collectionPath) : null;
  if (col && existsSync(col) && statSync(col).mtimeMs > newest) {
    return {
      ok: false,
      reason: `execution ${id} predates the current collection`,
    };
  }
  const g = context?.review_gates?.api_assertions_reviewed;
  const approved =
    g && typeof g === 'object' ? Date.parse(g.reviewed_at ?? '') : NaN;
  if (!Number.isNaN(approved) && approved > newest) {
    return {
      ok: false,
      reason: `execution ${id} predates the Gate 4' approval`,
    };
  }
  return { ok: true, executionId: id };
}

/**
 * The newest execution directory holding Newman reports for this story
 * (reports/<execution-id>/newman/<story>/*.json, task group 3.2 layout), or
 * null. Only ONE execution is ever used; older ones are never mixed in.
 * @param {string | undefined} storyId
 * @param {string} [root]
 * @returns {string | null}
 */
export function latestNewmanExecution(storyId, root = '.') {
  const reports = join(root, 'reports');
  if (!storyId || !existsSync(reports)) return null;
  const candidates = readdirSync(reports, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('exec-'))
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const id of candidates) {
    const dir = join(reports, id, 'newman', storyId);
    if (existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.json'))) {
      return id;
    }
  }
  return null;
}
