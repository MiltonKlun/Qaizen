// Unit tests for the Healer guardrails — the safety-critical pure logic
// (CLAUDE.md §3.6). Run with `npm run test:unit` (node:test, no deps).
//
// guardrailViolations(before, after) -> [] means SAFE; non-empty means REJECT.
// A regression here would let the Healer change a business assertion or
// suppress a test, so this is the most important suite in the repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCandidate,
  ELIGIBILITY_NOTE,
  guardrailViolations,
} from '../scripts/healer-guardrails.js';

const base = `import { test, expect } from '@playwright/test';
test('login lands on inventory', async ({ page }) => {
  await page.locator('#login-button').click();
  await expect(page).toHaveURL(/inventory.html/);
  await expect(page.locator('.title')).toHaveText('Products');
});`;

test('locator-only fix is SAFE (allowed)', () => {
  const after = base.replace(
    "page.locator('#login-button')",
    'page.locator(\'[data-test="login-button"]\')'
  );
  assert.deepEqual(guardrailViolations(base, after), []);
});

test('changing an expected value is REJECTED', () => {
  const after = base.replace(
    "toHaveText('Products')",
    "toHaveText('Swag Labs')"
  );
  const v = guardrailViolations(base, after);
  assert.ok(
    v.some((x) => /expected value/.test(x)),
    v.join('; ')
  );
});

test('changing an expected URL is REJECTED', () => {
  const after = base.replace('/inventory.html/', '/anything.html/');
  const v = guardrailViolations(base, after);
  assert.ok(
    v.some((x) => /expected value/.test(x)),
    v.join('; ')
  );
});

test('adding .skip is REJECTED', () => {
  const after = base.replace('test(', 'test.skip(');
  const v = guardrailViolations(base, after);
  assert.ok(
    v.some((x) => /skip|fixme/.test(x)),
    v.join('; ')
  );
});

test('adding .fixme is REJECTED', () => {
  const after = base.replace('test(', 'test.fixme(');
  const v = guardrailViolations(base, after);
  assert.ok(
    v.some((x) => /skip|fixme/.test(x)),
    v.join('; ')
  );
});

test('deleting a test is REJECTED', () => {
  const after = "import { test, expect } from '@playwright/test';\n// gone";
  const v = guardrailViolations(base, after);
  assert.ok(
    v.some((x) => /removes a test/.test(x)),
    v.join('; ')
  );
});

test('weakening an assertion to toBeTruthy is REJECTED', () => {
  const after = base.replace(
    "await expect(page.locator('.title')).toHaveText('Products');",
    'await expect(page.locator(".title")).toBeTruthy();'
  );
  const v = guardrailViolations(base, after);
  assert.ok(
    v.some((x) => /weakens an assertion/.test(x)),
    v.join('; ')
  );
});

test('introducing a snapshot is REJECTED', () => {
  const after = base.replace(
    'await expect(page).toHaveURL(/inventory.html/);',
    'await expect(page).toHaveScreenshot();'
  );
  const v = guardrailViolations(base, after);
  assert.ok(
    v.some((x) => /snapshot/.test(x)),
    v.join('; ')
  );
});

test('an identical patch (no change) is SAFE', () => {
  assert.deepEqual(guardrailViolations(base, base), []);
});

test('a fix that does several forbidden things reports each', () => {
  // weakens AND changes expected: at least two distinct violations.
  const after = base
    .replace("toHaveText('Products')", 'toBeTruthy()')
    .replace('/inventory.html/', '/x/');
  const v = guardrailViolations(base, after);
  assert.ok(
    v.length >= 2,
    `expected multiple violations, got: ${v.join('; ')}`
  );
});

// ---------------------------------------------------------------------------
// Task group 6.1: parsed comparison (review findings S1, S2). Every
// reproduced bypass must be rejected; only the narrow locator repair passes.

const spec = (
  body,
  header = "import { test, expect } from '@playwright/test';"
) =>
  `${header}
// TC-001 PW-001 SPEC-001
test.beforeEach(async ({ page }) => {
  await page.goto('/');
});
test('checkout total', async ({ page }) => {
${body}
});
test('other test', async ({ page }) => {
  await page.locator('#other').click();
});
`;

