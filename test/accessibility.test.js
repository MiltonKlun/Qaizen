// Accessibility checks (tests/fixtures/accessibility.ts, @axe-core/playwright)
// run in a real browser: a clean page passes, a broken one fails with the
// rules named, and narrowing the check works as documented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execPath } from 'node:process';

import { removeTempDir } from './helpers/cleanup.js';
import { playwrightCli } from '../scripts/lib/cli.js';

const REPO = process.cwd();
const FIXTURE = join(REPO, 'tests', 'fixtures', 'accessibility.ts')
  .split('\\')
  .join('/');

async function browserInstalled() {
  try {
    const { chromium } = await import('@playwright/test');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const SPEC = `import { test, expect } from '@playwright/test';
import { accessibilityViolations, expectAccessible } from '${FIXTURE}';

const page = (body) =>
  '<!doctype html><html lang="en"><head><title>Shop</title></head><body>' +
  body +
  '</body></html>';
const CLEAN = '<main><h1>Shop</h1><button>Add to cart</button></main>';
const BROKEN = '<main><h1>Shop</h1><img src="x.png"><button></button></main>';

test('a clean page passes', async ({ page: p }) => {
  await p.setContent(page(CLEAN));
  await expectAccessible(p);
});

test('a broken page names every rule it breaks', async ({ page: p }) => {
  await p.setContent(page(BROKEN));
  const ids = (await accessibilityViolations(p)).map((v) => v.id).sort();
  expect(ids).toEqual(['button-name', 'image-alt']);
  const failure = await expectAccessible(p).then(() => null, (e) => e);
  expect(String(failure?.message)).toContain('image-alt (critical)');
  expect(String(failure?.message)).toContain('button-name (critical)');
  expect(String(failure?.message)).toContain('https://dequeuniversity.com/rules/axe/');
});

test('include scopes the check; disableRules turns a rule off', async ({ page: p }) => {
  await p.setContent(page('<div id="clean">' + CLEAN + '</div><div id="broken"><img src="x.png"></div>'));
  await expectAccessible(p, { include: '#clean' });
  await expectAccessible(p, { exclude: ['#broken'] });
  await expectAccessible(p, { disableRules: ['image-alt'] });
  expect((await accessibilityViolations(p)).map((v) => v.id)).toEqual(['image-alt']);
});
`;

const CONFIG = `import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', reporter: 'list', workers: 1 });
`;

test('accessibility checks find WCAG violations in a real browser', async (t) => {
  if (!(await browserInstalled())) {
    t.skip(
      'no Playwright browser installed (CI quality job); run locally for the real check'
    );
    return;
  }
  const dir = mkdtempSync(join(REPO, '.tmp-a11y-'));
  t.after(() => removeTempDir(dir));
  writeFileSync(join(dir, 'a11y.spec.ts'), SPEC);
  writeFileSync(join(dir, 'playwright.config.ts'), CONFIG);
  const r = spawnSync(
    execPath,
    [playwrightCli(), 'test', '--config', join(dir, 'playwright.config.ts')],
    { cwd: REPO, encoding: 'utf8', timeout: 180000 }
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /3 passed/);
});
