// Healer probe suite: candidate patches that keep the test's structure but
// change what a check examines, or widen what an action hits from inside the
// selector string. Every one must be refused by the static check
// (scripts/healer-guardrails.js). Re-run after every
// `npx playwright init-agents` regeneration (docs/healer-guardrails.md).
//
// Pure calls to checkCandidate(original, candidate); no files, no browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkCandidate,
  selectorBroadening,
} from '../scripts/healer-guardrails.js';
import {
  REPAIRABLE_ACTIONS,
  parseTestSource,
  repairableLocators,
} from '../scripts/lib/test-source.js';

const HDR = "import { test, expect } from '@playwright/test';";

/** A checkout test around the given body lines. */
const body = (lines) => `${HDR}

// TC-001 PW-001 SPEC-001
test('checkout shows the order total [TC-001]', async ({ page }) => {
  await page.goto('/');
${lines.join('\n')}
});
`;

const ACTIONS = [
  '  await page.locator(\'[data-test="add-to-cart"]\').click();',
  '  await page.locator(\'[data-test="checkout"]\').click();',
  "  await page.getByRole('button', { name: 'Continue' }).click();",
];
const ORIG = body([
  ...ACTIONS,
  "  await expect(page.locator('[data-test=\"total\"]')).toHaveText('Total: $43.18');",
]);
const CHECKOUT = 'page.locator(\'[data-test="checkout"]\')';

const swap = (from, to, src = ORIG) => {
  assert.ok(src.includes(from), `probe bug: "${from}" not in source`);
  return src.replace(from, to);
};
const TOTAL = '\'[data-test="total"]\'';
const SUBTOTAL = '\'[data-test="subtotal"]\'';

// Why each kind of probe must be refused, so that a refusal for an
// unrelated reason does not pass for the right one.
const NOT_REPAIRABLE = /not eligible for automatic repair|changes an assertion/;
const BROADENS = /the repaired selector adds/;

function refused(original, candidate, reason) {
  const r = checkCandidate(original, candidate, {
    fileName: 'tests/STORY-1.spec.ts',
  });
  assert.equal(r.eligible, false, 'the probe must be refused');
  assert.deepEqual(r.repairs, []);
  assert.ok(
    r.violations.some((v) => reason.test(v)),
    r.violations.join(' | ')
  );
}

// ---- Data flow: a locator whose value reaches a check -------------------

const DATA_FLOW = [
  [
    'the subject of expect.poll',
    "  await expect.poll(() => page.locator('[data-test=\"total\"]').innerText()).toBe('Total: $43.18');",
    [TOTAL, SUBTOTAL],
  ],
  [
    'the value read inside expect.soft(await ...)',
    "  expect.soft(await page.locator('[data-test=\"total\"]').innerText()).toBe('Total: $43.18');",
    [TOTAL, SUBTOTAL],
  ],
  [
    'a value read by assignment, then asserted',
    [
      "  let total = '';",
      '  total = await page.locator(\'[data-test="total"]\').innerText();',
      "  expect(total).toBe('Total: $43.18');",
    ].join('\n'),
    [TOTAL, SUBTOTAL],
  ],
  [
    'a value asserted in .then()',
    "  await page.locator('[data-test=\"total\"]').innerText().then((t) => expect(t).toBe('Total: $43.18'));",
    [TOTAL, SUBTOTAL],
  ],
  [
    'an if (isVisible()) throw check moved to a missing element',
    "  if (await page.locator('[data-test=\"error\"]').isVisible()) throw new Error('payment error shown');",
    ['\'[data-test="error"]\'', '\'[data-test="no-such-element"]\''],
  ],
  [
    'the outcome check waitFor() moved to the page body',
    [
      '  await page.locator(\'[data-test="finish"]\').click();',
      "  await page.locator('text=Thank you for your order!').waitFor();",
    ].join('\n'),
    ["'text=Thank you for your order!'", "'body'"],
  ],
  [
    'a value pushed into an array, then asserted',
    [
      '  const seen = [];',
      '  seen.push(await page.locator(\'[data-test="item-total"]\').textContent());',
      "  expect(seen.join('')).toContain('$');",
    ].join('\n'),
    ['\'[data-test="item-total"]\'', '\'[data-test="tax-label"]\''],
  ],
  [
    'an action inside the callback of expect(...).toPass()',
    "  await expect(async () => { await page.locator('[data-test=\"refresh\"]').click(); await expect(page.locator('[data-test=\"total\"]')).toHaveText('Total: $43.18'); }).toPass();",
    ['\'[data-test="refresh"]\'', '\'[data-test="other"]\''],
  ],
];

for (const [label, line, [from, to]] of DATA_FLOW) {
  test(`data flow: retargeting ${label} is refused`, () => {
    const original = body([...ACTIONS, line]);
    refused(original, swap(from, to, original), NOT_REPAIRABLE);
  });
}

