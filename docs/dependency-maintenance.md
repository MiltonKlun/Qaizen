# Dependency maintenance — advisories, exceptions, and their review dates

> Some registry advisories are **accepted, not fixed**. This document records
> which ones, why, what would change the decision, and when it must be looked at
> again. An exception here is **not a claim of safety** — it is a dated decision
> with an owner.

## The rule

1. Run `npm audit` on a **clean install** before concluding anything; a local
   `node_modules` can drift from the lockfile.
2. Prefer a **compatible upgrade within the existing dependency family**.
3. Never run `npm audit fix --force`, never downgrade a runtime tool to satisfy
   the audit, and never add a package purely to evade it. A lower advisory count
   obtained that way is a worse outcome, not a better one.
4. If no compatible fix exists, record an **exception row** below with exposure
   reasoning, the upstream constraint, an owner, and a review date **no more
   than 30 days out**.
5. An exception is open until the human maintainer accepts it. Accepting it is a
   judgement about **exposure**, not a statement that the advisory is wrong.

## Current status — reviewed 2026-09-15

Clean-install audit (`npm ci` in an isolated copy, then `npm audit`):

| Severity  | Count  |
| --------- | ------ |
| critical  | 1      |
| high      | 15     |
| moderate  | 8      |
| **total** | **24** |

**No package change was applied.** Not because the advisories are disputed, but
because no compatible remedy exists — see the analysis below. The audit count is
therefore unchanged, deliberately.

### Why nothing was upgraded

**20 of the 24 advisories reach the tree only through `newman` /
`newman-reporter-htmlextra`**, and npm's only offered remedy for them is
`newman@4.6.1`, which it reports as `isSemVerMajor: true`. Installed Newman is
**6.2.2**, so that "fix" is a two-major **downgrade** of the API test runner.
Newman publishes no 7.x (`majors published: 1,2,3,4,5,6`), and both direct
packages are already at the newest published release:

| Package                     | Installed | Latest published |
| --------------------------- | --------- | ---------------- |
| `newman`                    | 6.2.2     | 6.2.2            |
| `newman-reporter-htmlextra` | 1.23.1    | 1.23.1           |

So the Newman family is **exhausted**: there is nowhere forward to go.

The three advisories npm marks `fixAvailable: true` are not fixable in place
either — the installed versions already sit inside the vulnerable range, and
their parents pin them:

| Package           | Installed | Vulnerable range | Blocked by                                                            |
| ----------------- | --------- | ---------------- | --------------------------------------------------------------------- |
| `brace-expansion` | 5.0.6     | `<5.0.9`         | `eslint@10.10.0` (latest) still wants `^10.2.5` minimatch             |
| `fast-uri`        | 3.1.2     | `<3.1.6`         | `ajv@8.20.0` (latest) pins `fast-uri ^3.0.1`; fix is in 4.1.5 (major) |
| `ip-address`      | 10.2.0    | `<=10.3.0`       | `newman` → `postman-request` → `socks-proxy-agent` → `socks`          |

`npm audit fix` **without** `--force` reports zero changes.

### The critical advisory, specifically

`handlebars` is **critical** (`GHSA-2w6w-674q-4c4q` and related AST
type-confusion / prototype-pollution advisories, vulnerable `>=4.0.0 <=4.7.8`).
Two copies are installed:

- `node_modules/handlebars@4.7.7` — via `newman-reporter-htmlextra`
- `node_modules/postman-runtime/node_modules/handlebars@4.7.8` — via `newman`

The fix is **4.7.9**, but both copies are transitive and pinned by parents that
are already at their latest release, so no in-family upgrade reaches it.

**Exposure reasoning.** The advisories require an attacker to control the
template or the AST passed into compilation. In this repo Handlebars is reached
only through the Newman **htmlextra reporter**, which renders our own collection
run output on the runner. The review that surfaced this did **not** establish an
attack path in Qaizen. Since task group 1.1, the generated HTML report is
**local-only and never published** — CI uploads `reports/published/` alone. That
narrows the blast radius; it does not clear the advisory.

## Open exceptions

