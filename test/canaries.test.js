// Gate 2 canaries: planting probability, the synthetic case, the reveal, the
// Red-domain value question, and isolation (a canary never reaches the test
// cases, never changes the reviewed digest, and only the runner's log is
// written). The loop runs on scripted answers; no gate is decided here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateValue } from '../scripts/lib/artifact-io.js';
import { gateDigest } from '../scripts/lib/approval-binding.js';
import { applyCaseDecisions } from '../scripts/lib/case-decisions.js';
import {
  CANARY_LOG,
  CANARY_RATE,
  canaryLines,
  canaryMetrics,
  caseLoop,
  makeCanary,
  mutations,
  plantSlots,
  valueMatches,
  writeCanaryLog,
} from '../scripts/lib/canaries.js';

const REPO = process.cwd();
const read = (/** @type {string} */ p) =>
  JSON.parse(readFileSync(join(REPO, p), 'utf8'));
const CONTEXT = read(
  'examples/evaluation/regressions/cases/REG-007/context.json'
);
const CASES = read(
  'runs/STORY-020/2026-07-01T00-25-56-738Z/test-cases/STORY-020.json'
);

/** A deterministic uniform generator (a small LCG). */
function seeded(seed = 7) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** The draft cases of STORY-020, as the Test Designer leaves them. */
const drafts = () =>
  structuredClone(CASES).test_cases.map((/** @type {any} */ c) => ({
    ...c,
    status: 'draft',
  }));

/** Answers in order; the loop asks, these reply. */
function scripted(/** @type {string[]} */ answers) {
  const asked = /** @type {string[]} */ ([]);
  const said = /** @type {string[]} */ ([]);
  return {
    asked,
    said,
    ask: async (/** @type {string} */ q) => {
      asked.push(q);
      if (!answers.length) throw new Error(`no scripted answer for: ${q}`);
      return /** @type {string} */ (answers.shift());
    },
    say: (/** @type {string} */ line) => said.push(line),
  };
}

test('planting: about one canary per ten decisions, never at rate 0, one per decision at rate 1', () => {
  assert.equal(CANARY_RATE, 0.1);
  const n = 20000;
  const total = plantSlots(n, seeded(1)).reduce((a, b) => a + b, 0);
  // Binomial(20000, 0.1): mean 2000, sd about 42.
  assert.ok(total > 1850 && total < 2150, `planted ${total}`);
  assert.deepEqual(plantSlots(5, seeded(), 0), [0, 0, 0, 0, 0, 0]);
  assert.equal(
    plantSlots(5, seeded(), 1).reduce((a, b) => a + b, 0),
    5
  );
  // Every slot, the first and after the last included, can receive one.
  const seen = new Set();
  for (let seed = 1; seed < 400; seed++)
    plantSlots(4, seeded(seed), 1).forEach((k, i) => k && seen.add(i));
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4]);
});

test("a canary contradicts a criterion or invents a rule, and looks like the run's cases", () => {
  assert.deepEqual(
    mutations('The badge updates to N-1 without a page reload').map((m) => [
      m.kind,
      m.text,
    ]),
    [
      ['comparison', 'The badge updates to N-1 with a page reload'],
      ['number', 'The badge updates to N-2 without a page reload'],
    ]
  );
  assert.equal(
    mutations('Standard shipping is shown as $0.00').find(
      (m) => m.kind === 'number'
    )?.text,
    'Standard shipping is shown as $1.00'
  );
  assert.equal(
    mutations('The order is not placed').find((m) => m.kind === 'negation')
      ?.text,
    'The order is placed'
  );

  const cases = drafts();
  const ids = new Set(cases.map((c) => c.test_case_id));
  // STORY-020's outcomes only allow a negation; a shipping criterion adds a
  // comparison and a number.
  const context = {
    ...CONTEXT,
    acceptance_criteria: [
      ...CONTEXT.acceptance_criteria,
      'Given a cart whose item total is more than $50.00, when the shopper reaches the checkout overview, then standard shipping is shown as $0.00 when the total is more than $50.00.',
    ],
  };
  const outcomes = context.acceptance_criteria.map((/** @type {string} */ a) =>
    a.toLowerCase()
  );
  const kinds = new Set();
  for (let seed = 1; seed < 200; seed++) {
    const { case: c, plant } = makeCanary(context, cases, seeded(seed), {
      redDomain: true,
    });
    kinds.add(plant.kind);
    assert.equal(ids.has(c.test_case_id), false, 'a fresh id');
    assert.match(c.test_case_id, /^TC-\d{3}$/);
    assert.notEqual(c.priority, 'P0', 'never P0 in a Red-domain story');
    assert.ok(
      cases.some((r) => r.automation_decision === c.automation_decision)
    );
    if (plant.kind !== 'invented_rule') {
      assert.ok(plant.criterion >= 1 && plant.criterion <= outcomes.length);
      assert.ok(
        !outcomes.some((o) => o.includes(c.title.toLowerCase())),
        `"${c.title}" must not be a criterion's own outcome`
      );
    }
  }
  assert.deepEqual([...kinds].sort(), [
    'comparison',
    'invented_rule',
    'negation',
    'number',
  ]);
});

