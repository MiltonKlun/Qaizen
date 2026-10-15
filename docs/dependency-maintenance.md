# Dependency maintenance — advisories, exceptions, and their review dates

> Some registry advisories are **accepted, not fixed**. This document records
> which ones, why, what would change the decision, and when it must be looked at
> again. An exception here is **not a claim of safety** — it is a dated decision
> with an owner.

## The rule

1. Run `npm audit` on a **clean install** before concluding anything; a local
   `node_modules` can drift from the lockfile.
2. Prefer a **compatible upgrade within the existing dependency family**. When
   a transitive package is pinned by a parent that is already at its latest
   release, an npm **`overrides`** entry may lift it — but only to a release in
   the **same major version**, only with the affected tool exercised before the
   change merges, and each override is removed once the parent ships the fix
   itself (see [Overrides](#overrides)).
3. Never run `npm audit fix --force`, never downgrade a runtime tool to satisfy
   the audit, never override across a major version, and never add a package
   purely to evade it. A lower advisory count obtained that way is a worse
   outcome, not a better one.
4. If no compatible fix exists, record an **exception row** below with exposure
   reasoning, the upstream constraint, an owner, and a review date **no more
   than 30 days out**.
5. An exception is open until the human maintainer accepts it. Accepting it is a
   judgement about **exposure**, not a statement that the advisory is wrong.

## Current status — reviewed 2026-10-15

Clean-install audit (`npm ci` in an isolated copy, then `npm audit`):

| Severity  | Before (10-15) | After this review |
| --------- | -------------- | ----------------- |
| critical  | 1              | **0**             |
| high      | 18             | 9                 |
| moderate  | 7              | 5                 |
| **total** | **26**         | **14**            |

The count had risen from 24 (10-01) to 26 because new advisories were
published, not because anything was added: two new **critical** `handlebars`
advisories (`GHSA-8r5x-fm3f-whwj`, `GHSA-p8wg-vrv2-v86f`) reach `<=4.7.9`, so
the release the last review waited for no longer clears them — only `4.7.10`
does.

Two changes were applied:

**1. In-range lockfile updates (−3).** Three packages now have fixed releases
inside the ranges their parents already accept, so a targeted
`npm update brace-expansion fast-uri ip-address` reaches them with no
`package.json` change. The previous review recorded `fast-uri` as needing a
major bump; a fixed 3.x has since been published.

| Package           | Was    | Now    | Parent                                                       |
| ----------------- | ------ | ------ | ------------------------------------------------------------ |
| `brace-expansion` | 5.0.6  | 5.0.12 | `eslint` → `minimatch`                                       |
| `fast-uri`        | 3.1.2  | 3.1.8  | `ajv`                                                        |
| `ip-address`      | 10.2.0 | 10.7.4 | `newman` → `postman-request` → `socks-proxy-agent` → `socks` |

A plain `npm update` was **not** used: it would also have raised
`@playwright/test` and `eslint`, unrelated upgrades that do not belong in a
security change.

**2. Same-major overrides for the Newman family (−9, including the critical).**
`newman@6.2.3` (published 2026-10-09) still pins `postman-runtime@7.39.1`, and
`newman-reporter-htmlextra@1.23.1` is still the latest, so neither parent
reaches the fixes. `package.json` `overrides` lifts them:

### Overrides

| Package      | Was            | Override | Reached through                                    | Remove when                                                   |
| ------------ | -------------- | -------- | -------------------------------------------------- | ------------------------------------------------------------- |
| `handlebars` | 4.7.7 / 4.7.8  | 4.7.10   | `newman-reporter-htmlextra`, `postman-runtime`     | both parents depend on `>=4.7.10`                             |
| `lodash`     | 4.17.21        | 4.18.1   | `newman`, `postman-*`, `newman-reporter-htmlextra` | the Newman family depends on `>=4.18.1`                       |
| `underscore` | 1.12.1         | 1.13.8   | `postman-runtime` → `httpntlm`                     | `httpntlm` / `postman-runtime` move past the vulnerable range |
| `flatted`    | 3.2.6          | 3.4.4    | `postman-sandbox` → `uvm`                          | `uvm` depends on `>=3.4.2`                                    |
| `jose`       | 4.14.4         | 4.15.9   | `postman-runtime`                                  | `postman-runtime` depends on `>=4.15.5`                       |
| `qs`         | 6.5.5 / 6.14.2 | 6.16.1   | `postman-request` (two copies)                     | `postman-request` depends on `>=6.16.0`                       |
| `node-forge` | 1.3.1          | 1.4.0    | `postman-runtime`                                  | `postman-runtime` depends on `>=1.4.0` (see the open row)     |

Every override stays within the major version its parent asks for. Because an
override puts a parent on a release it was not published against, the affected
tool was exercised before merging: a Newman run with the `cli`, `json` and
`htmlextra` reporters against a local server executed both requests, the test
scripts (including `lodash` inside the sandbox), variable passing between
requests, and a deliberate assertion failure, which Newman reported; the JSON
report counted it and the HTML report rendered every test. The repo test
suite and CI's Newman job run on the change as well.

Re-check this table at every review: `npm view newman dependencies` and
`npm view newman-reporter-htmlextra dependencies` show whether a parent has
caught up, and an override that is no longer needed is deleted.

## Added since the last review

| Package                | Version | Kind                 | License | Advisories when added | Why                                                                                               |
| ---------------------- | ------- | -------------------- | ------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| `@axe-core/playwright` | 4.13.0  | dev (and `axe-core`) | MPL-2.0 | none                  | Accessibility checks in Playwright tests (`tests/fixtures/accessibility.ts`); approved 2026-10-15 |

## Open exceptions

The 14 remaining advisories come from **five** packages that carry an advisory
of their own; the other nine entries are their parents, which npm flags
because they contain them. None has a compatible fix: two have **no fixed
release at all**, three need a **major** version their parent does not allow.

| Advisory                                  | Severity | Installed             | Why it is not fixed                                                                                     | Exposure reasoning                                                                                                                    | Owner  | Review by  | Status                        |
| ----------------------------------------- | -------- | --------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ----------------------------- |
| `node-forge` (`GHSA-86w9-cpqp-85rv`)      | high     | 1.4.0 (override)      | **No fixed release**: affected `<=1.4.0`, and 1.4.0 is the latest.                                      | RSA PKCS#1 v1.5 signature verification. `postman-runtime` loads forge only for its ASAP auth type; no collection here uses ASAP auth. | Milton | 2026-11-14 | **Awaiting human acceptance** |
| `braces` (`GHSA-vfj7-8cjw-p6xm`)          | high     | 3.0.3                 | **No fixed release**: affected `<=3.0.3`, and 3.0.3 is the latest.                                      | Stack exhaustion on deeply nested glob patterns. Reached only via the htmlextra reporter's helper library on our own report data.     | Milton | 2026-11-14 | **Awaiting human acceptance** |
| `@faker-js/faker` (`GHSA-qxc2-j82w-r537`) | high     | 5.5.3                 | Fixed only in a later major (10.x); `postman-collection` pins 5.x for `{{$random…}}` dynamic variables. | `helpers.fake` on attacker-supplied templates. Our collections are repo-authored and reviewed at Gate 3.                              | Milton | 2026-11-14 | **Awaiting human acceptance** |
| `csv-parse` (`GHSA-8cw4-87c7-c6xx`)       | moderate | 4.16.3                | Fixed only in 7.x; `newman` pins 4.x for `-d` data files.                                               | Prototype replacement via the `columns` path. The pipeline passes no CSV data files to Newman.                                        | Milton | 2026-11-14 | **Awaiting human acceptance** |
| `uuid` (`GHSA-w5hq-g745-h8pq`)            | moderate | 3.4.0 / 8.3.2 / 9.0.1 | Fixed only in 11.x; the Postman packages pin older majors.                                              | Missing bounds check only when a caller passes its own `buf` to v3/v5/v6; the Postman packages generate ids without one.              | Milton | 2026-11-14 | **Awaiting human acceptance** |

Newman only runs at dev time and in CI, against our own collections and our own
endpoints; nothing it touches is shipped, and the HTML report is local-only and
never published (task group 1.1). That narrows the blast radius of every row
above; it does not clear any of them.

**All rows are OPEN.** They become accepted only when the maintainer records
acceptance here. Until then this is an unresolved finding, not a cleared one.

### Row membership (so each row can be audited)

A row you cannot enumerate is not reviewable. The 14 audit entries map to the
rows above as follows:

- **Carry an advisory — 5:** `node-forge`, `braces`, `@faker-js/faker`,
  `csv-parse`, `uuid`.
- **Flagged through them — 9:** `micromatch` (via `braces`),
  `@budibase/handlebars-helpers` (via `micromatch`, `uuid`),
  `newman-reporter-htmlextra`, `newman`, `postman-collection`,
  `postman-request`, `postman-runtime`, `postman-sandbox`, `serialised-error`.

### What would change these decisions

- `node-forge` or `braces` publishes a fixed release → add or update an override
  (same major) and drop the row.
- Newman publishes a release whose Postman packages move to the fixed majors of
  `@faker-js/faker`, `csv-parse` or `uuid` → upgrade in-family and drop those
  rows, and remove any override the new release makes unnecessary.
- The pipeline starts passing CSV data files to Newman, or running collections
  that are not repo-authored → the `csv-parse` and `@faker-js/faker` exposure
  reasoning is void; escalate immediately.
- The htmlextra reporter is dropped → `braces`, `micromatch` and
  `@budibase/handlebars-helpers` leave the tree.
- A review date passes → re-audit and re-decide; do not silently roll it forward.

## History

- **2026-09-15** — first triage: 24 advisories, four exception rows opened, no
  package change (the Newman family exhausted, `npm audit fix` without
  `--force` changes nothing).
- **2026-10-01** — a new moderate `moment` advisory (via
  `newman-reporter-htmlextra` → `moment-timezone`) fixed by a compatible in-range
  lockfile update to `2.31.0`; back to 24, exception rows unchanged.
- **2026-10-15** — 26 → 14: in-range updates for three packages and same-major
  overrides for seven, including the critical `handlebars`; the previous rows
  replaced by the five above.

## Re-running this triage

```powershell
# Clean install in a scratch copy, so local drift cannot skew the result
npm ci
npm audit --json > audit.json

# Read counts and per-package remedies (never trust a cached summary)
node -e "const a=require('./audit.json'); console.log(a.metadata.vulnerabilities)"

# Has a parent caught up? Compare against the Overrides table
npm view newman dependencies
npm view newman-reporter-htmlextra dependencies
```

Compare against the tables above. If the counts moved, update this document in
the same change — a stale advisory ledger is worse than none.

## Playwright and generated agent prompts

`@playwright/test` is currently **1.60.0**; newer minors inside the declared
`^1.60.0` range are published (1.64.1 at this review). They carry **no
advisory** and were therefore **not** bundled into this security triage —
mixing an unrelated upgrade into a security change makes both harder to review.

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
