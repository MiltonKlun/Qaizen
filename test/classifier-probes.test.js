// Failure-classification probes: Red-adjacent failures that must never be
// Green, and the controls that must keep their verdict.
//
// Green is the only severity that makes a failure eligible for the Healer, so
// each probe below is a route by which a wrong price, a payment step, a login
// or an outcome check could reach an automatic repair. The messages follow
// the exact format of test/fixtures/playwright-classification.json (real
// Chromium output, colour codes included).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GREEN_ACTIONS,
  classifyPlaywrightUnit,
  systemicFailure,
  valueBearing,
} from '../scripts/lib/classify-failure.js';
import { REPAIRABLE_ACTIONS } from '../scripts/lib/test-source.js';
import { redDomainsInText, words } from '../scripts/red-domains.js';

const DIM = (s) => `\u001b[2m${s}\u001b[22m`;
const actionTimeout = (op, locator) =>
  `TimeoutError: ${op}: Timeout 1000ms exceeded.\nCall log:\n${DIM(`  - waiting for ${locator}`)}\n`;
const unit = (title, ...messages) => ({
  unit_id: 'u1',
  outcome: 'failed',
  identity: {
    kind: 'playwright',
    test_title: title,
    file: 'tests/S.spec.ts',
    project: 'chromium',
  },
  attempts: messages.map((m) => ({ status: 'failed', error_message: m })),
});
const click = (title, locator) =>
  unit(title, actionTimeout('locator.click', locator));
const verdict = (u, run) => {
  const c = classifyPlaywrightUnit(u, run);
  return `${c.severity}/${c.classification}`;
};

// --- the audit's sixteen probes ---------------------------------------------

/** [id, what it is, unit, expected severity, reason it must give] */
const PROBES = [
  [
    'C1',
    'payment action, camelCase locator',
    click('TC-003 Place order [TC-003]', "locator('#submitPayment')"),
    'yellow',
    /Red domain\(s\): .*payment/,
  ],
  [
    'C2',
    'login action',
    click(
      'TC-001 log in as standard user [TC-001]',
      'locator(\'[data-test="login-button"]\')'
    ),
    'yellow',
    /Red domain\(s\): security/,
  ],
  [
    'C3',
    'promo flow: a product bug hides the next button',
    click(
      'TC-004 apply promo code SAVE10 [TC-004]',
      "getByRole('button', { name: 'Proceed' })"
    ),
    'yellow',
    /Red domain\(s\): pricing/,
  ],
  [
    'C4',
    'a business value encoded in an action locator',
    click(
      'TC-002 cart shows the item amount [TC-002]',
      "locator('text=$29.99')"
    ),
    'yellow',
    /finds its element by text content/,
  ],
  [
    'C5',
    'an outcome check through locator.waitFor',
    unit(
      'TC-005 order summary [TC-005]',
      actionTimeout(
        'locator.waitFor',
        "locator('text=Thank you for your order!') to be visible"
      )
    ),
    'yellow',
    /locator\.waitFor reads or waits for something/,
  ],
  [
    'C6',
    '"subtotal"',
    click(
      'TC-006 subtotal updates after removing an item [TC-006]',
      "locator('#subtotal-refresh')"
    ),
    'yellow',
    /Red domain\(s\): business_logic/,
  ],
  [
    'C7',
    'a Spanish payment test',
    click('TC-007 pagar con tarjeta [TC-007]', "getByTestId('pagar')"),
    'yellow',
    /Red domain\(s\): payment/,
  ],
  [
    'C8',
    'control: admin keyword',
    click(
      'TC-008 viewer cannot open the admin page [TC-008]',
      "getByTestId('nav')"
    ),
    'yellow',
    /Red domain\(s\): permission_role/,
  ],
  [
    'C9',
    'destructive action: delete account',
    click('TC-009 delete account [TC-009]', "getByTestId('delete-account')"),
    'yellow',
    /Red domain\(s\): data_integrity/,
  ],
  [
    'C10',
    'an innerText read that feeds an assertion',
    unit(
      'TC-010 order summary [TC-010]',
      actionTimeout('locator.innerText', 'locator(\'[data-test="sum"]\')')
    ),
    'yellow',
    /locator\.innerText reads or waits for something/,
  ],
  [
    'C11',
    'control: "submits the payment"',
    click('submits the payment', "getByTestId('pay-now')"),
    'yellow',
    /Red domain\(s\): payment/,
  ],
  [
    'C12',
    'control: a custom expect message worded like an action error',
    unit(
      'TC-012 order total [TC-012]',
      'Error: locator.click: Timeout 1000ms exceeded\n\n' +
        `${DIM('expect(')}received${DIM(').')}toBe${DIM('(')}expected${DIM(') // Object.is equality')}\n\nExpected: "$43.18"\nReceived: "$1.00"`
    ),
    'red',
    /a wrong business value is Red/,
  ],
  [
    'C13',
    'test code rethrows with action wording (caught by its domain)',
    click('TC-013 order confirmation [TC-013]', "locator('#confirm')"),
    'yellow',
    /Red domain\(s\): pricing/,
  ],
  [
    'C14',
    'transfer funds',
    click(
      'TC-014 transfer funds between accounts [TC-014]',
      "getByTestId('transfer-submit')"
    ),
    'yellow',
    /Red domain\(s\): payment/,
  ],
  [
    'C15',
    'control: checkout keyword',
    click('TC-015 checkout [TC-015]', "getByTestId('continue')"),
    'yellow',
    /Red domain\(s\): pricing/,
  ],
  [
    'C16',
    'two failed attempts on order history',
    unit(
      'TC-016 open order history [TC-016]',
      actionTimeout('locator.click', "getByTestId('orders')"),
      actionTimeout('locator.click', "getByTestId('orders')")
    ),
    'yellow',
    /Red domain\(s\): pricing/,
  ],
];

