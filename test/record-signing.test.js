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

/**
 * Whether the signing tests can run; skipped where OpenSSH cannot sign, but
 * a failure in CI, where they must run.
 */
function signingOr(t) {
  if (canSign()) return true;
  assert.ok(
    !process.env.CI,
    'ssh-keygen cannot sign in CI (OpenSSH 8.2 or later is needed)'
  );
  t.skip('ssh-keygen cannot sign here (OpenSSH 8.2 or later is needed)');
  return false;
}

function run(t) {
  const dir = mkdtempSync(join(REPO, '.tmp-runner-tx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = runContext({ storyId: 'SG-1', runId: 'sg-run-1' });
  // A fresh run: no gate approved yet, so every approval has a record.
  for (const gate of Object.keys(ctx.review_gates))
    ctx.review_gates[gate] = {
      status: false,
      reviewer: null,
      reviewed_at: null,
    };
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
  if (!signingOr(t)) return;
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
  assert.match(
    edited.stderr,
    /its signature does not verify for Ada Reviewer: the record was changed after it was signed/
  );
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
    /its signature was made with SHA256:.*, not with the key it names/
  );

  // Only the reviewer's other key is listed: the named key is not allowed.
  assert.ok(signRecord(record, ada).ok);
  const unlisted = verify(dir, allowed(dir, [[REVIEWER, other]]));
  assert.equal(unlisted.status, 1);
  assert.match(
    unlisted.stderr,
    /its signature does not verify for Ada Reviewer: the key is not allowed to sign it/
  );
});

test('the trail signatures report each record, signed or not', async (t) => {
  if (!signingOr(t)) return;
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

test('a signed rejection renamed into an approval, or a record moved into another run, does not pass', async (t) => {
  if (!signingOr(t)) return;
  const { dir, ctx, keys } = run(t);
  const ada = makeKey(keys, 'ada');
  const rejected = decide(dir, ctx, {
    signingKeyPath: ada,
    decision: 'rejected',
    notes: 'not yet',
  });
  assert.equal(rejected.ok, true);
  const signers = allowed(dir, [[REVIEWER, ada]]);
  assert.equal(verify(dir, signers, ['--require-signatures']).status, 0);

  // Rename the record and its signature, and rewrite the decision and the
  // gate as an approval: the signature still matches the (rejection) text.
  const from = join(dir, rejected.record);
  const to = from.replace('-rejected.md', '-approved.md');
  writeFileSync(to, readFileSync(from));
  writeFileSync(`${to}.sig`, readFileSync(`${from}.sig`));
  rmSync(from);
  rmSync(`${from}.sig`);
  const forged = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'));
  const d = forged.gate_decisions.at(-1);
  d.decision = 'approved';
  d.record.path = rejected.record.replace('-rejected.md', '-approved.md');
  forged.review_gates.requirements_reviewed = {
    status: true,
    reviewer: REVIEWER,
    reviewed_at: d.decided_at,
    notes: null,
  };
  writeFileSync(join(dir, 'context.json'), JSON.stringify(forged, null, 2));
  const r = verify(dir, signers, ['--require-signatures']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(
    r.stderr,
    /001-gate1-approved\.md does not match its decision: its name says gate1 approved, its text requirements_reviewed rejected; it records requirements_reviewed rejected, the decision naming it requirements_reviewed approved/
  );

  // The same record carried into another run.
  forged.run_id = 'another-run';
  writeFileSync(join(dir, 'context.json'), JSON.stringify(forged, null, 2));
  assert.match(
    verify(dir, signers).stderr,
    /it is of run sg-run-1, not another-run/
  );
});

test('with signatures required, an approval without a record does not pass', async (t) => {
  const { dir, ctx } = run(t);
  ctx.review_gates.requirements_reviewed = true;
  ctx.gate_decisions = [
    {
      gate: 'requirements_reviewed',
      decision: 'approved',
      decided_at: '2026-11-13T10:00:00.000Z',
      reviewer: REVIEWER,
      notes: null,
    },
  ];
  writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
  const r = verify(dir, join(dir, 'none'), ['--require-signatures']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(
    r.stderr,
    /requirements_reviewed stands approved without a gate record of its approval, and signatures are required/
  );
});

test("the allowed signers' options hold, a key may carry several names, and a brief's line endings do not matter", async (t) => {
  if (!signingOr(t)) return;
  const { dir, ctx, keys } = run(t);
  const ada = makeKey(keys, 'ada');
  const done = decide(dir, ctx, {
    signingKeyPath: ada,
    brief: 'LINE ONE\r\nLINE TWO\r\n',
  });
  assert.equal(done.ok, true);
  assert.doesNotMatch(readFileSync(join(dir, done.record), 'utf8'), /\r/);
  const pub = readFileSync(`${ada}.pub`, 'utf8').trim();
  const write = (line) => {
    const path = join(dir, 'allowed-signers');
    writeFileSync(path, `${line}\n`);
    return path;
  };
  assert.equal(verify(dir, write(`"${REVIEWER}" ${pub}`)).status, 0);
  // Another namespace, or a key retired before the record was signed.
  const other = verify(dir, write(`"${REVIEWER}" namespaces="git" ${pub}`));
  assert.equal(other.status, 1);
  assert.match(other.stderr, /the key is no longer allowed to sign it/);
  const expired = verify(
    dir,
    write(`"${REVIEWER}" valid-before="20200101" ${pub}`)
  );
  assert.equal(expired.status, 1);
  // The same key listed under two names, the reviewer second.
  assert.equal(
    verify(dir, write(`"Bo Somebody,${REVIEWER}" ${pub}`)).status,
    0
  );
});
