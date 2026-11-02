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
// reason }. The fields the ledger fixes (which unit failed, how, and in which
// runner) never change; a test case id may only be filled in where the draft
// left it null. Anything else it fills in (resolved test ids, bug draft paths,
// the status) needs no override.
//
// overrideProblems() says where the finalized analysis and its draft disagree
// without a record. Pure: values in, problems out.

import { isDeepStrictEqual } from 'node:util';

/** The fields whose change must be recorded as an override. */
export const OVERRIDABLE = /** @type {const} */ ([
  'classification',
  'severity',
]);

/** The fields the ledger fixes: what failed, how, and where. */
export const FIXED = /** @type {const} */ ([
  'unit_id',
  'execution_outcome',
  'source',
  'runner_identity',
]);

/** Where the pre-classifier keeps its draft. */
export const DRAFT_PATH = 'analysis/failure-analysis.draft.json';

/**
 * @typedef {{ failure_id: string, classification?: string, severity?: string,
 *   test_case_id?: string | null } & Record<string, any>} Failure
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
  // A repeated id would let one copy change while the other stays the same.
  for (const [name, list] of [
    ['the draft', draft.failures ?? []],
    ['the analysis', final.failures ?? []],
  ]) {
    const ids = /** @type {Failure[]} */ (list).map((f) => f.failure_id);
    const repeated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    if (repeated.length)
      problems.push(`${repeated.join(', ')} appears more than once in ${name}`);
  }
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
    for (const field of FIXED) {
      if (!isDeepStrictEqual(was[field], now[field])) {
        problems.push(
          `${id} ${field} differs from the rule-based draft; the ledger fixes it`
        );
      }
    }
    if (
      was.test_case_id != null &&
      !isDeepStrictEqual(was.test_case_id, now.test_case_id)
    ) {
      problems.push(
        `${id} test_case_id changed from ${was.test_case_id} to ${now.test_case_id}; only an unresolved one may be filled in`
      );
    }
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