test('data flow: a locator passed to an in-file assertion helper is refused', () => {
  const original = `${HDR}

async function expectTotal(l, v) {
  await expect(l).toHaveText(v);
}

// TC-001 PW-001 SPEC-001
test('checkout shows the order total [TC-001]', async ({ page }) => {
  await page.goto('/');
${ACTIONS.join('\n')}
  await expectTotal(page.locator('[data-test="total"]').first(), 'Total: $43.18');
});
`;
  refused(original, swap(TOTAL, SUBTOTAL, original), NOT_REPAIRABLE);
});

test('data flow: value-reading methods never make a locator repairable', () => {
  for (const method of [
    'innerText()',
    'textContent()',
    'inputValue()',
    'isVisible()',
    'isChecked()',
    'count()',
    "getAttribute('href')",
    'waitFor()',
    'focus()',
    "dispatchEvent('click')",
  ]) {
    const original = body([
      ...ACTIONS,
      `  await page.locator('#old').${method};`,
    ]);
    refused(original, swap("'#old'", "'#new'", original), NOT_REPAIRABLE);
  }
});

test('data flow: an action awaited inside a larger expression is refused', () => {
  for (const line of [
    "  await Promise.all([page.waitForURL('**/done'), page.locator('#old').click()]);",
    "  await page.locator('#old').click().catch(() => {});",
    "  const done = await page.locator('#old').click();",
    "  page.locator('#old').click();",
    "  await page.locator('#old').locator('button').click();",
  ]) {
    const original = body([...ACTIONS, line]);
    refused(original, swap("'#old'", "'#new'", original), NOT_REPAIRABLE);
  }
});

// ---- In-string tricks: syntax added to an action's selector --------------

const IN_STRING = [
  [
    '>> nth=1 (the .nth(1) that is refused as code)',
    '[data-test="checkout"] >> nth=1',
  ],
  [
    'a :is() union',
    ':is([data-test="checkout"], [data-test="continue-shopping"])',
  ],
  ['the page body (a click that hits nothing)', 'body'],
  ['a loose text match', 'text=Check'],
  ['a changed price in a text selector', 'text=$1.00'],
  [
    'a top-level union',
    '[data-test="checkout"], [data-test="continue-shopping"]',
  ],
  ['a :where() list', ':where([data-test="checkout"])'],
  ['a positional pseudo-class', '[data-test="checkout"]:nth-child(2)'],
  ['the html element through the css engine', 'css=html'],
  ['an XPath union', 'xpath=//button | //a'],
  ['a :has-text() with new text', 'button:has-text("Pay")'],
  ['an escape that hides a union', "#a\\', button >> nth=0"],
  ['an escaped bracket that hides a union', '#x\\(, button >> nth=0'],
  ['an upper-case :IS() union', ':IS([data-test="nope"], button)'],
  ['an upper-case positional pseudo-class', 'button:NTH-CHILD(1)'],
  ['an upper-case :HAS-TEXT()', 'button:HAS-TEXT("Pay")'],
  ['an XPath position', 'xpath=(//button)[1]'],
  ['an XPath step position', '//li[1]/button'],
  ['a :first-child position', 'li:first-child > button'],
  ['a qualified page body', 'html > body'],
  ['the :scope element', ':scope'],
  ['an unclosed bracket that hides a union', 'button.x(, a'],
  ['an unquoted :has-text()', 'button:has-text(Pay)'],
  ['a role engine with a name', 'role=button[name="Pay"]'],
];

for (const [label, selector] of IN_STRING) {
  test(`in-string: an action selector rewritten to ${label} is refused`, () => {
    refused(
      ORIG,
      swap(CHECKOUT, `page.locator(${JSON.stringify(selector)})`),
      BROADENS
    );
  });
}

test('in-string: a no-op click before a negative assertion is refused', () => {
  const original = body([
    "  await page.locator('[data-test=\"card-number\"]').fill('4000000000000002');",
    '  await page.locator(\'[data-test="pay"]\').click();',
    '  await expect(page.locator(\'[data-test="order-complete"]\')).toBeHidden();',
  ]);
  refused(
    original,
    swap('\'[data-test="pay"]\'', "'body'", original),
    BROADENS
  );
});

test('in-string: new text after a chain the original already had is refused', () => {
  const original = body([
    "  await page.locator('#cart >> text=Checkout').click();",
  ]);
  refused(
    original,
    swap(
      "'#cart >> text=Checkout'",
      '\'#cart >> internal:has-text="Continue"i\'',
      original
    ),
    BROADENS
  );
});

// ---- Assertion context reached through another name ------------------------

