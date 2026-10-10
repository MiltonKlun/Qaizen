// Gate 1 and Gate 2 checks from real use: each acceptance criterion must be
// in the story word for word (scripts/gate-briefs.js), and every draft test
// case gets the reviewer's own decision before Gate 2
// (scripts/lib/case-decisions.js, used by the runner's prompt and the demo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { criteriaNotInStory, renderGateBrief } from '../scripts/gate-briefs.js';
import {
  applyCaseDecisions,
  describeCase,
  draftCases,
} from '../scripts/lib/case-decisions.js';

const REPO = process.cwd();

const STORY = `## Acceptance criteria

1. Given a shopper with two known items in the cart, when they
   proceed to checkout, then they reach the "Checkout: Overview" step.
2. The order log records the reason \`expired_card_client_reject\`.
`;

test('a criterion copied with only its formatting changed is found', () => {
  assert.deepEqual(
    criteriaNotInStory(
      [
        // Line wrapping, quote style and a dropped colon are formatting.
        "Given a shopper with two known items in the cart, when they proceed to checkout, then they reach the 'Checkout Overview' step.",
        // Code marks become quotes; case changes.
        "the order log records the reason 'expired_card_client_reject'.",
      ],
      STORY
    ),
    []
  );
});

test('a criterion with a word added, dropped or changed is not', () => {
  assert.deepEqual(
    criteriaNotInStory(
      [
        'Given a shopper with two items in the cart, when they proceed to checkout, then they reach the "Checkout: Overview" step.',
        'The order log records the reason `expired_card_client_reject` and the time.',
        'The order log keeps the reason `expired_card_client_reject`.',
        'The order log records the reason `expired_card_client_reject`.',
      ],
      STORY
    ),
    [1, 2, 3]
  );
  // Whole words only: "car" is not found inside "cart".
  assert.deepEqual(criteriaNotInStory(['items in the car'], STORY), [1]);
});

test("every example story's expected criteria pass the check", () => {
  const dir = join(REPO, 'examples', 'expected');
  let checked = 0;
  for (const f of readdirSync(dir).filter((n) =>
    n.endsWith('.expected-context.json')
  )) {
    const story = join(
      REPO,
      'examples',
      'stories',
      f.replace('.expected-context.json', '.md')
    );
    if (!existsSync(story)) continue;
    const ctx = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    assert.deepEqual(
      criteriaNotInStory(ctx.acceptance_criteria, readFileSync(story, 'utf8')),
      [],
      f
    );
    checked += 1;
  }
  assert.ok(checked >= 5, `only ${checked} example stories were checked`);
  // The demo's story too.
  const demo = JSON.parse(
    readFileSync(
      join(REPO, 'examples', 'demo-run', 'context.after-analyst.json'),
      'utf8'
    )
  );
  assert.deepEqual(
    criteriaNotInStory(
      demo.acceptance_criteria,
      readFileSync(join(REPO, 'examples', 'demo-run', 'story.md'), 'utf8')
    ),
    []
  );
});

test("the brief lists the gate's own automatic checks", () => {
  const brief = renderGateBrief({
    step: 'gate1',
    context: { story: { id: 'S-1' } },
    artifacts: [{ path: 'context.json', exists: true, valid: true }],
    checks: ['ATTENTION: AC 2 not found word for word in story.md'],
  });
  assert.match(
    brief,
    /Auto-checks:\n {2}- all reviewed artifacts exist and schema-validate \(where applicable\)\n {2}- ATTENTION: AC 2 not found word for word in story\.md\n/
  );
});

const cases = () => ({
  test_cases: [
    {
      test_case_id: 'TC-001',
      title: 'Valid login',
      status: 'approved',
      automation_decision: 'automate_e2e',
      priority: 'P0',
      risk_ids: ['RISK-001'],
    },
    {
      test_case_id: 'TC-002',
      title: 'Wrong password',
      status: 'draft',
      automation_decision: 'automate_e2e',
      priority: 'P1',
      risk_ids: ['RISK-002'],
    },
    {
      test_case_id: 'TC-003',
      title: 'Looks right',
      status: 'draft',
      automation_decision: 'manual',
      priority: 'P3',
      risk_ids: [],
    },
  ],
});

test('only draft cases are asked about, and each is shown with what decides it', () => {
  const doc = cases();
  assert.deepEqual(
    draftCases(doc).map((c) => c.test_case_id),
    ['TC-002', 'TC-003']
  );
  assert.equal(
    describeCase(doc.test_cases[1]),
    '  TC-002  Wrong password\n    automate_e2e, P1, covers RISK-002'
  );
  assert.equal(
    describeCase(doc.test_cases[2]),
    '  TC-003  Looks right\n    manual, P3'
  );
  assert.deepEqual(draftCases(null), []);
});

test('every draft needs a decision, or none is written', () => {
  const doc = cases();
  assert.throws(
    () => applyCaseDecisions(doc, { 'TC-002': 'approved' }),
    /no decision for draft case TC-003/
  );
  assert.throws(
    () => applyCaseDecisions(doc, { 'TC-002': 'approved', 'TC-003': 'maybe' }),
    /no decision for draft case TC-003/
  );
  assert.deepEqual(
    doc.test_cases.map((c) => c.status),
    ['approved', 'draft', 'draft'],
    'a refused set of decisions changes nothing'
  );
  assert.deepEqual(
    applyCaseDecisions(doc, { 'TC-002': 'approved', 'TC-003': 'rejected' }),
    [
      { id: 'TC-002', decision: 'approved' },
      { id: 'TC-003', decision: 'rejected' },
    ]
  );
  assert.deepEqual(
    doc.test_cases.map((c) => c.status),
    ['approved', 'approved', 'rejected']
  );
});
