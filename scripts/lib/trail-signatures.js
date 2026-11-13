// @ts-check
// The signatures of a run's gate records (record-signing.js), checked one by
// one: a signed record must verify against the allowed signers, with the
// key it names when it names one, and its signer must be its reviewer. A
// record that names a key but has no valid signature is a problem whether
// signing is required or not, so deleting a signature shows; an unsigned
// record that names no key is a problem only when signatures are required.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { listGateRecords, readRecord } from './gate-records.js';
import { verifyRecord } from './record-signing.js';

/**
 * @param {string} root the run's folder
 * @param {string} allowedSigners path to the allowed signers file
 * @param {{ require?: boolean }} [opts]
 * @returns {{ problems: string[], lines: string[], signed: number,
 *   unsigned: number }}
 */
export function trailSignatures(root, allowedSigners, opts = {}) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const lines = [];
  let signed = 0;
  let unsigned = 0;
  for (const r of listGateRecords(root)) {
    const abs = join(root, r.record);
    const { reviewer, signingKey } = readRecord(root, r.record);
    const hasSig = existsSync(`${abs}.sig`);
    if (!hasSig && !signingKey) {
      unsigned += 1;
      lines.push(`${r.record}: unsigned`);
      if (opts.require)
        problems.push(`${r.record} is not signed, and signatures are required`);
      continue;
    }
    const v = verifyRecord(abs, allowedSigners, signingKey);
    if (!v.ok) {
      problems.push(
        `${r.record}${signingKey ? ` names the signing key ${signingKey}, but` : ''} ${v.reason}`
      );
      lines.push(`${r.record}: signature NOT valid`);
      continue;
    }
    if (reviewer !== v.principal) {
      problems.push(
        `${r.record} was signed by ${v.principal}, but it names ${reviewer ?? 'no reviewer'} as the reviewer`
      );
      lines.push(
        `${r.record}: signed by ${v.principal}, another than its reviewer`
      );
      continue;
    }
    signed += 1;
    lines.push(`${r.record}: signed by ${v.principal}`);
  }
  return { problems, lines, signed, unsigned };
}
