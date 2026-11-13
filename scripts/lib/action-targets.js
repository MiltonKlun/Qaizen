// @ts-check
// Action targets: what each action of a test acts on, so a heal can be held
// to the element the test meant.
//
// The repeat check records, in one extra run after its counted runs, each
// action's target in context.json `repeat_check.targets`: its accessible role
// and name, its test id, and how many elements the locator matched
// (action-targets/shim.js). When the Healer validates a candidate, one extra
// run records the candidate's targets, and they are compared action by
// action with the recorded ones:
//
//   same        every action acts on an element of the same role and name;
//               a renamed test id or another locator for it is fine
//   yellow      an action acts on an element of the same role and test id
//               whose visible name changed: the app changed, and a person
//               decides whether the test should follow
//   different   an action acts on another element (another role, or another
//               name and test id), or its locator does not match exactly one
//               element: the heal retargeted the test, and is refused
//   not_recorded nothing was recorded for this test before (a run from before
//               the record existed): the comparison cannot be made
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
 *   test_id?: string | null }} Action
 * @typedef {{ test_title: string, project: string, actions: Action[] }} Targets
 * @typedef {{ index: number, kind: 'yellow' | 'different', why: string,
 *   recorded: { role: string | null, name: string | null, test_id: string | null } | null,
 *   candidate: { role: string | null, name: string | null, test_id: string | null, count: number | null } | null }} Difference
 * @typedef {{ verdict: 'same' | 'yellow' | 'different' | 'not_recorded',
 *   actions_compared: number, differences: Difference[] }} Comparison
 */

/**
 * The role and name on the first line of an aria snapshot
 * (`- button "Go to checkout"`, `- textbox "Postcode"`, `- link "basket":`).
 * @param {string} snapshot
 * @returns {{ role: string | null, name: string | null }}
 */
export function roleAndName(snapshot) {
  const m = /^- ([a-z][\w-]*)(?: "((?:[^"\\]|\\.)*)")?/.exec(
    snapshot.split(/\r?\n/)[0] ?? ''
  );
  return m
    ? {
        role: m[1],
        name: m[2] === undefined ? null : m[2].replace(/\\"/g, '"'),
      }
    : { role: null, name: null };
}

/** At most this many tests are kept in a record. */
export const MAX_TESTS = 50;

/**
 * The environment of a recording run: the hook is preloaded, and the shim
 * writes to `outPath`.
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
      actions: row.actions.map((/** @type {any} */ a) => ({
        index: Number(a.index),
        method: String(a.method),
        locator: String(a.locator ?? ''),
        count: typeof a.count === 'number' ? a.count : null,
        role: a.role ?? null,
        name: a.name ?? null,
        test_id: a.test_id ?? null,
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
  a.role
    ? `${a.role}${a.name !== null && a.name !== undefined ? ` "${a.name}"` : ''}`
    : 'an element of unknown role';

/**
 * Compare a candidate's targets with the recorded ones, action by action.
 * @param {Targets | null} recorded
 * @param {Targets | null} candidate
 * @returns {Comparison}
 */
export function compareTargets(recorded, candidate) {
  if (!recorded || !recorded.actions.length)
    return { verdict: 'not_recorded', actions_compared: 0, differences: [] };
  /** @type {Difference[]} */
  const differences = [];
  const got = candidate?.actions ?? [];
  const pick = (/** @type {Action} */ a) => ({
    role: a.role ?? null,
    name: a.name ?? null,
    test_id: a.test_id ?? null,
  });
  if (got.length !== recorded.actions.length)
    differences.push({
      index: Math.min(got.length, recorded.actions.length),
      kind: 'different',
      why: `the candidate performs ${got.length} action(s), the recorded test ${recorded.actions.length}`,
      recorded: null,
      candidate: null,
    });
  const n = Math.min(got.length, recorded.actions.length);
  for (let i = 0; i < n; i += 1) {
    const r = recorded.actions[i];
    const c = got[i];
    const cand = { ...pick(c), count: c.count };
    if (c.count !== 1) {
      differences.push({
        index: i,
        kind: 'different',
        why: `action ${i + 1} (${c.method}) matches ${c.count ?? 'no'} element(s) instead of one`,
        recorded: pick(r),
        candidate: cand,
      });
      continue;
    }
    if (!r.role || r.count !== 1) continue; // nothing recorded to hold it to
    if (r.role === c.role && r.name === c.name) continue;
    const sameElement =
      r.role === c.role && r.test_id !== null && r.test_id === c.test_id;
    differences.push({
      index: i,
      kind: sameElement ? 'yellow' : 'different',
      why: sameElement
        ? `action ${i + 1} (${c.method}) acts on the same ${r.role} (${r.test_id}), whose visible name changed from "${r.name}" to "${c.name}"`
        : `action ${i + 1} (${c.method}) now acts on ${shown(c)} instead of ${shown(r)}`,
      recorded: pick(r),
      candidate: cand,
    });
  }
  return {
    verdict: differences.some((d) => d.kind === 'different')
      ? 'different'
      : differences.length
        ? 'yellow'
        : 'same',
    actions_compared: n,
    differences: differences.slice(0, 10),
  };
}
