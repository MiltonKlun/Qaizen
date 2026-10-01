// @ts-check
// Prompt stability, computed once (task group 8.2, review finding B7).
//
// The question: does a given set of agent prompts produce work that humans
// rarely send back at Gate 3/4? The old metric divided ALL rejection events by
// ALL runs with any gate log, ignored which prompts produced them, and its
// Markdown hardcoded "MET" whenever the value was not null -- so ten rejected
// runs rendered as stable.
//
// Here the answer is derived from one result that the JSON, the Markdown and
// /evolve all read:
//
//   * Eligible run: not a demo, `status: "completed"`, at least one decision
//     record on a Gate 3/4-equivalent gate (E2E, API or external branch), and
//     a known prompt version for every agent that ran. Anything else is
//     excluded and counted with its reason. An empty gate_decisions array is
//     not a reviewed run.
//   * Cohort: runs with an IDENTICAL prompt-version vector. Unrelated versions
//     are never mixed to certify one prompt.
//   * Sample: the latest ten eligible runs of a cohort, by execution time,
//     then run id.
//   * Rate: the fraction of those runs with at least one Gate 3/4-equivalent
//     human rejection (several rejections in one run are one affected run; raw
//     event counts are kept separately).
//   * Verdict, per cohort: `met` when the sample is ten runs and the rate is
//     strictly below 10% (one affected run in ten is not met), `not_met` when
//     it is not, `not_computable` with fewer than ten eligible runs.
//
// There is no verdict across cohorts: qualifying cohorts are reported one by
// one, and when none qualifies there is no verdict at all.
//
// Pure: the caller reads the archived runs and passes them in.

/** @typedef {import('./approval-binding.js').Context} Context */
/**
 * One archived run as the caller read it.
 * @typedef {{ story: string, runId: string, demo?: boolean,
 *   context: Context | null, failureAnalysis?: any }} ArchivedRun
 */

/** Plan/spec reviews and final reviews of every branch (E2E, API, external). */
export const GATE3_KEYS = new Set([
  'specs_reviewed',
  'collection_reviewed',
  'external_plan_reviewed',
]);
export const GATE4_KEYS = new Set([
  'code_reviewed',
  'api_assertions_reviewed',
  'external_evidence_reviewed',
]);
const REVIEW_KEYS = new Set([...GATE3_KEYS, ...GATE4_KEYS]);

/** Agents whose prompts every completed run executed (docs/context-json-guide.md). */
export const CORE_AGENTS = [
  'analyst',
  'test-designer',
  'failure-classifier',
  'reporter',
];
const API_GATES = new Set(['collection_reviewed', 'api_assertions_reviewed']);

export const SAMPLE_SIZE = 10;
/** Strict upper bound on the rejection rate for `met`. */
export const MAX_RATE = 0.1;

/** @type {Record<string, string>} */
export const VERDICT_TEXT = {
  met: 'MET',
  not_met: 'NOT MET',
  not_computable: 'NOT COMPUTABLE',
};

/** @returns {Record<string, any>[]} */
const decisionsOf = (/** @type {Context | null} */ ctx) =>
  Array.isArray(ctx?.gate_decisions) ? ctx.gate_decisions : [];

/**
 * The agents a run executed, as far as its artifacts show.
 * @param {Context} ctx
 */
function agentsThatRan(ctx) {
  const api =
    Boolean(ctx?.artifact_paths?.api_collection) ||
    decisionsOf(ctx).some((d) => API_GATES.has(d.gate));
  return api ? [...CORE_AGENTS, 'api-agent'] : [...CORE_AGENTS];
}

/**
 * When the run executed: its analysis's execution date, else its last decision.
 * @param {ArchivedRun} run
 * @returns {number | null}
 */
function executedAt(run) {
  const fromAnalysis = Date.parse(run.failureAnalysis?.execution_date ?? '');
  if (!Number.isNaN(fromAnalysis)) return fromAnalysis;
  const decided = decisionsOf(run.context)
    .map((d) => Date.parse(d.decided_at ?? ''))
    .filter((t) => !Number.isNaN(t));
  return decided.length ? Math.max(...decided) : null;
}

/**
 * Why a run cannot count, or null when it is eligible.
 * @param {Pick<ArchivedRun, 'demo' | 'context' | 'failureAnalysis'>} run
 */
export function exclusionReason(run) {
  if (run.demo) return 'demo run';
  const ctx = run.context;
  if (!ctx) return 'no readable context.json';
  if (ctx.status !== 'completed') return 'not a completed run';
  if (!decisionsOf(ctx).some((d) => REVIEW_KEYS.has(d.gate))) {
    return 'no Gate 3/4 decision record';
  }
  const versions = ctx.prompt_versions ?? {};
  const unknown = agentsThatRan(ctx).filter(
    (a) => typeof versions[a] !== 'string' || !versions[a]
  );
  if (unknown.length) return `no prompt version for ${unknown.join(', ')}`;
  if (executedAt(/** @type {ArchivedRun} */ (run)) === null) {
    return 'no execution timestamp';
  }
  return null;
}

