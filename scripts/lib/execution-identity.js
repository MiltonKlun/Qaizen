// @ts-check
// What an execution was: the identity the runner records the moment the test
// runner finishes, and the check that the evidence on disk is still that.
//
// The Playwright report used to be accepted when it was newer than the test
// it ran. A report dropped in later, or one produced under another config,
// passed. Now the execute step records, in context.json execution_identity:
// the report's digest, the config it ran with and its digest, the base URL,
// the app build (QAIZEN_APP_BUILD, or "unknown"), the Gate 4 approval it ran
// under, and an execution id. On --resume the report is accepted only while
// all of that still holds; the classify step passes the same identity into
// the ledger (source_executions[].config_identity).
//
// I/O is limited to reading the files named; nothing is written here.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** What the app build is recorded as when nobody declared it (D4). */
export const UNKNOWN_BUILD = 'unknown';

/**
 * @typedef {{
 *   execution_id: string,
 *   recorded_at: string,
 *   report_path: string,
 *   report_sha256: string,
 *   config_path: string,
 *   config_sha256: string | null,
 *   base_url: string | null,
 *   app_build: string,
 *   gate_digest: string | null,
 * }} ExecutionIdentity
 *   Paths are relative to the run's folder, with forward slashes.
 *   `config_sha256` is null when the config file does not exist;
 *   `gate_digest` is the Gate 4 approval's input digest, or null when the
 *   gate carries none.
 */

const posix = (/** @type {string} */ p) => p.split(sep).join('/');

/** @param {string} path */
function digest(path) {
  return existsSync(path)
    ? createHash('sha256').update(readFileSync(path)).digest('hex')
    : null;
}

/**
 * The Gate 4 approval digest the run executes under.
 * @param {any} context
 * @returns {string | null}
 */
function gate4Digest(context) {
  const g = context?.review_gates?.code_reviewed;
  return g && typeof g === 'object' && typeof g.input_digest === 'string'
    ? g.input_digest
    : null;
}

/**
 * Record what a Playwright execution was, right after it produced its report.
 * @param {object} args
 * @param {string} args.root          the run's folder
 * @param {string} args.reportPath    relative to root
 * @param {string} args.configPath    as Playwright was given it (absolute or
 *   relative to root)
 * @param {any} args.context
 * @param {Record<string, string | undefined>} args.env
 * @param {string} [args.now]
 * @returns {ExecutionIdentity}
 */
export function playwrightIdentity({
  root,
  reportPath,
  configPath,
  context,
  env,
  now = new Date().toISOString(),
}) {
  const configAbs = resolve(root, configPath);
  const build = (env.QAIZEN_APP_BUILD ?? '').trim();
  return {
    execution_id: `exec-pw-${randomUUID().slice(0, 8)}`,
    recorded_at: now,
    report_path: posix(reportPath),
    report_sha256: /** @type {string} */ (digest(join(root, reportPath))),
    config_path: posix(relative(resolve(root), configAbs)),
    config_sha256: digest(configAbs),
    base_url: (env.BASE_URL ?? '').trim() || null,
    app_build: build || UNKNOWN_BUILD,
    gate_digest: gate4Digest(context),
  };
}

/**
 * Why the evidence on disk is no longer the execution that was recorded.
 * @param {ExecutionIdentity | undefined} identity
 * @param {object} args
 * @param {string} args.root
 * @param {string} args.reportPath relative to root
 * @param {any} args.context
 * @returns {string[]} empty when the report, its config and its approval
 *   are exactly what the execute step recorded
 */
export function identityProblems(identity, { root, reportPath, context }) {
  if (!identity) {
    return [
      'has no recorded execution identity; it was not produced by the execute step of this run',
    ];
  }
  /** @type {string[]} */
  const problems = [];
  if (identity.report_path !== posix(reportPath)) {
    problems.push(
      `is not the report the execute step recorded (${identity.report_path})`
    );
  } else if (digest(join(root, reportPath)) !== identity.report_sha256) {
    problems.push(
      'changed after the execute step recorded it (digest mismatch)'
    );
  }
  if (digest(resolve(root, identity.config_path)) !== identity.config_sha256) {
    problems.push(
      `was produced with ${identity.config_path}, which has changed since`
    );
  }
  if (gate4Digest(context) !== identity.gate_digest) {
    problems.push(
      'was produced under a different Gate 4 approval than the current one'
    );
  }
  return problems;
}

