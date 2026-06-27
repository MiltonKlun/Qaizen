# Postman + Newman Integration (Phase 1.5)

> **Status:** Phase 1.5. The API branch runs in parallel with the E2E
> branch. The Test Designer marks some test cases `automate_api`; those feed
> the API Agent (`agents/api-agent.md`), which produces Postman collections;
> Newman executes them; the same Failure Classifier and Reporter cover both
> branches.

This document covers how the API branch is wired: the Postman MCP server (for
the agent to author collections), Newman (for deterministic execution), the
API key, and the recommended workspace layout.

---

## 1. Two different tools, two different jobs

A common confusion: "Postman MCP" and "Newman" are not the same thing and do
not do the same job.

| Tool                   | Who uses it         | What it does                                                                                                    |
| ---------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Postman MCP server** | The API Agent (LLM) | Lets the agent **read and write** Postman collections / environments / workspaces conversationally. Authoring.  |
| **Newman**             | The pipeline / CI   | A command-line runner that **executes** a collection file deterministically and emits machine-readable results. |

The agent authors with the MCP; the pipeline executes with Newman. The
collection file on disk (`api-tests/collections/[story-id].postman_collection.json`)
is the hand-off artifact between them and the **primary source of truth** —
the Postman cloud workspace is optional/secondary storage.

### Why Newman for execution (not the MCP)

- **Deterministic.** Newman runs the same collection the same way every time,
  with no LLM in the loop. Test execution must be reproducible.
- **CI-friendly.** Newman is a CLI with structured JSON output. Phase 2 wires
  it into GitHub Actions trivially; an MCP server in CI would be awkward.
- **No API key needed at run time.** Newman reads the collection from disk and
  runs it. It does not need `POSTMAN_API_KEY` — only the MCP (authoring) does.
- **Separation of concerns.** Authoring (creative, agent-driven) and execution
  (mechanical, deterministic) are kept apart, mirroring how the Playwright
  branch separates the Generator (authoring) from `playwright test` (execution).

---

## 2. The official Postman MCP server

The package is **`@postman/postman-mcp-server`** (the official scoped package
from Postman). It runs in two modes:

- **Local (STDIO):** `npx @postman/postman-mcp-server --full`, configured in
  `.mcp.json`. Needs `POSTMAN_API_KEY`. This is what this project uses.
- **Remote (hosted):** `https://mcp.postman.com` with OAuth. Not used here —
  we keep everything local for Phase 1.5.

> **Note on the package name:** the phase plan text and `README.md` §1.2 refer
> to `@postman/mcp-server` / `postmanlabs/postman-mcp-server`. The actual
> npm package is `@postman/postman-mcp-server`. There is also a **third-party**
> unscoped `postman-mcp-server` on npm — **do not use it**; it is not published
> by Postman. See `docs/ambiguities.md` A4 for the full reasoning.

### `.mcp.json` entry

```json
{
  "mcpServers": {
    "postman": {
      "command": "cmd",
      "args": ["/c", "npx", "@postman/postman-mcp-server", "--full"],
      "env": {
        "POSTMAN_API_KEY": "${POSTMAN_API_KEY}"
      }
    }
  }
}
```

(The `cmd /c` wrapper is for Windows `npx` resolution, matching the
`playwright-test` entry. On macOS/Linux a bare `npx` command also works.)

The `--full` flag exposes the complete tool surface (workspace, collection,
request, environment, folder, mock-server management). For Phase 1.5 the API
Agent primarily needs collection + environment read/write.

---

## 3. Getting a Postman API key

1. Sign in to Postman and open
   `https://go.postman.co/settings/me/api-keys`.
2. Click **Generate API Key**, name it (e.g. "ai-qa-pipeline"), copy it.
3. Put it in `.env` as `POSTMAN_API_KEY`. `.env` is gitignored — never commit
   it.
4. Restart the MCP client (Claude Code) so it re-reads `.mcp.json` + `.env`.

