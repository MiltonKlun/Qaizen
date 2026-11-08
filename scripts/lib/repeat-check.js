// @ts-check
// Repeat check: run the generated test many times before Gate 4.
//
// One green run says little about a test: a timing-dependent wait or an
// order-dependent fixture can pass once and fail the next time. Before Gate 4
// the runner runs the generated test N times (`--repeat-each`) on two or more
// workers, and records what happened to each test across the runs:
//
//   stable   every test passed every run
//   failing  some test failed every run (the app may have a bug, or the test
//            is wrong; Gate 4 is where that is judged), none was flaky
//   flaky    some test passed in one run and failed in another, or passed
//            only on a retry
//
// A flaky result stops the run before Gate 4: the test is fixed first. The
// record is kept in context.json `repeat_check`, bound to the Gate 4 inputs it
// ran against (the same digest Gate 4 approves), so a changed test, fixture,
// config or lock runs the check again. A new check replaces the record and
// keeps a one-line summary of each earlier one (`earlier`), so the metrics
// can count a flaky check that was fixed.
//
// Playwright does not call a test flaky when its repetitions disagree (it
// counts each repetition as its own test), so the comparison is made here.
//
// Pure apart from nothing: callers run Playwright and pass the report in.

/** Runs per test before Gate 4, by track (decision D6). */
export const REPEAT_EACH = { lite: 10, standard: 10, full: 20 };
/** Workers for the repeat run: more than one, so order-dependence shows. */
export const REPEAT_WORKERS = 2;
/** Where the repeat run writes its report, relative to the run folder. */
export const REPEAT_REPORT = 'reports/repeat/results.json';

/**
 * @typedef {{ file: string, title: string, project: string, runs: number,
 *   passed: number, failed: number, flaky: number, skipped: number }} RepeatUnit
 * @typedef {'stable' | 'failing' | 'flaky'} RepeatOutcome
 * @typedef {{ input_digest: string, track: string, repeat_each: number,
 *   workers: number, ran_at: string, report: string, outcome: RepeatOutcome,
 *   units: RepeatUnit[], errors?: string[],
 *   earlier?: ReturnType<typeof earlierChecks>,
 *   earlier_dropped?: number }} RepeatRecord
 */

/**
 * Runs per test for a track.
 * @param {string} track
 */
export function repeatCount(track) {
  return (
    /** @type {Record<string, number>} */ (REPEAT_EACH)[track] ??
    REPEAT_EACH.standard
  );
}

/**
 * A test is flaky when it passed in one run and failed in another, or passed
 * only on a retry.
 * @param {RepeatUnit} u
 */
export const isFlakyUnit = (u) => u.flaky > 0 || (u.passed > 0 && u.failed > 0);

/** Earlier checks a record keeps a summary of. */
export const EARLIER_KEPT = 20;

/**
 * The summaries of earlier checks a new record carries: the previous
 * record's own, then the previous record itself. A flaky check stops the run
 * and is replaced once the test is fixed; this keeps it countable.
 * @param {RepeatRecord | null | undefined} previous
 * @returns {{ ran_at: string, input_digest: string, repeat_each: number,
 *   outcome: RepeatOutcome, units: number, flaky_units: number }[]}
 */
export function earlierChecks(previous) {
  if (!previous || !Array.isArray(previous.units)) return [];
  return [
    ...(Array.isArray(previous.earlier) ? previous.earlier : []),
    {
      ran_at: previous.ran_at,
      input_digest: previous.input_digest,
      repeat_each: previous.repeat_each,
      outcome: previous.outcome,
      units: previous.units.length,
      flaky_units: previous.units.filter(isFlakyUnit).length,
    },
  ].slice(-EARLIER_KEPT);
}

/**
 * The repeat check as the execution ledger records it: the check itself,
 * without the summaries of earlier ones (run history, not evidence of the
 * execution it sits beside; the ledger schema has no place for them).
 * @param {RepeatRecord} record
 */
export function ledgerRepeatCheck(record) {
  const { earlier: _earlier, earlier_dropped: _dropped, ...check } = record;
  void _earlier;
  void _dropped;
  return check;
}

/**
 * How many earlier checks a new record no longer keeps a summary of: the
 * previous record's count, plus any its own summaries push past the cap.
 * @param {RepeatRecord | null | undefined} previous
 * @returns {number}
 */
export function earlierDropped(previous) {
  if (!previous || !Array.isArray(previous.units)) return 0;
  const kept = Array.isArray(previous.earlier) ? previous.earlier.length : 0;
  const before = Number.isInteger(previous.earlier_dropped)
    ? /** @type {number} */ (previous.earlier_dropped)
    : 0;
  return before + Math.max(0, kept + 1 - EARLIER_KEPT);
}

/**
 * What happened to each test across the repetitions of one Playwright JSON
 * report, and the outcome for the whole run. A test is named by its describe
 * blocks and its own title, and told apart by where it is declared, so two
 * tests with the same name in different blocks stay two tests. The report's
 * own errors (a file that does not load, a global setup that fails) are kept.
 * @param {any} report parsed Playwright JSON report
 * @returns {{ units: RepeatUnit[], outcome: RepeatOutcome, errors: string[] }}
 */
