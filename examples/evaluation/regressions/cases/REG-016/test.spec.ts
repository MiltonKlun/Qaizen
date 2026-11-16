// spec: specs/BENCH-2.md (SPEC-001)
// BENCH-2: checkout and order review on Bench Shop v1. Each test names its
// case (TC-XXX) and its id (PW-XXX).

import { test, expect, type Page } from '@playwright/test';

const qa = (page: Page, hook: string) => page.locator(`[data-qa="${hook}"]`);

/** A price as the review shows it ("Items: $46.75"), in cents. */
const cents = (text: string) => {
  const m = /\$(\d+)\.(\d{2})/.exec(text);
  if (!m) throw new Error(`no amount in "${text}"`);
  return Number(m[1]) * 100 + Number(m[2]);
};
const amount = async (page: Page, hook: string) =>
  cents((await qa(page, hook).textContent()) ?? '');

async function toCheckout(page: Page) {
  await page.goto('/');
  await page.getByLabel('Workshop ID').fill('ada.joiner');
  await page.getByLabel('Passphrase').fill('dovetail-42');
  await qa(page, 'login-submit').click();
  await qa(page, 'basket-add-chisel-set').click();
  await qa(page, 'basket-add-marking-gauge').click();
  await qa(page, 'basket-link').click();
  await qa(page, 'go-to-checkout').click();
}

async function reachReview(page: Page) {
  await toCheckout(page);
  await page.getByLabel('Given name').fill('Ada');
  await page.getByLabel('Family name').fill('Joiner');
  await page.getByLabel('Postcode').fill('LS6 2QT');
  await qa(page, 'review-order').click();
  await expect(qa(page, 'page-heading')).toHaveText('Review your order');
}

test('TC-001 · PW-001: complete delivery details reach the review listing both products', async ({
  page,
}) => {
  await reachReview(page);
  await expect(qa(page, 'product-name')).toHaveText([
    'Bevel-Edge Chisel Set',
    'Brass Marking Gauge',
  ]);
});

test('TC-002 · PW-002: the Items figure is the sum of the listed prices', async ({
  page,
}) => {
  await reachReview(page);
  const prices = (await qa(page, 'product-price').allTextContents()).map(cents);
  expect(prices).toHaveLength(2);
  expect(await amount(page, 'sum-items')).toBe(
    prices.reduce((a, b) => a + b, 0)
  );
});

test('TC-003 · PW-003: the Order total is Items plus Sales tax', async ({
  page,
}) => {
  await reachReview(page);
  const items = await amount(page, 'sum-items');
  const tax = await amount(page, 'sum-tax');
  expect(await amount(page, 'sum-total')).toBe(items + tax);
});

test('TC-004 · PW-004: delivery details without a postcode are refused', async ({
  page,
}) => {
  await toCheckout(page);
  await page.getByLabel('Given name').fill('Ada');
  await page.getByLabel('Family name').fill('Joiner');
  await qa(page, 'review-order').click();
  await expect(qa(page, 'form-error')).toHaveText('Please enter a postcode.');
  await expect(qa(page, 'page-heading')).toHaveText('Delivery details');
});

test('TC-005 · PW-005: placing the order confirms it and clears the basket count', async ({
  page,
}) => {
  await reachReview(page);
  await qa(page, 'place-order').click();
  await expect(qa(page, 'page-heading')).toHaveText('Order placed');
  await expect(qa(page, 'order-confirmed')).toHaveText(
    'Your order is on its way to the workshop.'
  );
});
