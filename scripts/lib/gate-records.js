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
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { gateFiles } from './approval-binding.js';
import { writeTextAtomic } from './artifact-io.js';
import { dispositionSection } from './finding-dispositions.js';
import { GATE_KEYS } from '../pipeline-state.js';

/** @typedef {import('./approval-binding.js').Context} Context */

/** Where a run's gate records live, at the run's root. */
export const GATES_DIR = 'gates';

/** The runner step for each gate key (`requirements_reviewed` -> `gate1`). */
export const GATE_STEP = Object.fromEntries(
  Object.entries(GATE_KEYS).map(([step, key]) => [key, step])
);

const RECORD = /^(\d{3,})-([a-z0-9_-]+?)-(approved|rejected)\.md$/;

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
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  /** @type {GateRecord[]} */
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const m = e.isFile() ? RECORD.exec(e.name) : null;
    if (!m) continue;
    const step = m[2];
    out.push({
      number: Number(m[1]),
      step,
      gate: GATE_KEYS[step] ?? step,
      decision: /** @type {'approved' | 'rejected'} */ (m[3]),
      record: `${GATES_DIR}/${e.name}`,
      dir: `${GATES_DIR}/${e.name.slice(0, -3)}`,
    });
  }
  return out.sort(
    (a, b) => a.number - b.number || a.record.localeCompare(b.record)
  );
}

/**
 * The number the next record gets: one past every number already used, by
 * a record or a copy folder on disk or by a decision that names its record.
 * A record whose write failed is never numbered again, so a retry cannot
 * take its name.
 * @param {string} root
 * @param {Context} context
 * @returns {number}
 */
function nextRecordNumber(root, context) {
  const dir = join(root, GATES_DIR);
  const used = [0];
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    for (const name of readdirSync(dir)) {
      const m = /^(\d{3,})-/.exec(name);
      if (m) used.push(Number(m[1]));
    }
  }
  for (const d of Array.isArray(context?.gate_decisions)
    ? context.gate_decisions
    : []) {
    const m = /^gates\/(\d{3,})-/.exec(d?.record?.path ?? '');
    if (m) used.push(Number(m[1]));
  }
  return Math.max(...used) + 1;
}

/**
 * The binding scheme a gate record's approval was computed under, from its
 * header table. A record written before the scheme was versioned has no such
 * row and is version 1.
 * @param {string} root
 * @param {string} record repository-relative path of the record (.md)
 * @returns {number}
 */
export function recordBindingVersion(root, record) {
  const abs = join(root, record);
  if (!existsSync(abs)) return 1;
  const m = /^\| Binding version \| (\d+) \|$/m.exec(readFileSync(abs, 'utf8'));
  return m ? Number(m[1]) : 1;
}

/**
 * One copy a record keeps, with the digest of its bytes.
 * @typedef {{ rel: string, bytes: Buffer, sha256: string }} RecordCopy
 */
/**
 * A record built but not yet written (prepareGateRecord).
 * @typedef {{ number: number, name: string, record: string, dir: string,
 *   text: string, sha256: string, copies: RecordCopy[] }} PreparedRecord
 */

const sha256 = (/** @type {string | Buffer} */ b) =>
  createHash('sha256').update(b).digest('hex');

/**
 * A record's digest: its text with line endings normalized, so the same
 * record checked out with CRLF line endings does not read as edited.
 * @param {string} text
 */
const textSha = (text) => sha256(text.replace(/\r\n/g, '\n'));

/**
 * The digest of a record on disk, or null when it is missing.
 * @param {string} root
 * @param {string} record repository-relative path of the record (.md)
 * @returns {string | null}
 */
export function recordDigest(root, record) {
  const abs = join(root, record);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  return textSha(readFileSync(abs, 'utf8'));
}

/**
 * What a record says about its place in the trail and its copies.
 * `previous` is undefined for a record written before records were chained;
 * `copies` is null for one written before copies carried digests.
 * @param {string} root
 * @param {string} record
 * @returns {{ previous: { record: string, sha256: string } | null | undefined,
 *   copies: Map<string, string> | null }}
 */
export function readRecord(root, record) {
  const abs = join(root, record);
  const md = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  const row = /^\| Previous record \| (.*) \|$/m.exec(md)?.[1];
  /** @type {{ record: string, sha256: string } | null | undefined} */
  let previous;
  if (row === '(none)') previous = null;
  else if (row) {
    const m = /^(\S+) `([0-9a-f]{64}|\(missing\))`$/.exec(row);
    previous = m ? { record: m[1], sha256: m[2] } : undefined;
  }
  const text = md.replace(/\r\n/g, '\n');
  const at = text.indexOf('\n## Copy digests\n');
  const end = at < 0 ? -1 : text.indexOf('\n## ', at + 1);
  const section =
    at < 0 ? undefined : text.slice(at, end < 0 ? undefined : end);
  /** @type {Map<string, string> | null} */
  let copies = null;
  if (section !== undefined) {
    copies = new Map();
    for (const m of section.matchAll(/^\| `(.+)` \| `([0-9a-f]{64})` \|$/gm))
      copies.set(m[1], m[2]);
  }
  return { previous, copies };
}