| Advisory set                            | Severity            | Exposure reasoning                                                                                                                                                                    | Upstream constraint                                                                                                          | Owner  | Review by  | Status                        |
| --------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ----------------------------- |
| `handlebars` (critical, AST/prototype)  | critical            | Reached only via the htmlextra reporter rendering our own run output. No attacker-controlled template/AST path established. HTML report is local-only and never published (task 1.1). | Fix in 4.7.9; both copies pinned transitively by `newman-reporter-htmlextra@1.23.1` and `newman@6.2.2`, both already latest. | Milton | 2026-10-15 | **Awaiting human acceptance** |
| Newman / Postman family (20 advisories) | 12 high, 8 moderate | Dev-time API test runner, executed against our own collections and a demo endpoint. Not part of any shipped artifact. Members listed below.                                           | Only remedy offered is `newman@4.6.1` — a two-major **downgrade**. No 7.x exists.                                            | Milton | 2026-10-15 | **Awaiting human acceptance** |
| `brace-expansion`, `fast-uri`           | high                | Dev tooling only (`eslint` lint runs, `ajv` schema validation of our own artifacts). Inputs are repo-controlled.                                                                      | Parents at latest still pin the vulnerable ranges; `fast-uri` fix requires a major bump `ajv` does not allow.                | Milton | 2026-10-15 | **Awaiting human acceptance** |
| `ip-address`                            | high                | Reached via Newman's SOCKS proxy agent; the pipeline does not configure a SOCKS proxy.                                                                                                | Transitive under `newman`; same downgrade-only remedy.                                                                       | Milton | 2026-10-15 | **Awaiting human acceptance** |

**All rows are OPEN.** They become accepted only when the maintainer records
acceptance here. Until then this is an unresolved finding, not a cleared one.

### Row membership (so each row can be audited)

A row you cannot enumerate is not reviewable. The 24 advisories map to the rows
above as follows:

**Newman / Postman family — 20** (`newman`, `newman-reporter-htmlextra`,
`@budibase/handlebars-helpers`, `@faker-js/faker`, `csv-parse`, `flatted`,
`httpntlm`, `jose`, `lodash`, `node-forge`, `postman-collection`,
`postman-collection-transformer`, `postman-request`, `postman-runtime`,
`postman-sandbox`, `qs`, `serialised-error`, `underscore`, `uuid`, `uvm`).

`qs` is listed here rather than as its own row: npm marks it `fixAvailable:
true`, but both installed copies (`6.14.2` and `6.5.5`) arrive solely via
`newman` → `postman-request`, so it carries the same downgrade-only remedy as
the rest of the family.

**Dev tooling — 2** (`brace-expansion` via `eslint`, `fast-uri` via `ajv`).

**Own rows — 2** (`handlebars`, `ip-address`).

### What would change these decisions

- Newman publishes a **7.x** (or a 6.x patch) that updates its Postman
  transitives → re-audit and upgrade in-family.
- `newman-reporter-htmlextra` releases a build depending on `handlebars@>=4.7.9`
  → upgrade and drop the critical row.
- `ajv` widens its `fast-uri` range to allow 4.x → upgrade.
- The pipeline starts rendering **third-party or user-supplied** templates
  through Handlebars → exposure reasoning is void; escalate immediately.
- A review date passes → re-audit and re-decide; do not silently roll it forward.

## Re-running this triage

```powershell
# Clean install in a scratch copy, so local drift cannot skew the result
npm ci
npm audit --json > audit.json

# Read counts and per-package remedies (never trust a cached summary)
node -e "const a=require('./audit.json'); console.log(a.metadata.vulnerabilities)"
```

Compare against the table above. If the counts moved, update this document in
the same change — a stale advisory ledger is worse than none.

## Playwright and generated agent prompts

`@playwright/test` is currently **1.60.0**; **1.63.0** is published and is a
minor bump inside the declared `^1.60.0` range. It carries **no advisory** and
was therefore **not** bundled into this security triage — mixing an unrelated
upgrade into a security change makes both harder to review.

When Playwright _is_ upgraded, regenerate the native agent prompts rather than
editing them:

```powershell
npx playwright init-agents --loop=claude
```

`.claude/agents/*.md` are generated and gitignored. **Never hand-edit them**
(`CLAUDE.md` §5).

## References

- `docs/secrets-management.md` — what may be published from a run.
- `docs/security-and-data-safety.md` — the data-safety surface around secrets.
