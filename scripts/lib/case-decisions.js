// @ts-check
// The per-case decisions Gate 2 reviews.
//
// The Test Designer writes every case as `draft`. Before Gate 2 the reviewer
// approves or rejects each one: the decisions are part of the scope the gate
// approves, and the runner refuses Gate 2 while a case is still a draft
// (docs/review-gates.md). The interactive gate prompt asks for them one case
// at a time; the offline demo asks the same way. Pure: the callers read and
// write the test-cases file.

/** @typedef {'approved' | 'rejected'} CaseDecision */
/**
 * @typedef {{ test_case_id: string, title?: string, status: string,
 *   automation_decision?: string, priority?: string, risk_ids?: string[] }} DraftCase
 */

/**
 * The cases still waiting for a decision.
 * @param {{ test_cases?: DraftCase[] } | null | undefined} doc
 * @returns {DraftCase[]}
 */
export function draftCases(doc) {
  return (doc?.test_cases ?? []).filter((c) => c.status === 'draft');
}

/**
 * Write a decision on every draft case. A draft without one is an error, so
 * a partial set of decisions never reaches the file.
 * @param {{ test_cases?: DraftCase[] }} doc changed in place
 * @param {Record<string, CaseDecision>} decisions by test_case_id
 * @returns {{ id: string, decision: CaseDecision }[]} what was decided
 */
export function applyCaseDecisions(doc, decisions) {
  const drafts = draftCases(doc);
  for (const c of drafts) {
    const d = decisions[c.test_case_id];
    if (d !== 'approved' && d !== 'rejected') {
      throw new Error(`no decision for draft case ${c.test_case_id}`);
    }
  }
  return drafts.map((c) => {
    c.status = decisions[c.test_case_id];
    return {
      id: c.test_case_id,
      decision: /** @type {CaseDecision} */ (c.status),
    };
  });
}

/**
 * How a case is shown when its decision is asked for.
 * @param {DraftCase} c
 * @returns {string}
 */
export function describeCase(c) {
  const facts = [
    c.automation_decision,
    c.priority,
    c.risk_ids?.length ? `covers ${c.risk_ids.join(', ')}` : null,
  ].filter(Boolean);
  return `  ${c.test_case_id}  ${c.title ?? '(untitled)'}\n    ${facts.join(', ')}`;
}
