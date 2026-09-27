// Recoverable external synchronization (task group 5.1, review finding I2).
//
// The Jira and TestLink adapters used to create every remote item, keep the
// new ids in memory, and write them to disk only after the whole batch
// succeeded. A failure on the third create lost the ids of the first two, and
// the next run created them again. This module holds what the adapters share
// so that cannot happen:
//
//   - a stable OPERATION identity per remote create, and a short MARKER derived
//     from it that travels with the create so an uncertain outcome can be
//     found again by a read-only search;
//   - a per-workspace, per-target LOCK so two syncs never write concurrently;
//   - HTTP with a bounded timeout, and a classification of every outcome as
//     created / definitely rejected / AMBIGUOUS (the request may have been
//     processed but no usable answer came back);
//   - sanitized diagnostics that never echo a credential;
//   - the scope checks every adapter runs before any request.
//
// What it deliberately does not do: retry a create. An ambiguous create is
// resolved by reconciliation (search by marker), never by sending it again.
// The lock is a transient mutual-exclusion file, not a queue or a state store.

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { canonicalJson, requireCurrentGate } from './approval-binding.js';
import { redactText } from './report-sanitization.js';
import { gatePassed } from '../pipeline-state.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------------ operations

/** Record states (schemas/test-cases.schema.json#/definitions/syncRecord). */
export const SYNC_STATE = {
  PENDING: 'pending',
  CREATED: 'created',
  FAILED: 'failed',
  NOT_FOUND: 'not_found',
};

/**
 * Stable identity of one remote create: the same target, project, story,
 * local item and operation kind always yield the same key, across runs.
 */
export function operationKey({ target, project, storyId, localId, kind }) {
  for (const [name, v] of Object.entries({
    target,
    project,
    storyId,
    localId,
    kind,
  })) {
    if (typeof v !== 'string' || !v) {
      throw new Error(`operationKey: ${name} is required`);
    }
  }
  return [target, project, storyId, localId, kind].join(':');
}

/** Short, search-friendly marker for an operation key. */
export function operationMarker(key) {
  return `qaizen-op-${sha256(key).slice(0, 12)}`;
}

/** Digest of a request payload, independent of key order. */
export function payloadDigest(payload) {
  return sha256(canonicalJson(payload));
}

/**
 * The next action for one local item, from its saved record and whether it
 * already carries a remote id. Pure: dry-run and apply call the same function
 * on the same validated inputs, so they plan identical operations.
 *
 * @returns {'create'|'reconcile'|'link'|'skip'}
 */
export function planAction(record, remoteId, { linkWanted = false } = {}) {
  if (record?.state === SYNC_STATE.PENDING) return 'reconcile';
  if (remoteId) {
    const retryLink =
      linkWanted &&
      record?.state === SYNC_STATE.CREATED &&
      (record.link_state === 'pending' || record.link_state === 'failed');
    return retryLink ? 'link' : 'skip';
  }
  return 'create';
}

// ------------------------------------------------------------ lock

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return err.code === 'EPERM';
  }
}

/**
 * Take the per-workspace lock for one target (e.g. "jira", "testlink").
 *
 * A live holder always wins. A holder that looks dead is only removed with an
 * explicit `releaseStale`, and only when its death is provable here (same host,
 * process gone); anything else is left for a human to inspect.
 *
 * @returns {{ok: true, release: () => void} | {ok: false, reason: string}}
 */
