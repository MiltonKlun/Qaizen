import { test, expect } from '@playwright/test';

// SK-13 (Jira, Mode B) — sort products by name and price.
// Spec: specs/SK-13.md · Cases: TC-001..TC-005 · Risks: RISK-001/002/003.
// E2E-only: Saucedemo sorts client-side (no backend sort API). Locators
// verified live via the playwright-test MCP: sort control is a <select>
// [data-test="product-sort-container"] (az/za/lohi/hilo); names
// [data-test="inventory-item-name"]; prices [data-test="inventory-item-price"]
// ($NN.NN); active selection text [data-test="active-option"].
// BASE_URL comes from playwright.config.ts.
//
// Assertions use web-first forms (toHaveText / expect.poll) so they
// auto-retry rather than reading a value once (playwright/prefer-web-first).

test.describe('SK-13 product sorting', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-test="username"]').fill('standard_user');
    await page.locator('[data-test="password"]').fill('secret_sauce');
    await page.locator('[data-test="login-button"]').click();
    await expect(page).toHaveURL(/\/inventory\.html$/);
  });

  test('TC-001 sort Name (A to Z) orders names ascending', async ({ page }) => {
    const names = page.locator('[data-test="inventory-item-name"]');
    await page
      .locator('[data-test="product-sort-container"]')
      .selectOption('az');
    // RISK-001: the rendered order must match true ascending alphabetical.
    const observed = await names.allTextContents();
    const expected = [...observed].sort((a, b) => a.localeCompare(b));
    await expect(names).toHaveText(expected);
  });

  test('TC-002 sort Name (Z to A) orders names descending', async ({
    page,
  }) => {
    const names = page.locator('[data-test="inventory-item-name"]');
    await page
      .locator('[data-test="product-sort-container"]')
      .selectOption('za');
    const observed = await names.allTextContents();
    const expected = [...observed].sort((a, b) => b.localeCompare(a));
    await expect(names).toHaveText(expected);
  });

  test('TC-003 sort Price (low to high) orders prices ascending', async ({
    page,
  }) => {
    await page
      .locator('[data-test="product-sort-container"]')
      .selectOption('lohi');
    // RISK-002: compare as NUMBERS, not strings, to catch "$10 before $9".
    // expect.poll auto-retries the read until the sorted order settles.
    await expect
      .poll(async () => {
        const raw = await page
          .locator('[data-test="inventory-item-price"]')
          .allTextContents();
        const nums = raw.map((s) => parseFloat(s.replace(/[^0-9.]/g, '')));
        return nums.every((v, i) => i === 0 || v >= nums[i - 1]);
      })
      .toBe(true);
  });

  test('TC-004 sort Price (high to low) orders prices descending', async ({
    page,
  }) => {
    await page
      .locator('[data-test="product-sort-container"]')
      .selectOption('hilo');
    await expect
      .poll(async () => {
        const raw = await page
          .locator('[data-test="inventory-item-price"]')
          .allTextContents();
        const nums = raw.map((s) => parseFloat(s.replace(/[^0-9.]/g, '')));
        return nums.every((v, i) => i === 0 || v <= nums[i - 1]);
      })
      .toBe(true);
  });

  test('TC-005 selected sort option remains visible as the active selection', async ({
    page,
  }) => {
    await page
      .locator('[data-test="product-sort-container"]')
      .selectOption('lohi');
    // RISK-003: the control reflects the chosen option, not the default.
    await expect(page.locator('[data-test="active-option"]')).toHaveText(
      'Price (low to high)'
    );
    await expect(
      page.locator('[data-test="product-sort-container"]')
    ).toHaveValue('lohi');
  });
});
