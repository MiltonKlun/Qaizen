# MCP Setup

This document covers how the MCP (Model Context Protocol) servers used by the
AI QA pipeline are configured for local development. Each Phase adds new MCPs;
this file is updated when that happens.

## Current state (Phase 1)

Two MCP servers are wired up in `.mcp.json`:

| Server            | Purpose                                                                                    | Phase introduced |
| ----------------- | ------------------------------------------------------------------------------------------ | ---------------- |
| `playwright-test` | Playwright Native Agents (planner/generator/healer) drive a real browser through this MCP. | 1 (TG3)          |
| `atlassian`       | `sooperset/mcp-atlassian` — Jira + Confluence access. **Read-only in Phase 1.**            | 1 (TG4)          |

Phase 1.5 will add `postman`. Phase 2 will add `testlink` and will expand the
Atlassian tool allowlist to include writes.

---

## `playwright-test`

Created by `npx playwright init-agents --loop=claude` (Phase 1, TG3). It runs
`npx playwright run-test-mcp-server`, the test-runner-aware MCP that the
Native Agents call via `mcp__playwright-test__*` tools.

Do not hand-edit the entry. Regenerate it with `npx playwright init-agents`
after Playwright upgrades. See `docs/ambiguities.md` entry A2 for why this
server is named `playwright-test` rather than the bare `playwright` the
phase plan text described.

---

## `atlassian` — `sooperset/mcp-atlassian`

Runs as a stdio-attached Docker container. Authentication is done with an
Atlassian API token. The container reads its config from environment
variables that the MCP client (Claude Code) passes through from `.env`.

### Why Phase 1 is read-only

The system has four human gates and a strict "no invented requirements"
rule. Phase 1 is the foundation slice — there are no human-approved bug
drafts yet, no traceability to a real failure that should write back to
Jira, and no audit trail for writes. Until the pipeline has produced a
validated `release-report.json` and at least one Gate-4-approved
generated test, the agent has no reason to mutate Jira. So Phase 1
locks the toolset down to the read tools only.

Phase 2 (TG2) expands the allowlist to include `jira_create_issue`,
`jira_update_issue`, and `jira_add_comment`, and even then writes require
explicit human approval via the `--apply` flag in
`scripts/create-jira-bugs.js`.

### Phase 1 `ENABLED_TOOLS` allowlist

`sooperset/mcp-atlassian` exposes ~72 tools. The agent only gets the
read tools below. Anything not listed is unavailable; writes attempted by
the agent fail at the MCP layer, not at the policy layer.

```
ENABLED_TOOLS=jira_get_issue,jira_search,jira_get_issue_link_types,confluence_get_page,confluence_search
```

| Tool                        | Purpose                           |
| --------------------------- | --------------------------------- |
| `jira_get_issue`            | Fetch a single Jira issue by key. |
| `jira_search`               | JQL search.                       |
| `jira_get_issue_link_types` | Read issue link metadata.         |
| `confluence_get_page`       | Fetch a Confluence page by ID.    |
| `confluence_search`         | Search Confluence content.        |

### Getting an Atlassian API token

