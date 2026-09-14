// Report sanitization for publication (IMPLEMENTATION_PLAN task group 1.1, I3).
//
// WHY: Newman records the LIVE request into its JSON/HTML reports — including
// the `x-api-key` header that scripts/run-newman.js injects at run time, and
// the resolved `environment.values`. docs/secrets-management.md section 5
// predicted exactly this ("scrub auth headers before CI uploads it"), but CI
// uploaded the raw reports verbatim. Confirmed against a real local report: a
// non-empty x-api-key header and an `api_key` environment value were both
// retained.
//
// DESIGN: build the published view from an explicit ALLOWLIST. A denylist would
// silently leak any field a future Newman version adds. Nothing reaches the
// published view unless it is named here.
//
// The published view carries collection/request identity, counts, statuses,
// timings, and sanitized error summaries. It deliberately omits request and
// response BODIES, environment/global values, collection variables, cookies,
// auth objects, URL userinfo, and all raw header values.
//
// NOTE: this sanitizes what gets PUBLISHED. Local raw reports under reports/
// remain secret-bearing by design — they are gitignored and never uploaded.

/** Header names whose values are secret-bearing wherever they appear. */
const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'x-session-token',
]);

/** Query/variable names that carry credentials. */
const SECRET_PARAM_RE =
  /^(api[-_]?key|access[-_]?token|auth|authorization|token|secret|password|passwd|pwd|session|sig|signature|credential)s?$/i;

export const REDACTED = '[REDACTED]';

/**
 * Every encoded form a secret can take in a report. A raw value may appear
 * JSON-escaped, URL-encoded, or HTML-escaped depending on which reporter wrote
 * it, so redaction must cover all of them (task 1.1 requires testing each).
 */
function encodedForms(secret) {
  const forms = new Set();
  const add = (s) => {
    if (s && String(s).length >= 4) forms.add(String(s));
  };
  add(secret);
  try {
    add(encodeURIComponent(secret));
    add(encodeURI(secret));
  } catch {
    // Non-encodable input: the raw form below is still covered.
  }
  // JSON escaping (drop the surrounding quotes).
  add(JSON.stringify(String(secret)).slice(1, -1));
  // HTML escaping, as the htmlextra reporter would write it.
  add(
    String(secret)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  );
  // Base64, as used by Basic auth.
  try {
    add(Buffer.from(String(secret), 'utf8').toString('base64'));
  } catch {
    // Ignore: the raw form is still covered.
  }
  return [...forms];
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redact known secret values (in every encoded form) from a text field.
 * `secrets` are the literal values the runner injected for this execution.
 */
export function redactText(text, secrets = []) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const secret of secrets) {
    // Very short values would match everywhere; refuse rather than mangle.
    if (!secret || String(secret).length < 4) continue;
    for (const form of encodedForms(secret)) {
      out = out.replace(new RegExp(escapeRe(form), 'g'), REDACTED);
    }
  }
  return out;
}

/**
 * Strip credentials from a URL: userinfo (user:pass@) and secret-bearing query
 * parameters. Returns a string safe for the published view.
 */
export function sanitizeUrl(rawUrl, secrets = []) {
  if (!rawUrl) return '';
  const asString =
    typeof rawUrl === 'string'
      ? rawUrl
      : [
          // Newman stores url as an object.
          rawUrl.protocol ? `${rawUrl.protocol}://` : '',
          Array.isArray(rawUrl.host)
            ? rawUrl.host.join('.')
            : rawUrl.host || '',
          rawUrl.port ? `:${rawUrl.port}` : '',
          Array.isArray(rawUrl.path)
            ? `/${rawUrl.path.join('/')}`
            : rawUrl.path || '',
        ].join('');
  let url;
  try {
    url = new URL(asString);
  } catch {
    // Not an absolute URL: redact known secrets rather than leak the raw text.
    return redactText(asString, secrets);
  }
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_PARAM_RE.test(key)) url.searchParams.set(key, REDACTED);
  }
  return redactText(url.toString(), secrets);
}

