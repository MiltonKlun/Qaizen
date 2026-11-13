// @ts-check
// Action targets: what each action of a test acts on, so a heal can be held
// to the element the test meant.
//
// The repeat check records, in one extra run after its counted runs, each
// action's target in context.json `repeat_check.targets`: its accessible role
// and name, its test id, its text, how many elements the locator matched,
// and where it stands among elements that look the same (same role and
// name, or, without a name, the same text) (action-targets/shim.js). When the
// Healer validates a candidate, one extra run records the candidate's
// targets, and they are compared action by action with the recorded ones:
//
//   same        every action checked acts on the element it acted on before:
//               the same role and name, and, when several elements share
//               them, the same one of them (by position or test id); an
//               element with no name is held to its test id, or to its text
//               when that text is unique
//   yellow      an action acts on an element of the same role and test id
//               whose visible name changed: the app changed, and a person
//               decides whether the test should follow
//   different   an action acts on another element, on an element that cannot
//               be identified, or through a locator that does not match
//               exactly one element: the heal retargeted the test, and is
//               refused
//   not_recorded nothing was recorded for this test
//
// Pure apart from building the run's environment.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REGISTER = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), 'action-targets', 'register.js')
).href;

/**
 * @typedef {{ index: number, method: string, locator: string,
 *   count: number | null, role?: string | null, name?: string | null,
 *   test_id?: string | null, text?: string | null,
 *   same_count?: number | null, same_index?: number | null }} Action
 * @typedef {{ test_title: string, project: string, passed: boolean,
 *   actions: Action[] }} Targets
 * @typedef {{ role: string | null, name: string | null, test_id: string | null }} Element
 * @typedef {{ index: number, kind: 'yellow' | 'different', why: string,
 *   recorded: Element | null,
 *   candidate: (Element & { count: number | null }) | null }} Difference
 * @typedef {{ verdict: 'same' | 'yellow' | 'different' | 'not_recorded',
 *   actions_compared: number, actions_skipped: number,
 *   differences: Difference[] }} Comparison
 */

/**
 * The role and name on the first line of an aria snapshot: `- button "Go to
 * checkout"`, `- link "basket":`, `- checkbox "Agree" [checked]`, and the
 * YAML-quoted form Playwright uses when the name holds `: ` or `#`
 * (`- 'button "Step 2: Pay"'`).
 * @param {string} snapshot
 * @returns {{ role: string | null, name: string | null }}
 */
export function roleAndName(snapshot) {
  let line = (snapshot.split(/\r?\n/)[0] ?? '').replace(/^- /, '');
  const quoted = /^'((?:[^']|'')*)'/.exec(line);
  if (quoted) line = quoted[1].replace(/''/g, "'");
  const m = /^([a-z][\w-]*)(?: ("(?:[^"\\]|\\.)*"))?/.exec(line);
  if (!m) return { role: null, name: null };
  /** @type {string | null} */
  let name = null;
  if (m[2] !== undefined) {
    try {
      name = JSON.parse(m[2]);
    } catch {
      name = m[2].slice(1, -1);
    }
  }
  return { role: m[1], name };
}

/** At most this many tests are kept in a record. */
export const MAX_TESTS = 50;

/**
 * The environment of a recording run: the hook is preloaded (into every Node
 * process the run starts, a webServer included, where it changes nothing),
 * and the shim writes to `outPath`.
 * @param {string} outPath
 * @param {Record<string, string | undefined>} [env]
 */
export function recordingEnv(outPath, env = process.env) {
  return {
    ...env,
    NODE_OPTIONS: `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--import=${REGISTER}`,
    QAIZEN_TARGETS_OUT: outPath,
  };
}

/** @param {unknown} v */
const num = (v) => (typeof v === 'number' ? v : null);
/** @param {unknown} v */
const str = (v) => (typeof v === 'string' ? v : null);

/**
 * The targets of each test, from what a recording run wrote: the first
 * repetition of each test and project.
 * @param {string} text the JSON lines the shim wrote
 * @returns {Targets[]}
 */
export function readTargets(text) {
  /** @type {Map<string, Targets>} */
  const byTest = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    /** @type {any} */
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row?.test_title !== 'string' || !Array.isArray(row.actions))
      continue;
    const key = JSON.stringify([row.test_title, row.project ?? '']);
    if (byTest.has(key)) continue;
    byTest.set(key, {
      test_title: row.test_title,
      project: String(row.project ?? ''),
      passed: row.passed !== false,
      actions: row.actions.map((/** @type {any} */ a) => ({
        index: Number(a.index),
        method: String(a.method),
        locator: String(a.locator ?? ''),
        count: num(a.count),
        role: str(a.role),
        name: str(a.name),
        test_id: str(a.test_id),
        text: str(a.text),
        same_count: num(a.same_count),
        same_index: num(a.same_index),
      })),
    });
  }
  return [...byTest.values()]
    .sort((a, b) =>
      `${a.test_title}|${a.project}`.localeCompare(
        `${b.test_title}|${b.project}`
      )
    )
    .slice(0, MAX_TESTS);
}

/**
 * The recorded targets of one test.
 * @param {Targets[] | undefined} all
 * @param {string} testTitle
 * @param {string} [project]
 */
