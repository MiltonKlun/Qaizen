// @ts-check
// Outcome metrics: what the run records say about how well the gates and the
// tests did, beside the counts of what was done (scripts/pipeline-metrics.js).
//
//   gate time            decided_at - opened_at of every gate decision
//   rounds to approval   decisions it took a gate to be approved, per approval
//   flake rate           repeat checks that found a flaky test, the earlier
//                        checks of a run included (context.json repeat_check)
//   cost per story       what the operator entered (outcomes/costs/)
//   escaped defects      bugs a completed run should have caught
//                        (outcomes/escaped-defects/)
//   dual-judge trigger   whether the evidence asks to re-open the dual-judge
//                        evaluation (docs/dual-judge-evaluation.md §4)
//
// Every result says how many records it read, and a result over none is
// unknown (null), never zero. Pure: callers read the files.

import { rate } from './stats.js';
import { isFlakyUnit } from './repeat-check.js';

const round1 = (/** @type {number} */ x) => Math.round(x * 10) / 10;
const round2 = (/** @type {number} */ x) => Math.round(x * 100) / 100;

/** @param {number[]} xs */
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** @param {any} ctx */
const decisionsOf = (ctx) =>
  Array.isArray(ctx?.gate_decisions) ? ctx.gate_decisions : [];

// ------------------------------------------------------------ gate time

/**
 * Minutes between a gate's brief and its decision.
 * @param {any} d a gate_decisions[] entry
 * @returns {number | null} null when either time is missing or out of order
 */
export function decisionMinutes(d) {
  const opened = Date.parse(d?.opened_at ?? '');
  const decided = Date.parse(d?.decided_at ?? '');
  if (Number.isNaN(opened) || Number.isNaN(decided) || decided < opened)
    return null;
  return (decided - opened) / 60000;
}

/**
 * Time spent at the gates, per gate and per run.
 * @param {any[]} contexts one parsed context.json per run
 */
export function gateTime(contexts) {
  /** @type {Record<string, number[]>} */
  const byGate = {};
  /** @type {number[]} */
  const perRun = [];
  let untimed = 0;
  for (const ctx of contexts) {
    let runTotal = 0;
    let timed = 0;
    for (const d of decisionsOf(ctx)) {
      const m = decisionMinutes(d);
      if (m === null || typeof d?.gate !== 'string') {
        untimed += 1;
        continue;
      }
      (byGate[d.gate] ??= []).push(m);
      runTotal += m;
      timed += 1;
    }
    if (timed) perRun.push(runTotal);
  }
  const all = Object.values(byGate).flat();
  const total = all.reduce((a, b) => a + b, 0);
  const med = median(perRun);
  return {
    runs_with_timing: perRun.length,
    decisions_timed: all.length,
    decisions_untimed: untimed,
    total_minutes: all.length ? round1(total) : null,
    median_minutes_per_run: med === null ? null : round1(med),
    by_gate: Object.fromEntries(
      Object.entries(byGate)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([gate, ms]) => [
          gate,
          {
            timed: ms.length,
            total_minutes: round1(ms.reduce((a, b) => a + b, 0)),
            median_minutes: round1(/** @type {number} */ (median(ms))),
            max_minutes: round1(Math.max(...ms)),
          },
        ])
    ),
  };
}

// ------------------------------------------------------------ rounds

/**
 * How many decisions each approval took: the rejections since the previous
 * approval of the same gate, plus the approval. An approval that follows an
 * approval of the same gate with no rejection between is a re-approval
 * (after a change to the reviewed inputs returned the gate to pending), and
 * is counted apart: counting it as approved the first time would inflate
 * that share. A gate whose last decision is a rejection is counted apart, as
 * still open.
 * @param {any[]} contexts
 */
