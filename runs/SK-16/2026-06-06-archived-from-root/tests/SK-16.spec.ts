import { test, expect } from '@playwright/test';

// SK-16 (Jira, Mode B) — complete checkout successfully.
// Spec: specs/SK-16.md · Cases: TC-001/002/003 · Risks: RISK-001/002/003.
// E2E-only: multi-step checkout journey (cart -> information -> overview ->
// complete) on a front-end-only app; no order API. Locators + behaviour
// verified live via the playwright-test MCP: login [data-test=username/
// password/login-button]; add [data-test=add-to-cart-sauce-labs-backpack];
// cart [data-test=shopping-cart-link]; [data-test=checkout]; info step
// (/checkout-step-one.html) [data-test=firstName/lastName/postalCode] +
// [data-test=continue] + [data-test=error]; overview
// (/checkout-step-two.html) [data-test=inventory-item-name] + [data-test=
// finish]; complete (/checkout-complete.html) [data-test=complete-header]
// = "Thank you for your order!". BASE_URL from playwright.config.ts.

test.describe('SK-16 checkout', () => {
  // Shared setup: log in and reach the checkout information step with a
  // known item (Sauce Labs Backpack) in the cart.
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-test="username"]').fill('standard_user');
    await page.locator('[data-test="password"]').fill('secret_sauce');
    await page.locator('[data-test="login-button"]').click();
    await expect(page).toHaveURL(/\/inventory\.html$/);

    await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
    await page.locator('[data-test="shopping-cart-link"]').click();
    await expect(page).toHaveURL(/\/cart\.html$/);
    await page.locator('[data-test="checkout"]').click();
    await expect(page).toHaveURL(/\/checkout-step-one\.html$/);
  });

  test('TC-001 complete checkout end-to-end shows the confirmation', async ({
    page,
  }) => {
    await page.locator('[data-test="firstName"]').fill('Test');
    await page.locator('[data-test="lastName"]').fill('User');
    await page.locator('[data-test="postalCode"]').fill('1000');
    await page.locator('[data-test="continue"]').click();
    await expect(page).toHaveURL(/\/checkout-step-two\.html$/);

    await page.locator('[data-test="finish"]').click();
    // RISK-001: the order completes with the confirmation message.
    await expect(page).toHaveURL(/\/checkout-complete\.html$/);
    await expect(page.locator('[data-test="complete-header"]')).toHaveText(
      'Thank you for your order!'
    );
  });

  test('TC-002 overview page shows the correct item', async ({ page }) => {
    await page.locator('[data-test="firstName"]').fill('Test');
    await page.locator('[data-test="lastName"]').fill('User');
    await page.locator('[data-test="postalCode"]').fill('1000');
    await page.locator('[data-test="continue"]').click();
    await expect(page).toHaveURL(/\/checkout-step-two\.html$/);

    // RISK-002: the overview lists exactly the product that was added.
    await expect(page.locator('[data-test="inventory-item-name"]')).toHaveText([
      'Sauce Labs Backpack',
    ]);
  });

  test('TC-003 information step blocks a missing required field', async ({
    page,
  }) => {
    await page.locator('[data-test="firstName"]').fill('Test');
    await page.locator('[data-test="lastName"]').fill('User');
    // Leave postal code empty.
    await page.locator('[data-test="continue"]').click();

    // RISK-003: a required field missing is rejected; overview not reached.
    await expect(page.locator('[data-test="error"]')).toHaveText(
      'Error: Postal Code is required'
    );
    await expect(page).toHaveURL(/\/checkout-step-one\.html$/);
  });
});
