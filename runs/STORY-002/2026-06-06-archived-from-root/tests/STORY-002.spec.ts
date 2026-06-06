// spec: specs/STORY-002.md
// seed: tests/seed.spec.ts

import { test, expect } from '@playwright/test';

test.describe('STORY-002: Account access (E2E)', () => {
  // SPEC-001: Happy-path login — TC-001 (Linked TC: TC-001, Linked RISK: RISK-001)
  test('SPEC-001: happy-path login redirects to inventory', async ({
    page,
  }) => {
    test.info().annotations.push({ type: 'TC', description: 'TC-001' });
    test.info().annotations.push({ type: 'RISK', description: 'RISK-001' });

    const baseURL = process.env.BASE_URL ?? '';
    // eslint-disable-next-line playwright/no-skipped-test -- environmental skip with explicit reason, not a hidden failure
    test.skip(baseURL === '', 'BASE_URL env var not set');

    // 1. Navigate to BASE_URL.
    await page.goto(baseURL);

    // 2. Fill the Username field using [data-test='username'] with 'standard_user'.
    await page.locator('[data-test="username"]').fill('standard_user');
    await expect(page.locator('[data-test="username"]')).toHaveValue(
      'standard_user'
    );

    // 3. Fill the Password field using [data-test='password'] with 'secret_sauce'.
    await page.locator('[data-test="password"]').fill('secret_sauce');
    await expect(page.locator('[data-test="password"]')).toHaveValue(
      'secret_sauce'
    );

    // 4. Click the Login button using [data-test='login-button'].
    await page.locator('[data-test="login-button"]').click();

    // 5. Assert URL changes to /inventory.html.
    await expect(page).toHaveURL(/\/inventory\.html$/);

    // 6. Assert at least one inventory item is visible — confirms the grid rendered.
    await expect(
      page.locator('[data-test="inventory-item"]').first()
    ).toBeVisible();
  });

  // SPEC-002: Invalid-password rejection — TC-002 (Linked TC: TC-002, Linked RISK: RISK-001)
  test('SPEC-002: invalid password is rejected with no session', async ({
    page,
  }) => {
    test.info().annotations.push({ type: 'TC', description: 'TC-002' });
    test.info().annotations.push({ type: 'RISK', description: 'RISK-001' });

    const baseURL = process.env.BASE_URL ?? '';
    // eslint-disable-next-line playwright/no-skipped-test -- environmental skip with explicit reason, not a hidden failure
    test.skip(baseURL === '', 'BASE_URL env var not set');

    // 1. Navigate to BASE_URL. Starts from a clean browser context with no pre-existing session.
    await page.goto(baseURL);

    // 2. Fill the Username field using [data-test='username'] with 'standard_user'.
    await page.locator('[data-test="username"]').fill('standard_user');
    await expect(page.locator('[data-test="username"]')).toHaveValue(
      'standard_user'
    );

    // 3. Fill the Password field using [data-test='password'] with 'wrong-password'.
    await page.locator('[data-test="password"]').fill('wrong-password');
    await expect(page.locator('[data-test="password"]')).toHaveValue(
      'wrong-password'
    );

    // 4. Click the Login button using [data-test='login-button'].
    await page.locator('[data-test="login-button"]').click();

    // 5. Assert URL did NOT change — user is still on the login page.
    await expect(page).toHaveURL(/^https:\/\/www\.saucedemo\.com\/?$/);

    // 6. Assert the error banner [data-test='error'] is visible with the exact verbatim rejection message.
    await expect(page.locator('[data-test="error"]')).toBeVisible();
    await expect(page.locator('[data-test="error"]')).toHaveText(
      /Epic sadface: Username and password do not match any user in this service/
    );

    // 7. RISK-001 assertion: no session was created. Saucedemo sets a 'session-username' cookie
    //    ONLY after a successful login. Its absence after a failed login is the authoritative
    //    proof that no session was created.
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === 'session-username')).toBeUndefined();
  });
});
