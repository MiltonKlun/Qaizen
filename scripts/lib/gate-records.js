// @ts-check
// Gate records: what every gate decision leaves behind.
//
// An approval is bound to a SHA-256 of what it reviewed (approval-binding.js).
// A digest proves whether something changed, but not what it was, and it
// cannot be read by a person or restored. So each decision, approved or
// rejected, also writes:
//
//   gates/<NNN>-<gate>-<decision>.md   the record: who, when, how long, the
//                                       brief exactly as shown, the automatic
//                                       checks, every input with its digest
//   gates/<NNN>-<gate>-<decision>/     a copy of every reviewed file, at its
//                                       own relative path
//
// NNN numbers the decisions of the run in order. The records are the run's
// review trail; they are archived with the run like its other artifacts.
// Nothing here decides or changes a gate: the runner records the decision in
// context.json first, then writes the record of it.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { gateFiles } from './approval-binding.js';
import { writeTextAtomic } from './artifact-io.js';
import { GATE_KEYS } from '../pipeline-state.js';

/** @typedef {import('./approval-binding.js').Context} Context */

/** Where a run's gate records live, at the run's root. */
export const GATES_DIR = 'gates';

/** The runner step for each gate key (`requirements_reviewed` -> `gate1`). */
export const GATE_STEP = Object.fromEntries(
  Object.entries(GATE_KEYS).map(([step, key]) => [key, step])
);

const RECORD = /^(\d{3})-([a-z0-9_-]+?)-(approved|rejected)\.md$/;

/**
 * One reviewed file as it was when the decision was made.
 * @typedef {{ input: string, path: string, copy: boolean,
 *   bytes: Buffer | null, note: string | null }} CapturedFile
 */

/**
 * One gate record found on disk.
 * @typedef {{ number: number, step: string, gate: string,
 *   decision: 'approved' | 'rejected', record: string, dir: string }} GateRecord
 */

const posix = (/** @type {string} */ p) => p.split(sep).join('/');

/**
 * Read every file a gate reviews, now, before the decision changes anything.
 * A file outside the run (the demo's tests live in examples/) or a repository
 * file (`copy: false`) keeps only its digest in the record.
 * @param {string} gate
 * @param {Context} context
 * @param {string} [root]
 * @returns {CapturedFile[]}
 */
export function captureGateFiles(gate, context, root = '.') {
  const rootAbs = resolve(root);
  return gateFiles(gate, context, root).map(({ input, path, copy }) => {
    const abs = resolve(root, path);
    const inside = abs === rootAbs || abs.startsWith(rootAbs + sep);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      return { input, path, copy, bytes: null, note: 'missing' };
    }
    if (!copy) {
      return {
        input,
        path,
        copy,
        bytes: null,
        note: 'repository file; digest only',
      };
    }
    if (!inside) {
      return {
        input,
        path,
        copy,
        bytes: null,
        note: 'outside the run folder; digest only',
      };
    }
    return { input, path, copy, bytes: readFileSync(abs), note: null };
  });
}

/**
 * The gate records already written for this run, oldest first.
 * @param {string} [root]
 * @returns {GateRecord[]}
 */
export function listGateRecords(root = '.') {
  const dir = join(root, GATES_DIR);
  if (!existsSync(dir)) return [];
  /** @type {GateRecord[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const m = RECORD.exec(name);
    if (!m) continue;
    const step = m[2];
    out.push({
      number: Number(m[1]),
      step,
      gate: GATE_KEYS[step] ?? step,
      decision: /** @type {'approved' | 'rejected'} */ (m[3]),
      record: `${GATES_DIR}/${name}`,
      dir: `${GATES_DIR}/${name.slice(0, -3)}`,
    });
  }
  return out.sort((a, b) => a.number - b.number);
}

/** @param {string | null | undefined} from @param {string | null | undefined} to */
function duration(from, to) {
  if (!from || !to) return null;
  const s = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  if (!Number.isFinite(s) || s < 0) return null;
  return s < 120 ? `${s} s` : `${Math.round(s / 6) / 10} min`;
}

const cell = (/** @type {unknown} */ v) =>
  String(v ?? '').replace(/\|/g, '\\|');
const short = (/** @type {string | null | undefined} */ d) =>
  d ? `\`${d.slice(0, 12)}\`` : '(absent)';

/**
 * Write the record of one decision and the copy of what it reviewed.
 * The snapshot is assembled in a temporary folder and renamed into place, so
 * a failure never leaves a half-written snapshot under its final name.
 * @param {{
 *   root?: string,
 *   context: Context,
 *   gate: string,
 *   decision: 'approved' | 'rejected',
 *   reviewer: string | null,
 *   notes: string | null,
 *   openedAt: string,
 *   decidedAt: string,
 *   binding: { input_digest: string, inputs: Record<string, string | null> },
 *   captured: CapturedFile[],
 *   brief: string,
 *   scan?: string | null,
 *   title?: string,
 * }} args
 * @returns {{ number: number, record: string, dir: string }}
 */
