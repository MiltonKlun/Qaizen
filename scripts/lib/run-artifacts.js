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

import { validateValue } from './artifact-io.js';

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = (name) => join(REPO_DIR, 'schemas', name);

export const CONTEXT_SCHEMA = schema('context.schema.json');

/** How each artifact_paths entry is checked. */
const RULES = {
  test_cases: { kind: 'json', schema: 'test-cases.schema.json' },
  planner_brief: { kind: 'text' },
  playwright_spec: { kind: 'text' },
  generated_test: { kind: 'text' },
  execution_results: { kind: 'playwright-report' },
  execution_ledger: { kind: 'json', schema: 'execution-ledger.schema.json' },
  failure_analysis: { kind: 'json', schema: 'failure-analysis.schema.json' },
  release_report_json: { kind: 'json', schema: 'release-report.schema.json' },
};

const ok = (data) => ({ ok: true, data });
const bad = (reason) => ({ ok: false, reason });
/** Not produced YET: not a defect to report, just not done. */
const absent = (reason) => ({ ok: false, reason, absent: true });

function readJson(path) {
  try {
    return { ok: true, data: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { ok: false };
  }
}

/** The moment Gate 4 was approved, when the audit object records it. */
function gate4ApprovedAt(context) {
  const g = context?.review_gates?.code_reviewed;
  const t = g && typeof g === 'object' ? Date.parse(g.reviewed_at ?? '') : NaN;
  return Number.isNaN(t) ? null : t;
}

/**
 * A Playwright JSON report that can stand as THIS run's execution evidence:
 * well-formed, with suites and counts, and produced AFTER the code it ran was
 * last changed and approved. `{}` is not a report; a report older than the
 * generated test (or than the Gate 4 approval) is stale evidence of other code.
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
  const approved = gate4ApprovedAt(context);
  if (approved !== null && approved > reportTime) {
    return bad('is stale: it predates the Gate 4 approval of the code it ran');
  }
  return ok(rep);
}

/**
 * Check one artifact_paths entry.
 * @returns {{ok: true, data?: any} | {ok: false, reason: string}}
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
  const v = validateValue(r.data, schema(rule.schema));
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
  return ok(r.data);
}

/** Validate context.json itself; everything else depends on it. */
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
 */
export function missingBugDrafts(analysis, root = '.') {
  return (analysis?.failures ?? [])
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
 */
export function ledgerHasApiExecution(ledger) {
  return (ledger?.source_executions ?? []).some((s) => s.runner === 'newman');
}

/**
 * The newest execution directory holding Newman reports for this story
 * (reports/<execution-id>/newman/<story>/*.json, task group 3.2 layout), or
 * null. Only ONE execution is ever used; older ones are never mixed in.
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
