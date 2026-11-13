// Action targets (scripts/lib/action-targets.js): what each action of a test
// acts on, recorded by a run with the shim preloaded, and the comparison a
// heal is held to. The real-browser tests run a test against the Bench Shop:
// a heal that swaps "Go to checkout" for "Keep shopping" is refused, and a
// heal that follows a pure test-id rename (v1 to v2) is accepted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { execPath } from 'node:process';

import {
  compareTargets,
  readTargets,
  recordingEnv,
  roleAndName,
  targetsOf,
} from '../scripts/lib/action-targets.js';
import { ledgerRepeatCheck } from '../scripts/lib/repeat-check.js';
import { playwrightCli } from '../scripts/lib/cli.js';
import { validateValue } from '../scripts/lib/artifact-io.js';

const REPO = process.cwd();

const act = (index, role, name, testId, extra = {}) => ({
  index,
  method: 'click',
  locator: `locator('[data-qa="${testId}"]')`,
  count: 1,
  role,
  name,
  test_id: testId,
  ...extra,
});
const targets = (...actions) => ({
  test_title: 'BENCH-2.spec.ts > checks out [TC-001]',
  project: '',
  actions,
});

test('the role and name come from the first line of the aria snapshot', () => {
  assert.deepEqual(roleAndName('- button "Go to checkout"'), {
    role: 'button',
    name: 'Go to checkout',
  });
  assert.deepEqual(roleAndName('- link "basket":\n  - text: "1"'), {
    role: 'link',
    name: 'basket',
  });
  assert.deepEqual(roleAndName('- textbox "say \\"hi\\""'), {
    role: 'textbox',
    name: 'say "hi"',
  });
  assert.deepEqual(roleAndName('- text: hello'), { role: 'text', name: null });
  assert.deepEqual(roleAndName(''), { role: null, name: null });
});

test('the comparison: same element, a changed visible name, another element, a locator matching many', () => {
  const recorded = targets(
    act(0, 'button', 'Add to basket', 'basket-add-chisel-set'),
    act(1, 'button', 'Go to checkout', 'go-to-checkout')
  );
  // A renamed test id on the same button: the same element.
  assert.equal(
    compareTargets(
      recorded,
      targets(
        act(0, 'button', 'Add to basket', 'put-in-chisel-set'),
        act(1, 'button', 'Go to checkout', 'go-to-checkout')
      )
    ).verdict,
    'same'
  );
  // The same button (same test id) whose text changed: Yellow.
  const yellow = compareTargets(
    recorded,
    targets(
      act(0, 'button', 'Add to basket', 'basket-add-chisel-set'),
      act(1, 'button', 'Proceed to payment', 'go-to-checkout')
    )
  );
  assert.equal(yellow.verdict, 'yellow');
  assert.match(
    yellow.differences[0].why,
    /same button \(go-to-checkout\), whose visible name changed from "Go to checkout" to "Proceed to payment"/
  );
  // Another button: refused.
  const swap = compareTargets(
    recorded,
    targets(
      act(0, 'button', 'Add to basket', 'basket-add-chisel-set'),
      act(1, 'button', 'Keep shopping', 'keep-shopping')
    )
  );
  assert.equal(swap.verdict, 'different');
  assert.match(
    swap.differences[0].why,
    /action 2 \(click\) now acts on button "Keep shopping" instead of button "Go to checkout"/
  );
  // A locator matching two elements, or fewer actions: refused.
  assert.equal(
    compareTargets(
      recorded,
      targets(
        act(0, 'button', 'Add to basket', 'x', { count: 2 }),
        act(1, 'button', 'Go to checkout', 'go-to-checkout')
      )
    ).verdict,
    'different'
  );
  assert.equal(
    compareTargets(
      recorded,
      targets(act(0, 'button', 'Add to basket', 'basket-add-chisel-set'))
    ).verdict,
    'different'
  );
  // Nothing recorded: the comparison cannot be made, and says so.
  assert.equal(compareTargets(null, recorded).verdict, 'not_recorded');
});

