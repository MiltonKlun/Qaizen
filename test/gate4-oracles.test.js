// Weak-oracle regression fixtures for the Gate 4 scan.
//
// A generated test can pass whatever the product does: it asserts nothing,
// asserts softly, asserts only under a condition, catches its own failure,
// checks a constant, checks the value its own mock served, or buys a pass
// with retries and long timeouts. Each fixture below is one such pattern
// and must produce the named finding; the controls must produce none of
// these rules. The scan informs the Gate 4 reviewer; it never decides.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gate4Findings } from '../scripts/gate4-scan.js';

const HDR = "import { test, expect } from '@playwright/test';";
const ASSERT =
  "  await expect(page.getByTestId('total')).toHaveText('$43.18');";
const wrap = (body, top = '') => `${HDR}
${top}
// PW-001 SPEC-001
test('cart total [TC-001]', async ({ page }) => {
  await page.goto('/');
${body.join('\n')}
});
`;
const ARTIFACTS = {
  contextPath: 'context.json',
  storyId: 'S-1',
  testCases: {
    story_id: 'S-1',
    test_cases: [
      {
        test_case_id: 'TC-001',
        status: 'approved',
        automation_decision: 'automate_e2e',
        expected_result: 'The cart total shows $43.18 for the two items.',
      },
      {
        test_case_id: 'TC-002',
        status: 'approved',
        automation_decision: 'automate_e2e',
        expected_result: 'An empty cart shows no total.',
      },
    ],
  },
  testCasesPath: 'test-cases/S-1.json',
  specText: '## SPEC-001 cart total (TC-001)\n## SPEC-002 empty cart (TC-002)',
  specPath: 'specs/S-1.md',
  criteria: ['The cart shows the total of its items.'],
};
/** The TC-002 test every fixture also carries, so only G21 leaves a case uncovered. */
const TC2 = `
// PW-002 SPEC-002
test('empty cart [TC-002]', async ({ page }) => {
  await page.goto('/cart');
  await expect(page.getByTestId('total')).toBeHidden();
  await expect(page.getByTestId('empty')).toBeVisible();
});
`;
const rulesOf = (src, { coverage = true, tc2 = true } = {}) =>
  gate4Findings(tc2 ? src + TC2 : src, {
    fileName: 'tests/S-1.spec.ts',
    artifacts: ARTIFACTS,
    coverage,
  }).findings.map((f) => f.rule);

// The rules this suite is about; traceability rules are tested elsewhere.
const ORACLE_RULES = new Set([
  'hard_wait',
  'test_suppression',
  'retries_or_slow',
  'long_timeout',
  'untraced_expected_value',
  'fragile_locator',
  'no_assertion',
  'trivial_assertion',
  'weak_assertion',
  'swallowed_assertion',
  'swallowed_failure',
  'conditional_assertion',
  'soft_only',
  'absence_only',
  'mocked_oracle',
  'uncovered_case',
]);
const oracleRules = (src, opts) =>
  rulesOf(src, opts).filter((r) => ORACLE_RULES.has(r));