/**
 * Check the run's review trail and say what does not hold: a gap in the
 * record numbers, a record whose predecessor no longer has the digest it
 * was chained to, a decision whose record is missing or was edited since it
 * was written. Records and decisions from before the trail was chained are
 * not checked for what they never carried. Nothing is written.
 *
 * This shows that the trail was changed after the fact; it does not show who
 * made a decision. context.json and gates/ can both be edited by anyone with
 * the checkout (docs/pipeline-runner.md, "No approval flag").
 * @param {Context} context
 * @param {string} [root]
 * @returns {string[]}
 */
export function verifyGateTrail(context, root = '.') {
  /** @type {string[]} */
  const problems = [];
  const records = listGateRecords(root);
  const paths = new Set(records.map((r) => r.record));
  /** @type {any[]} */
  const decisions = Array.isArray(context?.gate_decisions)
    ? context.gate_decisions
    : [];
  const named = new Set(decisions.map((d) => d?.record?.path).filter(Boolean));
  const n = (/** @type {number} */ x) => String(x).padStart(3, '0');
  records.forEach((r, i) => {
    const before = records[i - 1];
    if (before && before.number === r.number) {
      problems.push(
        `two records are numbered ${n(r.number)}: ${before.record} and ${r.record}`
      );
    } else {
      const expected = before ? before.number + 1 : 1;
      if (r.number > expected)
        problems.push(
          r.number - 1 === expected
            ? `record ${n(expected)} is missing before ${r.record}`
            : `records ${n(expected)}-${n(r.number - 1)} are missing before ${r.record}`
        );
    }
    const { previous } = readRecord(root, r.record);
    if (previous === undefined) return;
    if (!named.has(r.record))
      problems.push(`no decision in context.json names ${r.record}`);
    if (previous === null) {
      if (before && before.number !== r.number)
        problems.push(
          `${r.record} says it is the first record, but ${before.record} comes before it`
        );
      return;
    }
    if (!paths.has(previous.record)) {
      problems.push(
        `${r.record} follows ${previous.record}, which is no longer in the trail`
      );
      return;
    }
    if (recordDigest(root, previous.record) !== previous.sha256)
      problems.push(
        `${previous.record} was edited after ${r.record} was chained to it`
      );
  });
  for (const d of decisions) {
    const rec = d?.record;
    if (!rec?.path) continue;
    const now = recordDigest(root, rec.path);
    if (now === null)
      problems.push(
        `${rec.path} (the record of the ${d.decision} ${d.gate} decision at ${d.decided_at}) is missing`
      );
    else if (now !== rec.sha256)
      problems.push(
        `${rec.path} was edited after the ${d.decision} ${d.gate} decision recorded it`
      );
  }
  return problems;
}

/**
 * Whether a record can be trusted to say what was approved: why not, or
 * null. It must still have the digest its decision recorded and the digest
 * the next record was chained to, and a chained record must be named by a
 * decision in context.json.
 * @param {Context} context
 * @param {string} root
 * @param {string} record
 * @returns {string | null}
 */
export function recordProblem(context, root, record) {
  const now = recordDigest(root, record);
  if (now === null) return `${record} is missing`;
  /** @type {any[]} */
  const decisions = Array.isArray(context?.gate_decisions)
    ? context.gate_decisions
    : [];
  const anchor = decisions.find((d) => d?.record?.path === record)?.record;
  if (anchor && anchor.sha256 !== now)
    return `${record} was edited after its decision recorded it`;
  const records = listGateRecords(root);
  const i = records.findIndex((r) => r.record === record);
  const next = i >= 0 ? records[i + 1] : undefined;
  const link = next ? readRecord(root, next.record).previous : undefined;
  if (link && link.record === record && link.sha256 !== now)
    return `${record} was edited after ${next?.record} was chained to it`;
  if (!anchor && readRecord(root, record).previous !== undefined)
    return `no decision in context.json names ${record}`;
  return null;
}

/**
 * Everything that keeps a record from showing what was approved: its own
 * problem (recordProblem), and each copy whose bytes no longer have the
 * digest the record holds for it. Empty when it can be trusted.
 * @param {Context} context
 * @param {string} root
 * @param {GateRecord} record
 * @returns {string[]}
 */
