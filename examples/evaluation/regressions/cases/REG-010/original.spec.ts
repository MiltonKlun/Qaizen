// spec: specs/STORY-003.md
// TC-003 · RISK-001 · PW-003: adding an item shows it in the cart badge.
// Written against Bench Shop v1; run against v2 (see README.md).

import { test, expect } from '@playwright/test';

test('TC-003: Adding an item shows it in the cart badge', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('Username').fill('standard_user');
  await page.getByPlaceholder('Password').fill('secret_sauce');
  await page.locator('[data-test="login-button"]').click();
  await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
  await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveText(
    '1'
  );
});
