# Phase 1 — Retrospective

> **Status:** Phase 1 complete. This file is the prerequisite for starting
> Phase 1.5 per `README.md` section 3 ("Reglas de avance entre fases").
>
> Run that closed Phase 1: STORY-001 (Saucedemo login slice).
> Run ID: `2026-05-28T16-00-00Z-tg13run`.
> Completion date: 2026-05-31.

---

## 1. What worked

### 1.1 The discipline layer

The four-gate rhythm (Requirements → Test Scope → Specs → Code) plus the
schema-validated artifact contracts caught real problems early.

- **Gate 1** was approved quickly because the manual story was clean, but
  the act of writing `context.json.ambiguities = []` forced an honest check
  rather than a glance.
- **Gate 2** surfaced the right conversations: I raised three honest issues
  (TC-003 vs Saucedemo's missing backend; TC-002's exact-copy assertion
  vs Saucedemo specificity; deferral of API execution to Phase 1.5) and
  the project owner triaged each — no silent compromise.
- **Gate 3** caught a real protocol violation: the first Planner run
  produced its spec from text alone because the seed crashed at module
  load when the MCP tried to introspect it without `BASE_URL`. We rejected
  the spec, fixed the seed, and re-ran the Planner with real
  `planner_setup_page` + `browser_snapshot` calls. Without Gate 3 this
  would have shipped silently and the rule from CLAUDE.md §3.8 would have
  been violated invisibly. **This was the single most valuable gate firing
  in Phase 1.**
