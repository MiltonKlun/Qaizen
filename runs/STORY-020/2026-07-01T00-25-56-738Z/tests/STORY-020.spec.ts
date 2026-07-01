// spec: specs/STORY-020.md
// TC-001..TC-005, RISK-001..RISK-004
// Verified live against https://www.saucedemo.com on 2026-06-30

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Typed helpers
// ---------------------------------------------------------------------------

/** Log in and add both items to the cart. Ends on /inventory.html. */
async function loginAndAddItems(page: Page): Promise<void> {
  await page.goto('https://www.saucedemo.com');
  await page.locator('[data-test="username"]').fill('standard_user');
  await page.locator('[data-test="password"]').fill('secret_sauce');
  await page.locator('[data-test="login-button"]').click();
  await expect(page).toHaveURL(/inventory\.html/);
  await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
  await page.locator('[data-test="add-to-cart-sauce-labs-bike-light"]').click();
}

/** Navigate from inventory through cart → Information → Overview. Ends on /checkout-step-two.html. */
async function reachOverview(page: Page): Promise<void> {
  await loginAndAddItems(page);
  await page.locator('[data-test="shopping-cart-link"]').click();
  await expect(page).toHaveURL(/cart\.html/);
  await page.locator('[data-test="checkout"]').click();
  await expect(page).toHaveURL(/checkout-step-one\.html/);
  await page.locator('[data-test="firstName"]').fill('Jane');
  await page.locator('[data-test="lastName"]').fill('Tester');
  await page.locator('[data-test="postalCode"]').fill('90210');
  await page.locator('[data-test="continue"]').click();
  await expect(page).toHaveURL(/checkout-step-two\.html/);
}

/**
 * Parse the dollar amount that follows the last "$" in a label's text.
 * e.g. "Item total: $39.98" → 39.98
 */