export function roundsToApproval(contexts) {
  /** @type {Record<string, { rounds: number[], open: number, reapprovals: number }>} */
  const byGate = {};
  let runs = 0;
  for (const ctx of contexts) {
    const decisions = decisionsOf(ctx);
    if (!decisions.length) continue;
    runs += 1;
    /** @type {Record<string, number>} */
    const pending = {};
    /** @type {Set<string>} gates approved before in this run */
    const approved = new Set();
    for (const d of decisions) {
      if (typeof d?.gate !== 'string') continue;
      const g = (byGate[d.gate] ??= { rounds: [], open: 0, reapprovals: 0 });
      if (d?.decision === 'rejected')
        pending[d.gate] = (pending[d.gate] ?? 0) + 1;
      else if (d?.decision === 'approved') {
        if (approved.has(d.gate) && !pending[d.gate]) g.reapprovals += 1;
        else g.rounds.push((pending[d.gate] ?? 0) + 1);
        pending[d.gate] = 0;
        approved.add(d.gate);
      }
    }
    for (const [gate, n] of Object.entries(pending))
      if (n > 0) byGate[gate].open += 1;
  }
  /** @param {{ rounds: number[], open: number, reapprovals: number }} g */
  const summary = (g) => {
    const first = g.rounds.filter((r) => r === 1).length;
    return {
      approvals: g.rounds.length,
      first_time: { count: first, ...rate(first, g.rounds.length) },
      mean_rounds: g.rounds.length
        ? round2(g.rounds.reduce((a, b) => a + b, 0) / g.rounds.length)
        : null,
      max_rounds: g.rounds.length ? Math.max(...g.rounds) : null,
      open_after_rejection: g.open,
      reapprovals: g.reapprovals,
    };
  };
  const all = Object.values(byGate);
  return {
    runs_with_gate_log: runs,
    ...summary({
      rounds: all.flatMap((g) => g.rounds),
      open: all.reduce((a, g) => a + g.open, 0),
      reapprovals: all.reduce((a, g) => a + g.reapprovals, 0),
    }),
    by_gate: Object.fromEntries(
      Object.entries(byGate)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([gate, g]) => [gate, summary(g)])
    ),
  };
}

// ------------------------------------------------------------ flake rate

/**
 * Repeat checks that found a flaky test, and flaky tests per check. Each
 * run's current record counts, and so does every earlier check it keeps a
 * summary of.
 * @param {any[]} contexts
 */
export function repeatFlakes(contexts) {
  let runs = 0;
  let checks = 0;
  let flakyChecks = 0;
  let units = 0;
  let flakyUnits = 0;
  let notKept = 0;
  for (const ctx of contexts) {
    const r = ctx?.repeat_check;
    if (!r || !Array.isArray(r.units)) continue;
    runs += 1;
    if (Number.isInteger(r.earlier_dropped)) notKept += r.earlier_dropped;
    const list = [
      ...(Array.isArray(r.earlier) ? r.earlier : []),
      {
        outcome: r.outcome,
        units: r.units.length,
        flaky_units: r.units.filter(isFlakyUnit).length,
      },
    ];
    for (const c of list) {
      checks += 1;
      if (c.outcome === 'flaky') flakyChecks += 1;
      units += c.units;
      flakyUnits += c.flaky_units;
    }
  }
  return {
    runs_with_check: runs,
    checks,
    flaky_checks: { count: flakyChecks, ...rate(flakyChecks, checks) },
    tests_checked: units,
    flaky_tests: { count: flakyUnits, ...rate(flakyUnits, units) },
    // Checks past the summaries a record keeps: run, but no longer countable.
    checks_not_kept: notKept,
  };
}

// ------------------------------------------------------------ cost

/**
 * What the operator entered per story, and over all stories.
 * @param {any[]} docs valid outcomes/costs/<story>.json documents
 * @param {Set<string>} [counted] `story|run_id` of the runs the metrics count;
 *   an entry for any other run (a demo, an archive since removed) is left out
 */
export function costMetrics(docs, counted) {
  /** @type {Record<string, { runs: number, minutes: number[], spend: Record<string, number[]> }>} */
  const byStory = {};
  let ignored = 0;
  for (const doc of docs) {
    for (const e of doc?.runs ?? []) {
      if (counted && !counted.has(`${doc.story_id}|${e.run_id}`)) {
        ignored += 1;
        continue;
      }
      const s = (byStory[doc.story_id] ??= { runs: 0, minutes: [], spend: {} });
      s.runs += 1;
      if (typeof e.operator_minutes === 'number')
        s.minutes.push(e.operator_minutes);
      if (e.spend) (s.spend[e.spend.currency] ??= []).push(e.spend.amount);
    }
  }
  /** @param {number[]} xs */
  const tally = (xs) => ({
    runs: xs.length,
    total: xs.length ? round2(xs.reduce((a, b) => a + b, 0)) : null,
    per_run: xs.length
      ? round2(xs.reduce((a, b) => a + b, 0) / xs.length)
      : null,
  });
  /** @param {{ minutes: number[], spend: Record<string, number[]> }} s */
  const shape = (s) => ({
    operator_minutes: tally(s.minutes),
    spend: Object.fromEntries(
      Object.entries(s.spend)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cur, xs]) => [cur, tally(xs)])
    ),
  });
  const stories = Object.entries(byStory).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  /** @type {Record<string, number[]>} */
  const allSpend = {};
  for (const [, s] of stories)
    for (const [cur, xs] of Object.entries(s.spend))
      (allSpend[cur] ??= []).push(...xs);
  return {
    runs_with_cost: stories.reduce((a, [, s]) => a + s.runs, 0),
    entries_not_counted: ignored,
    overall: shape({
      minutes: stories.flatMap(([, s]) => s.minutes),
      spend: allSpend,
    }),
    by_story: Object.fromEntries(
      stories.map(([story, s]) => [story, { runs: s.runs, ...shape(s) }])
    ),
  };
}

