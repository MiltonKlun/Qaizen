# MCP Setup

This document covers how the MCP (Model Context Protocol) servers used by the
Qaizen QA pipeline are configured for local development.

## Current state

Four MCP servers are wired up in `.mcp.json`. None of them can write to Jira or
Confluence; Jira writes go through deterministic scripts that a human runs with
`--apply` (see "Jira writes" below).

| Server            | Purpose                                                                                    | Phase introduced |
| ----------------- | ------------------------------------------------------------------------------------------ | ---------------- |
| `playwright-test` | Playwright Native Agents (planner/generator/healer) drive a real browser through this MCP. | 1                |
| `atlassian`       | `sooperset/mcp-atlassian` — Jira + Confluence access. **Read-only.**                       | 1                |
| `postman`         | `@postman/postman-mcp-server` — collections for the API branch.                            | 1.5              |
| `github`          | `github/github-mcp-server` — a linked PR's diff as secondary context.                      | 3                |

---

## `playwright-test`

Created by `npx playwright init-agents --loop=claude`. It runs
`npx playwright run-test-mcp-server`, the test-runner-aware MCP that the
Native Agents call via `mcp__playwright-test__*` tools.

Do not hand-edit the entry. Regenerate it with `npx playwright init-agents`
after Playwright upgrades. See `docs/design-decisions.md` D2 for why this
server is named `playwright-test` rather than the bare `playwright` the
phase plan text described.

---

## `atlassian` — `sooperset/mcp-atlassian`

Runs as a stdio-attached Docker container. Authentication is done with an
Atlassian API token. The container reads its config from environment
variables that the MCP client passes through from `.env`.

### Why it is read-only

The system has four human gates and a strict "no invented requirements"
rule. An agent that reads a story has no reason to mutate Jira, so the
MCP toolset is locked down to the read tools only.

Jira writes exist, but only through deterministic scripts that a
human runs with `--apply` (`scripts/create-jira-bugs.js`,
`scripts/create-jira-testcases.js`). The MCP server stays read-only: an agent reads tickets written by other people, and a write-capable
server in the same session would let instructions hidden in a ticket reach a
real Jira project.

### Version, tool groups and read-only mode

`.mcp.json` pins the image to a release and its digest
(`ghcr.io/sooperset/mcp-atlassian:0.23.1@sha256:…`) rather than `latest`, so
neither an upstream release nor a re-pushed tag can change the tools under the
allowlist without a reviewed change here. Two server settings back the
allowlist up:

- `TOOLSETS=all`. The server filters by tool group as well
  as by name, and the two filters intersect. Its documentation says the
  default will narrow to six core groups, which leave out
  `jira_get_link_types`; naming the groups keeps the allowlist the only
  filter that matters.
- `READ_ONLY_MODE=true`. Even if a write
  tool were added to `ENABLED_TOOLS` by mistake, the server would neither
  list nor run it.

To upgrade, check the new release's tool names against `ENABLED_TOOLS` (a
name that no longer exists enables nothing, silently), then change the pin. The Docker engine must be running
(Docker Desktop on Windows and macOS): when it is not, the MCP client reports
the server's connection as closed and no Jira tool is available.

### `ENABLED_TOOLS` allowlist

`sooperset/mcp-atlassian` 0.23.1 exposes about 98 tools. The agent only gets the
read tools below. Anything not listed is unavailable; writes attempted by
the agent fail at the MCP layer, not at the policy layer.

```
ENABLED_TOOLS=jira_get_issue,jira_search,jira_get_link_types,confluence_get_page,confluence_search
```

| Tool                  | Purpose                           |
| --------------------- | --------------------------------- |
| `jira_get_issue`      | Fetch a single Jira issue by key. |
| `jira_search`         | JQL search.                       |
| `jira_get_link_types` | Read issue link metadata.         |
| `confluence_get_page` | Fetch a Confluence page by ID.    |
| `confluence_search`   | Search Confluence content.        |

### Getting an Atlassian API token

1. Sign in to `https://id.atlassian.com/manage-profile/security/api-tokens`.
2. Click **Create API token**, give it a label (e.g. "qaizen").
3. Copy the token immediately — Atlassian shows it once.
4. Put it in `.env`. Two credentials are used, on purpose:
   - `ATLASSIAN_READ_USERNAME` / `ATLASSIAN_READ_API_TOKEN` — what the MCP
     server uses for both Jira and Confluence. Create this token on an
     account that can only **read** the projects and spaces the pipeline
     needs, so no agent session ever holds a token that can write.
   - `JIRA_USERNAME` / `JIRA_API_TOKEN` — what the deterministic scripts use
     (story fetch, and promotion to Jira with an explicit `--apply`).
     Until you have a read-only account, the read pair may repeat the script
     pair; the MCP server still runs read-only, but the token itself could
     write.