function parseDollarAmount(text: string): number {
  const match = text.match(/\$(\d+\.\d+)/);
  if (!match) {
    throw new Error(`Could not parse dollar amount from: "${text}"`);
  }
  return parseFloat(match[1]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('STORY-020 — Checkout Order Summary', () => {
  // TC-001 (P0 · RISK-004): Two-item checkout reaches the Overview step
  test('TC-001: Two-item checkout reaches the Overview step', async ({
    page,
  }) => {
    // 1. Log in, add Sauce Labs Backpack and Sauce Labs Bike Light to cart
    await loginAndAddItems(page);

    // 2. Verify cart badge shows 2
    await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveText(
      '2'
    );

    // 3. Open cart
    await page.locator('[data-test="shopping-cart-link"]').click();
    await expect(page).toHaveURL(/cart\.html/);

    // 4. Verify both items are in the cart
    await expect(
      page
        .locator('[data-test="inventory-item-name"]')
        .filter({ hasText: 'Sauce Labs Backpack' })
    ).toBeVisible();
    await expect(
      page
        .locator('[data-test="inventory-item-name"]')
        .filter({ hasText: 'Sauce Labs Bike Light' })
    ).toBeVisible();

    // 5. Click Checkout and fill Information step
    await page.locator('[data-test="checkout"]').click();
    await expect(page).toHaveURL(/checkout-step-one\.html/);

    await page.locator('[data-test="firstName"]').fill('Jane');
    await page.locator('[data-test="lastName"]').fill('Tester');
    await page.locator('[data-test="postalCode"]').fill('90210');

    // 6. Click Continue — should reach Overview
    await page.locator('[data-test="continue"]').click();
    await expect(page).toHaveURL(
      'https://www.saucedemo.com/checkout-step-two.html'
    );
    await expect(page.locator('[data-test="title"]')).toHaveText(
      'Checkout: Overview'
    );

    // 7. Verify both item names appear on the Overview page
    await expect(
      page
        .locator('[data-test="inventory-item-name"]')
        .filter({ hasText: 'Sauce Labs Backpack' })
    ).toBeVisible();
    await expect(
      page
        .locator('[data-test="inventory-item-name"]')
        .filter({ hasText: 'Sauce Labs Bike Light' })
    ).toBeVisible();
  });

  // TC-002 (P0 · RISK-001): Item total equals sum of individual unit prices
  test('TC-002: Item total equals sum of individual unit prices', async ({
    page,
  }) => {
    // Shared setup: reach the Overview page
    await reachOverview(page);
    await expect(page.locator('[data-test="title"]')).toHaveText(
      'Checkout: Overview'
    );

    // Read all unit price elements and sum them (integer-cent arithmetic)
    const priceLocator = page.locator('[data-test="inventory-item-price"]');
    const priceTexts = await priceLocator.allTextContents();
    const sumCents = priceTexts.reduce((acc, txt) => {
      return acc + Math.round(parseDollarAmount(txt) * 100);
    }, 0);

    // Read the rendered subtotal label and parse its dollar amount
    const subtotalText =
      (await page.locator('[data-test="subtotal-label"]').textContent()) ?? '';
    const subtotalCents = Math.round(parseDollarAmount(subtotalText) * 100);

    // Assert: parsed item-total must exactly equal the computed sum of unit prices
    expect(subtotalCents).toBe(sumCents);
  });

  // TC-003 (P0 · RISK-002): Total equals Item total plus Tax
  test('TC-003: Total equals Item total plus Tax', async ({ page }) => {
    // Shared setup: reach the Overview page
    await reachOverview(page);
    await expect(page.locator('[data-test="title"]')).toHaveText(
      'Checkout: Overview'
    );

    // Read each label's text content and parse dollar amounts
    const subtotalText =
      (await page.locator('[data-test="subtotal-label"]').textContent()) ?? '';
    const taxText =
      (await page.locator('[data-test="tax-label"]').textContent()) ?? '';
    const totalText =
      (await page.locator('[data-test="total-label"]').textContent()) ?? '';

    const subtotalCents = Math.round(parseDollarAmount(subtotalText) * 100);
    const taxCents = Math.round(parseDollarAmount(taxText) * 100);
    const totalCents = Math.round(parseDollarAmount(totalText) * 100);

    // Assert: total must equal subtotal + tax to the cent — no hard-coded numbers
    expect(totalCents).toBe(subtotalCents + taxCents);
  });

  // TC-004 (P1 · RISK-003): Missing Zip/Postal Code blocks checkout and shows error
  test('TC-004: Missing Zip blocks checkout and shows validation error', async ({
    page,
  }) => {
    // Setup: log in, add items, open cart, click Checkout to reach Information step
    await loginAndAddItems(page);
    await page.locator('[data-test="shopping-cart-link"]').click();
    await page.locator('[data-test="checkout"]').click();
    await expect(page).toHaveURL(/checkout-step-one\.html/);

    // Fill First Name and Last Name but leave Postal Code empty
    await page.locator('[data-test="firstName"]').fill('Jane');
    await page.locator('[data-test="lastName"]').fill('Tester');
    // [data-test="postalCode"] is intentionally left empty

    // Click Continue
    await page.locator('[data-test="continue"]').click();

    // Assert: URL must remain on step-one (no navigation)
    await expect(page).toHaveURL(
      'https://www.saucedemo.com/checkout-step-one.html'
    );

    // Assert: error element is visible with the correct message
    const errorLocator = page.locator('[data-test="error"]');
    await expect(errorLocator).toBeVisible();
    await expect(errorLocator).toHaveText('Error: Postal Code is required');
  });

  // TC-005 (P1 · RISK-004): Clicking Finish completes the order and clears the cart
  test('TC-005: Finish completes order and clears the cart badge', async ({
    page,
  }) => {
    // Shared setup: reach the Overview page
    await reachOverview(page);
    await expect(page.locator('[data-test="title"]')).toHaveText(
      'Checkout: Overview'
    );

    // Click Finish
    await page.locator('[data-test="finish"]').click();

    // Assert: URL navigates to complete page
    await expect(page).toHaveURL(
      'https://www.saucedemo.com/checkout-complete.html'
    );

    // Assert: confirmation header is visible with exact text
    const completeHeader = page.locator('[data-test="complete-header"]');
    await expect(completeHeader).toBeVisible();
    await expect(completeHeader).toHaveText('Thank you for your order!');

    // Assert: cart badge is not present in the DOM (count === 0 means absent)
    await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveCount(
      0
    );
  });
});