// ------------------------------------------------------------ escaped defects

/** Why a defect escaped, in the order the metrics list them. */
export const WHY_MISSED = [
  'no_case',
  'not_automated',
  'test_passed_wrongly',
  'not_run',
  'unknown',
];

/**
 * Escaped defects, by why they were missed.
 * @param {any[]} records valid outcomes/escaped-defects/*.json records
 * @param {number} invalid records left out because they do not validate
 * @param {Set<string>} [counted] `story|run_id` of the runs the metrics count;
 *   a defect recorded against any other run is left out and counted apart
 */
export function escapedMetrics(records, invalid = 0, counted) {
  const kept = counted
    ? records.filter((r) => counted.has(`${r.story_id}|${r.run_id}`))
    : records;
  const sorted = [...kept].sort((a, b) =>
    a.escaped_defect_id.localeCompare(b.escaped_defect_id)
  );
  return {
    recorded: sorted.length,
    invalid_records: invalid,
    not_counted: records.length - kept.length,
    runs_with_escape: new Set(sorted.map((r) => `${r.story_id}|${r.run_id}`))
      .size,
    by_why_missed: Object.fromEntries(
      WHY_MISSED.map((w) => [
        w,
        sorted.filter((r) => r.why_missed === w).length,
      ])
    ),
    by_severity: Object.fromEntries(
      ['high', 'medium', 'low'].map((s) => [
        s,
        sorted.filter((r) => r.severity === s).length,
      ])
    ),
    defects: sorted.map((r) => ({
      id: r.escaped_defect_id,
      story: r.story_id,
      run_id: r.run_id,
      risk_ids: r.risk_ids,
      test_case_ids: r.test_case_ids,
      severity: r.severity,
      why_missed: r.why_missed,
      found_in: r.found_in,
      found_at: r.found_at,
    })),
  };
}

// ------------------------------------------------------------ dual judge

/** The re-evaluation trigger of docs/dual-judge-evaluation.md §4. */
export const DUAL_JUDGE = {
  /** Escaped defects a test covered and passed (false negatives). */
  false_negatives_at: 3,
  /** Gate 2 canaries missed... */
  canary_misses_at: 3,
  /** ...with the catch rate's 95% upper bound below this. */
  canary_upper_below: 0.9,
};

/**
 * Whether the evidence asks to re-open the dual-judge evaluation. Either
 * signal is enough; each needs its own minimum count, so one bad week does
 * not fire it.
 * @param {ReturnType<typeof escapedMetrics>} escaped
 * @param {{ canaries: { planted: number, caught: number,
 *   wilson_95: [number, number] | null } }} canaries canaryMetrics()
 */
export function dualJudgeTrigger(escaped, canaries) {
  const falseNegatives = escaped.by_why_missed.test_passed_wrongly ?? 0;
  const planted = canaries.canaries.planted;
  const missed = planted - canaries.canaries.caught;
  const upper = canaries.canaries.wilson_95?.[1] ?? null;
  const signals = [
    {
      signal: 'false_negative_escapes',
      value: falseNegatives,
      rule: `${DUAL_JUDGE.false_negatives_at} or more escaped defects that a test covered and passed`,
      met: falseNegatives >= DUAL_JUDGE.false_negatives_at,
    },
    {
      signal: 'gate2_canary_misses',
      value: missed,
      planted,
      catch_rate_upper_95: upper,
      rule: `${DUAL_JUDGE.canary_misses_at} or more Gate 2 canaries missed, with the catch rate's 95% upper bound below ${Math.round(DUAL_JUDGE.canary_upper_below * 100)}%`,
      met:
        missed >= DUAL_JUDGE.canary_misses_at &&
        upper !== null &&
        upper < DUAL_JUDGE.canary_upper_below,
    },
  ];
  // With nothing recorded and nothing planted there is no evidence either
  // way: unknown, not "not fired".
  const evidence = escaped.recorded > 0 || planted > 0;
  return { fired: evidence ? signals.some((s) => s.met) : null, signals };
}

