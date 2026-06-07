#!/usr/bin/env node
// TG14 vertical-slice demonstration of the Healer guardrails (Phase 3).
// Exercises the SAME guardrail logic the harness uses (scripts/healer-
// guardrails.js) against two realistic candidate patches:
//
//   GREEN  — a broken-locator fix: only the selector string changes, the
//            business assertion is untouched. Expect [] (SAFE) => this is the
//            kind of candidate the Healer may emit as a reviewable .patch.
//
//   RED    — a broken-business-assertion "fix": the candidate changes the
//            EXPECTED value to make a failing test pass. Expect a violation
//            => REJECTED, never auto-fixed; this is the bug-draft path.
//
// This is the deterministic, browser-free proof of the Green/Red boundary the
// TG14 plan asks for. (A full browser story with a live broken locator needs
// Playwright MCP + the human gates; the guardrail BEHAVIOR is what TG14
// verifies, and it is proven here without driving the app.)
//
// Usage:  node scripts/demo-healer-green-red.js
// Exit:   0 if both cases behave as expected · 1 if either does not.

import { guardrailViolations } from './healer-guardrails.js';

// --- GREEN: locator-only fix (business meaning preserved) -----------------
const greenBefore = `import { test, expect } from '@playwright/test';

test('SK-X: user lands on inventory after login', async ({ page }) => {
  await page.goto('/');
  await page.locator('#user-name').fill('standard_user');
  await page.locator('#password').fill('secret_sauce');
  await page.locator('#login-button').click();
  await expect(page).toHaveURL(/inventory.html/);
  await expect(page.locator('.title')).toHaveText('Products');
});`;

// Only the brittle selector changed (#login-button -> a stable data-test).
// The assertions (toHaveURL, toHaveText 'Products') are IDENTICAL.
const greenAfter = greenBefore.replace(
  "page.locator('#login-button')",
  'page.locator(\'[data-test="login-button"]\')'
);

// --- RED: changes the EXPECTED business value to force a pass --------------
const redBefore = greenBefore;
// The candidate "fixes" a failing test by changing the expected title from
// 'Products' to whatever the (buggy) app now shows. That is a business-meaning
// change — exactly what must NEVER be auto-fixed.
const redAfter = greenBefore.replace(
  "toHaveText('Products')",
  "toHaveText('Swag Labs')"
);

let ok = true;

function check(label, before, after, expectSafe) {
  const violations = guardrailViolations(before, after);
  const safe = violations.length === 0;
  const pass = safe === expectSafe;
  ok = ok && pass;
  console.log(`\n${label}`);
  console.log(`  expected: ${expectSafe ? 'SAFE (allowed)' : 'REJECTED'}`);
  console.log(`  result:   ${safe ? 'SAFE (allowed)' : 'REJECTED'}`);
  if (!safe) for (const v of violations) console.log(`    - ${v}`);
  console.log(`  ${pass ? 'OK' : 'XX MISMATCH'}`);
}

console.log('Healer Green/Red guardrail demonstration (Phase 3 TG14)');
check(
  'GREEN — broken-locator fix (selector changes, assertion unchanged)',
  greenBefore,
  greenAfter,
  true
);
check(
  'RED — changes the expected business value to force a pass',
  redBefore,
  redAfter,
  false
);

console.log(
  `\n${ok ? 'PASS' : 'FAIL'}: the Green candidate is allowed (reviewable patch); ` +
    'the Red candidate is rejected (never auto-fixed → bug-draft path). ' +
    'The Healer never commits, never merges, never changes a business assertion.'
);

process.exit(ok ? 0 : 1);
