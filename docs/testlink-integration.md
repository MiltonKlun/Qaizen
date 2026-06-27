# TestLink Integration (Phase 2)

> **Status:** Phase 2. TestLink is the first adapter behind the
> `TestManagementAdapter` port (`agents/test-management-adapter.md`). It
> syncs **approved** test cases and execution results from the pipeline
> into a running TestLink instance. The pipeline's source of truth stays
> `test-cases/[story-id].json`; TestLink is a downstream target.

This document covers the TestLink-specific setup: the MCP, the XML-RPC
URL, the field mapping, and the gotchas found standing up a local
instance.

---

## 1. TestLink is self-hosted

The pipeline does **not** install or manage TestLink. You point it at a
running instance. For local development this project uses a two-container
Docker setup (app + a separate MySQL), because the bundled-MySQL images
proved fragile (see §6).

---

## 2. The `testlink` MCP entry — REMOVED; use the script instead

> **Status (TG3/TG4, A7):** the `testlink` MCP entry below was **removed
> from `.mcp.json`** because `dogkeeper886/testlink-mcp` would not complete
> its MCP handshake in Claude Code (`-32000 Connection closed`, no
> diagnostics) — even though TestLink itself works. **The supported
> TestLink path is `scripts/sync-to-testlink.js`** (XML-RPC, live-verified:
> it synced the 4 STORY-002 cases and wrote `testlink_id` back). The MCP
> block is preserved here only so it can be restored if a future image
> works. See `docs/ambiguities.md` A7.

The (removed) `testlink` MCP entry ran `dogkeeper886/testlink-mcp`:

```json
{
  "testlink": {
    "command": "docker",
    "args": [
      "run",
      "--rm",
      "-i",
      "-e",
      "TESTLINK_URL",
      "-e",
      "TESTLINK_API_KEY",
      "dogkeeper886/testlink-mcp:latest"
    ],
    "env": {
      "TESTLINK_URL": "${TESTLINK_URL}",
      "TESTLINK_API_KEY": "${TESTLINK_API_KEY}"
    }
  }
}
```

### Two URL gotchas — read before setting `TESTLINK_URL`

1. **XML-RPC endpoint path.** TestLink's API is XML-RPC at
   `<base>/lib/api/xmlrpc/v1/xmlrpc.php`. Depending on the MCP version it
   may want the **base** URL (`http://host/testlink`) or the **full
   XML-RPC** URL. The MCP's `verifyConnection` failing with a 404 or
   "not XML-RPC" almost always means the path is wrong — try the full
   `.../lib/api/xmlrpc/v1/xmlrpc.php` form.
2. **Docker-to-host networking.** The MCP runs in a Docker container, so
   `localhost` inside it is the **container**, not your machine. If
   TestLink is also a local container, `http://localhost:8080/...` will
   NOT resolve from the MCP container. Use one of:
   - `http://host.docker.internal:8080/testlink/...` (Docker Desktop maps
     this to the host), or
   - put both on the same Docker network and use the TestLink
     container's name as host, or
   - use the host's LAN IP.
     This project's local TestLink is at `http://localhost:8080/testlink`
     for browser access; the value the MCP needs may have to be the
     `host.docker.internal` form. Confirm during `verifyConnection`.

---

## 3. Getting the TestLink API key → `TESTLINK_API_KEY`

1. Log in to TestLink (default admin `admin` / `admin`).
2. Click your **username** (top-right) → **My Settings** / user edit page.
3. **API interface** section → **Generate a new key** → copy it.
4. Put it in `.env` as `TESTLINK_API_KEY`. It is write-capable — never
   commit it (see `docs/secrets-management.md`).
5. The XML-RPC API must be enabled: `$tlCfg->api->enabled = TRUE;` in
   `config.inc.php`. (The `imtnd/testlink` image ships with it already
   enabled.)

The user behind the key needs, in the target project: create/edit test
cases, and record executions against the plan.

