// @ts-check
// Outcome records: what happened after a run, entered by a person through
// scripts/record-outcome.js and read by the metrics and the defect history.
//
//   outcomes/escaped-defects/ESC-NNN.json   a bug a completed run should
//                                           have caught (escaped-defect)
//   outcomes/costs/<story>.json             the operator's time and spend per
//                                           run of a story (story-cost)
//
// They name an archived run under runs/ and never change it: an archive is
// evidence. outcomes/ is not a run folder, so it is never archived or cleared
// with a run.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatErrors, readJson, validateValue } from './artifact-io.js';

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ESCAPED_DEFECT_SCHEMA = join(
  REPO_DIR,
  'schemas',
  'escaped-defect.schema.json'
);
export const STORY_COST_SCHEMA = join(
  REPO_DIR,
  'schemas',
  'story-cost.schema.json'
);

/** Relative to the repository root. */
export const OUTCOMES_DIR = 'outcomes';
export const ESCAPED_DIR = 'outcomes/escaped-defects';
export const COSTS_DIR = 'outcomes/costs';

const ESC_FILE = /^ESC-(\d{3,})\.json$/;

/**
 * The lines a failed validation reports, without the offending values.
 * @param {{ message: string, errors?: any[] }} v
 */
const schemaErrors = (v) =>
  v.errors?.length ? formatErrors(v.errors).map((l) => l.trim()) : [v.message];

/** @param {string} p */
const isDir = (p) => existsSync(p) && statSync(p).isDirectory();

/**
 * @param {string} path
 * @returns {any} parsed JSON, or undefined when unreadable
 */
function parsed(path) {
  const r = readJson(path);
  return r.ok ? r.data : undefined;
}

/**
 * Every escaped-defect record that validates, and how many do not.
 * @param {string} [dir]
 * @returns {{ records: any[], invalid: number }}
 */
export function readEscapedDefects(dir = ESCAPED_DIR) {
  /** @type {any[]} */
  const records = [];
  let invalid = 0;
  if (!isDir(dir)) return { records, invalid };
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const data = parsed(join(dir, name));
    const m = ESC_FILE.exec(name);
    if (
      data === undefined ||
      !m ||
      data.escaped_defect_id !== `ESC-${m[1]}` ||
      !validateValue(data, ESCAPED_DEFECT_SCHEMA).ok ||
      !ofStory(data.run_archive, data.story_id)
    )
      invalid += 1;
    else records.push(data);
  }
  return { records, invalid };
}

/**
 * Every story-cost document that validates, and how many do not.
 * @param {string} [dir]
 * @returns {{ docs: any[], invalid: number }}
 */
export function readStoryCosts(dir = COSTS_DIR) {
  /** @type {any[]} */
  const docs = [];
  let invalid = 0;
  if (!isDir(dir)) return { docs, invalid };
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const data = parsed(join(dir, name));
    if (
      data === undefined ||
      name !== `${data?.story_id}.json` ||
      !validateValue(data, STORY_COST_SCHEMA).ok ||
      data.runs.some(
        (/** @type {any} */ r) => !ofStory(r.run_archive, data.story_id)
      ) ||
      // One entry per run: a second one would count the run twice.
      new Set(data.runs.map((/** @type {any} */ r) => r.run_id)).size !==
        data.runs.length
    )
      invalid += 1;
    else docs.push(data);
  }
  return { docs, invalid };
}

/**
 * Whether an archive path is a run folder of this story.
 * @param {string} archive
 * @param {string} story
 */
const ofStory = (archive, story) =>
  typeof archive === 'string' && archive.startsWith(`runs/${story}/`);

/**
 * The id a run is known by, everywhere the metrics and the outcome records
 * meet: the id its context records, else its failure analysis's, else its
 * archive folder name.
 * @param {any} context
 * @param {any} failureAnalysis
 * @param {string} folder
 * @returns {string}
 */
export function runIdentity(context, failureAnalysis, folder) {
  for (const id of [context?.run_id, failureAnalysis?.run_id])
    if (typeof id === 'string' && id) return id;
  return folder;
}

/**
 * The next free escaped-defect id.
 * @param {string} [dir]
 */
