// @ts-check
// Canaries: measuring the Gate 2 review itself.
//
// A review nobody tests has no known catch rate. While the reviewer decides
// each draft test case before Gate 2, the runner (never the maintainer, who
// would know where it is) plants a synthetic case at a low random rate: one
// that contradicts an acceptance criterion (a comparison, a number or a
// negation changed) or invents a business rule the story never states. It is
// shown exactly like a real case, every case labelled by its place in the
// loop rather than its id. Right after the reviewer decides it, the
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

/** About one canary per ten case decisions. */
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

/**
 * Rules a story could plausibly state but these do not. A rule is used only
 * when its topic is the story's and the story says nothing about it, so a
 * case built on it invents a business rule.
 * @type {{ rule: string, topic: RegExp, avoid: RegExp }[]}
 */
export const INVENTED_RULES = [
  {
    rule: 'A second coupon code doubles the discount',
    topic: /\b(coupon|discount)/i,
    avoid: /\b(second|two|double|stack)/i,
  },
  {
    rule: 'Orders above $500.00 need a manager approval before payment',
    topic: /\b(order|checkout|payment)/i,
    avoid: /\b(manager|approv|\$500)/i,
  },
  {
    rule: 'Guest shoppers can keep at most three items in the cart',
    topic: /\bcart\b/i,
    avoid: /\b(guest|three|limit|maximum)/i,
  },
  {
    rule: 'Prices are rounded up to the next whole dollar at checkout',
    topic: /\b(price|total|checkout)/i,
    avoid: /\bround/i,
  },
  {
    rule: 'Removing the last item from the cart also signs the shopper out',
    topic: /\b(cart|remov)/i,
    avoid: /\b(sign|log)(s|ged|ging)? ?out\b/i,
  },
  {
    rule: 'Three failed sign-in attempts lock the account for an hour',
    topic: /\b(log ?in|sign ?in|password)/i,
    avoid: /\b(lock|attempt)/i,
  },
  {
    rule: 'A session expires after five minutes without activity',
    topic: /\b(log ?in|sign ?in|session)/i,
    avoid: /\b(expir|timeout|inactiv|idle)/i,
  },
  {
    rule: 'A user created through the API stays disabled until an administrator enables it',
    topic: /\b(api|endpoint)\b.*\buser|\buser\b.*\b(api|endpoint)\b/i,
    avoid: /\b(disabled|administrator|admin|enable)/i,
  },
  {
    rule: 'The sort order resets to the default whenever the page reloads',
    topic: /\bsort/i,
    avoid: /\b(reset|reload|default)/i,
  },
];

/**
 * Opposites. "at least" and "at most" are not each other's opposite (both
 * hold at the boundary), so each maps to the comparison that excludes it.
 */
const OPPOSITES = [
  ['more than', 'less than'],
  ['less than', 'more than'],
  ['greater than', 'less than'],
  ['fewer than', 'more than'],
  ['at least', 'fewer than'],
  ['at most', 'more than'],
  ['or less', 'or more'],
  ['or more', 'or less'],
  ['before', 'after'],
  ['after', 'before'],
  ['without', 'with'],
];

/** Keep the case of the first letter of what is replaced. */
const likeCase = (/** @type {string} */ was, /** @type {string} */ now) =>
  /^[A-Z]/.test(was) ? now.charAt(0).toUpperCase() + now.slice(1) : now;

const NEGATED_BEFORE = /\b(not|no|never|without)\b/i;

/**
 * @typedef {{ kind: 'comparison' | 'number' | 'negation', from: string,
 *   to: string, text: string }} Mutation
 */

/**
 * The ways a main clause can be made to contradict itself: a comparison
 * reversed, a number that is not itself negated changed, a negation dropped,
 * or one added to a clause that has none.
 * @param {string} clause
 * @returns {Mutation[]}
 */