// ------------------------------------------------------------ Markdown

/** @param {{ value: number | null, wilson_95: [number, number] | null }} r */
const pctI = (r) =>
  r.value === null
    ? 'n/a'
    : `${Math.round(r.value * 100)}% (95% interval ${Math.round((r.wilson_95?.[0] ?? 0) * 100)}–${Math.round((r.wilson_95?.[1] ?? 0) * 100)}%)`;

/**
 * @param {ReturnType<typeof gateTime>} t
 * @param {number} totalRuns
 * @returns {string[]}
 */
export function gateTimeLines(t, totalRuns) {
  if (!t.decisions_timed)
    return [
      `- No gate decision records when its brief was opened (0/${totalRuns} run(s)): gate time is unknown, not zero.`,
    ];
  return [
    `- ${t.total_minutes} min over ${t.decisions_timed} timed decision(s) in ${t.runs_with_timing}/${totalRuns} run(s); median per run ${t.median_minutes_per_run} min.` +
      (t.decisions_untimed
        ? ` ${t.decisions_untimed} decision(s) carry no opening time and are left out.`
        : ''),
    ...Object.entries(t.by_gate).map(
      ([g, v]) =>
        `- ${g}: ${v.timed} decision(s), ${v.total_minutes} min, median ${v.median_minutes}, longest ${v.max_minutes}`
    ),
    '- Time from the brief to the decision, including any pause: an upper bound on review effort, not a measure of it.',
  ];
}

/**
 * @param {ReturnType<typeof roundsToApproval>} r
 * @param {number} totalRuns
 * @returns {string[]}
 */
export function roundsLines(r, totalRuns) {
  if (!r.approvals && !r.open_after_rejection && !r.reapprovals)
    return [
      `- No run records a gate decision (0/${totalRuns}): rounds to approval are unknown.`,
    ];
  return [
    `- ${r.approvals} approval(s) over ${r.runs_with_gate_log}/${totalRuns} run(s): ${r.mean_rounds ?? 'n/a'} decision(s) per approval on average, at most ${r.max_rounds ?? 'n/a'}; approved the first time ${r.first_time.count}/${r.approvals} = ${pctI(r.first_time)}.` +
      (r.reapprovals
        ? ` ${r.reapprovals} re-approval(s) after a change to the reviewed inputs counted apart.`
        : ''),
    ...Object.entries(r.by_gate).map(
      ([g, v]) =>
        `- ${g}: ${v.approvals} approval(s), ${v.mean_rounds ?? 'n/a'} per approval, at most ${v.max_rounds ?? 'n/a'}, first time ${v.first_time.count}/${v.approvals}` +
        (v.open_after_rejection
          ? `; ${v.open_after_rejection} run(s) left it rejected`
          : '') +
        (v.reapprovals ? `; ${v.reapprovals} re-approval(s)` : '')
    ),
  ];
}

/**
 * @param {ReturnType<typeof repeatFlakes>} f
 * @param {number} totalRuns
 * @returns {string[]}
 */
export function flakeLines(f, totalRuns) {
  if (!f.checks)
    return [
      `- No run carries a repeat check (0/${totalRuns}): the flake rate is unknown, not zero.`,
    ];
  return [
    `- Repeat checks that found a flaky test: ${f.flaky_checks.count}/${f.checks} = ${pctI(f.flaky_checks)}, over ${f.runs_with_check}/${totalRuns} run(s).`,
    `- Tests flaky in a check: ${f.flaky_tests.count}/${f.tests_checked} = ${pctI(f.flaky_tests)}.`,
    '- A run keeps a summary of each earlier check, so a flaky check that was fixed still counts; runs from before that only show their last check.',
    ...(f.checks_not_kept
      ? [
          `- ${f.checks_not_kept} earlier check(s) ran but are past the summaries a record keeps, and are not in these counts.`,
        ]
      : []),
  ];
}

