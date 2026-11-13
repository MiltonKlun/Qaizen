// @ts-check
// Optional signing of gate records with OpenSSH (`ssh-keygen -Y`).
//
// A gate record (gate-records.js) is chained to the one before it and named
// by digest in context.json, which shows that the trail was changed after the
// fact, but not who made a decision: anyone with the checkout can write a
// record. An operator who sets QAIZEN_SIGNING_KEY to an SSH key (a private
// key, or the public key of one held by ssh-agent) has each record name the
// key's fingerprint, and signs the record once it is written: the signature
// sits beside it (`gates/NNN-<gate>-<decision>.md.sig`).
//
// `npm run verify:trail` checks each signature against the team's allowed
// signers (config/allowed-signers, the format `ssh-keygen` documents): the
// signer must be the record's reviewer, and the key must be the one the
// record named. A record that names a key but has no valid signature is a
// problem whether signing is on or off, so deleting a signature shows; an
// unsigned record that names no key is valid unless signatures are required.
//
// A signature proves which key approved, not how carefully the reviewer read
// what they approved.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';

/** The namespace every gate-record signature is made in. */
export const NAMESPACE = 'qaizen-gate-record';
/** Where a team lists who may sign, relative to the repository. */
export const ALLOWED_SIGNERS = 'config/allowed-signers';

/**
 * @param {string[]} args
 * @param {{ input?: string, inheritStdin?: boolean }} [opts]
 */
function keygen(args, opts = {}) {
  const r = spawnSync('ssh-keygen', args, {
    encoding: 'utf8',
    ...(opts.input !== undefined
      ? { input: opts.input }
      : opts.inheritStdin
        ? { stdio: ['inherit', 'pipe', 'pipe'] }
        : {}),
  });
  return {
    ok: !r.error && r.status === 0,
    stdout: r.stdout ?? '',
    stderr: (r.stderr ?? '').trim() || r.error?.message || '',
    missing: Boolean(r.error && /ENOENT/.test(r.error.message)),
  };
}

/**
 * The SHA-256 fingerprint of an SSH key file (private or public).
 * @param {string} keyPath
 * @returns {{ ok: true, fingerprint: string } | { ok: false, reason: string }}
 */
export function keyFingerprint(keyPath) {
  if (!existsSync(keyPath))
    return { ok: false, reason: `the signing key ${keyPath} does not exist` };
  const r = keygen(['-l', '-E', 'sha256', '-f', keyPath]);
  const m = /\b(SHA256:[A-Za-z0-9+/=]+)/.exec(r.stdout);
  if (!r.ok || !m)
    return {
      ok: false,
      reason: r.missing
        ? 'ssh-keygen was not found (OpenSSH 8.2 or later signs records)'
        : `ssh-keygen could not read the signing key ${keyPath}: ${r.stderr}`,
    };
  return { ok: true, fingerprint: m[1] };
}

/**
 * Sign a written record. The passphrase prompt, if the key has one, reaches
 * the operator's terminal.
 * @param {string} recordPath
 * @param {string} keyPath
 * @returns {{ ok: true, signature: string } | { ok: false, reason: string }}
 */
export function signRecord(recordPath, keyPath) {
  const sig = `${recordPath}.sig`;
  rmSync(sig, { force: true });
  const r = keygen(['-Y', 'sign', '-f', keyPath, '-n', NAMESPACE, recordPath], {
    inheritStdin: true,
  });
  if (!r.ok || !existsSync(sig))
    return {
      ok: false,
      reason: `ssh-keygen could not sign ${recordPath}: ${r.stderr || 'no signature was written'}`,
    };
  return { ok: true, signature: sig };
}

/**
 * The command that signs a record by hand, for when signing failed.
 * @param {string} record
 * @param {string} keyPath
 */
export const signCommand = (record, keyPath) =>
  `ssh-keygen -Y sign -f "${keyPath}" -n ${NAMESPACE} "${record}"`;

/**
 * The allowed signers: one line per principal and key.
 * @param {string} path
 * @returns {{ principal: string, key: string }[]}
 */