1. Sign in to `https://id.atlassian.com/manage-profile/security/api-tokens`.
2. Click **Create API token**, give it a label (e.g. "ai-qa-pipeline").
3. Copy the token immediately — Atlassian shows it once.
4. Put it in `.env` as `JIRA_API_TOKEN` (and `CONFLUENCE_API_TOKEN` — they're
   the same token if you're on the same Atlassian site).
5. `.env` is gitignored. Never commit it.

The username field (`JIRA_USERNAME`, `CONFLUENCE_USERNAME`) is the email
address of the Atlassian account that owns the token, not a separate user
name.

### Local setup steps

1. Install Docker Desktop (≥ 20). Confirm: `docker --version`.
2. Pull the image:
   ```
   docker pull ghcr.io/sooperset/mcp-atlassian:latest
   ```
3. Copy `.env.example` to `.env` and fill in:
   - `JIRA_URL` — e.g. `https://your-domain.atlassian.net`
   - `JIRA_USERNAME` — your Atlassian email
   - `JIRA_API_TOKEN` — the token from the step above
   - `JIRA_PROJECT_KEY` — e.g. `PROJ`
   - `CONFLUENCE_URL`, `CONFLUENCE_USERNAME`, `CONFLUENCE_API_TOKEN`
   - Leave `ENABLED_TOOLS` at the Phase 1 value listed above.
4. Restart Claude Code so it re-reads `.mcp.json` and `.env`.

### Verifying the connection

Once `.env` is populated, in a Claude Code session ask:

> Fetch Jira issue `<your-project-key>-1` (or any real issue key).

Expected behavior:

- Returns the issue summary, description, status, etc.

To confirm the read-only lock, also ask:

> Create a Jira issue in `<your-project>` with summary "ignore me".

Expected behavior:

- The agent cannot complete the request because `jira_create_issue` is not
  in `ENABLED_TOOLS`. The MCP either reports the tool as unavailable, or
  the agent explains that no such tool is exposed.

If a write tool somehow succeeds in Phase 1, that is a configuration bug:
re-check `ENABLED_TOOLS` in `.env` and that Claude Code is reading the
updated `.mcp.json`. Stop and report rather than silently proceeding.

### How `.mcp.json` and `.env` connect

The `atlassian` block in `.mcp.json` declares each env var with a Docker
`-e VAR` flag (no value) and supplies the value via an `env` map using
`${VAR}` substitution. Claude Code expands `${VAR}` from the process
environment (which is loaded from `.env`) before launching the container.
The container then sees the variables as part of its own environment and
applies the `ENABLED_TOOLS` filter at startup.

If the agent ever reports "JIRA_URL is empty" or similar, the most likely
cause is that `.env` is missing or Claude Code wasn't restarted after
`.env` changed.

---

## `atlassian-write` — write-enabled Atlassian (Phase 2)

Phase 2 introduces a **second** Atlassian MCP entry, `atlassian-write`,
alongside the read-only `atlassian`. Both use the same Docker image and
the same token. The only difference is the `ENABLED_TOOLS` allowlist:

| Entry             | `ENABLED_TOOLS` source             | Tools available                                                                                          |
| ----------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `atlassian`       | `${ENABLED_TOOLS}` (read-only)     | `jira_get_issue`, `jira_search`, `jira_get_issue_link_types`, `confluence_get_page`, `confluence_search` |
| `atlassian-write` | `${ATLASSIAN_ENABLED_TOOLS_WRITE}` | the read tools **plus** `jira_create_issue`, `jira_update_issue`, `jira_add_comment`                     |

### Why two entries instead of flipping the one

Keeping the read-only entry as the default means the **safe** capability
is always what's loaded; the write capability is a deliberate, separate
server the human chooses. Flipping the single entry to writes would make
writes the ambient default — exactly what we don't want for a tool that
can mutate a real Jira project.

### Two ways to operate the toggle

1. **Two MCP entries (current setup).** `atlassian` (read) and
   `atlassian-write` (write) both exist in `.mcp.json`. Use the read one
   for everything except deliberate bug creation; the write tools only
   exist under `atlassian-write`.
2. **Two env files (recommended for teams).** Keep `.env.dev` with
   `ENABLED_TOOLS` = the read-only list and **no** write value, and
   `.env.prod` (or `.env.write`) that sets
   `ATLASSIAN_ENABLED_TOOLS_WRITE`. Point the shell at whichever file you
   mean to use. CI never loads the write file on PR-from-fork triggers
   (see `docs/secrets-management.md` §3).

### THE CRITICAL RULE — writes are never a side effect

Having `atlassian-write` available does **not** mean the agent creates or
mutates Jira issues on its own. Two independent things must both be true
for a write to happen:

1. **Capability** — the write tools are loaded (`atlassian-write` /
   the write allowlist).
2. **Intent** — an explicit human action requests it. Bug creation
   happens only through `node scripts/create-jira-bugs.js --apply`
   (Phase 2 TG5), which requires the `--apply` flag a human types. The
   Analyst's optional "QA pipeline started" Jira comment (Phase 2 TG9)
   likewise requires explicit human approval in the run.

The agent must NEVER call `jira_create_issue` / `jira_update_issue` /
`jira_add_comment` as an implicit consequence of some other command
(e.g. "analyze this story" must not silently comment on the Jira issue).
If a task seems to imply a write without an explicit human-supplied
flag, stop and ask — this is the same "stop before guessing" rule as
everywhere else, applied to the one place where the agent could
otherwise mutate a real external system.

### Verifying the write path (manual test)

With `.env` populated (real `JIRA_*` + `ATLASSIAN_ENABLED_TOOLS_WRITE`)
and Claude Code restarted so `atlassian-write` is loaded:

- Ask the agent to create a throwaway test issue in your project (e.g.
  "create a test issue in `<PROJECT_KEY>` titled 'mcp write smoke test'").
  It should succeed and return the new issue key.
- Then delete that test issue in Jira by hand.
- Confirm the negative: a normal read/analysis command does NOT create
  or comment on any issue.

This is the TG2 Definition-of-Done check. Because it needs a live Jira
tenant, the human runs it; the agent cannot self-verify against your
real Jira.

---

## `github` — read-only PR/diff access (Phase 3 TG15)

Phase 3 adds a **read-only** GitHub MCP so the Analyst (Mode B) can fetch a
linked PR's diff as **secondary context** for risk/regression prioritization.
It runs as a stdio Docker container, like the Atlassian MCP.

### The hard boundary (read twice)

The diff is **secondary context only**. Acceptance criteria define
correctness; the diff informs _regression scope_ and _risk prioritization_.
The Analyst NEVER generates expected-behavior assertions from "what the code
does" (that would validate the implementation against itself). This is the
§3.8 rule applied to code: anchor on the requirement, use the diff to sharpen.

### Read-only, by design

- The token is a **fine-grained PAT scoped to read** pull requests + repo
  contents — no write/admin scopes.
- `GITHUB_TOOLSETS=repos,pull_requests` restricts which tool groups the MCP
  server even loads; write-oriented toolsets (issues, actions, etc.) are not
  enabled. The pipeline never writes to GitHub.

### Optional + PR-dependent

If a Jira story has **no linked PR**, the Analyst skips the diff entirely and
the pipeline runs exactly as before — no error, no blocking. So this MCP is
only exercised when QA-ing a story that points at real code (see
`agents/analyst.md` Mode B and `phase3-healing-scaling.md` TG15). Shift-left
`pre_development` runs have no PR by definition, so they never use it.

### Setup

1. Create a fine-grained PAT at
   `https://github.com/settings/personal-access-tokens` with **read-only**
   Pull requests + Contents on the relevant repo(s).
2. Put it in `.env` as `GITHUB_PERSONAL_ACCESS_TOKEN`; leave
   `GITHUB_TOOLSETS=repos,pull_requests`.
3. Restart Claude Code so it loads the `github` entry from `.mcp.json`.

`code_change_context` in `context.json` (optional) records what was fetched:
`linked_pr`, `base_sha`, `head_sha`, `changed_files[]`, `summary`,
`fetched_at`. Absent when there is no linked PR.

---

## Future state

Phase 1.5 — adds the Postman MCP for the API branch. Documented in
`docs/postman-integration.md` (created in P1.5 TG1).

Phase 2 — adds the writes-enabled `atlassian-write` entry (above). It was
**intended** to also add a `testlink` MCP, but that bridge
(`dogkeeper886/testlink-mcp`) would not complete its handshake in Claude
Code (`-32000`, zero diagnostics), so it was removed from `.mcp.json`. The
supported TestLink path is the XML-RPC script `scripts/sync-to-testlink.js`
(live-verified). See `docs/testlink-integration.md` and
`docs/ambiguities.md` A7. So the active MCP servers as of Phase 2 are:
`playwright-test`, `atlassian`, `atlassian-write`, `postman` — **no
`testlink`**.

Phase 3 — adds the read-only `github` MCP (TG15, above) for code-change
awareness. Otherwise hardening, prompt versioning, and metrics are
application-level.
