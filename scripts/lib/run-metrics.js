// @ts-check
// Metric identities and evidence rules for scripts/pipeline-metrics.js (task
// group 8.3).
//
// Two faults this fixes:
//
//   * Identity. Failures were counted by bare `TC-001`, so two stories'
//     unrelated TC-001s merged into one row, and flaky tests fell back to a
//     FAIL id that is only unique within one analysis. A unit is now named by
//     its story plus its domain id (failing test cases) or its runner identity
//     (flaky units: file, title and project for Playwright; collection and
//     request for Newman), and every row keeps the runs it came from.
//   * Healer denominators. Every Markdown file in healer-validation/ counted as
//     a patch, and any file not saying "REJECTED" as a success, so a Yellow
//     suggestion note was a successful patch. Now only schema-valid candidate
//     records (schemas/healer-validation.schema.json) count: the numerator is
//     `validated`, the denominator is unique submissions with a terminal
//     outcome. Suggestion notes, exhaustion notices, invalid records and old
//     Markdown notes are reported apart and never counted as successes.
//
// Pure: callers read the files and pass the contents in.

/**
 * One entry of a failure analysis's `failures[]`
 * (schemas/failure-analysis.schema.json), read loosely: 1.x and 2.x differ.
 * @typedef {Record<string, any>} Failure
 * @typedef {Record<string, any> & { count: number, runs: Set<string> }} Tally
 */

/**
 * A runner-identity key for one failure, or null when none is proven.
 * @param {Failure} f
 * @returns {{ source: string, label: string, project: string | null,
 *   key: string } | null}
 */
export function unitKey(f) {
  const source = f.source ?? 'playwright';
  const ri = f.runner_identity;
  if (ri?.kind === 'playwright' && ri.test_title) {
    return {
      source,
      label: `${ri.file ?? '?'} > ${ri.test_title}`,
      project: ri.project ?? null,
      key: `playwright|${ri.file ?? ''}|${ri.test_title}|${ri.project ?? ''}`,
    };
  }
  if (ri?.kind === 'newman' && ri.request_name) {
    return {
      source,
      label: `${ri.collection_id ?? '?'} > ${ri.request_name}`,
      project: null,
      key: `newman|${ri.collection_id ?? ''}|${ri.request_name}`,
    };
  }
  if (ri?.kind === 'external' && ri.test_title) {
    return {
      source,
      label: ri.test_title,
      project: null,
      key: `external|${ri.test_title}`,
    };
  }
  // A 1.x analysis has no runner identity; its PW/REQ ids are proven ids.
  const id = f.playwright_test_id || f.request_id;
  if (id) return { source, label: id, project: null, key: `${source}|${id}` };
  return null;
}

/**
 * Failing test cases and flaky units across runs.
 * @param {Array<{story: string, runId: string, failures: Failure[]}>} analyses
 */