test('a recording keeps the first repetition of each test, and the ledger copy leaves it out', () => {
  const line = (rep, name) =>
    JSON.stringify({
      test_title: 'BENCH-2.spec.ts > checks out [TC-001]',
      project: '',
      repeat_index: rep,
      actions: [act(0, 'button', name, 'go-to-checkout')],
    });
  const read = readTargets(
    [line(0, 'first'), line(1, 'second'), 'not json', ''].join('\n')
  );
  assert.equal(read.length, 1);
  assert.equal(read[0].actions[0].name, 'first');
  assert.equal(
    targetsOf(read, 'BENCH-2.spec.ts > checks out [TC-001]')?.actions.length,
    1
  );
  assert.equal(targetsOf(read, 'another'), null);

  const record = {
    input_digest: 'a'.repeat(64),
    track: 'standard',
    repeat_each: 10,
    workers: 2,
    ran_at: '2026-11-13T10:00:00Z',
    report: 'reports/repeat/results.json',
    outcome: 'stable',
    units: [],
    targets: read,
  };
  assert.equal(
    validateValue(record, 'schemas/context.schema.json', {
      fragment: '#/properties/repeat_check',
    }).ok,
    true
  );
  assert.equal('targets' in ledgerRepeatCheck(record), false);
});

// ------------------------------------------------------------ real browser

async function browserInstalled() {
  try {
    const { chromium } = await import('@playwright/test');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/** A test that adds a product and goes to checkout, with its locators. */
const spec = (
  add,
  checkout
) => `import { test, expect } from '@playwright/test';

test('goes to checkout [TC-001]', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Workshop ID').fill('ada.joiner');
  await page.getByLabel('Passphrase').fill('dovetail-42');
  await page.locator('[data-qa="login-submit"]').click();
  await page.locator('[data-qa="${add}"]').click();
  await page.locator('[data-qa="basket-link"]').click();
  await page.locator('[data-qa="${checkout}"]').click();
  await expect(page.locator('[data-qa="page-heading"]')).toBeVisible();
});
`;

/**
 * Run one spec against the Bench Shop with the recording preloaded, and
 * return its targets.
 */
function record(dir, version, body) {
  const work = join(dir, `${version}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'checkout.spec.ts'), body);
  writeFileSync(
    join(work, 'pw.config.mjs'),
    "export default { testDir: '.', outputDir: './out', retries: 0, workers: 1, timeout: 15000, use: { baseURL: process.env.BASE_URL, actionTimeout: 4000 } };\n"
  );
  const out = join(work, 'targets.jsonl');
  spawnSync(
    execPath,
    [
      join(REPO, 'scripts', 'bench-shop-run.js'),
      '--version',
      version,
      '--',
      playwrightCli(),
      'test',
      '--config',
      join(work, 'pw.config.mjs'),
      '--reporter',
      'line',
    ],
    { cwd: REPO, encoding: 'utf8', env: recordingEnv(out) }
  );
  return existsSync(out)
    ? targetsOf(
        readTargets(readFileSync(out, 'utf8')),
        'checkout.spec.ts > goes to checkout [TC-001]'
      )
    : null;
}

test('real Playwright: a swap to another button is refused; a pure test-id rename is accepted', async (t) => {
  if (!(await browserInstalled())) {
    t.skip(
      'no Playwright browser installed; run locally for the real acceptance'
    );
    return;
  }
  const dir = mkdtempSync(join(REPO, '.tmp-runner-tx-'));
  try {
    const original = record(
      dir,
      'v1',
      spec('basket-add-chisel-set', 'go-to-checkout')
    );
    assert.ok(original, 'the original test was recorded');
    assert.deepEqual(
      original.actions.map((a) => [a.method, a.role, a.name, a.test_id]),
      [
        ['fill', 'textbox', 'Workshop ID', 'login-user'],
        ['fill', 'textbox', 'Passphrase', 'login-pass'],
        ['click', 'button', 'Sign in', 'login-submit'],
        ['click', 'button', 'Add to basket', 'basket-add-chisel-set'],
        ['click', 'link', 'basket', 'basket-link'],
        ['click', 'button', 'Go to checkout', 'go-to-checkout'],
      ]
    );

    // A "heal" that clicks Keep shopping instead of Go to checkout: it still
    // passes (the next screen has a heading), but it acts on another button.
    const swapped = record(
      dir,
      'v1',
      spec('basket-add-chisel-set', 'keep-shopping')
    );
    const swap = compareTargets(original, swapped);
    assert.equal(swap.verdict, 'different');
    assert.match(
      swap.differences[0].why,
      /now acts on button "Keep shopping" instead of button "Go to checkout"/
    );

    // v2 renamed the add button's test id only: the heal that follows it
    // acts on the same button.
    const renamed = record(
      dir,
      'v2',
      spec('put-in-chisel-set', 'go-to-checkout')
    );
    const rename = compareTargets(original, renamed);
    assert.equal(rename.verdict, 'same', JSON.stringify(rename.differences));
    assert.equal(rename.actions_compared, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