export function acquireLock(
  root,
  target,
  { releaseStale = false, now = new Date() } = {}
) {
  const dir = join(root, '.qaizen', 'locks');
  const path = join(dir, `${target}.lock`);
  const me = {
    pid: process.pid,
    host: hostname(),
    started_at: now.toISOString(),
  };

  const tryCreate = () => {
    mkdirSync(dir, { recursive: true });
    let fd;
    try {
      fd = openSync(path, 'wx');
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      throw err;
    }
    try {
      writeSync(fd, JSON.stringify(me));
    } finally {
      closeSync(fd);
    }
    return true;
  };

  const release = () => {
    try {
      const holder = JSON.parse(readFileSync(path, 'utf8'));
      if (holder.pid === me.pid && holder.host === me.host) rmSync(path);
    } catch {
      // Already gone or replaced by a human: nothing of ours to remove.
    }
  };

  if (tryCreate()) return { ok: true, release };

  let holder = null;
  try {
    holder = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Unreadable lock: its owner cannot be verified.
  }
  const who = holder
    ? `pid ${holder.pid} on ${holder.host} since ${holder.started_at}`
    : 'an unreadable owner';
  const sameHost = Boolean(holder) && holder.host === me.host;
  const pidKnown = Boolean(holder) && Number.isInteger(holder.pid);

  if (sameHost && pidKnown && pidAlive(holder.pid)) {
    return {
      ok: false,
      reason: `another ${target} sync is running (${who}). Wait for it to finish.`,
    };
  }
  if (!(sameHost && pidKnown)) {
    return {
      ok: false,
      reason:
        `the ${target} lock ${path} is held by ${who}, which cannot be verified from this machine. ` +
        `If you are certain no sync is running, delete that file by hand.`,
    };
  }
  if (!releaseStale) {
    return {
      ok: false,
      reason:
        `the ${target} lock ${path} is held by ${who}, which is no longer running. ` +
        `If that sync was interrupted, re-run with --release-stale-lock.`,
    };
  }
  rmSync(path, { force: true });
  if (tryCreate()) return { ok: true, release };
  return {
    ok: false,
    reason: `the ${target} lock was taken by another process while releasing a stale one.`,
  };
}

// ------------------------------------------------------------ HTTP

export const DEFAULT_TIMEOUT_MS = 30000;

/** Request timeout from QAIZEN_HTTP_TIMEOUT_MS, bounded to 1s..120s. */
export function httpTimeoutMs(env = process.env) {
  const raw = env.QAIZEN_HTTP_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 100 || n > 120000) {
    throw new Error(
      `QAIZEN_HTTP_TIMEOUT_MS must be an integer between 100 and 120000 (got "${raw}")`
    );
  }
  return n;
}

// Errors raised before a request can have reached the server: nothing was
// processed, so the operation definitely did not happen.
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_INVALID_URL',
]);

function transportFailure(err) {
  const code = err?.cause?.code ?? err?.code ?? null;
  if (code && NOT_SENT_CODES.has(code)) {
    return { kind: 'not_sent', error: `not sent (${code})` };
  }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return { kind: 'ambiguous', error: 'timed out waiting for a response' };
  }
  return {
    kind: 'ambiguous',
    error: `connection failed after sending (${code ?? err?.message ?? 'unknown error'})`,
  };
}

/**
 * One HTTP request with a hard timeout covering the whole exchange.
 * @returns {Promise<{kind: 'response', status: number, ok: boolean, text: string}
 *   | {kind: 'not_sent' | 'ambiguous', error: string}>}
 */
export async function httpRequest(
  url,
  { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { kind: 'response', status: res.status, ok: res.ok, text };
  } catch (err) {
    if (err instanceof TypeError && /Invalid URL/i.test(err.message)) {
      return { kind: 'not_sent', error: 'not sent (invalid URL)' };
    }
    return transportFailure(err);
  }
}

/**
 * Classify the outcome of a CREATE request.
 *
 * `parse(text)` returns `{ id }` for a recognised success body, `{ rejected }`
 * for a recognised refusal (an XML-RPC fault, for instance), or null when the
 * body cannot be interpreted.
 *
 *   created   — the remote id is known
 *   rejected  — the remote definitely did not create anything
 *   ambiguous — it may have; reconcile before any new create
 */