/** [id, pattern, source, the rule it must produce] */
const PATTERNS = [
  [
    'G1',
    "page['waitForTimeout']",
    wrap(["  await page['waitForTimeout'](3000);", ASSERT]),
    'hard_wait',
  ],
  [
    'G2',
    'globalThis.setTimeout',
    wrap([
      '  await new Promise((r) => globalThis.setTimeout(r, 3000));',
      ASSERT,
    ]),
    'hard_wait',
  ],
  [
    'G3',
    'a bound alias of waitForTimeout',
    wrap([
      '  const pause = page.waitForTimeout.bind(page);',
      '  await pause(3000);',
      ASSERT,
    ]),
    'hard_wait',
  ],
  [
    'G4',
    'waitForTimeout with a variable delay',
    wrap(['  const ms = 3000;', '  await page.waitForTimeout(ms);', ASSERT]),
    'hard_wait',
  ],
  [
    'G5',
    'skip through const t = test',
    `${HDR}\nconst t = test;\n// PW-001 SPEC-001\nt.skip('cart total [TC-001]', async ({ page }) => {\n${ASSERT}\n});\n`,
    'test_suppression',
  ],
  [
    'G6',
    "skip through test['skip']",
    `${HDR}\n// PW-001 SPEC-001\ntest['skip']('cart total [TC-001]', async ({ page }) => {\n${ASSERT}\n});\n`,
    'test_suppression',
  ],
  [
    'G7',
    'skip through a namespace import',
    `import * as pw from '@playwright/test';\n// PW-001 SPEC-001\npw.test.skip('cart total [TC-001]', async ({ page }) => {\n  await pw.expect(page.getByTestId('total')).toHaveText('$43.18');\n});\n`,
    'test_suppression',
  ],
  [
    'G8',
    'skip through const { skip } = test',
    `${HDR}\nconst { skip } = test;\n// PW-001 SPEC-001\nskip('cart total [TC-001]', async ({ page }) => {\n${ASSERT}\n});\n`,
    'test_suppression',
  ],
  [
    'G9',
    'describe.configure({ retries })',
    wrap([ASSERT], 'test.describe.configure({ retries: 5 });'),
    'retries_or_slow',
  ],
  [
    'G10',
    'test.slow() and a long test timeout',
    wrap(['  test.slow();', '  test.setTimeout(600000);', ASSERT]),
    'long_timeout',
  ],
  [
    'G11',
    'an expected value no approved case states',
    wrap(["  await expect(page.getByTestId('total')).toHaveText('$39.98');"]),
    'untraced_expected_value',
  ],
  [
    'G12',
    '.first() and in-string nth=',
    wrap([
      "  await page.locator('.item').first().click();",
      "  await page.locator('.item >> nth=1').click();",
      ASSERT,
    ]),
    'fragile_locator',
  ],
  [
    'G13',
    'no assertion at all',
    wrap(["  await page.getByTestId('add').click();"]),
    'no_assertion',
  ],
  [
    'G14',
    'expect(true).toBe(true)',
    wrap(['  expect(true).toBe(true);']),
    'trivial_assertion',
  ],
  [
    'G15',
    'assertion swallowed by try/catch',
    wrap([`  try {\n  ${ASSERT}\n  } catch {}`]),
    'swallowed_assertion',
  ],
  [
    'G16',
    'assertion only inside if (isVisible())',
    wrap([
      `  if (await page.getByTestId('total').isVisible()) {\n  ${ASSERT}\n  }`,
    ]),
    'conditional_assertion',
  ],
  [
    'G17',
    'weak matcher through const e = expect',
    wrap([
      '  const e = expect;',
      "  e(await page.getByTestId('total').innerText()).toBeTruthy();",
    ]),
    'weak_assertion',
  ],
  [
    'G18',
    'toBeGreaterThanOrEqual(0) and not.toBeNull()',
    wrap([
      "  expect((await page.getByTestId('total').innerText()).length).toBeGreaterThanOrEqual(0);",
      "  expect(await page.getByTestId('total').textContent()).not.toBeNull();",
    ]),
    'weak_assertion',
  ],
  [
    'G19',
    '.catch(() => {}) on an action',
    wrap(["  await page.getByTestId('add').click().catch(() => {});", ASSERT]),
    'swallowed_failure',
  ],
  [
    'G20',
    'expect.soft everywhere',
    wrap([
      "  await expect.soft(page.getByTestId('total')).toHaveText('$43.18');",
    ]),
    'soft_only',
  ],
  ['G21', 'an approved case with no test', wrap([ASSERT]), 'uncovered_case'],
  [
    'G22',
    'a huge expect timeout',
    wrap([
      "  await expect(page.getByTestId('total')).toHaveText('$43.18', { timeout: 600000 });",
    ]),
    'long_timeout',
  ],
];

for (const [id, what, src, rule] of PATTERNS) {
  test(`pattern ${id} (${what}) is reported as ${rule}`, () => {
    // G21 is the one fixture without the TC-002 test.
    const rules = rulesOf(src, { tc2: id !== 'G21' });
    assert.ok(rules.includes(rule), `${id}: got ${JSON.stringify(rules)}`);
  });
}

test('every one of the 22 weakening patterns produces a finding', () => {
  assert.equal(PATTERNS.length, 22);
  for (const [id, , src, rule] of PATTERNS)
    assert.ok(rulesOf(src, { tc2: id !== 'G21' }).includes(rule), id);
});

test('G10 also reports test.slow(), and G9 the retries, each on its own line', () => {
  const g10 = gate4Findings(PATTERNS[9][2] + TC2, { artifacts: ARTIFACTS });
  assert.ok(g10.findings.some((f) => f.rule === 'retries_or_slow'));
  const g9 = gate4Findings(PATTERNS[8][2] + TC2, { artifacts: ARTIFACTS });
  const retries = g9.findings.find((f) => f.rule === 'retries_or_slow');
  assert.match(retries.excerpt, /retries: 5/);
});

// --- the five weak-oracle drafts --------------------------------------------

