// Selector survival: real locator semantics, not rebuilt text (task group
// 9.1, review finding I7).
//
// Synthetic app versions are served in-process; the CLI runs real probe
// functions in Chromium against them. Source inspection is tested on parsed
// source and never yields a rate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';

import { extractLocators } from '../scripts/lib/locator-source.js';
import { survivalResult } from '../scripts/lib/selector-probes.js';

const REPO = process.cwd();
const SCRIPT = join(REPO, 'scripts', 'selector-survival.js');

/** Serve `pages` ({ '/v1/': html, ... }); resolves to the base URL. */
function serve(pages) {
  const server = createServer((req, res) => {
    const html = pages[req.url.split('?')[0]];
    if (!html) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>${html}</body></html>`);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: (path) => `http://127.0.0.1:${server.address().port}${path}`,
        close: () => new Promise((r) => server.close(r)),
      })
    )
  );
}

/** Run the CLI without blocking this process's event loop (the server). */
function cli(args) {
  return new Promise((resolve) => {
    const child = spawn(execPath, [SCRIPT, ...args], { cwd: REPO });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    child.on('close', (code) => resolve({ code, out }));
  });
}

function probeModule(dir, body) {
  const path = join(dir, 'probes.mjs');
  writeFileSync(path, body);
  return path;
}

const scratch = () => mkdtempSync(join(tmpdir(), 'qaizen-survival-'));

// ------------------------------------------------------------ measurement

const IMG =
  '<img alt="Logo" width="20" height="20" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
const V1 = `
  <button>Login</button><button>Help</button>
  <input placeholder="Email">
  <label>Password <input type="password"></label>
  <span title="Settings">settings</span>
  ${IMG}
  <div role="dialog" aria-label="Confirm"><button>OK</button></div>
  <button data-testid="buy">Buy</button>
  <button id="save">Save</button>
  <button data-testid="pay">Pay</button>`;
// Login is gone (an unrelated Help button remains), an OK button now exists
// outside the dialog, and the buy button is duplicated.
const V2 = `
  <button>Help</button>
  <input placeholder="Email">
  <label>Password <input type="password"></label>
  <span title="Settings">settings</span>
  ${IMG}
  <button>OK</button>
  <div role="dialog" aria-label="Confirm"><button>OK</button></div>
  <button data-testid="buy">Buy</button><button data-testid="buy">Buy now</button>
  <button id="save" hidden>Save</button>
  <button data-testid="pay" disabled>Pay</button>`;

const DRIFT_PROBES = `
export async function prepare(page, { baseURL }) { await page.goto(baseURL); }
export const probes = [
  { id: 'login', cardinality: 1, locate: (p) => p.getByRole('button', { name: 'Login', exact: true }) },
  { id: 'email', cardinality: 1, locate: (p) => p.getByPlaceholder('Email') },
  { id: 'password', cardinality: 1, locate: (p) => p.getByLabel('Password') },
  { id: 'settings', cardinality: 1, locate: (p) => p.getByTitle('Settings') },
  { id: 'logo', cardinality: 1, locate: (p) => p.getByAltText('Logo') },
  { id: 'dialog-ok', cardinality: 1, locate: (p) => p.getByRole('dialog').getByRole('button', { name: 'OK' }) },
  { id: 'buy', cardinality: 1, locate: (p) => p.getByTestId('buy') },
  { id: 'save', cardinality: 1, locate: (p) => p.locator('#save') },
  { id: 'pay', cardinality: 1, locate: (p) => p.getByTestId('pay'), usable: (l) => l.isEnabled() },
];
`;