export function failureMetrics(analyses) {
  /** @type {Map<string, Tally>} */
  const failing = new Map();
  /** @type {Map<string, Tally>} */
  const flaky = new Map();
  let withoutCase = 0;
  let flakyWithoutIdentity = 0;
  /**
   * @param {Map<string, Tally>} map
   * @param {string} key
   * @param {Record<string, any>} row
   * @param {string} runId
   */
  const bump = (map, key, row, runId) => {
    let r = map.get(key);
    if (!r) {
      r = { ...row, count: 0, runs: new Set() };
      map.set(key, r);
    }
    r.count += 1;
    r.runs.add(runId);
  };
  for (const { story, runId, failures } of analyses) {
    for (const f of failures ?? []) {
      if (f.test_case_id) {
        bump(
          failing,
          `${story}|${f.test_case_id}`,
          { story, test_case_id: f.test_case_id },
          runId
        );
      } else {
        withoutCase += 1;
      }
      if (f.classification === 'flaky') {
        const u = unitKey(f);
        if (!u) {
          flakyWithoutIdentity += 1;
          continue;
        }
        bump(
          flaky,
          `${story}|${u.key}`,
          {
            story,
            source: u.source,
            unit: u.label,
            project: u.project,
            test_case_id: f.test_case_id ?? null,
          },
          runId
        );
      }
    }
  }
  /**
   * @param {Map<string, Tally>} map
   * @param {string} countKey
   * @returns {Record<string, any>[]}
   */
  const rows = (map, countKey) =>
    [...map.values()]
      .map(({ count, runs, ...row }) => ({
        ...row,
        [countKey]: count,
        runs: [...runs].sort(),
      }))
      .sort(
        (a, b) =>
          b[countKey] - a[countKey] ||
          `${a.story}|${a.test_case_id ?? a.unit}`.localeCompare(
            `${b.story}|${b.test_case_id ?? b.unit}`
          )
      )
      .slice(0, 10);
  return {
    top_failing_test_cases: rows(failing, 'failures'),
    failures_without_test_case: withoutCase,
    flakiest_tests: rows(flaky, 'flaky_count'),
    flaky_without_identity: flakyWithoutIdentity,
  };
}

const YELLOW_NOTE = /^#\s*FAIL-\d+\s+—\s+Yellow \(suggestion only\)/;
const RECORD_NAME = /^FAIL-\d+\.attempt-\d+\.json$/;
const RENDERING_NAME = /^(FAIL-\d+\.attempt-\d+)\.md$/;
const EXHAUSTED_NAME = /^FAIL-\d+\.exhausted\.md$/;
const TERMINAL = new Set(['validated', 'validation_failed', 'rejected_static']);

/**
 * Healer evidence across runs.
 * @param {Array<{story: string, runId: string,
 *   files: Array<{name: string, text: string}>}>} dirs  each run's
 *   analysis/healer-validation/ files
 * @param {(record: any) => boolean} isValidRecord  schema check
 */
export function healerMetrics(dirs, isValidRecord) {
  /** @type {Map<string, string>} */
  const unique = new Map();
  const counts = {
    duplicate_records: 0,
    invalid_records: 0,
    yellow_suggestions: 0,
    exhausted_notices: 0,
    legacy_markdown_notes: 0,
  };
  for (const { files } of dirs) {
    const names = new Set(files.map((f) => f.name));
    for (const { name, text } of files) {
      if (name.endsWith('.json')) {
        /** @type {any} parsed healer-validation record, checked below */
        let rec = null;
        try {
          rec = JSON.parse(text);
        } catch {
          rec = null;
        }
        if (
          !RECORD_NAME.test(name) ||
          !rec ||
          !isValidRecord(rec) ||
          !TERMINAL.has(rec.outcome)
        ) {
          counts.invalid_records += 1;
          continue;
        }
        // One submission, however many times its evidence was archived.
        const key = [
          rec.run_id,
          rec.unit.unit_id,
          rec.original.sha256,
          rec.candidate.sha256,
        ].join('|');
        if (unique.has(key)) counts.duplicate_records += 1;
        else unique.set(key, rec.outcome);
        continue;
      }
      if (!name.endsWith('.md')) continue;
      const rendering = RENDERING_NAME.exec(name);
      if (rendering && names.has(`${rendering[1]}.json`)) continue;
      if (EXHAUSTED_NAME.test(name)) counts.exhausted_notices += 1;
      else if (YELLOW_NOTE.test(text)) counts.yellow_suggestions += 1;
      else counts.legacy_markdown_notes += 1;
    }
  }
  const outcomes = [...unique.values()];
  const n = (/** @type {string} */ o) => outcomes.filter((x) => x === o).length;
  return {
    submissions: outcomes.length,
    validated: n('validated'),
    validation_failed: n('validation_failed'),
    rejected_static: n('rejected_static'),
    // Null when no structured submission exists: absence is not success.
    success_rate: outcomes.length ? n('validated') / outcomes.length : null,
    ...counts,
  };
}
