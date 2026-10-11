# Runtime Contracts

What the pipeline's shared code guarantees, where decisions are made versus
where files are touched, and the three different things "it passed" can mean.
Ownership of each artifact is in `docs/artifact-boundaries.md`.

---

## 1. Pure decisions, I/O at the edge

The modules that decide something take values and return values: no file
system, no network, no clock, no process state. The code around them gathers
the facts, calls them, and writes the result. This is what lets every rule be
tested directly against real captured inputs, and what stops a decision from
depending on whatever happens to be on disk.

The runner is the clearest case. `scripts/run-pipeline.js` reads the run's
artifacts and checks each one (`gatherHints`: exists, parses, validates,
belongs to this run, is not stale), then hands those facts to
`nextStep(context, hints)` in `scripts/pipeline-state.js`. The state machine
never opens a file, and nothing outside it decides the next step. A step that
"succeeds" without changing what the state machine sees is stopped by the
progress guard rather than repeated.

**Pure** (decide; no I/O): `pipeline-state.js`, `healer-guardrails.js`,
`gate-briefs.js` (rendering), `track-floor.js`, `red-domains.js`, and in
`scripts/lib/`: `classify-failure`, `execution-results`, `build-ledger`,
`report-sanitization`, `test-source`, `locator-source`, `prompt-stability`,
`run-metrics`, `selector-probes` (`survivalResult`), `schema-contracts`,
`case-decisions`.

**I/O** (read, write, run, call out): `artifact-io`, `execution-ledger`
(`readLedger`), `execution-paths`, `run-artifacts`, `approval-binding`
(digests of reviewed files), `gate-records`, `gate-history`,
`gate-checkpoints`, `run-lifecycle`, `integration-io`,
`healer-candidate`, `cli`, and the scripts that use them.

---

## 2. Shared module contracts

What a caller can rely on. Each module's header comment gives the reasoning;
its tests demonstrate the behavior.

