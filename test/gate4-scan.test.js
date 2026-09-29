// Unit tests for the pre-Gate-4 static scanner (IMPROVEMENT-PLAN IP-6.3).
// Table-driven over crafted sources so each rule is exercised in isolation,
// plus one real known-clean file. The scanner is INFORMATIONAL — these tests
// assert it DETECTS the mechanical patterns, not that it judges or blocks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gate4Findings, renderGate4Scan } from '../scripts/gate4-scan.js';

// Fragments are scanned for the mechanical rules; per-test traceability only
// concerns test registrations, so a bare statement never trips it.
const traced = (body) => body;

function rules(source) {
  return gate4Findings(source).findings.map((f) => f.rule);
}

test('clean traced source produces no findings', () => {
  const src = traced(`
    // PW-001 SPEC-001
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

test('each test needs its own PW, TC and SPEC; one id alone is not traceability', () => {
  const untraced = "test('x', async ({ page }) => { await page.goto('/'); });";
  assert.ok(rules(untraced).includes('missing_traceability'));

  // The review's reproduction: only PW-001, otherwise unlinked.
  const onlyPw = gate4Findings(`// PW-001\n${untraced}`).findings.find(
    (f) => f.rule === 'missing_traceability'
  );
  assert.ok(onlyPw, 'an only-PW test must be reported');
  assert.match(onlyPw.note, /no TC \/ SPEC id/);

  const full = `// PW-003 SPEC-002\ntest('x [TC-001]', async ({ page }) => { await page.goto('/'); });`;
  assert.deepEqual(gate4Findings(full).findings, []);
});

test('findings carry a line number, the test, and an excerpt', () => {
  const src = traced('await page.waitForTimeout(500);');
  const hw = gate4Findings(src).findings.find((f) => f.rule === 'hard_wait');
  assert.equal(typeof hw.line, 'number');
  assert.match(hw.excerpt, /waitForTimeout/);

  const tr = gate4Findings(
    "\n\ntest('the checkout', async () => {});"
  ).findings.find((f) => f.rule === 'missing_traceability');
  assert.equal(tr.line, 3);
  assert.equal(tr.test, 'the checkout');
});

test('judgment questions are always returned (the human still decides)', () => {
  const { judgment } = gate4Findings(traced('expect(1).toBe(1);'));
  assert.ok(Array.isArray(judgment) && judgment.length >= 2);
});

test('reuses the guardrail weak-matcher definition (no drift)', async () => {
  // The scanner must flag exactly what the guardrail flags as weak.
  const { WEAK_MATCHERS } = await import('../scripts/healer-guardrails.js');
  for (const m of WEAK_MATCHERS) {
    assert.ok(rules(traced(`expect(x).${m}();`)).includes('weak_assertion'), m);
  }
  assert.ok(
    rules(traced('expect(fn).not.toThrow();')).includes('weak_assertion')
  );
  // Text in a comment is not an assertion (the old regex flagged it).
  assert.ok(
    !rules(traced('// expect(x).toBeTruthy();')).includes('weak_assertion')
  );
});

// ---------------------------------------------------------------------------
// Task group 6.2: per-test traceability (finding S4)

const header = "import { test, expect } from '@playwright/test';\n";

test('one file header does not cover several tests', () => {
  const src =
    header +
    '// PW-001 TC-001 SPEC-001 — story header\n\n' +
    "const APP = '/';\n" +
    "test('first [TC-001]', async ({ page }) => { await page.goto(APP); });\n" +
    "test('second [TC-002]', async ({ page }) => { await page.goto(APP); });\n";
  const missing = gate4Findings(src).findings.filter(
    (f) => f.rule === 'missing_traceability'
  );
  assert.deepEqual(
    missing.map((f) => f.test),
    ['first [TC-001]', 'second [TC-002]']
  );
});

