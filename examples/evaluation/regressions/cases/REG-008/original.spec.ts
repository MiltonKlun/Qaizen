// spec: specs/STORY-020.md
// TC-002 · RISK-001 · PW-002: the item total is the sum of the line prices.
// Run against Bench Shop v1 with --bug wrong-item-total (see README.md).

import { test } from '@playwright/test';

test('TC-002: Item total equals the sum of the line prices', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByPlaceholder('Username').fill('standard_user');
  await page.getByPlaceholder('Password').fill('secret_sauce');
  await page.locator('[data-test="login-button"]').click();
  await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
  await page.locator('[data-test="add-to-cart-sauce-labs-bike-light"]').click();
  await page.locator('[data-test="shopping-cart-link"]').click();
  await page.locator('[data-test="checkout"]').click();
  await page.locator('[data-test="firstName"]').fill('Jane');
  await page.locator('[data-test="lastName"]').fill('Tester');
  await page.locator('[data-test="postalCode"]').fill('90210');
  await page.locator('[data-test="continue"]').click();
  // $29.99 + $9.99
  await page.locator('text=Item total: $39.98').click();
});
