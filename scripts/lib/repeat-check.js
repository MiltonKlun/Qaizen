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
// config or lock runs the check again.
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
 *   units: RepeatUnit[] }} RepeatRecord
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
 * What happened to each test across the repetitions of one Playwright JSON
 * report, and the outcome for the whole run.
 * @param {any} report parsed Playwright JSON report
 * @returns {{ units: RepeatUnit[], outcome: RepeatOutcome }}
 */
export function summarizeRepeat(report) {
  /** @type {Map<string, RepeatUnit>} */
  const units = new Map();
  /** @param {any} suite */
  const walk = (suite) => {
    for (const spec of suite?.specs ?? [])
      for (const t of spec.tests ?? []) {
        const file = String(spec.file ?? suite.file ?? '');
        const title = String(spec.title ?? '');
        const project = String(t.projectName ?? '');
        const key = JSON.stringify([file, title, project]);
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
    for (const child of suite?.suites ?? []) walk(child);
  };
  for (const s of report?.suites ?? []) walk(s);
  const list = [...units.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.title.localeCompare(b.title)
  );
  /** @param {RepeatUnit} u */
  const isFlaky = (u) => u.flaky > 0 || (u.passed > 0 && u.failed > 0);
  /** @type {RepeatOutcome} */
  const outcome = list.some(isFlaky)
    ? 'flaky'
    : list.some((u) => u.failed > 0)
      ? 'failing'
      : 'stable';
  return { units: list, outcome };
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
  return `${stale}${lines[0]}${failing}${lines.length > 1 ? `\n${lines.slice(1).join('\n')}` : ''}`;
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
