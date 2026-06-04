# Secrets Management

> **Status:** Phase 2. This document covers how the pipeline handles
> credentials: where they live, how to create them, and how they reach
> CI without ever entering the repository.

The pipeline talks to several external services that need credentials —
Jira, Confluence, Postman, reqres.in, and (Phase 2) TestLink, plus
GitHub Actions in CI. None of those credentials ever live in a committed
file. This document is the single reference for getting them, storing
them, and feeding them to CI.

---

## 1. The one rule

**Credentials live in `.env` (local) or in the CI provider's secret
store (GitHub Actions). They never live in a committed file.**

- `.env` is gitignored (`.gitignore` line 2). Verify any time with
  `git check-ignore .env`.
- `.env.example` is the committed template — it lists every key with an
  **empty** value and a comment. It documents what's needed without
  leaking anything.
- Collections, schemas, agent prompts, test code, and reports must never
  contain a literal secret. Where a secret is needed at run time, it is
  injected from the environment (see §5).

If you ever find a real token in a file that git tracks, treat it as
compromised: rotate it immediately and scrub it from history.

---

## 2. Creating the tokens

### Jira / Confluence (Atlassian API token)

1. Sign in at `https://id.atlassian.com/manage-profile/security/api-tokens`.
2. **Create API token**, label it (e.g. "ai-qa-pipeline"), copy it once.
3. Put it in `.env`:
   - `JIRA_URL` — e.g. `https://your-domain.atlassian.net`
   - `JIRA_USERNAME` — the Atlassian account email
   - `JIRA_API_TOKEN` — the token
   - `JIRA_PROJECT_KEY` — the project bugs go to, e.g. `QA`
   - `CONFLUENCE_*` — same token if on the same Atlassian site.
4. The same token authorizes both read (Phase 1) and write (Phase 2)
   tools. What differs is the MCP's `ENABLED_TOOLS` allowlist, not the
   token. See §4.

### TestLink (API key)

1. In TestLink, open **User Settings** (your profile).
2. Find **API interface** / **Generate a new API key**. Generate + copy.
3. Put it in `.env`:
   - `TESTLINK_URL` — your instance base URL.
   - `TESTLINK_API_KEY` — the key.
   - `TESTLINK_PROJECT_KEY` — the project to sync test cases into.
   - `TESTLINK_TEST_PLAN_ID` — the test plan execution results report to.
4. TestLink is **self-hosted** — the pipeline does not install or manage
   it. You point the pipeline at a running instance.

### Postman (API key)

1. `https://go.postman.co/settings/me/api-keys` → **Generate API Key**.
2. `.env`: `POSTMAN_API_KEY`. Only the Postman MCP (authoring) needs it;
   Newman execution does not. See `docs/postman-integration.md`.

### reqres.in (demo API key)

1. `https://app.reqres.in/api-keys` → free key.
2. `.env`: `REQRES_API_KEY`. Injected into Newman runs as `{{api_key}}`
   (sent as `x-api-key`). See `docs/postman-integration.md` and
   `docs/ambiguities.md` A5.

### GitHub (for CI)

CI does not use a personal token for the pipeline's own logic; it uses
GitHub Actions secrets (see §3) plus the built-in `GITHUB_TOKEN` that
Actions provides automatically for repo operations. No separate token to
create unless a workflow calls an external service.

---

## 3. GitHub Actions secrets (Phase 2 CI)

CI cannot read your local `.env`. Each secret the workflow needs is
stored in the repo's GitHub Actions secret store and referenced as
`${{ secrets.NAME }}` in the workflow.

### Adding a secret

- Repo → **Settings → Secrets and variables → Actions → New repository
  secret**. Name + value. Or via CLI:
  ```
  gh secret set JIRA_API_TOKEN
  gh secret set TESTLINK_API_KEY
  gh secret set REQRES_API_KEY
  # ...one per credential the workflow needs
  ```
- Names should match the `.env` keys so the workflow maps cleanly.

### Which secrets CI needs

Depends on which jobs run. The Phase 2 `quality-checks` and
`playwright`/`newman` jobs need:

