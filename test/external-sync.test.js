// Recoverable external synchronization (task group 5.1, review finding I2).
//
// Every scenario runs the real adapter scripts against in-process fake Jira
// and TestLink servers in a throwaway workspace. No real service is ever
// contacted: each run gets explicit localhost endpoints and blank inherited
// credentials.
//
// Acceptance (IMPLEMENTATION_PLAN 5.1): no acknowledged remote identity
// disappears after a later failure; uncertain operations cannot duplicate
// silently; dry-run makes no remote writes or local progress mutations.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';

import { bindGate, runContext, validTestCases } from './helpers/valid-run.js';
import {
  classifyCreate,
  httpTimeoutMs,
  operationKey,
  operationMarker,
  describeSkip,
  planOperation,
  sanitizeDiagnostic,
} from '../scripts/lib/integration-io.js';

const REPO = process.cwd();
const STORY = 'SK-10';
const RUN = 'run-sync-1';
const TOKEN = 'jira-secret-token-9f8e7d';
const DEVKEY = 'testlink-devkey-5a4b3c';

// ------------------------------------------------------------ workspace

function workspace({ storyKey = 'SK-1' } = {}) {
  const dir = mkdtempSync(join(REPO, '.tmp-runner-sync-'));
  for (const d of ['scripts', 'schemas', 'config']) {
    cpSync(join(REPO, d), join(dir, d), { recursive: true });
  }
  const ctx = runContext({ storyId: STORY, runId: RUN, status: 'draft' });
  if (storyKey) ctx.story.jira_issue_key = storyKey;
  mkdirSync(join(dir, 'test-cases'));
  // Start unsynced: the gold example shows TC-001 already linked to Jira and
  // TestLink, which would make the adapters (correctly) skip it.
  const doc = validTestCases(STORY, RUN);
  for (const tc of doc.test_cases) {
    delete tc.external_ids;
    delete tc.testlink_id;
  }
  writeFileSync(
    join(dir, 'test-cases', `${STORY}.json`),
    JSON.stringify(doc, null, 2)
  );
  writeFileSync(
    join(dir, 'context.json'),
    JSON.stringify(bindGate(ctx, 'test_scope_reviewed', dir), null, 2)
  );
  return dir;
}

const casesFile = (dir) => join(dir, 'test-cases', `${STORY}.json`);
const readCases = (dir) => JSON.parse(readFileSync(casesFile(dir), 'utf8'));
const caseOf = (dir, id) =>
  readCases(dir).test_cases.find((c) => c.test_case_id === id);
const writeCases = (dir, doc) =>
  writeFileSync(casesFile(dir), JSON.stringify(doc, null, 2));

/** Run a script asynchronously, so the in-process fake server can answer. */
function runCli(dir, script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(execPath, [join('scripts', script), ...args], {
      cwd: dir,
      env: {
        ...process.env,
        TEST_MANAGEMENT_TOOL: '',
        JIRA_URL: '',
        JIRA_USERNAME: '',
        JIRA_API_TOKEN: '',
        JIRA_PROJECT_KEY: '',
        TESTLINK_URL: '',
        TESTLINK_API_KEY: '',
        TESTLINK_PROJECT_KEY: '',
        QAIZEN_HTTP_TIMEOUT_MS: '3000',
        ...env,
      },
    });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(url);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

// ------------------------------------------------------------ fake Jira

/**
 * A fake Jira. `script.create` is a queue of behaviours for successive
 * creates ('ok' when empty); `script.link` likewise for issue links.
 */
function fakeJira(project = 'SK') {
  const state = {
    issues: [],
    requests: [],
    script: { create: [], link: [] },
    onCreate: null,
  };
  const handler = async (req, res) => {
    const body = await readBody(req);
    const path = req.url.split('?')[0];
    state.requests.push({ method: req.method, path });
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof value === 'string' ? value : JSON.stringify(value));
    };
    if (req.method === 'POST' && path === '/rest/api/3/issue') {
      const how = state.script.create.shift() ?? 'ok';
      if (how === 'reject') return json(400, { errorMessages: ['boom'] });
      const fields = JSON.parse(body).fields;
      const key = `${project}-${100 + state.issues.length + 1}`;
      state.issues.push({ key, labels: fields.labels ?? [], fields });
      if (state.onCreate) await state.onCreate(key);
      if (how === 'drop') return req.socket.destroy();
      if (how === 'malformed') return json(201, 'this is not json');
      return json(201, { id: '1', key });
    }
    if (req.method === 'POST' && path === '/rest/api/3/issueLink') {
      const how = state.script.link.shift() ?? 'ok';
      if (how === 'fail') return json(500, { errorMessages: ['link down'] });
      return json(201, '');
    }
    if (req.method === 'GET' && path === '/rest/api/3/search/jql') {
      const jql = new URL(req.url, 'http://x').searchParams.get('jql');
      const label = jql.match(/labels = "([^"]+)"/)[1];
      const issues = state.issues
        .filter((i) => i.labels.includes(label))
        .map((i) => ({ key: i.key }));
      return json(200, { issues });
    }
    json(404, { errorMessages: ['not found'] });
  };
  return { state, handler };
}

const creates = (s) =>
  s.requests.filter(
    (r) => r.method === 'POST' && r.path === '/rest/api/3/issue'
  ).length;
const links = (s) =>
  s.requests.filter((r) => r.path === '/rest/api/3/issueLink').length;

