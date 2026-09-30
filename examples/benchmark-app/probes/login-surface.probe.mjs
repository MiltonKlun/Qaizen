// Reviewed selector-survival probes for the Bench Shop login surface
// (scripts/selector-survival.js --probe; task groups 9.1, 9.2). A benchmark
// probe, not a test: it is typechecked (tsconfig.json) and run by
// `npm run benchmark:check`, never by the Playwright suite.
//
// The same five locators the old login.survival-probe.spec.ts listed, now as
// the exact functions a test would call, checked against the v1 baseline of
// the running app. `prepare` opens the landing page, where the login screen is the only
// screen rendered, so each hook has one visible target.
//
// In v2, `username`/`password` were renamed to `user-name`/`pass-word` and
// the `.title` class became `.page-title` (README.md, drift table).

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
  await page
    .locator('[data-test="login-button"]')
    .waitFor({ state: 'visible' });
}

/** @type {Probe[]} */
export const probes = [
  {
    id: 'username-test-id',
    locate: (page) => page.locator('[data-test="username"]'),
    cardinality: 1,
  },
  {
    id: 'password-test-id',
    locate: (page) => page.locator('[data-test="password"]'),
    cardinality: 1,
  },
  {
    id: 'login-button-test-id',
    locate: (page) => page.locator('[data-test="login-button"]'),
    cardinality: 1,
    usable: (locator) => locator.isEnabled(),
  },
  {
    id: 'title-test-id',
    locate: (page) => page.locator('[data-test="title"]'),
    cardinality: 1,
  },
  {
    id: 'title-class',
    locate: (page) => page.locator('.title'),
    cardinality: 1,
  },
];
