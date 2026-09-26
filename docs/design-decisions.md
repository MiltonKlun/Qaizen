# Design decisions

Architecture decision records for choices that are not obvious from the code:
where the implementation departs from the first design, or where an external
tool behaved differently than documented. Each record gives the context, the
decision, and its consequences.

Records are referenced by ID (`D1`–`D7`) from the docs and agent prompts that
depend on them.

## How records are added

The pipeline never invents an answer to an open question (`CLAUDE.md` §3.7).
Ambiguities about a specific story go into that story's
`context.json.ambiguities`. A project-level question found before any story
context exists is recorded here as **Proposed**, with a `blocking` flag, and
work that depends on it stops until the maintainer decides. Once decided, the
record moves to **Accepted** and states the decision.

| ID  | Decision                                                          | Status   |
| --- | ----------------------------------------------------------------- | -------- |
| D1  | Playwright agent definitions are regenerated, not versioned       | Accepted |
| D2  | The Native Agents use the `playwright-test` MCP server            | Accepted |
| D3  | The API branch targets reqres.in                                  | Accepted |
| D4  | The Postman MCP package is `@postman/postman-mcp-server`          | Accepted |
| D5  | reqres.in requests carry an API key from the environment          | Accepted |
| D6  | Test management is a port with adapters, not a hardcoded TestLink | Accepted |
| D7  | TestLink sync runs through XML-RPC, not the TestLink MCP bridge   | Accepted |

---

## D1 — Playwright agent definitions are regenerated, not versioned

**Context.** `npx playwright init-agents --loop=claude` generates the Planner,
Generator and Healer definitions under `.claude/agents/`, plus `.mcp.json` at
the repository root. The `.claude/` directory also holds per-user tool state
that must never be committed.

**Decision.** `.claude/` stays gitignored and `.mcp.json` is tracked. The agent
definitions are scaffolding: after cloning, and after every Playwright upgrade,
run `npx playwright init-agents --loop=claude` to regenerate them. They are
never edited by hand.

**Consequences.** Per-user state cannot leak into the repository, and a fresh
clone reproduces the agents with one command. Local edits to the generated
prompts are not version-controlled, which is intended: behavior is
customized in `agents/` and `skills/`, not in the generated files.

---

## D2 — The Native Agents use the `playwright-test` MCP server

**Context.** The first design assumed the standalone `@playwright/mcp` server.
`init-agents` (Playwright 1.60) instead registers an entry named
`playwright-test` that runs `npx playwright run-test-mcp-server`, the
test-runner-aware MCP server that ships inside `@playwright/test`. The Native
Agents' tools are wired to it (`mcp__playwright-test__*`).

**Decision.** Keep the scaffold exactly as generated. Other MCP servers
(Atlassian, Postman, GitHub) are added to `.mcp.json` next to
`playwright-test`, never in place of it.

**Consequences.** The agents run against the server they were built for, and
regenerating them after an upgrade does not conflict with project config.

---

## D3 — The API branch targets reqres.in

**Context.** The E2E target, Saucedemo (`https://www.saucedemo.com/`), is a
client-side demo app: credentials live in the bundle, cart state in
`localStorage`, and there are no auth or order endpoints to call. The API
branch needs a real HTTP API.

**Decision.** The API branch targets `https://reqres.in/api`
(`API_BASE_URL` in `.env.example`); Saucedemo stays the E2E target. reqres.in
was chosen over fakestoreapi.com and httpbin.org because it supports the full
method surface (GET / POST / PUT / PATCH / DELETE) with deterministic,
documented failure modes, such as `POST /register` with a missing field
returning `400` with a specific error body. Negative API cases are a primary
use of `automate_api` in the Automation Decision Model.

**Consequences.** API example stories (for instance
`examples/stories/api-create-user.md`) target reqres.in. The `automate_api`
case in `examples/expected/login-success.expected-test-cases.json` stays as a
correct application of the decision model, even though Saucedemo cannot
execute it.

---

## D4 — The Postman MCP package is `@postman/postman-mcp-server`

