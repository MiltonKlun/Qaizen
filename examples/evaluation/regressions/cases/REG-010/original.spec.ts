// spec: specs/BENCH-1.md
// TC-002 · RISK-002 · PW-002: emptying the basket hides the basket count.
// Written against Bench Shop v1; run against v2 (see README.md).

import { test, expect } from '@playwright/test';

test('TC-002: Taking out the last product hides the basket count', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Workshop ID').fill('ada.joiner');
  await page.getByLabel('Passphrase').fill('dovetail-42');
  await page.locator('[data-qa="login-submit"]').click();
  await page.locator('[data-qa="basket-add-chisel-set"]').click();
  await page.locator('[data-qa="basket-link"]').click();
  await page.locator('[data-qa="basket-remove-chisel-set"]').click();
  await expect(page.locator('[data-qa="basket-count"]')).toBeHidden();
});