export function summarizeRepeat(report) {
  /** @type {Map<string, RepeatUnit>} */
  const units = new Map();
  /**
   * @param {any} suite
   * @param {string[]} titles the describe blocks around it
   */
  const walk = (suite, titles) => {
    for (const spec of suite?.specs ?? [])
      for (const t of spec.tests ?? []) {
        const file = String(spec.file ?? suite.file ?? '');
        const title = [...titles, String(spec.title ?? '')].join(' › ');
        const project = String(t.projectName ?? '');
        const key = JSON.stringify([
          file,
          title,
          project,
          spec.line ?? null,
          spec.column ?? null,
        ]);
        const u = units.get(key) ?? {
          file,
          title,
          project,
          runs: 0,
          passed: 0,
          failed: 0,
          flaky: 0,
          skipped: 0,
        };
        u.runs += 1;
        if (t.status === 'expected') u.passed += 1;
        else if (t.status === 'unexpected') u.failed += 1;
        else if (t.status === 'flaky') u.flaky += 1;
        else u.skipped += 1;
        units.set(key, u);
      }
    for (const child of suite?.suites ?? [])
      walk(child, [...titles, String(child.title ?? '')]);
  };
  // A top-level suite is the file; its title is the file name, not a block.
  for (const s of report?.suites ?? []) walk(s, []);
  const list = [...units.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.title.localeCompare(b.title)
  );
  /** @type {RepeatOutcome} */
  const outcome = list.some(isFlakyUnit)
    ? 'flaky'
    : list.some((u) => u.failed > 0)
      ? 'failing'
      : 'stable';
  const errors = (Array.isArray(report?.errors) ? report.errors : [])
    .map((/** @type {any} */ e) =>
      String(e?.message ?? e ?? '')
        // Playwright colours its error text; the ANSI escape is the match.
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b\[[0-9;]*m/g, '')
        .split(/\r?\n/)[0]
        .trim()
    )
    .filter(Boolean)
    .slice(0, 5);
  return { units: list, outcome, errors };
}

/**
 * Whether the recorded repeat check still holds: it ran against exactly the
 * Gate 4 inputs as they are now.
 * @param {any} context parsed context.json
 * @param {string} currentDigest the Gate 4 input digest now
 * @returns {{ state: 'missing' | 'stale' | 'current', record: RepeatRecord | null }}
 */
export function repeatState(context, currentDigest) {
  const record = context?.repeat_check ?? null;
  if (!record) return { state: 'missing', record: null };
  return {
    state: record.input_digest === currentDigest ? 'current' : 'stale',
    record,
  };
}

/** @param {RepeatUnit} u */
const tally = (u) =>
  `${u.passed}/${u.runs} passed` +
  (u.failed ? `, ${u.failed} failed` : '') +
  (u.flaky ? `, ${u.flaky} passed only on a retry` : '') +
  (u.skipped ? `, ${u.skipped} skipped` : '');

/**
 * The lines that describe a repeat record, for the console, the Gate 4 brief
 * and the refusal.
 * @param {RepeatRecord} r
 * @returns {string[]}
 */
export function repeatLines(r) {
  const head = `repeat check: ${r.repeat_each} run(s) of each test on ${r.workers} workers (${r.track} track): ${r.outcome}`;
  const notable = r.units.filter(
    (u) => r.outcome === 'stable' || u.failed || u.flaky || u.skipped
  );
  return [
    head,
    ...notable.map(
      (u) => `  - ${u.title}${u.project ? ` [${u.project}]` : ''}: ${tally(u)}`
    ),
  ];
}

/**
 * The Gate 4 brief line.
 * @param {ReturnType<typeof repeatState>} s
 * @returns {string}
 */
export function repeatBriefLine(s) {
  if (!s.record) return 'ATTENTION: no repeat check recorded for this test';
  const lines = repeatLines(s.record);
  const stale =
    s.state === 'stale'
      ? 'ATTENTION: the repeat check ran against other inputs than these; '
      : s.record.outcome === 'stable'
        ? ''
        : 'ATTENTION: ';
  const failing =
    s.record.outcome === 'failing'
      ? ' (a test that fails every run points at the app or at the test: judge which)'
      : '';
  // A test skipped every run, or an error Playwright reported, is said
  // even when every test that ran passed.
  const warnings = [
    ...s.record.units
      .filter((u) => u.passed + u.failed + u.flaky === 0)
      .map(
        (u) =>
          `ATTENTION: ${u.title} was skipped in every run, so the check says nothing about it`
      ),
    ...(s.record.errors ?? []).map(
      (e) => `ATTENTION: Playwright reported an error in the repeat run: ${e}`
    ),
  ];
  const head = !stale && warnings.length ? 'ATTENTION: ' : stale;
  return [
    `${head}${lines[0]}${failing}`,
    ...lines.slice(1),
    ...warnings.map((w) => `  ${w}`),
  ].join('\n');
}

/**
 * Why Gate 4 cannot open on this repeat check, or null.
 * @param {ReturnType<typeof repeatState>} s
 * @returns {string | null}
 */
export function repeatProblem(s) {
  if (s.state === 'missing')
    return 'no repeat check has run for this test; --resume runs it before Gate 4';
  if (s.state === 'stale')
    return 'the repeat check ran against other inputs than the ones under review; --resume runs it again';
  if (s.record?.outcome === 'flaky')
    return `the generated test is flaky in the repeat check (${repeatLines(
      s.record
    )
      .slice(1)
      .map((l) => l.replace(/^\s*-\s*/, ''))
      .join('; ')}); fix the test, then --resume`;
  return null;
}
