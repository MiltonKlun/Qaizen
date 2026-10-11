// @ts-check
// Reading a run's gate trail: the history of its decisions, and what changed
// since a gate was approved. Read-only: nothing here writes to the run.
//
//   gateTimeline  every human decision and every automatic return to pending,
//                 in time order, each decision with its gate record when one
//                 exists (runs from before gate records have none)
//   gateDiff      a gate's reviewed files now, against the copy kept with its
//                 latest approval (scripts/lib/gate-records.js)

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import {
  BOUND_GATES,
  bindingState,
  gateFiles,
  gateInputs,
} from './approval-binding.js';
import { GATE_STEP, listGateRecords } from './gate-records.js';
import { GATE_KEYS } from '../pipeline-state.js';

/** @typedef {import('./approval-binding.js').Context} Context */
/** @typedef {import('./gate-records.js').GateRecord} GateRecord */

/**
 * A short name a reviewer recognizes, per gate key.
 * @type {Record<string, string>}
 */
export const GATE_LABEL = {
  requirements_reviewed: 'Gate 1',
  test_scope_reviewed: 'Gate 2',
  qa_scope_approved: 'Gates 1+2 (lite)',
  specs_reviewed: 'Gate 3',
  code_reviewed: 'Gate 4',
  collection_reviewed: "API Gate 3'",
  api_assertions_reviewed: "API Gate 4'",
  external_plan_reviewed: 'External Gate 3',
  external_evidence_reviewed: 'External Gate 4',
};

/**
 * A gate named either way: its step (`gate2`, `qa_scope`, `gate3-api`) or its
 * key (`test_scope_reviewed`).
 * @param {string | null | undefined} name
 * @returns {string | null} the gate key, or null when it names no gate
 */
export function resolveGate(name) {
  if (!name) return null;
  if (GATE_KEYS[name]) return GATE_KEYS[name];
  return BOUND_GATES.includes(name) ? name : null;
}

/**
 * One line of a run's gate history.
 * @typedef {{ kind: 'decision', at: string, gate: string,
 *   decision: string, reviewer: string | null, notes: string | null,
 *   opened_at: string | null, record: string | null }
 * | { kind: 'reset', at: string, gate: string, reason: string }} TimelineRow
 */

/**
 * Every decision and every return to pending, oldest first. Records are
 * matched to decisions per gate from the most recent one back, so a run whose
 * early decisions predate gate records still lines up.
 * @param {Context} context
 * @param {GateRecord[]} records
 * @returns {TimelineRow[]}
 */
export function gateTimeline(context, records) {
  /** @type {{ gate: string, decision: string, decided_at: string, opened_at?: string, reviewer?: string | null, notes?: string | null }[]} */
  const decisions = context?.gate_decisions ?? [];
  /** @type {{ gate: string, invalidated_at: string, reason: string }[]} */
  const resets = context?.gate_invalidations ?? [];

  /** @type {Map<string, (string | null)[]>} */
  const byGate = new Map();
  for (const gate of new Set(decisions.map((d) => d.gate))) {
    const mine = decisions.filter((d) => d.gate === gate);
    const recs = records.filter((r) => r.gate === gate).map((r) => r.record);
    const offset = mine.length - recs.length;
    byGate.set(
      gate,
      mine.map((_, i) => (i - offset >= 0 ? recs[i - offset] : null))
    );
  }
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {TimelineRow[]} */
  const rows = decisions.map((d) => {
    const i = seen.get(d.gate) ?? 0;
    seen.set(d.gate, i + 1);
    return {
      kind: 'decision',
      at: d.decided_at,
      gate: d.gate,
      decision: d.decision,
      reviewer: d.reviewer ?? null,
      notes: d.notes ?? null,
      opened_at: d.opened_at ?? null,
      record: byGate.get(d.gate)?.[i] ?? null,
    };
  });
  for (const r of resets) {
    rows.push({
      kind: 'reset',
      at: r.invalidated_at,
      gate: r.gate,
      reason: r.reason,
    });
  }
  // Stable: decisions keep their logged order when timestamps tie.
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => Date.parse(a.row.at) - Date.parse(b.row.at) || a.i - b.i)
    .map(({ row }) => row);
}