export function writeGateRecord({
  root = '.',
  context,
  gate,
  decision,
  reviewer,
  notes,
  openedAt,
  decidedAt,
  binding,
  captured,
  brief,
  scan = null,
  title,
}) {
  const step = GATE_STEP[gate];
  if (!step) throw new Error(`writeGateRecord: unknown gate "${gate}"`);
  const existing = listGateRecords(root);
  const number = existing.length ? existing[existing.length - 1].number + 1 : 1;
  const name = `${String(number).padStart(3, '0')}-${step}-${decision}`;
  const dirRel = `${GATES_DIR}/${name}`;
  const recordRel = `${dirRel}.md`;
  const gatesAbs = join(root, GATES_DIR);
  mkdirSync(gatesAbs, { recursive: true });

  // 1. The snapshot, assembled aside and moved into place.
  const tmp = join(gatesAbs, `.tmp-${name}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  /** @type {Map<string, string>} */
  const copied = new Map();
  for (const f of captured) {
    if (!f.bytes) continue;
    const rel = posix(relative(resolve(root), resolve(root, f.path)));
    const dest = join(tmp, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.bytes);
    copied.set(f.input, `${dirRel}/${rel}`);
  }
  if (copied.size) {
    renameSync(tmp, join(root, dirRel));
  } else {
    rmSync(tmp, { recursive: true, force: true });
  }

  // 2. The record itself.
  const storyId = context?.story?.id ?? '(unknown story)';
  /** @type {{ gate: string, decision: string, decided_at: string, reviewer?: string | null, notes?: string | null }[]} */
  const decisions = context?.gate_decisions ?? [];
  const earlier = decisions.filter((d) => d.gate === gate).slice(0, -1);
  const rows = Object.entries(binding.inputs).map(([input, digest]) => {
    if (input.startsWith('gate:')) {
      return `| ${cell(input)} | ${short(digest)} | the previous gate's approved inputs |`;
    }
    const f = captured.find((c) => c.input === input);
    const where = copied.get(input) ?? (f?.note || 'not copied');
    const path = f ? ` (${cell(f.path)})` : '';
    return `| ${cell(input)}${path} | ${short(digest)} | ${cell(where)} |`;
  });
  const took = duration(openedAt, decidedAt);
  const lines = [
    `# ${title ?? step} — ${decision.toUpperCase()}`,
    '',
    '| | |',
    '| --- | --- |',
    `| Story | ${cell(storyId)}${context?.story?.title ? ` — ${cell(context.story.title)}` : ''} |`,
    `| Run | ${cell(context?.run_id ?? '(none)')} |`,
    `| Gate | ${cell(gate)} (${step}) |`,
    `| Decision | ${decision} |`,
    `| Reviewer | ${cell(reviewer ?? '(none)')} |`,
    `| Opened | ${cell(openedAt)} |`,
    `| Decided | ${cell(decidedAt)}${took ? ` (${took})` : ''} |`,
    `| Approval digest | \`${binding.input_digest}\` |`,
    '',
  ];
  if (notes) {
    lines.push(
      decision === 'rejected' ? '## What must change' : '## Notes',
      '',
      ...notes.split(/\r?\n/).map((l) => `> ${l}`),
      ''
    );
  }
  lines.push(
    '## What was reviewed',
    '',
    'Each input with the digest the decision is bound to, and where its copy is kept.',
    '',
    '| Input | Digest | Copy |',
    '| --- | --- | --- |',
    ...rows,
    ''
  );
  if (decision === 'approved') {
    const cmd = (/** @type {string} */ flag) =>
      `\`npm run pipeline -- --${flag} ${step}\``;
    lines.push(
      '## Going back',
      '',
      `- What changed since this approval: ${cmd('diff')}`,
      `- Put back the files it approved: ${cmd('restore')}`,
      `- Send the run back to this gate: ${cmd('reopen')}`,
      ''
    );
  }
  if (earlier.length) {
    lines.push(
      '## Earlier decisions on this gate',
      '',
      ...earlier.map(
        (d) =>
          `- ${d.decision} ${d.decided_at} by ${d.reviewer ?? '(none)'}${d.notes ? `: "${d.notes.replace(/\s+/g, ' ')}"` : ''}`
      ),
      ''
    );
  }
  lines.push('## Brief as shown', '', '```text', brief.trimEnd(), '```', '');
  if (scan) {
    lines.push(
      '## Gate 4 static scan',
      '',
      '```text',
      scan.trimEnd(),
      '```',
      ''
    );
  }
  const w = writeTextAtomic(join(root, recordRel), lines.join('\n'), {
    root,
  });
  if (!w.ok) throw new Error(`${recordRel}: ${w.message}`);
  return { number, record: recordRel, dir: copied.size ? dirRel : '' };
}