/**
 * Header NAMES only, never values — a reviewer can see that an auth header was
 * sent without the published file carrying the credential.
 */
export function summarizeHeaderNames(headers) {
  if (!Array.isArray(headers)) return [];
  return headers
    .map((h) => String((h && h.key) || '').toLowerCase())
    .filter(Boolean)
    .map((name) => (SECRET_HEADERS.has(name) ? `${name} (redacted)` : name))
    .sort();
}

/**
 * Build the published view of a Newman run. ALLOWLIST ONLY.
 *
 * @param {object} report parsed Newman JSON report
 * @param {object} [opts]
 * @param {string[]} [opts.secrets] literal secret values injected this run
 * @param {string} [opts.collectionId] identity recorded alongside the result
 * @returns {object} a view safe to publish
 */
export function buildPublishedNewmanView(report, opts = {}) {
  const secrets = opts.secrets || [];
  const run = (report && report.run) || {};
  const stats = run.stats || {};

  const count = (node) => ({
    total: (node && node.total) || 0,
    pending: (node && node.pending) || 0,
    failed: (node && node.failed) || 0,
  });

  const executions = (run.executions || []).map((e) => ({
    // Identity only — never item.request.body or response.stream.
    name: redactText((e && e.item && e.item.name) || '', secrets),
    method: (e && e.request && e.request.method) || '',
    url: sanitizeUrl(e && e.request && e.request.url, secrets),
    request_header_names: summarizeHeaderNames(
      e && e.request && e.request.header
    ),
    response_header_names: summarizeHeaderNames(
      e && e.response && e.response.header
    ),
    status: (e && e.response && e.response.status) ?? null,
    code: (e && e.response && e.response.code) ?? null,
    response_time_ms: (e && e.response && e.response.responseTime) ?? null,
    response_size_bytes: (e && e.response && e.response.responseSize) ?? null,
    assertions: ((e && e.assertions) || []).map((a) => ({
      assertion: redactText((a && a.assertion) || '', secrets),
      skipped: Boolean(a && a.skipped),
      failed: Boolean(a && a.error),
      error_message:
        a && a.error
          ? redactText(String(a.error.message || ''), secrets)
          : null,
    })),
  }));

  const failures = (run.failures || []).map((f) => ({
    name: redactText((f && f.source && f.source.name) || '', secrets),
    assertion: redactText((f && f.error && f.error.test) || '', secrets),
    message: redactText(
      String((f && f.error && f.error.message) || ''),
      secrets
    ),
  }));

  return {
    schema_version: '1.0',
    kind: 'newman-published-summary',
    collection_id: opts.collectionId || null,
    collection_name: redactText(
      (report &&
        report.collection &&
        report.collection.info &&
        report.collection.info.name) ||
        '',
      secrets
    ),
    generated_at: new Date().toISOString(),
    stats: {
      requests: count(stats.requests),
      assertions: count(stats.assertions),
      test_scripts: count(stats.testScripts),
    },
    timings: {
      started: (run.timings && run.timings.started) ?? null,
      completed: (run.timings && run.timings.completed) ?? null,
      response_average_ms: (run.timings && run.timings.responseAverage) ?? null,
    },
    // Run-level transport error, sanitized. Never the raw exception object.
    run_error: run.error
      ? redactText(String(run.error.message || ''), secrets)
      : null,
    executions,
    failures,
  };
}

/**
 * Assert a value contains no secret in any encoded form. Call this before
 * writing a published file: if it throws, nothing is published for that
 * execution (task 1.1 — a sanitizer failure must prevent publication).
 */
export function assertNoSecrets(value, secrets = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) {
    if (!secret || String(secret).length < 4) continue;
    for (const form of encodedForms(secret)) {
      if (text.includes(form)) {
        // Never include the secret itself in the error message.
        throw new Error(
          `Refusing to publish: output still contains an injected secret (length ${String(secret).length}).`
        );
      }
    }
  }
  return true;
}
