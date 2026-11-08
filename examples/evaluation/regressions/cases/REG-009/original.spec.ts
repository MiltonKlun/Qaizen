// spec: specs/BENCH-1.md
// TC-001 · RISK-001 · PW-001: the basket count goes down right after a take-out.
// Run against Bench Shop v1 with --bug stale-badge (see README.md).

import { test } from '@playwright/test';

test('TC-001: The basket count goes down right after a take-out', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Workshop ID').fill('ada.joiner');
  await page.getByLabel('Passphrase').fill('dovetail-42');
  await page.locator('[data-qa="login-submit"]').click();
  await page.locator('[data-qa="basket-add-chisel-set"]').click();
  await page.locator('[data-qa="basket-add-marking-gauge"]').click();
  await page.locator('[data-qa="basket-link"]').click();
  await page.locator('[data-qa="basket-remove-chisel-set"]').click();
  // Two products, one taken out: the count reads 1 without changing screen.
  await page.locator('[data-qa="basket-count"]:text-is("1")').waitFor();
});