test('each canary is revealed right after its decision, and recorded caught or missed', async () => {
  const cases = drafts();
  // Rate 1: every real decision brings a canary. Reject the canaries in
  // order: caught, missed, then approve everything real.
  const io = scripted([]);
  let canaryTurn = 0;
  io.ask = async (q) => {
    io.asked.push(q);
    const last = io.said[io.said.length - 1] ?? '';
    const isCanary = /TC-0(0[6-9]|1\d)\b/.test(last);
    if (isCanary) return canaryTurn++ % 2 === 0 ? 'r' : 'a';
    return 'a';
  };
  const r = await caseLoop({
    drafts: cases,
    cases,
    context: CONTEXT,
    redDomain: false,
    ask: io.ask,
    say: io.say,
    rng: seeded(3),
    canaryRate: 1,
    reviewer: 'Ana',
    now: () => '2026-11-07T10:00:00.000Z',
  });
  assert.equal(r.quit, false);
  const decisions = r.quit ? {} : r.decisions;
  assert.deepEqual(
    Object.keys(decisions).sort(),
    cases.map((c) => c.test_case_id).sort(),
    'decisions only for the real drafts'
  );
  const canaries = r.events.filter((e) => e.kind === 'canary');
  assert.equal(canaries.length, cases.length);
  assert.deepEqual(canaries.map((e) => e.result).slice(0, 2), [
    'caught',
    'missed',
  ]);
  const reveals = io.said.filter((l) => l.includes('That was a canary'));
  assert.equal(reveals.length, cases.length);
  assert.match(reveals[0], /You rejected it: caught/);
  assert.match(reveals[1], /You approved it: missed/);
  // The reveal follows the canary's own decision, before anything else is shown.
  const first = io.said.findIndex((l) => l.includes('That was a canary'));
  assert.match(io.said[first - 1], /TC-0\d\d/);
  const loop = r.events.find((e) => e.kind === 'case_loop');
  assert.deepEqual(
    {
      real: loop.real_cases,
      rejected: loop.rejected_real,
      canaries: loop.canaries,
    },
    { real: cases.length, rejected: 0, canaries: cases.length }
  );
  assert.ok(
    validateValue(
      { schema_version: '1.0', events: r.events },
      join(REPO, 'schemas/canary-log.schema.json')
    ).ok
  );

  // Quitting keeps what was measured and decides nothing.
  const q = scripted(['r', 'q']);
  const quit = await caseLoop({
    drafts: drafts(),
    cases: drafts(),
    context: CONTEXT,
    redDomain: false,
    ...q,
    rng: () => 0, // a canary first, before the first real case
    canaryRate: 1,
  });
  assert.equal(quit.quit, true);
  assert.deepEqual(
    quit.events.map((e) => [e.kind, e.result]),
    [['canary', 'caught']]
  );
});

test('a Red-domain P0 case asks for its expected value first, and records only whether it matched', async () => {
  const cases = drafts();
  const p0 = cases.filter((c) => c.priority === 'P0');
  assert.ok(p0.length > 0);
  const answers = cases.flatMap((c) =>
    c.priority === 'P0'
      ? [
          c.test_case_id === p0[0].test_case_id
            ? 'Checkout: Overview'
            : 'nothing like it',
          'a',
        ]
      : ['a']
  );
  const io = scripted(answers);
  const r = await caseLoop({
    drafts: cases,
    cases,
    context: CONTEXT,
    redDomain: true,
    ...io,
    rng: seeded(),
    canaryRate: 0,
  });
  const values = r.events.filter((e) => e.kind === 'forced_value');
  assert.equal(values.length, p0.length);
  assert.equal(
    values.find((e) => e.test_case_id === p0[0].test_case_id)?.matched,
    true
  );
  assert.ok(values.some((e) => e.matched === false));
  assert.ok(
    !JSON.stringify(r.events).includes('nothing like it'),
    'the typed value is not kept'
  );
  // The question comes before the agent's expected results are shown.
  const q = io.asked.findIndex((a) => a.includes('Red-domain P0'));
  assert.ok(q >= 0);
  // Not asked for a story outside the Red domains.
  const plain = scripted(cases.map(() => 'a'));
  const r2 = await caseLoop({
    drafts: drafts(),
    cases: drafts(),
    context: CONTEXT,
    redDomain: false,
    ...plain,
    rng: seeded(),
    canaryRate: 0,
  });
  assert.equal(r2.events.filter((e) => e.kind === 'forced_value').length, 0);
  assert.equal(valueMatches('$39.98', ['The Total reads $39.98.']), true);
  assert.equal(valueMatches('$40.98', ['The Total reads $39.98.']), false);
  assert.equal(valueMatches('  ', ['anything']), false);
  assert.equal(valueMatches('r', ['The order is placed.']), false);
  assert.equal(
    valueMatches('Item total', ['The displayed Item total equals the sum.']),
    true
  );
  assert.equal(valueMatches('$39.9', ['The Total reads $39.98.']), false);
});

