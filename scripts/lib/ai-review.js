// @ts-check
// The advisory AI review at Gates 3 and 4 (docs/review-gates.md, "Advisory
// AI review").
//
// An operator runs the Spec Reviewer (Gate 3) or the Test Reviewer (Gate 4)
// on what the gate reviews; it writes a review naming the gate's input digest
// and its round. At the gate, the reviewer is asked for their own concerns
// before seeing the AI's findings, and answers each finding (fixed, wrong,
// intentional, irrelevant; scripts/lib/finding-dispositions.js) before the
// decision. The review never decides: it has no field that could approve,
// and nothing here sets a gate.
//
// A review is used only while its input digest is the gate's current one. A
// gate gets at most three rounds of review in a run: a round counts when its
// review is first shown at the gate (context.json ai_reviews[]), and after
// the first round only what changed since the previous one is reviewed. With
// `ai_review: "on"` in config/gate-checks.json the runner asks for a review
// before each gate; with "off" (the default) it uses one only if it exists.
//
// Pure except readReview, which reads the review file.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateValue } from './artifact-io.js';

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** At most this many review rounds per gate in a run. */
export const MAX_ROUNDS = 3;

/**
 * The gates an AI review assists, with the step that asks for it, the agent
 * that writes it and where.
 * @type {Readonly<Record<string, { step: string, agent: string, dir: string,
 *   suffix: string, schema: string, what: string, version: RegExp }>>}
 */
export const AI_REVIEW_GATES = Object.freeze({
  specs_reviewed: {
    step: 'ai-review-spec',
    agent: 'agents/spec-reviewer.md',
    dir: 'analysis/spec-reviews',
    suffix: '.spec-review.json',
    schema: 'schemas/spec-review.schema.json',
    what: 'spec',
    // 1.x spec reviews predate binding: they are history, never used.
    version: /^2\./,
  },
  code_reviewed: {
    step: 'ai-review-test',
    agent: 'agents/test-reviewer.md',
    dir: 'analysis/test-reviews',
    suffix: '.test-review.json',
    schema: 'schemas/test-review.schema.json',
    what: 'generated test',
    version: /^1\./,
  },
});

/** The step that asks for each gate's review. */
export const AI_REVIEW_STEPS = Object.freeze(
  Object.fromEntries(
    Object.entries(AI_REVIEW_GATES).map(([gate, g]) => [g.step, gate])
  )
);

/**
 * Whether the runner asks for an AI review before Gates 3 and 4, from the
 * `ai_review` setting of config/gate-checks.json ("off" when absent).
 * @param {any} gateChecks the parsed config file, or null
 * @returns {{ ok: true, mode: 'off' | 'on' } | { ok: false, message: string }}
 */
export function aiReviewMode(gateChecks) {
  const v = gateChecks?.ai_review ?? 'off';
  if (v === 'off' || v === 'on') return { ok: true, mode: v };
  return {
    ok: false,
    message: `config/gate-checks.json ai_review is ${JSON.stringify(v)}; use "off" or "on"`,
  };
}

/**
 * The review file of a gate, relative to the run.
 * @param {string} gate
 * @param {any} context
 */
export function reviewPath(gate, context) {
  const g = AI_REVIEW_GATES[gate];
  return `${g.dir}/${context?.story?.id ?? '<story-id>'}${g.suffix}`;
}

/**
 * The rounds already shown at a gate in this run.
 * @param {any} context
 * @param {string} gate
 * @returns {any[]}
 */
export const roundsShown = (context, gate) =>
  (context?.ai_reviews ?? []).filter(
    (/** @type {any} */ r) => r?.gate === gate
  );

/**
 * @typedef {'missing' | 'invalid' | 'legacy' | 'stale' | 'wrong_round'
 *   | 'capped'} Unusable
 * @typedef {{ usable: true, review: any, sha256: string, round: number,
 *   path: string, logged: boolean }
 *   | { usable: false, state: Unusable, path: string, reason: string,
 *       nextRound: number | null }} ReviewState
 */

/**
 * What the AI review of a gate is now, against the gate's current input
 * digest: usable (its digest is current, and its round is one already shown
 * or the next one), or why not.
 * @param {{ context: any, gate: string, digest: string, raw: string | null }} a
 *   `raw`: the review file's text, or null when there is none
 * @returns {ReviewState}
 */
