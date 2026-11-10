// @ts-check
// Fault check: prove each generated test can fail.
//
// A test that stays green whatever the app does catches nothing. Before
// Gate 4, on a story the Bench Shop models (examples/benchmark-app/), the
// runner serves the Bench Shop with each relevant seeded bug switched on and
// runs the generated test against it. A test KILLS a fault when one of its
// `expect` assertions fails under it; failing an action (a click that times
// out, a locator that is gone) is not a kill, because the test then failed for
// a reason other than checking the behavior. A test that survives every fault
// relevant to it is a weak oracle: it is flagged in the Gate 4 brief, and on
// the full track Gate 4 does not open until it is fixed.
//
// Which faults are relevant to a test: each fault names the acceptance
// criterion it breaks by a phrase of that criterion; the test names its cases
// (`TC-` ids in its title); a fault is relevant when one of those cases covers
// the criterion. A test that names no case is held to every fault of its
// story.
//
// Full source mutation is not done here: these are the faults the app can
// switch on, chosen because they model the story's risks.
//
// Pure apart from nothing: callers run Playwright and pass the reports in.

/**
 * @typedef {{ bug: string, story: string, criterion: string,
 *   what: string }} Fault
 * @typedef {'passed' | 'assertion_failed' | 'action_failed' | 'not_run'} RunOutcome
 * @typedef {'strong' | 'weak_oracle' | 'no_relevant_fault' |
 *   'baseline_failed'} Verdict
 * @typedef {{ file: string, title: string, project: string,
 *   test_case_ids: string[], relevant: string[], clean: RunOutcome,
 *   results: Record<string, RunOutcome>, verdict: Verdict }} FaultUnit
 * @typedef {{ input_digest: string, target: 'bench-shop', track: string,
 *   ran_at: string, faults: { bug: string, criterion_index: number | null }[],
 *   outcome: 'strong' | 'weak' | 'baseline_failed' | 'no_relevant_fault',
 *   units: FaultUnit[], errors?: string[] }} FaultRecord
 */

/**
 * The Bench Shop's seeded bugs, each with the story it models and a phrase of
 * the acceptance criterion it breaks (examples/benchmark-app/README.md).
 * @type {Fault[]}
 */
export const BENCH_SHOP_FAULTS = [
  {
    bug: 'stale-badge',
    story: 'BENCH-1',
    criterion: 'shows N-1 without changing screen',
    what: 'the basket count does not go down on a take-out',
  },
  {
    bug: 'wrong-item-total',
    story: 'BENCH-2',
    criterion: 'equals the exact sum of the prices',
    what: 'the Items figure is the sum plus $1.00',
  },
  {
    bug: 'inconsistent-total',
    story: 'BENCH-2',
    criterion: 'plus the shown "Sales tax"',
    what: 'the Order total is not Items plus Sales tax',
  },
];

/**
 * The faults that model a story's risks; none for a story the Bench Shop
 * does not model, which then has no fault check.
 * @param {string | undefined} storyId
 * @returns {Fault[]}
 */
export function faultsForStory(storyId) {
  return BENCH_SHOP_FAULTS.filter((f) => f.story === storyId);
}

/**
 * The index of the criterion a fault breaks in this run's context, or null
 * when no criterion carries its phrase (the story was changed).
 * @param {Fault} fault
 * @param {string[]} criteria context.acceptance_criteria
 */
export function criterionIndex(fault, criteria) {
  const i = criteria.findIndex((c) =>
    c.toLowerCase().includes(fault.criterion.toLowerCase())
  );
  return i === -1 ? null : i;
}

/** The `TC-` ids a test names in its title. @param {string} title */
export const caseIdsOf = (title) => [
  ...new Set(title.match(/\bTC-\d+\b/g) ?? []),
];

/**
 * How one test ended in one run: an `expect` failure is an assertion
 * failure; anything else that failed (an action, a timeout of the test) is an
 * action failure. Playwright states an assertion as `expect(...)` in the
 * first line of its error, with or without a timeout around it.
 * @param {any} test a Playwright JSON report test
 * @returns {RunOutcome}
 */
