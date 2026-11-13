// @ts-check
// What a test file gets for `@playwright/test` during a recording run
// (hooks.js): everything the real module exports, except that `test`
// extends the `page` fixture so that, before each action (a locator's click,
// fill, check, ..., or the same called on the page with a selector), the
// element it acts on is described: its accessible role and name (from
// Playwright's aria snapshot), its test id (`data-qa`, `data-test` or
// `data-testid`), its text, how many elements the locator matched, and where
// it stands among the elements that share its role and name (or, without a
// name, its text). One JSON line per test goes to QAIZEN_TARGETS_OUT, with
// how the test ended.
//
// Describing an element never fails the test: if it cannot be described in
// a few seconds, the action is recorded with what is known and runs as it
// would have. The recording run's test timeout is doubled, so the waits
// added here do not push a tight test past it.

import { appendFileSync } from 'node:fs';

import * as real from '@playwright/test';

import { roleAndName } from '../action-targets.js';

export * from '@playwright/test';

/** The methods that act on an element. */
const ACTIONS = [
  'click',
  'dblclick',
  'tap',
  'hover',
  'fill',
  'clear',
  'type',
  'press',
  'pressSequentially',
  'check',
  'uncheck',
  'setChecked',
  'selectOption',
  'setInputFiles',
];
/** Actions whose element may be hidden by design. */
const ATTACHED_ONLY = new Set(['setInputFiles', 'selectOption']);
/** At most this many actions are recorded per test. */
const MAX_ACTIONS = 200;
/** Longest name or text kept. */
const MAX_TEXT = 200;

/** @type {any[] | null} the actions of the test now running */
let current = null;
/** True while an action runs: an action Playwright calls inside it is not another. */
let inAction = false;
let patched = false;

/** @param {string | null | undefined} s */
const cap = (s) =>
  typeof s === 'string'
    ? s.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
    : null;

/**
 * What a locator acts on, as far as it can be told quickly.
 * @param {import('@playwright/test').Locator} locator
 * @param {string} method
 */
async function describe(locator, method) {
  try {
    await locator.waitFor({
      state: ATTACHED_ONLY.has(method) ? 'attached' : 'visible',
      timeout: 5000,
    });
  } catch {
    return { count: await locator.count().catch(() => null) };
  }
  const count = await locator.count().catch(() => null);
  if (count !== 1) return { count };
  const snapshot = await locator
    .ariaSnapshot({ timeout: 2000 })
    .catch(() => '');
  const { role, name } = roleAndName(snapshot);
  /** @type {{ test_id: string | null, text: string | null }} */
  const own = await locator
    .evaluate((el) => ({
      test_id:
        el.getAttribute('data-qa') ??
        el.getAttribute('data-test') ??
        el.getAttribute('data-testid'),
      text: el.textContent,
    }))
    .catch(() => ({ test_id: null, text: null }));
  const text = cap(own.text);
  // Where it stands among the elements that look the same to a reader: those
  // sharing its role and name, or, without a name, its exact text.
  const page = locator.page();
  const peers =
    role && name
      ? page.getByRole(/** @type {any} */ (role), { name, exact: true })
      : text
        ? page.getByText(text, { exact: true })
        : null;
  /** @type {number | null} */
  let sameCount = null;
  /** @type {number | null} */
  let sameIndex = null;
  if (peers) {
    const handle = await locator.elementHandle().catch(() => null);
    if (handle) {
      sameCount = await peers.count().catch(() => null);
      sameIndex = await peers
        .evaluateAll(
          (els, target) => els.indexOf(/** @type {any} */ (target)),
          handle
        )
        .catch(() => null);
      await handle.dispose().catch(() => {});
    }
  }
  return {
    count,
    role,
    name: cap(name),
    test_id: own.test_id,
    text,
    same_count: sameCount,
    same_index: sameIndex === -1 ? null : sameIndex,
  };
}

/**
 * Wrap one action method so that it records its target first.
 * @param {any} proto
 * @param {string} method
 * @param {(self: any, args: any[]) => import('@playwright/test').Locator | null} target
 */
function wrap(proto, method, target) {
  const original = proto[method];
  if (typeof original !== 'function') return;
  proto[method] = async function (/** @type {any[]} */ ...args) {
    if (!current || inAction) return original.apply(this, args);
    inAction = true;
    try {
      const locator = target(this, args);
      if (locator && current.length < MAX_ACTIONS)
        current.push({
          index: current.length,
          method,
          locator: String(locator).slice(0, 200),
          ...(await describe(locator, method)),
        });
      return await original.apply(this, args);
    } finally {
      inAction = false;
    }
  };
}

export const test = real.test.extend({
  page: async ({ page }, use, testInfo) => {
    if (!patched) {
      const locatorProto = Object.getPrototypeOf(page.locator('body'));
      const pageProto = Object.getPrototypeOf(page);
      for (const method of ACTIONS) {
        wrap(locatorProto, method, (self) => self);
        // page.click(selector, ...) and the like: the selector names it.
        wrap(pageProto, method, (self, args) =>
          typeof args[0] === 'string' ? self.locator(args[0]) : null
        );
      }
      patched = true;
    }
    testInfo.setTimeout(testInfo.timeout * 2);
    current = [];
    try {
      await use(page);
    } finally {
      const out = process.env.QAIZEN_TARGETS_OUT;
      if (out)
        appendFileSync(
          out,
          JSON.stringify({
            test_title: testInfo.titlePath.join(' > '),
            project: testInfo.project.name,
            repeat_index: testInfo.repeatEachIndex,
            // Whether the test had failed by the end of its page: if so, its
            // actions stop at the one that failed.
            passed: !testInfo.errors.length,
            actions: current,
          }) + '\n'
        );
      current = null;
    }
  },
});

export default test;