test('valid per-test annotations pass, and linkage is verified against artifacts', () => {
  const src =
    header +
    "test('adds to cart [TC-001]', { annotation: [{ type: 'PW', description: 'PW-001' }, { type: 'SPEC', description: 'SPEC-001' }] }, async ({ page }) => {\n" +
    "  await page.goto('/');\n});\n" +
    '// PW-002 SPEC-001\n' +
    "test('removes from cart [TC-002]', async ({ page }) => {\n  await page.goto('/');\n});\n";
  const artifacts = {
    contextPath: 'context.json',
    storyId: 'SK-7',
    testCases: {
      story_id: 'SK-7',
      test_cases: [
        { test_case_id: 'TC-001', status: 'approved' },
        { test_case_id: 'TC-002', status: 'approved' },
      ],
    },
    testCasesPath: 'test-cases/SK-7.json',
    specText: '# Spec SPEC-001 — cart',
    specPath: 'specs/SK-7.md',
  };
  const r = gate4Findings(src, { artifacts });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.traceability.verified, [
    'TC ids against test-cases/SK-7.json (approved scope)',
    'SPEC ids against specs/SK-7.md',
    'PW ids for presence and uniqueness only (no artifact defines them)',
  ]);
  // Without artifacts the same file is NOT called verified.
  const bare = gate4Findings(src);
  assert.deepEqual(bare.traceability.verified, []);
  assert.match(bare.traceability.basis, /linkage unverified/);
  assert.match(renderGate4Scan('t.spec.ts', bare), /linkage unverified/);
});

test('unknown TC, unapproved TC, unknown SPEC and a mismatched story are reported', () => {
  const src =
    header +
    '// PW-001 SPEC-009\n' +
    "test('a [TC-001]', async ({ page }) => { await page.goto('/'); });\n" +
    '// PW-002 SPEC-001\n' +
    "test('b [TC-404]', async ({ page }) => { await page.goto('/'); });\n" +
    '// PW-003 SPEC-001\n' +
    "test('c [TC-002]', async ({ page }) => { await page.goto('/'); });\n";
  const artifacts = (storyId) => ({
    contextPath: 'context.json',
    storyId,
    testCases: {
      story_id: 'SK-7',
      test_cases: [
        { test_case_id: 'TC-001', status: 'approved' },
        { test_case_id: 'TC-002', status: 'draft' },
      ],
    },
    testCasesPath: 'test-cases/SK-7.json',
    specText: 'SPEC-001',
    specPath: 'specs/SK-7.md',
  });
  const notes = gate4Findings(src, { artifacts: artifacts('SK-7') })
    .findings.filter((f) => f.rule === 'unknown_reference')
    .map((f) => `${f.test}: ${f.note}`);
  assert.deepEqual(notes, [
    'a [TC-001]: SPEC-009 is not declared in specs/SK-7.md',
    'b [TC-404]: TC-404 is not a test case of SK-7',
    'c [TC-002]: TC-002 is not approved (status draft)',
  ]);
  const mismatch = gate4Findings(src, { artifacts: artifacts('SK-8') });
  assert.ok(mismatch.findings.some((f) => f.rule === 'story_mismatch'));
  assert.ok(
    !mismatch.traceability.verified.some((v) => v.startsWith('TC ids')),
    'a mismatched story never counts as verified'
  );
});

test('duplicate and conflicting ids are reported per test', () => {
  const src =
    header +
    '// PW-001 SPEC-001\n' +
    "test('a [TC-001]', async ({ page }) => { await page.goto('/'); });\n" +
    '// PW-001 SPEC-001\n' +
    "test('b [TC-002]', async ({ page }) => { await page.goto('/'); });\n" +
    '// PW-003 PW-004 SPEC-001 TC-009\n' +
    "test('c [TC-003]', async ({ page }) => { await page.goto('/'); });\n";
  const f = gate4Findings(src).findings;
  const dup = f.find((x) => x.rule === 'duplicate_traceability');
  assert.equal(dup.test, 'b [TC-002]');
  assert.match(dup.note, /PW-001 is also claimed by "a \[TC-001\]"/);
  const conflicts = f
    .filter((x) => x.rule === 'conflicting_traceability')
    .map((x) => x.note);
  assert.ok(
    conflicts.some((n) =>
      /conflicting PW ids for this test: PW-003, PW-004/.test(n)
    )
  );
  assert.ok(
    conflicts.some((n) => /conflicting TC ids/.test(n)),
    conflicts.join(' | ')
  );
});

