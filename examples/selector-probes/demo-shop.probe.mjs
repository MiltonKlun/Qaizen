// Reviewed selector-survival probes for the offline demo app
// (examples/demo-run/app/, served by examples/demo-run/serve.js).
//
// Each probe is the exact locator examples/demo-run/tests/demo-login.spec.ts
// relies on, checked against the running app, not written from the story
// text. `prepare` performs the same login the test does, so the inventory
// targets exist before the probes run. Every probe expects one usable target.
//
// Run (both versions here are the same app, which proves the probes resolve;
// point --version at a later build to measure drift):
//   node examples/demo-run/serve.js   # prints PORT <n>; run it twice
//   node scripts/selector-survival.js --probe examples/selector-probes/demo-shop.probe.mjs \
//     --baseline v1=http://127.0.0.1:<n1>/ --version v2=http://127.0.0.1:<n2>/

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Locator} Locator */
/**
 * @typedef {{ id: string, cardinality: 1, locate: (page: Page) => Locator,
 *   usable?: (locator: Locator) => Promise<boolean> }} Probe
 */

/**
 * @param {Page} page
 * @param {{ baseURL: string }} options
 */
export async function prepare(page, { baseURL }) {
  await page.goto(baseURL);
  await page.locator('[data-test="username"]').fill('demo');
  await page.locator('[data-test="password"]').fill('demo123');
  await page.locator('[data-test="login-button"]').click();
  await page.locator('[data-test="title"]').waitFor({ state: 'visible' });
}

/** @type {Probe[]} */
export const probes = [
  {
    id: 'inventory-title',
    locate: (page) => page.locator('[data-test="title"]'),
    cardinality: 1,
  },
  {
    // The test counts items; the list that holds them is the single target.
    id: 'inventory-list',
    locate: (page) => page.locator('[data-test="inventory-list"]'),
    cardinality: 1,
  },
  {
    id: 'logout-button',
    locate: (page) => page.getByRole('button', { name: 'Logout' }),
    cardinality: 1,
    usable: (locator) => locator.isEnabled(),
  },
];