test('real locator semantics decide survival: named-role drift, strictness, scope, and non-text locators', async () => {
  const app = await serve({ '/v1/': V1, '/v2/': V2 });
  const dir = scratch();
  try {
    const out = join(dir, 'result.json');
    const r = await cli([
      '--probe',
      probeModule(dir, DRIFT_PROBES),
      '--baseline',
      `v1=${app.url('/v1/')}`,
      '--version',
      `v2=${app.url('/v2/')}`,
      '--out',
      out,
    ]);
    assert.equal(r.code, 0, r.out);
    const res = JSON.parse(readFileSync(out, 'utf8'));
    // The Login button is gone even though another button survives; the
    // duplicated buy button fails strictness. Placeholder, label, title and
    // alt text are measured as themselves, and the scoped OK still has one
    // target inside its dialog.
    // Save is still one element but hidden; Pay is still one button but
    // disabled, and its probe requires an enabled one: neither is usable.
    assert.deepEqual(res.lost.sort(), ['buy', 'login', 'pay', 'save']);
    assert.deepEqual(res.survived.sort(), [
      'dialog-ok',
      'email',
      'logo',
      'password',
      'settings',
    ]);
    assert.equal(res.numerator, 5);
    assert.equal(res.denominator, 9);
    assert.equal(res.selector_survival_rate, 5 / 9);
    const v2 = res.evidence.find((v) => v.name === 'v2').results;
    assert.equal(v2.find((x) => x.probe === 'buy').count, 2);
    assert.equal(v2.find((x) => x.probe === 'login').count, 0);
    assert.match(r.out, /Survival across 1 later version\(s\): 5\/9 = 55\.6%/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const LOGIN_APP = `
  <section id="form"><label>User <input id="u"></label><button id="go">Sign in</button></section>
  <section id="home" hidden><h1>Welcome</h1></section>
  <script>
    document.getElementById('go').onclick = () => {
      document.getElementById('form').hidden = true;
      document.getElementById('home').hidden = false;
    };
  </script>`;

const LOGIN_PROBES = `
export async function prepare(page, { baseURL }) {
  await page.goto(baseURL);
  await page.getByLabel('User').fill('demo', { timeout: 2000 });
  await page.getByRole('button', { name: 'Sign in' }).click({ timeout: 2000 });
}
export const probes = [
  { id: 'welcome', cardinality: 1, locate: (p) => p.getByRole('heading', { name: 'Welcome' }) },
];
`;

test('preparation runs before probing; a version whose setup fails makes the rate null', async () => {
  const app = await serve({
    '/v1/': LOGIN_APP,
    '/v2/': LOGIN_APP,
    '/v3/': '<h1>Welcome</h1><p>no login form any more</p>',
  });
  const dir = scratch();
  try {
    const mod = probeModule(dir, LOGIN_PROBES);
    let r = await cli([
      '--probe',
      mod,
      '--baseline',
      `v1=${app.url('/v1/')}`,
      '--version',
      `v2=${app.url('/v2/')}`,
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /1\/1 = 100\.0%/);

    const out = join(dir, 'result.json');
    r = await cli([
      '--probe',
      mod,
      '--baseline',
      `v1=${app.url('/v1/')}`,
      '--version',
      `v2=${app.url('/v2/')}`,
      '--version',
      `v3=${app.url('/v3/')}`,
      '--out',
      out,
    ]);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /NOT MEASURABLE: setup failed on v3/);
    const res = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(res.selector_survival_rate, null);
    assert.equal(res.numerator, null);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a baseline probe that is not unique makes the measurement invalid, not a failure rate', async () => {
  const app = await serve({ '/v1/': V1, '/v2/': V1 });
  const dir = scratch();
  try {
    const r = await cli([
      '--probe',
      probeModule(
        dir,
        `export async function prepare(page, { baseURL }) { await page.goto(baseURL); }
export const probes = [{ id: 'any-button', cardinality: 1, locate: (p) => p.getByRole('button') }];`
      ),
      '--baseline',
      `v1=${app.url('/v1/')}`,
      '--version',
      `v2=${app.url('/v2/')}`,
    ]);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /on the baseline v1, any-button found 6 target\(s\)/);
    assert.doesNotMatch(
      r.out,
      /selector_survival_rate for the benchmark record/
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one version only, repeated versions, or an invalid probe module never produce a rate', async () => {
  const dir = scratch();
  try {
    const mod = probeModule(dir, DRIFT_PROBES);
    let r = await cli(['--probe', mod, '--baseline', 'v1=http://127.0.0.1:9/']);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /NOT MEASURABLE: fewer than two distinct app versions/);

    r = await cli([
      '--probe',
      mod,
      '--baseline',
      'v1=http://127.0.0.1:9/',
      '--version',
      'v2=http://127.0.0.1:9/',
    ]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /distinct name and a distinct URL/);

    const bad = probeModule(
      dir,
      `export async function prepare() {}
export const probes = [{ id: 'many', cardinality: 2, locate: (p) => p.getByRole('listitem') }];`
    );
    r = await cli([
      '--probe',
      bad,
      '--baseline',
      'v1=http://a/',
      '--version',
      'v2=http://b/',
    ]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /must declare cardinality: 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ the rule

test('the aggregate: survived in every later version over valid baseline probes, or null with a reason', () => {
  const ok = (probe) => ({ probe, count: 1, usable: true, resolved: true });
  const gone = (probe) => ({ probe, count: 0, usable: null, resolved: false });
  const base = { name: 'v1', results: [ok('a'), ok('b')] };
  assert.deepEqual(
    survivalResult(['a', 'b'], base, [
      { name: 'v2', results: [ok('a'), ok('b')] },
      { name: 'v3', results: [ok('a'), gone('b')] },
    ]),
    {
      selector_survival_rate: 0.5,
      numerator: 1,
      denominator: 2,
      survived: ['a'],
      lost: ['b'],
    }
  );
  const err = {
    probe: 'b',
    count: null,
    usable: null,
    resolved: false,
    error: 'boom',
  };
  assert.match(
    survivalResult(['a', 'b'], base, [{ name: 'v2', results: [ok('a'), err] }])
      .reason,
    /on v2, b could not be evaluated \(boom\)/
  );
  assert.equal(
    survivalResult(['a', 'b'], base, [{ name: 'v2', results: [ok('a'), err] }])
      .selector_survival_rate,
    null
  );
});

// ------------------------------------------------------------ source inspection

test('source inspection keeps method, options, scope, regexes and escapes; dynamic source is unmeasurable', () => {
  const src = `
import { test } from '@playwright/test';
test('t', async ({ page }) => {
  const label = 'Login';
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.getByText('It\\'s "here"').click();
  await page.getByText(/log in/i).click();
  await page.getByRole('dialog').getByRole('button', { name: 'OK' }).nth(1).click();
  await page.getByPlaceholder('Email').fill('a');
  await page.getByRole('button', { name: label }).click();
  await dialog.getByRole('button', { name: 'Close' }).click();
  const n = [1].filter((x) => x).length;
});`;
  const r = extractLocators(src);
  assert.equal(r.ok, true);
  const by = (expr) => r.locators.find((l) => l.expression === expr);
  assert.ok(
    by("page.getByRole('button', { name: 'Login', exact: true })")?.measurable
  );
  assert.ok(
    by(`page.getByText('It\\'s "here"')`)?.measurable,
    'escapes are resolved, not dropped'
  );
  assert.deepEqual(
    r.locators.find((l) => l.expression.startsWith("page.getByText('It"))
      .steps[0].args,
    ['It\'s "here"'],
    'the cooked string is kept exactly'
  );
  assert.ok(by('page.getByText(/log in/i)')?.measurable);
  const scoped = by(
    "page.getByRole('dialog').getByRole('button', { name: 'OK' }).nth(1)"
  );
  assert.deepEqual(
    scoped.steps.map((s) => s.method),
    ['getByRole', 'getByRole', 'nth']
  );
  assert.ok(by("page.getByPlaceholder('Email')")?.measurable);
  const dyn = by("page.getByRole('button', { name: label })");
  assert.equal(dyn.measurable, false);
  assert.match(dyn.reason, /option name: the variable `label`/);
  const vscope = by("dialog.getByRole('button', { name: 'Close' })");
  assert.equal(vscope.measurable, false);
  assert.match(vscope.reason, /scope `dialog` is defined elsewhere/);
  assert.equal(
    r.locators.some((l) => l.expression.startsWith('[1]')),
    false
  );
});

test('--tests is source inspection only: it lists locators and never reports a rate', async () => {
  const dir = scratch();
  try {
    const spec = join(dir, 'a.spec.ts');
    writeFileSync(
      spec,
      `import { test } from '@playwright/test';
test('t', async ({ page }) => { await page.getByRole('button', { name: 'Login' }).click(); });`
    );
    const r = await cli([
      '--tests',
      spec,
      '--version',
      'v2=http://a/',
      '--version',
      'v3=http://b/',
    ]);
    assert.equal(r.code, 3, r.out);
    assert.match(
      r.out,
      /L1 line 2: page\.getByRole\('button', \{ name: 'Login' \}\)/
    );
    assert.match(r.out, /SOURCE INSPECTION ONLY: no survival rate/);
    assert.match(r.out, /--version is ignored here/);
    assert.doesNotMatch(
      r.out,
      /selector_survival_rate for the benchmark record/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
