// @ts-check
// Independence for Red-domain approvals (docs/review-gates.md, "Independence
// at Gates 2 and 4").
//
// On the `full` track, an approval at Gate 2 or Gate 4 must rest on more than
// the word of the person who ran the step it reviews. One of these applies,
// and the decision records which:
//
//   second_reviewer  the person deciding is not the operator of what they
//                    approve: the first person whose terminal session opened
//                    this gate on these inputs (the operator who ran the
//                    step opens it once and quits; a gate reached right
//                    after deciding another one notes nobody). Inputs that
//                    change, an edit after a rejection included, get a new
//                    operator;
//   delay            at least an hour (config/gate-checks.json can make it
//                    longer, never shorter) passed between the first time
//                    the brief for these same inputs was shown and the
//                    decision;
//   outside_review   the team's sampled outside review: offered only when
//                    the team set a sampling rate, and drawn when the
//                    decision is recorded; a draw that selected the gate
//                    holds for the rest of the run, and one for the same
//                    inputs is never made again, so the reviewer can
//                    neither know the draw in advance nor draw again.
//
// An advisory AI review joins these once it exists (its accuracy measured on
// canaries). A rejection needs none of them. Names are the ones people decide
// as (QAIZEN_REVIEWER or git user.name): declared, not authenticated, unless
// the records are signed (docs/signed-gate-records.md).
//
// Pure except authoredDigest, which reads the reviewed files; the runner does
// the rest of the I/O.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson, gateDigest, semanticCase } from './approval-binding.js';

/** The gates that need independence on the full track, and the step each reviews. */
export const INDEPENDENT_GATES = Object.freeze(
  /** @type {Record<string, string>} */ ({
    test_scope_reviewed: 'test-designer',
    code_reviewed: 'generator',
    api_assertions_reviewed: 'api',
  })
);

/** The shortest delay that counts, in minutes. */
export const MIN_DELAY_MINUTES = 60;
/** The lowest outside-review sampling rate a team can set. */
export const MIN_OUTSIDE_RATE = 0.1;

/**
 * @typedef {{ control: 'second_reviewer', operator: string,
 *     noted_at: string }
 *   | { control: 'delay', operator: string | null,
 *     brief_first_shown_at: string, minutes: number }
 *   | { control: 'outside_review', operator: string | null, rate: number,
 *     selected: boolean, input_digest: string }} Independence
 * @typedef {{ minDelayMinutes: number, outsideRate: number | null }} IndependenceConfig
 */

/**
 * Whether an approval at this gate needs independence.
 * @param {string} track the effective track
 * @param {string} gate a review_gates key
 */
export function needsIndependence(track, gate) {
  return track === 'full' && Object.hasOwn(INDEPENDENT_GATES, gate);
}

/**
 * The team's settings, from the `independence` object of
 * config/gate-checks.json. Absent means the defaults: an hour, and no
 * outside review. A value that cannot apply is an error, never a silent
 * default.
 * @param {any} gateChecks the parsed config file, or null when absent
 * @returns {{ ok: true, config: IndependenceConfig } | { ok: false, message: string }}
 */
export function independenceConfig(gateChecks) {
  const set = gateChecks?.independence;
  if (set === undefined || set === null)
    return {
      ok: true,
      config: { minDelayMinutes: MIN_DELAY_MINUTES, outsideRate: null },
    };
  const where = 'config/gate-checks.json independence';
  if (typeof set !== 'object' || Array.isArray(set))
    return { ok: false, message: `${where} must be an object` };
  const delay = set.min_delay_minutes ?? MIN_DELAY_MINUTES;
  if (
    typeof delay !== 'number' ||
    !Number.isFinite(delay) ||
    delay < MIN_DELAY_MINUTES
  )
    return {
      ok: false,
      message: `${where}.min_delay_minutes is ${JSON.stringify(delay)}; it is a number of minutes, ${MIN_DELAY_MINUTES} or more`,
    };
  const rate = set.outside_review_rate ?? null;
  if (
    rate !== null &&
    (typeof rate !== 'number' || !(rate >= MIN_OUTSIDE_RATE && rate <= 1))
  )
    return {
      ok: false,
      message: `${where}.outside_review_rate is ${JSON.stringify(rate)}; it is a share of decisions between ${MIN_OUTSIDE_RATE} and 1, or absent when there is no outside review`,
    };
  return { ok: true, config: { minDelayMinutes: delay, outsideRate: rate } };
}