export function reviewState({ context, gate, digest, raw }) {
  const g = AI_REVIEW_GATES[gate];
  const path = reviewPath(gate, context);
  const shown = roundsShown(context, gate);
  const used = new Set(shown.map((r) => r.sha256)).size;
  const nextRound = used < MAX_ROUNDS ? used + 1 : null;
  /** @param {Unusable} state @param {string} reason @returns {ReviewState} */
  const no = (state, reason) => ({
    usable: false,
    state,
    path,
    reason,
    nextRound,
  });
  const capped = () =>
    no(
      'capped',
      `the ${MAX_ROUNDS} review rounds of this gate are used, so no review is shown and none is asked for`
    );
  if (raw === null)
    return nextRound === null ? capped() : no('missing', `there is no ${path}`);
  const sha256 = createHash('sha256')
    .update(raw.replace(/\r\n/g, '\n'))
    .digest('hex');
  const earlier = shown.find((r) => r.sha256 === sha256);
  // With the rounds used, only a review already shown can be shown again;
  // anything else is past the cap, whatever its state.
  if (!earlier && nextRound === null) return capped();
  /** @type {any} */
  let review;
  try {
    review = JSON.parse(raw);
  } catch {
    return no('invalid', `${path} is not valid JSON`);
  }
  if (
    typeof review?.schema_version === 'string' &&
    !g.version.test(review.schema_version)
  )
    return no(
      'legacy',
      gate === 'specs_reviewed' && /^1\./.test(review.schema_version)
        ? `${path} is a schema_version ${review.schema_version} review, which names no input digest: it is not used`
        : `${path} has schema_version ${review.schema_version}, which this runner does not read`
    );
  const v = validateValue(review, join(REPO_DIR, g.schema));
  if (!v.ok)
    return no('invalid', `${path} does not validate against ${g.schema}`);
  if (review.story_id !== context?.story?.id)
    return no(
      'invalid',
      `${path} reviews ${review.story_id}, not ${context?.story?.id}`
    );
  if (review.input_digest !== digest)
    return no(
      'stale',
      `${path} reviewed other inputs than the gate's current ones`
    );
  if (earlier)
    return {
      usable: true,
      review,
      sha256,
      round: earlier.round,
      path,
      logged: true,
    };
  if (review.round !== nextRound)
    return no(
      'wrong_round',
      `${path} says round ${review.round}; the next round of this gate is ${nextRound}`
    );
  return {
    usable: true,
    review,
    sha256,
    // Not null: a new review past the cap returned capped above.
    round: /** @type {number} */ (nextRound),
    path,
    logged: false,
  };
}

/**
 * Read a gate's review file and say what it is.
 * @param {{ context: any, gate: string, digest: string, root?: string }} a
 * @returns {ReviewState}
 */
export function readReview({ context, gate, digest, root = '.' }) {
  const file = join(root, reviewPath(gate, context));
  return reviewState({
    context,
    gate,
    digest,
    raw: existsSync(file) ? readFileSync(file, 'utf8') : null,
  });
}

/**
 * Whether the runner should stop for an AI review before the gate: the team
 * asks for one, none is usable, and rounds are left.
 * @param {'off' | 'on'} mode
 * @param {ReviewState} state
 */
export const reviewNeeded = (mode, state) =>
  mode === 'on' && !state.usable && state.nextRound !== null;

/**
 * Count a review as a round, the first time it is shown at its gate.
 * @param {any} context
 * @param {string} gate
 * @param {Extract<ReviewState, { usable: true }>} state
 * @param {string} at
 * @returns {boolean} whether the context changed
 */
export function logRound(context, gate, state, at) {
  if (state.logged) return false;
  (context.ai_reviews ??= []).push({
    gate,
    round: state.round,
    review: state.path,
    sha256: state.sha256,
    input_digest: state.review.input_digest,
    shown_at: at,
  });
  return true;
}

/**
 * Text an AI wrote, made safe to print: control characters become spaces.
 * @param {unknown} text
 */
export const printable = (text) =>
  Array.from(String(text ?? ''), (c) => {
    const n = /** @type {number} */ (c.codePointAt(0));
    return n < 0x20 || (n >= 0x7f && n < 0xa0) ? ' ' : c;
  }).join('');

/** The rule prefix of each gate's AI findings: the metrics count them apart. */
export const RULE_PREFIX = Object.freeze(
  /** @type {Record<string, string>} */ ({
    specs_reviewed: 'ai-spec',
    code_reviewed: 'ai-test',
  })
);

/**
 * The review's findings as the findings the reviewer answers at the gate.
 * @param {string} gate
 * @param {any} review
 * @returns {import('./finding-dispositions.js').Finding[]}
 */
