// spec: specs/STORY-001.md
// seed: tests/seed.spec.ts

import { test, expect } from '@playwright/test';

test.describe('STORY-001: Login slice', () => {
  // SPEC-001: Happy-path login — TC-001 (Linked TC: TC-001, Linked RISK: RISK-001)
  test('SPEC-001: happy-path login redirects to inventory', async ({
    page,
  }) => {
    test.info().annotations.push({ type: 'TC', description: 'TC-001' });
    test.info().annotations.push({ type: 'RISK', description: 'RISK-001' });

    const baseURL = process.env.BASE_URL ?? '';
    // eslint-disable-next-line playwright/no-skipped-test -- environmental skip with explicit reason, not a hidden failure
    test.skip(baseURL === '', 'BASE_URL env var not set');

    // 1. Navigate to BASE_URL. Confirm the login form is visible.
    await page.goto(baseURL);
    await expect(page.getByRole('textbox', { name: 'Username' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Password' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();

    // 2. Fill the Username textbox with 'standard_user'.
    await page.getByRole('textbox', { name: 'Username' }).fill('standard_user');
    await expect(page.getByRole('textbox', { name: 'Username' })).toHaveValue(
      'standard_user'
    );

    // 3. Fill the Password textbox with 'secret_sauce'.
    await page.getByRole('textbox', { name: 'Password' }).fill('secret_sauce');
    await expect(page.getByRole('textbox', { name: 'Password' })).toHaveValue(
      'secret_sauce'
    );

    // 4. Click the Login button.
    await page.getByRole('button', { name: 'Login' }).click();

    // 5. Assert URL changes to /inventory.html.
    await expect(page).toHaveURL(/\/inventory\.html$/);

    // 6. Assert at least one inventory item is visible — Sauce Labs Backpack confirms the grid rendered.
    await expect(
      page.getByRole('link', { name: 'Sauce Labs Backpack' }).first()
    ).toBeVisible();

    // 7. Assert the page heading area contains 'Products'.
    await expect(page.locator('[data-test="title"]')).toHaveText('Products');
  });

  // SPEC-002: Invalid-password rejection — TC-002 (Linked TC: TC-002, Linked RISK: RISK-001)
  test('SPEC-002: invalid password is rejected with error banner', async ({
    page,
  }) => {
    test.info().annotations.push({ type: 'TC', description: 'TC-002' });
    test.info().annotations.push({ type: 'RISK', description: 'RISK-001' });

    const baseURL = process.env.BASE_URL ?? '';
    // eslint-disable-next-line playwright/no-skipped-test -- environmental skip with explicit reason, not a hidden failure
    test.skip(baseURL === '', 'BASE_URL env var not set');

    // 1. Navigate to BASE_URL. Confirm login form is visible and no error is present.
    await page.goto(baseURL);
    await expect(page.getByRole('textbox', { name: 'Username' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Password' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
    await expect(page.locator('[data-test="error"]')).toBeHidden();

    // 2. Fill the Username textbox with 'standard_user'.
    await page.getByRole('textbox', { name: 'Username' }).fill('standard_user');
    await expect(page.getByRole('textbox', { name: 'Username' })).toHaveValue(
      'standard_user'
    );

    // 3. Fill the Password textbox with a deliberately wrong value: 'wrong-password'.
    await page
      .getByRole('textbox', { name: 'Password' })
      .fill('wrong-password');
    await expect(page.getByRole('textbox', { name: 'Password' })).toHaveValue(
      'wrong-password'
    );

    // 4. Click the Login button.
    await page.getByRole('button', { name: 'Login' }).click();

    // 5. Assert URL is still at the root — page did NOT navigate to /inventory.html.
    await expect(page).toHaveURL(/^https:\/\/www\.saucedemo\.com\/?$/);

    // 6. Assert the error heading is visible with the exact verbatim rejection message.
    await expect(
      page.getByRole('heading', {
        name: /Epic sadface: Username and password do not match any user in this service/,
      })
    ).toBeVisible();

    // 7. RISK-001 assertion: no session was created. Saucedemo stores the
    //    session as a cookie named "session-username" that gets set ONLY
    //    after a successful login. The cookie's absence is the strongest
    //    "no partial session" signal on this backend-less app.
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === 'session-username')).toBeUndefined();

    // 8. UX assertion (NOT a session check): form fields retain their
    //    entered values so the user does not have to retype on rejection.
    await expect(page.getByRole('textbox', { name: 'Username' })).toHaveValue(
      'standard_user'
    );
    await expect(page.getByRole('textbox', { name: 'Password' })).toHaveValue(
      'wrong-password'
    );
  });
});