/** @param {string | null | undefined} name */
const norm = (name) =>
  (name ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase() ||
  null;

/** @param {string | Buffer} data */
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * The digest of what the step's operator produced for this gate. For Gate 4
 * it is the gate's input digest. For Gate 2 it leaves out each case's
 * approval state (`status`), which the reviewer sets when deciding the
 * cases, so deciding them is not authoring them.
 * @param {string} gate
 * @param {any} context
 * @param {string} [root]
 */
export function authoredDigest(gate, context, root = '.') {
  if (gate !== 'test_scope_reviewed') return gateDigest(gate, context, root);
  const read = (/** @type {string | undefined} */ rel) =>
    rel && existsSync(join(root, rel)) ? readFileSync(join(root, rel)) : null;
  const casesRaw = read(context?.artifact_paths?.test_cases);
  /** @type {any} */
  let cases = null;
  if (casesRaw) {
    try {
      const doc = JSON.parse(casesRaw.toString('utf8'));
      cases = {
        ...doc,
        test_cases: (doc.test_cases ?? []).map(
          (/** @type {Record<string, any>} */ tc) => {
            const c = semanticCase(tc);
            delete c.status;
            return c;
          }
        ),
      };
    } catch {
      cases = sha256(casesRaw);
    }
  }
  const brief = read(context?.artifact_paths?.planner_brief);
  return sha256(
    canonicalJson({
      gate,
      upstream: gateDigest('requirements_reviewed', context, root),
      cases,
      brief: brief ? sha256(brief) : null,
    })
  );
}

/**
 * Note the operator of what a gate reviews: the first session that opens
 * the gate on these inputs. Inputs that change get the session that opens
 * the gate on them next.
 * @param {any} context
 * @param {string} gate
 * @param {string} digest authoredDigest of the gate now
 * @param {string | null} operator
 * @param {string} at
 * @returns {boolean} whether the context changed
 */
export function recordOperator(context, gate, digest, operator, at) {
  if (!Object.hasOwn(INDEPENDENT_GATES, gate)) return false;
  const ri = (context.review_independence ??= {});
  const operators = (ri.operators ??= {});
  if (operators[gate]?.authored_digest === digest) return false;
  operators[gate] = { operator: operator || null, authored_digest: digest, at };
  return true;
}

/**
 * Note that a gate's brief was shown for these inputs. The first showing
 * counts; inputs that changed start the clock again.
 * @param {any} context
 * @param {string} gate
 * @param {string} digest the gate's input digest while the brief is shown
 * @param {string} at
 * @returns {boolean} whether the context changed
 */
export function recordBriefShown(context, gate, digest, at) {
  if (!Object.hasOwn(INDEPENDENT_GATES, gate)) return false;
  const ri = (context.review_independence ??= {});
  const briefs = (ri.briefs ??= {});
  if (briefs[gate]?.input_digest === digest) return false;
  briefs[gate] = { input_digest: digest, first_shown_at: at };
  return true;
}

/**
 * What independence an approval can rest on, at the moment of the decision.
 * @param {{ context: any, gate: string, reviewer: string | null,
 *   digest: string, authored: string, at: string,
 *   config: IndependenceConfig }} args
 *   `digest`: the gate's input digest; `authored`: its authoredDigest
 * @returns {{ operator: string | null,
 *   second: Independence | null, delay: Independence | null,
 *   waitUntil: string | null, outsideRate: number | null,
 *   earlierDraw: boolean | null, why: string[] }}
 */
export function independenceOptions({
  context,
  gate,
  reviewer,
  digest,
  authored,
  at,
  config,
}) {
  const noted = context?.review_independence?.operators?.[gate] ?? null;
  const current = noted?.authored_digest === authored ? noted : null;
  const operator = current?.operator ?? null;
  /** @type {string[]} */
  const why = [];

  /** @type {Independence | null} */
  let second = null;
  if (!current)
    why.push(
      `no operator is noted for these inputs (the first session that opens the gate on them is)`
    );
  else if (!operator)
    why.push('the operator noted for these inputs has no name');
  else if (!norm(reviewer))
    why.push('no reviewer name is known for this decision');
  else if (norm(operator) === norm(reviewer))
    why.push(`${operator}, the operator noted for these inputs, is deciding`);
  else
    second = {
      control: 'second_reviewer',
      operator,
      noted_at: current.at,
    };

  /** @type {Independence | null} */
  let delay = null;
  /** @type {string | null} */
  let waitUntil = null;
  const brief = context?.review_independence?.briefs?.[gate];
  const shown =
    brief?.input_digest === digest ? Date.parse(brief.first_shown_at) : NaN;
  const now = Date.parse(at);
  if (Number.isNaN(shown) || Number.isNaN(now) || now < shown)
    why.push('when the brief for these inputs was first shown is not recorded');
  else {
    const minutes = Math.floor((now - shown) / 60000);
    if (minutes >= config.minDelayMinutes)
      delay = {
        control: 'delay',
        operator,
        brief_first_shown_at: brief.first_shown_at,
        minutes,
      };
    else {
      waitUntil = new Date(
        shown + config.minDelayMinutes * 60000
      ).toISOString();
      why.push(
        `the brief for these inputs was first shown ${minutes} minute(s) ago, under ${config.minDelayMinutes}`
      );
    }
  }

  // An outside-review draw made before stands: one that selected this gate
  // holds for the rest of the run, so changing the inputs does not escape
  // it, and one for these same inputs is not drawn again.
  const draws = (context?.gate_decisions ?? []).filter(
    (/** @type {any} */ d) =>
      d?.gate === gate && d?.independence?.control === 'outside_review'
  );
  const earlierDraw = draws.some(
    (/** @type {any} */ d) => d.independence.selected === true
  )
    ? true
    : draws.some(
          (/** @type {any} */ d) => d.independence.input_digest === digest
        )
      ? false
      : null;
  return {
    operator,
    second,
    delay,
    waitUntil,
    outsideRate: config.outsideRate,
    earlierDraw,
    why,
  };
}

/**
 * The control an approval rests on: a second reviewer (unless the reviewer
 * said they are the operator after all), else the delay, else the outside
 * review when the reviewer chose it and the team has one. The draw is made
 * here with `rng` (which the caller must give: the runner gives crypto
 * randomness), unless an earlier draw stands.
 * @param {ReturnType<typeof independenceOptions>} options
 * @param {{ outside?: boolean, notOperator?: boolean, digest?: string,
 *   rng?: () => number }} [choice]
 * @returns {Independence | null}
 */
export function resolveIndependence(options, choice = {}) {
  if (options.second && choice.notOperator !== false) return options.second;
  if (options.delay) return options.delay;
  if (choice.outside && options.outsideRate !== null) {
    const rng = choice.rng;
    if (options.earlierDraw === null && !rng)
      throw new Error('resolveIndependence: the outside review needs an rng');
    return {
      control: 'outside_review',
      operator: options.operator,
      rate: options.outsideRate,
      selected:
        options.earlierDraw ??
        /** @type {() => number} */ (rng)() < options.outsideRate,
      input_digest: choice.digest ?? '',
    };
  }
  return null;
}

/**
 * One line naming the control, for the gate record and the terminal.
 * @param {Independence} i
 */
export function independenceLine(i) {
  if (i.control === 'second_reviewer')
    return `second reviewer: ${i.operator} is the operator of these inputs (noted ${i.noted_at})`;
  if (i.control === 'delay')
    return `delay: decided ${i.minutes} minute(s) after the brief was first shown (${i.brief_first_shown_at})${i.operator ? `; ${i.operator} is the operator of these inputs` : ''}`;
  return `sampled outside review (rate ${i.rate}): ${i.selected ? 'marked for outside review' : 'not drawn this time'}`;
}

/**
 * Why an approval cannot be recorded yet, and what would allow it.
 * @param {ReturnType<typeof independenceOptions>} options
 * @param {number} minDelayMinutes
 * @returns {string[]}
 */
export function refusalLines(options, minDelayMinutes) {
  return [
    'On the full track this approval needs a second reviewer or a compensating control (docs/review-gates.md, "Independence at Gates 2 and 4"), and none applies:',
    ...options.why.map((w) => `  - ${w};`),
    'It can be approved by:',
    '  - another person, in their own session, who is not the operator of these inputs;',
    `  - you, ${minDelayMinutes} minutes or more after the brief was first shown${options.waitUntil ? ` (from ${options.waitUntil})` : ''}: quit and --resume then;`,
    options.outsideRate === null
      ? '  - the sampled outside review, once the team sets independence.outside_review_rate in config/gate-checks.json.'
      : '  - the sampled outside review, which you declined.',
    'A rejection needs none of these.',
  ];
}

/**
 * How full-track approvals at the independent gates rested on each control.
 * @param {any[]} contexts one parsed context.json per run
 */
export function independenceMetrics(contexts) {
  const counts = {
    second_reviewer: 0,
    delay: 0,
    outside_review: 0,
    outside_selected: 0,
  };
  for (const ctx of contexts)
    for (const d of ctx?.gate_decisions ?? []) {
      const i = d?.independence;
      if (d?.decision !== 'approved' || !i) continue;
      if (i.control in counts)
        counts[
          /** @type {'second_reviewer' | 'delay' | 'outside_review'} */ (
            i.control
          )
        ] += 1;
      if (i.control === 'outside_review' && i.selected)
        counts.outside_selected += 1;
    }
  return counts;
}

/**
 * The metrics lines.
 * @param {ReturnType<typeof independenceMetrics>} m
 * @returns {string[]}
 */
export function independenceLines(m) {
  const total = m.second_reviewer + m.delay + m.outside_review;
  if (!total)
    return [
      '- No full-track approval at Gate 2 or Gate 4 records what it rested on.',
    ];
  return [
    `- ${total} full-track approval(s) at Gate 2 or Gate 4: ${m.second_reviewer} by a second reviewer, ${m.delay} after the delay, ${m.outside_review} on the sampled outside review (${m.outside_selected} marked for it).`,
    '- A second reviewer and a delay are recorded by the runner; neither shows how carefully anyone read.',
  ];
}
