// @ts-check
// Run-artifact checks at transition boundaries.
//
// The state machine (scripts/pipeline-state.js) decides the next step from
// "has this artifact been produced?". That used to mean "does the file
// exist?", so a valid, approved context pointing at `{}` for its test cases,
// execution results, failure analysis and release report made `--resume`
// print "Run complete". Here "produced" means: the file exists,
// is well-formed, validates against its schema, and belongs to THIS run (same
// story id, same run id). Every real archived run already satisfies that
// exactly, so the stricter rule rejects only broken or foreign files.
//
// Pure reads. The pure state machine stays pure: the runner computes these
// facts and passes them in as hints.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  DRAFT_PATH,
  downgradesOf,
  overrideProblems,
  unconfirmed,
} from './analysis-overrides.js';
import { validateValue } from './artifact-io.js';
import {
  identityProblems,
  newmanIdentityProblems,
  newmanReportFiles,
} from './execution-identity.js';
import { releaseRuleProblems } from './report-checks.js';
import { effectiveTrack } from '../track-floor.js';
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
  // One schema, two documents: each path must hold its own.
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
 * Is this a Playwright JSON report at all: suites and counts? `{}` is not.
 * @param {string} path
 * @returns {ArtifactCheck}
 */
export function playwrightReportShape(path) {
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
  return ok(rep);
}

/**
 * A Playwright JSON report that can stand as THIS run's execution evidence:
 * well-formed, and exactly the report the execute step recorded, produced
 * with the config and under the Gate 4 approval it recorded
 * (scripts/lib/execution-identity.js). A report dropped in later, or produced
 * under another config or approval, is not this run's evidence.
 * @param {string} path
 * @param {string} rel
 * @param {Context} context
 * @param {string} root
 * @returns {ArtifactCheck}
 */
