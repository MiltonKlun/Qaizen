import { test, expect } from '@playwright/test';

/**
 * PW-002 — Invalid password shows the agreed error copy.
 * Traceability: SPEC-001 / TC-002 / RISK-002 (story DEMO-1).
 *
 * Demo fixture (examples/demo-run/): this test FAILS BY DESIGN. The app has
 * a planted bug — it shows "Wrong password!" where AC-2 agreed on the exact
 * copy "Invalid credentials". The test asserts the AGREED behavior (never
 * weaken a test to match a bug), so the failure is real product signal:
 * it feeds the classifier (product_bug, red) -> BUG-001 draft -> report.
 *
 * The assertion is deliberately a VALUE comparison (toEqual on textContent)
 * so the rule-based classifier sees an expected-vs-received business
 * mismatch, not a locator/wait signal.
 */
test('invalid password shows the error "Invalid credentials" [TC-002]', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('[data-test="username"]').fill('demo');
  await page.locator('[data-test="password"]').fill('nope');
  await page.locator('[data-test="login-button"]').click();

  const error = page.locator('[data-test="error"]');
  await expect(error).toBeVisible();
  // AC-2: the copy is a business contract — assert the exact string.
  expect(await error.textContent()).toEqual('Invalid credentials');
});
