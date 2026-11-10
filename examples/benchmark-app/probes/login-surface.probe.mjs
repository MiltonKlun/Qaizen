// Reviewed selector-survival probes for the Bench Shop login surface
// (scripts/selector-survival.js --probe). A benchmark
// probe, not a test: it is typechecked (tsconfig.json) and run by
// `npm run benchmark:check`, never by the Playwright suite.
//
// Five locators on the sign-in screen, as the exact functions a test would
// call, checked against the v1 baseline of the running app. `prepare` opens
// the landing page, where the sign-in screen is the only screen rendered, so
// each hook has one visible target.
//
// In v2, `login-user`/`login-pass` were renamed to `signin-user`/`signin-pass`
// and the `.heading` class became `.screen-heading` (README.md, drift table).

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
  await page.locator('[data-qa="login-submit"]').waitFor({ state: 'visible' });
}

/** @type {Probe[]} */
export const probes = [
  {
    id: 'user-hook',
    locate: (page) => page.locator('[data-qa="login-user"]'),
    cardinality: 1,
  },
  {
    id: 'pass-hook',
    locate: (page) => page.locator('[data-qa="login-pass"]'),
    cardinality: 1,
  },
  {
    id: 'submit-hook',
    locate: (page) => page.locator('[data-qa="login-submit"]'),
    cardinality: 1,
    usable: (locator) => locator.isEnabled(),
  },
  {
    id: 'heading-hook',
    locate: (page) => page.locator('[data-qa="page-heading"]'),
    cardinality: 1,
  },
  {
    id: 'heading-class',
    locate: (page) => page.locator('.heading'),
    cardinality: 1,
  },
];