const BODY = [
  "  await page.locator('#add-to-cart').click();",
  "  await expect(page.locator('.total')).toBe(100);",
  "  await expect(page.locator('.banner')).toBeHidden();",
  "  await expect(page).toHaveScreenshot('approved.png');",
].join('\n');

function rejects(after, pattern, before = spec(BODY)) {
  const r = checkCandidate(before, after);
  assert.equal(r.eligible, false, 'must be rejected');
  assert.ok(
    r.violations.some((x) => pattern.test(x)),
    r.violations.join(' | ')
  );
}

test('S1: negating a matcher is rejected', () => {
  rejects(
    spec(BODY.replace('.toBe(100)', '.not.toBe(100)')),
    /changes an assertion/
  );
});

test('S1: removing an assertion is rejected', () => {
  rejects(
    spec(
      BODY.replace(
        "  await expect(page.locator('.banner')).toBeHidden();\n",
        ''
      )
    ),
    /removes an assertion/
  );
});

test('S1: changing a snapshot target is rejected', () => {
  rejects(spec(BODY.replace("'approved.png'", "'other.png'")), /snapshot/);
});

test('S2: adding .skip is rejected even when the file already skips something', () => {
  const before = spec(BODY).replace(
    "test('other test'",
    "test.skip('other test'"
  );
  const after = before.replace(
    "test('checkout total'",
    "test.skip('checkout total'"
  );
  rejects(after, /adds test suppression \(\.skip\)/, before);
});

test('S2: commenting out a whole test is rejected', () => {
  const before = spec(BODY);
  const after = before.replace(/test\('other test'[\s\S]*?\n\}\);\n/, (m) =>
    m
      .split('\n')
      .map((l) => (l ? `// ${l}` : l))
      .join('\n')
  );
  rejects(after, /removes a test/, before);
});

test('an explicitly allowed locator repair is eligible and reported', () => {
  const after = spec(
    BODY.replace(
      "page.locator('#add-to-cart')",
      'page.locator(\'[data-test="add-to-cart"]\')'
    )
  );
  const r = checkCandidate(spec(BODY), after);
  assert.deepEqual(r.violations, []);
  assert.equal(r.eligible, true);
  assert.deepEqual(r.repairs, [
    { line: 7, from: '#add-to-cart', to: '[data-test="add-to-cart"]' },
  ]);
  assert.match(ELIGIBILITY_NOTE, /human review still required/);
});

test('getByTestId repairs are eligible; reformatting and multiline matchers are not changes', () => {
  const before = spec(
    [
      "  await page.getByTestId('login').click();",
      "  await expect(page.locator('.t')).toHaveText('Products');",
    ].join('\n')
  );
  const after = spec(
    [
      "  await page.getByTestId('login-button').click();",
      '  await expect(',
      "    page.locator('.t')",
      '  ).toHaveText(',
      "    'Products'",
      '  );',
    ].join('\n')
  );
  assert.deepEqual(checkCandidate(before, after).violations, []);
});

test('alias imports: suppression and assertions through aliases are seen', () => {
  const header = "import { test as t, expect as e } from '@playwright/test';";
  const before = spec(BODY, header)
    .replaceAll("test('", "t('")
    .replace('test.beforeEach', 't.beforeEach')
    .replaceAll('expect(', 'e(');
  rejects(
    before.replace("t('checkout total'", "t.fixme('checkout total'"),
    /adds test suppression \(\.fixme\)/,
    before
  );
  rejects(
    before.replace('.toBe(100)', '.toBe(1)'),
    /changes an assertion/,
    before
  );
});

test('changed assertion operand, removed await, and an assertion moved into a dead branch are rejected', () => {
  rejects(
    spec(
      BODY.replace(
        "expect(page.locator('.total'))",
        "expect(page.locator('.subtotal'))"
      )
    ),
    /changes an assertion/
  );
  rejects(
    spec(
      BODY.replace(
        "await expect(page.locator('.total'))",
        "expect(page.locator('.total'))"
      )
    ),
    /changes an assertion/
  );
  rejects(
    spec(
      BODY.replace(
        "  await expect(page.locator('.total')).toBe(100);",
        [
          '  if (false) {',
          "    await expect(page.locator('.total')).toBe(100);",
          '  }',
        ].join('\n')
      )
    ),
    /changes an assertion/
  );
});

