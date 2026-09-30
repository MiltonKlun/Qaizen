// Bench Shop versions: the ONLY differences between the served versions
// (task group 9.2). Everything else — the router, the cart, the bug switches,
// the money math — is shared in shop.js, so the versions cannot drift apart
// by accident. v2 is v1 with realistic DOM drift; README.md lists every change
// as the ground truth for selector_survival_rate.
//
// A classic browser script (it only assigns a global), also imported by
// serve.js to know which versions exist.

globalThis.BENCH_VERSIONS = {
  v1: {
    titleClass: 'title',
    priceClass: 'item_price',
    hooks: {
      username: 'username',
      password: 'password',
      price: 'inventory-item-price',
      add: 'add-to-cart',
    },
    overview: (lines) => `<div id="overview">${lines}</div>`,
    // One element per figure. Before task group 9.2 each row also carried a
    // separate visible label ("Item total:", "Tax:", "Total:") repeating the
    // figure's own text, so getByText('Item total:') matched two elements and
    // a text-based locator failed strictness for a reason no real app had.
    summary: (itemTotal, tax, total) =>
      [
        '<div class="summary_info">',
        '            <div class="summary_row">',
        `              <span data-test="subtotal-label">Item total: ${itemTotal}</span>`,
        '            </div>',
        '            <div class="summary_row">',
        `              <span data-test="tax-label">Tax: ${tax}</span>`,
        '            </div>',
        '            <div class="summary_row">',
        `              <span data-test="total-label">Total: ${total}</span>`,
        '            </div>',
        '          </div>',
      ].join('\n'),
  },
  v2: {
    titleClass: 'page-title',
    priceClass: 'price-tag',
    hooks: {
      username: 'user-name',
      password: 'pass-word',
      price: 'item-cost',
      add: 'add',
    },
    overview: (lines) => `<section id="overview">${lines}</section>`,
    summary: (itemTotal, tax, total) =>
      [
        '<ul class="summary-list">',
        '            <li class="summary-line">',
        `              <span data-test="summary-subtotal">Item total: ${itemTotal}</span>`,
        '            </li>',
        '            <li class="summary-line">',
        `              <span data-test="tax-label">Tax: ${tax}</span>`,
        '            </li>',
        '            <li class="summary-line">',
        `              <span data-test="total-label">Total: ${total}</span>`,
        '            </li>',
        '          </ul>',
      ].join('\n'),
  },
};