function checkPlaywrightReport(path, rel, context, root) {
  const shape = playwrightReportShape(path);
  if (!shape.ok) return shape;
  const problems = identityProblems(
    /** @type {any} */ (context)?.execution_identity?.playwright,
    { root, reportPath: rel, context }
  );
  return problems.length ? bad(problems.join('; ')) : shape;
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
    const r = checkPlaywrightReport(path, rel, context, root);
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
 * execution_summary is exactly the one derived from that analysis's ledger.
 * A 1.x analysis keeps 1.x reports and their meaning.
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
  if (!isDeepStrictEqual(report.execution_summary, expected)) {
    return `has an execution_summary that differs from the ledger's (npm run report:summary prints the one to use)`;
  }
  // The release rules hold in a live run, not only when a prompt is
  // evaluated: no pass while something blocks it, and nothing hidden.
  const casesRel = context?.artifact_paths?.test_cases;
  const cases =
    typeof casesRel === 'string' && casesRel
      ? readJson(join(root, casesRel))
      : null;
  const broken = releaseRuleProblems({
    report,
    context,
    testCases: cases?.ok ? cases.data : { test_cases: [] },
    analysis: fa.data,
    ledger: ledger.data,
  });
  return broken.length
    ? `breaks the release rules: ${broken.join('; ')} (agents/reporter.md)`
    : null;
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
 * Red failures in a FINALIZED analysis that have no bug draft on disk, or
 * whose draft is empty (whitespace only): an empty file is not a report of a
 * bug. A 1.x analysis keeps its own rule (every Red must name a draft) and is
 * held to the same check.
 * @param {any} analysis parsed failure analysis
 * @param {string} [root]
 * @returns {string[]}
 */
export function missingBugDrafts(analysis, root = '.') {
  /** @type {{ severity?: string, bug_draft_path?: string, failure_id: string }[]} */
  const failures = analysis?.failures ?? [];
  /** @param {string} path */
  const hasContent = (path) => {
    try {
      return readFileSync(path, 'utf8').trim() !== '';
    } catch {
      return false;
    }
  };
  return failures
    .filter((f) => f.severity === 'red')
    .filter(
      (f) => !f.bug_draft_path || !hasContent(join(root, f.bug_draft_path))
    )
    .map((f) => f.failure_id);
}

/**
 * Why a 2.x analysis does not keep its rule-based draft intact, or changes a
 * classification or severity without recording it (scripts/lib/
 * analysis-overrides.js). An analysis written before drafts were kept names
 * none and has no draft file for its run; it is not checked.
 * @param {any} analysis parsed failure analysis
 * @param {string} [root]
 * @returns {string[]}
 */
export function draftProblems(analysis, root = '.') {
  if (!/^2\./.test(String(analysis?.schema_version))) return [];
  /** @type {{ path?: string, sha256?: string } | undefined} */
  const named = analysis.rule_draft;
  // The draft has one place. A rule_draft naming any other file would let a
  // made-up "draft" vouch for the analysis.
  const path = DRAFT_PATH;
  const abs = join(root, path);
  const ours = (/** @type {any} */ d) =>
    d?.run_id === analysis.run_id && d?.story_id === analysis.story_id;
  if (!named) {
    // Dropping rule_draft must not hide the draft this run has.
    const d = existsSync(abs) ? readJson(abs) : null;
    return d?.ok && ours(d.data)
      ? [
          `does not name its rule-based draft (${path} exists for this run); keep rule_draft as the pre-classifier wrote it`,
        ]
      : [];
  }
  if (named.path !== DRAFT_PATH) {
    return [`names ${named.path} as its rule-based draft; it is ${DRAFT_PATH}`];
  }
  if (!existsSync(abs)) return [`its rule-based draft ${path} is missing`];
  /** @type {Buffer} */
  let bytes;
  try {
    bytes = readFileSync(abs);
  } catch {
    return [`its rule-based draft ${path} cannot be read`];
  }
  if (createHash('sha256').update(bytes).digest('hex') !== named.sha256) {
    return [
      `its rule-based draft ${path} changed after the pre-classifier wrote it (digest mismatch); re-run npm run classify`,
    ];
  }
  const draft = readJson(abs);
  if (!draft.ok || draft.data.status !== 'draft' || !ours(draft.data)) {
    return [`${path} is not this run's rule-based draft`];
  }
  return overrideProblems(draft.data, analysis);
}

/**
 * The severity downgrades a finalized analysis made that a person must
 * confirm (scripts/lib/analysis-overrides.js), and which of them are not
 * confirmed yet for these exact analysis bytes. Call it once draftProblems()
 * is empty: the draft is then this run's and unchanged.
 * @param {Context} context
 * @param {string} [root]
 * @returns {{ downgrades: import('./analysis-overrides.js').Downgrade[],
 *   pending: import('./analysis-overrides.js').Downgrade[],
 *   sha256: string | null }}
 */
export function downgradeStatus(context, root = '.') {
  const none = { downgrades: [], pending: [], sha256: null };
  const faRel = context?.artifact_paths?.failure_analysis;
  if (typeof faRel !== 'string' || !faRel) return none;
  /** @type {Buffer} */
  let bytes;
  try {
    bytes = readFileSync(join(root, faRel));
  } catch {
    return none;
  }
  const final = readJson(join(root, faRel));
  const draft = readJson(join(root, DRAFT_PATH));
  if (!final.ok || !final.data.rule_draft || !draft.ok) return none;
  const casesRel = context?.artifact_paths?.test_cases;
  const cases =
    typeof casesRel === 'string' && casesRel
      ? readJson(join(root, casesRel))
      : null;
  // The track from the story file as well as the context, as everywhere.
  const storyRel = context?.story?.path || 'story.md';
  const storyText = existsSync(join(root, storyRel))
    ? readFileSync(join(root, storyRel), 'utf8')
    : null;
  const downgrades = downgradesOf({
    draft: draft.data,
    final: final.data,
    context,
    testCases: cases?.ok ? cases.data : { test_cases: [] },
    track: effectiveTrack(context, storyText).track,
  });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    downgrades,
    pending: unconfirmed(
      downgrades,
      /** @type {any} */ (context).downgrade_confirmations ?? [],
      sha256
    ),
    sha256,
  };
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
 * Are an execution's Newman reports real evidence: valid JSON, with at least
 * one executed request between them?
 * @param {string} root
 * @param {string} executionId
 * @param {string} storyId
 * @returns {{ok: true, files: string[]} | {ok: false, reason: string}}
 */
export function newmanExecutionShape(root, executionId, storyId) {
  const files = newmanReportFiles(root, executionId, storyId);
  if (!files.length) {
    return {
      ok: false,
      reason: `execution ${executionId} wrote no Newman report for ${storyId}`,
    };
  }
  let executed = 0;
  for (const f of files) {
    const r = readJson(join(root, f));
    if (!r.ok) return { ok: false, reason: `${f} is not valid JSON` };
    executed += (r.data?.run?.executions ?? []).length;
  }
  if (executed === 0) {
    return {
      ok: false,
      reason: `execution ${executionId} executed no request`,
    };
  }
  return { ok: true, files };
}

/**
 * Newman evidence that can stand for THIS run's approved API branch: exactly
 * the reports the execute-api step recorded, unchanged, from a collection and
 * environment that have not changed since, under the current Gate 4' approval
 * (scripts/lib/execution-identity.js), with at least one executed request.
 * @param {Context} context
 * @param {string} [root]
 * @returns {{ok: true, executionId: string} | {ok: false, reason: string}}
 */
export function newmanEvidence(context, root = '.') {
  /** @type {string} */
  const story = context?.story?.id;
  const identity = /** @type {any} */ (context)?.execution_identity?.newman;
  const problems = newmanIdentityProblems(identity, {
    root,
    storyId: story,
    context,
  });
  if (problems.length) return { ok: false, reason: problems.join('; ') };
  const shape = newmanExecutionShape(root, identity.execution_id, story);
  if (!shape.ok) return shape;
  return { ok: true, executionId: identity.execution_id };
}

/**
 * The newest execution directory holding Newman reports for this story
 * (reports/<execution-id>/newman/<story>/*.json), or
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
