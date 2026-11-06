// Every Gate 4 scan finding gets an answer (scripts/lib/finding-dispositions.js):
// fixed, wrong, intentional or irrelevant, with a reason for wrong and
// intentional on a Red-domain story. The answers are stored with the
// decision, resolve the finding for a later scan, and feed per-check metrics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DISPOSITIONS,
  answeredFindings,
  approvalAllowed,
  dispositionLines,
  dispositionMetrics,
  dispositionSection,
  findingKey,
  needsReason,
  recordDispositions,
} from '../scripts/lib/finding-dispositions.js';
import { validateValue } from '../scripts/lib/artifact-io.js';
import { applyGateDecision } from '../scripts/run-pipeline.js';

const FINDINGS = [
  {
    rule: 'hard_wait',
    line: 12,
    test: 'checkout [TC-001]',
    excerpt: 'await page.waitForTimeout(500);',
    note: 'hard wait',
  },
  {
    rule: 'uncovered_case',
    line: null,
    test: null,
    excerpt: '(whole file)',
    note: 'TC-003 is an approved E2E case of SK-7, but no test in this file names it',
  },
];

test('every finding needs one known answer', () => {
  const ok = recordDispositions(
    FINDINGS,
    [{ disposition: 'intentional' }, { disposition: 'irrelevant' }],
    { redDomain: false }
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(
    ok.ok && ok.dispositions.map((d) => [d.rule, d.disposition, d.reason]),
    [
      ['hard_wait', 'intentional', null],
      ['uncovered_case', 'irrelevant', null],
    ]
  );
  const missing = recordDispositions(FINDINGS, [{ disposition: 'wrong' }], {
    redDomain: false,
  });
  assert.equal(missing.ok, false);
  assert.match(!missing.ok ? missing.problems[0] : '', /2 finding\(s\) but 1/);
  const unknown = recordDispositions(
    FINDINGS,
    [{ disposition: 'maybe' }, { disposition: 'wrong' }],
    { redDomain: false }
  );
  assert.match(!unknown.ok ? unknown.problems[0] : '', /"maybe" is not/);
  assert.deepEqual(DISPOSITIONS, [
    'fixed',
    'wrong',
    'intentional',
    'irrelevant',
  ]);
});

test('on a Red-domain story, wrong and intentional need a reason', () => {
  assert.equal(needsReason('wrong', true), true);
  assert.equal(needsReason('intentional', true), true);
  assert.equal(needsReason('fixed', true), false);
  assert.equal(needsReason('irrelevant', true), false);
  assert.equal(needsReason('wrong', false), false);
  const bare = recordDispositions(
    FINDINGS,
    [{ disposition: 'wrong' }, { disposition: 'intentional', reason: '  ' }],
    { redDomain: true }
  );
  assert.equal(bare.ok, false);
  assert.equal(!bare.ok && bare.problems.length, 2);
  const given = recordDispositions(
    FINDINGS,
    [
      { disposition: 'wrong', reason: 'the wait is in a fixture' },
      { disposition: 'intentional', reason: 'TC-003 is tested by hand' },
    ],
    { redDomain: true }
  );
  assert.equal(given.ok, true);
});

test('a finding answered fixed means the test cannot be approved as it is', () => {
  const rec = recordDispositions(
    FINDINGS,
    [{ disposition: 'fixed' }, { disposition: 'wrong' }],
    { redDomain: false }
  );
  assert.equal(rec.ok && approvalAllowed(rec.dispositions), false);
  assert.equal(approvalAllowed([]), true);
});

test('answers resolve findings only for the current approval, and only unchanged ones', () => {
  const rec = recordDispositions(
    FINDINGS,
    [{ disposition: 'intentional' }, { disposition: 'fixed' }],
    { redDomain: false }
  );
  assert.ok(rec.ok);
  const dispositions = rec.ok ? rec.dispositions : [];
  const ctx = {
    review_gates: { code_reviewed: { status: true } },
    gate_decisions: [
      {
        gate: 'code_reviewed',
        decision: 'approved',
        decided_at: 'x',
        finding_dispositions: dispositions,
      },
    ],
  };
  const answered = answeredFindings(ctx);
  assert.equal(answered.has(findingKey(FINDINGS[0])), true);
  // "fixed" never resolves a finding.
  assert.equal(answered.has(findingKey(FINDINGS[1])), false);
  // A moved or rewritten line is a different finding.
  assert.equal(answered.has(findingKey({ ...FINDINGS[0], line: 13 })), false);
  assert.equal(
    answered.has(
      findingKey({ ...FINDINGS[0], excerpt: 'await page.waitForTimeout(900);' })
    ),
    false
  );
  // Not approved now, or a later rejection: nothing is resolved.
  assert.equal(
    answeredFindings({
      ...ctx,
      review_gates: { code_reviewed: { status: false } },
    }).size,
    0
  );
  assert.equal(
    answeredFindings({
      ...ctx,
      gate_decisions: [
        ...ctx.gate_decisions,
        { gate: 'code_reviewed', decision: 'rejected', decided_at: 'y' },
      ],
    }).size,
    0
  );
});

test('the decision stores the answers, valid against the context schema', () => {
  const rec = recordDispositions(
    FINDINGS,
    [
      { disposition: 'wrong', reason: 'fixture wait' },
      { disposition: 'irrelevant' },
    ],
    { redDomain: true }
  );
  assert.ok(rec.ok);
  const base = JSON.parse(
    readFileSync(
      join(
        'examples',
        'expected',
        'gate-decisions-logged.expected-context.json'
      ),
      'utf8'
    )
  );
  const ctx = applyGateDecision(base, 'code_reviewed', {
    decision: 'approved',
    reviewer: 'r',
    notes: null,
    openedAt: '2026-11-06T00:00:00Z',
    decidedAt: '2026-11-06T00:05:00Z',
    dispositions: rec.ok ? rec.dispositions : [],
  });
  const logged = ctx.gate_decisions.at(-1);
  assert.equal(logged.finding_dispositions.length, 2);
  assert.equal(logged.finding_dispositions[0].reason, 'fixture wait');
  const schema = join('schemas', 'context.schema.json');
  const v = validateValue(ctx, schema);
  assert.equal(v.ok, true, JSON.stringify(v));
  // An unknown answer is refused by the schema too.
  logged.finding_dispositions[0].disposition = 'maybe';
  assert.equal(validateValue(ctx, schema).ok, false);
  // No answers, no field.
  const none = applyGateDecision({ review_gates: {} }, 'code_reviewed', {
    decision: 'approved',
    openedAt: 'a',
    decidedAt: 'b',
  });
  assert.equal('finding_dispositions' in none.gate_decisions[0], false);
});

test('the gate record lists each finding and its answer', () => {
  assert.deepEqual(dispositionSection([]), []);
  const rec = recordDispositions(
    FINDINGS,
    [{ disposition: 'wrong', reason: 'a | pipe' }, { disposition: 'fixed' }],
    { redDomain: true }
  );
  const lines = dispositionSection(rec.ok ? rec.dispositions : []);
  assert.equal(lines[0], '## Scan findings answered');
  assert.ok(
    lines.includes(
      '| [hard_wait]:12 | checkout [TC-001] | wrong | a \\| pipe |'
    )
  );
  assert.ok(lines.includes('| [uncovered_case] |  | fixed |  |'));
});

test('metrics give each check its answer counts and precision', () => {
  const ctx = (/** @type {[string, string][]} */ answers) => ({
    gate_decisions: [
      {
        gate: 'code_reviewed',
        decision: 'approved',
        finding_dispositions: answers.map(([rule, disposition]) => ({
          rule,
          line: 1,
          test: 't',
          note: 'n',
          disposition,
        })),
      },
    ],
  });
  const m = dispositionMetrics([
    ctx([
      ['hard_wait', 'wrong'],
      ['hard_wait', 'fixed'],
      ['no_assertion', 'intentional'],
    ]),
    ctx([
      ['hard_wait', 'irrelevant'],
      ['hard_wait', 'wrong'],
    ]),
    { gate_decisions: [{ gate: 'code_reviewed', decision: 'approved' }] },
    null,
  ]);
  assert.equal(m.runs_with_dispositions, 2);
  assert.equal(m.answered, 5);
  assert.deepEqual(m.by_rule.hard_wait, {
    fixed: 1,
    wrong: 2,
    intentional: 0,
    irrelevant: 1,
    total: 4,
    precision: 0.5,
  });
  assert.equal(m.by_rule.no_assertion.precision, 1);
  assert.deepEqual(Object.keys(m.by_rule), ['hard_wait', 'no_assertion']);
  assert.match(
    dispositionLines(m, 4).join('\n'),
    /- hard_wait: 4 answered, precision 50% \(fixed 1, wrong 2, intentional 0, irrelevant 1\)/
  );
  assert.match(
    dispositionLines(dispositionMetrics([]), 3)[0],
    /No run records an answer to a scan finding yet \(0\/3 run\(s\)\)/
  );
});
