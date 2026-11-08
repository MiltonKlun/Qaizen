// spec: specs/BENCH-1.md
// TC-003 · RISK-001 · PW-003: adding a product shows it in the basket count.
// Written against Bench Shop v1; run against v2 (see README.md).

import { test, expect } from '@playwright/test';

test('TC-003: Adding a product shows it in the basket count', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Workshop ID').fill('ada.joiner');
  await page.getByLabel('Passphrase').fill('dovetail-42');
  await page.locator('[data-qa="login-submit"]').click();
  await page.locator('[data-qa="basket-add-chisel-set"]').click();
  await expect(page.locator('[data-qa="basket-count"]')).toHaveText('1');
});
