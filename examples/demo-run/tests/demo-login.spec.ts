import { test, expect } from '@playwright/test';

/**
 * PW-001 — Valid login shows the inventory.
 * Traceability: SPEC-001 / TC-001 / RISK-001 (story DEMO-1).
 *
 * Demo fixture (examples/demo-run/): this test PASSES — the happy path of
 * the demo app works. Runs against the local server the demo driver starts
 * (baseURL from the demo Playwright config).
 */
test('valid login shows the inventory with products [TC-001]', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('[data-test="username"]').fill('demo');
  await page.locator('[data-test="password"]').fill('demo123');
  await page.locator('[data-test="login-button"]').click();

  await expect(page.locator('[data-test="title"]')).toHaveText('Products');
  expect(await page.locator('[data-test="item"]').count()).toBeGreaterThan(0);
});