5. `.env` is gitignored. Never commit it.

The username fields are the email address of the Atlassian account that owns
each token, not a separate user name.

### Local setup steps

1. Install Docker Desktop (≥ 20). Confirm: `docker --version`.
2. Pull the image:
   ```
   docker pull ghcr.io/sooperset/mcp-atlassian:0.23.1
   ```
3. Copy `.env.example` to `.env` and fill in:
   - `JIRA_URL` — e.g. `https://your-domain.atlassian.net`
   - `JIRA_USERNAME` — your Atlassian email
   - `JIRA_API_TOKEN` — the token from the step above
   - `ATLASSIAN_READ_USERNAME`, `ATLASSIAN_READ_API_TOKEN` — the read-only
     credential for the MCP server
   - `JIRA_PROJECT_KEY` — e.g. `PROJ`
   - `CONFLUENCE_URL`
   - Leave `ENABLED_TOOLS` at the value listed above.
4. Restart the MCP client so it re-reads `.mcp.json` and `.env`.

### Verifying the connection

Once `.env` is populated, ask your AI agent:

> Fetch Jira issue `<your-project-key>-1` (or any real issue key).

Expected behavior:

- Returns the issue summary, description, status, etc.

To confirm the read-only lock, also ask:

> Create a Jira issue in `<your-project>` with summary "ignore me".

Expected behavior:

- The agent cannot complete the request because `jira_create_issue` is not
  in `ENABLED_TOOLS`. The MCP either reports the tool as unavailable, or
  the agent explains that no such tool is exposed.

If a write tool somehow succeeds, that is a configuration bug:
re-check `ENABLED_TOOLS` in `.env` and that the MCP client is reading the
updated `.mcp.json`. Stop and report rather than silently proceeding.

### How `.mcp.json` and `.env` connect

The `atlassian` block in `.mcp.json` declares each env var with a Docker
`-e VAR` flag (no value) and supplies the value via an `env` map using
`${VAR}` substitution. The MCP client expands `${VAR}` from the process
environment (which is loaded from `.env`) before launching the container.
The container then sees the variables as part of its own environment and
applies the `ENABLED_TOOLS` filter at startup.

The names are not always the same on both sides: the container's
`JIRA_USERNAME`, `JIRA_API_TOKEN`, `CONFLUENCE_USERNAME` and
`CONFLUENCE_API_TOKEN` are filled from `ATLASSIAN_READ_USERNAME` and
`ATLASSIAN_READ_API_TOKEN`. An older `.env` without those two variables
leaves the server unable to authenticate; add them (they may repeat the
`JIRA_*` values until you have a read-only account) and restart the MCP
client.

If the agent ever reports "JIRA_URL is empty" or similar, the most likely
cause is that `.env` is missing or the MCP client wasn't restarted after
`.env` changed.

---

## Jira writes — scripts, never an MCP server

No MCP server in `.mcp.json` can write to Jira or Confluence. An earlier
version shipped a second, write-enabled `atlassian-write` entry for one
optional agent action (a "pipeline started" comment); it was removed so that
no agent session can mutate a real Jira project, even by mistake or through
instructions hidden in a ticket it reads.

Every Jira write goes through a deterministic script that a human runs with
an explicit flag:

- Bug promotion: `node scripts/create-jira-bugs.js --apply`.
- Test-case promotion: `node scripts/create-jira-testcases.js --apply`.

Both use `JIRA_USERNAME` / `JIRA_API_TOKEN` and are covered in
`docs/bug-draft-format.md` and `docs/live-acceptance.md`. Without `--apply`
they only print what they would do.

If a task seems to imply a Jira write without an explicit human-supplied
flag, stop and ask — the same "stop before guessing" rule as everywhere else.

---

## `github` — read-only PR/diff access

A **read-only** GitHub MCP lets the Analyst (Mode B) fetch a
linked PR's diff as **secondary context** for risk/regression prioritization.
It runs as a stdio Docker container, like the Atlassian MCP.

### The hard boundary (read twice)

The diff is **secondary context only**. Acceptance criteria define
correctness; the diff informs _regression scope_ and _risk prioritization_.
The Analyst NEVER generates expected-behavior assertions from "what the code
does" (that would validate the implementation against itself). This is the
§3.8 rule applied to code: anchor on the requirement, use the diff to sharpen.

### Read-only, enforced three ways

The `repos` and `pull_requests` toolsets that an earlier version enabled
include write tools (`push_files`, `create_pull_request`,
`merge_pull_request`, `delete_repository`), so "read-only" used to depend
entirely on the token. It no longer does. `.mcp.json` fixes the server's
configuration (not `.env`):

