// @ts-check
// Canaries: measuring the Gate 2 review itself.
//
// A review nobody tests has no known catch rate. While the reviewer decides
// each draft test case before Gate 2, the runner (never the maintainer, who
// would know where it is) plants a synthetic case at a low random rate: one
// that contradicts an acceptance criterion (a comparison, a number or a
// negation changed) or invents a business rule the story never states. It is
// shown exactly like a real case. Right after the reviewer decides it, the
// runner says it was a canary and records whether it was caught (rejected)
// or missed (approved).
//
// A canary exists only in memory and in gates/canaries.json, the runner's
// log: it is never written to test-cases/ or any agent-owned folder, never
// enters an approved digest and never changes a real decision.
//
// For a Red-domain story the loop also asks, before each P0 case's expected
// results are shown, what the reviewer expects: they type the value from the
// story, then see the agent's, so an approval is not a nod at a number nobody
// checked.
//
// Pure apart from writeCanaryLog.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJson, writeJsonAtomic } from './artifact-io.js';
import { describeCase } from './case-decisions.js';
import { rate } from './stats.js';

/** About one canary per ten case decisions (design decision D9). */
export const CANARY_RATE = 0.1;

/** The runner's log of canaries, value questions and case loops. */
export const CANARY_LOG = 'gates/canaries.json';

const SCHEMA = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'schemas',
  'canary-log.schema.json'
);

/**
 * @typedef {import('./case-decisions.js').DraftCase & {
 *   expected_results?: string[], acceptance_criteria_refs?: number[] }} Case
 * @typedef {{ kind: 'comparison' | 'number' | 'negation', criterion: number,
 *   from: string, to: string } | { kind: 'invented_rule', rule: string }} Plant
 * @typedef {{ case: Case, plant: Plant }} Canary
 * @typedef {() => number} Rng a uniform number in [0, 1)
 */

/** Rules no story here states; a case built on one invents a business rule. */
export const INVENTED_RULES = [
  'A second coupon code doubles the discount',
  'Orders above $500.00 need a manager approval before payment',
  'Guest shoppers can keep at most three items in the cart',
  'Prices are rounded up to the next whole dollar at checkout',
  'An order placed after 10 pm is charged on the next business day',
  'Removing the last item from the cart also signs the shopper out',
];

/** Opposites, longest first so "at least" wins over "least". */
const OPPOSITES = [
  ['more than', 'less than'],
  ['less than', 'more than'],
  ['greater than', 'less than'],
  ['at least', 'at most'],
  ['at most', 'at least'],
  ['or less', 'or more'],
  ['or more', 'or less'],
  ['before', 'after'],
  ['after', 'before'],
  ['without', 'with'],
  ['visible', 'hidden'],
  ['hidden', 'visible'],
];

/**
 * The ways a clause can be made to contradict itself.
 * @param {string} clause
 * @returns {{ kind: 'comparison' | 'number' | 'negation', from: string, to: string, text: string }[]}
 */
export function mutations(clause) {
  /** @type {{ kind: 'comparison' | 'number' | 'negation', from: string, to: string, text: string }[]} */
  const out = [];
  for (const [a, b] of OPPOSITES) {
    const re = new RegExp(`\\b${a}\\b`, 'i');
    const m = re.exec(clause);
    if (m) {
      out.push({
        kind: 'comparison',
        from: m[0],
        to: b,
        text: clause.replace(re, b),
      });
      break;
    }
  }
  const num = /\$?\d+(?:\.\d+)?/.exec(clause);
  if (num) {
    const raw = num[0];
    const dollars = raw.startsWith('$');
    const n = Number(raw.replace('$', ''));
    const changed = raw.includes('.')
      ? (n + 1).toFixed(raw.split('.')[1].length)
      : String(n + 1);
    const to = `${dollars ? '$' : ''}${changed}`;
    out.push({ kind: 'number', from: raw, to, text: clause.replace(raw, to) });
  }
  const not = /\b(?:not|no longer)\s+/i.exec(clause);
  if (not)
    out.push({
      kind: 'negation',
      from: not[0].trim(),
      to: '(removed)',
      text: clause.replace(not[0], ''),
    });
  else {
    const verb = /\b(is|are)\s+/i.exec(clause);
    if (verb)
      out.push({
        kind: 'negation',
        from: verb[1],
        to: `${verb[1]} not`,
        text: clause.replace(verb[0], `${verb[1]} not `),
      });
  }
  return out;
}

