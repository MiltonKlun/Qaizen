// @ts-check
// The signatures of a run's gate records (record-signing.js), checked one by
// one: a signed record must verify against the allowed signers for its
// reviewer and, when it names its signing key, with that key. A record that
// names a key but has no valid signature is a problem whether signing is
// required or not, so deleting a signature shows. When signatures are
// required, an unsigned record is a problem too, and so is a gate that
// stands approved without a signed record of its approval (an approval
// written with no record at all included).

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { listGateRecords, readRecord } from './gate-records.js';
import { verifyRecord } from './record-signing.js';

/**
 * @param {string} root the run's folder
 * @param {string} allowedSigners path to the allowed signers file
 * @param {{ require?: boolean, context?: any, revoked?: string | null }} [opts]
 * @returns {{ problems: string[], lines: string[], signed: number,
 *   unsigned: number }}
 */
export function trailSignatures(root, allowedSigners, opts = {}) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const lines = [];
  /** @type {Set<string>} */
  const valid = new Set();
  let signed = 0;
  let unsigned = 0;
  for (const r of listGateRecords(root)) {
    const abs = join(root, r.record);
    const { reviewer, signingKey } = readRecord(root, r.record);
    if (!existsSync(`${abs}.sig`) && !signingKey) {
      unsigned += 1;
      lines.push(`${r.record}: unsigned`);
      if (opts.require)
        problems.push(`${r.record} is not signed, and signatures are required`);
      continue;
    }
    const v = verifyRecord(abs, allowedSigners, {
      reviewer,
      declared: signingKey,
      revoked: opts.revoked ?? null,
    });
    if (!v.ok) {
      problems.push(
        `${r.record}${signingKey ? ` names the signing key ${signingKey}, but` : ''} ${v.reason}`
      );
      lines.push(`${r.record}: signature NOT valid`);
      continue;
    }
    signed += 1;
    valid.add(r.record);
    lines.push(`${r.record}: signed by ${reviewer}`);
  }
  if (opts.require && opts.context) {
    /** @type {any[]} */
    const decisions = Array.isArray(opts.context.gate_decisions)
      ? opts.context.gate_decisions
      : [];
    for (const [gate, value] of Object.entries(
      opts.context.review_gates ?? {}
    )) {
      const passed =
        value === true ||
        (value !== null && typeof value === 'object' && value.status === true);
      if (!passed) continue;
      const approval = [...decisions]
        .reverse()
        .find((d) => d?.gate === gate && d?.decision === 'approved');
      const rec = approval?.record?.path;
      if (!rec)
        problems.push(
          `${gate} stands approved without a gate record of its approval, and signatures are required`
        );
      else if (!valid.has(rec))
        problems.push(
          `${gate} stands approved, but the record of its approval (${rec}) is not validly signed`
        );
    }
  }
  return { problems, lines, signed, unsigned };
}