for (const [id, what, u, severity, reason] of PROBES) {
  test(`probe ${id} (${what}) is ${severity}, with its reason`, () => {
    const c = classifyPlaywrightUnit(u);
    assert.equal(c.severity, severity, c.reason);
    assert.match(c.reason, reason);
  });
}

// --- value reads and value-bearing locators -----------------------------------

test('a timeout on an operation that reads or waits is never Green', () => {
  for (const op of [
    'waitFor',
    'innerText',
    'textContent',
    'inputValue',
    'isVisible',
    'count',
    'getAttribute',
    'innerHTML',
    'allTextContents',
  ]) {
    const c = classifyPlaywrightUnit(
      unit(
        'opens the help panel',
        actionTimeout(`locator.${op}`, "getByTestId('help-toggle')")
      )
    );
    assert.equal(
      `${c.severity}/${c.classification}`,
      'yellow/unknown_needs_human_review',
      op
    );
  }
});

test('only the actions the Healer may repair can be Green, and the lists match', () => {
  assert.deepEqual([...GREEN_ACTIONS].sort(), [...REPAIRABLE_ACTIONS].sort());
  for (const op of GREEN_ACTIONS) {
    assert.equal(
      verdict(
        unit(
          'opens the help panel',
          actionTimeout(`locator.${op}`, "getByTestId('help-toggle')")
        )
      ),
      'green/locator_or_selector',
      op
    );
  }
  // Not a locator: page.click(selector) and frame actions are not repairable.
  assert.equal(
    verdict(
      unit(
        'opens the help panel',
        actionTimeout('page.click', "locator('#help')")
      )
    ),
    'yellow/unknown_needs_human_review'
  );
});

test('a locator that finds its element by text, a number or a price is not Green', () => {
  for (const [locator, why] of [
    ["locator('text=Continue')", /text content/],
    ["getByText('Continue')", /text content/],
    ['locator(\'button:has-text("Continue")\')', /text content/],
    ["locator('#cart').getByText('$5.00')", /text content/],
    ["getByRole('button', { name: 'Remove 2 items' })", /a number/],
    ["getByLabel('Quantity 3')", /a number/],
    ['locator(\'[data-price="$5"]\')', /a price/],
    ['locator(\'[title="€10"]\')', /a price/],
  ]) {
    const c = classifyPlaywrightUnit(click('opens the help panel', locator));
    assert.equal(c.severity, 'yellow', locator);
    assert.match(c.reason, why, locator);
  }
});

