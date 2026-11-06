// @ts-check
// Track floor.
//
// Some stories are too consequential to run with less than the full review.
// `minimumTrack(context, story)` computes the LOWEST track a story is allowed
// to use, with written reasons, from two independent sources: the story file
// itself and what the Analyst wrote (acceptance criteria, risks). The higher
// of the two wins, so a risk or a Red domain the Analyst left out cannot lower
// the floor.
//
// Floor-raisers:
//   1. Red-taxonomy domains (scripts/red-domains.js, config/red-domains.json)
//      raise the floor to `full`: a story touching business logic,
//      permissions, security, pricing, payment, compliance or data integrity
//      gets everything `full` requires (docs/review-gates.md, "The full
//      track"). This is the taxonomy the Healer uses to refuse auto-fixes
//      (docs/healer-guardrails.md §4).
//   2. Size (many criteria or risks) and a high-severity risk raise it to
//      `standard`: such a story is not routine, so it is never `lite`.
//
// `effectiveTrack` is the track a run is held to: the declared track (absent
// means standard) or the floor, whichever is higher. The runner refuses a
// declared `lite` below the floor; any other track below it is raised.
//
// Pure: no I/O, no side effects. Constants are at the top, documented.

import { redDomainsInText, redDomainLabel } from './red-domains.js';

// Size heuristics. A story above either bound is not lite-eligible.
// Tunable; kept conservative so lite stays genuinely "small routine work".
export const MAX_LITE_ACS = 4;
export const MAX_LITE_RISKS = 5;

export const TRACK_ORDER = ['lite', 'standard', 'full'];

/** @typedef {'lite' | 'standard' | 'full'} Track */

/**
 * Numeric rank so floors can be compared (lite < standard < full).
 * @param {string} track
 */
export function trackRank(track) {
  const i = TRACK_ORDER.indexOf(track);
  return i === -1 ? 1 : i; // unknown => treat as standard
}

/**
 * Compute the minimum allowable track for a run.
 * @param {import('./lib/approval-binding.js').Context | null} context  Parsed context.json.
 * @param {string | null} [story] the story file's text, scanned on its own
 * @returns {{ minimum: Track, reasons: string[] }}
 */
export function minimumTrack(context, story = null) {
  /** @type {string[]} */
  const reasons = [];
  /** @type {Track} */
  let minimum = 'lite';

  /** @type {(track: Track, reason: string) => void} */
  const raiseTo = (track, reason) => {
    reasons.push(reason);
    if (trackRank(track) > trackRank(minimum)) minimum = track;
  };

  // 1. Red-taxonomy scan, over the story file and over what the Analyst wrote
  // (title, description, criteria, risks), each named as a source.
  const meta = context?.story || {};
  const analyst = [
    meta.title,
    meta.description,
    ...(Array.isArray(context?.acceptance_criteria)
      ? context.acceptance_criteria
      : []),
    ...(Array.isArray(context?.risks)
      ? context.risks.map((/** @type {any} */ r) => r && r.description)
      : []),
  ].filter((t) => typeof t === 'string' && t.length > 0);
  /** @type {Map<string, string[]>} domain id -> sources */
  const domainHits = new Map();
  const hit = (/** @type {string} */ text, /** @type {string} */ source) => {
    for (const id of redDomainsInText(text)) {
      const sources = domainHits.get(id) ?? [];
      if (!sources.includes(source)) sources.push(source);
      domainHits.set(id, sources);
    }
  };
  if (typeof story === 'string') hit(story, 'the story');
  for (const t of analyst) hit(t, "the Analyst's context");
  for (const [id, sources] of domainHits) {
    raiseTo(
      'full',
      `red-domain: ${redDomainLabel(id)} (in ${sources.join(' and ')})`
    );
  }

  // 2. Size heuristics.
  const acCount = Array.isArray(context?.acceptance_criteria)
    ? context.acceptance_criteria.length
    : 0;
  const riskCount = Array.isArray(context?.risks) ? context.risks.length : 0;
  if (acCount > MAX_LITE_ACS) {
    raiseTo('standard', `${acCount} acceptance criteria (> ${MAX_LITE_ACS})`);
  }
  if (riskCount > MAX_LITE_RISKS) {
    raiseTo('standard', `${riskCount} risks (> ${MAX_LITE_RISKS})`);
  }

  // A high-severity risk alone is enough to leave routine territory.
  const hasHighRisk =
    Array.isArray(context?.risks) &&
    context.risks.some((/** @type {any} */ r) => r && r.severity === 'high');
  if (hasHighRisk) {
    raiseTo('standard', 'at least one high-severity risk');
  }

  return { minimum, reasons };
}

/**
 * Is the proposed track allowed for this context? A track at or above the
 * floor is allowed; below it is refused.
 * @param {import('./lib/approval-binding.js').Context | null} context
 * @param {string} proposed
 * @param {string | null} [story] the story file's text
 * @returns {{ allowed: boolean, minimum: string, reasons: string[] }}
 */
export function trackAllowed(context, proposed, story = null) {
  const { minimum, reasons } = minimumTrack(context, story);
  return {
    allowed: trackRank(proposed) >= trackRank(minimum),
    minimum,
    reasons,
  };
}

/**
 * The track a run is held to: the declared track (absent or unknown means
 * standard), the floor computed now, or the floor the Analyst recorded,
 * whichever is highest.
 * @param {any} context parsed context.json
 * @param {string | null} [story] the story file's text
 * @returns {{ track: Track, declared: Track, minimum: Track, reasons: string[] }}
 */
export function effectiveTrack(context, story = null) {
  /** @type {Track} */
  const declared = TRACK_ORDER.includes(context?.track)
    ? context.track
    : 'standard';
  const { minimum, reasons } = minimumTrack(context, story);
  const recorded = context?.track_floor?.minimum;
  /** @type {Track} */
  let track = declared;
  for (const t of [minimum, recorded])
    if (TRACK_ORDER.includes(t) && trackRank(t) > trackRank(track)) track = t;
  return { track, declared, minimum, reasons };
}

/**
 * What the full track requires, and which of it is in force today. Shown in
 * the Gate 1 brief and documented in docs/review-gates.md ("The full track").
 */
export const FULL_TRACK_REQUIREMENTS = [
  'the Gate 4 static scan exits 1 while any finding is open',
  'every lowered failure severity needs a person to confirm it',
  'on a Red-domain story, a scan finding answered wrong or intentional needs a reason',
];
