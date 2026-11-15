// An outside reviewer's verdict on the approvals the sampled outside review
// marked (scripts/record-outcome.js outside-review, scripts/lib/outcomes.js,
// docs/outcome-records.md §3), and what the metrics make of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execPath } from 'node:process';

import { validateValue } from '../scripts/lib/artifact-io.js';
import {
  markedDecisions,
  outsideReviewLines,
  outsideReviewMetrics,
  sameName,
} from '../scripts/lib/review-independence.js';

const REPO = process.cwd();
const SCHEMA = 'schemas/outside-review.schema.json';

const approval = (gate, decided_at, independence, extra = {}) => ({
  gate,
  decision: 'approved',
  decided_at,
  reviewer: 'Ada Reviewer',
  ...(independence ? { independence } : {}),
  ...extra,
});
const outside = (selected) => ({
  control: 'outside_review',
  operator: 'Bo Operator',
  rate: 0.25,
  selected,
  input_digest: 'a'.repeat(64),
});

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-outside-'));
  const put = (rel, value) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
  };
  put('runs/S-1/a/context.json', {
    status: 'completed',
    run_id: 'run-a',
    gate_decisions: [
      { gate: 'test_scope_reviewed', decision: 'rejected', decided_at: 't0' },
      approval('test_scope_reviewed', 't1', outside(true), {
        record: { path: 'gates/002-gate2-approved.md', sha256: 'b'.repeat(64) },
      }),
      approval('test_scope_reviewed', 't2', outside(true)),
      approval('code_reviewed', 't3', outside(false)),
      approval('api_assertions_reviewed', 't4', {
        control: 'delay',
        operator: null,
        brief_first_shown_at: 't',
        minutes: 61,
      }),
    ],
  });
  put('runs/DEMO-1/x/context.json', { run_id: 'demo' });
  put('runs/DEMO-1/x/DEMO_RUN', '');
  return dir;
}
const cli = (dir, ...args) =>
  spawnSync(execPath, [join(REPO, 'scripts', 'record-outcome.js'), ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
const BASE = ['--story', 'S-1', '--run', 'a'];
const DOC = 'outcomes/outside-reviews/S-1.json';

test('only the selected approvals are marked, and names compare as people would', () => {
  const ctx = JSON.parse(
    JSON.stringify({
      gate_decisions: [
        approval('test_scope_reviewed', 't1', outside(true)),
        approval('code_reviewed', 't2', outside(false)),
        {
          ...approval('code_reviewed', 't3', outside(true)),
          decision: 'rejected',
        },
        approval('code_reviewed', 't4', null),
      ],
    })
  );
  assert.deepEqual(markedDecisions(ctx), [
    {
      gate: 'test_scope_reviewed',
      decided_at: 't1',
      record: null,
      reviewer: 'Ada Reviewer',
      operator: 'Bo Operator',
    },
  ]);
  assert.equal(sameName(' ada  REVIEWER', 'Ada Reviewer'), true);
  assert.equal(sameName('Ada', 'Bo'), false);
  assert.equal(sameName(null, null), false);
});

test('record-outcome outside-review refuses what is not a marked decision or not an outside view', (t) => {
  const dir = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const refused = (args, pattern) => {
    const r = cli(dir, 'outside-review', ...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, pattern);
    assert.equal(existsSync(join(dir, DOC)), false, 'nothing is written');
  };
  const by = ['--by', 'Dana Outside'];
  refused(
    [...BASE, '--gate', 'gate1', '--verdict', 'agree', ...by],
    /covers test_scope_reviewed/
  );
  refused(
    [...BASE, '--gate', 'gate4', '--verdict', 'agree', ...by],
    /no approval at code_reviewed .* is marked/
  );
  refused(
    [...BASE, '--gate', 'gate4-api', '--verdict', 'agree', ...by],
    /no approval at api_assertions_reviewed/
  );
  refused(
    [
      ...BASE,
      '--gate',
      'gate2',
      '--decided-at',
      't0',
      '--verdict',
      'agree',
      ...by,
    ],
    /were decided at t1, t2/
  );
  refused(
    [...BASE, '--gate', 'gate2', '--verdict', 'agree', '--by', 'ada reviewer'],
    /made this decision/
  );
  refused(
    [...BASE, '--gate', 'gate2', '--verdict', 'agree', '--by', 'Bo Operator'],
    /is the operator noted/
  );
  refused(
    [...BASE, '--gate', 'gate2', '--verdict', 'disagree', ...by],
    /a disagreement says why/
  );
  refused(
    [
      '--story',
      'DEMO-1',
      '--run',
      'x',
      '--gate',
      'gate2',
      '--verdict',
      'agree',
      ...by,
    ],
    /demo runs do not count/
  );
  refused([...BASE, '--gate', 'gate2', '--verdict', 'maybe', ...by], /verdict/);
});

test('record-outcome outside-review records one verdict per decision, and replaces it only when asked', (t) => {
  const dir = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const by = ['--by', 'Dana Outside'];
  const first = cli(
    dir,
    'outside-review',
    ...BASE,
    '--gate',
    'gate2',
    '--verdict',
    'agree',
    ...by
  );
  assert.equal(first.status, 0, first.stderr);
  // The latest marked approval at the gate, unless another is named.
  const older = cli(
    dir,
    'outside-review',
    ...BASE,
    '--gate',
    'test_scope_reviewed',
    '--decided-at',
    't1',
    '--verdict',
    'disagree',
    '--notes',
    'TC-002 has no negative case.',
    ...by
  );
  assert.equal(older.status, 0, older.stderr);
  assert.match(older.stdout, /Follow it up/);
  const again = cli(
    dir,
    'outside-review',
    ...BASE,
    '--gate',
    'gate2',
    '--verdict',
    'disagree',
    '--notes',
    'x',
    ...by
  );
  assert.equal(again.status, 2);
  assert.match(again.stderr, /pass --replace/);
  assert.equal(
    cli(
      dir,
      'outside-review',
      ...BASE,
      '--gate',
      'gate2',
      '--verdict',
      'disagree',
      '--notes',
      'On reflection, no.',
      '--replace',
      ...by
    ).status,
    0
  );
  const doc = JSON.parse(readFileSync(join(dir, DOC), 'utf8'));
  assert.equal(validateValue(doc, SCHEMA).ok, true);
  assert.deepEqual(
    doc.reviews.map((r) => [r.decided_at, r.verdict]),
    [
      ['t2', 'disagree'],
      ['t1', 'disagree'],
    ]
  );
  const t1 = doc.reviews.find((r) => r.decided_at === 't1');
  assert.equal(t1.decision_record, 'gates/002-gate2-approved.md');
  assert.equal(t1.decision_reviewer, 'Ada Reviewer');
  assert.equal(t1.operator, 'Bo Operator');
  assert.equal(t1.run_archive, 'runs/S-1/a');
  assert.equal(t1.recorded_by, 'Dana Outside');
  // The archive is evidence: it is never changed.
  assert.equal(
    JSON.parse(readFileSync(join(dir, 'runs/S-1/a/context.json'), 'utf8'))
      .gate_decisions.length,
    5
  );
});

test('the metrics count reviewed, agreed, disagreed and waiting, and say what they leave out', (t) => {
  const runs = [
    {
      story: 'S-1',
      runId: 'run-a',
      context: {
        gate_decisions: [
          approval('test_scope_reviewed', 't1', outside(true)),
          approval('code_reviewed', 't2', outside(true)),
          approval('api_assertions_reviewed', 't3', outside(true)),
        ],
      },
    },
  ];
  const docs = [
    {
      story_id: 'S-1',
      reviews: [
        {
          run_id: 'run-a',
          gate: 'test_scope_reviewed',
          decided_at: 't1',
          verdict: 'agree',
          recorded_by: 'D',
        },
        {
          run_id: 'run-a',
          gate: 'code_reviewed',
          decided_at: 't2',
          verdict: 'disagree',
          recorded_by: 'D',
        },
        {
          run_id: 'gone',
          gate: 'code_reviewed',
          decided_at: 't9',
          verdict: 'agree',
          recorded_by: 'D',
        },
      ],
    },
  ];
  const m = outsideReviewMetrics(runs, docs);
  assert.equal(m.marked, 3);
  assert.equal(m.reviewed, 2);
  assert.equal(m.agreed, 1);
  assert.equal(m.disagreed, 1);
  assert.equal(m.waiting.length, 1);
  assert.equal(m.verdicts_not_counted, 1);
  const lines = outsideReviewLines(m, 2).join('\n');
  assert.match(
    lines,
    /3 decision\(s\) marked for outside review: 2 reviewed \(1 agreed, 1 disagreed\), 1 waiting/
  );
  assert.match(lines, /DISAGREED: S-1 run-a code_reviewed/);
  assert.match(lines, /Waiting: S-1 run-a api_assertions_reviewed/);
  assert.match(lines, /1 verdict\(s\) name no marked decision/);
  assert.match(lines, /2 record\(s\) left out/);
  assert.match(
    outsideReviewLines(outsideReviewMetrics([], [])).join('\n'),
    /No decision is marked for outside review/
  );

  // End to end: the verdict recorded above shows in npm run metrics.
  const dir = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(
    cli(
      dir,
      'outside-review',
      ...BASE,
      '--gate',
      'gate2',
      '--verdict',
      'agree',
      '--by',
      'Dana'
    ).status,
    0
  );
  const run = spawnSync(
    execPath,
    [join(REPO, 'scripts', 'pipeline-metrics.js')],
    {
      cwd: dir,
      encoding: 'utf8',
    }
  );
  assert.equal(run.status, 0, run.stderr);
  const json = JSON.parse(
    readFileSync(join(dir, 'metrics/pipeline-metrics.json'), 'utf8')
  );
  assert.equal(json.outside_reviews.marked, 2);
  assert.equal(json.outside_reviews.agreed, 1);
  assert.equal(json.outside_reviews.waiting.length, 1);
  const md = readFileSync(join(dir, 'metrics/pipeline-metrics.md'), 'utf8');
  assert.match(md, /^## Outside reviews$/m);
  assert.match(md, /Waiting: S-1 run-a test_scope_reviewed \(decided t1\)/);
});
