# Signed gate records (optional)

Every gate decision leaves a record under `gates/`, chained to the one before
it and named by digest in `context.json` (`docs/pipeline-runner.md` §5). That
shows when the trail was changed after the fact. It does not show who made a
decision: anyone with the checkout can write a record. An operator can sign
their records with their own SSH key, and the team can check every signature.

**A signature shows which key approved a record. It does not show how
carefully the reviewer read what they approved.** It adds identity to the
trail, not attention.

## Turning it on

Set `QAIZEN_SIGNING_KEY` in your shell to an SSH key, before running the
pipeline:

```powershell
$env:QAIZEN_SIGNING_KEY = "$HOME\.ssh\id_ed25519"
npm run pipeline -- --resume
```

It can be a private key, or the public key of one held by `ssh-agent`. A key
with a passphrase asks for it at the terminal when a record is signed.
OpenSSH 8.2 or later is needed (`ssh-keygen -Y`). Signing is per operator: it
is not a setting of the repository, and an operator who does not set it
records unsigned decisions, as before.

With it set, each gate decision:

1. names the key in its record (`| Signing key | SHA256:… |`), so a
   signature that goes missing later shows;
2. is signed once its record is written, with `ssh-keygen -Y sign` in the
   namespace `qaizen-gate-record`; the signature is kept beside the record
   (`gates/NNN-<gate>-<decision>.md.sig`) and archived with it.

A key that cannot be read stops the decision before anything is recorded. If
signing fails after the record is written, the decision stands, the runner
says so and prints the command that signs the record by hand; until it is
signed, the trail check reports it.

## Checking a trail

The team lists who may sign in `config/allowed-signers`, in the format
`ssh-keygen` documents (`ALLOWED SIGNERS` in its manual): one line per
person, the name in double quotes when it holds a space, then the public key.
The name must be the one the reviewer decides as (`QAIZEN_REVIEWER`, else
`git config user.name`). The file is read as written, so its options hold:
`namespaces="qaizen-gate-record"` limits a key to gate records, and
`valid-before="YYYYMMDD"` retires a rotated key while the records it signed
before that date stay valid. Removing a key's line instead makes every record
it signed fail.

```text
"Ada Reviewer" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... ada@laptop
```

```bash
npm run verify:trail                         # the current run
npm run verify:trail -- --root runs/<story>/<run>
npm run verify:trail -- --require-signatures # an unsigned record is a problem
npm run verify:trail -- --allowed-signers <file>
```

It checks the chain (the trail check of `--history`), that each record says
what its file name and its decision say (gate, decision, run, reviewer, and
the digest the gate stands approved on), and each record's signature. A
problem is reported, and the command exits 1, when:

- a signed record no longer matches its signature (it was edited);
- a record was moved under another name, or into another run or decision
  (a signed rejection renamed into an approval, for instance);
- a record names a signing key but has no signature, or one made with
  another key;
- the key that signed it is not allowed to sign it for its reviewer (not
  listed under that name, expired, for another namespace, or listed in a
  revocation file given with `--revoked <file>`);
- with `--require-signatures`, a record is unsigned, or a gate stands
  approved without a validly signed record of that approval.

Line endings converted by a checkout do not break a signature: the record is
checked as it was written. Records from before signing, and records of
operators who do not sign, are valid unless signatures are required.

## What it does not do

- It does not decide or approve anything; the gates stay with people
  (`CLAUDE.md` §3.5).
- It does not make `context.json` or `gates/` tamper-proof: someone who can
  rewrite both, and sign with an allowed key, can still write a consistent
  trail. It makes that the act of a named key holder.
- It trusts `config/allowed-signers`, which anyone with the checkout can
  edit: someone who adds their own key under a reviewer's name can sign as
  that reviewer. Protect the file like code (changes reviewed, CODEOWNERS or
  branch protection), or check against a copy from a source you trust with
  `--allowed-signers <file>`.
- It does not manage keys: adding, rotating and removing people in
  `config/allowed-signers` is the team's.