export function mutations(clause) {
  /** @type {Mutation[]} */
  const out = [];
  for (const [a, b] of OPPOSITES) {
    const m = new RegExp(`\\b${a}\\b`, 'i').exec(clause);
    if (m) {
      const to = likeCase(m[0], b);
      out.push({
        kind: 'comparison',
        from: m[0],
        to: b,
        text:
          clause.slice(0, m.index) + to + clause.slice(m.index + m[0].length),
      });
      break;
    }
  }
  for (const m of clause.matchAll(/\$?\d+(?:\.\d+)?/g)) {
    const before = clause.slice(0, m.index).split(/\s+/).slice(-4).join(' ');
    if (NEGATED_BEFORE.test(before)) continue;
    const raw = m[0];
    const n = Number(raw.replace('$', ''));
    const changed = raw.includes('.')
      ? (n + 1).toFixed(raw.split('.')[1].length)
      : String(n + 1);
    const to = `${raw.startsWith('$') ? '$' : ''}${changed}`;
    out.push({
      kind: 'number',
      from: raw,
      to,
      text:
        clause.slice(0, m.index) +
        to +
        clause.slice(/** @type {number} */ (m.index) + raw.length),
    });
    break;
  }
  const not = /\b(not|no longer|never)\s+/i.exec(clause);
  if (not) {
    const rest =
      clause.slice(0, not.index) + clause.slice(not.index + not[0].length);
    out.push({
      kind: 'negation',
      from: not[1],
      to: '(removed)',
      text: not.index === 0 ? likeCase('A', rest) : rest,
    });
  } else if (!/\bno\b/i.test(clause)) {
    // Only the main verb: an "is" further in belongs to a subordinate
    // clause, and negating it garbles the sentence.
    const verb = /\b(is|are)\s+/i.exec(clause);
    if (verb && clause.slice(0, verb.index).split(/\s+/).length <= 6)
      out.push({
        kind: 'negation',
        from: verb[1],
        to: `${verb[1]} not`,
        text:
          clause.slice(0, verb.index) +
          `${verb[1]} not ` +
          clause.slice(verb.index + verb[0].length),
      });
  }
  return out;
}

/**
 * The main clause of a criterion's outcome: what follows its last "then", its
 * first sentence, without asides in brackets. Null when it has no "then".
 * @param {string} ac
 * @returns {string | null}
 */
export function outcomeOf(ac) {
  const thens = [...ac.matchAll(/\bthen\s+/gi)];
  if (!thens.length) return null;
  const last = thens[thens.length - 1];
  const clause = ac
    .slice(/** @type {number} */ (last.index) + last[0].length)
    .replace(/\s*\([^)]*\)/g, '')
    .split(/(?<=[.!?;])\s|\s+[—–]\s+/)[0]
    .trim()
    .replace(/[.!?;,]$/, '');
  return clause ? clause.charAt(0).toUpperCase() + clause.slice(1) : null;
}

/** A clause starting with a pronoun reads as a fragment, not a title. */
const PRONOUN_START = /^(they|it|he|she|we|you|this|that)\b/i;

/**
 * Pick one element.
 * @template T
 * @param {T[]} xs
 * @param {Rng} rng
 * @returns {T}
 */
function pick(xs, rng) {
  return xs[Math.floor(rng() * xs.length)];
}

/**
 * A canary for these cases: a case that contradicts a criterion of the
 * context, or one built on a rule of the story's topic that the story never
 * states, with the facts a real case of this run shows. Null when neither
 * can be made, so nothing implausible is shown.
 * @param {any} context
 * @param {Case[]} cases every case of the file, decided or not
 * @param {Rng} rng
 * @param {{ story?: string | null }} [opts] the story file's text
 * @returns {Canary | null}
 */
