// Optional signing of gate records (scripts/lib/record-signing.js): with a
// throwaway SSH key made in a temp folder, a decision's record is signed by
// the runner, `npm run verify:trail` checks it against the allowed signers,
// and an edited record, a deleted signature, another signer or another key
// is a problem. With signing off, an unsigned trail stays valid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';

import { runContext } from './helpers/valid-run.js';
import { bindingFor } from '../scripts/lib/approval-binding.js';
import { recordGateDecision } from '../scripts/run-pipeline.js';
import {
  keyFingerprint,
  readAllowedSigners,
  signRecord,
} from '../scripts/lib/record-signing.js';
import { trailSignatures } from '../scripts/lib/trail-signatures.js';

const REPO = process.cwd();
const REVIEWER = 'Ada Reviewer';

/** A throwaway key in its own folder; never the operator's ~/.ssh. */
function makeKey(dir, name, comment = name) {
  const path = join(dir, name);
  const r = spawnSync(
    'ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', path],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return r.status === 0 && existsSync(path) ? path : null;
}

/** Whether this machine's OpenSSH can sign (ssh-keygen -Y, 8.2+). */
function canSign() {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-sign-probe-'));
  try {
    const key = makeKey(dir, 'probe');
    if (!key) return false;
    writeFileSync(join(dir, 'data'), 'x\n');
    return signRecord(join(dir, 'data'), key).ok;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(t) {
  const dir = mkdtempSync(join(REPO, '.tmp-runner-tx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = runContext({ storyId: 'SG-1', runId: 'sg-run-1' });
  writeFileSync(join(dir, 'story.md'), '# SG-1\nThe story.\n');
  writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
  const keys = join(dir, 'keys');
  mkdirSync(keys);
  return { dir, ctx, keys };
}

const decide = (dir, ctx, extra = {}) =>
  recordGateDecision({
    root: dir,
    context: ctx,
    step: 'gate1',
    gateKey: 'requirements_reviewed',
    decision: 'approved',
    reviewer: REVIEWER,
    notes: null,
    openedAt: '2026-11-13T10:00:00.000Z',
    decidedAt: '2026-11-13T10:00:42.000Z',
    bindings: {
      requirements_reviewed: bindingFor('requirements_reviewed', ctx, dir),
    },
    brief: 'BRIEF AS SHOWN',
    ...extra,
  });

const allowed = (dir, entries) => {
  const path = join(dir, 'allowed-signers');
  writeFileSync(
    path,
    entries
      .map(
        ([principal, key]) =>
          `"${principal}" ${readFileSync(`${key}.pub`, 'utf8').trim()}`
      )
      .join('\n') + '\n'
  );
  return path;
};

const verify = (dir, signers, extra = []) =>
  spawnSync(
    execPath,
    [
      join(REPO, 'scripts', 'verify-gate-trail.js'),
      '--root',
      dir,
      '--allowed-signers',
      signers,
      ...extra,
    ],
    { encoding: 'utf8' }
  );

test('the allowed signers: quoted names, comma lists, options before the key', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qaizen-signers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'allowed');
  writeFileSync(
    path,
    [
      '# a comment',
      '"Ada Reviewer" ssh-ed25519 AAAAone ada@laptop',
      'bo,cy namespaces="qaizen-gate-record" ssh-ed25519 AAAAtwo',
      'nokey here',
    ].join('\n')
  );
  assert.deepEqual(readAllowedSigners(path), [
    { principal: 'Ada Reviewer', key: 'ssh-ed25519 AAAAone' },
    { principal: 'bo', key: 'ssh-ed25519 AAAAtwo' },
    { principal: 'cy', key: 'ssh-ed25519 AAAAtwo' },
  ]);
});

test('with signing off, the trail is unsigned and still holds, unless signatures are required', (t) => {
  const { dir, ctx } = run(t);
  const done = decide(dir, ctx, { signingKeyPath: null });
  assert.equal(done.ok, true);
  assert.equal(done.signature, null);
  assert.doesNotMatch(
    readFileSync(join(dir, done.record), 'utf8'),
    /Signing key/
  );
  const signers = join(dir, 'none');
  const r = verify(dir, signers);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /0 record\(s\) signed by their reviewer, 1 unsigned/);
  const strict = verify(dir, signers, ['--require-signatures']);
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /is not signed, and signatures are required/);
});

