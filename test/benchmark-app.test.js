// The Bench Shop and the static server it shares with the demo app.
// No browser needed: these run in CI's quality job. The rendered
// behavior (clean and injected bugs, v1 -> v2 survival) is checked with a
// browser by `npm run benchmark:check`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { request } from 'node:http';
import { join, relative } from 'node:path';
import { execPath } from 'node:process';

import {
  bugProblems,
  cents,
  salesTax,
} from '../scripts/lib/bench-shop-check.js';

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
    user: 'login-user',
    pass: 'login-pass',
    price: 'product-price',
    add: 'basket-add',
  });
  assert.deepEqual(v2.hooks, {
    user: 'signin-user',
    pass: 'signin-pass',
    price: 'unit-price',
    add: 'put-in',
  });
  // No v1 hook contains its v2 name, so a check that a repair uses the v2
  // hook cannot be satisfied by code that still uses the v1 one.
  for (const k of Object.keys(v1.hooks))
    assert.equal(v1.hooks[k].includes(v2.hooks[k]), false, k);

  // Everything else that differs, read from what each version renders, and
  // every difference is a row of the README drift table.
  const rendered = (/** @type {any} */ v) => {
    const summary = v.summary('$1.00', '$0.07', '$1.07');
    return {
      headingClass: v.headingClass,
      priceClass: v.priceClass,
      items: /data-qa="([^"]+)">Items:/.exec(summary)?.[1],
      tax: /data-qa="([^"]+)">Sales tax:/.exec(summary)?.[1],
      total: /data-qa="([^"]+)">Order total:/.exec(summary)?.[1],
      figureTag: /<(\w+) data-qa="[^"]+">Items:/.exec(summary)?.[1],
      container: /^<(\w+) class="([^"]+)"/.exec(summary)?.slice(1).join('.'),
      row: /<\w+ class="([^"]+)">\s*<(?:span|td)/.exec(summary)?.[1],
      lines: /^<(\w+) id="review-lines"/.exec(v.review(''))?.[1],
    };
  };
  const r1 = rendered(v1);
  const r2 = rendered(v2);
  assert.deepEqual(r1, {
    headingClass: 'heading',
    priceClass: 'price',
    items: 'sum-items',
    tax: 'sum-tax',
    total: 'sum-total',
    figureTag: 'span',
    container: 'div.order-sums',
    row: 'sum-row',
    lines: 'div',
  });
  assert.deepEqual(r2, {
    headingClass: 'screen-heading',
    priceClass: 'cost',
    items: 'items-sum',
    tax: 'sum-tax',
    total: 'sum-total',
    figureTag: 'span',
    container: 'table.order-table',
    row: 'order-line',
    lines: 'section',
  });
  const readme = readFileSync(
    join(REPO, 'examples', 'benchmark-app', 'README.md'),
    'utf8'
  );
  const row = (/** @type {string} */ a, /** @type {string} */ b) =>
    readme
      .split(/\r?\n/)
      .some((l) => l.startsWith('|') && l.includes(a) && l.includes(b));
  for (const k of Object.keys(v1.hooks))
    assert.ok(
      row(`"${v1.hooks[k]}`, `"${v2.hooks[k]}`),
      `README drift table lacks ${k}`
    );
  assert.ok(row(`class="${r1.headingClass}"`, `class="${r2.headingClass}"`));
  assert.ok(row(`class="${r1.priceClass}"`, `class="${r2.priceClass}"`));
  assert.ok(row(`"${r1.items}"`, `"${r2.items}"`));
  assert.ok(row('class="order-sums"', 'class="order-table"'));
  assert.ok(row('<div id="review-lines">', '<section id="review-lines">'));
  // One visible element per summary figure in both versions: no duplicate
  // label text for a text-based locator to trip over.
  for (const v of [v1, v2]) {
    const html = v.summary('$1.00', '$0.07', '$1.07');
    assert.equal((html.match(/Items:/g) ?? []).length, 1);
    assert.equal((html.match(/Sales tax:/g) ?? []).length, 1);
    assert.equal((html.match(/Order total:/g) ?? []).length, 1);
  }
});