export function makeCanary(context, cases, rng, { story = null } = {}) {
  const criteria = /** @type {string[]} */ (context?.acceptance_criteria ?? []);
  const all = criteria.flatMap((ac, i) => {
    const clause = outcomeOf(ac);
    if (!clause || clause.length > 120) return [];
    return mutations(clause).map((m) => ({ ...m, criterion: i, clause }));
  });
  const readable = all.filter((m) => !PRONOUN_START.test(m.clause));
  const options = readable.length ? readable : all;
  const text = [story ?? '', ...criteria].join('\n');
  const rules = INVENTED_RULES.filter(
    (r) => r.topic.test(text) && !r.avoid.test(text)
  );
  if (!options.length && !rules.length) return null;

  /** @type {Plant} */
  let plant;
  let title;
  /** @type {number | null} */
  let criterion = null;
  if (options.length && (!rules.length || rng() >= 0.25)) {
    const m = pick(options, rng);
    criterion = m.criterion;
    plant = {
      kind: m.kind,
      criterion: m.criterion + 1,
      from: m.from,
      to: m.to,
    };
    title = m.text;
  } else {
    const r = pick(rules, rng);
    plant = { kind: 'invented_rule', rule: r.rule };
    title = r.rule;
  }

  // Look like this run's cases: a decision, a priority and a risk its cases
  // use. The id is the next unused one; it is logged, never shown.
  const next = cases.reduce((max, c) => {
    const m = /^TC-(\d+)$/.exec(c.test_case_id);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  const width =
    /^TC-(\d+)$/.exec(cases[0]?.test_case_id ?? '')?.[1].length ?? 3;
  const decisions = cases.map((c) => c.automation_decision).filter(Boolean);
  const priorities = cases.map((c) => c.priority).filter(Boolean);
  const related = /** @type {any[]} */ (context?.risks ?? []).filter(
    (r) => criterion !== null && (r.related_acs ?? []).includes(criterion)
  );
  return {
    plant,
    case: {
      test_case_id: `TC-${String(next + 1).padStart(width, '0')}`,
      title,
      status: 'draft',
      automation_decision: decisions.length
        ? pick(decisions, rng)
        : 'automate_e2e',
      priority: priorities.length ? pick(priorities, rng) : 'P1',
      risk_ids: related.length
        ? [pick(related, rng).risk_id]
        : (pick(cases, rng)?.risk_ids ?? []),
      // What a P0 canary in a Red-domain story shows after the value
      // question, as a real case shows its expected results.
      expected_results: [`${title}.`],
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
    if (rng() < canaryRate) slots[Math.floor(rng() * (n + 1))] += 1;
  return slots;
}

/** What the reveal says the canary was. */
export function plantText(/** @type {Plant} */ plant) {
  return plant.kind === 'invented_rule'
    ? `it states a rule this story does not ("${plant.rule}")`
    : plant.kind === 'negation' && plant.to === '(removed)'
      ? `it drops the "${plant.from}" of acceptance criterion ${plant.criterion}`
      : `it changes acceptance criterion ${plant.criterion}: "${plant.from}" became "${plant.to}"`;
}

/** Words, punctuation and case aside. */
const words = (/** @type {string} */ s) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** The numbers in a text, by value: "$40" and "40.00" are the same. */
const numbers = (/** @type {string} */ s) =>
  [...s.replace(/(\d),(?=\d{3}\b)/g, '$1').matchAll(/\d+(?:\.\d+)?/g)].map(
    (m) => Number(m[0])
  );

/**
 * Does the value the reviewer typed appear in the agent's expected results?
 * Numbers are compared by value, currency signs and units aside; otherwise
 * the typed words must appear in order. A stray letter matches nothing.
 * @param {string} typed
 * @param {string[]} expected
 */
export function valueMatches(typed, expected) {
  const have = expected.join(' ');
  const want = numbers(typed);
  if (want.length) {
    const got = numbers(have);
    return want.every((n) => got.includes(n));
  }
  const w = words(typed);
  const h = words(have);
  if (!w.length) return false;
  for (let i = 0; i + w.length <= h.length; i++)
    if (w.every((x, j) => h[i + j] === x)) return true;
  return false;
}

/**
 * The Gate 2 per-case loop: every draft case decided one at a time, with the
 * canaries planted among them and the value question on a Red-domain P0.
 * Cases are labelled by their place in the loop, not by id, so a canary's id
 * cannot give it away. `ask` returns the reviewer's answer (`q` quits); `say`
 * shows a line. Decisions are returned for the real drafts only; `summary`,
 * the loop's own event, is logged once the decisions are saved.
 * @param {{
 *   drafts: Case[], cases: Case[], context: any, story?: string | null,
 *   redDomain: boolean,
 *   ask: (question: string) => Promise<string>, say: (line: string) => void,
 *   rng: Rng, now?: () => string, reviewer?: string | null,
 *   gate?: string, canaryRate?: number,
 * }} args
 * @returns {Promise<{ quit: true, events: any[] }
 *   | { quit: false, decisions: Record<string, 'approved' | 'rejected'>,
 *       events: any[], summary: any }>}
 */
export async function caseLoop({
  drafts,
  cases,
  context,
  story = null,
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
  let place = 0;
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
  /**
   * Show a case and, for a Red-domain P0, ask its value first.
   * @param {Case} c
   * @returns {Promise<{ quit: true } | { quit: false, matched: boolean | null }>}
   */
  const present = async (c) => {
    place += 1;
    say(`\n${describeCase(c, `Case ${place}`)}`);
    if (!(redDomain && c.priority === 'P0'))
      return { quit: false, matched: null };
    let typed = '';
    while (!typed)
      typed = (
        await ask(
          "  Red-domain P0: type the value this case must expect, from the story, before you see the agent's ([q] quits): "
        )
      ).trim();
    if (typed.toLowerCase() === 'q') return { quit: true };
    const expected = c.expected_results ?? [];
    const matched = valueMatches(typed, expected);
    say(
      `  The agent expects: ${expected.length ? expected.join(' | ') : '(no expected results)'}\n` +
        (matched
          ? '  Your value appears in it.'
          : '  Your value does not appear in it: check which one the story states.')
    );
    return { quit: false, matched };
  };
  const quit = () => ({ quit: /** @type {true} */ (true), events });

  for (let slot = 0; slot <= drafts.length; slot++) {
    for (let k = 0; k < slots[slot]; k++) {
      const canary = makeCanary(context, shown, rng, { story });
      if (!canary) continue;
      shown.push(canary.case);
      const plantedAt = now();
      const p = await present(canary.case);
      if (p.quit) return quit();
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
    const p = await present(c);
    if (p.quit) return quit();
    if (p.matched !== null)
      events.push({
        kind: 'forced_value',
        gate,
        reviewer,
        answered_at: now(),
        test_case_id: c.test_case_id,
        matched: p.matched,
      });
    const a = await decide();
    if (a === 'q') return quit();
    decisions[c.test_case_id] = a === 'a' ? 'approved' : 'rejected';
  }
  return {
    quit: false,
    decisions,
    events,
    summary: {
      kind: 'case_loop',
      gate,
      reviewer,
      decided_at: now(),
      real_cases: drafts.length,
      rejected_real: Object.values(decisions).filter((d) => d === 'rejected')
        .length,
      canaries: events.filter((e) => e.kind === 'canary').length,
    },
  };
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
 * @param {any[]} logs parsed gates/canaries.json documents, valid ones only
 * @param {number} [invalid] archived logs left out because they do not
 *   validate
 */
export function canaryMetrics(logs, invalid = 0) {
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
    invalid_logs: invalid,
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
      ...(m.invalid_logs
        ? [
            `- ${m.invalid_logs} archived canary log(s) left out: they do not validate.`,
          ]
        : []),
    ];
  return [
    `- Canaries caught at Gate 2: ${m.canaries.caught}/${m.canaries.planted} = ${pct(m.canaries)}`,
    `- By kind: ${Object.entries(m.by_kind)
      .map(([k, v]) => `${k} ${v.caught}/${v.planted}`)
      .join(', ')}`,
    `- Real cases rejected (false-alarm ceiling): ${m.real_cases.rejected}/${m.real_cases.decided} = ${pct(m.real_cases)}`,
    `- Red-domain P0 values typed that matched the agent's: ${m.forced_values.matched}/${m.forced_values.asked} = ${pct(m.forced_values)}`,
    `- Over ${m.runs_with_log}/${totalRuns} run(s) with a canary log. Small counts: read the interval, not the point.`,
    ...(m.invalid_logs
      ? [
          `- ${m.invalid_logs} archived canary log(s) left out: they do not validate against schemas/canary-log.schema.json.`,
        ]
      : []),
  ];
}
