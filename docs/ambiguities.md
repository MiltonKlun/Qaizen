# Ambiguities and Open Questions

This file collects ambiguities, conflicts, or open decisions surfaced during the
build of the AI QA pipeline. Each entry includes context, options, and a
`blocking` flag. Items resolved by the project owner are moved to a
`## Resolved` section with the decision.

Per `CLAUDE.md` section 3.7, the agent does NOT invent answers. It writes the
ambiguity here and stops or asks.

---

## Open

### A7 — TestLink MCP bridge unusable; XML-RPC script is the supported path

**Phase:** 2 (TG3/TG4). **Project-owner-approved** (chose "accept script
path; defer the MCP"). **Blocking:** false — TestLink sync works.

**Context:**

- TestLink itself is fully working: clean self-built image
  `ai-qa-testlink:1.9.20` (see `docker/testlink/Dockerfile`), XML-RPC API
  authenticates the key (`tl.checkDevKey` → `boolean 1`), project `AIQA`
  - plan id 2 exist.
- The `dogkeeper886/testlink-mcp` bridge, however, **will not complete its
  MCP handshake in Claude Code**: `/mcp` shows it `Failed` with
  `MCP error -32000: Connection closed`, and the container emits **zero
  diagnostics** (starts, exits 0, no stdout/stderr). Reconnecting repeatedly
  does not help. The failure is in the bridge, not TestLink — proven
  because the same XML-RPC endpoint works perfectly from `scripts/`.
- We spent significant session time on this one transport.

**Decision (project owner, during TG3):** Accept the **script path** as the
supported TestLink integration and **defer the MCP bridge**.
`scripts/sync-to-testlink.js` talks to the TestLink XML-RPC endpoint
directly (built-in `fetch`, no MCP). It is **live-verified**: it created the
4 STORY-002 cases in TestLink (ids 4/10/16/19), reused the story suite
(id 3), and wrote `testlink_id` back into `test-cases/STORY-002.json`
(which still schema-validates).

**How applied:**

- Removed the `testlink` entry from `.mcp.json` (so `/mcp` is clean). The
  exact block is preserved in `docs/testlink-integration.md` §2 for
  restoration if a future image works.
- `scripts/sync-to-testlink.js` is the TestLink adapter's executable path
  (dry-run default; `--apply-testlink` writes). The `skills/syncing-testlink`
  SKILL still documents the MCP-tool path for the day the bridge works, but
  the script is the path that runs today.
- The TG3 "connection verified" DoD is met by the live `tl.checkDevKey` +
  the live case sync, not by the MCP.

**Why it doesn't break the plan:** TG3's intent (TestLink reachable, cases
syncable, results reportable) is satisfied. Only the _transport_ differs
from the plan's assumed MCP. The modular port (A6) is unaffected — the
TestLink adapter simply uses XML-RPC instead of the MCP under the same
port.

**Follow-up (low priority):** if an interactive agent-driven TestLink path
is wanted later, either find/build a working TestLink MCP image or wrap the
script as a small first-party MCP. Not needed for Phase 2.

**Status:** Resolved by decision. TestLink sync live-verified via script.

---

### A6 — Test management built as a modular port, not hardcoded TestLink

**Phase:** 2 (TG2/TG3). **Project-owner-approved** design choice.
**Blocking:** false.

**Context:**

- The literal Phase 2 plan (`phase2-integrations.md` TG3/TG4/TG10)
  hardcodes TestLink as _the_ test-management tool.
- The project owner asked (during TG2) for a modular design so future
  tools (Xray, Qase, others) can be added as new modules without
  modifying TestLink's code or the pipeline core — the SOLID
  Open/Closed Principle.
- README §9 already frames test management as "an adapter, not a
  hardcoded coupling," so this formalizes an intent the architecture
  already had rather than contradicting the plan.

**Decision (project owner, during TG2):** Introduce a stable
`TestManagementAdapter` **port** (`agents/test-management-adapter.md`)
defining three operations — `verifyConnection`, `pushTestCases`,
`pushExecutionResults` — with `test-cases/*.json` as the source of
truth and the tool as a downstream sync target. TestLink is the first
and (for Phase 2) only implemented adapter. **Xray and Qase are
documented as planned future adapters, to be built when they suit the
project** — not speculatively now. Selection is via a
`TEST_MANAGEMENT_TOOL` env var; adding a tool is one dispatcher row +
a new `skills/syncing-<tool>/` adapter + a `config/<tool>-*-map.json`,
with zero edits to existing adapters.

**How applied:**

- `agents/test-management-adapter.md` documents the port + the
  Xray/Qase future-adapter plan.
- `skills/syncing-testlink/` is the TestLink adapter behind the port
  (TG4).
- Field/status mappings are externalized to `config/testlink-*-map.json`
  (no hardcoded mapping — also a Phase 2 non-negotiable rule).

**Why it doesn't break the plan:** TestLink still works exactly as TG3/4
require; the port is an additive wrapper. The DoDs for TG3/TG4/TG10 are
all still met. The only change is that the TestLink-specific logic lives
behind a named interface instead of being the assumed-only path.

**Status:** Approved. TestLink adapter active; Xray/Qase deferred by
design.

---

### A5 — reqres.in now requires an x-api-key header

**Phase:** 1.5 (surfaced during Task Group 9, the API vertical slice).
**Blocking:** was blocking the API branch; resolved by project-owner
decision.

**Context:**

- The Phase 1.5 API branch targets reqres.in (A3). The classic reqres.in
  was keyless: `POST /users` → 201, `POST /register` with a missing
  field → 400.
- Verified live during TG9 (the API Agent's "do not invent endpoint
  shapes" rule, `agents/api-agent.md` §5): **both endpoints now return
  `401 {"error":"missing_api_key"}`** without an `x-api-key` header.
  reqres.in added mandatory free-tier auth on all `/api/*` endpoints.
- The Gate-2-approved STORY-002 API test cases (TC-003 → 201, TC-004 → 400) assumed the old keyless behavior.

**Decision (project owner, during TG9):** Provide a free reqres.in API
key. The Newman environment carries it as `{{api_key}}` (sent as the
`x-api-key` header); it is sourced from `.env` as `REQRES_API_KEY` and
never hardcoded in the committed collection.

**How applied:**

- `.env.example` and `.env` gained a `REQRES_API_KEY` slot.
- The STORY-002 Postman environment sets `api_key` from `REQRES_API_KEY`
  and `base_url` to `https://reqres.in/api`.
- Every request in the collection sends `x-api-key: {{api_key}}`.
- TC-003 / TC-004 keep their 201 / 400 assertions — re-verified against
  the live key before finalizing (the verification is the whole point of
  the do-not-invent rule).

**Why this matters for the retrospective:** this is the canonical example
of why the pipeline forbids generating tests from text alone. The TCs
read plausibly and passed Gate 2, but the live API had changed. Only the
verification step caught it before a fictional collection shipped.

**Follow-up found during execution (Step 14):** Newman records the live
request headers — including the injected `x-api-key` value — into
`reports/newman-results.json` (it appears 3× in the STORY-002 run). The
file is gitignored, so it does not reach the repo. BUT in Phase 2, CI
uploads Newman results as build artifacts, where a leaked key would be
exposed. **Phase 2 follow-up:** scrub auth headers from the Newman JSON
before it becomes a CI artifact (post-process the export, or use a
Newman reporter option / a custom reporter that redacts
`x-api-key` / `Authorization`). Until then, treat
`reports/newman-results.json` as secret-bearing and keep it gitignored.
Also: rotate the reqres + Postman keys that were exposed in the build
session.

**Status:** Resolved by decision. The slice proceeded with the key in
`.env`; the CI-artifact redaction is a tracked Phase 2 follow-up.

---

### A4 — Postman MCP npm package name differs from the plan text

**Phase:** 1.5 (surfaced during Task Group 1).
**Blocking:** false. Resolved by verification against the official source,
per the TG1 instruction to confirm the package name.

**Context:**

- `phase1.5-api-branch.md` TG1 names the package `@postman/mcp-server` and
  `README.md` §1.2 names `postmanlabs/postman-mcp-server`. TG1 explicitly
  says to verify the name since "el nombre puede haber cambiado."
- `@postman/mcp-server` returns **404** on npm — it does not exist.
- `postman-mcp-server` (unscoped) exists at v1.2.0 but is published by a
  **third party** (`npmcrafter` / `ankit-roy-0602`), NOT Postman. Using it
  would violate CLAUDE.md §4 ("use the official version, do not rewrite")
  and §9 (no unofficial MCP when an official one exists).
- The **official** package, confirmed at
  `github.com/postmanlabs/postman-mcp-server`, is
  **`@postman/postman-mcp-server`** (currently v2.8.9). It offers a local
  STDIO mode (`npx @postman/postman-mcp-server --full`, needs
  `POSTMAN_API_KEY`) and a remote hosted mode (`https://mcp.postman.com`).

**Decision:** Use `@postman/postman-mcp-server` (the official scoped
package) in local STDIO mode. This is the closest match to the plan's
intent (official Postman MCP) even though the exact string differs from
the plan text. The third-party unscoped package is explicitly rejected.

**How applied:** `.mcp.json` `postman` entry runs
`npx @postman/postman-mcp-server --full` with `POSTMAN_API_KEY` from env.
Documented in `docs/postman-integration.md`.

**Status:** Resolved by verification. Not blocking.

---

### A1 — Should `.claude/agents/*.md` and `.mcp.json` be versioned in git?

**Phase:** 1 (surfaced during Task Group 3).
**Blocking:** false. TG3 DoD is satisfied either way (files exist on disk).
**Context:**

- TG1 specified `.gitignore` includes `.claude/`. That entry was copied verbatim
  from the phase plan.
- TG3 ran `npx playwright init-agents --loop=claude`, which created
  `.claude/agents/playwright-test-planner.md`, `playwright-test-generator.md`,
  `playwright-test-healer.md`, and (at repo root) `.mcp.json`.
- The three agent files are currently gitignored. `.mcp.json` is tracked.
- TG3 itself says these files are "scaffolding regenerable" — so reproducing
  them from a fresh clone is just one command.

**Options:**

- **A. Keep `.claude/` ignored as written.** Contributors run
  `npx playwright init-agents --loop=claude` after cloning. Pro: matches the
  literal TG1 instruction; protects per-user Claude state files that may also
  live under `.claude/`. Con: any local edits to the agent prompts are not
  version-controlled.
- **B. Narrow the ignore to per-user files** (e.g. `.claude/settings*.local.json`,
  `.claude/cache/`) and commit `.claude/agents/*.md`. Pro: agent prompts are
  versioned, reproducible across machines, reviewable in PRs. Con: deviates
  from the literal TG1 `.gitignore` content.

**Recommendation:** B, because the agent prompt content is part of the
pipeline contract and benefits from PR review — but this is a project-owner
decision. Logged for the Phase 1 retrospective.

**Status:** Open.

---

### A2 — `.mcp.json` server name and binary differ from TG3's text

**Phase:** 1 (surfaced during Task Group 3).
**Blocking:** false.
**Context:**

- TG3 describes the MCP entry as `"playwright": { command: "npx", args: ["@playwright/mcp@latest"] }` (the standalone `microsoft/playwright-mcp` server).
- The actual `npx playwright init-agents --loop=claude` (Playwright 1.60)
  produced an entry named `"playwright-test"` running
  `npx playwright run-test-mcp-server` — the test-runner-aware MCP that ships
  inside `@playwright/test` itself.
- These are different MCPs: `run-test-mcp-server` is the one the Native Agents
  are actually wired to (their tool list uses the `mcp__playwright-test__*`
  prefix). The standalone `@playwright/mcp` is for general browser automation
  outside the Playwright test runner.
- TG3 anticipates filename/scaffold differences and instructs to document
  rather than fail.

**Decision so far:** Keep the scaffold as generated. The TG4 merge of the
Atlassian MCP into `.mcp.json` will add a second entry alongside
`playwright-test`, not replace it.

**Status:** Documented. Not blocking.

---

## Resolved

### A3 — Saucedemo has no real backend API; Phase 1.5 needs a target

**Phase:** 1 (surfaced during Task Group 12). **Resolved at the end of
Task Group 12** by the project owner.

**Context:**

- Phase 1 TG12 chose Saucedemo (`https://www.saucedemo.com/`) as the
  application under test. Saucedemo is a public demo SPA: pure
  client-side React, credentials hardcoded in the bundle, cart state
  in localStorage, no auth or order endpoints to call.
- The Phase 1 TG9 test-cases example
  (`examples/expected/login-success.expected-test-cases.json`)
  includes one TC marked `automate_api` — TC-003, locked-account
  rejection at the auth boundary. Phase 1 records `automate_api`
  cases without executing them, so this is fine for Phase 1; Phase 1.5
  builds the API branch and needed a real API target.

**Decision (project owner, 2026-05-28):** Option A — point the
Phase 1.5 API branch at `https://reqres.in/`. Saucedemo remains the
E2E target unchanged.

**How to apply:**

- Phase 1.5 TG1 sets `API_BASE_URL=https://reqres.in/api` in
  `.env.example` (and the local `.env`), alongside the existing
  `BASE_URL=https://www.saucedemo.com/` for E2E.
- Phase 1.5 TG8 adds at least one API-only example story in
  `examples/stories/` against reqres.in endpoints
  (e.g. `api-list-users.md`, `api-create-user-missing-field.md`),
  with matching `examples/expected/*.expected-test-cases.json` and
  `examples/expected/*.expected-collection.json` once the
  postman-collection schema lands.
- Phase 1.5 TG9 runs the API vertical slice against reqres.in.
- The Phase 1 Saucedemo flow is NOT changed by this decision. The
  TC-003 (`automate_api` locked-account check in
  `examples/expected/login-success.expected-test-cases.json`)
  stays as-is — it's an example of the Automation Decision Model
  applied correctly, even though Saucedemo cannot execute it. The
  Phase 1.5 API stories are separate.

**Why reqres.in over fakestoreapi.com / httpbin.org:**

- reqres.in supports a wider HTTP method surface (GET / POST / PUT /
  PATCH / DELETE) with deterministic, well-documented behaviour
  including intentional failure modes (e.g. `POST /register` with a
  missing field returns 400 with a specific error body). That makes
  it a better demo target for testing negative cases — and the
  Automation Decision Model treats negative API cases as a primary
  use of `automate_api`.

**Status:** Resolved. Acted on in Phase 1.5.