export function recordTrustProblems(context, root, record) {
  const own = recordProblem(context, root, record.record);
  if (own) return [own];
  const { previous, copies } = readRecord(root, record.record);
  if (previous === undefined || !copies) return [];
  /** @type {string[]} */
  const out = [];
  for (const [rel, digest] of copies) {
    const abs = join(root, record.dir, rel);
    const now =
      existsSync(abs) && statSync(abs).isFile()
        ? sha256(readFileSync(abs))
        : null;
    if (now !== digest)
      out.push(
        `${record.dir}/${rel} ${now === null ? 'is missing' : 'changed since the approval'}`
      );
  }
  return out;
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
 * Build the record of one decision and the copies of what it reviewed, in
 * memory: nothing is written (commitGateRecord writes it). The record names
 * the record before it by digest; its own digest is returned so the decision
 * can name it.
 * @param {{
 *   root?: string,
 *   context: Context,
 *   gate: string,
 *   decision: 'approved' | 'rejected',
 *   reviewer: string | null,
 *   notes: string | null,
 *   openedAt: string,
 *   decidedAt: string,
 *   binding: { binding_version?: number, input_digest: string,
 *     inputs: Record<string, string | null> },
 *   captured: CapturedFile[],
 *   brief: string,
 *   scan?: string | null,
 *   dispositions?: import('./finding-dispositions.js').DispositionRecord[],
 *   title?: string,
 * }} args
 * @returns {PreparedRecord}
 */
export function prepareGateRecord({
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
  dispositions = [],
  title,
}) {
  const step = GATE_STEP[gate];
  if (!step) throw new Error(`prepareGateRecord: unknown gate "${gate}"`);
  const existing = listGateRecords(root);
  const last = existing[existing.length - 1];
  const number = nextRecordNumber(root, context);
  const name = `${String(number).padStart(3, '0')}-${step}-${decision}`;
  const dirRel = `${GATES_DIR}/${name}`;
  const recordRel = `${dirRel}.md`;

  // 1. The copies, each with the digest of its bytes, so a restore can
  // prove a copy is still what was reviewed.
  /** @type {Map<string, string>} */
  const copied = new Map();
  /** @type {RecordCopy[]} */
  const copies = [];
  for (const f of captured) {
    if (!f.bytes) continue;
    const rel = posix(relative(resolve(root), resolve(root, f.path)));
    if (copies.some((c) => c.rel === rel)) {
      copied.set(f.input, `${dirRel}/${rel}`);
      continue;
    }
    copies.push({ rel, bytes: f.bytes, sha256: sha256(f.bytes) });
    copied.set(f.input, `${dirRel}/${rel}`);
  }

  // 2. The record itself, chained to the one before it.
  const previous = last
    ? `${cell(last.record)} \`${recordDigest(root, last.record) ?? '(missing)'}\``
    : '(none)';
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
    `| Binding version | ${binding.binding_version ?? 1} |`,
    `| Previous record | ${previous} |`,
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
  if (copies.length) {
    lines.push(
      '## Copy digests',
      '',
      'The SHA-256 of each copy, byte for byte. A restore puts back only a copy that still matches.',
      '',
      '| Copy | SHA-256 |',
      '| --- | --- |',
      ...copies.map((c) => `| \`${c.rel}\` | \`${c.sha256}\` |`),
      ''
    );
  }
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
  lines.push(...dispositionSection(dispositions));
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
  const text = lines.join('\n');
  return {
    number,
    name,
    record: recordRel,
    dir: copies.length ? dirRel : '',
    text,
    sha256: textSha(text),
    copies,
  };
}

/**
 * Write a prepared record: the copies first, assembled aside and renamed
 * into place so a failure never leaves a half-written snapshot under its
 * final name, then the record.
 * @param {string} root
 * @param {PreparedRecord} prepared
 * @returns {{ number: number, record: string, dir: string }}
 */
export function commitGateRecord(root, prepared) {
  const gatesAbs = join(root, GATES_DIR);
  mkdirSync(gatesAbs, { recursive: true });
  if (prepared.copies.length) {
    const tmp = join(gatesAbs, `.tmp-${prepared.name}-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    for (const c of prepared.copies) {
      const dest = join(tmp, c.rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, c.bytes);
    }
    renameSync(tmp, join(root, prepared.dir));
  }
  const w = writeTextAtomic(join(root, prepared.record), prepared.text, {
    root,
  });
  if (!w.ok) throw new Error(`${prepared.record}: ${w.message}`);
  return {
    number: prepared.number,
    record: prepared.record,
    dir: prepared.dir,
  };
}