/**
 * @typedef {{
 *   execution_id: string,
 *   recorded_at: string,
 *   reports: { path: string, sha256: string }[],
 *   collection_path: string,
 *   collection_sha256: string | null,
 *   environment_path: string,
 *   environment_sha256: string | null,
 *   base_url: string | null,
 *   app_build: string,
 *   gate_digest: string | null,
 * }} NewmanIdentity
 *   `reports`: every Newman JSON report of the execution for this story,
 *   relative to the run's folder. `base_url` is the environment file's
 *   `base_url` value. `gate_digest` is the Gate 4' (api_assertions_reviewed)
 *   approval's input digest.
 */

/**
 * The Newman JSON reports of one execution for one story, relative to root.
 * @param {string} root
 * @param {string} executionId
 * @param {string} storyId
 * @returns {string[]}
 */
export function newmanReportFiles(root, executionId, storyId) {
  const dir = posix(join('reports', executionId, 'newman', storyId));
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => `${dir}/${f}`);
}

/** @param {string} path */
function environmentBaseUrl(path) {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    const v = (doc?.values ?? []).find(
      (/** @type {any} */ x) => x?.key === 'base_url'
    )?.value;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** @param {any} context */
function gate4ApiDigest(context) {
  const g = context?.review_gates?.api_assertions_reviewed;
  return g && typeof g === 'object' && typeof g.input_digest === 'string'
    ? g.input_digest
    : null;
}

/**
 * Record what a Newman execution was, right after it wrote its reports.
 * @param {object} args
 * @param {string} args.root
 * @param {string} args.executionId
 * @param {string} args.storyId
 * @param {string} args.collectionPath relative to root
 * @param {string} args.environmentPath relative to root
 * @param {any} args.context
 * @param {Record<string, string | undefined>} args.env
 * @param {string} [args.now]
 * @returns {NewmanIdentity}
 */
export function newmanIdentity({
  root,
  executionId,
  storyId,
  collectionPath,
  environmentPath,
  context,
  env,
  now = new Date().toISOString(),
}) {
  const build = (env.QAIZEN_APP_BUILD ?? '').trim();
  return {
    execution_id: executionId,
    recorded_at: now,
    reports: newmanReportFiles(root, executionId, storyId).map((path) => ({
      path,
      sha256: /** @type {string} */ (digest(join(root, path))),
    })),
    collection_path: posix(collectionPath),
    collection_sha256: digest(join(root, collectionPath)),
    environment_path: posix(environmentPath),
    environment_sha256: digest(join(root, environmentPath)),
    base_url: environmentBaseUrl(join(root, environmentPath)),
    app_build: build || UNKNOWN_BUILD,
    gate_digest: gate4ApiDigest(context),
  };
}

/**
 * Why the Newman evidence on disk is no longer the execution recorded.
 * @param {NewmanIdentity | undefined} identity
 * @param {{ root: string, storyId: string, context: any }} args
 * @returns {string[]}
 */
export function newmanIdentityProblems(identity, { root, storyId, context }) {
  if (!identity) {
    return ['no Newman execution was recorded for this run'];
  }
  /** @type {string[]} */
  const problems = [];
  const id = identity.execution_id;
  const onDisk = newmanReportFiles(root, id, storyId);
  const recorded = identity.reports.map((r) => r.path);
  const extra = onDisk.filter((p) => !recorded.includes(p));
  const missing = recorded.filter((p) => !onDisk.includes(p));
  if (extra.length)
    problems.push(
      `execution ${id} holds reports it did not record: ${extra.join(', ')}`
    );
  if (missing.length)
    problems.push(
      `execution ${id} is missing recorded reports: ${missing.join(', ')}`
    );
  const changed = identity.reports.filter(
    (r) => onDisk.includes(r.path) && digest(join(root, r.path)) !== r.sha256
  );
  if (changed.length) {
    problems.push(
      `execution ${id}: ${changed.map((r) => r.path).join(', ')} changed after it was recorded (digest mismatch)`
    );
  }
  for (const [label, path, sha] of [
    ['collection', identity.collection_path, identity.collection_sha256],
    ['environment', identity.environment_path, identity.environment_sha256],
  ]) {
    if (digest(join(root, /** @type {string} */ (path))) !== sha) {
      problems.push(
        `execution ${id} ran a ${label} (${path}) that has changed since`
      );
    }
  }
  if (gate4ApiDigest(context) !== identity.gate_digest) {
    problems.push(
      `execution ${id} ran under a different Gate 4' approval than the current one`
    );
  }
  return problems;
}