/** @param {string | null} from @param {string} to */
function took(from, to) {
  if (!from) return '';
  const s = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  if (!Number.isFinite(s) || s < 0) return '';
  return s < 120 ? ` (${s} s)` : ` (${Math.round(s / 6) / 10} min)`;
}

const when = (/** @type {string} */ iso) =>
  iso ? iso.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, 'Z') : '?';

/**
 * The history as printed by `--history`, with each gate's standing now.
 * @param {Context} context
 * @param {string} [root]
 * @returns {string}
 */
export function renderHistory(context, root = '.') {
  const rows = gateTimeline(context, listGateRecords(root));
  const lines = [
    `Gate history: ${context?.story?.id ?? '(no story)'} · run ${context?.run_id ?? '(none)'}`,
    '',
  ];
  if (!rows.length) lines.push('  No gate has been decided yet.');
  for (const r of rows) {
    const label = (GATE_LABEL[r.gate] ?? r.gate).padEnd(16);
    if (r.kind === 'decision') {
      lines.push(
        `  ${when(r.at)}  ${label} ${r.decision.toUpperCase().padEnd(9)} ${r.reviewer ?? '(no reviewer)'}${took(r.opened_at, r.at)}`
      );
      if (r.notes) lines.push(`      "${r.notes.replace(/\s+/g, ' ')}"`);
      lines.push(
        `      ${r.record ?? '(no gate record: decided before records were kept)'}`
      );
    } else {
      lines.push(`  ${when(r.at)}  ${label} returned to pending`);
      lines.push(`      ${r.reason}`);
    }
  }
  lines.push('', 'Now:');
  for (const gate of BOUND_GATES) {
    if (context?.review_gates?.[gate] === undefined) continue;
    const s = bindingState(gate, context, root);
    const state =
      s.state === 'current'
        ? 'approved'
        : s.state === 'pending'
          ? 'pending'
          : s.state === 'legacy'
            ? 'approved before approvals were bound; needs re-review'
            : `approved, but changed since: ${s.changed.join(', ')} (returns to pending on the next --resume)`;
    lines.push(`  ${(GATE_LABEL[gate] ?? gate).padEnd(16)} ${state}`);
  }
  return lines.join('\n');
}

/**
 * The text a reviewer compares for an input. Gate 1's interpretation and
 * Gate 3's prompt versions live in context.json; only their part is shown.
 * @param {string} input
 * @param {Buffer} bytes
 * @returns {string}
 */
function comparable(input, bytes) {
  if (input !== 'interpretation' && input !== 'prompt_versions') {
    return bytes.toString('utf8');
  }
  /** @type {Context} */
  let ctx;
  try {
    ctx = JSON.parse(bytes.toString('utf8'));
  } catch {
    return bytes.toString('utf8');
  }
  if (input === 'interpretation') {
    return (
      JSON.stringify(
        {
          acceptance_criteria: ctx.acceptance_criteria ?? [],
          risks: ctx.risks ?? [],
          ambiguities: ctx.ambiguities ?? [],
          track: ctx.track ?? null,
        },
        null,
        2
      ) + '\n'
    );
  }
  const versions = Object.fromEntries(
    Object.entries(ctx.prompt_versions ?? {}).filter(([k]) =>
      /planner|generator/i.test(k)
    )
  );
  return JSON.stringify(versions, null, 2) + '\n';
}

/**
 * The changed lines between two texts, by `git diff --no-index` (no diff of
 * our own). Null when git is not available.
 * @param {string} before
 * @param {string} after
 * @returns {string | null}
 */