// What a model may remember of the well-known public demo shop: none of it
// may be in the Bench Shop or in the cases and stories that run on it, so a
// test that passes there was written by looking at the app.
const SAUCEDEMO = [
  // products and their ids
  /sauce labs/i,
  /sauce-labs/i,
  /backpack/i,
  /bike light/i,
  /bolt t-shirt/i,
  /fleece jacket/i,
  /onesie/i,
  /allthethings/i,
  // credentials
  /standard_user|locked_out_user|problem_user|performance_glitch_user|error_user|visual_user/,
  /secret_sauce/,
  // prices, the 8% tax and the totals they make
  /\b(29\.99|9\.99|15\.99|49\.99|7\.99|39\.98|43\.18)\b/,
  /\b0\.08\b|\b8 ?%/,
  // the attribute, hooks, classes, routes and screen text
  /data-test\b/,
  /shopping[-_]cart|inventory[-_]item|add-to-cart|checkout-step|subtotal|tax-label|total-label/i,
  /complete-header|back-to-products|continue-shopping|login-button|firstName|lastName|postalCode/,
  /item_price|summary_info|cart_badge|app_logo|inventory\.html/,
  /swag labs|checkout: overview|checkout: complete|thank you for your order|your cart|epic sadface|item total/i,
];
const SET = join(REPO, 'examples', 'evaluation', 'regressions');

/**
 * The regression cases that run on the Bench Shop, from the manifest: a
 * Bench Shop bug, or a case whose files serve the Bench Shop.
 */
function benchCases() {
  const manifest = JSON.parse(readFileSync(join(SET, 'manifest.json'), 'utf8'));
  return manifest.cases.filter(
    (/** @type {any} */ c) =>
      c.source?.kind === 'bench-shop-bug' ||
      walk(join(SET, c.input)).some((f) =>
        readFileSync(f, 'utf8').includes('examples/benchmark-app/serve.js')
      )
  );
}

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
  );
}

test('the Bench Shop, its stories and the cases run on it hold no SauceDemo names, prices, credentials or hooks', () => {
  const cases = benchCases();
  assert.deepEqual(
    cases.map((/** @type {any} */ c) => c.id),
    ['REG-006', 'REG-007', 'REG-008', 'REG-009', 'REG-010']
  );
  /** @type {{ name: string, text: string }[]} */
  const sources = [
    ...walk(join(REPO, 'examples', 'benchmark-app')),
    ...cases.flatMap((/** @type {any} */ c) => walk(join(SET, c.input))),
  ].map((f) => ({ name: relative(REPO, f), text: readFileSync(f, 'utf8') }));
  // The cases' manifest entries too: their check texts name hooks.
  for (const c of cases)
    sources.push({
      name: `manifest.json ${c.id}`,
      text: JSON.stringify(c, null, 2),
    });
  const found = [];
  for (const { name, text } of sources)
    text.split(/\r?\n/).forEach((line, i) => {
      for (const re of SAUCEDEMO)
        if (re.test(line)) found.push(`${name}:${i + 1} ${re}`);
    });
  assert.deepEqual(found, []);
});

test('the seeded-bug check passes only when each bug shows its own symptom and nothing else', () => {
  const clean = {
    countAfterAdds: 2,
    countAfterTakeOut: 1,
    countAfterMoving: 1,
    lines: [3450, 1225],
    items: 4675,
    tax: salesTax(4675),
    total: 4675 + salesTax(4675),
  };
  assert.equal(salesTax(4675), 304, '6.5% of $46.75, half up');
  const seen = {
    clean,
    'stale-badge': { ...clean, countAfterTakeOut: 2 },
    'wrong-item-total': {
      ...clean,
      items: 4775,
      total: 4775 + clean.tax,
    },
    'inconsistent-total': { ...clean, total: clean.total + 50 },
  };
  assert.deepEqual(bugProblems(seen), []);
  // A bug that no longer toggles is caught...
  assert.match(
    bugProblems({ ...seen, 'stale-badge': clean }).join('\n'),
    /stale-badge: does not show its symptom/
  );
  // ...and so is one that changes something else as well.
  assert.match(
    bugProblems({
      ...seen,
      'inconsistent-total': {
        ...seen['inconsistent-total'],
        countAfterTakeOut: 2,
      },
    }).join('\n'),
    /inconsistent-total: changes countAfterTakeOut/
  );
  // A wrong clean run is reported before any bug is judged against it.
  assert.match(
    bugProblems({ ...seen, clean: { ...clean, tax: 320 } }).join('\n'),
    /clean: tax is 320, expected 304/
  );
  assert.equal(cents('Order total: $49.79'), 4979);
});