**Context.** The official server is referred to as
`postmanlabs/postman-mcp-server`, but that is the GitHub repository, not the
npm package. On npm, `@postman/mcp-server` does not exist (404), and the
unscoped `postman-mcp-server` is published by a third party, not by Postman.

**Decision.** Use the official scoped package, `@postman/postman-mcp-server`
(source: `github.com/postmanlabs/postman-mcp-server`), in local STDIO mode:
`npx @postman/postman-mcp-server --full` with `POSTMAN_API_KEY` from the
environment. The unscoped third-party package is rejected, since the stack
only admits official MCP servers (`CLAUDE.md` §4).

**Consequences.** Configured in `.mcp.json` and documented in
`docs/postman-integration.md`.

---

## D5 — reqres.in requests carry an API key from the environment

**Context.** reqres.in added mandatory free-tier authentication to all
`/api/*` endpoints: without an `x-api-key` header, both `POST /users` and
`POST /register` return `401 {"error":"missing_api_key"}`. Test cases written
for the earlier keyless behavior read correctly and passed review, but the live
API had changed. Only the rule to verify endpoint shapes against the live API
before writing assertions (`agents/api-agent.md`) caught it.

**Decision.** The key is supplied as `REQRES_API_KEY` in `.env` and reaches the
collection as the environment variable `{{api_key}}`, sent as the `x-api-key`
header. It is never hardcoded in a committed collection.

**Consequences.**

- Every request sends `x-api-key: {{api_key}}`; assertions were re-verified
  against the live API with the key.
- Newman records live request headers, so raw Newman reports are
  secret-bearing. They stay in the gitignored execution directory, and CI
  uploads only the allowlisted, sanitized summary
  (`docs/security-and-data-safety.md`).

---

## D6 — Test management is a port with adapters, not a hardcoded TestLink

**Context.** The first integration design hardcoded TestLink as the
test-management tool. Teams use other tools (Xray, Qase), and adding one should
not mean modifying TestLink's code or the pipeline core (Open/Closed
Principle).

**Decision.** A stable `TestManagementAdapter` port
(`agents/test-management-adapter.md`) defines three operations:
`verifyConnection`, `pushTestCases` and `pushExecutionResults`.
`test-cases/*.json` is the source of truth and the tool is a downstream sync
target. `TEST_MANAGEMENT_TOOL` selects the adapter. TestLink is the first
implemented adapter; Xray and Qase are documented as future adapters and are
built only when needed.

**Consequences.** Adding a tool means one dispatcher row, a new
`skills/syncing-<tool>/` adapter and a `config/<tool>-*-map.json`, with no
edits to existing adapters. Field and status mappings live in
`config/testlink-*-map.json`, never in code.

---

## D7 — TestLink sync runs through XML-RPC, not the TestLink MCP bridge

**Context.** TestLink itself works: the self-built image
(`docker/testlink/Dockerfile`) serves the XML-RPC API, which authenticates the
developer key (`tl.checkDevKey` returns `1`). The `dogkeeper886/testlink-mcp`
bridge, however, never completes its MCP handshake: the client reports
`MCP error -32000: Connection closed`, and the container exits cleanly without
any diagnostics. The same XML-RPC endpoint works from a script, so the fault
is in the bridge, not in TestLink.

**Decision.** `scripts/sync-to-testlink.js` is the supported TestLink adapter
path. It calls the XML-RPC endpoint directly with Node's built-in `fetch`,
defaults to a dry run, and writes only with `--apply-testlink`.

**Consequences.**

- The `testlink` entry was removed from `.mcp.json`. The block is preserved in
  `docs/testlink-integration.md` §2 so it can be restored if a working bridge
  image appears.
- The sync is live-verified: it created test cases in TestLink, reused the
  story suite, and wrote each `testlink_id` back into the test-case file,
  which still validates against its schema.
- `skills/syncing-testlink` still documents the MCP tool path; the script is
  the path that runs today. The adapter port (D6) is unaffected, because only
  the transport changed.