| Secret           | Used by                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| `BASE_URL`       | Playwright (can also be a plain repo _variable_, not secret)                 |
| `REQRES_API_KEY` | Newman API runs                                                              |
| `JIRA_*`         | only jobs that read/write Jira — keep these off PR-triggered jobs from forks |

**Do not** expose write-capable secrets (`JIRA_API_TOKEN`,
`TESTLINK_API_KEY`) to workflows triggered by pull requests from forks —
a malicious PR could exfiltrate them. Gate write-needing steps behind
`workflow_dispatch` or `push` to protected branches, not `pull_request`
from forks.

---

## 4. Read-only vs write-enabled Atlassian (the allowlist, not the token)

The Atlassian MCP's capability is controlled by `ENABLED_TOOLS`, not by
the token:

- **Phase 1 / read-only:**
  `ENABLED_TOOLS=jira_get_issue,jira_search,jira_get_issue_link_types,confluence_get_page,confluence_search`
- **Phase 2 / write-enabled:**
  `ATLASSIAN_ENABLED_TOOLS_WRITE=...,jira_create_issue,jira_update_issue,jira_add_comment,...`

**Recommended setup:** keep two env files — `.env.dev` (read-only
allowlist) and `.env.prod` (write allowlist) — and point the MCP at one
or the other deliberately. Even with writes enabled, the agent **never**
creates a Jira issue as a side effect: bug creation only happens through
`node scripts/create-jira-bugs.js --apply` with an explicit human flag
(Phase 2 TG5). The allowlist is the capability; the `--apply` flag is the
intent. Both are required for a write to happen. See `docs/mcp-setup.md`.

---

## 5. Injecting secrets at run time (never in artifacts)

Some tools need a secret inside a file they read (e.g. a Postman
environment's `api_key`). The pattern is: the committed file has an
**empty** value, and the runner injects the real value from the
environment at run time. Example — `scripts/run-newman.js` does:

```
newman run ... --env-var "api_key=$REQRES_API_KEY"
```

so `api-tests/environments/*.postman_environment.json` keeps `api_key`
empty in git.

**Caveat learned in Phase 1.5 (A5):** run-time injection keeps secrets
out of _committed_ files, but tools may still record them in their
**output**. Newman writes the live `x-api-key` request header into
`reports/newman-results.json`. That file is gitignored locally, but in
CI it would be uploaded as a build artifact. **Before Phase 2 CI uploads
Newman results, scrub auth headers** (`x-api-key`, `Authorization`) from
the JSON. Treat any results file that captured a live request as
secret-bearing until it has been scrubbed.

---

## 6. Rotation

Rotate a credential when:

- It was printed in a terminal, a chat/transcript, a screenshot, or a log
  that others can see.
- It landed in a build artifact that wasn't scrubbed.
- A team member with access leaves.
- On a routine cadence for production-adjacent tokens.

Rotation is cheap; a leaked long-lived token is not. The reqres.in and
Postman demo keys used during Phase 1.5 development were exposed in the
build session and are flagged for rotation in `PHASE1.5-RETROSPECTIVE.md`.

---

## 7. Checklist before committing

- [ ] No real token appears in any tracked file (`git diff --cached`).
- [ ] New secrets were added to `.env.example` as **empty** keys with a
      comment, and to local `.env` with real values.
- [ ] Any new run-time-injected secret keeps its committed file empty.
- [ ] Any new CI secret was added to the GitHub Actions secret store.
- [ ] Write-capable secrets are not exposed to fork-PR-triggered jobs.

---

## 8. References

- `.env.example` — the committed template of every key.
- `docs/mcp-setup.md` — Atlassian read-only vs write allowlist.
- `docs/postman-integration.md` — Postman / reqres / Newman secrets.
- `docs/testlink-integration.md` — TestLink setup (Phase 2 TG3).
- `docs/ambiguities.md` A5 — the Newman-results secret-leak follow-up.
- `phase2-integrations.md` TG1, TG5, TG8 — where these secrets are used.