test('deleted hooks, dynamic generation, .only, .fail and in-body skips are rejected', () => {
  rejects(
    spec(BODY).replace(/test\.beforeEach[\s\S]*?\n\}\);\n/, ''),
    /removes a hook/
  );
  rejects(
    spec(BODY).replace(
      "test('other test'",
      'for (const n of [1, 2]) test(`other ${n}`'
    ),
    /registers tests dynamically/
  );
  rejects(
    spec(BODY).replace("test('other test'", "test.only('other test'"),
    /\.only/
  );
  rejects(
    spec(BODY).replace("test('other test'", "test.fail('other test'"),
    /expected-failure declaration/
  );
  rejects(
    spec(BODY + "\n  test.skip(true, 'flaky');"),
    /adds test suppression \(\.skip\)/
  );
});

test('snapshot edits of any kind are rejected', () => {
  rejects(spec(BODY + '\n  await expect(page).toMatchSnapshot();'), /snapshot/);
  rejects(
    spec(
      BODY.replace(
        "\n  await expect(page).toHaveScreenshot('approved.png');",
        ''
      )
    ),
    /snapshot/
  );
});

test('locators that decide what an assertion checks are not eligible', () => {
  // Inside expect(...).
  rejects(
    spec(
      BODY.replace(
        "expect(page.locator('.total'))",
        "expect(page.locator('#total'))"
      )
    ),
    /changes an assertion/
  );
  // Stored in a variable, so its value may reach an assertion.
  const before = spec(
    "  const btn = page.locator('#buy');\n  await btn.click();"
  );
  rejects(
    before.replace("'#buy'", "'#purchase'"),
    /not eligible for automatic repair/,
    before
  );
});

test('receivers that are not provably the page fixture are not eligible', () => {
  const alias = spec("  const p = page;\n  await p.locator('#buy').click();");
  rejects(
    alias.replace("'#buy'", "'#purchase'"),
    /not eligible|outside the allowed/,
    alias
  );
  const renamed = spec(BODY)
    .replace(
      "test('checkout total', async ({ page })",
      "test('checkout total', async ({ page: pg })"
    )
    .replace("page.locator('#add-to-cart')", "pg.locator('#add-to-cart')");
  rejects(
    renamed.replace("'#add-to-cart'", "'#cart'"),
    /not eligible|outside the allowed/,
    renamed
  );
});

test('changing the locator method, its options, or a test title is rejected', () => {
  rejects(
    spec(
      BODY.replace(
        "page.locator('#add-to-cart')",
        "page.getByRole('button', { name: 'Add' })"
      )
    ),
    /outside the allowed|not eligible/
  );
  rejects(
    spec(
      BODY.replace(
        "page.locator('#add-to-cart')",
        "page.locator('#add-to-cart', { hasText: 'Add' })"
      )
    ),
    /outside the allowed|not eligible/
  );
  rejects(
    spec(BODY).replace("test('other test'", "test('renamed test'"),
    /changes test registration/
  );
});

test('traceability: comment-only edits keep ids; removing an id or commenting out code is rejected', () => {
  const before = spec(BODY);
  assert.deepEqual(
    checkCandidate(
      before,
      before.replace(
        '// TC-001 PW-001 SPEC-001',
        '// TC-001 PW-001 SPEC-001 (checkout)'
      )
    ).violations,
    []
  );
  rejects(
    before.replace('// TC-001 PW-001 SPEC-001', '// TC-001 SPEC-001'),
    /removes traceability reference\(s\) PW-001/,
    before
  );
  rejects(
    before.replace(
      "  await page.locator('#add-to-cart').click();",
      "  // await page.locator('#add-to-cart').click();"
    ),
    /removes executable code/,
    before
  );
});

test('unsupported source gets a reason instead of a verdict', () => {
  const r = checkCandidate(spec(BODY), spec(BODY) + '\n test(');
  assert.equal(r.eligible, false);
  assert.match(r.violations[0], /unsupported source: syntax error at line \d+/);
  const o = checkCandidate('test(', spec(BODY));
  assert.match(o.violations[0], /the original is unsupported source/);
});