test('a test id or a role name without numbers stays Green', () => {
  for (const locator of [
    "getByTestId('step-2')",
    'locator(\'[data-test="item-4"]\')',
    "getByRole('button', { name: 'Open help' })",
    "locator('#help-toggle')",
  ]) {
    assert.equal(
      verdict(click('opens the help panel', locator)),
      'green/locator_or_selector',
      locator
    );
    assert.equal(valueBearing(locator), null, locator);
  }
});

// --- what the run knows ------------------------------------------------------

test('a failure on a case linked to a high-severity or Red-domain risk is not Green', () => {
  const u = click('opens the help panel', "getByTestId('help-toggle')");
  const high = classifyPlaywrightUnit(u, {
    risks: [{ risk_id: 'RISK-001', severity: 'high', description: 'x' }],
  });
  assert.equal(high.severity, 'yellow');
  assert.match(high.reason, /covers high-severity RISK-001/);
  const red = classifyPlaywrightUnit(u, {
    risks: [
      {
        risk_id: 'RISK-002',
        severity: 'low',
        description: 'el saldo queda mal',
      },
    ],
  });
  assert.equal(red.severity, 'yellow');
  assert.match(red.reason, /RISK-002, a Red domain \(business_logic\)/);
  assert.equal(
    verdict(u, {
      risks: [{ risk_id: 'RISK-003', severity: 'low', description: 'tooltip' }],
    }),
    'green/locator_or_selector'
  );
});

test('Green is refused when most of the run failed; one failure is never systemic', () => {
  const pw = (outcome) => ({ identity: { kind: 'playwright' }, outcome });
  const nm = (outcome) => ({ identity: { kind: 'newman' }, outcome });
  assert.equal(systemicFailure([pw('failed')]), null);
  assert.equal(systemicFailure([pw('failed'), pw('passed')]), null);
  assert.equal(
    systemicFailure([pw('failed'), pw('failed'), pw('passed'), pw('passed')]),
    null
  );
  assert.deepEqual(
    systemicFailure([pw('failed'), pw('blocked'), pw('passed')]),
    { failed: 2, units: 3 }
  );
  // Newman units are not counted: the question is whether the UI moved.
  assert.equal(
    systemicFailure([pw('failed'), pw('passed'), nm('failed'), nm('failed')]),
    null
  );
  const c = classifyPlaywrightUnit(
    click('opens the help panel', "getByTestId('help-toggle')"),
    { systemic: { failed: 7, units: 9 } }
  );
  assert.equal(c.severity, 'yellow');
  assert.match(c.reason, /7 of 9 Playwright tests in this run failed/);
});

// --- keywords ----------------------------------------------------------------

test('identifiers are split into words before keywords match', () => {
  assert.deepEqual(words('submitPayment btn-checkout order_total HTTPServer'), [
    'submit',
    'payment',
    'btn',
    'checkout',
    'order',
    'total',
    'http',
    'server',
  ]);
  assert.deepEqual(words('Contraseña 2FA'), ['contrasena', '2fa']);
  for (const [text, domain] of [
    ['submitPayment', 'payment'],
    ['btnCheckout', 'pricing'],
    ['order_total', 'business_logic'],
    ['pay-now', 'payment'],
    ['PAGO', 'payment'],
    ['iniciar sesión', 'security'],
    ['Contraseña', 'security'],
    ['precios', 'pricing'],
    ['2FA code', 'security'],
    ['personal data export', 'compliance'],
  ]) {
    assert.ok(redDomainsInText(text).includes(domain), `${text} -> ${domain}`);
  }
});

test('ordinary words stay outside the taxonomy', () => {
  for (const text of [
    'opens the help panel',
    'sort products by name',
    'the menu opens once rendered',
    'shows the tooltip',
  ]) {
    assert.deepEqual(redDomainsInText(text), [], text);
  }
});