/** The outcome part of a criterion: what follows its last "then". */
const outcomeOf = (/** @type {string} */ ac) => {
  const i = ac.toLowerCase().lastIndexOf('then ');
  const clause = (i === -1 ? ac : ac.slice(i + 5)).trim().replace(/\.$/, '');
  return clause.charAt(0).toUpperCase() + clause.slice(1);
};

/**
 * Pick one element.
 * @template T
 * @param {T[]} xs
 * @param {Rng} rng
 * @returns {T}
 */
function pick(xs, rng) {
  return xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))];
}

/**
 * A canary for these cases: a case that contradicts a criterion of the
 * context, or one built on a rule the story never states, with the facts a
 * real case of this run would show.
 * @param {any} context
 * @param {Case[]} cases every case of the file, decided or not
 * @param {Rng} rng
 * @param {{ redDomain?: boolean }} [opts]
 * @returns {Canary}
 */
export function makeCanary(context, cases, rng, { redDomain = false } = {}) {
  const criteria = /** @type {string[]} */ (context?.acceptance_criteria ?? []);
  const options = criteria.flatMap((ac, i) => {
    const clause = outcomeOf(ac);
    if (clause.length > 140) return [];
    return mutations(clause).map((m) => ({ ...m, criterion: i }));
  });
  /** @type {Plant} */
  let plant;
  let title;
  if (options.length && rng() >= 0.25) {
    const m = pick(options, rng);
    plant = {
      kind: m.kind,
      criterion: m.criterion + 1,
      from: m.from,
      to: m.to,
    };
    title = m.text;
  } else {
    const rule = pick(INVENTED_RULES, rng);
    plant = { kind: 'invented_rule', rule };
    title = rule;
  }

  // Look like this run's cases: its id format, a decision and a priority its
  // cases use, and a risk the criterion relates to. A Red-domain P0 case gets
  // the value question, which a canary cannot answer, so it is never P0 there.
  const ids = cases
    .map((c) => /^TC-(\d+)$/.exec(c.test_case_id))
    .filter((m) => m !== null);
  const width = ids.length ? ids[0][1].length : 3;
  const next =
    Math.max(
      0,
      ...ids.map((m) => Number(/** @type {RegExpExecArray} */ (m)[1]))
    ) + 1;
  const decisions = cases.map((c) => c.automation_decision).filter(Boolean);
  const priorities = cases
    .map((c) => c.priority)
    .filter((p) => p && !(redDomain && p === 'P0'));
  const risks = /** @type {any[]} */ (context?.risks ?? []);
  const related =
    plant.kind === 'invented_rule'
      ? []
      : risks.filter((r) =>
          (r.related_acs ?? []).includes(
            /** @type {{ criterion: number }} */ (plant).criterion - 1
          )
        );
  const riskIds = related.length
    ? [pick(related, rng).risk_id]
    : (pick(cases, rng)?.risk_ids ?? []);
  return {
    plant,
    case: {
      test_case_id: `TC-${String(next).padStart(width, '0')}`,
      title,
      status: 'draft',
      automation_decision: decisions.length
        ? pick(decisions, rng)
        : 'automate_e2e',
      priority: priorities.length ? pick(priorities, rng) : 'P1',
      risk_ids: riskIds,
    },
  };
}

/**
 * Where canaries go among `n` real cases: each real decision brings one with
 * probability `rate`, at a uniformly random place. Returns, for each slot
 * 0..n, how many canaries are shown before the real case at that slot (slot n
 * is after the last).
 * @param {number} n
 * @param {Rng} rng
 * @param {number} [canaryRate]
 * @returns {number[]}
 */
export function plantSlots(n, rng, canaryRate = CANARY_RATE) {
  const slots = Array.from({ length: n + 1 }, () => 0);
  for (let i = 0; i < n; i++)
    if (rng() < canaryRate)
      slots[Math.min(n, Math.floor(rng() * (n + 1)))] += 1;
  return slots;
}

/** What the reveal says the canary was. */
export function plantText(/** @type {Plant} */ plant) {
  return plant.kind === 'invented_rule'
    ? `it states a rule the story never does ("${plant.rule}")`
    : plant.kind === 'negation' && plant.to === '(removed)'
      ? `it drops the "${plant.from}" of acceptance criterion ${plant.criterion}`
      : `it changes acceptance criterion ${plant.criterion}: "${plant.from}" became "${plant.to}"`;
}