const jiraEnv = (url) => ({
  TEST_MANAGEMENT_TOOL: 'jira',
  JIRA_URL: url,
  JIRA_USERNAME: 'qa@example.test',
  JIRA_API_TOKEN: TOKEN,
  JIRA_PROJECT_KEY: 'SK',
});

// ------------------------------------------------------------ pure decisions

test('create outcomes: only a known id is "created"; only a definite refusal is "rejected"', () => {
  const parse = (t) =>
    t === 'OK' ? { id: 'X-1' } : t === 'NO' ? { rejected: 'fault' } : null;
  const res = (status, text) => ({
    kind: 'response',
    status,
    ok: status < 300,
    text,
  });
  const cases = [
    [res(201, 'OK'), 'created'],
    [res(200, 'NO'), 'rejected'],
    [res(400, 'bad'), 'rejected'],
    [{ kind: 'not_sent', error: 'not sent (ECONNREFUSED)' }, 'rejected'],
    [res(201, '???'), 'ambiguous'],
    [res(502, 'gateway'), 'ambiguous'],
    [res(302, ''), 'ambiguous'],
    [{ kind: 'ambiguous', error: 'timed out' }, 'ambiguous'],
  ];
  for (const [result, expected] of cases) {
    assert.equal(
      classifyCreate(result, parse).outcome,
      expected,
      JSON.stringify(result)
    );
  }
});

test('diagnostics never carry credentials and stay short', () => {
  const text =
    `Authorization: Basic dXNlcjpwYXNz token=${TOKEN} ` +
    `<name>devKey</name><value><string>${DEVKEY}</string></value> ` +
    'x'.repeat(1000);
  const out = sanitizeDiagnostic(text, [TOKEN]);
  assert.ok(!out.includes(TOKEN));
  assert.ok(!out.includes(DEVKEY));
  assert.ok(!out.includes('dXNlcjpwYXNz'));
  assert.ok(out.length <= 303);
});

test('planning: pending reconciles, a trusted id skips, a bad id blocks, a failed link is retried, anything else creates', () => {
  const rec = (state, extra = {}) => ({ state, ...extra });
  const isValidId = (id) => /^[A-Z]+-[0-9]+$/.test(id);
  const plan = (record, remoteIds, linkWanted = false) =>
    planOperation({ record, remoteIds, isValidId, linkWanted });

  assert.equal(plan(rec('pending'), []).action, 'reconcile');
  assert.equal(plan(rec('pending'), ['SK-1']).action, 'reconcile');
  assert.deepEqual(plan(undefined, ['SK-1']), { action: 'skip', id: 'SK-1' });
  assert.equal(plan(undefined, ['SK-1', 'SK-1']).action, 'skip');
  const linked = rec('created', { remote_id: 'SK-1', link_state: 'failed' });
  assert.equal(plan(linked, ['SK-1'], true).action, 'link');
  assert.equal(plan(linked, ['SK-1']).action, 'skip');
  assert.equal(
    plan(
      rec('created', { remote_id: 'SK-1', link_state: 'linked' }),
      ['SK-1'],
      true
    ).action,
    'skip'
  );
  // Never create an item whose recorded id cannot be trusted.
  assert.match(plan(undefined, ['not-a-key']).reason, /not a valid id/);
  assert.match(
    plan(undefined, ['SK-1', 'SK-2']).reason,
    /conflicting remote ids SK-1 and SK-2/
  );
  assert.match(
    plan(rec('created', { remote_id: 'SK-9' }), ['SK-1']).reason,
    /record says SK-9/
  );
  assert.match(
    plan(rec('created', { remote_id: 'SK-9' }), []).reason,
    /carries no id/
  );
  for (const bad of [['x'], ['SK-1', 'SK-2']]) {
    assert.equal(plan(undefined, bad).action, 'blocked');
  }
  // Empty strings are how unsynced cases leave the field.
  assert.equal(plan(undefined, ['', undefined, null]).action, 'create');
  assert.equal(plan(rec('failed'), []).action, 'create');
  assert.equal(plan(rec('not_found'), []).action, 'create');
});

test('a skipped item says whether it changed locally, and that it is never updated', () => {
  assert.equal(
    describeSkip(undefined, 'a'.repeat(64), 'Jira'),
    'already there'
  );
  assert.equal(
    describeSkip({ source_digest: 'a'.repeat(64) }, 'a'.repeat(64), 'Jira'),
    'already there'
  );
  assert.match(
    describeSkip({ source_digest: 'a'.repeat(64) }, 'b'.repeat(64), 'Jira'),
    /changed locally since it was pushed; Jira is NOT updated/
  );
});

test('operation identity is stable and the timeout is bounded', () => {
  const parts = {
    target: 'jira',
    project: 'SK',
    storyId: 'SK-10',
    localId: 'TC-001',
    kind: 'create_case',
  };
  assert.equal(operationKey(parts), 'jira:SK:SK-10:TC-001:create_case');
  assert.equal(
    operationMarker(operationKey(parts)),
    operationMarker(operationKey({ ...parts }))
  );
  assert.match(
    operationMarker(operationKey(parts)),
    /^qaizen-op-[0-9a-f]{12}$/
  );
  assert.throws(
    () => operationKey({ ...parts, project: '' }),
    /project is required/
  );
  assert.equal(httpTimeoutMs({}), 30000);
  assert.equal(httpTimeoutMs({ QAIZEN_HTTP_TIMEOUT_MS: '1500' }), 1500);
  for (const bad of ['0', '-1', 'soon', '999999']) {
    assert.throws(
      () => httpTimeoutMs({ QAIZEN_HTTP_TIMEOUT_MS: bad }),
      /QAIZEN_HTTP_TIMEOUT_MS/
    );
  }
});