function lineDiff(before, after) {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-diff-'));
  try {
    writeFileSync(join(dir, 'approved'), before);
    writeFileSync(join(dir, 'now'), after);
    const r = spawnSync(
      'git',
      [
        'diff',
        '--no-index',
        '--no-color',
        '--no-prefix',
        '--',
        'approved',
        'now',
      ],
      { cwd: dir, encoding: 'utf8' }
    );
    if (r.error || (r.status !== 0 && r.status !== 1)) return null;
    // Keep the hunks; the file header names temporary files.
    return r.stdout
      .split('\n')
      .filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l))
      .join('\n')
      .trimEnd();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One reviewed input compared with its approved copy.
 * @typedef {{ input: string, path: string,
 *   state: 'unchanged' | 'changed' | 'missing now' | 'new since'
 *     | 'unchanged (by digest)' | 'changed (by digest)' | 'not copied',
 *   diff: string | null }} DiffEntry
 */

/**
 * A gate's reviewed files now, against the copy kept with its latest
 * approval. Files kept only as a digest are compared by digest while the
 * approval still carries it.
 * @param {string} gate a gate key
 * @param {Context} context
 * @param {string} [root]
 * @returns {{ record: GateRecord | null, entries: DiffEntry[] }}
 */
export function gateDiff(gate, context, root = '.') {
  const record =
    listGateRecords(root)
      .filter((r) => r.gate === gate && r.decision === 'approved')
      .pop() ?? null;
  if (!record) return { record: null, entries: [] };
  const rootAbs = resolve(root);
  const recorded = context?.review_gates?.[gate]?.inputs ?? null;
  const now = gateInputs(gate, context, root);
  /** @type {DiffEntry[]} */
  const entries = [];
  for (const f of gateFiles(gate, context, root)) {
    const abs = resolve(root, f.path);
    const inside = abs.startsWith(rootAbs + sep);
    const rel = relative(rootAbs, abs).split(sep).join('/');
    const copy = inside ? join(root, record.dir, rel) : null;
    const hasCopy = Boolean(copy && existsSync(copy));
    const hasNow = existsSync(abs) && statSync(abs).isFile();
    if (!hasCopy) {
      /** @type {DiffEntry['state']} */
      let state = 'not copied';
      if (recorded && f.input in recorded) {
        state =
          recorded[f.input] === now[f.input]
            ? 'unchanged (by digest)'
            : 'changed (by digest)';
      } else if (hasNow && f.copy && inside) {
        state = 'new since';
      }
      entries.push({ input: f.input, path: f.path, state, diff: null });
      continue;
    }
    if (!hasNow) {
      entries.push({
        input: f.input,
        path: f.path,
        state: 'missing now',
        diff: null,
      });
      continue;
    }
    const before = comparable(
      f.input,
      readFileSync(/** @type {string} */ (copy))
    );
    const after = comparable(f.input, readFileSync(abs));
    entries.push({
      input: f.input,
      path: f.path,
      state: before === after ? 'unchanged' : 'changed',
      diff: before === after ? null : lineDiff(before, after),
    });
  }
  return { record, entries };
}

/**
 * The comparison as printed by `--diff <gate>`.
 * @param {string} gate a gate key
 * @param {Context} context
 * @param {string} [root]
 * @returns {string}
 */
export function renderDiff(gate, context, root = '.') {
  const label = GATE_LABEL[gate] ?? gate;
  const { record, entries } = gateDiff(gate, context, root);
  if (!record) {
    return `${label} (${GATE_STEP[gate]}): no approved gate record to compare with yet.`;
  }
  const lines = [
    `${label} (${GATE_STEP[gate]}): now, compared with ${record.record}`,
    '',
  ];
  for (const e of entries) {
    const name = e.input === e.path ? e.path : `${e.input} (${e.path})`;
    lines.push(`  ${name}: ${e.state}`);
    if (e.state === 'changed') {
      lines.push(
        ...(e.diff ?? '(install git to see the changed lines)')
          .split('\n')
          .map((l) => `      ${l}`)
      );
    }
  }
  const differ = new Set([
    'changed',
    'changed (by digest)',
    'missing now',
    'new since',
  ]);
  const changed = entries.filter((e) => differ.has(e.state));
  lines.push(
    '',
    changed.length
      ? `${changed.length} of ${entries.length} reviewed input(s) differ from the approved copy.`
      : 'Everything this gate reviewed is as it was approved.'
  );
  return lines.join('\n');
}
