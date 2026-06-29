// Generated Playwright test for STORY-010 — Cart badge reflects item count.
// Traceability: SPEC specs/STORY-010.md → TC-001..TC-004 → RISK-001..RISK-003.
// Authored against the running SauceDemo app (locators observed live via
// Playwright MCP — data-test attributes, not brittle CSS). CLAUDE.md §3.8.
import { test, expect, type Page } from '@playwright/test';

const APP = 'https://www.saucedemo.com';

async function login(page: Page): Promise<void> {
  await page.goto(`${APP}/`);
  await page.locator('[data-test="username"]').fill('standard_user');
  await page.locator('[data-test="password"]').fill('secret_sauce');
  await page.locator('[data-test="login-button"]').click();
  await expect(page).toHaveURL(/.*inventory\.html/);
}

const badge = (page: Page) => page.locator('[data-test="shopping-cart-badge"]');

test.beforeEach(async ({ page }) => {
  await login(page);
  // Precondition: empty cart → no badge (AC-1 baseline).
  await expect(badge(page)).toHaveCount(0);
});

// TC-001 (RISK-001): badge appears showing "1" after adding one product.
test('TC-001: cart badge appears showing 1 after adding one product @smoke', async ({
  page,
}) => {
  await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
  await expect(badge(page)).toBeVisible();
  await expect(badge(page)).toHaveText('1');
});

// TC-002 (RISK-001): badge shows "2" after adding two distinct products.
test('TC-002: cart badge shows 2 after adding two distinct products @regression', async ({
  page,
}) => {
  await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
  await page.locator('[data-test="add-to-cart-sauce-labs-bike-light"]').click();
  await expect(badge(page)).toHaveText('2');
});

// TC-003 (RISK-002): remove decrements; badge disappears when cart is empty.
test('TC-003: cart badge decrements on remove and disappears at empty @smoke', async ({
  page,
}) => {
  await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
  await page.locator('[data-test="add-to-cart-sauce-labs-bike-light"]').click();
  await expect(badge(page)).toHaveText('2');

  await page.locator('[data-test="remove-sauce-labs-backpack"]').click();
  await expect(badge(page)).toHaveText('1');

  await page.locator('[data-test="remove-sauce-labs-bike-light"]').click();
  // Absence assertion — the badge must be gone, not show "0" (AC-3).
  await expect(badge(page)).toHaveCount(0);
});

// TC-004 (RISK-003): count survives navigation to the cart page and back.
test('TC-004: cart badge count survives navigation to cart and back @regression', async ({
  page,
}) => {
  await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
  await page.locator('[data-test="add-to-cart-sauce-labs-bike-light"]').click();
  await expect(badge(page)).toHaveText('2');

  await page.locator('[data-test="shopping-cart-link"]').click();
  await expect(page).toHaveURL(/.*cart\.html/);
  await page.locator('[data-test="continue-shopping"]').click();
  await expect(page).toHaveURL(/.*inventory\.html/);

  await expect(badge(page)).toHaveText('2');
});