- **Gate 4** firmed up the locator policy ("most robust wins, not always
  semantic") and strengthened the RISK-001 assertion from "form retains
  values" (weak proxy) to "session-username cookie is absent after a
  failed login" (real signal). Both improvements landed because the human
  reviewer pushed back on agent defaults.

### 1.2 The generic validator

One `scripts/validate-json.js` script + one `scripts/validate-examples.js`
covered every JSON artifact in the pipeline. No per-schema validators
were ever needed. The TG7 self-check tested 19 positive + negative cases
against the 4 schemas and caught real `if/then` rule bugs before they
shipped.

### 1.3 The reqres.in decision

Resolving `docs/ambiguities.md` A3 (Phase 1.5 API target = reqres.in)
at the end of Phase 1 unblocks Phase 1.5 cleanly. No need to re-litigate
when 1.5 starts.

### 1.4 Trust-but-verify on subagent reports

The Playwright Generator subagent reported that its tests "passed when
run via the MCP." I re-ran them myself with `npm run test`. They did
pass — but the discipline of verifying mattered, because the Planner
subagent had reported success on its first run while having silently
skipped the MCP exploration step.

### 1.5 Examples as anchors, not prescriptions

The Phase 1 TG9 expected examples
(`examples/expected/login-success.expected-*.json`) anchored the shape
of the production artifacts without prescribing their content. TG13's
`test-cases/STORY-001.json` closely mirrored the TG9 example because the
story was the same, but the relationship was intentional — the example
is the schema worked-out, not a copy-paste source.

---

## 2. What frictioned

### 2.1 The seed-throws-at-module-load bug

The TG11 seed (`tests/seed.spec.ts`) used `throw new Error('BASE_URL env
var not set')` at the top of the module. This crashed
`planner_setup_page` because the MCP server loaded the file before
Playwright had a chance to wire any env. The first Planner run failed
silently — it produced a spec from text because the MCP probe didn't
work, and we only caught it at Gate 3.

**Fix landed in TG13:** the seed now uses `test.skip(baseURL === '',
'BASE_URL env var not set')` inside the test body. The module loads
cleanly regardless of env state; the test skips (with a clear reason)
when BASE_URL is unset; passes normally when set. Verified with both
`unset BASE_URL; npm run test` (1 skipped, no crash) and
`BASE_URL=https://www.saucedemo.com/ npm run test` (1 passed).

**Cost:** one Planner re-run (~30 extra MCP calls, ~2 minutes). Cheap
relative to discovering the same bug at Phase 1.5 against reqres.in.

**Lesson:** the seed is read by the MCP server, the Playwright runner,
and downstream tooling. Eager module-level guards break the first two.
`test.skip()` with a clear reason is the right idiom.

### 2.2 The `playwright/no-skipped-test` lint warning

Switching to `test.skip()` triggered `playwright/no-skipped-test` (intent:
prevent hidden failures). Our skip is an environmental guard with an
explicit reason — not a hidden failure — but the rule fires on the
keyword regardless.

**Phase 1 resolution:** `// eslint-disable-next-line` comments with a
named reason on each skip. Used in both `tests/seed.spec.ts` and
`tests/STORY-001.spec.ts`.

**Phase 2 / production note:** production runs have known environments
and would not need BASE_URL guards. The project owner confirmed this
during Gate 4 — the skips are a Phase-1 artifact, not a long-term
pattern. Track for removal whenever the env-guard becomes unnecessary.

### 2.3 The locator policy was implicit

The original Gate 4 criterion read "Locators stable and semantic" with
an implicit preference for `getByRole`/`getByLabel`/`getByText` over
CSS. Reality was more nuanced: a `data-test` attribute placed by the
dev team as a deliberate test contract is often **more** robust than a
role-based locator, because it survives even the page's accessibility
tree changing.

**Fix landed in TG13:** `docs/review-gates.md` now has a dedicated
"Locator selection policy" section with a 4-tier preference list
(stable test hooks → semantic roles → stable text → structural CSS as
last resort) and three worked examples. Cross-referenced from
`docs/seed-test-guidelines.md`.

**Future Planner subagent prompts should reference this section
explicitly** so the agent ranks candidates rather than defaulting to
the first semantic match.

### 2.4 `.mcp.json` server-name deviation

The TG3 plan text described an MCP entry called `playwright` running
`@playwright/mcp@latest`. The actual `init-agents` scaffold produces
`playwright-test` running `playwright run-test-mcp-server` — a different
MCP that's the test-runner-aware variant the Native Agents actually
call. Documented in `docs/ambiguities.md` A2.

**Not a Phase 1 problem.** Worth noting for anyone re-reading the
phase plans.

### 2.5 The auto-scaffolded seed stub from TG3

`npx playwright init-agents` writes its own `tests/seed.spec.ts` stub
(no assertion, no BASE_URL handling). This lived in the repo from TG3
until TG11 replaced it, producing a benign `playwright/expect-expect`
lint warning the whole time.

**Lesson:** when scaffolders write into folders we plan to populate,
expect to overwrite their output. The plan TG11 explicitly does this.

### 2.6 `.playwright-mcp/` runtime cache

The `playwright-test` MCP server writes session snapshots and console
logs to `.playwright-mcp/` at the project root. Not in the TG1
gitignore. Caught when prettier started complaining about a YAML
snapshot file.

**Fix landed in TG13:** added `.playwright-mcp/` to both `.gitignore`
and `.prettierignore`.

---

## 3. Locations of generated Native Agent files

Per the TG3 DoD requirement:

- `.claude/agents/playwright-test-planner.md`
- `.claude/agents/playwright-test-generator.md`
- `.claude/agents/playwright-test-healer.md`

Filenames differ from the plan text (which says `planner.md`,
`generator.md`, `healer.md`) — the scaffolder uses the
`playwright-test-` prefix to match the MCP namespace. Documented in
`docs/ambiguities.md` A1.

`.claude/agents/` is currently gitignored (the TG1 `.gitignore` was
copied verbatim from the plan). Whether to keep that or to commit the
agent files is **open question A1** in `docs/ambiguities.md`. The
project owner has not yet decided. Phase 2 is a natural time to
revisit when CI starts depending on the regenerable scaffolding being
present after a fresh clone.

---

## 4. Story-app fit

Saucedemo is a good match for `examples/stories/login-success.md`:

- The story's "Out of scope" section (password reset, MFA, etc.)
  matches what Saucedemo doesn't have.
- The credentials in the story (`standard_user`, `secret_sauce`,
  `locked_out_user`) are exactly Saucedemo's documented test users.
- The post-login URL (`/inventory.html`), the exact error copy ("Epic
  sadface: Username and password do not match any user in this
  service"), and the session-state mechanism (`session-username`
  cookie) all matched the spec the Planner produced from real MCP
  probing.

`examples/stories/checkout-expired-card.md` is NOT a fit for Saucedemo
(Saucedemo's checkout accepts any card data). It remains in
`examples/` as a Jira-mode demonstration for future stories on apps
that do have a real checkout backend.

---

## 5. Recommendations for Phase 1.5

In priority order:

1. **Inject the locator policy into Planner subagent prompts.** The
   current `.claude/agents/playwright-test-planner.md` is a generic
   prompt; each invocation we add a "follow the policy in
   `docs/review-gates.md` § Locator selection policy" line. Track
   whether the next Planner run picks robust locators by default.

2. **Make `mcp__playwright-test__planner_save_plan` carry the
   traceability metadata.** Right now the tool's output schema doesn't
   expose `**Linked TC:**` / `**Linked RISK:**` fields, so we embed
   them as substrings in scenario headings. The Generator can grep
   for them but it's fragile. Worth checking if a newer Playwright
   release lets the Planner attach structured metadata.

3. **The API branch.** Per `docs/ambiguities.md` A3 resolved entry:
   - Set `API_BASE_URL=https://reqres.in/api` in `.env.example` and
     `.env`.
   - Write at least one API-only example story (e.g. `api-create-user-missing-field.md`).
   - Build the API Agent (`agents/api-agent.md`) and confirm TC-003
     can execute against the reqres.in equivalent.

4. **Revisit `.claude/` gitignore (A1).** Phase 2 will need
   reproducible scaffolding for CI. Decide whether to commit
   `.claude/agents/*.md` and `.mcp.json` then.

5. **Add `.playwright-mcp/` to the canonical gitignore list in
   `phase1-foundation-e2e.md` TG1.** Future re-reads of the plan
   should know about this folder upfront.

6. **Consider a "trust but verify" CI step.** Right now the human
   re-runs `npm run test` after each subagent claims tests pass. CI
   doing the same automatically would make Gate 4 cheaper to repeat
   on subsequent runs.

---

## 6. Phase 1 — Definition of Done verification

Per `phase1-foundation-e2e.md` section 0 ("Phase 1 termina cuando una
historia produce..."):

| # | DoD item | Status |
|---|----------|--------|
| 1 | `context.json` validated against schema | ✓ |
| 2 | `test-cases/STORY-001.json` validated | ✓ |
| 3 | `planner-input/STORY-001.planner-brief.md` | ✓ |
| 4 | `specs/` with ≥1 Markdown spec (Planner output) | ✓ — `specs/STORY-001.md` |
| 5 | `tests/` with ≥1 `.spec.ts` (Generator output) | ✓ — `tests/STORY-001.spec.ts` |
| 6 | Quality checks pass (typecheck, lint, format) | ✓ — all 3 clean |
| 7 | `reports/results.json` (Playwright runner) | ✓ — 3 expected, 3 passed |
| 8 | `analysis/failure-analysis.json` validated | ✓ — empty `failures[]` |
| 9 | `release/release-report.md` + `.json` validated | ✓ |
| 10 | All 4 gates marked `true` | ✓ |
| 11 | `PHASE1-RETROSPECTIVE.md` written | ✓ (this file) |

`context.json.status = "completed"`. The traceability chain is closed:

```
STORY-001 → RISK-001/RISK-002 → TC-001/002/003/004 → SPEC-001/002 → PW-001/002
(no FAIL-XXX, no BUG-XXX — three executed tests, three passed)
```

Phase 1 is complete. Phase 1.5 may begin once this retrospective is
reviewed.