The key is only needed for the **MCP** (authoring against Postman cloud). If
you only ever run collections from disk with Newman, you can leave it blank —
Newman doesn't use it.

`POSTMAN_WORKSPACE_ID` is optional; set it to point the API Agent at a specific
workspace, or leave it blank for the account default.

---

## 4. Recommended workspace structure

Keep collections **one per story**, mirroring the filesystem:

```
api-tests/
  collections/
    QA-1042.postman_collection.json
    api-create-user.postman_collection.json
  environments/
    QA-1042.postman_environment.json
    api-create-user.postman_environment.json
```

In Postman cloud (if used as secondary storage), mirror the same separation:
one collection per story-id, named with the story-id prefix so they sort
together and never collide. The API Agent reads the existing collection for a
story (if any) and **updates** it rather than creating a duplicate.

### Environments hold the variables, collections hold the requests

- The **collection** describes requests + assertions. It references variables
  like `{{base_url}}` and `{{api_key}}` — never hardcoded values.
- The **environment** supplies those variable values. Credentials and the API
  base URL live here, never in the collection. This is a hard rule
  (`agents/api-agent.md` Forbidden actions).

For Phase 1.5 the API base URL is `https://reqres.in/api` (per
`docs/ambiguities.md` A3 — Saucedemo has no backend, so the API branch targets
reqres.in). The environment file sets `base_url` to that value.

---

## 5. Running collections with Newman

The `test:api` npm script wraps Newman through `scripts/run-newman.js` (a
cross-platform wrapper — the phase plan's literal `$STORY_ID` shell expansion
does not work when npm runs scripts through `cmd` on Windows):

```bash
# By env var:
STORY_ID=QA-1042 npm run test:api

# Or directly:
node scripts/run-newman.js QA-1042
```

It runs:

```
newman run api-tests/collections/<STORY_ID>.postman_collection.json \
  -e api-tests/environments/<STORY_ID>.postman_environment.json \
  --reporters cli,json,htmlextra \
  --reporter-json-export reports/newman-results.json \
  --reporter-htmlextra-export reports/newman-html
```

Outputs:

- `reports/newman-results.json` — machine-readable results the Failure
  Classifier reads (gitignored; goes to CI artifacts in Phase 2).
- `reports/newman-html/` — human-readable HTML report (gitignored).

Exit codes from the wrapper: `0` all passed, `1` at least one
assertion/request failed, `2` usage error or the collection file is missing.

The environment file is optional — if it's absent the wrapper warns and runs
without `-e`.

---

## 6. How this fits the pipeline

```
test-cases/[story-id].json
   │
   ├── automate_e2e cases → Playwright branch (Phase 1)
   │
   └── automate_api cases → API Agent (authors via Postman MCP)
                              │
                              ▼
                       api-tests/collections/[story-id].postman_collection.json
                       api-tests/environments/[story-id].postman_environment.json
                              │
                              ▼  Gate 3 (collection review) → Gate 4 (assertion review)
                              │
                              ▼  npm run test:api  (Newman)
                              │
                              ▼  reports/newman-results.json
                              │
                              ▼  Failure Classifier (same agent, both branches)
                              ▼  Reporter (same agent, grouped execution_summary)
```

The Failure Classifier and Reporter are **extended**, not duplicated, to cover
the API branch (Phase 1.5 TG5 + TG6). The Healer never touches API tests in any
phase (`docs/healer-guardrails.md`).

---

## 7. References

- `agents/api-agent.md` — the agent that authors collections (Phase 1.5 TG4).
- `schemas/postman-collection.schema.json` — minimal schema the collections
  validate against (Phase 1.5 TG3).
- `scripts/run-newman.js` — the cross-platform Newman wrapper.
- `docs/ambiguities.md` A3 (API target = reqres.in) and A4 (MCP package name).
- `docs/mcp-setup.md` — the other MCP servers (playwright-test, atlassian).
- `docs/automation-decision-model.md` — when a case is `automate_api`.