// ------------------------------------------------------------ Jira test cases

test('dry-run sends nothing and changes nothing, even with a pending operation', async () => {
  const dir = workspace();
  try {
    const doc = readCases(dir);
    doc.test_cases[0].sync_state = {
      jira: {
        operation_key: 'jira:SK:SK-10:TC-001:create_case',
        marker: 'qaizen-op-0123456789ab',
        state: 'pending',
        intent_at: '2026-09-27T00:00:00Z',
      },
    };
    writeCases(dir, doc);
    const before = readFileSync(casesFile(dir), 'utf8');
    const jira = fakeJira();
    await withServer(jira.handler, async (url) => {
      const r = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY],
        jiraEnv(url)
      );
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /DRY RUN/);
      assert.match(r.out, /TC-001 .* RECONCILE FIRST/);
    });
    assert.equal(jira.state.requests.length, 0);
    assert.equal(readFileSync(casesFile(dir), 'utf8'), before);
    assert.equal(existsSync(join(dir, '.qaizen')), false, 'no lock taken');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('first create succeeds, second is rejected: the first key survives and is never recreated', async () => {
  const dir = workspace();
  try {
    const jira = fakeJira();
    jira.state.script.create = ['ok', 'reject'];
    await withServer(jira.handler, async (url) => {
      const r1 = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--apply'],
        jiraEnv(url)
      );
      assert.equal(r1.code, 1, r1.out);
      assert.match(r1.out, /rejected the create/);
      assert.ok(!r1.out.includes(TOKEN), 'token never printed');

      const tc1 = caseOf(dir, 'TC-001');
      assert.equal(tc1.external_ids.jira, 'SK-101');
      assert.equal(tc1.sync_state.jira.state, 'created');
      assert.equal(tc1.sync_state.jira.link_state, 'linked');
      const tc2 = caseOf(dir, 'TC-002');
      assert.equal(tc2.external_ids, undefined);
      assert.equal(tc2.sync_state.jira.state, 'failed');
      assert.match(tc2.sync_state.jira.last_error, /HTTP 400/);

      const r2 = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--apply'],
        jiraEnv(url)
      );
      assert.equal(r2.code, 0, r2.out);
    });
    assert.equal(creates(jira.state), 4, '1 ok + 1 rejected + 2 on the rerun');
    const keys = readCases(dir).test_cases.map((c) => c.external_ids?.jira);
    assert.deepEqual(keys, ['SK-101', 'SK-102', 'SK-103']);
    assert.equal(jira.state.issues.length, 3, 'exactly one issue per case');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed story link keeps the key; the next run retries only the link', async () => {
  const dir = workspace();
  try {
    const jira = fakeJira();
    jira.state.script.link = ['fail'];
    await withServer(jira.handler, async (url) => {
      const r1 = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--apply'],
        jiraEnv(url)
      );
      assert.equal(r1.code, 0, r1.out);
      assert.match(r1.out, /link\(s\) failed/);
      const tc1 = caseOf(dir, 'TC-001');
      assert.equal(tc1.external_ids.jira, 'SK-101');
      assert.equal(tc1.sync_state.jira.link_state, 'failed');

      const createsBefore = creates(jira.state);
      const linksBefore = links(jira.state);
      const r2 = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--apply'],
        jiraEnv(url)
      );
      assert.equal(r2.code, 0, r2.out);
      assert.equal(creates(jira.state), createsBefore, 'nothing recreated');
      assert.equal(links(jira.state), linksBefore + 1, 'one link retried');
    });
    assert.equal(caseOf(dir, 'TC-001').sync_state.jira.link_state, 'linked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('remote success with a lost response: pending blocks creates until --reconcile finds it', async () => {
  const dir = workspace();
  try {
    const jira = fakeJira();
    jira.state.script.create = ['ok', 'drop'];
    await withServer(jira.handler, async (url) => {
      const r1 = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--apply'],
        jiraEnv(url)
      );
      assert.equal(r1.code, 1, r1.out);
      assert.match(r1.out, /outcome of the create is unknown/);
      assert.match(r1.out, /--reconcile/);
      assert.equal(caseOf(dir, 'TC-002').sync_state.jira.state, 'pending');
      assert.equal(
        caseOf(dir, 'TC-004').sync_state,
        undefined,
        'batch stopped'
      );

      const blocked = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--apply'],
        jiraEnv(url)
      );
      assert.equal(blocked.code, 1, blocked.out);
      assert.match(blocked.out, /Refusing to create/);
      assert.equal(creates(jira.state), 2, 'no create while pending');

      const rec = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--reconcile'],
        jiraEnv(url)
      );
      assert.equal(rec.code, 0, rec.out);
      assert.match(rec.out, /found SK-102/);
      const tc2 = caseOf(dir, 'TC-002');
      assert.equal(tc2.external_ids.jira, 'SK-102');
      assert.equal(tc2.sync_state.jira.state, 'created');
      assert.ok(tc2.sync_state.jira.reconciled_at);

      const r2 = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--apply'],
        jiraEnv(url)
      );
      assert.equal(r2.code, 0, r2.out);
    });
    assert.equal(
      jira.state.issues.length,
      3,
      'no duplicate for the lost response'
    );
    assert.equal(caseOf(dir, 'TC-004').external_ids.jira, 'SK-103');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed success response is treated as unknown, not as success or failure', async () => {
  const dir = workspace({ storyKey: null });
  try {
    const jira = fakeJira();
    jira.state.script.create = ['malformed'];
    await withServer(jira.handler, async (url) => {
      const r1 = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--apply'],
        jiraEnv(url)
      );
      assert.equal(r1.code, 1, r1.out);
      assert.match(r1.out, /no usable id/);
      assert.equal(caseOf(dir, 'TC-001').sync_state.jira.state, 'pending');
      const rec = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--reconcile'],
        jiraEnv(url)
      );
      assert.equal(rec.code, 0, rec.out);
    });
    assert.equal(caseOf(dir, 'TC-001').external_ids.jira, 'SK-101');
    assert.equal(
      caseOf(dir, 'TC-001').sync_state.jira.link_state,
      'not_applicable'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pending operation that never reached Jira is reconciled to not_found and then created once', async () => {
  const dir = workspace({ storyKey: null });
  try {
    const key = operationKey({
      target: 'jira',
      project: 'SK',
      storyId: STORY,
      localId: 'TC-001',
      kind: 'create_case',
    });
    const doc = readCases(dir);
    doc.test_cases[0].sync_state = {
      jira: {
        operation_key: key,
        marker: operationMarker(key),
        state: 'pending',
        intent_at: '2026-09-27T00:00:00Z',
      },
    };
    writeCases(dir, doc);
    const jira = fakeJira();
    await withServer(jira.handler, async (url) => {
      const rec = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--reconcile'],
        jiraEnv(url)
      );
      assert.equal(rec.code, 0, rec.out);
      assert.match(rec.out, /not in Jira/);
      assert.equal(caseOf(dir, 'TC-001').sync_state.jira.state, 'not_found');
      assert.equal(creates(jira.state), 0, 'reconcile only reads');
      const r = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--apply'],
        jiraEnv(url)
      );
      assert.equal(r.code, 0, r.out);
    });
    assert.equal(jira.state.issues.length, 3);
    assert.equal(caseOf(dir, 'TC-001').sync_state.jira.state, 'created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('remote success followed by a local save failure: the key is printed, nothing else is created, --resolve records it', async () => {
  const dir = workspace({ storyKey: null });
  const moved = join(dir, 'test-cases.moved');
  try {
    const jira = fakeJira();
    // Once Jira has created the issue, make the test-cases folder unwritable
    // by replacing it with a plain file.
    jira.state.onCreate = async () => {
      jira.state.onCreate = null;
      renameSync(join(dir, 'test-cases'), moved);
      writeFileSync(join(dir, 'test-cases'), 'not a directory');
    };
    await withServer(jira.handler, async (url) => {
      const r1 = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--apply'],
        jiraEnv(url)
      );
      assert.equal(r1.code, 1, r1.out);
      assert.match(r1.out, /CRITICAL: Jira created SK-101 for TC-001/);
      assert.match(r1.out, /--resolve TC-001=SK-101/);
      assert.equal(creates(jira.state), 1, 'stopped after the unsaved create');

      rmSync(join(dir, 'test-cases'));
      renameSync(moved, join(dir, 'test-cases'));
      assert.equal(caseOf(dir, 'TC-001').sync_state.jira.state, 'pending');

      const res = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--resolve', 'TC-001=SK-101'],
        jiraEnv(url)
      );
      assert.equal(res.code, 0, res.out);
      assert.equal(caseOf(dir, 'TC-001').external_ids.jira, 'SK-101');

      const r2 = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--apply'],
        jiraEnv(url)
      );
      assert.equal(r2.code, 0, r2.out);
    });
    assert.equal(jira.state.issues.length, 3, 'TC-001 was not created twice');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second sync refuses while the first is running', async () => {
  const dir = workspace({ storyKey: null });
  try {
    const jira = fakeJira();
    let firstSeen;
    const seen = new Promise((r) => (firstSeen = r));
    let releaseFirst;
    const hold = new Promise((r) => (releaseFirst = r));
    jira.state.onCreate = async () => {
      jira.state.onCreate = null;
      firstSeen();
      await hold;
    };
    await withServer(jira.handler, async (url) => {
      const first = runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--apply'],
        jiraEnv(url)
      );
      await seen;
      const second = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--apply'],
        jiraEnv(url)
      );
      releaseFirst();
      assert.equal(second.code, 1, second.out);
      assert.match(second.out, /another jira sync is running/);
      const done = await first;
      assert.equal(done.code, 0, done.out);
    });
    assert.equal(jira.state.issues.length, 3, 'only the first sync created');
    assert.equal(existsSync(join(dir, '.qaizen', 'locks', 'jira.lock')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale lock needs --release-stale-lock; a live one is never taken over', async () => {
  const dir = workspace({ storyKey: null });
  try {
    const lockPath = join(dir, '.qaizen', 'locks', 'jira.lock');
    mkdirSync(join(dir, '.qaizen', 'locks'), { recursive: true });
    const jira = fakeJira();
    await withServer(jira.handler, async (url) => {
      // Live holder: this test process.
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, host: hostname(), started_at: 'x' })
      );
      const live = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--apply', '--release-stale-lock'],
        jiraEnv(url)
      );
      assert.equal(live.code, 1, live.out);
      assert.match(live.out, /another jira sync is running/);

      // Dead holder: a process that has already exited.
      const gone = spawnSync(execPath, ['-e', '']).pid;
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: gone, host: hostname(), started_at: 'x' })
      );
      const stale = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--apply'],
        jiraEnv(url)
      );
      assert.equal(stale.code, 1, stale.out);
      assert.match(stale.out, /--release-stale-lock/);
      assert.equal(jira.state.requests.length, 0);

      const taken = await runCli(
        dir,
        'create-jira-testcases.js',
        [STORY, '--apply', '--release-stale-lock'],
        jiraEnv(url)
      );
      assert.equal(taken.code, 0, taken.out);
    });
    assert.equal(jira.state.issues.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope checks run before any request: wrong story, wrong run, stale approval', async () => {
  const jira = fakeJira();
  await withServer(jira.handler, async (url) => {
    const cases = [
      [
        (dir) => {
          const doc = readCases(dir);
          doc.run_id = 'some-other-run';
          writeCases(dir, doc);
        },
        /belong to run some-other-run/,
      ],
      [
        (dir) => {
          const p = join(dir, 'context.json');
          const ctx = JSON.parse(readFileSync(p, 'utf8'));
          ctx.story.id = 'SK-99';
          writeFileSync(p, JSON.stringify(ctx));
        },
        /context\.json is for story SK-99/,
      ],
      [
        (dir) => {
          const doc = readCases(dir);
          doc.test_cases[0].expected_results = ['something else entirely'];
          writeCases(dir, doc);
        },
        /test_scope_reviewed is stale/,
      ],
    ];
    for (const [breakIt, message] of cases) {
      const dir = workspace();
      try {
        breakIt(dir);
        const r = await runCli(
          dir,
          'create-jira-testcases.js',
          [STORY, '--apply'],
          jiraEnv(url)
        );
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, message);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  assert.equal(jira.state.requests.length, 0);
});

test('TEST_MANAGEMENT_TOOL must select the adapter; bad arguments are usage errors', async () => {
  const dir = workspace();
  try {
    const cases = [
      [
        'sync-to-testlink.js',
        [STORY],
        { TEST_MANAGEMENT_TOOL: 'jira' },
        /does not select the testlink adapter/,
      ],
      [
        'sync-to-testlink.js',
        [STORY],
        { TEST_MANAGEMENT_TOOL: 'testlnik' },
        /not a known value/,
      ],
      ['sync-to-testlink.js', [STORY], {}, /TEST_MANAGEMENT_TOOL is unset/],
      [
        'create-jira-testcases.js',
        [STORY],
        { TEST_MANAGEMENT_TOOL: 'testlink' },
        /does not select the jira adapter/,
      ],
      [
        'create-jira-testcases.js',
        [STORY, '--apply', '--limit', 'two'],
        { TEST_MANAGEMENT_TOOL: 'jira' },
        /--limit expects a positive integer/,
      ],
      [
        'create-jira-testcases.js',
        [STORY, '--resolve', 'TC-001'],
        { TEST_MANAGEMENT_TOOL: 'jira' },
        /--resolve expects/,
      ],
    ];
    for (const [script, args, env, message] of cases) {
      const r = await runCli(dir, script, args, env);
      assert.equal(r.code, 2, `${script} ${args.join(' ')}: ${r.out}`);
      assert.match(r.out, message);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ fake TestLink

const xmlValue = (v) =>
  typeof v === 'number' ? `<int>${v}</int>` : `<string>${v}</string>`;
const xmlStruct = (obj) =>
  `<value><struct>${Object.entries(obj)
    .map(
      ([k, v]) =>
        `<member><name>${k}</name><value>${xmlValue(v)}</value></member>`
    )
    .join('')}</struct></value>`;
const xmlArray = (items) =>
  `<?xml version="1.0"?><methodResponse><params><param><value><array><data>${items
    .map(xmlStruct)
    .join('')}</data></array></value></param></params></methodResponse>`;
const xmlFault = (msg) =>
  `<?xml version="1.0"?><methodResponse><fault>${xmlStruct({ faultCode: 1, faultString: msg })}</fault></methodResponse>`;
const member = (body, name) =>
  (body.match(
    new RegExp(`<name>${name}</name><value><(?:string|int)>([^<]*)<`)
  ) || [])[1];

function fakeTestLink() {
  const state = { cases: [], suites: [], calls: [], script: { create: [] } };
  const handler = async (req, res) => {
    const body = await readBody(req);
    const method = body.match(/<methodName>([^<]+)<\/methodName>/)[1];
    state.calls.push(method);
    const reply = (xml) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(xml);
    };
    if (member(body, 'devKey') !== DEVKEY) return reply(xmlFault('bad devKey'));
    switch (method) {
      case 'tl.getProjects':
        return reply(xmlArray([{ id: '1', name: 'Qaizen', prefix: 'QZ' }]));
      case 'tl.getFirstLevelTestSuitesForTestProject':
        return reply(xmlArray(state.suites));
      case 'tl.createTestSuite': {
        const suite = { id: '10', name: member(body, 'testsuitename') };
        state.suites.push(suite);
        return reply(xmlArray([{ id: suite.id }]));
      }
      case 'tl.createTestCase': {
        const how = state.script.create.shift() ?? 'ok';
        if (how === 'fault') return reply(xmlFault('duplicate name'));
        const tc = {
          id: String(200 + state.cases.length + 1),
          name: member(body, 'testcasename'),
          summary: member(body, 'summary'),
        };
        state.cases.push(tc);
        if (how === 'drop') return req.socket.destroy();
        return reply(xmlArray([{ id: tc.id, status: '1' }]));
      }
      case 'tl.getTestCaseIDByName': {
        const hits = state.cases.filter(
          (c) => c.name === member(body, 'testcasename')
        );
        return reply(
          hits.length
            ? xmlArray(hits.map((c) => ({ id: c.id, name: c.name })))
            : xmlArray([{ code: 5030, message: 'Cannot find test case' }])
        );
      }
      case 'tl.getTestCase': {
        const tc = state.cases.find((c) => c.id === member(body, 'testcaseid'));
        return reply(xmlArray([{ id: tc.id, summary: tc.summary }]));
      }
      default:
        return reply(xmlFault(`unexpected ${method}`));
    }
  };
  return { state, handler };
}

const testlinkEnv = (url) => ({
  TEST_MANAGEMENT_TOOL: 'testlink',
  TESTLINK_URL: url,
  TESTLINK_API_KEY: DEVKEY,
  TESTLINK_PROJECT_KEY: 'QZ',
});
const tlCreates = (s) =>
  s.calls.filter((c) => c === 'tl.createTestCase').length;

test('TestLink: a failed create keeps earlier ids; the rerun creates only what is missing', async () => {
  const dir = workspace();
  try {
    const tl = fakeTestLink();
    tl.state.script.create = ['ok', 'fault'];
    await withServer(tl.handler, async (url) => {
      const r1 = await runCli(
        dir,
        'sync-to-testlink.js',
        [STORY, '--apply-testlink'],
        testlinkEnv(url)
      );
      assert.equal(r1.code, 1, r1.out);
      assert.ok(!r1.out.includes(DEVKEY), 'devKey never printed');
      assert.equal(caseOf(dir, 'TC-001').testlink_id, '201');
      assert.equal(caseOf(dir, 'TC-001').external_ids.testlink, '201');
      assert.equal(caseOf(dir, 'TC-002').sync_state.testlink.state, 'failed');

      const r2 = await runCli(
        dir,
        'sync-to-testlink.js',
        [STORY, '--apply-testlink'],
        testlinkEnv(url)
      );
      assert.equal(r2.code, 0, r2.out);
      assert.match(
        r2.out,
        /TC-001 .* SKIP \(in TestLink as 201; already there\)/
      );
    });
    assert.equal(tlCreates(tl.state), 4, '1 ok + 1 fault + 2 on the rerun');
    assert.equal(tl.state.cases.length, 3, 'exactly one TestLink case per TC');
    assert.equal(
      tl.state.suites.length,
      1,
      'the suite is reused, not recreated'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TestLink: a lost response is found again by name and marker, never recreated', async () => {
  const dir = workspace();
  try {
    const tl = fakeTestLink();
    tl.state.script.create = ['drop'];
    await withServer(tl.handler, async (url) => {
      const r1 = await runCli(
        dir,
        'sync-to-testlink.js',
        [STORY, '--apply-testlink'],
        testlinkEnv(url)
      );
      assert.equal(r1.code, 1, r1.out);
      assert.equal(caseOf(dir, 'TC-001').sync_state.testlink.state, 'pending');
      const blocked = await runCli(
        dir,
        'sync-to-testlink.js',
        [STORY, '--apply-testlink'],
        testlinkEnv(url)
      );
      assert.equal(blocked.code, 1, blocked.out);
      assert.equal(tlCreates(tl.state), 1);

      const rec = await runCli(
        dir,
        'sync-to-testlink.js',
        [STORY, '--reconcile'],
        testlinkEnv(url)
      );
      assert.equal(rec.code, 0, rec.out);
      assert.equal(caseOf(dir, 'TC-001').testlink_id, '201');

      const r2 = await runCli(
        dir,
        'sync-to-testlink.js',
        [STORY, '--apply-testlink'],
        testlinkEnv(url)
      );
      assert.equal(r2.code, 0, r2.out);
    });
    assert.equal(tl.state.cases.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ Jira bugs

function writeDraft(
  dir,
  { bugId = 'BUG-001', story = STORY, tc = 'TC-001' } = {}
) {
  const drafts = join(dir, 'release', 'bug-drafts');
  mkdirSync(drafts, { recursive: true });
  const md = [
    `# ${bugId}`,
    '',
    '## Summary',
    '',
    'The error copy is wrong on an invalid password.',
    '',
    '## Severity',
    '',
    'red',
    '',
    '## Linked Story',
    '',
    story,
    '',
    '## Linked Failure',
    '',
    'FAIL-001',
    '',
    '## Linked Risk',
    '',
    'RISK-001',
    '',
    '## Linked Test Case',
    '',
    tc,
    '',
    '## Steps to Reproduce',
    '',
    '1. Log in with a wrong password.',
    '',
    '## Expected Behavior',
    '',
    'Invalid credentials.',
    '',
    '## Actual Behavior',
    '',
    'Wrong password!',
    '',
    '## Environment',
    '',
    '- run_id: run-sync-1',
    '',
    '## Evidence',
    '',
    '- reports/results.json',
    '',
    '## Jira Issue Key',
    '',
    '[empty until promoted; populated by scripts/create-jira-bugs.js --apply]',
    '',
  ].join('\n');
  const path = join(drafts, `${bugId}.md`);
  writeFileSync(path, md);
  return path;
}

function syncStateOf(path) {
  const md = readFileSync(path, 'utf8');
  const m = md.match(/## Sync State\s*\n+```json\n([\s\S]*?)\n```/);
  return m ? JSON.parse(m[1]) : null;
}

test('bugs: the key and sync state are saved at once; a failed link is retried alone', async () => {
  const dir = workspace();
  try {
    const draft = writeDraft(dir);
    const jira = fakeJira();
    jira.state.script.link = ['fail'];
    await withServer(jira.handler, async (url) => {
      const dry = await runCli(dir, 'create-jira-bugs.js', [], jiraEnv(url));
      assert.equal(dry.code, 0, dry.out);
      assert.equal(jira.state.requests.length, 0);

      const r1 = await runCli(
        dir,
        'create-jira-bugs.js',
        ['--apply'],
        jiraEnv(url)
      );
      assert.equal(r1.code, 0, r1.out);
      const md = readFileSync(draft, 'utf8');
      assert.match(md, /## Jira Issue Key\n\nSK-101\n/);
      const sync = syncStateOf(draft);
      assert.equal(sync.jira.state, 'created');
      assert.equal(sync.jira.remote_id, 'SK-101');
      assert.equal(sync.jira.link_state, 'failed');
      assert.ok(!md.includes(TOKEN));

      const r2 = await runCli(
        dir,
        'create-jira-bugs.js',
        ['--apply'],
        jiraEnv(url)
      );
      assert.equal(r2.code, 0, r2.out);
    });
    assert.equal(creates(jira.state), 1, 'the bug was filed once');
    assert.equal(links(jira.state), 2, 'the failed link was retried');
    assert.equal(syncStateOf(draft).jira.link_state, 'linked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bugs: a lost response is reconciled by its marker label', async () => {
  const dir = workspace({ storyKey: null });
  try {
    const draft = writeDraft(dir);
    const jira = fakeJira();
    jira.state.script.create = ['drop'];
    await withServer(jira.handler, async (url) => {
      const r1 = await runCli(
        dir,
        'create-jira-bugs.js',
        ['--apply'],
        jiraEnv(url)
      );
      assert.equal(r1.code, 1, r1.out);
      assert.equal(syncStateOf(draft).jira.state, 'pending');
      const rec = await runCli(
        dir,
        'create-jira-bugs.js',
        ['--reconcile'],
        jiraEnv(url)
      );
      assert.equal(rec.code, 0, rec.out);
      const again = await runCli(
        dir,
        'create-jira-bugs.js',
        ['--apply'],
        jiraEnv(url)
      );
      assert.equal(again.code, 0, again.out);
    });
    assert.equal(jira.state.issues.length, 1);
    assert.match(readFileSync(draft, 'utf8'), /## Jira Issue Key\n\nSK-101\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bugs: a draft from another story or outside the approved scope is refused before any request', async () => {
  const jira = fakeJira();
  await withServer(jira.handler, async (url) => {
    for (const [opts, message] of [
      [
        { story: 'SK-77' },
        /linked to story SK-77, but the active story is SK-10/,
      ],
      [{ tc: 'TC-003' }, /TC-003, which is not an approved case/],
    ]) {
      const dir = workspace();
      try {
        writeDraft(dir, opts);
        const r = await runCli(
          dir,
          'create-jira-bugs.js',
          ['--apply'],
          jiraEnv(url)
        );
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, message);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  assert.equal(jira.state.requests.length, 0);
});

// ------------------------------------------------------------ 5.2: idempotency

/** Re-approve the current scope, as a human does after changing a case. */
function reapproveScope(dir) {
  const p = join(dir, 'context.json');
  const ctx = JSON.parse(readFileSync(p, 'utf8'));
  writeFileSync(
    p,
    JSON.stringify(bindGate(ctx, 'test_scope_reviewed', dir), null, 2)
  );
}

const planLines = (out) =>
  out.split(/\r?\n/).filter((l) => l.startsWith('    - '));

test('TestLink: the review fixture — already-linked cases make zero create calls and keep their ids', async () => {
  const dir = workspace();
  try {
    const doc = readCases(dir);
    doc.test_cases.forEach((tc, i) => (tc.testlink_id = String(101 + i)));
    writeCases(dir, doc);
    const before = readFileSync(casesFile(dir), 'utf8');
    const tl = fakeTestLink();
    await withServer(tl.handler, async (url) => {
      const r = await runCli(
        dir,
        'sync-to-testlink.js',
        [STORY, '--apply-testlink'],
        testlinkEnv(url)
      );
      assert.equal(r.code, 0, r.out);
      assert.equal(
        (r.out.match(/SKIP \(in TestLink as 10[123]; already there\)/g) || [])
          .length,
        3
      );
      assert.match(r.out, /Existing TestLink cases are never updated/);
    });
    assert.equal(tlCreates(tl.state), 0);
    assert.deepEqual(
      tl.state.calls,
      [],
      'nothing to create: TestLink is not even contacted'
    );
    assert.equal(
      readFileSync(casesFile(dir), 'utf8'),
      before,
      'ids kept, file untouched'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repeating a successful sync creates nothing and changes nothing (Jira and TestLink)', async () => {
  for (const [script, flag, env, fake, count] of [
    [
      'create-jira-testcases.js',
      '--apply',
      jiraEnv,
      fakeJira,
      (f) => creates(f.state) + links(f.state),
    ],
    [
      'sync-to-testlink.js',
      '--apply-testlink',
      testlinkEnv,
      fakeTestLink,
      (f) => f.state.calls.length,
    ],
  ]) {
    const dir = workspace();
    try {
      const server = fake();
      await withServer(server.handler, async (url) => {
        const first = await runCli(dir, script, [STORY, flag], env(url));
        assert.equal(first.code, 0, first.out);
        const after = readFileSync(casesFile(dir), 'utf8');
        const requests = count(server);
        const second = await runCli(dir, script, [STORY, flag], env(url));
        assert.equal(second.code, 0, second.out);
        assert.equal(
          count(server),
          requests,
          `${script}: no write on the repeat`
        );
        assert.equal(
          readFileSync(casesFile(dir), 'utf8'),
          after,
          `${script}: file unchanged`
        );
        assert.equal((second.out.match(/SKIP \(in /g) || []).length, 3);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a case changed after it was pushed is skipped, with a statement that remote cases are never updated', async () => {
  for (const [script, flag, env, fake, tool, created] of [
    [
      'create-jira-testcases.js',
      '--apply',
      jiraEnv,
      fakeJira,
      'Jira',
      (f) => creates(f.state),
    ],
    [
      'sync-to-testlink.js',
      '--apply-testlink',
      testlinkEnv,
      fakeTestLink,
      'TestLink',
      (f) => tlCreates(f.state),
    ],
  ]) {
    const dir = workspace();
    try {
      const server = fake();
      await withServer(server.handler, async (url) => {
        assert.equal(
          (await runCli(dir, script, [STORY, flag], env(url))).code,
          0
        );
        const doc = readCases(dir);
        doc.test_cases[0].title = 'Valid user lands on the inventory page';
        writeCases(dir, doc);
        reapproveScope(dir);
        const made = created(server);

        const dry = await runCli(dir, script, [STORY], env(url));
        const apply = await runCli(dir, script, [STORY, flag], env(url));
        for (const r of [dry, apply]) {
          assert.equal(r.code, 0, r.out);
          assert.match(
            r.out,
            new RegExp(
              `TC-001 .* SKIP \\(in ${tool} as \\S+; changed locally since it was pushed; ${tool} is NOT updated`
            )
          );
          assert.match(
            r.out,
            /TC-002 .* SKIP \(in \S+ as \S+; already there\)/
          );
        }
        assert.equal(created(server), made, `${tool}: nothing re-created`);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a malformed or conflicting remote id is blocked: never created, never treated as linked', async () => {
  const dir = workspace();
  try {
    const doc = readCases(dir);
    doc.test_cases[0].testlink_id = 'TL-abc';
    doc.test_cases[1].testlink_id = '101';
    doc.test_cases[1].external_ids = { testlink: '102' };
    writeCases(dir, doc);
    const tl = fakeTestLink();
    await withServer(tl.handler, async (url) => {
      const r = await runCli(
        dir,
        'sync-to-testlink.js',
        [STORY, '--apply-testlink'],
        testlinkEnv(url)
      );
      assert.equal(r.code, 1, r.out);
      assert.match(
        r.out,
        /TC-001 .* BLOCKED \(recorded remote id "TL-abc" is not a valid id/
      );
      assert.match(
        r.out,
        /TC-002 .* BLOCKED \(conflicting remote ids 101 and 102/
      );
      assert.match(r.out, /2 case\(s\) are BLOCKED and were not touched/);
    });
    assert.equal(tlCreates(tl.state), 1, 'only the clean case was created');
    const after = readCases(dir).test_cases;
    assert.equal(after[0].testlink_id, 'TL-abc');
    assert.equal(after[0].sync_state, undefined);
    assert.deepEqual(
      [after[1].testlink_id, after[1].external_ids.testlink],
      ['101', '102']
    );
    assert.equal(after[2].testlink_id, '201');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dry-run and apply select identical operations from the same inputs', async () => {
  const setups = [
    [
      'sync-to-testlink.js',
      '--apply-testlink',
      testlinkEnv,
      fakeTestLink,
      (doc) => {
        doc.test_cases[0].testlink_id = '150';
        doc.test_cases[1].testlink_id = 'bogus';
      },
    ],
    [
      'create-jira-testcases.js',
      '--apply',
      jiraEnv,
      fakeJira,
      (doc) => {
        doc.test_cases[0].external_ids = { jira: 'SK-150' };
        doc.test_cases[1].external_ids = { jira: 'not a key' };
      },
    ],
  ];
  for (const [script, flag, env, fake, arrange] of setups) {
    const dir = workspace({ storyKey: null });
    try {
      const doc = readCases(dir);
      arrange(doc);
      writeCases(dir, doc);
      const server = fake();
      await withServer(server.handler, async (url) => {
        const dry = await runCli(dir, script, [STORY], env(url));
        const apply = await runCli(dir, script, [STORY, flag], env(url));
        assert.equal(dry.code, 0, dry.out);
        assert.equal(apply.code, 1, apply.out);
        const plan = planLines(dry.out);
        assert.equal(plan.length, 3);
        assert.deepEqual(
          planLines(apply.out).slice(0, 3),
          plan,
          `${script}: same plan`
        );
        assert.deepEqual(
          plan.map((l) => l.match(/-> (\w+)/)[1]),
          ['SKIP', 'BLOCKED', 'CREATE']
        );
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