/**
 * @param {any} h healerMetrics().heals_per_test
 * @returns {string[]}
 */
export function healsLines(h) {
  if (!h.tests_with_submissions)
    return ['- No structured healer submission yet: heals per test unknown.'];
  return [
    `- Tests healed: ${h.tests_healed} of ${h.tests_with_submissions} with a submission; ${h.validated_heals} validated heal(s), ${h.heals_per_healed_test ?? 'n/a'} per healed test.`,
    ...(h.healed_more_than_once.length
      ? h.healed_more_than_once.map(
          (/** @type {any} */ t) =>
            `- Healed ${t.heals} times: ${t.story} ${t.test} (${t.runs.join(', ')})`
        )
      : ['- No test was healed more than once.']),
  ];
}

/**
 * @param {ReturnType<typeof costMetrics>} c
 * @param {number} totalRuns
 * @returns {string[]}
 */
export function costLines(c, totalRuns) {
  /** @param {ReturnType<typeof costMetrics>['overall']} s */
  const show = (s) =>
    [
      s.operator_minutes.runs
        ? `${s.operator_minutes.total} min hands-on (${s.operator_minutes.per_run} per run over ${s.operator_minutes.runs})`
        : 'no time entered',
      ...Object.entries(s.spend).map(
        ([cur, v]) =>
          `${v.total} ${cur} spent (${v.per_run} per run over ${v.runs})`
      ),
    ].join('; ');
  const skipped = c.entries_not_counted
    ? [
        `- ${c.entries_not_counted} entry(ies) left out: their run is not among the runs counted here.`,
      ]
    : [];
  if (!c.runs_with_cost)
    return [
      `- No cost entered for any run (0/${totalRuns}): enter it with npm run record-outcome -- cost.`,
      ...skipped,
    ];
  return [
    `- Entered for ${c.runs_with_cost}/${totalRuns} run(s): ${show(c.overall)}.`,
    ...Object.entries(c.by_story).map(
      ([story, s]) => `- ${story} (${s.runs} run(s)): ${show(s)}`
    ),
    ...skipped,
  ];
}

/**
 * @param {ReturnType<typeof escapedMetrics>} e
 * @param {number} totalRuns
 * @returns {string[]}
 */
export function escapedLines(e, totalRuns) {
  const invalid = [
    ...(e.invalid_records
      ? [
          `- ${e.invalid_records} record(s) left out: they do not validate against schemas/escaped-defect.schema.json.`,
        ]
      : []),
    ...(e.not_counted
      ? [
          `- ${e.not_counted} record(s) left out: their run is not among the runs counted here.`,
        ]
      : []),
  ];
  if (!e.recorded)
    return [
      '- None recorded. That a defect escaped is only known once someone records it (npm run record-outcome -- escaped-defect); none recorded is not none escaped.',
      ...invalid,
    ];
  return [
    `- ${e.recorded} escaped defect(s) from ${e.runs_with_escape}/${totalRuns} run(s). Why missed: ${Object.entries(
      e.by_why_missed
    )
      .map(([k, n]) => `${k} ${n}`)
      .join(', ')}.`,
    ...e.defects.map(
      (d) =>
        `- ${d.id} ${d.story} (${d.run_id}): ${d.severity}, ${d.why_missed}, found in ${d.found_in} on ${d.found_at}; ${d.risk_ids.length ? d.risk_ids.join(', ') : 'no risk linked'}`
    ),
    ...invalid,
  ];
}

/**
 * @param {ReturnType<typeof dualJudgeTrigger>} t
 * @returns {string[]}
 */
export function dualJudgeLines(t) {
  return [
    t.fired === null
      ? '- Unknown: no escaped defect is recorded and no canary was planted, so there is no evidence either way.'
      : t.fired
        ? '- FIRED: re-open the evaluation in docs/dual-judge-evaluation.md.'
        : '- Not fired.',
    ...t.signals.map((s) => {
      const upper =
        ('catch_rate_upper_95' in s ? s.catch_rate_upper_95 : null) ?? null;
      const of =
        'planted' in s
          ? ` of ${s.planted} planted, upper bound ${upper === null ? 'n/a' : `${Math.round(upper * 100)}%`}`
          : '';
      return `- ${s.met ? 'met' : 'not met'}: ${s.rule} (now ${s.value}${of})`;
    }),
  ];
}