export function classifyCreate(result, parse, secrets = []) {
  if (result.kind === 'not_sent') {
    return { outcome: 'rejected', detail: result.error };
  }
  if (result.kind === 'ambiguous') {
    return { outcome: 'ambiguous', detail: result.error };
  }
  const body = sanitizeDiagnostic(result.text, secrets);
  if (result.status >= 400 && result.status < 500) {
    return {
      outcome: 'rejected',
      status: result.status,
      detail: `HTTP ${result.status}: ${body}`,
    };
  }
  if (result.status < 200 || result.status >= 300) {
    return {
      outcome: 'ambiguous',
      status: result.status,
      detail: `HTTP ${result.status}: ${body}`,
    };
  }
  const parsed = parse(result.text);
  if (parsed?.id) return { outcome: 'created', id: parsed.id };
  if (parsed?.rejected) {
    return {
      outcome: 'rejected',
      status: result.status,
      detail: sanitizeDiagnostic(parsed.rejected, secrets),
    };
  }
  return {
    outcome: 'ambiguous',
    status: result.status,
    detail: `HTTP ${result.status} but no usable id in the response: ${body}`,
  };
}

/** Make a remote diagnostic safe to print and to store in last_error. */
export function sanitizeDiagnostic(text, secrets = []) {
  let out = redactText(String(text ?? ''), secrets.filter(Boolean));
  out = out
    .replace(
      /(<name>devKey<\/name>\s*<value>\s*(?:<string>)?)[^<]*/gi,
      '$1[REDACTED]'
    )
    .replace(/(Basic|Bearer)\s+[A-Za-z0-9+/=._-]+/g, '$1 [REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > 300 ? `${out.slice(0, 300)}...` : out;
}

// ------------------------------------------------------------ scope checks

/** The approval that covers a run's test scope: Gate 2, or the lite gate. */
export function scopeGate(context) {
  return context.track === 'lite' ||
    gatePassed(context.review_gates?.qa_scope_approved)
    ? 'qa_scope_approved'
    : 'test_scope_reviewed';
}

/**
 * Before any request: the artifact belongs to the active story and run, and
 * the scope approval is current.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkSyncScope(context, doc, storyId, root = '.') {
  const active = context.story?.id;
  if (active !== storyId) {
    return {
      ok: false,
      reason: `context.json is for story ${active ?? '(none)'}, not ${storyId}`,
    };
  }
  if (doc.story_id !== storyId) {
    return {
      ok: false,
      reason: `the test cases are for story ${doc.story_id}, not ${storyId}`,
    };
  }
  if (doc.run_id !== context.run_id) {
    return {
      ok: false,
      reason: `the test cases belong to run ${doc.run_id}, but the active run is ${context.run_id}`,
    };
  }
  const gate = scopeGate(context);
  const current = requireCurrentGate(context, gate, root);
  if (!current.ok)
    return { ok: false, reason: `scope approval: ${current.reason}` };
  return { ok: true };
}

/** TEST_MANAGEMENT_TOOL values and the adapters each one selects. */
export const TEST_MANAGEMENT_TOOLS = {
  testlink: ['testlink'],
  jira: ['jira'],
  both: ['testlink', 'jira'],
  xray: ['xray'],
  qase: ['qase'],
  none: [],
};

/**
 * Does TEST_MANAGEMENT_TOOL select this adapter? An unset or unknown value is
 * an error, never a silent default.
 * @returns {{ok: true, tool: string} | {ok: false, reason: string}}
 */
export function selectTestManagementTarget(raw, target) {
  const tool = String(raw ?? '')
    .trim()
    .toLowerCase();
  const known = Object.keys(TEST_MANAGEMENT_TOOLS).join(' | ');
  if (!tool) {
    return {
      ok: false,
      reason: `TEST_MANAGEMENT_TOOL is unset; set it to ${target} or both to run the ${target} adapter (values: ${known}).`,
    };
  }
  if (!(tool in TEST_MANAGEMENT_TOOLS)) {
    return {
      ok: false,
      reason: `TEST_MANAGEMENT_TOOL="${raw}" is not a known value (${known}).`,
    };
  }
  if (!TEST_MANAGEMENT_TOOLS[tool].includes(target)) {
    return {
      ok: false,
      reason: `TEST_MANAGEMENT_TOOL=${tool} does not select the ${target} adapter; set it to ${target} or both to opt in.`,
    };
  }
  return { ok: true, tool };
}

// ------------------------------------------------------------ Jira client

export const JIRA_KEY = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;

function parseJiraCreate(text) {
  try {
    const key = JSON.parse(text)?.key;
    return typeof key === 'string' && JIRA_KEY.test(key) ? { id: key } : null;
  } catch {
    return null;
  }
}

/** Atlassian Document Format: one paragraph per line of plain text. */
export function adf(text) {
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}

/**
 * The three Jira REST calls the adapters need. Credentials stay inside the
 * client; every diagnostic it returns is sanitized.
 */
export function jiraClient({ baseUrl, user, token, timeoutMs }) {
  const auth = 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');
  const secrets = [token, auth.slice('Basic '.length)];
  const headers = {
    Authorization: auth,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const base = baseUrl.replace(/\/$/, '');
  const call = (path, method, body) =>
    httpRequest(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs,
    });
  const describe = (r) =>
    r.kind === 'response'
      ? `HTTP ${r.status}: ${sanitizeDiagnostic(r.text, secrets)}`
      : r.error;

  return {
    secrets,
    async createIssue(fields) {
      const r = await call('/rest/api/3/issue', 'POST', { fields });
      return classifyCreate(r, parseJiraCreate, secrets);
    },
    async linkToStory(key, storyKey, linkType) {
      const r = await call('/rest/api/3/issueLink', 'POST', {
        type: { name: linkType },
        inwardIssue: { key },
        outwardIssue: { key: storyKey },
      });
      return r.kind === 'response' && r.ok
        ? { ok: true }
        : { ok: false, detail: describe(r) };
    },
    /** Read-only: issues in the project carrying the marker label. */
    async findByMarker(projectKey, marker) {
      const jql = `project = "${projectKey}" AND labels = "${marker}"`;
      const r = await call(
        `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=key&maxResults=10`,
        'GET'
      );
      if (r.kind !== 'response' || !r.ok) {
        return { ok: false, detail: describe(r) };
      }
      let issues;
      try {
        issues = JSON.parse(r.text)?.issues;
      } catch {
        issues = undefined;
      }
      if (!Array.isArray(issues)) {
        return { ok: false, detail: 'search response had no issues array' };
      }
      const keys = issues.map((i) => i?.key);
      if (!keys.every((k) => typeof k === 'string' && JIRA_KEY.test(k))) {
        return {
          ok: false,
          detail: 'search response had a malformed issue key',
        };
      }
      return { ok: true, keys };
    },
  };
}

// ------------------------------------------------------------ CLI helpers

/** Parse --resolve ID=REMOTE|none (repeatable). */
export function parseResolutions(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--resolve') continue;
    const spec = argv[i + 1] ?? '';
    const m = spec.match(/^([A-Za-z]+-[0-9]+)=(.+)$/);
    if (!m) {
      throw new Error(
        `--resolve expects LOCAL-ID=REMOTE-ID or LOCAL-ID=none (got "${spec}")`
      );
    }
    out.push({ localId: m[1], remote: m[2] === 'none' ? null : m[2] });
    i++;
  }
  return out;
}

/** Parse --limit N as a positive integer (Infinity when absent). */
export function parseLimit(argv) {
  const i = argv.indexOf('--limit');
  if (i === -1) return Infinity;
  const raw = argv[i + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--limit expects a positive integer (got "${raw ?? ''}")`);
  }
  return n;
}

/** Fill process.env gaps from a local .env file; never overrides real env. */
export function loadDotEnv(env = process.env, path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2];
  }
}