test('a key that cannot be read stops the decision before anything is recorded', (t) => {
  const { dir, ctx } = run(t);
  const done = decide(dir, ctx, {
    signingKeyPath: join(dir, 'keys', 'missing'),
  });
  assert.equal(done.ok, false);
  assert.match(
    done.message,
    /signing is on \(QAIZEN_SIGNING_KEY\), but the signing key .* does not exist; nothing was recorded/
  );
  assert.equal(existsSync(join(dir, 'gates')), false);
  assert.equal(ctx.gate_decisions, undefined, 'the decision was not applied');
});

test('a signed record verifies; an edit, a deleted signature, another signer or another key does not', async (t) => {
  if (!canSign()) {
    t.skip('ssh-keygen cannot sign here (OpenSSH 8.2 or later is needed)');
    return;
  }
  const { dir, ctx, keys } = run(t);
  const ada = makeKey(keys, 'ada');
  const other = makeKey(keys, 'other');
  assert.ok(ada && other);

  const done = decide(dir, ctx, { signingKeyPath: ada });
  assert.equal(done.ok, true, done.message);
  assert.equal(done.signingError, null);
  assert.ok(existsSync(`${join(dir, done.record)}.sig`));
  const fp = keyFingerprint(ada);
  assert.ok(fp.ok);
  const record = join(dir, done.record);
  const text = readFileSync(record, 'utf8');
  assert.match(
    text,
    new RegExp(
      `\\| Signing key \\| \`${fp.fingerprint.replace(/[+/]/g, '\\$&')}\` \\|`
    )
  );

  const signers = allowed(dir, [[REVIEWER, ada]]);
  const ok = verify(dir, signers, ['--require-signatures']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /signed by Ada Reviewer/);
  // A checkout that converts line endings does not break the signature.
  writeFileSync(record, text.replace(/\n/g, '\r\n'));
  assert.equal(verify(dir, signers).status, 0);

  // Edited after it was signed: the chain and the signature both say so.
  writeFileSync(record, text.replace('BRIEF AS SHOWN', 'ANOTHER BRIEF'));
  const edited = verify(dir, signers);
  assert.equal(edited.status, 1);
  assert.match(edited.stderr, /its signature does not match it/);
  assert.match(
    edited.stderr,
    /was edited after the approved requirements_reviewed decision recorded it/
  );
  writeFileSync(record, text);

  // The record names its key, so a deleted signature shows even when
  // signatures are not required.
  const sig = readFileSync(`${record}.sig`);
  rmSync(`${record}.sig`);
  const deleted = verify(dir, signers);
  assert.equal(deleted.status, 1);
  assert.match(
    deleted.stderr,
    /names the signing key SHA256:.*, but it has no signature/
  );
  writeFileSync(`${record}.sig`, sig);

  // The same key listed under another name: not the reviewer.
  const misnamed = verify(dir, allowed(dir, [['Bo Somebody', ada]]));
  assert.equal(misnamed.status, 1);
  assert.match(
    misnamed.stderr,
    /was signed by Bo Somebody, but it names Ada Reviewer as the reviewer/
  );

  // Signed by hand with another key than the one the record names.
  assert.ok(signRecord(record, other).ok);
  const swapped = verify(
    dir,
    allowed(dir, [
      [REVIEWER, ada],
      [REVIEWER, other],
    ])
  );
  assert.equal(swapped.status, 1);
  assert.match(
    swapped.stderr,
    /its signature was not made with the key it names/
  );

  // Only the reviewer's other key is listed: the named key is not allowed.
  const unlisted = verify(dir, allowed(dir, [[REVIEWER, other]]));
  assert.equal(unlisted.status, 1);
  assert.match(unlisted.stderr, /is not among the allowed signers/);
});

test('the trail signatures report each record, signed or not', async (t) => {
  if (!canSign()) {
    t.skip('ssh-keygen cannot sign here');
    return;
  }
  const { dir, ctx, keys } = run(t);
  const ada = makeKey(keys, 'ada');
  assert.ok(ada);
  decide(dir, ctx, { signingKeyPath: null });
  const second = decide(dir, ctx, {
    signingKeyPath: ada,
    decidedAt: '2026-11-13T10:05:00.000Z',
  });
  assert.equal(second.ok, true);
  const res = trailSignatures(dir, allowed(dir, [[REVIEWER, ada]]));
  assert.deepEqual(res.problems, []);
  assert.equal(res.signed, 1);
  assert.equal(res.unsigned, 1);
});