/**
 * Words and values: "$39.98", "10%" and "N-1" stay whole; punctuation and
 * case do not count.
 * @param {string} s
 */
const words = (s) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9$%.-]+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
    .filter(Boolean);

/**
 * Does the value the reviewer typed appear, as whole words in order, in the
 * agent's expected results? A stray letter matches nothing.
 * @param {string} typed
 * @param {string[]} expected
 */
export function valueMatches(typed, expected) {
  const want = words(typed);
  const have = words(expected.join(' '));
  if (!want.length) return false;
  for (let i = 0; i + want.length <= have.length; i++)
    if (want.every((w, j) => have[i + j] === w)) return true;
  return false;
}

/**
 * The Gate 2 per-case loop: every draft case decided one at a time, with the
 * canaries planted among them and the value question on a Red-domain P0.
 * `ask` returns the reviewer's answer; `say` shows a line. Decisions are
 * returned for the real drafts only.
 * @param {{
 *   drafts: Case[], cases: Case[], context: any, redDomain: boolean,
 *   ask: (question: string) => Promise<string>, say: (line: string) => void,
 *   rng: Rng, now?: () => string, reviewer?: string | null,
 *   gate?: string, canaryRate?: number,
 * }} args
 * @returns {Promise<{ quit: true, events: any[] }
 *   | { quit: false, decisions: Record<string, 'approved' | 'rejected'>, events: any[] }>}
 */
export async function caseLoop({
  drafts,
  cases,
  context,
  redDomain,
  ask,
  say,
  rng,
  now = () => new Date().toISOString(),
  reviewer = null,
  gate = 'test_scope_reviewed',
  canaryRate = CANARY_RATE,
}) {
  const slots = plantSlots(drafts.length, rng, canaryRate);
  /** @type {Record<string, 'approved' | 'rejected'>} */
  const decisions = {};
  /** @type {any[]} */
  const events = [];
  const shown = [...cases];
  /** @returns {Promise<'a' | 'r' | 'q'>} */
  const decide = async () => {
    for (;;) {
      const a = (await ask('  [a]pprove / [r]eject / [q]uit: '))
        .trim()
        .toLowerCase()
        .slice(0, 1);
      if (a === 'a' || a === 'r' || a === 'q') return a;
    }
  };
  const quit = () => ({ quit: /** @type {true} */ (true), events });

  for (let slot = 0; slot <= drafts.length; slot++) {
    for (let k = 0; k < slots[slot]; k++) {
      const canary = makeCanary(context, shown, rng, { redDomain });
      shown.push(canary.case);
      const plantedAt = now();
      say(`\n${describeCase(canary.case)}`);
      const a = await decide();
      if (a === 'q') return quit();
      const caught = a === 'r';
      say(
        `  That was a canary: a case the runner made up to measure this review; ${plantText(canary.plant)}. ` +
          (caught
            ? 'You rejected it: caught.'
            : 'You approved it: missed. Read the next cases against the story.') +
          ' It is not saved and changes no real case.'
      );
      events.push({
        kind: 'canary',
        gate,
        reviewer,
        planted_at: plantedAt,
        decided_at: now(),
        shown_as: canary.case.test_case_id,
        plant: canary.plant,
        decision: caught ? 'rejected' : 'approved',
        result: caught ? 'caught' : 'missed',
      });
    }
    if (slot === drafts.length) break;
    const c = drafts[slot];
    say(`\n${describeCase(c)}`);
    if (redDomain && c.priority === 'P0') {
      let typed = '';
      while (!typed)
        typed = (
          await ask(
            "  Red-domain P0: type the value this case must expect, from the story, before you see the agent's: "
          )
        ).trim();
      const expected = c.expected_results ?? [];
      const matched = valueMatches(typed, expected);
      say(
        `  The agent expects: ${expected.length ? expected.join(' | ') : '(no expected results)'}\n` +
          (matched
            ? '  Your value appears in it.'
            : '  Your value does not appear in it: check which one the story states.')
      );
      events.push({
        kind: 'forced_value',
        gate,
        reviewer,
        answered_at: now(),
        test_case_id: c.test_case_id,
        matched,
      });
    }
    const a = await decide();
    if (a === 'q') return quit();
    decisions[c.test_case_id] = a === 'a' ? 'approved' : 'rejected';
  }
  events.push({
    kind: 'case_loop',
    gate,
    reviewer,
    decided_at: now(),
    real_cases: drafts.length,
    rejected_real: Object.values(decisions).filter((d) => d === 'rejected')
      .length,
    canaries: events.filter((e) => e.kind === 'canary').length,
  });
  return { quit: false, decisions, events };
}

