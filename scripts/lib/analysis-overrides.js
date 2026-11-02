// @ts-check
// The rule-based draft of a failure analysis, and the changes a finalized
// analysis made to it.
//
// scripts/run-failure-classifier.js writes the draft twice: as the immutable
// record analysis/failure-analysis.draft.json, and as the starting point of
// analysis/failure-analysis.json, which names the draft and its digest in
// `rule_draft`. The Failure Classifier Agent (or a human) finalizes the second
// file. It may change a failure's classification or severity only by also
// recording the change in `overrides[]`: { failure_id, field, from, to,
// reason }. Anything else it fills in (resolved ids, bug draft paths, the
// status) needs no override.
//
// overrideProblems() says where the finalized analysis and its draft disagree
// without a record. Pure: values in, problems out.

/** The fields whose change must be recorded as an override. */
export const OVERRIDABLE = /** @type {const} */ ([
  'classification',
  'severity',
]);

/** Where the pre-classifier keeps its draft. */
export const DRAFT_PATH = 'analysis/failure-analysis.draft.json';

/**
 * @typedef {{ failure_id: string, classification?: string, severity?: string }} Failure
 * @typedef {{ failure_id: string, field: string, from: string, to: string,
 *   reason: string }} Override
 */

/**
 * Every disagreement between the draft and the finalized analysis that the
 * analysis does not record, and every recorded override that does not match
 * a change.
 * @param {{ failures?: Failure[] }} draft
 * @param {{ failures?: Failure[], overrides?: Override[] }} final
 * @returns {string[]} empty when every change is recorded exactly
 */
export function overrideProblems(draft, final) {
  /** @type {string[]} */
  const problems = [];
  const before = new Map((draft.failures ?? []).map((f) => [f.failure_id, f]));
  const after = new Map((final.failures ?? []).map((f) => [f.failure_id, f]));

  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  if (added.length)
    problems.push(`${added.join(', ')} not in the rule-based draft`);
  if (removed.length)
    problems.push(`${removed.join(', ')} from the draft is missing`);

  /** @type {Map<string, Override[]>} */
  const recorded = new Map();
  for (const o of final.overrides ?? []) {
    const key = `${o.failure_id} ${o.field}`;
    recorded.set(key, [...(recorded.get(key) ?? []), o]);
  }

  /** @type {Set<string>} */
  const changed = new Set();
  for (const [id, was] of before) {
    const now = after.get(id);
    if (!now) continue;
    for (const field of OVERRIDABLE) {
      if (was[field] === now[field]) continue;
      const key = `${id} ${field}`;
      changed.add(key);
      const list = recorded.get(key) ?? [];
      const match = list.find(
        (o) => o.from === was[field] && o.to === now[field]
      );
      if (!match) {
        problems.push(
          `${id} ${field} changed from ${was[field]} to ${now[field]} with no override recording it`
        );
      } else if (!String(match.reason ?? '').trim()) {
        problems.push(`${id} ${field} override gives no reason`);
      }
    }
  }
  for (const [key, list] of recorded) {
    if (list.length > 1) problems.push(`${key} is overridden more than once`);
    if (!changed.has(key)) {
      problems.push(
        `${key} override records a change the analysis does not make`
      );
    }
  }
  return problems;
}