const DRAFTS = `${HDR}

// PW-001 SPEC-001
test('no assertion at all [TC-001]', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('login-button').click();
});

// PW-002 SPEC-001
test('soft assertion only [TC-001]', async ({ page }) => {
  await page.goto('/');
  await expect.soft(page.getByTestId('title')).toHaveText('Products');
});

// PW-003 SPEC-001
test('asserts on its own mock [TC-001]', async ({ page }) => {
  await page.route('**/api/cart', (r) => r.fulfill({ json: { total: 43.18 } }));
  await page.goto('/');
  await expect(page.getByTestId('total-label')).toContainText('43.18');
});

// PW-004 SPEC-001
test('memorized money value [TC-001]', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('subtotal-label')).toContainText('$39.98');
});

// PW-005 SPEC-001
test('assertion swallowed by try/catch [TC-001]', async ({ page }) => {
  await page.goto('/');
  try { await expect(page.getByTestId('error')).toBeVisible(); } catch { /* ignore */ }
});
`;

test('each of the five weak-oracle drafts produces its finding', () => {
  const r = gate4Findings(DRAFTS + TC2, {
    fileName: 'tests/S-1.spec.ts',
    artifacts: ARTIFACTS,
  });
  const by = (rule) =>
    r.findings.filter((f) => f.rule === rule).map((f) => f.test);
  assert.deepEqual(by('no_assertion'), ['no assertion at all [TC-001]']);
  assert.deepEqual(by('soft_only'), ['soft assertion only [TC-001]']);
  assert.deepEqual(by('mocked_oracle'), ['asserts on its own mock [TC-001]']);
  assert.ok(
    by('untraced_expected_value').includes('memorized money value [TC-001]')
  );
  assert.deepEqual(by('swallowed_assertion'), [
    'assertion swallowed by try/catch [TC-001]',
  ]);
});

// --- controls: an honest test raises none of these ------------------------------

test('a firm, traced test raises no weak-oracle finding', () => {
  assert.deepEqual(oracleRules(wrap([ASSERT])), []);
});

test('assertions in a loop, in an in-file helper, or mixed soft and hard are not weak', () => {
  const helper = `${HDR}
async function expectTotal(page, value) {
  await expect(page.getByTestId('total')).toHaveText(value);
}
// PW-001 SPEC-001
test('cart total [TC-001]', async ({ page }) => {
  await page.goto('/');
  for (const id of ['a', 'b']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  await expect.soft(page.getByTestId('note')).toBeVisible();
  await expectTotal(page, '$43.18');
});
`;
  assert.deepEqual(oracleRules(helper), []);
  // A helper alone gives the test its oracle.
  const onlyHelper = helper.replace(
    /  for \(const id[\s\S]*?toBeVisible\(\);\n/,
    ''
  );
  assert.ok(!oracleRules(onlyHelper).includes('no_assertion'));
});

test('ordinary timeouts and test.setTimeout are not waits or long timeouts', () => {
  const src = wrap([
    '  test.setTimeout(60000);',
    "  await page.getByTestId('add').click({ timeout: 10000 });",
    ASSERT,
  ]);
  assert.deepEqual(oracleRules(src), []);
});

test('a hard wait in a comment is not one', () => {
  assert.deepEqual(
    oracleRules(wrap(['  // await page.waitForTimeout(500);', ASSERT])),
    []
  );
});

test('an absence check next to a positive one is fine; absence alone is reported', () => {
  assert.ok(
    oracleRules(
      wrap([
        "  await expect(page.getByTestId('error')).toBeHidden();",
        "  await expect(page.getByTestId('error')).not.toBeVisible();",
      ])
    ).includes('absence_only')
  );
  assert.ok(
    !oracleRules(
      wrap(["  await expect(page.getByTestId('error')).toBeHidden();", ASSERT])
    ).includes('absence_only')
  );
});

test('without the run artifacts no value is called untraced and no case uncovered', () => {
  const r = gate4Findings(
    wrap(["  await expect(page.getByTestId('total')).toHaveText('$39.98');"])
  );
  const rules = r.findings.map((f) => f.rule);
  assert.ok(!rules.includes('untraced_expected_value'));
  assert.ok(!rules.includes('uncovered_case'));
});

test('a number is traced by its exact digits; words by their words', () => {
  assert.ok(
    oracleRules(
      wrap(["  await expect(page.getByTestId('total')).toHaveText('$43.19');"])
    ).includes('untraced_expected_value')
  );
  assert.ok(
    !oracleRules(
      wrap([
        "  await expect(page.getByTestId('total')).toHaveText('The cart total shows $43.18!');",
      ])
    ).includes('untraced_expected_value')
  );
});
