// Unit tests for the pre-Gate-4 static scanner (IMPROVEMENT-PLAN IP-6.3).
// Table-driven over crafted sources so each rule is exercised in isolation,
// plus one real known-clean file. The scanner is INFORMATIONAL — these tests
// assert it DETECTS the mechanical patterns, not that it judges or blocks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gate4Findings } from '../scripts/gate4-scan.js';

// A source that references a TC so traceability never trips unless asserted.
const traced = (body) => `// [TC-001]\n${body}`;

function rules(source) {
  return gate4Findings(source).findings.map((f) => f.rule);
}

test('clean traced source produces no findings', () => {
  const src = traced(`
    test('user sees inventory [TC-001]', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
    });
  `);
  assert.deepEqual(gate4Findings(src).findings, []);
});

test('each mechanical rule is detected in isolation', () => {
  const cases = [
    [
      'hard_wait — waitForTimeout',
      traced('await page.waitForTimeout(500);'),
      'hard_wait',
    ],
    [
      'hard_wait — bare setTimeout',
      traced('setTimeout(() => {}, 100);'),
      'hard_wait',
    ],
    [
      'test_suppression — .skip',
      traced("test.skip('x', async () => {});"),
      'test_suppression',
    ],
    [
      'test_suppression — .only',
      traced("test.only('x', async () => {});"),
      'test_suppression',
    ],
    [
      'test_suppression — .fixme',
      traced("test.fixme('x', async () => {});"),
      'test_suppression',
    ],
    [
      'fragile_locator — nth-child',
      traced("page.locator('ul li:nth-child(2)');"),
      'fragile_locator',
    ],
    [
      'fragile_locator — .nth()',
      traced("page.getByRole('row').nth(3);"),
      'fragile_locator',
    ],
    [
      'fragile_locator — index XPath',
      traced("page.locator('//div[2]/span');"),
      'fragile_locator',
    ],
    [
      'weak_assertion — toBeTruthy',
      traced('expect(x).toBeTruthy();'),
      'weak_assertion',
    ],
    [
      'weak_assertion — toBeDefined',
      traced('expect(x).toBeDefined();'),
      'weak_assertion',
    ],
  ];
  for (const [name, src, expected] of cases) {
    assert.ok(
      rules(src).includes(expected),
      `${name}: expected rule "${expected}", got ${JSON.stringify(rules(src))}`
    );
  }
});

test('missing traceability is flagged only when no TC/SPEC/PW id is present', () => {
  const untraced = "test('x', async ({ page }) => { await page.goto('/'); });";
  assert.ok(rules(untraced).includes('missing_traceability'));

  for (const id of ['TC-001', 'SPEC-002', 'PW-003']) {
    const src = `// ${id}\n${untraced}`;
    assert.ok(
      !rules(src).includes('missing_traceability'),
      `${id} should satisfy traceability`
    );
  }
});

test('findings carry a line number + excerpt (except whole-file traceability)', () => {
  const src = traced('await page.waitForTimeout(500);');
  const hw = gate4Findings(src).findings.find((f) => f.rule === 'hard_wait');
  assert.equal(typeof hw.line, 'number');
  assert.match(hw.excerpt, /waitForTimeout/);

  const untraced = "test('x', async () => {});";
  const tr = gate4Findings(untraced).findings.find(
    (f) => f.rule === 'missing_traceability'
  );
  assert.equal(tr.line, null);
});

test('judgment questions are always returned (the human still decides)', () => {
  const { judgment } = gate4Findings(traced('expect(1).toBe(1);'));
  assert.ok(Array.isArray(judgment) && judgment.length >= 2);
});

test('reuses the guardrail weak-assertion definition (no drift)', async () => {
  // The scanner must flag exactly what the guardrail constant flags.
  const { WEAK_ASSERTION_PATTERN } =
    await import('../scripts/healer-guardrails.js');
  assert.ok(WEAK_ASSERTION_PATTERN.test('expect(x).toBeTruthy()'));
  assert.ok(
    rules(traced('expect(x).toBeTruthy();')).includes('weak_assertion')
  );
});

test('a real known-clean product spec scans clean', () => {
  // demo-login.spec.ts: TC-001 in a comment, data-test locators, real assertions.
  const src = readFileSync(
    'examples/demo-run/tests/demo-login.spec.ts',
    'utf8'
  );
  assert.deepEqual(gate4Findings(src).findings, []);
});
