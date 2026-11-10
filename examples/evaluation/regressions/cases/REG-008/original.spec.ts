// spec: specs/BENCH-2.md
// TC-002 · RISK-001 · PW-002: the Items figure is the sum of the line prices.
// Run against Bench Shop v1 with --bug wrong-item-total (see README.md).

import { test } from '@playwright/test';

test('TC-002: The Items figure equals the sum of the line prices', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Workshop ID').fill('ada.joiner');
  await page.getByLabel('Passphrase').fill('dovetail-42');
  await page.locator('[data-qa="login-submit"]').click();
  await page.locator('[data-qa="basket-add-chisel-set"]').click();
  await page.locator('[data-qa="basket-add-marking-gauge"]').click();
  await page.locator('[data-qa="basket-link"]').click();
  await page.locator('[data-qa="go-to-checkout"]').click();
  await page.locator('[data-qa="given-name"]').fill('Ada');
  await page.locator('[data-qa="family-name"]').fill('Joiner');
  await page.locator('[data-qa="postcode"]').fill('LS6 2QT');
  await page.locator('[data-qa="review-order"]').click();
  // $34.50 + $12.25
  await page.locator('text=Items: $46.75').click();
});