export function readAllowedSigners(path) {
  if (!existsSync(path)) return [];
  /** @type {{ principal: string, key: string }[]} */
  const out = [];
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // The principals: a comma-separated list, in double quotes when a name
    // holds a space ("Ada Reviewer").
    const m = /^(?:"([^"]*)"|(\S+))\s+(.*)$/.exec(line);
    if (!m) continue;
    const principals = m[1] ?? m[2];
    const rest = m[3].split(/\s+/);
    // Options (namespaces="...", valid-after=...) may come before the key.
    const at = rest.findIndex((t) => /^(ssh-|ecdsa-|sk-)/.test(t));
    if (at < 0) continue;
    const key = rest.slice(at, at + 2).join(' ');
    for (const p of principals.split(','))
      if (p.trim()) out.push({ principal: p.trim(), key });
  }
  return out;
}

/**
 * What a record's signature shows, checked with `ssh-keygen -Y verify`
 * against the allowed signers file as the team wrote it (its namespaces,
 * validity dates and certificate authorities apply), with the record's
 * reviewer as the principal, and, when the record names its signing key,
 * that the key `ssh-keygen` reports is that one. The record is compared with
 * its line endings normalized, as it was written, so a checkout that
 * converts them does not break the signature.
 * @param {string} recordPath
 * @param {string} allowedSignersPath
 * @param {{ reviewer: string | null, declared?: string | null,
 *   revoked?: string | null }} who
 * @returns {{ ok: true, fingerprint: string | null } | { ok: false, reason: string }}
 */
export function verifyRecord(recordPath, allowedSignersPath, who) {
  const sig = `${recordPath}.sig`;
  if (!existsSync(sig)) return { ok: false, reason: 'it has no signature' };
  if (!existsSync(allowedSignersPath))
    return {
      ok: false,
      reason: `there is no allowed signers file (${allowedSignersPath}) to check its signature against (docs/signed-gate-records.md)`,
    };
  if (!who.reviewer)
    return {
      ok: false,
      reason: 'it names no reviewer to check its signer against',
    };
  const data = readFileSync(recordPath, 'utf8').replace(/\r\n/g, '\n');
  const verified = keygen(
    [
      '-Y',
      'verify',
      '-f',
      allowedSignersPath,
      '-I',
      who.reviewer,
      '-n',
      NAMESPACE,
      '-s',
      sig,
      ...(who.revoked ? ['-r', who.revoked] : []),
    ],
    { input: data }
  );
  if (verified.missing)
    return {
      ok: false,
      reason: 'ssh-keygen was not found, so its signature cannot be checked',
    };
  if (!verified.ok) {
    // Who did sign it, if anyone the allowed signers list: to say why.
    const found = keygen([
      '-Y',
      'find-principals',
      '-s',
      sig,
      '-f',
      allowedSignersPath,
    ]);
    const principals = found.ok
      ? found.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
    return {
      ok: false,
      reason:
        principals.length && !principals.includes(who.reviewer)
          ? `it was signed by ${principals.join(', ')}, but it names ${who.reviewer} as the reviewer`
          : principals.length
            ? `its signature does not verify for ${who.reviewer}: the record was changed after it was signed, or the key is no longer allowed to sign it (expired, revoked or for another namespace) (${verified.stderr.split(/\r?\n/)[0] || 'no reason given'})`
            : `its signature does not verify for ${who.reviewer}: the key is not allowed to sign it (not listed, expired, revoked or for another namespace) or the record was changed (${verified.stderr.split(/\r?\n/)[0] || 'no reason given'})`,
    };
  }
  const fingerprint =
    /\b(SHA256:[A-Za-z0-9+/=]+)/.exec(
      `${verified.stdout}\n${verified.stderr}`
    )?.[1] ?? null;
  if (who.declared && fingerprint !== who.declared)
    return {
      ok: false,
      reason: `its signature was made with ${fingerprint ?? 'another key'}, not with the key it names (${who.declared})`,
    };
  return { ok: true, fingerprint };
}
