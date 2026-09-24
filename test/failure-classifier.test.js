// Regression tests for evidence-based failure classification (task group 3.3).
//
// Every case below runs against REAL Playwright output captured from a
// Chromium run (test/fixtures/playwright-classification.json), with its
// terminal colour codes intact. That matters twice over:
//
//   B1  The review's example -- `$100.00` expected, element showing `$1.00` --
//       was classified green/locator_or_selector (auto-heal eligible) because
//       the message contains the word "locator".
//   --  Playwright colours its matcher hints (`expect(\x1b[31mreceived...`),
//       so the old product-bug regex never matched a real report. A suite of
//       hand-written, colour-free messages would have hidden that entirely.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parsePlaywrightError,
  classifyUnit,
  stripAnsi,
} from '../scripts/lib/classify-failure.js';
import {
  adaptPlaywrightReport,
  adaptNewmanReport,
} from '../scripts/lib/execution-results.js';
import {
  resolveDomainLinks,
  idsFromMetadata,
} from '../scripts/lib/build-ledger.js';
import { validateValue } from '../scripts/lib/artifact-io.js';

const PW_FIXTURE = 'test/fixtures/playwright-classification.json';
const NM_FIXTURE = 'test/fixtures/newman-mixed-outcomes.json';
const FA_SCHEMA = 'schemas/failure-analysis.schema.json';
const ROOT = process.cwd();

const report = () => JSON.parse(readFileSync(PW_FIXTURE, 'utf8'));

/** Real ledger units from the real fixture, keyed by the test's own title. */
function units() {
  const { units: u } = adaptPlaywrightReport(report(), { executionId: 'e' });
  return Object.fromEntries(
    u.map((x) => [x.identity.test_title.split(' > ').pop(), x])
  );
}

function verdict(title) {
  const c = classifyUnit(units()[title]);
  return `${c.severity}/${c.classification}`;
}

// --- the fixture really carries what the tests rely on --------------------

