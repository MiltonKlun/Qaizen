import { test, expect } from '@playwright/test';

// SK-10 (Jira, Mode B) — valid user login (happy path).
// Spec: specs/SK-10.md · Cases: TC-001, TC-002, TC-003 · Risks: RISK-001/002/003.
// Locators verified live via the playwright-test MCP on Saucedemo
// (stable [data-test=...] hooks). Happy-path only; negatives are SK-11/SK-12.
// BASE_URL is provided by playwright.config.ts (use.baseURL).

test.describe('SK-10 valid login', () => {
  test('TC-001 valid user logs in and reaches the inventory page', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('[data-test="username"]').fill('standard_user');
    await page.locator('[data-test="password"]').fill('secret_sauce');
    await page.locator('[data-test="login-button"]').click();

    // AC0/AC1, RISK-001/002: the journey reaches the inventory page.
    await expect(page).toHaveURL(/\/inventory\.html$/);
    await expect(page.locator('[data-test="login-button"]')).toHaveCount(0);
  });

  test('TC-002 inventory page shows the product list after login', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('[data-test="username"]').fill('standard_user');
    await page.locator('[data-test="password"]').fill('secret_sauce');
    await page.locator('[data-test="login-button"]').click();

    // AC1/AC2, RISK-002: the landing page actually renders the product list.
    await expect(page.locator('[data-test="title"]')).toHaveText('Products');
    await expect(
      page.locator('[data-test="inventory-item"]').first()
    ).toBeVisible();
    expect(
      await page.locator('[data-test="inventory-item"]').count()
    ).toBeGreaterThan(0);
  });

  test('TC-003 no error message is shown on a successful login', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('[data-test="username"]').fill('standard_user');
    await page.locator('[data-test="password"]').fill('secret_sauce');
    await page.locator('[data-test="login-button"]').click();

    // AC3, RISK-003: no error container appears on the success path.
    await expect(page).toHaveURL(/\/inventory\.html$/);
    await expect(page.locator('[data-test="error"]')).toHaveCount(0);
  });
});