export function aiFindings(gate, review) {
  return (review?.findings ?? []).map((/** @type {any} */ f) => ({
    rule: `${RULE_PREFIX[gate]}:${f.type}`,
    line: Number.isInteger(f.line) ? f.line : null,
    test: f.tc_id ?? null,
    excerpt: printable(f.quote ?? ''),
    note: `[${f.severity ?? 'info'}] ${printable(f.description)}`,
  }));
}

/**
 * Blind first: what the gate asks before anything of the review is shown,
 * and the review it shows after the answer. The question carries nothing
 * the AI wrote.
 * @param {string} gate
 * @param {Extract<ReviewState, { usable: true }>} state
 * @returns {{ question: string, prompt: string, review: string[] }}
 */
export function blindFirst(gate, state) {
  return {
    question: `There is an AI review of this ${AI_REVIEW_GATES[gate].what}. Before it is shown: what concerns do you have, from your own reading?`,
    prompt: 'Your concerns (one line; Enter for none): ',
    review: reviewLines(gate, state),
  };
}

/**
 * The AI review as shown after the reviewer's own concerns: its findings and
 * recommendations, with no verdict of its own. Nothing found is said as
 * nothing reported, never as a pass.
 * @param {string} gate
 * @param {Extract<ReviewState, { usable: true }>} state
 * @returns {string[]}
 */
export function reviewLines(gate, state) {
  const g = AI_REVIEW_GATES[gate];
  const { review } = state;
  const findings = review.findings ?? [];
  const lines = [
    `AI review of the ${g.what} (round ${state.round} of ${MAX_ROUNDS}, ${state.path}). It is advice: the decision is yours.`,
  ];
  if (!findings.length)
    lines.push(
      `  The AI reviewer reported no findings. That does not mean the ${g.what} is right; it means this review found nothing to report.`
    );
  for (const [i, f] of findings.entries())
    lines.push(
      `  ${i + 1}. [${printable(f.severity ?? 'info')}] ${printable(f.type)}${f.tc_id ? ` ${printable(f.tc_id)}` : ''}${Number.isInteger(f.line) ? ` line ${f.line}` : ''}: ${printable(f.description)}`
    );
  for (const r of review.recommendations ?? [])
    lines.push(`  Suggestion: ${printable(r)}`);
  if (gate === 'specs_reviewed' && review.uncovered_risks?.length)
    lines.push(
      `  Risks with no covering case: ${printable(review.uncovered_risks.join(', '))} (${review.uncovered_high_severity_count ?? 0} high).`
    );
  return lines;
}

/**
 * The step instruction that asks for a review.
 * @param {string} gate
 * @param {any} context
 * @param {{ digest: string, round: number, previous: string | null }} a
 *   `previous`: the folder the last decision at this gate copied what it
 *   reviewed into, when there is one
 * @returns {string}
 */
export function reviewInstruction(gate, context, { digest, round, previous }) {
  const g = AI_REVIEW_GATES[gate];
  return [
    `Run the ${g.agent.replace(/^agents\/|\.md$/g, '')} (${g.agent}) on the ${g.what}; it writes ${reviewPath(gate, context)}.`,
    `  Give it these two values; the review must carry them as written:`,
    `    input_digest: ${digest}`,
    `    round: ${round}`,
    round > 1
      ? `  Round ${round} of ${MAX_ROUNDS}: review only what changed since round ${round - 1}${previous ? ` (what the last decision at this gate reviewed is copied under ${previous}/)` : ''}, and keep the earlier findings that still hold.`
      : `  Round 1 of ${MAX_ROUNDS}.`,
    '  The review advises; it never approves or rejects. Then --resume: the gate asks for your own concerns before it shows the review.',
  ].join('\n');
}

/**
 * The gate record's section on the AI review.
 * @param {{ round: number, review: string, sha256: string,
 *   own_concerns: string | null, lines: string[] }} a
 * @returns {string[]}
 */
export function recordSection(a) {
  return [
    '## Advisory AI review',
    '',
    `Round ${a.round} of ${MAX_ROUNDS}: \`${a.review}\` \`${a.sha256}\`.`,
    '',
    'Before seeing it, the reviewer noted:',
    '',
    ...(a.own_concerns
      ? a.own_concerns.split(/\r?\n/).map((l) => `> ${l}`)
      : ['> (nothing)']),
    '',
    '```text',
    ...a.lines,
    '```',
    '',
  ];
}