export function runOutcome(test) {
  const result = (test?.results ?? []).at(-1);
  if (test?.status === 'expected') return 'passed';
  if (test?.status === 'skipped' || !result) return 'not_run';
  const errors = [
    ...(result.errors ?? []),
    ...(result.error ? [result.error] : []),
  ];
  const assertion = errors.some((e) =>
    /\bexpect\(/.test(
      String(e?.message ?? '')
        // Playwright colours its error text; the ANSI escape is the match.
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b\[[0-9;]*m/g, '')
        .split(/\r?\n/)[0]
    )
  );
  return assertion ? 'assertion_failed' : 'action_failed';
}

/**
 * Every test of one Playwright JSON report and how it ended, keyed by where
 * it is declared and its name (as the repeat check keys them).
 * @param {any} report
 * @returns {Map<string, { file: string, title: string, project: string,
 *   outcome: RunOutcome }>}
 */
export function reportOutcomes(report) {
  /** @type {Map<string, { file: string, title: string, project: string, outcome: RunOutcome }>} */
  const out = new Map();
  /**
   * @param {any} suite
   * @param {string[]} titles
   */
  const walk = (suite, titles) => {
    for (const spec of suite?.specs ?? [])
      for (const t of spec.tests ?? []) {
        const file = String(spec.file ?? suite.file ?? '');
        const title = [...titles, String(spec.title ?? '')].join(' › ');
        const project = String(t.projectName ?? '');
        out.set(JSON.stringify([file, title, project, spec.line ?? null]), {
          file,
          title,
          project,
          outcome: runOutcome(t),
        });
      }
    for (const child of suite?.suites ?? [])
      walk(child, [...titles, String(child.title ?? '')]);
  };
  for (const s of report?.suites ?? []) walk(s, []);
  return out;
}

/**
 * The kill matrix for a story's generated test.
 * @param {{ inputDigest: string, track: string, ranAt: string,
 *   faults: Fault[], criteria: string[],
 *   cases: { test_case_id: string, acceptance_criteria_refs?: number[] }[],
 *   clean: any, reports: Record<string, any>, errors?: string[] }} input
 *   `clean` and each of `reports` (keyed by bug) is a Playwright JSON report
 * @returns {FaultRecord}
 */
export function faultRecord({
  inputDigest,
  track,
  ranAt,
  faults,
  criteria,
  cases,
  clean,
  reports,
  errors = [],
}) {
  const indexOf = new Map(
    faults.map((f) => [f.bug, criterionIndex(f, criteria)])
  );
  const byBug = Object.fromEntries(
    Object.entries(reports).map(([bug, r]) => [bug, reportOutcomes(r)])
  );
  /** @type {FaultUnit[]} */
  const units = [...reportOutcomes(clean)].map(([key, u]) => {
    const ids = caseIdsOf(u.title);
    const refs = new Set(
      cases
        .filter((c) => ids.includes(c.test_case_id))
        .flatMap((c) => c.acceptance_criteria_refs ?? [])
    );
    const relevant = faults
      .filter((f) => {
        if (!ids.length) return true;
        const i = indexOf.get(f.bug);
        return i !== null && i !== undefined && refs.has(i);
      })
      .map((f) => f.bug);
    /** @type {Record<string, RunOutcome>} */
    const results = {};
    for (const f of faults)
      results[f.bug] = byBug[f.bug]?.get(key)?.outcome ?? 'not_run';
    /** @type {Verdict} */
    const verdict =
      u.outcome !== 'passed'
        ? 'baseline_failed'
        : !relevant.length
          ? 'no_relevant_fault'
          : relevant.some((b) => results[b] === 'assertion_failed')
            ? 'strong'
            : 'weak_oracle';
    return {
      file: u.file,
      title: u.title,
      project: u.project,
      test_case_ids: ids,
      relevant,
      clean: u.outcome,
      results,
      verdict,
    };
  });
  const any = (/** @type {Verdict} */ v) => units.some((u) => u.verdict === v);
  return {
    input_digest: inputDigest,
    target: 'bench-shop',
    track,
    ran_at: ranAt,
    faults: faults.map((f) => ({
      bug: f.bug,
      criterion_index: indexOf.get(f.bug) ?? null,
    })),
    outcome:
      any('baseline_failed') || !units.length
        ? 'baseline_failed'
        : any('weak_oracle')
          ? 'weak'
          : any('strong')
            ? 'strong'
            : 'no_relevant_fault',
    units,
    ...(errors.length ? { errors: errors.slice(0, 5) } : {}),
  };
}

/**
 * Whether the recorded fault check still holds for the Gate 4 inputs.
 * @param {any} context
 * @param {string} currentDigest
 * @returns {{ state: 'not_applicable' | 'missing' | 'stale' | 'current',
 *   record: FaultRecord | null }}
 */
export function faultState(context, currentDigest) {
  if (!faultsForStory(context?.story?.id).length)
    return { state: 'not_applicable', record: null };
  const record = context?.fault_check ?? null;
  if (!record) return { state: 'missing', record: null };
  return {
    state: record.input_digest === currentDigest ? 'current' : 'stale',
    record,
  };
}

/** @param {FaultUnit} u */
const row = (u) =>
  `  - ${u.title}${u.project ? ` [${u.project}]` : ''}: ${u.verdict.replace(/_/g, ' ')}` +
  (u.clean !== 'passed'
    ? ` (clean run: ${u.clean.replace(/_/g, ' ')})`
    : u.relevant.length
      ? ` (${u.relevant.map((b) => `${b} ${u.results[b] === 'assertion_failed' ? 'killed' : `survived, ${u.results[b].replace(/_/g, ' ')}`}`).join('; ')})`
      : ' (no seeded bug breaks the criteria of its cases)');

/**
 * The lines that describe a fault record (console and Gate 4 brief).
 * @param {FaultRecord} r
 * @returns {string[]}
 */
export function faultLines(r) {
  return [
    `fault check: ${r.faults.length} seeded bug(s) of the Bench Shop, ${r.units.length} test(s): ${r.outcome.replace(/_/g, ' ')}`,
    ...r.units.map(row),
    ...(r.errors ?? []).map((e) => `  error: ${e}`),
  ];
}

/**
 * The Gate 4 brief line, or null for a story without faults.
 * @param {ReturnType<typeof faultState>} s
 * @returns {string | null}
 */
export function faultBriefLine(s) {
  if (s.state === 'not_applicable') return null;
  if (!s.record)
    return 'ATTENTION: no fault check recorded for this test (each new test is run against the seeded bugs its cases cover)';
  const lines = faultLines(s.record);
  const head =
    s.state === 'stale'
      ? 'ATTENTION: the fault check ran against other inputs than these; '
      : s.record.outcome === 'strong' ||
          s.record.outcome === 'no_relevant_fault'
        ? ''
        : 'ATTENTION: ';
  const weak = s.record.units.some((u) => u.verdict === 'weak_oracle')
    ? [
        '  A weak oracle passes with the bug its cases are about switched on: its assertions do not check that behavior.',
      ]
    : [];
  return [`${head}${lines[0]}`, ...lines.slice(1), ...weak].join('\n');
}

/**
 * Why Gate 4 cannot open on this fault check, or null. A weak oracle blocks
 * on the full track only; elsewhere the brief flags it.
 * @param {ReturnType<typeof faultState>} s
 * @param {string} track
 * @returns {string | null}
 */
export function faultProblem(s, track) {
  if (s.state === 'not_applicable') return null;
  if (s.state === 'missing')
    return 'no fault check has run for this test; --resume runs it before Gate 4';
  if (s.state === 'stale')
    return 'the fault check ran against other inputs than the ones under review; --resume runs it again';
  const r = /** @type {FaultRecord} */ (s.record);
  if (r.outcome === 'baseline_failed')
    return `the test does not pass on the Bench Shop without a seeded bug, so no kill means anything (${
      r.units
        .filter((u) => u.verdict === 'baseline_failed')
        .map((u) => `${u.title}: ${u.clean.replace(/_/g, ' ')}`)
        .join('; ') || 'no test ran'
    }); fix the test, then --resume`;
  const weak = r.units.filter((u) => u.verdict === 'weak_oracle');
  if (track === 'full' && weak.length)
    return `weak oracle on the full track: ${weak
      .map((u) => `${u.title} survives ${u.relevant.join(', ')}`)
      .join('; ')}; strengthen its assertions, then --resume`;
  return null;
}