| Module (`scripts/lib/`)                              | Contract                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifact-io`                                        | One AJV configuration for the whole pipeline. Reads return the data or a failure whose `kind` says what went wrong (missing, malformed, schema-invalid, wrong identity, path escape), never "invalid" for a missing file. `writeJsonAtomic` validates in memory first and writes through a temporary file and a rename, so a rejected value never touches the destination; with `root`, a path outside it is refused. |
| `execution-ledger`                                   | The ledger's outcome vocabulary, and a reader that checks what the schema cannot: totals equal the counted units, case outcomes match their units, and the ledger belongs to the expected story and run. `approvedScopeDigest` fingerprints the approved test cases.                                                                                                                                                  |
| `execution-results`                                  | Playwright and Newman reports become ledger units. A timed-out attempt is never dropped, a transport failure is a blocked request rather than a failed assertion, error excerpts are redacted and truncated, and no domain id is invented.                                                                                                                                                                            |
| `build-ledger`                                       | Every total is derived from the units. Domain links come only from exact ids in the report or a declared mapping; when they disagree the link stays null with the reason.                                                                                                                                                                                                                                             |
| `classify-failure`                                   | A unit in; a classification, severity and stated reason out. A wrong business value is Red; Green, the only severity a repair can follow, needs positive evidence of a locator failure and no Red domain.                                                                                                                                                                                                             |
| `report-sanitization`                                | The published Newman view is built from an allowlist, and `assertNoSecrets` throws if an injected value survives in any encoding, so nothing is published.                                                                                                                                                                                                                                                            |
| `execution-paths`                                    | Reports live under `reports/<execution-id>/`, one file per collection; story, collection and execution ids are checked as safe path components.                                                                                                                                                                                                                                                                       |
| `approval-binding`                                   | Each gate's digest covers exactly the inputs it reviewed. A gate is pending, current, stale (an input changed) or legacy (approved without a digest); only current counts.                                                                                                                                                                                                                                            |
| `gate-records`                                       | Each gate decision leaves one numbered record and a copy of every file it reviewed, inside the run. Files outside the run and repository files (the lockfile) keep only their digest. The files are read before the decision is saved, so the copy is what was reviewed. A record never decides or changes a gate.                                                                                                    |
| `case-decisions`                                     | Only `draft` cases are asked about, and a set of decisions is applied only when every draft has one; a partial set changes nothing.                                                                                                                                                                                                                                                                                   |
| `gate-checkpoints`                                   | Going back to a gate only moves the run backwards. Reopening returns the gate and every approval that depends on it to pending, with the reviewer's reason in `gate_invalidations[]`, and invents no decision. Restoring puts back the files that differ from the latest approved copy and never records, withdraws or changes an approval.                                                                           |
| `gate-history`                                       | Reads the gate trail and never writes: every decision and return to pending in time order, and a gate's reviewed files now against the copy kept by its latest approval (changed lines by `git diff --no-index`).                                                                                                                                                                                                     |
| `run-artifacts`                                      | "Produced" means the file exists, parses, validates against its schema and belongs to this run; for execution evidence, also that it is newer than the code and approval it covers.                                                                                                                                                                                                                                   |
| `run-lifecycle`                                      | Root artifacts are attributed to the run or the transition stops. An archive is a digest-verified copy, and a failed archive leaves the root untouched. An interrupted new-story transition rolls back before anything moved, or forward once the archive is verified.                                                                                                                                                |
| `integration-io`                                     | Before each remote create, the intent is saved; an unknown outcome stays pending until reconciled by its marker, so a retry never creates twice. One lock per target. Diagnostics are sanitized.                                                                                                                                                                                                                      |
| `healer-candidate`                                   | Resolves the one ledger unit a Green failure belongs to and re-runs a candidate in an isolated copy; the live suite is never written.                                                                                                                                                                                                                                                                                 |
| `test-source`, `locator-source`                      | Test files are parsed with the TypeScript compiler; source that does not parse is rejected, never pattern-matched.                                                                                                                                                                                                                                                                                                    |
| `selector-probes`, `prompt-stability`, `run-metrics` | Measurement rules: a value that cannot be measured is null with its reason, never estimated.                                                                                                                                                                                                                                                                                                                          |
| `cli`                                                | The documented `.env` subset (the process environment wins) and strict argument parsing: unknown, repeated, conflicting or missing options are errors.                                                                                                                                                                                                                                                                |
| `schema-contracts`                                   | The per-schema contract: producers, consumers, docs, examples and migration (`docs/artifact-boundaries.md` §3).                                                                                                                                                                                                                                                                                                       |

---

## 3. Three claims, never one

The pipeline makes three different kinds of claim. They are recorded in
different places, and no output lets one stand in for another.

| Claim                        | What it means                                                                                                                                                                               | Where it is made                                                                                                                     | What it does not mean                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **Static check eligibility** | The source, inspected without running it, breaks no rule: a candidate patch changes only an allowed locator literal; a test file has no hard waits or suppression; a spec covers its risks. | `healer-guardrails.js` ("eligible under static checks"), `gate4-scan.js` findings, the Spec Reviewer's `auto_approval_eligible` hint | That the test passes, or that anyone approved it. Equal structure does not prove a new selector targets the same element. |
| **Executed test outcome**    | A runner executed the test and reported this result.                                                                                                                                        | Ledger units and totals, the Healer's `validated` outcome (the failing test passed with the candidate, in isolation), the CI summary | That the behavior is correct for the business, or that the result was reviewed. Zero executed tests is not a pass.        |
| **Human approval**           | A person decided at a gate, and the decision is bound to the digest of what they reviewed.                                                                                                  | `context.json` gate values, recorded only by the runner from an interactive session                                                  | Anything automatic. No check, outcome or report records an approval.                                                      |

So a Healer record says "evidence, not an approval"; the Gate 4 scan says it
"never approves"; "Pipeline complete" is not "release passed"; and an
eligible static check still needs its re-run and its human review.

**What the interactive check is, and is not.** The runner refuses gate
decisions when stdin is not a terminal, so CI and agents have no approval
path. That protects ordinary non-interactive use; it is not authentication,
and anyone who can edit `context.json` can edit a gate. The digest binding
makes such an edit visible (an approval that no longer matches its inputs is
returned to pending), but the rule that agents and CI never approve is a rule
of conduct as well as a mechanism (`CLAUDE.md` §3.5).
