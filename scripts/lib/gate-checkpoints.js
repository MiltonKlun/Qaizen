// @ts-check
// Going back to a gate: reopen it, or restore what it approved.
//
//   reopenGate   returns a gate, and every approval that depended on it, to
//                pending, with the reviewer's reason (gate_invalidations[],
//                the same log a stale approval goes to). Nothing is approved
//                or rejected: the old approval stays in the log.
//   restorePlan  what a restore would put back: every reviewed file that
//   applyRestore differs from the copy kept by the gate's latest approval
//                (scripts/lib/gate-records.js), from that copy.
//
// Both only move a run backwards. A restored gate whose approval was already
// returned to pending stays pending: a person approves it again (the brief
// then says it is exactly what was approved before). Restoring never records
// an approval. The runner calls these only from its interactive prompts.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';

import {
  DOWNSTREAM,
  applyInvalidations,
  bindingVersionOf,
  gateDigest,
} from './approval-binding.js';
import { gateDiff } from './gate-history.js';
import {
  listGateRecords,
  readRecord,
  recordBindingVersion,
  recordProblem,
} from './gate-records.js';
import { gatePassed } from '../pipeline-state.js';

/** @typedef {import('./approval-binding.js').Context} Context */
/** @typedef {import('./gate-records.js').GateRecord} GateRecord */

const sha256 = (/** @type {Buffer} */ b) =>
  createHash('sha256').update(b).digest('hex');

/**
 * Return a gate and the approvals that depended on it to pending.
 * @param {Context} context changed in place
 * @param {string} gate a gate key
 * @param {{ reviewer: string | null, reason: string, root?: string,
 *   now?: Date }} who
 * @returns {string[]} the gates returned to pending (empty: it was not
 *   approved, so there was nothing to reopen)
 */
export function reopenGate(
  context,
  gate,
  { reviewer, reason, root = '.', now }
) {
  if (!gatePassed(context?.review_gates?.[gate])) return [];
  const gates = [
    gate,
    ...(DOWNSTREAM[gate] ?? []).filter((g) =>
      gatePassed(context.review_gates?.[g])
    ),
  ];
  const entries = gates.map((g) => {
    const value = context.review_gates[g];
    return {
      gate: g,
      reason:
        g === gate
          ? `reopened by ${reviewer ?? '(no reviewer)'}: ${reason}`
          : `depends on ${gate}, which was reopened`,
      approved_digest:
        typeof value === 'object' ? (value.input_digest ?? null) : null,
      current_digest: gateDigest(g, context, root, bindingVersionOf(value)),
      changed_inputs: [],
    };
  });
  applyInvalidations(context, entries, now);
  return gates;
}

/**
 * What a restore of `gate` would do.
 * @typedef {{ record: GateRecord | null,
 *   restore: { input: string, path: string, from: string, sha256: string }[],
 *   cannot: { input: string, path: string, why: string,
 *     refused?: boolean }[] }} RestorePlan
 */

/**
 * @param {string} gate a gate key
 * @param {Context} context
 * @param {string} [root]
 * @returns {RestorePlan}
 */
export function restorePlan(gate, context, root = '.') {
  const { record, entries } = gateDiff(gate, context, root);
  /** @type {RestorePlan} */
  const plan = { record, restore: [], cannot: [] };
  if (!record) return plan;
  const rootAbs = resolve(root);
  // Nothing is put back that cannot be shown to be what was approved: the
  // record must be intact, and each copy must still have the digest the
  // record holds for it.
  const untrusted = recordProblem(context, root, record.record);
  // Copy digests count only in a chained record: one written before the
  // chain could have such a section appended to it afterwards.
  const rec = readRecord(root, record.record);
  const copies = rec.previous === undefined ? null : rec.copies;
  for (const e of entries) {
    if (e.state === 'changed' || e.state === 'missing now') {
      const rel = resolve(root, e.path)
        .slice(rootAbs.length + 1)
        .split(sep)
        .join('/');
      const from = `${record.dir}/${rel}`;
      const kept = copies?.get(rel);
      const why = untrusted
        ? untrusted
        : !copies
          ? 'its record was written before records were chained, so the copy cannot be verified'
          : !kept
            ? 'its record holds no digest for this copy'
            : sha256(readFileSync(join(root, from))) !== kept
              ? 'its copy changed since the approval'
              : null;
      if (why) {
        plan.cannot.push({ input: e.input, path: e.path, why, refused: true });
        continue;
      }
      plan.restore.push({
        input: e.input,
        path: e.path,
        from,
        sha256: /** @type {string} */ (kept),
      });
    } else if (e.state === 'changed (by digest)') {
      plan.cannot.push({
        input: e.input,
        path: e.path,
        why: 'changed, but only its digest was kept',
      });
    } else if (e.state === 'new since') {
      plan.cannot.push({
        input: e.input,
        path: e.path,
        why: 'added since the approval; a restore does not delete files',
      });
    }
  }
  return plan;
}