test('a TC outside the title is flagged: execution results could not link to it', () => {
  const src =
    header +
    '// PW-001 SPEC-001 TC-001\n' +
    "test('adds to cart', async ({ page }) => { await page.goto('/'); });\n";
  const f = gate4Findings(src).findings.find(
    (x) => x.rule === 'unlinked_title'
  );
  assert.match(f.note, /TC-001 is not in the test title/);
});

test('dynamic registration needs manual verification; no ids are invented', () => {
  const src =
    header +
    "for (const n of [1, 2]) {\n  test(`case ${n} [TC-001]`, async ({ page }) => { await page.goto('/'); });\n}\n";
  const r = gate4Findings(src);
  assert.deepEqual(
    r.findings.map((x) => x.rule),
    ['unverifiable_traceability']
  );
  assert.match(r.findings[0].note, /verify them by hand/);
});

test('the seed exception is narrow: it never covers another test in the file', () => {
  const src =
    header +
    "test.describe('Seed: Environment Setup', () => {\n" +
    "  test('app loads at BASE_URL', async ({ page }) => { await page.goto('/'); });\n" +
    '});\n' +
    "test('sneaky business test', async ({ page }) => { await page.goto('/'); });\n";
  const r = gate4Findings(src, { fileName: 'tests/seed.spec.ts' });
  const missing = r.findings.filter((f) => f.rule === 'missing_traceability');
  assert.deepEqual(
    missing.map((f) => f.test),
    ['sneaky business test']
  );
  assert.equal(r.traceability.tests.filter((t) => t.exempt).length, 1);
  // The same seed-shaped test in any other file is not exempt.
  const elsewhere = gate4Findings(src, { fileName: 'tests/SK-1.spec.ts' });
  assert.equal(
    elsewhere.findings.filter((f) => f.rule === 'missing_traceability').length,
    2
  );
});

test('unparseable source is reported, not silently passed', () => {
  const r = gate4Findings("test('x', async () => {");
  assert.ok(r.findings.some((f) => f.rule === 'unsupported_source'));
  assert.match(r.traceability.basis, /not checked/);
});

test('the scan is read-only and never records an approval', async () => {
  const {
    mkdtempSync,
    writeFileSync,
    readFileSync: read,
    rmSync,
  } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-gate4-'));
  try {
    const ctx = {
      story: { id: 'SK-7' },
      review_gates: {},
      artifact_paths: { test_cases: 'tc.json', playwright_spec: 'spec.md' },
    };
    writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx));
    writeFileSync(
      join(dir, 'tc.json'),
      JSON.stringify({
        story_id: 'SK-7',
        test_cases: [{ test_case_id: 'TC-001', status: 'approved' }],
      })
    );
    writeFileSync(join(dir, 'spec.md'), 'SPEC-001');
    writeFileSync(
      join(dir, 't.spec.ts'),
      header +
        "// PW-001 SPEC-001\ntest('a [TC-001]', async ({ page }) => { await page.goto('/'); });\n"
    );
    const before = read(join(dir, 'context.json'), 'utf8');
    const r = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'gate4-scan.js'),
        '--context',
        'context.json',
        't.spec.ts',
      ],
      { cwd: dir, encoding: 'utf8' }
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /verified: TC ids against tc\.json/);
    assert.match(r.stdout, /never approves/);
    assert.equal(read(join(dir, 'context.json'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real known-clean product spec scans clean', () => {
  // demo-login.spec.ts: TC-001 in a comment, data-test locators, real assertions.
  const src = readFileSync(
    'examples/demo-run/tests/demo-login.spec.ts',
    'utf8'
  );
  assert.deepEqual(gate4Findings(src).findings, []);
});