---

## 4. The four `.env` values

```
# CONFIRMED working value (the MCP runs in a container; localhost won't reach
# the host, and the MCP needs the XML-RPC endpoint, not the web root):
TESTLINK_URL=http://host.docker.internal:8080/testlink/lib/api/xmlrpc/v1/xmlrpc.php
TESTLINK_API_KEY=<from §3>                     # write-capable; put in .env yourself
TESTLINK_PROJECT_KEY=AIQA                      # the project PREFIX
TESTLINK_TEST_PLAN_ID=2                         # the numeric test plan id
```

> **Verified during TG3 live setup:** from inside a Docker container,
> `http://host.docker.internal:8080/testlink/lib/api/xmlrpc/v1/xmlrpc.php`
> returns HTTP 500 to a plain GET — which is the _correct_ response (the
> XML-RPC endpoint only accepts POST bodies); it proves reachability. The
> earlier `http://localhost:8080/testlink` value returned HTTP 000 from the
> MCP container (localhost = the container itself) and made the `testlink`
> MCP show **Failed** in `/mcp`. Use the `host.docker.internal` + xmlrpc-path
> form above.

`TESTLINK_PROJECT_KEY` is the project **prefix** (e.g. `AIQA`), not the
display name. `TESTLINK_TEST_PLAN_ID` is the numeric id — older TestLink
doesn't show it in the URL; read it from the DB
(`SELECT id FROM testplans` joined on `nodes_hierarchy` for the name) or
ask the agent to query it.

---

## 5. Recommended project / suite structure

- **One Test Project** for the pipeline (e.g. `AI QA Pipeline`, prefix
  `AIQA`). All synced cases live here.
- **One Test Suite per feature / story area** inside the project. The
  adapter creates a suite named after the story (e.g. `STORY-002 —
Account access`) and puts that story's approved cases under it. This
  keeps TestLink browsable and mirrors our per-story `test-cases/*.json`.
- **One Test Plan per release / regression cycle** (e.g. `QA Pipeline
Regression`, id `2`). Execution results report against the plan.
  Cases are added to the plan when they're synced.

---

## 6. Field mapping (our `test-cases.json` → TestLink)

The adapter maps fields via `config/testlink-field-map.json` (created in
TG4) — never hardcoded. The canonical mapping:

| Our field (`test-cases/*.json`)  | TestLink field                    | Notes                                                                         |
| -------------------------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| `test_case_id` (`TC-XXX`)        | `external_id` (or a custom field) | The linkage key. Written back to our JSON as `testlink_id` after create.      |
| `title`                          | `name`                            |                                                                               |
| `description`                    | `summary`                         |                                                                               |
| `preconditions` (array)          | `preconditions`                   | Joined to TestLink's HTML preconditions field.                                |
| `steps` (array of {action,data}) | `steps`                           | Mapped to TestLink's actions/expected step format.                            |
| `expected_results` (array)       | step `expected_results`           | Paired with the steps.                                                        |
| `priority` (`P0`–`P3`)           | `importance`                      | P0/P1 → High(3), P2 → Medium(2), P3 → Low(1) (configurable in the field map). |
| `automation_decision`            | `execution_type`                  | `automate_*` → automated(2); `manual`/`skip` → manual(1).                     |
| `status` (`approved` only)       | — (filter)                        | Only `approved` cases are synced at all.                                      |

Execution-result status mapping (our outcome → TestLink status) lives in
`config/testlink-status-map.json` and is wired in Phase 2 TG10 via
`scripts/sync-testlink-execution.js` (the Reporter's optional result
sync, dry-run by default, `--apply-testlink-execution` to write). The
outcome key is the failure's `classification`, or `skipped`, or `passed`
for a case with a `testlink_id` and no failure. The map:

| Our outcome                                                                         | TestLink status |
| ----------------------------------------------------------------------------------- | --------------- |
| passed                                                                              | Pass            |
| product_bug                                                                         | Fail            |
| flaky / environment_issue / test_bug / test_data_issue / unknown_needs_human_review | Blocked         |
| skipped                                                                             | Not Run         |

---

## 7. Verifying the connection (TG3 DoD)

With `.env` populated and Claude Code restarted so the `testlink` MCP
loads, ask the agent:

> List TestLink projects.

Expected: at least the `AI QA Pipeline` (`AIQA`) project comes back.

Because the MCP needs the live instance + key, **the human runs this
check** — the agent can't reach your local TestLink container from a
fresh restart on your behalf without the loaded MCP. If it returns the
project, the connection works and TG3 is verified.

If it fails: re-check the §2 URL gotchas (XML-RPC path + Docker
networking) first — those are the usual culprits.

---

## 8. Local-instance gotchas (from standing one up)

These bit us setting up the dev instance; recorded so they don't bite
again:

- **Bitnami TestLink images are dead** (removed from Docker Hub in 2025).
  The working image is `imtnd/testlink:latest` (TestLink 1.9.14).
- **`icellmobilsoft/testlink:1.9.19-1-hu`** crashes on init — it hardcodes
  the Hungarian locale (`hu_HU`) which isn't shipped. Avoid.
- **MySQL 5.7 strict mode breaks the 1.9.x schema.** TestLink 1.9.x SQL
  uses zero-dates; MySQL 5.7's default `STRICT_TRANS_TABLES` +
  `NO_ZERO_DATE` make `CREATE TABLE` fail. Fix: set
  `sql_mode=NO_ENGINE_SUBSTITUTION` (we persisted it via a
  `/etc/mysql/conf.d/*.cnf` file in the DB container).
- **The DB-user password must match TestLink's `config_db.inc.php`.** If
  you drop/recreate the `testlink` MySQL user, set its password to the
  value the installer wrote (`testlink123`) or the login page throws
  `1045 Access denied`.
- **The `conf.d` sql_mode file lives in the container's writable layer**,
  not a named volume — `docker rm` the DB container and you lose both the
  config and the data. Don't delete the DB container casually.
- **Older TestLink hides the test-plan id** — it's not in the URL. Read
  it from the DB.
- **The `imtnd` app container is not `docker start`-safe.** Its
  entrypoint exits cleanly (`Exited (0)`) on a restart because it finds
  Apache's leftover pid from the previous boot — so after a Docker
  Desktop restart the app container stays down and the `testlink` MCP
  shows **Failed**. Fix: recreate the **app** container fresh
  (`docker rm -f testlink` then the original `docker run ... -p 8080:80
--restart unless-stopped imtnd/testlink:latest`) — **keep
  `testlink-db`**, your data lives there. A `--restart` policy alone
  does NOT fix it (it just loops `Restarting (0)`); the container must
  be recreated via `docker run`. The DB container restarts fine.

To bring TestLink back up after a host/Docker restart:

```powershell
docker start testlink-db                 # DB restarts cleanly
docker rm -f testlink                     # app is not start-safe — recreate
docker run -d --name testlink --network testlink-net -p 8080:80 `
  --restart unless-stopped imtnd/testlink:latest
```

TestLink version (1.9.14 vs 1.9.20) does not matter to this integration:
the XML-RPC API is identical across 1.9.x.

---

## 9. References

- `agents/test-management-adapter.md` — the port TestLink implements.
- `skills/syncing-testlink/SKILL.md` — the adapter (TG4).
- `scripts/sync-to-testlink.js` — the test-case sync script (TG4),
  invoked optionally by the Test Designer with `--apply-testlink`.
- `scripts/sync-testlink-execution.js` — the execution-result sync
  (TG10), invoked optionally by the Reporter with
  `--apply-testlink-execution`.
- `config/testlink-field-map.json` / `config/testlink-status-map.json`
  — the (human-editable) mappings.
- `docs/secrets-management.md` — TestLink key handling.