/** The planner and generator prompt versions (what Gate 3 binds before binding version 3; from v3 it binds their prompt files). */
const specPrompt = (/** @type {string} */ k) => /planner|generator/i.test(k);

/**
 * Put back every file in the plan from its approved copy. Gate 1's
 * interpretation and Gate 3's prompt versions are restored into `context`,
 * which the caller then saves (validated). Every copy is read and checked
 * against the digest its record holds before anything is written; one that
 * changed since the plan was made stops the restore with nothing written.
 * @param {RestorePlan} plan
 * @param {Context} context changed in place for context.json inputs
 * @param {string} [root]
 * @returns {string[]} what was restored
 */
export function applyRestore(plan, context, root = '.') {
  const read = plan.restore.map((item) => {
    const bytes = readFileSync(join(root, item.from));
    if (sha256(bytes) !== item.sha256)
      throw new Error(
        `${item.from} changed since the approval; nothing was restored`
      );
    return { item, bytes };
  });
  /** @type {string[]} */
  const done = [];
  for (const { item, bytes } of read) {
    if (item.input === 'interpretation' || item.input === 'prompt_versions') {
      const was = JSON.parse(bytes.toString('utf8'));
      if (item.input === 'interpretation') {
        for (const k of ['acceptance_criteria', 'risks', 'ambiguities']) {
          context[k] = was[k] ?? [];
        }
        if (was.track === undefined) delete context.track;
        else context.track = was.track;
      } else {
        const now = context.prompt_versions ?? {};
        for (const k of Object.keys(now)) if (specPrompt(k)) delete now[k];
        for (const [k, v] of Object.entries(was.prompt_versions ?? {})) {
          if (specPrompt(k)) now[k] = v;
        }
        context.prompt_versions = now;
      }
      done.push(`${item.input} (context.json)`);
      continue;
    }
    // Written aside and renamed, so a failure never leaves half a file.
    const dest = join(root, item.path);
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.qaizen-restore-${process.pid}`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, dest);
    done.push(item.path);
  }
  return done;
}

/**
 * The approval a gate's inputs match exactly, when an earlier gate record
 * shows one: the brief says so, so re-approving restored files is a quick,
 * informed decision. Read from the record's header table.
 * Each record is compared with the gate's digest now under the binding
 * scheme that record was computed with.
 * @param {string} gate a gate key
 * @param {Context} context
 * @param {string} [root]
 * @returns {{ record: string, reviewer: string, decided: string } | null}
 */
export function earlierApprovalOf(gate, context, root = '.') {
  const records = listGateRecords(root)
    .filter((r) => r.gate === gate && r.decision === 'approved')
    .reverse();
  /** @type {Map<number, string>} */
  const now = new Map();
  for (const r of records) {
    const path = join(root, r.record);
    if (!existsSync(path)) continue;
    // An edited record cannot vouch for who approved what.
    if (recordProblem(context, root, r.record)) continue;
    const md = readFileSync(path, 'utf8');
    const d = /\| Approval digest \| `([0-9a-f]{64})` \|/.exec(md)?.[1];
    const version = recordBindingVersion(root, r.record);
    if (!now.has(version))
      now.set(version, gateDigest(gate, context, root, version));
    if (d !== now.get(version)) continue;
    return {
      record: r.record,
      reviewer: /\| Reviewer \| (.*?) \|/.exec(md)?.[1] ?? '(unknown)',
      decided: /\| Decided \| (\S+)/.exec(md)?.[1] ?? '(unknown)',
    };
  }
  return null;
}
