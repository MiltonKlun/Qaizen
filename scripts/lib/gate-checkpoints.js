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
import { dirname, join, resolve, sep } from 'node:path';

import {
  DOWNSTREAM,
  applyInvalidations,
  gateDigest,
} from './approval-binding.js';
import { gateDiff } from './gate-history.js';
import { listGateRecords } from './gate-records.js';
import { gatePassed } from '../pipeline-state.js';

/** @typedef {import('./approval-binding.js').Context} Context */
/** @typedef {import('./gate-records.js').GateRecord} GateRecord */

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
      current_digest: gateDigest(g, context, root),
      changed_inputs: [],
    };
  });
  applyInvalidations(context, entries, now);
  return gates;
}

/**
 * What a restore of `gate` would do.
 * @typedef {{ record: GateRecord | null,
 *   restore: { input: string, path: string, from: string }[],
 *   cannot: { input: string, path: string, why: string }[] }} RestorePlan
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
  for (const e of entries) {
    if (e.state === 'changed' || e.state === 'missing now') {
      const rel = resolve(root, e.path)
        .slice(rootAbs.length + 1)
        .split(sep)
        .join('/');
      plan.restore.push({
        input: e.input,
        path: e.path,
        from: `${record.dir}/${rel}`,
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

/** The planner and generator prompt versions (what Gate 3 binds). */
const specPrompt = (/** @type {string} */ k) => /planner|generator/i.test(k);

/**
 * Put back every file in the plan from its approved copy. Gate 1's
 * interpretation and Gate 3's prompt versions are restored into `context`,
 * which the caller then saves (validated).
 * @param {RestorePlan} plan
 * @param {Context} context changed in place for context.json inputs
 * @param {string} [root]
 * @returns {string[]} what was restored
 */
export function applyRestore(plan, context, root = '.') {
  /** @type {string[]} */
  const done = [];
  for (const item of plan.restore) {
    const bytes = readFileSync(join(root, item.from));
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
 * @param {string} gate a gate key
 * @param {string} digest the gate's digest now
 * @param {string} [root]
 * @returns {{ record: string, reviewer: string, decided: string } | null}
 */
export function earlierApprovalOf(gate, digest, root = '.') {
  const records = listGateRecords(root)
    .filter((r) => r.gate === gate && r.decision === 'approved')
    .reverse();
  for (const r of records) {
    const path = join(root, r.record);
    if (!existsSync(path)) continue;
    const md = readFileSync(path, 'utf8');
    const d = /\| Approval digest \| `([0-9a-f]{64})` \|/.exec(md)?.[1];
    if (d !== digest) continue;
    return {
      record: r.record,
      reviewer: /\| Reviewer \| (.*?) \|/.exec(md)?.[1] ?? '(unknown)',
      decided: /\| Decided \| (\S+)/.exec(md)?.[1] ?? '(unknown)',
    };
  }
  return null;
}
