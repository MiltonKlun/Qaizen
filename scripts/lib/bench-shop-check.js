// @ts-check
// The seeded-bug half of `npm run benchmark:check`: drive one purchase through
// the Bench Shop (examples/benchmark-app/) in a browser, clean and with each
// bug switched on, and check that every bug changes exactly the symptom it is
// documented to change and nothing else. A bug that no longer toggles would
// make known_bug_catch_rate measure nothing.
//
// observePurchase needs a Playwright page; bugProblems is pure.

/** @typedef {import('@playwright/test').Page} Page */

/** The seeded bugs (examples/benchmark-app/README.md, bug switches). */
export const BUGS = ['stale-badge', 'wrong-item-total', 'inconsistent-total'];

/**
 * What one purchase showed. Money is in cents.
 * @typedef {{ countAfterAdds: number, countAfterTakeOut: number,
 *   countAfterMoving: number, lines: number[], items: number, tax: number,
 *   total: number }} Observation
 */

/** @param {string} text e.g. "Items: $46.75" */
export function cents(text) {
  const m = /\$(\d+)\.(\d{2})/.exec(text);
  if (!m) throw new Error(`no amount in "${text}"`);
  return Number(m[1]) * 100 + Number(m[2]);
}

/** Sales tax as the README states it: 6.5% of the items, half up. */
export const salesTax = (/** @type {number} */ itemsCents) =>
  Math.floor((itemsCents * 650 + 5000) / 10000);

/**
 * One purchase on the v1 hooks: sign in, put two products in the basket,
 * take one out, move on, put it back, check out.
 * @param {Page} page
 * @param {string} baseURL
 * @returns {Promise<Observation>}
 */
export async function observePurchase(page, baseURL) {
  const qa = (/** @type {string} */ hook) =>
    page.locator(`[data-qa="${hook}"]`);
  const count = async () => {
    const text = (await qa('basket-count').textContent())?.trim() ?? '';
    return text ? Number(text) : 0;
  };
  await page.goto(baseURL);
  await qa('login-user').fill('ada.joiner');
  await qa('login-pass').fill('dovetail-42');
  await qa('login-submit').click();
  await qa('basket-add-chisel-set').click();
  await qa('basket-add-marking-gauge').click();
  const countAfterAdds = await count();
  await qa('basket-link').click();
  await qa('basket-remove-chisel-set').click();
  const countAfterTakeOut = await count();
  await qa('keep-shopping').click();
  await qa('basket-add-chisel-set').waitFor();
  const countAfterMoving = await count();
  await qa('basket-add-chisel-set').click();
  await qa('basket-link').click();
  await qa('go-to-checkout').click();
  await qa('given-name').fill('Ada');
  await qa('family-name').fill('Joiner');
  await qa('postcode').fill('LS6 2QT');
  await qa('review-order').click();
  await qa('place-order').waitFor();
  const lines = (await qa('product-price').allTextContents()).map(cents);
  return {
    countAfterAdds,
    countAfterTakeOut,
    countAfterMoving,
    lines,
    items: cents((await qa('sum-items').textContent()) ?? ''),
    tax: cents((await qa('sum-tax').textContent()) ?? ''),
    total: cents((await qa('sum-total').textContent()) ?? ''),
  };
}

/**
 * What is wrong with the observations: the clean run must be correct, and
 * each bug must show its own symptom and leave the rest as the clean run
 * showed it.
 * @param {Record<string, Observation>} seen keyed by "clean" and bug id
 * @returns {string[]} empty when every bug toggles as documented
 */
export function bugProblems(seen) {
  /** @type {string[]} */
  const problems = [];
  const clean = seen.clean;
  if (!clean) return ['no clean run'];
  const sum = clean.lines.reduce((a, b) => a + b, 0);
  // Both products reach the review: the take-out and put-back worked.
  if (clean.lines.length !== 2)
    problems.push(
      `clean: the review lists ${clean.lines.length} line(s), expected 2`
    );
  const expectClean = {
    countAfterAdds: 2,
    countAfterTakeOut: 1,
    countAfterMoving: 1,
    items: sum,
    tax: salesTax(sum),
    total: sum + salesTax(sum),
  };
  for (const [k, v] of Object.entries(expectClean))
    if (clean[/** @type {keyof Observation} */ (k)] !== v)
      problems.push(
        `clean: ${k} is ${JSON.stringify(clean[/** @type {keyof Observation} */ (k)])}, expected ${v}`
      );

  /** Each bug's symptom, and the fields it may change. */
  const symptom = {
    'stale-badge': {
      fields: ['countAfterTakeOut'],
      shows: (/** @type {Observation} */ o) => o.countAfterTakeOut === 2,
      what: 'the basket count still reads 2 right after a take-out',
    },
    'wrong-item-total': {
      fields: ['items', 'total'],
      shows: (/** @type {Observation} */ o) =>
        o.items === sum + 100 && o.total === o.items + o.tax,
      what: 'Items is the sum of the lines plus $1.00, and the total follows it',
    },
    'inconsistent-total': {
      fields: ['total'],
      shows: (/** @type {Observation} */ o) => o.total === o.items + o.tax + 50,
      what: 'the Order total is Items + Sales tax + $0.50',
    },
  };
  for (const bug of BUGS) {
    const o = seen[bug];
    if (!o) {
      problems.push(`${bug}: not observed`);
      continue;
    }
    const s = symptom[/** @type {keyof typeof symptom} */ (bug)];
    if (!s.shows(o))
      problems.push(`${bug}: does not show its symptom (${s.what})`);
    for (const k of /** @type {(keyof Observation)[]} */ (Object.keys(clean))) {
      if (s.fields.includes(k)) continue;
      if (JSON.stringify(o[k]) !== JSON.stringify(clean[k]))
        problems.push(
          `${bug}: changes ${k} (${JSON.stringify(o[k])}, clean ${JSON.stringify(clean[k])}), which it should leave alone`
        );
    }
  }
  return problems;
}
