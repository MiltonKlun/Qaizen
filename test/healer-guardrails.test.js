// Unit tests for the Healer guardrails — the safety-critical pure logic
// (CLAUDE.md §3.6). Run with `npm run test:unit` (node:test, no deps).
//
// guardrailViolations(before, after) -> [] means SAFE; non-empty means REJECT.
// A regression here would let the Healer change a business assertion or
// suppress a test, so this is the most important suite in the repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardrailViolations } from '../scripts/healer-guardrails.js';

const base = `import { test, expect } from '@playwright/test';
test('login lands on inventory', async ({ page }) => {
  await page.locator('#login-button').click();
  await expect(page).toHaveURL(/inventory.html/);
  await expect(page.locator('.title')).toHaveText('Products');
});`;

test('locator-only fix is SAFE (allowed)', () => {
  const after = base.replace(
    "page.locator('#login-button')",
    'page.locator(\'[data-test="login-button"]\')'
  );
  assert.deepEqual(guardrailViolations(base, after), []);
});

test('changing an expected value is REJECTED', () => {
  const after = base.replace(
    "toHaveText('Products')",
    "toHaveText('Swag Labs')"
  );
  const v = guardrailViolations(base, after);
  assert.ok(
    v.some((x) => /expected value/.test(x)),
    v.join('; ')
  );
});

test('changing an expected URL is REJECTED', () => {
  const after = base.replace('/inventory.html/', '/anything.html/');
  const v = guardrailViolations(base, after);
  assert.ok(
    v.some((x) => /expected value/.test(x)),
    v.join('; ')
  );
});

test('adding .skip is REJECTED', () => {
  const after = base.replace('test(', 'test.skip(');
  const v = guardrailViolations(base, after);
  assert.ok(
    v.some((x) => /skip|fixme/.test(x)),
    v.join('; ')
  );
});

test('adding .fixme is REJECTED', () => {
  const after = base.replace('test(', 'test.fixme(');
  const v = guardrailViolations(base, after);
  assert.ok(
    v.some((x) => /skip|fixme/.test(x)),
    v.join('; ')
  );
});

test('deleting a test is REJECTED', () => {
  const after = "import { test, expect } from '@playwright/test';\n// gone";
  const v = guardrailViolations(base, after);
  assert.ok(
    v.some((x) => /removes a test/.test(x)),
    v.join('; ')
  );
});

test('weakening an assertion to toBeTruthy is REJECTED', () => {
  const after = base.replace(
    "await expect(page.locator('.title')).toHaveText('Products');",
    'await expect(page.locator(".title")).toBeTruthy();'
  );
  const v = guardrailViolations(base, after);
  assert.ok(
    v.some((x) => /weakens an assertion/.test(x)),
    v.join('; ')
  );
});

test('introducing a snapshot is REJECTED', () => {
  const after = base.replace(
    'await expect(page).toHaveURL(/inventory.html/);',
    'await expect(page).toHaveScreenshot();'
  );
  const v = guardrailViolations(base, after);
  assert.ok(
    v.some((x) => /snapshot/.test(x)),
    v.join('; ')
  );
});

test('an identical patch (no change) is SAFE', () => {
  assert.deepEqual(guardrailViolations(base, base), []);
});

test('a fix that does several forbidden things reports each', () => {
  // weakens AND changes expected: at least two distinct violations.
  const after = base
    .replace("toHaveText('Products')", 'toBeTruthy()')
    .replace('/inventory.html/', '/x/');
  const v = guardrailViolations(base, after);
  assert.ok(
    v.length >= 2,
    `expected multiple violations, got: ${v.join('; ')}`
  );
});
