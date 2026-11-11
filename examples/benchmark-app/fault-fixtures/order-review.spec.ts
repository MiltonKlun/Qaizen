// Fault-check fixtures for BENCH-2 (examples/benchmark-app/stories/BENCH-2.md):
// one test that checks the Items figure against the line prices, and one
// that reaches the same screen and checks nothing. `npm run benchmark:check`
// requires the first to kill the wrong-item-total bug and the second to be
// flagged as a weak oracle (scripts/lib/fault-check.js).

import { test, expect, type Page } from '@playwright/test';

const qa = (page: Page, hook: string) => page.locator(`[data-qa="${hook}"]`);
const cents = (text: string) => {
  const m = /\$(\d+)\.(\d{2})/.exec(text);
  if (!m) throw new Error(`no amount in "${text}"`);
  return Number(m[1]) * 100 + Number(m[2]);
};

async function reachReview(page: Page) {
  await page.goto('/');
  await page.getByLabel('Workshop ID').fill('ada.joiner');
  await page.getByLabel('Passphrase').fill('dovetail-42');
  await qa(page, 'login-submit').click();
  await qa(page, 'basket-add-chisel-set').click();
  await qa(page, 'basket-add-marking-gauge').click();
  await qa(page, 'basket-link').click();
  await qa(page, 'go-to-checkout').click();
  await page.getByLabel('Given name').fill('Ada');
  await page.getByLabel('Family name').fill('Joiner');
  await page.getByLabel('Postcode').fill('LS6 2QT');
  await qa(page, 'review-order').click();
}

test('the Items figure is the sum of the line prices [TC-002]', async ({
  page,
}) => {
  await reachReview(page);
  const lines = (await qa(page, 'product-price').allTextContents()).map(cents);
  const items = cents((await qa(page, 'sum-items').textContent()) ?? '');
  expect(items).toBe(lines.reduce((a, b) => a + b, 0));
});

test('the review shows the Items figure [TC-004]', async ({ page }) => {
  await reachReview(page);
  await qa(page, 'place-order').click();
});
