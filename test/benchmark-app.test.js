// The Bench Shop and the static server it shares with the demo app (task
// group 9.2). No browser needed: these run in CI's quality job. The rendered
// behavior (clean and injected bugs, v1 -> v2 survival) is checked with a
// browser by `npm run benchmark:check`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';
import { execPath } from 'node:process';

const REPO = process.cwd();
const BENCH = join(REPO, 'examples', 'benchmark-app', 'serve.js');
const DEMO = join(REPO, 'examples', 'demo-run', 'serve.js');

function start(script, args = []) {
  const child = spawn(execPath, [script, ...args]);
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (b) => {
      const m = String(b).match(/^PORT (\d+)/m);
      if (m) resolve({ port: Number(m[1]), stop: () => child.kill() });
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
}

/** GET a raw path (no URL normalization, so `..` reaches the server). */
function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (b) => (body += b));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            type: res.headers['content-type'],
            body,
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('the Bench Shop serves one app with the chosen version and bugs injected', async () => {
  const s = await start(BENCH, [
    '--version',
    'v2',
    '--port',
    '0',
    '--bug',
    'wrong-item-total',
  ]);
  try {
    const page = await get(s.port, '/');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(
      page.body,
      /window\.__BENCH__ = \{"version":"v2","bugs":\["wrong-item-total"\]\};/
    );
    assert.doesNotMatch(page.body, /__BENCH_INJECT__/);
    for (const f of ['/shop.js', '/versions.js']) {
      const r = await get(s.port, f);
      assert.equal(r.status, 200, f);
      assert.match(r.type, /text\/javascript/, f);
    }
  } finally {
    s.stop();
  }
});

test('the shared server never serves outside its root', async () => {
  for (const script of [BENCH, DEMO]) {
    const s = await start(script, script === BENCH ? ['--port', '0'] : []);
    try {
      for (const path of [
        '/../serve.js',
        '/..%2Fserve.js',
        '/%2e%2e/%2e%2e/package.json',
        '/missing.html',
        '/%E0%A4%A',
      ]) {
        const r = await get(s.port, path);
        assert.ok(
          r.status === 404 || r.status === 400,
          `${script} ${path}: ${r.status}`
        );
        assert.doesNotMatch(r.body, /import|"name"/);
      }
      assert.equal((await get(s.port, '/')).status, 200);
    } finally {
      s.stop();
    }
  }
});

test('an unknown version or bug is a usage error', () => {
  for (const args of [
    ['--version', 'v9'],
    ['--bug', 'no-such-bug'],
    ['--port', '99999'],
  ]) {
    const r = spawnSync(execPath, [BENCH, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 2, args.join(' '));
  }
});

test('the version configuration holds only the documented drift', async () => {
  await import('../examples/benchmark-app/app/versions.js');
  const { v1, v2 } = globalThis.BENCH_VERSIONS;
  assert.deepEqual(Object.keys(globalThis.BENCH_VERSIONS), ['v1', 'v2']);
  assert.deepEqual(v1.hooks, {
    username: 'username',
    password: 'password',
    price: 'inventory-item-price',
    add: 'add-to-cart',
  });
  assert.deepEqual(v2.hooks, {
    username: 'user-name',
    password: 'pass-word',
    price: 'item-cost',
    add: 'add',
  });
  // One visible element per summary figure in both versions: no duplicate
  // label text for a text-based locator to trip over.
  for (const v of [v1, v2]) {
    const html = v.summary('$1.00', '$0.08', '$1.08');
    assert.equal((html.match(/Item total:/g) ?? []).length, 1);
    assert.equal((html.match(/Tax:/g) ?? []).length, 1);
    assert.equal((html.match(/>Total:/g) ?? []).length, 1);
  }
});