test('the fixture keeps real colour codes and all nine cases', () => {
  const raw = readFileSync(PW_FIXTURE, 'utf8');
  assert.ok((raw.match(/\\u001b\[/g) || []).length > 100);
  assert.equal(Object.keys(units()).length, 9);
});

// --- B1 and the evidence order ---------------------------------------------

test('B1: a wrong business value is Red, not a locator problem', () => {
  const u = units()['shows the order total'];
  const c = classifyUnit(u);
  assert.equal(c.severity, 'red');
  assert.equal(c.classification, 'product_bug');
  assert.match(c.reason, /"\$1\.00" where "\$100\.00" was required/);
});

test('a non-locator business assertion is Red', () => {
  assert.equal(verdict('computes the order total'), 'red/product_bug');
});

test('an infrastructure failure is Yellow environment_issue', () => {
  assert.equal(verdict('loads the home page'), 'yellow/environment_issue');
});

test('a flaky test is Yellow flaky ...', () => {
  assert.equal(
    verdict('opens the settings menu once rendered'),
    'yellow/flaky'
  );
});

test('... unless a failed attempt showed a wrong business value (stronger Red cause)', () => {
  assert.equal(verdict('shows the cart total once settled'), 'red/product_bug');
});

test('a locator that cannot be found during an ACTION is the only Green', () => {
  assert.equal(verdict('opens the help panel'), 'green/locator_or_selector');
  const greens = Object.values(units()).filter(
    (u) => classifyUnit(u).severity === 'green'
  );
  assert.equal(greens.length, 1);
});

test('the same locator failure inside a Red domain is Yellow, not Green', () => {
  const c = classifyUnit(units()['submits the payment']);
  assert.equal(c.severity, 'yellow');
  assert.equal(c.classification, 'locator_or_selector');
  assert.match(c.reason, /Red domain\(s\): payment/);
});

test('a missing element during an ASSERTION is ambiguous, not Green', () => {
  assert.equal(
    verdict('shows the grand total'),
    'yellow/unknown_needs_human_review'
  );
});

test('a whole-test timeout with no failing operation is Yellow unknown', () => {
  assert.equal(
    verdict('finishes the wizard'),
    'yellow/unknown_needs_human_review'
  );
});

// --- keywords never decide a cause ------------------------------------------

test('"locator", "getBy" and "timeout" in a message never grant Green on their own', () => {
  // Every word the old rules keyed on, in an assertion that observed a value.
  const message =
    'Error: expect(locator).toHaveText(expected) failed\n\n' +
    'Locator:  getByTestId(\'total\')\nExpected: "$100.00"\n' +
    'Received: "$1.00"\nTimeout:  5000ms\n\nCall log:\n' +
    "  - waiting for getByTestId('total')";
  const c = classifyUnit({
    outcome: 'failed',
    identity: { kind: 'playwright', test_title: 'x' },
    attempts: [{ status: 'failed', error_message: message }],
  });
  assert.equal(c.severity, 'red');
});

test('a word in a file path is not evidence of a cause', () => {
  // The old test_bug rule fired on "fixture" inside an absolute path.
  const c = classifyUnit({
    outcome: 'failed',
    identity: { kind: 'playwright', test_title: 'x' },
    attempts: [
      {
        status: 'failed',
        error_message:
          'Error: something odd\n    at /repo/tests/fixtures/global-setup.ts:12:3',
      },
    ],
  });
  assert.notEqual(c.classification, 'test_bug');
  assert.equal(c.severity, 'yellow');
});

test('colour codes are stripped before any evidence is read', () => {
  const coloured =
    'Error: order total\n\n\u001b[2mexpect(\u001b[22m\u001b[31mreceived' +
    '\u001b[39m\u001b[2m).\u001b[22mtoBe\u001b[2m(\u001b[22m\u001b[32mexpected' +
    '\u001b[39m\u001b[2m)\u001b[22m\n\nExpected: \u001b[32m3\u001b[39m\n' +
    'Received: \u001b[31m2\u001b[39m';
  const ev = parsePlaywrightError(coloured);
  assert.equal(ev.kind, 'assertion');
  assert.equal(ev.matcher, 'toBe');
  assert.equal(ev.expected, '3');
  assert.equal(ev.received, '2');
  assert.equal(stripAnsi(coloured).includes('\u001b'), false);
});

// --- Newman is never Green ---------------------------------------------------

test('Newman: transport, zero assertions, failed assertions; nothing is Green', () => {
  const nm = JSON.parse(readFileSync(NM_FIXTURE, 'utf8'));
  const byName = Object.fromEntries(
    adaptNewmanReport(nm, { executionId: 'e' }).units.map((x) => [
      x.identity.request_name,
      classifyUnit(x),
    ])
  );
  const dead = byName['Request that cannot connect'];
  assert.equal(
    `${dead.severity}/${dead.classification}`,
    'yellow/environment_issue'
  );
  assert.equal(
    byName['Request with zero assertions'].classification,
    'test_bug'
  );
  assert.equal(
    byName['Request with multiple failing assertions'].severity,
    'red'
  );
  // The healer never targets API tests, so nothing here may be Green.
  for (const c of Object.values(byName)) assert.notEqual(c.severity, 'green');
});

// --- ids come from exact metadata (B6) --------------------------------------

test('ids are read from the documented title and request-name conventions', () => {
  assert.deepEqual(
    idsFromMetadata({
      identity: {
        kind: 'playwright',
        test_title: 'login.spec.ts > invalid password shows the error [TC-002]',
      },
    }).ids,
    { test_case_id: 'TC-002' }
  );
  assert.deepEqual(
    idsFromMetadata({
      identity: {
        kind: 'newman',
        request_name: 'REQ-001 Create user returns 201 (TC-003)',
      },
    }).ids,
    { test_case_id: 'TC-003', request_id: 'REQ-001' }
  );
});

test('two different ids of one kind are a conflict, never a choice', () => {
  const u = {
    unit_id: 'u1',
    identity: {
      kind: 'playwright',
      test_title: 'x > covers [TC-001] and [TC-002]',
    },
    domain_links: {
      test_case_id: null,
      playwright_test_id: null,
      spec_id: null,
      unresolved_reason: 'r',
    },
  };
  const {
    units: [r],
    ambiguous,
  } = resolveDomainLinks([u]);
  assert.equal(r.domain_links.test_case_id, null);
  assert.match(r.domain_links.unresolved_reason, /TC-001 vs TC-002/);
  assert.deepEqual(ambiguous, ['u1']);
});

test('report metadata and a mapping that disagree leave the link unresolved', () => {
  const u = {
    unit_id: 'u1',
    identity: { kind: 'playwright', test_title: 'x > total [TC-001]' },
    domain_links: {
      test_case_id: null,
      playwright_test_id: null,
      spec_id: null,
      unresolved_reason: 'r',
    },
  };
  const {
    units: [r],
  } = resolveDomainLinks([u], { u1: { test_case_id: 'TC-009' } });
  assert.equal(r.domain_links.test_case_id, null);
  assert.match(
    r.domain_links.unresolved_reason,
    /report says TC-001, mapping says TC-009/
  );
});

// --- the CLI, end to end ----------------------------------------------------

/** A throwaway run workspace with a Gate-4-approved context. */
function workspace({ gate4 = true, runId = 'run-t' } = {}) {
  const w = mkdtempSync(join(tmpdir(), 'qz-classify-'));
  writeFileSync(
    join(w, 'context.json'),
    JSON.stringify({
      story: { id: 'STORY-042' },
      run_id: runId,
      review_gates: { code_reviewed: gate4 },
    })
  );
  copyFileSync(PW_FIXTURE, join(w, 'results.json'));
  copyFileSync(NM_FIXTURE, join(w, 'newman.json'));
  return w;
}

function run(w, script, args = []) {
  const r = spawnSync('node', [join(ROOT, 'scripts', script), ...args], {
    cwd: w,
    encoding: 'utf8',
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function normalize(w, extra = [], runId = 'run-t') {
  return run(w, 'normalize-results.js', [
    '--story',
    'STORY-042',
    '--run-id',
    runId,
    '--playwright',
    'results.json',
    '--newman',
    'newman.json',
    ...extra,
  ]);
}

test('the CLI writes a schema-valid v2 DRAFT with every failure preserved', () => {
  const w = workspace();
  assert.equal(normalize(w).code, 0);
  const r = run(w, 'run-failure-classifier.js');
  assert.equal(r.code, 0, r.out);

  const doc = JSON.parse(
    readFileSync(join(w, 'analysis', 'failure-analysis.json'), 'utf8')
  );
  const v = validateValue(doc, FA_SCHEMA);
  assert.equal(v.ok, true, JSON.stringify(v.errors));

  assert.equal(doc.schema_version, '2.0');
  assert.equal(doc.status, 'draft');
  const b = doc.outcome_breakdown;
  assert.equal(doc.failures.length, b.failed + b.blocked + b.flaky);
  // Flat fields are exactly the legacy projection of the breakdown.
  assert.equal(doc.failed, b.failed + b.blocked + b.flaky);
  assert.equal(doc.total_tests, b.units);
  // Execution outcome and cause are separate: a flaky unit can be Red.
  assert.ok(
    doc.failures.some(
      (f) => f.execution_outcome === 'flaky' && f.severity === 'red'
    )
  );
});

test('a draft never points at bug drafts that do not exist', () => {
  const w = workspace();
  normalize(w);
  run(w, 'run-failure-classifier.js');
  const doc = JSON.parse(
    readFileSync(join(w, 'analysis', 'failure-analysis.json'), 'utf8')
  );
  assert.ok(doc.failures.some((f) => f.severity === 'red'));
  for (const f of doc.failures) assert.equal(f.bug_draft_path, undefined);
  assert.equal(existsSync(join(w, 'release')), false);
});

test('the runner tells the human what must happen before the Reporter step', () => {
  const w = workspace();
  normalize(w);
  const r = run(w, 'run-failure-classifier.js');
  assert.match(r.out, /status: draft/);
  assert.match(r.out, /bug draft for each of the \d+ Red failure/);
  assert.match(r.out, /unresolved link/);
  assert.match(r.out, /set status to "finalized"/);
});

test('a proven PW id survives a reversed report order, with identical FAIL ids (B6)', () => {
  const mapping = {
    units: {
      'pw:chromium:classify.spec.ts > shows the order total': {
        playwright_test_id: 'PW-042',
      },
    },
  };
  const snapshot = (reverse) => {
    const w = workspace();
    writeFileSync(join(w, 'mapping.json'), JSON.stringify(mapping));
    if (reverse) {
      const r = report();
      (function rev(ss) {
        ss.reverse();
        for (const s of ss) {
          (s.specs || []).reverse();
          if (s.suites) rev(s.suites);
        }
      })(r.suites);
      writeFileSync(join(w, 'results.json'), JSON.stringify(r));
    }
    assert.equal(normalize(w, ['--mapping', 'mapping.json']).code, 0);
    assert.equal(run(w, 'run-failure-classifier.js').code, 0);
    const doc = JSON.parse(
      readFileSync(join(w, 'analysis', 'failure-analysis.json'), 'utf8')
    );
    return doc.failures.map((f) => [
      f.failure_id,
      f.unit_id,
      f.playwright_test_id ?? f.request_id,
      f.severity,
    ]);
  };
  const forward = snapshot(false);
  assert.ok(forward.some(([, , id]) => id === 'PW-042'));
  assert.deepEqual(snapshot(true), forward);
});

test('--blocking fails on product bugs and says it is not a release verdict', () => {
  const w = workspace();
  normalize(w);
  const r = run(w, 'run-failure-classifier.js', ['--blocking']);
  assert.equal(r.code, 1);
  assert.match(r.out, /not a release recommendation/);
});

test('missing, foreign or tampered evidence is an evidence error, never green', () => {
  const w = workspace();
  assert.equal(run(w, 'run-failure-classifier.js').code, 2, 'no ledger');

  assert.equal(normalize(w, ['--out', 'foreign.json'], 'run-other').code, 0);
  const foreign = run(w, 'run-failure-classifier.js', [
    '--ledger',
    'foreign.json',
  ]);
  assert.equal(foreign.code, 2, foreign.out);
  assert.match(foreign.out, /belongs to run run-other/);

  normalize(w);
  const l = JSON.parse(
    readFileSync(join(w, 'analysis', 'execution-ledger.json'), 'utf8')
  );
  l.totals.passed += 5;
  writeFileSync(join(w, 'tampered.json'), JSON.stringify(l));
  assert.equal(
    run(w, 'run-failure-classifier.js', ['--ledger', 'tampered.json']).code,
    2
  );
  assert.equal(existsSync(join(w, 'analysis', 'failure-analysis.json')), false);
});

test('Gate 4 must be passed before anything is classified', () => {
  const w = workspace({ gate4: false });
  normalize(w);
  const r = run(w, 'run-failure-classifier.js');
  assert.equal(r.code, 2);
  assert.match(r.out, /Gate 4/);
});

test('a run-level error reaches the analysis without an invented test identity', () => {
  const w = workspace();
  const r = report();
  r.errors = [{ message: 'Error: global setup failed: port 3000 in use' }];
  writeFileSync(join(w, 'results.json'), JSON.stringify(r));
  assert.equal(normalize(w).code, 0);
  assert.equal(run(w, 'run-failure-classifier.js').code, 0);

  const doc = JSON.parse(
    readFileSync(join(w, 'analysis', 'failure-analysis.json'), 'utf8')
  );
  assert.equal(doc.source_errors.length, 1);
  assert.match(doc.source_errors[0].message, /global setup failed/);
  assert.equal(doc.outcome_breakdown.source_error_count, 1);
  // Counted separately: it is not a failure entry and has no FAIL/PW id.
  assert.equal(
    doc.failures.some((f) => /global setup/.test(f.error_message)),
    false
  );
});