test('isolation: with or without canaries, the saved cases and the Gate 2 digest are identical, and only the runner log is added', async () => {
  /** Run the loop in a workspace and save what the runner saves. */
  async function session(/** @type {number} */ canaryRate) {
    const dir = mkdtempSync(join(tmpdir(), 'qaizen-canary-'));
    const ctx = {
      ...structuredClone(CONTEXT),
      artifact_paths: {
        ...CONTEXT.artifact_paths,
        test_cases: 'test-cases/STORY-020.json',
      },
    };
    writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx));
    mkdirSync(join(dir, 'test-cases'));
    const doc = { ...structuredClone(CASES), test_cases: drafts() };
    // Real answers: reject the second real case, approve the rest; reject
    // every canary.
    let real = 0;
    const said = /** @type {string[]} */ ([]);
    const r = await caseLoop({
      drafts: doc.test_cases.filter(
        (/** @type {any} */ c) => c.status === 'draft'
      ),
      cases: doc.test_cases,
      context: ctx,
      redDomain: false,
      ask: async () => {
        const last = said[said.length - 1] ?? '';
        const shown = /TC-\d+/.exec(last)?.[0];
        const isReal = doc.test_cases.some(
          (/** @type {any} */ c) => c.test_case_id === shown
        );
        if (!isReal) return 'r';
        return real++ === 1 ? 'r' : 'a';
      },
      say: (l) => said.push(l),
      rng: seeded(11),
      canaryRate,
    });
    assert.equal(r.quit, false);
    applyCaseDecisions(doc, r.quit ? {} : r.decisions);
    writeFileSync(
      join(dir, 'test-cases/STORY-020.json'),
      JSON.stringify(doc, null, 2)
    );
    assert.deepEqual(writeCanaryLog(dir, r.events), { ok: true });
    const files = readdirSync(dir, { recursive: true })
      .map((f) => String(f).replace(/\\/g, '/'))
      .sort();
    const result = {
      cases: readFileSync(join(dir, 'test-cases/STORY-020.json'), 'utf8'),
      digest: gateDigest('test_scope_reviewed', ctx, dir),
      files,
      events: r.events,
    };
    rmSync(dir, { recursive: true, force: true });
    return result;
  }
  const without = await session(0);
  const withCanaries = await session(1);
  assert.equal(withCanaries.cases, without.cases);
  assert.equal(withCanaries.digest, without.digest);
  assert.ok(withCanaries.events.filter((e) => e.kind === 'canary').length > 0);
  for (const e of withCanaries.events.filter((x) => x.kind === 'canary'))
    assert.ok(!withCanaries.cases.includes(`"${e.shown_as}"`));
  assert.deepEqual(withCanaries.files, [
    'context.json',
    'gates',
    CANARY_LOG,
    'test-cases',
    'test-cases/STORY-020.json',
  ]);
});

test('the log is validated before it is written, and appended to', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-canary-log-'));
  try {
    const loop = {
      kind: 'case_loop',
      gate: 'test_scope_reviewed',
      reviewer: null,
      decided_at: '2026-11-07T10:00:00.000Z',
      real_cases: 3,
      rejected_real: 1,
      canaries: 0,
    };
    assert.deepEqual(writeCanaryLog(dir, [loop]), { ok: true });
    assert.deepEqual(writeCanaryLog(dir, [loop]), { ok: true });
    const before = readFileSync(join(dir, CANARY_LOG), 'utf8');
    assert.equal(JSON.parse(before).events.length, 2);
    const bad = writeCanaryLog(dir, [{ ...loop, real_cases: -1 }]);
    assert.equal(bad.ok, false);
    assert.equal(readFileSync(join(dir, CANARY_LOG), 'utf8'), before);
    assert.deepEqual(writeCanaryLog(dir, []), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics: catch and false-alarm rates with Wilson intervals; an absent log is unknown', () => {
  const canary = (/** @type {string} */ result, kind = 'number') => ({
    kind: 'canary',
    result,
    plant: { kind },
  });
  const m = canaryMetrics([
    {
      events: [
        ...Array.from({ length: 7 }, () => canary('caught')),
        ...Array.from({ length: 3 }, () => canary('missed', 'invented_rule')),
        { kind: 'case_loop', real_cases: 40, rejected_real: 2 },
        { kind: 'forced_value', matched: true },
      ],
    },
  ]);
  assert.deepEqual(m.canaries, {
    planted: 10,
    caught: 7,
    value: 0.7,
    wilson_95: [0.3968, 0.8922],
  });
  assert.deepEqual(m.by_kind.invented_rule, { planted: 3, caught: 0 });
  assert.equal(m.real_cases.value, 0.05);
  assert.equal(m.forced_values.matched, 1);
  assert.match(
    canaryLines(m, 4).join('\n'),
    /7\/10 = 70% \(95% interval 40–89%\)/
  );
  assert.match(canaryLines(canaryMetrics([]), 4)[0], /unknown, not zero/);
});
