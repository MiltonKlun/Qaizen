// @ts-check
// What the runner recorded about the independence of full-track approvals,
// read without the rest of review-independence.js: the gates that need it,
// how names compare, which approvals the sampled outside review marked, and
// what became of them. The outcome records (outcomes.js) and the metrics read
// these; it loads nothing heavy, so they stay quick to start.

/** The gates that need independence on the full track, and the step each reviews. */
export const INDEPENDENT_GATES = Object.freeze(
  /** @type {Record<string, string>} */ ({
    test_scope_reviewed: 'test-designer',
    code_reviewed: 'generator',
    api_assertions_reviewed: 'api',
  })
);

/**
 * Whether two names are the same person's, as far as names can tell: case,
 * spacing and Unicode composition aside.
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 */
export const sameName = (a, b) =>
  normName(a) !== null && normName(a) === normName(b);

/**
 * The approvals of a run that the sampled outside review selected, oldest
 * first.
 * @param {any} context
 * @returns {{ gate: string, decided_at: string, record: string | null,
 *   reviewer: string | null, operator: string | null }[]}
 */
export function markedDecisions(context) {
  return (context?.gate_decisions ?? [])
    .filter(
      (/** @type {any} */ d) =>
        d?.decision === 'approved' &&
        d?.independence?.control === 'outside_review' &&
        d.independence.selected === true &&
        typeof d.decided_at === 'string'
    )
    .map((/** @type {any} */ d) => ({
      gate: d.gate,
      decided_at: d.decided_at,
      record: d.record?.path ?? null,
      reviewer: d.reviewer ?? null,
      operator: d.independence.operator ?? null,
    }));
}

/** @param {string | null | undefined} name */
export const normName = (name) =>
  (name ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase() ||
  null;

/**
 * What became of the decisions marked for outside review: reviewed (agreed
 * or not) or still waiting, over the runs the metrics count. A verdict that
 * names no marked decision of a counted run is counted apart.
 * @param {{ story: string, runId: string, context: any }[]} runs
 * @param {any[]} docs valid outcomes/outside-reviews/<story>.json documents
 */
export function outsideReviewMetrics(runs, docs) {
  /** @type {Map<string, any>} */
  const verdicts = new Map();
  for (const doc of docs)
    for (const r of doc?.reviews ?? [])
      verdicts.set(`${doc.story_id}|${r.run_id}|${r.gate}|${r.decided_at}`, r);
  let marked = 0;
  let agreed = 0;
  let disagreed = 0;
  /** @type {{ story: string, run_id: string, gate: string, decided_at: string }[]} */
  const waiting = [];
  /** @type {{ story: string, run_id: string, gate: string, decided_at: string, by: string }[]} */
  const disagreements = [];
  /** @type {Set<string>} */
  const matched = new Set();
  let superseded = 0;
  for (const run of runs) {
    const all = markedDecisions(run.context);
    for (const [i, d] of all.entries()) {
      marked += 1;
      const key = `${run.story}|${run.runId}|${d.gate}|${d.decided_at}`;
      const v = verdicts.get(key);
      const where = {
        story: run.story,
        run_id: run.runId,
        gate: d.gate,
        decided_at: d.decided_at,
      };
      // A verdict is owed on the latest marked approval at each gate; an
      // earlier one a later approval replaced is not waiting for one.
      const latest = !all.slice(i + 1).some((later) => later.gate === d.gate);
      if (!v && !latest) {
        superseded += 1;
        continue;
      }
      if (!v) {
        waiting.push(where);
        continue;
      }
      matched.add(key);
      if (v.verdict === 'agree') agreed += 1;
      else {
        disagreed += 1;
        disagreements.push({ ...where, by: v.recorded_by });
      }
    }
  }
  return {
    marked,
    reviewed: agreed + disagreed,
    agreed,
    disagreed,
    superseded,
    waiting,
    disagreements,
    verdicts_not_counted: verdicts.size - matched.size,
  };
}

/**
 * The metrics lines for the outside review.
 * @param {ReturnType<typeof outsideReviewMetrics>} m
 * @param {number} invalid records left out because they do not validate
 * @returns {string[]}
 */
export function outsideReviewLines(m, invalid = 0) {
  const lines = !m.marked
    ? ['- No decision is marked for outside review.']
    : [
        `- ${m.marked} decision(s) marked for outside review: ${m.reviewed} reviewed (${m.agreed} agreed, ${m.disagreed} disagreed), ${m.waiting.length} waiting${m.superseded ? `, ${m.superseded} replaced by a later approval at the same gate before a verdict` : ''}.`,
        ...m.disagreements.map(
          (d) =>
            `- DISAGREED: ${d.story} ${d.run_id} ${d.gate} (decided ${d.decided_at}), reviewed by ${d.by}. Follow it up: reopen the gate, or record an escaped defect.`
        ),
        ...m.waiting.map(
          (w) =>
            `- Waiting: ${w.story} ${w.run_id} ${w.gate} (decided ${w.decided_at}).`
        ),
      ];
  if (m.verdicts_not_counted)
    lines.push(
      `- ${m.verdicts_not_counted} verdict(s) name no marked decision of a run the metrics count, and are left out.`
    );
  if (invalid)
    lines.push(
      `- ${invalid} record(s) left out: they do not validate against schemas/outside-review.schema.json.`
    );
  return lines;
}
