// Bench Shop versions: the ONLY differences between the served versions.
// Everything else — the router, the basket, the bug switches,
// the money math — is shared in shop.js, so the versions cannot drift apart
// by accident. v2 is v1 with realistic DOM drift; README.md lists every change
// as the ground truth for selector_survival_rate.
//
// A classic browser script (it only assigns a global), also imported by
// serve.js to know which versions exist.

globalThis.BENCH_VERSIONS = {
  v1: {
    headingClass: 'heading',
    priceClass: 'price',
    hooks: {
      user: 'login-user',
      pass: 'login-pass',
      price: 'product-price',
      add: 'basket-add',
    },
    review: (lines) => `<div id="review-lines">${lines}</div>`,
    // One element per figure, its label in its own text, so a text locator
    // for "Items:" matches one element.
    summary: (items, tax, total) =>
      [
        '<div class="order-sums">',
        '            <div class="sum-row">',
        `              <span data-qa="sum-items">Items: ${items}</span>`,
        '            </div>',
        '            <div class="sum-row">',
        `              <span data-qa="sum-tax">Sales tax: ${tax}</span>`,
        '            </div>',
        '            <div class="sum-row">',
        `              <span data-qa="sum-total">Order total: ${total}</span>`,
        '            </div>',
        '          </div>',
      ].join('\n'),
  },
  v2: {
    headingClass: 'screen-heading',
    priceClass: 'cost',
    hooks: {
      user: 'signin-user',
      pass: 'signin-pass',
      price: 'unit-price',
      add: 'put-in',
    },
    review: (lines) => `<section id="review-lines">${lines}</section>`,
    summary: (items, tax, total) =>
      [
        '<table class="order-table">',
        '            <tr class="order-line">',
        `              <td data-qa="items-sum">Items: ${items}</td>`,
        '            </tr>',
        '            <tr class="order-line">',
        `              <td data-qa="sum-tax">Sales tax: ${tax}</td>`,
        '            </tr>',
        '            <tr class="order-line">',
        `              <td data-qa="sum-total">Order total: ${total}</td>`,
        '            </tr>',
        '          </table>',
      ].join('\n'),
  },
};
