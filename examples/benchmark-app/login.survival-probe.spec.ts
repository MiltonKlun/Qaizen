// A tiny locator probe for scripts/selector-survival.js, NOT a full test. The
// survival script loads a version's LANDING page (the login screen) and checks
// which of these locators still resolve there — so this file deliberately lists
// only login-surface hooks. Run against v1 vs v2 of the benchmark app to get a
// real selector_survival_rate (examples/benchmark-app/README.md).
//
// In v2, `username`/`password` were renamed to `user-name`/`pass-word` and the
// `.title` class became `.page-title`, so a locator bound to the OLD hook does
// not survive — which is exactly the rot signal the metric captures.
import { test, expect } from '@playwright/test';

test('login surface locators (survival probe)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-test="username"]')).toBeVisible();
  await expect(page.locator('[data-test="password"]')).toBeVisible();
  await expect(page.locator('[data-test="login-button"]')).toBeVisible();
  await expect(page.locator('[data-test="title"]')).toBeVisible();
  await expect(page.locator('.title')).toBeVisible();
});