export function targetsOf(all, testTitle, project = '') {
  return (
    (all ?? []).find(
      (t) => t.test_title === testTitle && (t.project ?? '') === (project ?? '')
    ) ?? null
  );
}

/** @param {Action} a */
const shown = (a) =>
  a.role && a.name
    ? `${a.role} "${a.name}"`
    : a.test_id
      ? `${a.role ?? 'the element'} with test id ${a.test_id}`
      : a.text
        ? `${a.role ?? 'the element'} with text "${a.text}"`
        : `${a.role ?? 'an element'} with nothing to identify it`;

/** @param {Action} a */
const pick = (a) => ({
  role: a.role ?? null,
  name: a.name ?? null,
  test_id: a.test_id ?? null,
});

/** Whether two descriptions are the same one among look-alikes. */
const samePlace = (/** @type {Action} */ r, /** @type {Action} */ c) =>
  (r.test_id !== null && r.test_id !== undefined && r.test_id === c.test_id) ||
  ((r.same_count ?? 1) <= 1 && (c.same_count ?? 1) <= 1) ||
  (r.same_index !== null &&
    r.same_index !== undefined &&
    r.same_index === c.same_index);

/**
 * One recorded action against the candidate's: null when it is the same
 * element, else the difference.
 * @param {number} i
 * @param {Action} r
 * @param {Action} c
 * @returns {Difference | null}
 */
function compareAction(i, r, c) {
  const at = `action ${i + 1} (${c.method})`;
  const diff = (
    /** @type {'yellow' | 'different'} */ kind,
    /** @type {string} */ why
  ) => ({
    index: i,
    kind,
    why,
    recorded: pick(r),
    candidate: { ...pick(c), count: c.count },
  });
  if (r.role && r.name) {
    if (r.role === c.role && r.name === c.name) {
      if (samePlace(r, c)) return null;
      return diff(
        'different',
        `${at} acts on another of the ${Math.max(r.same_count ?? 0, c.same_count ?? 0)} elements that are ${shown(r)} (position ${(c.same_index ?? -1) + 1} instead of ${(r.same_index ?? -1) + 1})`
      );
    }
    if (r.role === c.role && r.test_id && r.test_id === c.test_id)
      return diff(
        'yellow',
        `${at} acts on the same ${r.role} (${r.test_id}), whose visible name changed from "${r.name}" to "${c.name}"`
      );
    return diff(
      'different',
      `${at} now acts on ${shown(c)} instead of ${shown(r)}`
    );
  }
  // No accessible name: held to its test id, or to its text when that text
  // is unique on the page (or the same one of the look-alikes).
  if (r.test_id) {
    if (r.test_id === c.test_id && r.role === c.role) return null;
    return diff(
      'different',
      `${at} now acts on ${shown(c)} instead of ${shown(r)}`
    );
  }
  if (r.text) {
    if (r.text === c.text && r.role === c.role && samePlace(r, c)) return null;
    return diff(
      'different',
      `${at} now acts on ${shown(c)} instead of ${shown(r)}`
    );
  }
  return diff(
    'different',
    `${at}: the element the test acted on (${shown(r)}) has no name, test id or text, so the candidate cannot be shown to act on it`
  );
}

/**
 * Compare a candidate's targets with the recorded ones, action by action.
 * A recording of a test that failed stops at the action that failed; only
 * that many are compared.
 * @param {Targets | null} recorded
 * @param {Targets | null} candidate
 * @returns {Comparison}
 */
export function compareTargets(recorded, candidate) {
  if (!recorded || !recorded.actions.length)
    return {
      verdict: 'not_recorded',
      actions_compared: 0,
      actions_skipped: 0,
      differences: [],
    };
  /** @type {Difference[]} */
  const differences = [];
  const want = recorded.actions;
  const got = candidate?.actions ?? [];
  const lengthDiffers = recorded.passed
    ? got.length !== want.length
    : got.length < want.length;
  if (lengthDiffers)
    differences.push({
      index: Math.min(got.length, want.length),
      kind: 'different',
      why: `the candidate performs ${got.length} action(s), the recorded test ${recorded.passed ? '' : 'at least '}${want.length}; an action added or removed shifts every later one, so the differences after it may follow from that`,
      recorded: null,
      candidate: null,
    });
  let compared = 0;
  let skipped = 0;
  const n = Math.min(got.length, want.length);
  for (let i = 0; i < n; i += 1) {
    const r = want[i];
    const c = got[i];
    if (c.count !== 1) {
      differences.push({
        index: i,
        kind: 'different',
        why: `action ${i + 1} (${c.method}) matches ${c.count ?? 'no'} element(s) instead of one`,
        recorded: pick(r),
        candidate: { ...pick(c), count: c.count },
      });
      compared += 1;
      continue;
    }
    // The recorded action found no single element (the step that failed in
    // a failing recording): there is nothing to hold the candidate to.
    if (r.count !== 1) {
      skipped += 1;
      continue;
    }
    compared += 1;
    const d = compareAction(i, r, c);
    if (d) differences.push(d);
  }
  return {
    verdict: differences.some((d) => d.kind === 'different')
      ? 'different'
      : differences.length
        ? 'yellow'
        : 'same',
    actions_compared: compared,
    actions_skipped: skipped,
    differences: differences.slice(0, 10),
  };
}