- `GITHUB_TOOLS=pull_request_read,get_file_contents,get_commit` — only the
  three read tools the Analyst needs are loaded.
- `GITHUB_READ_ONLY=1` — the server's own filter, which disables every write
  tool even if one is requested.
- `GITHUB_LOCKDOWN_MODE=1` — in public repositories, only surfaces content
  written by users with push access. It reduces prompt-injection risk from untrusted issue
  and comment text; GitHub describes it as a best-effort content filter, not
  an authorization boundary.

And the token should still be a **fine-grained PAT scoped to read** pull
requests and contents — no write or admin scopes. The pipeline never writes
to GitHub.

### Optional + PR-dependent

If a Jira story has **no linked PR**, the Analyst skips the diff entirely and
the pipeline runs exactly as before — no error, no blocking. So this MCP is
only exercised when QA-ing a story that points at real code (see
`agents/analyst.md` Mode B). Shift-left `pre_development` runs have no PR
by definition, so they never use it.

### Setup

1. Create a fine-grained PAT at
   `https://github.com/settings/personal-access-tokens` with **read-only**
   Pull requests + Contents on the relevant repo(s).
2. Put it in `.env` as `GITHUB_PERSONAL_ACCESS_TOKEN`. (A
   `GITHUB_TOOLSETS` line left in an older `.env` is ignored; the tool list
   lives in `.mcp.json`.)
3. Restart the MCP client so it loads the `github` entry from `.mcp.json`.

`code_change_context` in `context.json` (optional) records what was fetched:
`linked_pr`, `base_sha`, `head_sha`, `changed_files[]`, `summary`,
`fetched_at`. Absent when there is no linked PR.

---

## Pinning and platforms

Every server is pinned to an exact version, so a new release of a server
never runs without a reviewed change:

| Server            | Pinned by                                                   |
| ----------------- | ----------------------------------------------------------- |
| `playwright-test` | the repository's installed Playwright (`package-lock.json`) |
| `atlassian`       | image tag and digest                                        |
| `postman`         | exact npm version (`@postman/postman-mcp-server@<version>`) |
| `github`          | image tag and digest                                        |

Upgrades follow `docs/dependency-maintenance.md`: check the new version's
release notes and advisories, prefer a release that has been public for at
least a week, update the pin (for an image, resolve the new digest), and
re-check the tool settings above, since a renamed tool silently drops out of
an allowlist. `test/mcp-config.test.js` fails if a server is left unpinned or
loses its read-only settings.

`.mcp.json` is written for Windows, the primary platform: Claude Code needs
the `cmd /c` wrapper to start `npx` there. On macOS or Linux, change the two
`npx` entries to run `npx` directly, keeping the same arguments without
`/c`:

```json
"playwright-test": { "command": "npx", "args": ["playwright", "run-test-mcp-server"] },
"postman": { "command": "npx", "args": ["-y", "@postman/postman-mcp-server@2.13.0"], "env": { "POSTMAN_API_KEY": "${POSTMAN_API_KEY}" } }
```

The same two entries are copied into the per-step configs
`config/mcp/playwright.json` and `config/mcp/postman.json`; change them there
too. The Docker entries work unchanged on every platform.

### Per-step configs

The runner tells you to start each agent step in its own session with only
the servers that step needs, from `config/mcp/` (`analyst.json`,
`playwright.json`, `postman.json`, `none.json`) and `--strict-mcp-config`.
Those files hold exact copies of the entries above, and
`test/mcp-steps.test.js` fails if one drifts, so a pin or a read-only setting
is changed in `.mcp.json` and copied, never edited in one place only. See
`docs/pipeline-runner.md` §3.

---

## History

The Postman MCP was added for the API branch. Documented in
`docs/postman-integration.md`.

A writes-enabled `atlassian-write` entry was added and later removed
(see "Jira writes" above). A `testlink` MCP was **intended** too, but that bridge
(`dogkeeper886/testlink-mcp`) would not complete its handshake in the MCP
client (`-32000`, zero diagnostics), so it was removed from `.mcp.json`. The
supported TestLink path is the XML-RPC script `scripts/sync-to-testlink.js`
(live-verified on 2026-06-04; re-acceptance of the current version is tracked
in `docs/sync-recovery.md` §7). See `docs/testlink-integration.md` and
`docs/design-decisions.md` D7. So the active MCP servers are
`playwright-test`, `atlassian` (read-only), `postman` and `github` — **no
`testlink`** and no write-enabled Atlassian entry.

The read-only `github` MCP (above) was added for code-change
awareness. The other later additions (hardening, prompt versioning,
metrics) are application-level and need no MCP.
