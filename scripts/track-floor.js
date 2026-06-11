// Track floor (IMPROVEMENT-PLAN Phase 4, IP-4.2).
//
// The lite track (PFI-1) lets a routine story skip ceremony it does not need.
// But "lite" must be a principled choice, not a vibe: some stories are too
// consequential to ever run with reduced ceremony. `minimumTrack(context)`
// computes the LOWEST track a given story is allowed to use, with written
// reasons — the analyst proposes a track, and the runner refuses to record one
// below this floor (scripts/run-pipeline.js / scripts/pipeline-state.js).
//
// Two independent floor-raisers, both to `standard`:
//   1. Red-taxonomy domains (scripts/red-domains.js) — a story touching
//      business logic, permissions, security, pricing, payment, compliance, or
//      data integrity is never `lite`. This is the same taxonomy the Healer
//      uses to refuse auto-fixes (docs/healer-guardrails.md §4); the rationale
//      is identical: high-consequence behavior gets the full review.
//   2. Size — a large story (many ACs or many risks) is not "routine"; lite is
//      for small, low-risk work.
//
// Lite never reaches `full`-only territory by floor; `full` is an explicit
// human upgrade for the highest-risk features. The floor only ever raises lite
// to standard; it never blocks standard or full.
//
// Pure: no I/O, no side effects. Constants are at the top, documented.

import { redDomainsInText, redDomainLabel } from './red-domains.js';

// Size heuristics. A story above either bound is not lite-eligible.
// Tunable; kept conservative so lite stays genuinely "small routine work".
export const MAX_LITE_ACS = 4;
export const MAX_LITE_RISKS = 5;

export const TRACK_ORDER = ['lite', 'standard', 'full'];

/** Numeric rank so floors can be compared (lite < standard < full). */
export function trackRank(track) {
  const i = TRACK_ORDER.indexOf(track);
  return i === -1 ? 1 : i; // unknown => treat as standard
}

/**
 * Compute the minimum allowable track for a run.
 * @param {object} context  Parsed context.json.
 * @returns {{ minimum: 'lite'|'standard'|'full', reasons: string[] }}
 */
export function minimumTrack(context) {
  const reasons = [];
  let minimum = 'lite';

  const raiseTo = (track, reason) => {
    reasons.push(reason);
    if (trackRank(track) > trackRank(minimum)) minimum = track;
  };

  // 1. Red-taxonomy scan over the story + ACs + risk descriptions.
  const story = context?.story || {};
  const texts = [
    story.title,
    story.description,
    ...(Array.isArray(context?.acceptance_criteria)
      ? context.acceptance_criteria
      : []),
    ...(Array.isArray(context?.risks)
      ? context.risks.map((r) => r && r.description)
      : []),
  ].filter((t) => typeof t === 'string' && t.length > 0);

  const domainHits = new Set();
  for (const t of texts)
    for (const id of redDomainsInText(t)) domainHits.add(id);
  for (const id of domainHits) {
    raiseTo('standard', `red-domain: ${redDomainLabel(id)}`);
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
    context.risks.some((r) => r && r.severity === 'high');
  if (hasHighRisk) {
    raiseTo('standard', 'at least one high-severity risk');
  }

  return { minimum, reasons };
}

/**
 * Is the proposed track allowed for this context? A track at or above the
 * floor is allowed; below it is refused.
 * @returns {{ allowed: boolean, minimum: string, reasons: string[] }}
 */
export function trackAllowed(context, proposed) {
  const { minimum, reasons } = minimumTrack(context);
  return {
    allowed: trackRank(proposed) >= trackRank(minimum),
    minimum,
    reasons,
  };
}
