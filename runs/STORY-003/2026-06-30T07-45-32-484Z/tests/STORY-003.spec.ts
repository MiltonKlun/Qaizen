// spec: specs/STORY-003.md
// TC-001 (P0, RISK-001): badge decrements in-place without reload or navigation
// TC-002 (P1, RISK-002): badge element absent from DOM when cart is empty
// TC-003 (P2, RISK-001, RISK-002): badge count correct across subsequent navigation after in-place decrement

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function login(page: Page): Promise<void> {
  await page.goto('https://www.saucedemo.com');
  await page.locator('[data-test="username"]').fill('standard_user');
  await page.locator('[data-test="password"]').fill('secret_sauce');
  await page.locator('[data-test="login-button"]').click();
  await expect(page).toHaveURL('https://www.saucedemo.com/inventory.html');
}

test.describe('Cart Badge Decrement Bug (STORY-003)', () => {
  test('TC-001 [P0 RISK-001] Remove item decrements badge in-place without reload or navigation', async ({
    page,
  }) => {
    // 1. Navigate to https://www.saucedemo.com and log in with username 'standard_user' and password 'secret_sauce'
    await login(page);
    await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveCount(
      0
    );

    // 2. Click [data-test='add-to-cart-sauce-labs-backpack'] to add the Sauce Labs Backpack
    await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
    await expect(
      page.locator('[data-test="remove-sauce-labs-backpack"]')
    ).toBeVisible();
    await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveText(
      '1'
    );

    // 3. Click [data-test='add-to-cart-sauce-labs-bike-light'] to add the Sauce Labs Bike Light
    await page
      .locator('[data-test="add-to-cart-sauce-labs-bike-light"]')
      .click();
    await expect(
      page.locator('[data-test="remove-sauce-labs-bike-light"]')
    ).toBeVisible();
    await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveText(
      '2'
    );

    // 4. Click the cart link [data-test='shopping-cart-link'] to navigate to the cart page
    await page.locator('[data-test="shopping-cart-link"]').click();
    await expect(page).toHaveURL('https://www.saucedemo.com/cart.html');
    await expect(page.getByText('Your Cart')).toBeVisible();
    await expect(
      page.locator('[data-test="inventory-item-name"]', {
        hasText: 'Sauce Labs Backpack',
      })
    ).toBeVisible();
    await expect(
      page.locator('[data-test="inventory-item-name"]', {
        hasText: 'Sauce Labs Bike Light',
      })
    ).toBeVisible();
    await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveText(
      '2'
    );

    // 5. On the cart page, click [data-test='remove-sauce-labs-backpack'] to remove the Sauce Labs Backpack
    await page.locator('[data-test="remove-sauce-labs-backpack"]').click();
    await expect(
      page.locator('[data-test="inventory-item-name"]', {
        hasText: 'Sauce Labs Backpack',
      })
    ).toHaveCount(0);
    await expect(
      page.locator('[data-test="inventory-item-name"]', {
        hasText: 'Sauce Labs Bike Light',
      })
    ).toBeVisible();

    // 6. WITHOUT navigating or reloading — while still on /cart.html — assert the badge shows '1'
    await expect(
      page.locator('[data-test="shopping-cart-badge"]')
    ).toBeVisible();
    await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveText(
      '1'
    );
    await expect(page).toHaveURL('https://www.saucedemo.com/cart.html');
  });

  test('TC-002 [P1 RISK-002] Empty cart hides the badge element entirely', async ({
    page,
  }) => {
    // 1. Navigate to https://www.saucedemo.com and log in
    await login(page);
    await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveCount(
      0
    );

    // 2. Click [data-test='add-to-cart-sauce-labs-backpack'] to add exactly one item
    await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
    await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveText(
      '1'
    );

    // 3. Click [data-test='shopping-cart-link'] to open the cart page
    await page.locator('[data-test="shopping-cart-link"]').click();
    await expect(page).toHaveURL('https://www.saucedemo.com/cart.html');
    await expect(
      page.locator('[data-test="inventory-item-name"]', {
        hasText: 'Sauce Labs Backpack',
      })
    ).toBeVisible();
    await expect(
      page.locator('[data-test="remove-sauce-labs-backpack"]')
    ).toBeVisible();
    await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveText(
      '1'
    );

    // 4. Click [data-test='remove-sauce-labs-backpack'] to remove the only item
    await page.locator('[data-test="remove-sauce-labs-backpack"]').click();
    await expect(
      page.locator('[data-test="inventory-item-name"]', {
        hasText: 'Sauce Labs Backpack',
      })
    ).toHaveCount(0);

    // 5. WITHOUT navigating or reloading — assert the badge element is ABSENT from the DOM (not '0')
    await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveCount(
      0
    );
    await expect(page).toHaveURL('https://www.saucedemo.com/cart.html');
  });

  test('TC-003 [P2 RISK-001 RISK-002] Badge count is correct across subsequent navigation after in-place decrement', async ({
    page,
  }) => {
    // 1. Navigate to https://www.saucedemo.com and log in
    await login(page);
    await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveCount(
      0
    );

    // 2. Add backpack and bolt t-shirt; verify badge increments to 1 then 2
    await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
    await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveText(
      '1'
    );
    await page
      .locator('[data-test="add-to-cart-sauce-labs-bolt-t-shirt"]')
      .click();
    await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveText(
      '2'
    );
    await expect(
      page.locator('[data-test="remove-sauce-labs-backpack"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-test="remove-sauce-labs-bolt-t-shirt"]')
    ).toBeVisible();

    // 3. Click [data-test='shopping-cart-link'] to navigate to the cart page
    await page.locator('[data-test="shopping-cart-link"]').click();
    await expect(page).toHaveURL('https://www.saucedemo.com/cart.html');
    await expect(
      page.locator('[data-test="inventory-item-name"]', {
        hasText: 'Sauce Labs Backpack',
      })
    ).toBeVisible();
    await expect(
      page.locator('[data-test="inventory-item-name"]', {
        hasText: 'Sauce Labs Bolt T-Shirt',
      })
    ).toBeVisible();
    await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveText(
      '2'
    );

    // 4. Click [data-test='remove-sauce-labs-backpack'] to remove the Sauce Labs Backpack
    await page.locator('[data-test="remove-sauce-labs-backpack"]').click();
    await expect(
      page.locator('[data-test="inventory-item-name"]', {
        hasText: 'Sauce Labs Backpack',
      })
    ).toHaveCount(0);
    await expect(
      page.locator('[data-test="inventory-item-name"]', {
        hasText: 'Sauce Labs Bolt T-Shirt',
      })
    ).toBeVisible();

    // 5. BEFORE any navigation — assert badge shows '1' in-place (critical: self-corrects on reload)
    await expect(
      page.locator('[data-test="shopping-cart-badge"]')
    ).toBeVisible();
    await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveText(
      '1'
    );
    await expect(page).toHaveURL('https://www.saucedemo.com/cart.html');

    // 6. Click [data-test='continue-shopping'] to navigate to the inventory page
    await page.locator('[data-test="continue-shopping"]').click();
    await expect(page).toHaveURL('https://www.saucedemo.com/inventory.html');
    await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveText(
      '1'
    );
    await expect(
      page.locator('[data-test="add-to-cart-sauce-labs-backpack"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-test="remove-sauce-labs-bolt-t-shirt"]')
    ).toBeVisible();

    // 7. Click [data-test='shopping-cart-link'] to navigate back to the cart page
    await page.locator('[data-test="shopping-cart-link"]').click();
    await expect(page).toHaveURL('https://www.saucedemo.com/cart.html');
    await expect(page.locator('[data-test="shopping-cart-badge"]')).toHaveText(
      '1'
    );
    await expect(
      page.locator('[data-test="inventory-item-name"]', {
        hasText: 'Sauce Labs Bolt T-Shirt',
      })
    ).toBeVisible();
    await expect(
      page.locator('[data-test="remove-sauce-labs-bolt-t-shirt"]')
    ).toBeVisible();
  });
});
