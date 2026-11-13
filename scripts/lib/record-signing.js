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
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  `ssh-keygen -Y sign -f ${keyPath} -n ${NAMESPACE} ${record}`;

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
 * What a record's signature shows: who signed it, checked against the
 * allowed signers and, when the record names its signing key, against that
 * key only. The record is compared with its line endings normalized, as it
 * was written, so a checkout that converts them does not break the
 * signature.
 * @param {string} recordPath
 * @param {string} allowedSignersPath
 * @param {string | null} [declared] the key fingerprint the record names
 * @returns {{ ok: true, principal: string } | { ok: false, reason: string }}
 */
export function verifyRecord(recordPath, allowedSignersPath, declared = null) {
  const sig = `${recordPath}.sig`;
  if (!existsSync(sig)) return { ok: false, reason: 'it has no signature' };
  if (!existsSync(allowedSignersPath))
    return {
      ok: false,
      reason: `there is no allowed signers file (${allowedSignersPath}) to check its signature against`,
    };
  let signers = readAllowedSigners(allowedSignersPath);
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-signers-'));
  try {
    if (declared) {
      signers = signers.filter((s) => {
        const pub = join(dir, 'key.pub');
        writeFileSync(pub, `${s.key}\n`);
        const fp = keyFingerprint(pub);
        return fp.ok && fp.fingerprint === declared;
      });
      if (!signers.length)
        return {
          ok: false,
          reason: `the key it names (${declared}) is not among the allowed signers`,
        };
    }
    const allowed = join(dir, 'allowed_signers');
    writeFileSync(
      allowed,
      signers.map((s) => `"${s.principal}" ${s.key}`).join('\n') + '\n'
    );
    const found = keygen(['-Y', 'find-principals', '-s', sig, '-f', allowed]);
    const principal = found.stdout.split(/\r?\n/)[0]?.trim();
    if (!found.ok || !principal)
      return {
        ok: false,
        reason: found.missing
          ? 'ssh-keygen was not found, so its signature cannot be checked'
          : declared
            ? `its signature was not made with the key it names (${declared})`
            : 'its signature was made by a key the allowed signers do not list',
      };
    const data = readFileSync(recordPath, 'utf8').replace(/\r\n/g, '\n');
    const verified = keygen(
      [
        '-Y',
        'verify',
        '-f',
        allowed,
        '-I',
        principal,
        '-n',
        NAMESPACE,
        '-s',
        sig,
      ],
      { input: data }
    );
    if (!verified.ok)
      return {
        ok: false,
        reason: `its signature does not match it (it was changed after it was signed)`,
      };
    return { ok: true, principal };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