/**
 * A deterministic key for a prompt-version vector.
 * @param {Record<string, string>} versions
 */
export function cohortKey(versions) {
  return Object.keys(versions)
    .sort()
    .map((k) => `${k}@${versions[k]}`)
    .join(' ');
}

/**
 * @param {ArchivedRun[]} runs
 */
export function promptStability(runs) {
  /** @type {{ story: string, run_id: string, reason: string }[]} */
  const excluded = [];
  /** @type {Map<string, { versions: Record<string, string>, runs: ArchivedRun[] }>} */
  const cohorts = new Map();
  for (const run of runs) {
    const reason = exclusionReason(run);
    if (reason) {
      excluded.push({ story: run.story, run_id: run.runId, reason });
      continue;
    }
    // Eligible: exclusionReason proved the context and its versions exist.
    /** @type {Record<string, string>} */
    const versions = /** @type {Context} */ (run.context).prompt_versions;
    const key = cohortKey(versions);
    let cohort = cohorts.get(key);
    if (!cohort) {
      cohort = { versions, runs: [] };
      cohorts.set(key, cohort);
    }
    cohort.runs.push(run);
  }

  const results = [...cohorts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, c]) => {
      const sample = [...c.runs]
        .sort(
          // Eligible runs always have a timestamp (exclusionReason).
          (a, b) =>
            (executedAt(b) ?? 0) - (executedAt(a) ?? 0) ||
            (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0)
        )
        .slice(0, SAMPLE_SIZE);
      let affected = 0;
      let events = 0;
      for (const r of sample) {
        const rejections = decisionsOf(r.context).filter(
          (d) => d.decision === 'rejected' && REVIEW_KEYS.has(d.gate)
        ).length;
        events += rejections;
        if (rejections > 0) affected += 1;
      }
      const rate = sample.length ? affected / sample.length : null;
      const verdict =
        sample.length < SAMPLE_SIZE
          ? 'not_computable'
          : rate !== null && rate < MAX_RATE
            ? 'met'
            : 'not_met';
      return {
        cohort: key,
        prompt_versions: Object.fromEntries(
          Object.keys(c.versions)
            .sort()
            .map((k) => [k, c.versions[k]])
        ),
        eligible_runs: c.runs.length,
        sample_size: sample.length,
        sample: sample.map((r) => `${r.story}/${r.runId}`),
        affected_runs: affected,
        rejection_events: events,
        rejection_rate: rate,
        verdict,
        ...(verdict === 'not_computable'
          ? {
              reason: `${sample.length}/${SAMPLE_SIZE} eligible runs for this prompt-version vector`,
            }
          : {}),
      };
    });

  /** @type {Record<string, number>} */
  const byReason = {};
  for (const e of excluded) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
  const qualifying = results
    .filter((r) => r.verdict !== 'not_computable')
    .map((r) => ({ cohort: r.cohort, verdict: r.verdict }));

  return {
    rule:
      `Per identical prompt-version vector: the latest ${SAMPLE_SIZE} eligible runs; ` +
      `met when fewer than ${MAX_RATE * 100}% of them had a Gate 3/4-equivalent rejection.`,
    runs_considered: runs.length,
    eligible_runs: runs.length - excluded.length,
    excluded,
    excluded_by_reason: byReason,
    cohorts: results,
    qualifying_cohorts: qualifying,
    // Never one verdict across different prompts: null when no cohort
    // qualifies, otherwise read `qualifying_cohorts` one by one.
    overall_verdict: null,
  };
}

/**
 * Markdown lines rendered from the same result the JSON carries.
 * @param {ReturnType<typeof promptStability>} ps
 */
export function renderPromptStability(ps) {
  const pct = (/** @type {number | null} */ r) =>
    r === null ? 'n/a' : `${Math.round(r * 1000) / 10}%`;
  const lines = [`- Rule: ${ps.rule}`];
  lines.push(
    `- Runs considered: ${ps.runs_considered} · eligible: ${ps.eligible_runs} · excluded: ${ps.excluded.length}`
  );
  for (const [reason, n] of Object.entries(ps.excluded_by_reason).sort()) {
    lines.push(`  - excluded, ${reason}: ${n}`);
  }
  if (ps.cohorts.length === 0) {
    lines.push(
      `- Prompt stability: ${VERDICT_TEXT.not_computable} — no eligible run. Completed runs need Gate 3/4 decision records and prompt_versions for every agent that ran.`
    );
    return lines;
  }
  for (const c of ps.cohorts) {
    lines.push(
      `- Cohort \`${c.cohort}\`: ${VERDICT_TEXT[c.verdict]} — ${c.affected_runs}/${c.sample_size} sampled run(s) with a Gate 3/4 rejection ` +
        `(${pct(c.rejection_rate)}; ${c.rejection_events} rejection event(s))` +
        (c.reason ? `; ${c.reason}` : '')
    );
  }
  lines.push(
    ps.qualifying_cohorts.length
      ? '- There is no verdict across cohorts: each qualifying cohort stands for its own prompt versions.'
      : `- No cohort has ${SAMPLE_SIZE} eligible runs yet, so there is no verdict.`
  );
  return lines;
}