/**
 * Append events to the runner's log at `root`/gates/canaries.json,
 * validated before it is written.
 * @param {string} root
 * @param {any[]} events
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function writeCanaryLog(root, events) {
  if (!events.length) return { ok: true };
  const path = join(root, CANARY_LOG);
  /** @type {any} */
  let log = { schema_version: '1.0', events: [] };
  if (existsSync(path)) {
    const read = readJson(path);
    if (!read.ok) return { ok: false, message: read.message };
    log = read.data;
  }
  log.events = [...(log.events ?? []), ...events];
  const w = writeJsonAtomic(path, log, { schemaPath: SCHEMA, root });
  return w.ok ? { ok: true } : { ok: false, message: w.message };
}

/**
 * Catch and false-alarm rates over many runs' logs. A false alarm is a real
 * case rejected; some rejections are right, so it is an upper bound on how
 * often the reviewer rejects a case that was fine.
 * @param {any[]} logs parsed gates/canaries.json documents
 */
export function canaryMetrics(logs) {
  const events = logs.flatMap((l) => l?.events ?? []);
  const canaries = events.filter((e) => e.kind === 'canary');
  const caught = canaries.filter((e) => e.result === 'caught').length;
  const loops = events.filter((e) => e.kind === 'case_loop');
  const real = loops.reduce((a, e) => a + e.real_cases, 0);
  const rejected = loops.reduce((a, e) => a + e.rejected_real, 0);
  const values = events.filter((e) => e.kind === 'forced_value');
  const matched = values.filter((e) => e.matched).length;
  return {
    runs_with_log: logs.length,
    canaries: {
      planted: canaries.length,
      caught,
      ...rate(caught, canaries.length),
    },
    by_kind: Object.fromEntries(
      ['comparison', 'number', 'negation', 'invented_rule'].map((k) => {
        const of = canaries.filter((e) => e.plant?.kind === k);
        return [
          k,
          {
            planted: of.length,
            caught: of.filter((e) => e.result === 'caught').length,
          },
        ];
      })
    ),
    real_cases: { decided: real, rejected, ...rate(rejected, real) },
    forced_values: {
      asked: values.length,
      matched,
      ...rate(matched, values.length),
    },
  };
}

/**
 * The metrics Markdown lines.
 * @param {ReturnType<typeof canaryMetrics>} m
 * @param {number} totalRuns
 * @returns {string[]}
 */
export function canaryLines(m, totalRuns) {
  const pct = (
    /** @type {{ value: number | null, wilson_95: [number, number] | null }} */ r
  ) =>
    r.value === null
      ? 'n/a'
      : `${Math.round(r.value * 100)}% (95% interval ${Math.round((r.wilson_95?.[0] ?? 0) * 100)}–${Math.round((r.wilson_95?.[1] ?? 0) * 100)}%)`;
  if (!m.runs_with_log)
    return [
      `- No run carries a canary log yet (0/${totalRuns}): the Gate 2 catch rate is unknown, not zero.`,
    ];
  return [
    `- Canaries caught at Gate 2: ${m.canaries.caught}/${m.canaries.planted} = ${pct(m.canaries)}`,
    `- By kind: ${Object.entries(m.by_kind)
      .map(([k, v]) => `${k} ${v.caught}/${v.planted}`)
      .join(', ')}`,
    `- Real cases rejected (false-alarm ceiling): ${m.real_cases.rejected}/${m.real_cases.decided} = ${pct(m.real_cases)}`,
    `- Red-domain P0 values typed that matched the agent's: ${m.forced_values.matched}/${m.forced_values.asked} = ${pct(m.forced_values)}`,
    `- Over ${m.runs_with_log}/${totalRuns} run(s) with a canary log. Small counts: read the interval, not the point.`,
  ];
}