export function nextEscapedId(dir = ESCAPED_DIR) {
  let max = 0;
  if (isDir(dir))
    for (const name of readdirSync(dir)) {
      const m = ESC_FILE.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
  return `ESC-${String(max + 1).padStart(3, '0')}`;
}

/**
 * @typedef {{ archive: string, runId: string, context: any,
 *   testCases: any[], ledger: any }} ArchivedRun
 */

/**
 * The archived run a record names: by its archive folder name or by the run
 * id its context records. A demo run is never one.
 * @param {string} runsDir
 * @param {string} story
 * @param {string} run
 * @returns {{ ok: true, run: ArchivedRun } | { ok: false, error: string }}
 */
export function findArchivedRun(runsDir, story, run) {
  const storyDir = join(runsDir, story);
  if (!isDir(storyDir))
    return {
      ok: false,
      error: `no archived run of ${story} under ${runsDir}/`,
    };
  /** @type {ArchivedRun[]} */
  const matches = [];
  for (const name of readdirSync(storyDir).sort()) {
    const dir = join(storyDir, name);
    if (!isDir(dir) || existsSync(join(dir, 'DEMO_RUN'))) continue;
    const context = parsed(join(dir, 'context.json')) ?? null;
    const runId = runIdentity(
      context,
      parsed(join(dir, 'analysis', 'failure-analysis.json')),
      name
    );
    if (name !== run && runId !== run) continue;
    const casesRel =
      context?.artifact_paths?.test_cases || `test-cases/${story}.json`;
    const cases = parsed(join(dir, casesRel));
    matches.push({
      archive: `runs/${story}/${name}`,
      runId,
      context,
      testCases: Array.isArray(cases?.test_cases) ? cases.test_cases : [],
      ledger: parsed(join(dir, 'analysis', 'execution-ledger.json')) ?? null,
    });
  }
  if (!matches.length)
    return {
      ok: false,
      error: `${story} has no archived run "${run}" (neither a folder under ${runsDir}/${story}/ nor a run_id a context there records; demo runs do not count)`,
    };
  if (matches.length > 1)
    return {
      ok: false,
      error: `"${run}" names ${matches.length} archives of ${story} (${matches.map((m) => m.archive).join(', ')}); name the archive folder instead`,
    };
  return { ok: true, run: matches[0] };
}

/**
 * @typedef {{ id: string, story: string, run: ArchivedRun, risks: string[],
 *   unresolved?: string, cases: string[], summary: string, severity: string,
 *   foundIn: string, foundAt: string, whyMissed: string, jira?: string,
 *   notes?: string, by: string, now: Date, existing?: any[],
 *   forceNew?: boolean }} EscapedInput
 */

/** The automation decisions a reason for missing a defect fits. */
const DECISIONS_FOR = {
  test_passed_wrongly: ['automate_e2e', 'automate_api', 'automate_component'],
  not_run: ['automate_e2e', 'automate_api', 'automate_component'],
  not_automated: ['manual', 'skip'],
};

/** @param {string} s */
const sameText = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * An escaped-defect record, checked against the run it names: the run is
 * completed; every risk is that run's own; every case is an approved case of
 * it whose automation decision fits why the defect was missed (and, for a
 * test that passed wrongly, one the run's ledger does not record as anything
 * but passed); and it is not a record already made, unless forceNew says it
 * is another defect.
 * @param {EscapedInput} i
 * @returns {{ ok: true, record: any } | { ok: false, errors: string[] }}
 */
export function buildEscapedDefect(i) {
  /** @type {string[]} */
  const errors = [];
  const ctx = i.run.context;
  if (ctx?.status !== 'completed')
    errors.push(
      `${i.run.archive} is not a completed run (status ${ctx?.status ?? 'unknown'}): only a completed run can have let a defect escape`
    );
  const knownRisks = new Set(
    (Array.isArray(ctx?.risks) ? ctx.risks : []).map(
      (/** @type {any} */ r) => r?.risk_id
    )
  );
  for (const r of i.risks)
    if (!knownRisks.has(r))
      errors.push(`${r} is not a risk of ${i.run.archive}`);
  const fits = /** @type {Record<string, string[]>} */ (DECISIONS_FOR)[
    i.whyMissed
  ];
  /** @type {any[]} */
  const outcomes = Array.isArray(i.run.ledger?.case_outcomes)
    ? i.run.ledger.case_outcomes
    : [];
  for (const id of i.cases) {
    const c = i.run.testCases.find((x) => x?.test_case_id === id);
    if (!c) {
      errors.push(`${id} is not a test case of ${i.run.archive}`);
      continue;
    }
    if (c.status !== 'approved')
      errors.push(
        `${id} is ${c.status ?? 'not approved'} in ${i.run.archive}; only an approved case was in scope`
      );
    if (fits && !fits.includes(c.automation_decision))
      errors.push(
        `${id} was decided ${c.automation_decision}, which does not fit ${i.whyMissed} (that needs ${fits.join(', ')})`
      );
    const ran = outcomes.find((o) => o?.test_case_id === id)?.outcome;
    if (i.whyMissed === 'test_passed_wrongly' && ran && ran !== 'passed')
      errors.push(
        `the run's ledger records ${id} as ${ran}, not passed; ${ran === 'not_run' ? 'use --why-missed not_run' : 'a test that did not pass did not pass wrongly'}`
      );
  }
  if (!i.forceNew)
    for (const r of i.existing ?? []) {
      if (r.escaped_defect_id === i.id) continue;
      if (i.jira && r.jira_key === i.jira)
        errors.push(
          `${r.escaped_defect_id} already records ${i.jira}; replace it (--replace ${r.escaped_defect_id}) or, if this is another defect, pass --force-new`
        );
      else if (
        r.story_id === i.story &&
        r.run_id === i.run.runId &&
        sameText(r.summary) === sameText(i.summary)
      )
        errors.push(
          `${r.escaped_defect_id} already records this defect for ${i.run.runId}; replace it (--replace ${r.escaped_defect_id}) or, if this is another defect, pass --force-new`
        );
    }
  if (!i.risks.length && !i.unresolved)
    errors.push(
      'name the risk(s) of that run the defect falls under (--risk), or say why none does (--unresolved "<reason>")'
    );
  if (i.risks.length && i.unresolved)
    errors.push('--risk and --unresolved cannot be combined');
  if (errors.length) return { ok: false, errors };
  const record = {
    schema_version: '1.0',
    record_type: 'escaped_defect',
    escaped_defect_id: i.id,
    story_id: i.story,
    run_id: i.run.runId,
    run_archive: i.run.archive,
    risk_ids: i.risks,
    ...(i.unresolved ? { traceability_unresolved: i.unresolved } : {}),
    test_case_ids: i.cases,
    summary: i.summary,
    severity: i.severity,
    found_in: i.foundIn,
    found_at: i.foundAt,
    why_missed: i.whyMissed,
    ...(i.jira ? { jira_key: i.jira } : {}),
    ...(i.notes ? { notes: i.notes } : {}),
    recorded_at: i.now.toISOString(),
    recorded_by: i.by,
  };
  const v = validateValue(record, ESCAPED_DEFECT_SCHEMA);
  if (!v.ok) return { ok: false, errors: schemaErrors(v) };
  return { ok: true, record };
}

/**
 * A story's cost document with one run's entry added, or replaced when asked.
 * @param {any} doc the current document, or null
 * @param {string} story
 * @param {any} entry
 * @param {boolean} replace
 * @returns {{ ok: true, doc: any } | { ok: false, errors: string[] }}
 */
export function withCostEntry(doc, story, entry, replace) {
  const runs = Array.isArray(doc?.runs) ? [...doc.runs] : [];
  const at = runs.findIndex((r) => r?.run_id === entry.run_id);
  if (at !== -1 && !replace)
    return {
      ok: false,
      errors: [
        `${story} already has a cost for ${entry.run_id}; pass --replace to replace it`,
      ],
    };
  if (at !== -1) runs[at] = entry;
  else runs.push(entry);
  const next = {
    schema_version: '1.0',
    record_type: 'story_cost',
    story_id: story,
    runs,
  };
  const v = validateValue(next, STORY_COST_SCHEMA);
  if (!v.ok) return { ok: false, errors: schemaErrors(v) };
  return { ok: true, doc: next };
}
