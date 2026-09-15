// Regression tests for published-report sanitization (task group 1.1, I3).
//
// The leak these guard against is real: Newman writes the live x-api-key header
// and resolved environment values into its reports, and CI uploaded those raw.
// Every test here uses a SYNTHETIC marker — never a real credential.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPublishedNewmanView,
  redactText,
  sanitizeUrl,
  summarizeHeaderNames,
  assertNoSecrets,
  REDACTED,
} from '../scripts/lib/report-sanitization.js';

// Long and distinctive so a match cannot be coincidental.
const SECRET = 'SYNTHETIC-SECRET-a1b2c3d4e5f6-DO-NOT-SHIP';
const SECRETS = [SECRET];

/** A Newman-shaped report carrying the marker in every place Newman puts it. */
function reportWithSecret() {
  return {
    collection: { info: { name: 'Demo collection' } },
    environment: {
      values: [
        { key: 'base_url', value: 'https://example.test' },
        { key: 'api_key', value: SECRET },
      ],
    },
    globals: { values: [{ key: 'g_token', value: SECRET }] },
    run: {
      stats: {
        requests: { total: 1, pending: 0, failed: 0 },
        assertions: { total: 2, pending: 0, failed: 1 },
        testScripts: { total: 1, pending: 0, failed: 0 },
      },
      timings: { started: 1, completed: 2, responseAverage: 12 },
      executions: [
        {
          item: { name: 'GET user' },
          request: {
            method: 'GET',
            url: `https://user:${SECRET}@example.test/api?api_key=${SECRET}&page=2`,
            header: [
              { key: 'x-api-key', value: SECRET },
              { key: 'Authorization', value: `Bearer ${SECRET}` },
              { key: 'Accept', value: 'application/json' },
            ],
            body: { raw: `{"password":"${SECRET}"}` },
          },
          response: {
            status: 'OK',
            code: 200,
            responseTime: 12,
            responseSize: 34,
            header: [{ key: 'Set-Cookie', value: `session=${SECRET}` }],
            stream: { type: 'Buffer', data: [1, 2, 3] },
            cookie: [{ name: 'session', value: SECRET }],
          },
          assertions: [
            { assertion: 'status is 200', skipped: false },
            {
              assertion: 'body matches',
              error: { message: `expected ${SECRET} to equal x` },
            },
          ],
        },
      ],
      failures: [
        {
          source: { name: 'GET user' },
          error: { test: 'body matches', message: `got ${SECRET}` },
        },
      ],
      error: { message: `connect failed using key ${SECRET}` },
    },
  };
}

test('published view omits the secret in every location Newman records it', () => {
  const view = buildPublishedNewmanView(reportWithSecret(), {
    secrets: SECRETS,
    collectionId: 'demo',
  });
  const out = JSON.stringify(view);
  assert.ok(
    !out.includes(SECRET),
    'published view must not contain the secret'
  );
  // And the guard agrees.
  assert.doesNotThrow(() => assertNoSecrets(view, SECRETS));
});

test('published view excludes bodies, cookies, env values and raw headers', () => {
  const out = JSON.stringify(
    buildPublishedNewmanView(reportWithSecret(), { secrets: SECRETS })
  );
  // Structural exclusions: these keys must not survive into the view at all.
  for (const forbidden of [
    '"body"',
    '"stream"',
    '"cookie"',
    '"environment"',
    '"globals"',
  ]) {
    assert.ok(
      !out.includes(forbidden),
      `published view must not include ${forbidden}`
    );
  }
});

test('published view keeps the identity and counts a reviewer needs', () => {
  const view = buildPublishedNewmanView(reportWithSecret(), {
    secrets: SECRETS,
    collectionId: 'demo',
  });
  assert.equal(view.collection_id, 'demo');
  assert.equal(view.collection_name, 'Demo collection');
  assert.equal(view.stats.assertions.total, 2);
  assert.equal(view.stats.assertions.failed, 1);
  assert.equal(view.executions[0].method, 'GET');
  assert.equal(view.executions[0].code, 200);
  assert.equal(view.failures.length, 1);
});

test('auth header names are visible but marked redacted, values never appear', () => {
  const names = summarizeHeaderNames([
    { key: 'X-API-Key', value: SECRET },
    { key: 'Accept', value: 'application/json' },
  ]);
  assert.ok(names.includes('x-api-key (redacted)'));
  assert.ok(names.includes('accept'));
  assert.ok(!JSON.stringify(names).includes(SECRET));
});

test('redaction covers URL-encoded, JSON-escaped and HTML-escaped forms', () => {
  // The reporters write the same value differently; each form must be caught.
  const urlEncoded = encodeURIComponent(SECRET);
  const jsonEscaped = JSON.stringify(SECRET).slice(1, -1);
  const htmlEscaped = SECRET.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  for (const [label, form] of [
    ['raw', SECRET],
    ['url-encoded', urlEncoded],
    ['json-escaped', jsonEscaped],
    ['html-escaped', htmlEscaped],
  ]) {
    const cleaned = redactText(`prefix ${form} suffix`, SECRETS);
    assert.ok(!cleaned.includes(SECRET), `${label} form must be redacted`);
    assert.match(cleaned, new RegExp(REDACTED.replace(/[[\]]/g, '\\$&')));
  }
});

test('a secret containing regex metacharacters is redacted literally', () => {
  const tricky = 'abc.*+?[](){}|^$secret';
  const cleaned = redactText(`value=${tricky} end`, [tricky]);
  assert.ok(!cleaned.includes(tricky));
});

test('URL sanitization strips userinfo and secret query parameters', () => {
  const cleaned = sanitizeUrl(
    `https://user:${SECRET}@example.test/api?api_key=${SECRET}&page=2`,
    SECRETS
  );
  assert.ok(!cleaned.includes(SECRET), cleaned);
  assert.ok(!cleaned.includes('user:'), cleaned);
  assert.match(cleaned, /page=2/); // non-secret params survive
});

test('URL sanitization handles the object form Newman actually stores', () => {
  const cleaned = sanitizeUrl(
    {
      protocol: 'https',
      host: ['example', 'test'],
      path: ['api', 'users'],
    },
    SECRETS
  );
  assert.equal(cleaned, 'https://example.test/api/users');
});

test('assertNoSecrets throws, without echoing the secret, when one survives', () => {
  let threw = null;
  try {
    assertNoSecrets({ leaked: SECRET }, SECRETS);
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'must throw when a secret survives');
  assert.ok(
    !threw.message.includes(SECRET),
    'the error must not echo the secret'
  );
  assert.match(threw.message, /Refusing to publish/);
});

test('very short secrets are not used for redaction (would mangle everything)', () => {
  const text = 'a perfectly ordinary sentence';
  assert.equal(redactText(text, ['a']), text);
});

test('an empty or error-only run produces a valid view, not a crash', () => {
  const view = buildPublishedNewmanView(
    { run: { error: { message: `boom ${SECRET}` } } },
    { secrets: SECRETS }
  );
  assert.equal(view.executions.length, 0);
  assert.ok(!JSON.stringify(view).includes(SECRET));
  assert.match(view.run_error, /boom/);
});