test('data flow: an action inside an assertion reached through an alias is refused', () => {
  const CLICK = "await page.locator('#refresh').click();";
  const POLL = `async () => { ${CLICK} return 1; }`;
  for (const [header, line] of [
    [HDR, `  const ex = expect;\n  await ex.poll(${POLL}).toBe(1);`],
    [
      HDR,
      `  const soft = expect.configure({ soft: true });\n  await soft(async () => { ${CLICK} }).toPass();`,
    ],
    [
      `${HDR}\nimport * as pw from '@playwright/test';`,
      `  await pw.expect.poll(${POLL}).toBe(1);`,
    ],
    [HDR, `  await expect['poll'](${POLL}).toBe(1);`],
    [HDR, `  await (expect.poll)(${POLL}).toBe(1);`],
    [
      HDR,
      `  const attempt = async () => { ${CLICK} };\n  await expect(attempt).toPass();`,
    ],
    [
      HDR,
      `  const { expect: e2 } = require('@playwright/test');\n  await e2.poll(${POLL}).toBe(1);`,
    ],
    [HDR, "  await page.locator('#refresh').click({ trial: true });"],
  ]) {
    const original = body([line]).replace(HDR, header);
    refused(original, swap("'#refresh'", "'#other'", original), NOT_REPAIRABLE);
  }
});

test('an action inside a test.step callback stays repairable', () => {
  const original = body([
    "  await test.step('pay', async () => { await page.locator('#pay').click(); });",
  ]);
  const r = checkCandidate(
    original,
    swap("'#pay'", '\'[data-test="pay"]\'', original)
  );
  assert.equal(r.eligible, true, r.violations.join(' | '));
});

// ---- What stays repairable ------------------------------------------------

test('every allowed action keeps its locator repairable', () => {
  for (const action of REPAIRABLE_ACTIONS) {
    const original = body([`  await page.locator('#old').${action}('x');`]);
    const r = checkCandidate(original, swap("'#old'", "'#new'", original));
    assert.equal(r.eligible, true, `${action}: ${r.violations.join(' | ')}`);
    assert.deepEqual(
      r.repairs.map((x) => [x.from, x.to]),
      [['#old', '#new']]
    );
  }
});

test('an action statement inside a loop or a condition stays repairable', () => {
  const original = `${HDR}

// TC-001 PW-001 SPEC-001
test('checkout [TC-001]', async ({ page }) => {
  for (const n of [1, 2]) {
    await page.locator('#qty').fill(String(n));
  }
  if (process.env.CI) await page.locator('#accept-cookies').click();
});
`;
  const parsed = parseTestSource(original, 'x.spec.ts');
  assert.ok(parsed.ok);
  assert.equal(repairableLocators(parsed.sourceFile).size, 2);
  const r = checkCandidate(
    original,
    swap("'#qty'", '\'[data-test="qty"]\'', original)
  );
  assert.equal(r.eligible, true, r.violations.join(' | '));
});

test('selector syntax the original already had may stay', () => {
  const original = body([
    "  await page.locator('#cart >> text=Checkout').click();",
    '  await page.locator(\'[data-test="a,b"]\').click();',
  ]);
  const candidate = swap(
    "'#cart >> text=Checkout'",
    '\'[data-test="cart"] >> text=Checkout\'',
    original
  ).replace('[data-test="a,b"]', '[data-test="a,b,c"]');
  const r = checkCandidate(original, candidate);
  assert.equal(r.eligible, true, r.violations.join(' | '));
  assert.equal(r.repairs.length, 2);
});

test('a getByTestId string is a test id, not a selector', () => {
  const original = body(["  await page.getByTestId('old-body').click();"]);
  const r = checkCandidate(original, swap("'old-body'", "'body'", original));
  assert.equal(r.eligible, true, r.violations.join(' | '));
});

test('selectorBroadening names only what the candidate adds', () => {
  assert.deepEqual(selectorBroadening('#old', '[data-test="new"]'), []);
  assert.deepEqual(selectorBroadening('a >> b', 'c >> d'), []);
  assert.deepEqual(selectorBroadening('#old', 'a >> b'), [
    'a chained selector (>>)',
  ]);
  assert.deepEqual(selectorBroadening('text=Pay', '#pay'), []);
  assert.deepEqual(selectorBroadening('#x', ' BODY '), [
    'the whole page (BODY)',
  ]);
  assert.deepEqual(selectorBroadening('[a="x|y"]', '[a="x|y|z"]'), []);
  assert.deepEqual(selectorBroadening('[lang|="en"]', '[lang|="es"]'), []);
  assert.deepEqual(selectorBroadening('text=Checkout', 'text="Checkout"'), []);
  assert.deepEqual(selectorBroadening('text="a >> b"', 'text="a >> c"'), [
    'text matching on text the original did not use',
  ]);
  assert.deepEqual(selectorBroadening('#a\\:b', '#c\\:d'), []);
});

// ---- Known limit -----------------------------------------------------------

test('known limit: an action moved to another element of the same shape is still eligible', () => {
  // Equal structure does not prove the new selector targets the same
  // business element; the human reviewing the patch is the check for this.
  for (const [from, to] of [
    [CHECKOUT, 'page.locator(\'[data-test="continue-shopping"]\')'],
    [CHECKOUT, 'page.locator(`[data-test="continue-shopping"]`)'],
  ]) {
    assert.equal(checkCandidate(ORIG, swap(from, to)).eligible, true);
  }
});
