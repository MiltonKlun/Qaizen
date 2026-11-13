// @ts-check
// What a test file gets for `@playwright/test` during a recording run
// (hooks.js): everything the real module exports, except that `test`
// extends the `page` fixture so that, before each action a locator performs
// (click, fill, check, ...), the element it acts on is described: its
// accessible role and name (from Playwright's aria snapshot), its test id
// (`data-qa`, `data-test` or `data-testid`), and how many elements the
// locator matched. One JSON line per test goes to QAIZEN_TARGETS_OUT.
//
// Describing an element never fails the test: if it cannot be described in
// a few seconds, the action is recorded with what is known and runs as it
// would have.

import { appendFileSync } from 'node:fs';

import * as real from '@playwright/test';

import { roleAndName } from '../action-targets.js';

export * from '@playwright/test';

/** The locator methods that act on an element. */
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
/** At most this many actions are recorded per test. */
const MAX_ACTIONS = 200;

/** @type {any[] | null} the actions of the test now running */
let current = null;
let patched = false;

/**
 * What a locator acts on, as far as it can be told quickly.
 * @param {import('@playwright/test').Locator} locator
 */
async function describe(locator) {
  try {
    await locator.waitFor({ state: 'attached', timeout: 5000 });
  } catch {
    return { count: await locator.count().catch(() => null) };
  }
  const count = await locator.count().catch(() => null);
  if (count !== 1) return { count };
  const snapshot = await locator
    .ariaSnapshot({ timeout: 2000 })
    .catch(() => '');
  const testId = await locator
    .evaluate(
      (el) =>
        el.getAttribute('data-qa') ??
        el.getAttribute('data-test') ??
        el.getAttribute('data-testid')
    )
    .catch(() => null);
  return { count, ...roleAndName(snapshot), test_id: testId };
}

export const test = real.test.extend({
  page: async ({ page }, use, testInfo) => {
    if (!patched) {
      const proto = Object.getPrototypeOf(page.locator('body'));
      for (const method of ACTIONS) {
        const original = proto[method];
        if (typeof original !== 'function') continue;
        proto[method] = async function (/** @type {any[]} */ ...args) {
          if (current && current.length < MAX_ACTIONS)
            current.push({
              index: current.length,
              method,
              locator: String(this).slice(0, 200),
              ...(await describe(this)),
            });
          return original.apply(this, args);
        };
      }
      patched = true;
    }
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
            actions: current,
          }) + '\n'
        );
      current = null;
    }
  },
});

export default test;
