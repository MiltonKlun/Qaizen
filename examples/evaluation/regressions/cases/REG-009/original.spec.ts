// spec: specs/STORY-003.md
// TC-001 · RISK-001 · PW-001: the badge counts down when an item is removed.
// Run against Bench Shop v1 with --bug stale-badge (see README.md).

import { test } from '@playwright/test';

test('TC-001: The cart badge counts down right after a remove', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByPlaceholder('Username').fill('standard_user');
  await page.getByPlaceholder('Password').fill('secret_sauce');
  await page.locator('[data-test="login-button"]').click();
  await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
  await page.locator('[data-test="add-to-cart-sauce-labs-bike-light"]').click();
  await page.locator('[data-test="shopping-cart-link"]').click();
  await page.locator('[data-test="remove-sauce-labs-backpack"]').click();
  // Two items, one removed: the badge reads 1 without a reload.
  await page
    .locator('[data-test="shopping-cart-badge"]:text-is("1")')
    .waitFor();
});
