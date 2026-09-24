// Per-execution report layout (task group 3.2).
//
// Raw reporter outputs used to go to ONE constant path:
//
//   reports/newman-results.json
//
// independent of story, collection and run. CI loops collections calling
// `npm run test:api` per collection, so every collection but the last had its
// raw evidence destroyed (finding I4). A stale file from an unrelated story
// also read as current evidence, because nothing tied a report to an execution.
//
// The layout is now:
//
//   reports/<execution-id>/newman/<story-id>/<collection-id>.json
//   reports/<execution-id>/newman/<story-id>/<collection-id>.html
//
// An execution id scopes one logical run, so a later execution cannot be
// mistaken for the current one and a report is never overwritten by a sibling
// collection.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const REPORTS_ROOT = 'reports';

/** Legacy single-report path. Read for compatibility; never written to. */
export const LEGACY_NEWMAN_JSON = join('reports', 'newman-results.json');

/**
 * Characters allowed in a path component. Story and collection ids come from
 * filenames and env vars, so they are untrusted input: a component containing
 * a separator or `..` would escape the execution directory.
 */
const SAFE_COMPONENT = /^[A-Za-z0-9._-]+$/;

/** Reject a component that could escape or collide. */
export function validateComponent(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, message: `${label} is required` };
  }
  if (value.length > 120) {
    return { ok: false, message: `${label} is too long (max 120 characters)` };
  }
  if (value === '.' || value === '..') {
    return { ok: false, message: `${label} cannot be "${value}"` };
  }
  if (!SAFE_COMPONENT.test(value)) {
    return {
      ok: false,
      // Never echo the raw value beyond what is needed to fix it: it may carry
      // injected content.
      message: `${label} may contain only letters, digits, dot, dash and underscore`,
    };
  }
  return { ok: true, value };
}

/**
 * Create a new execution id. One per logical run: the pipeline passes its own
 * id down, and a standalone command mints one so its reports never land in
 * another run's directory.
 */
export function newExecutionId(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `exec-${stamp}-${randomUUID().slice(0, 8)}`;
}

/**
 * Resolve the execution id for this process.
 *
 * An explicit id (pipeline-supplied) wins; otherwise one is created. A
 * malformed inherited id is rejected rather than sanitized, because silently
 * rewriting it would put reports somewhere the caller does not expect.
 */
export function resolveExecutionId(explicit, env = {}) {
  const candidate = explicit || env.QAIZEN_EXECUTION_ID;
  if (!candidate) return { ok: true, value: newExecutionId(), created: true };
  const check = validateComponent(candidate, 'execution id');
  if (!check.ok) return check;
  return { ok: true, value: candidate, created: false };
}

/**
 * Directory holding every Newman report for one story in one execution.
 * @returns {{ok: true, value: string} | {ok: false, message: string}}
 */
export function newmanStoryDir(executionId, storyId) {
  for (const [value, label] of [
    [executionId, 'execution id'],
    [storyId, 'story id'],
  ]) {
    const check = validateComponent(value, label);
    if (!check.ok) return check;
  }
  return {
    ok: true,
    value: join(REPORTS_ROOT, executionId, 'newman', storyId),
  };
}

/**
 * Paths for one collection's raw reports.
 * @returns {{ok: true, dir: string, json: string, html: string} | {ok: false, message: string}}
 */
export function newmanReportPaths(executionId, storyId, collectionId) {
  const dir = newmanStoryDir(executionId, storyId);
  if (!dir.ok) return dir;
  const check = validateComponent(collectionId, 'collection id');
  if (!check.ok) return check;
  return {
    ok: true,
    dir: dir.value,
    json: join(dir.value, `${collectionId}.json`),
    html: join(dir.value, `${collectionId}.html`),
  };
}

/** Create the directory for a set of report paths. */
export function ensureReportDir(paths) {
  mkdirSync(paths.dir, { recursive: true });
  return paths;
}

/**
 * Published (sanitized) summary path for one collection in one execution.
 *
 * Published files stay grouped per execution too, so a CI upload of
 * `reports/<execution-id>/published` cannot pick up an unrelated run.
 */
export function publishedPaths(executionId, storyId, collectionId) {
  for (const [value, label] of [
    [executionId, 'execution id'],
    [storyId, 'story id'],
    [collectionId, 'collection id'],
  ]) {
    const check = validateComponent(value, label);
    if (!check.ok) return check;
  }
  const dir = join(REPORTS_ROOT, executionId, 'published');
  return {
    ok: true,
    dir,
    json: join(dir, `newman-${storyId}-${collectionId}.json`),
  };
}
