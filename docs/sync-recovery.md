# External sync recovery

How the three scripts that create items in external tools behave when
something goes wrong partway, and how to finish an interrupted sync without
creating anything twice.

| Script                             | Creates                       | Apply flag         |
| ---------------------------------- | ----------------------------- | ------------------ |
| `scripts/create-jira-testcases.js` | Test cases as Jira issues     | `--apply`          |
| `scripts/sync-to-testlink.js`      | Test cases in TestLink        | `--apply-testlink` |
| `scripts/create-jira-bugs.js`      | Bugs in Jira, from bug drafts | `--apply`          |

All three are dry-run by default. A dry run sends nothing and changes no
local file.

---

## 1. The guarantee

- **An acknowledged remote id is never lost.** Each create is recorded the
  moment the tool returns its id, before the story link and before the next
  item. A later failure cannot erase it.
- **An uncertain create is never repeated silently.** If a create may have
  happened but no usable answer came back, the item is blocked until that
  question is settled. The scripts never retry a create on their own.
- **A dry run is only a preview.** It makes no request and writes nothing,
  not even progress.

## 2. What is recorded

Each synced item carries a sync record per target: under
`test_cases[].sync_state.<target>` in `test-cases/<story>.json`, or in the
`## Sync State` section of a bug draft (`docs/bug-draft-format.md`). The shape
is defined once, in `schemas/test-cases.schema.json#/definitions/syncRecord`.

| Field                          | Meaning                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `operation_key`                | Stable identity: `target:project:story:local-id:kind`, e.g. `jira:SK:SK-10:TC-001:create_case`.      |
| `marker`                       | `qaizen-op-` plus 12 hex digits derived from the key. Sent with the create so it can be found again. |
| `payload_digest`               | SHA-256 of what was sent.                                                                            |
| `source_digest`                | SHA-256 of the local item when it was pushed; a later difference is reported as a local change.      |
| `state`                        | `pending`, `created`, `failed`, or `not_found` (below).                                              |
| `remote_id`                    | The Jira key or TestLink id, once known.                                                             |
| `link_state`                   | Story link for Jira items: `pending`, `linked`, `failed`, or `not_applicable`.                       |
| `intent_at`, `created_at`, ... | Timestamps.                                                                                          |
| `last_error`                   | Sanitized diagnostic of the last failure. Never contains credentials.                                |

The record describes where an item was pushed, not what it says, so writing
it never makes a Gate 2 approval stale (the same rule as `testlink_id` and
`external_ids`).

## 3. States

| State       | How it is reached                                                                        | Next `--apply` does              |
| ----------- | ---------------------------------------------------------------------------------------- | -------------------------------- |
| `pending`   | Saved before the create is sent; still set if the outcome is unknown.                    | Refuses: reconcile first.        |
| `created`   | The tool returned an id, or reconciliation found the item.                               | Skips it; retries a failed link. |
| `failed`    | The tool definitely refused (HTTP 4xx, an XML-RPC fault, or the request was never sent). | Creates it again.                |
| `not_found` | A pending create was reconciled and does not exist remotely.                             | Creates it again.                |

An outcome counts as **unknown** when the request timed out, the connection
dropped after sending, the tool answered with a 5xx, or it answered success
without a usable id. In all of these the item may exist, so it stays
`pending`.

### How each item is planned

Every run, dry or real, prints one line per item with the operation it
selects. A dry run and an apply on the same files select the same operations.

| Plan              | When                                                                                       | What `--apply` does                               |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `CREATE`          | No remote id is recorded.                                                                  | Creates it.                                       |
| `SKIP`            | A valid remote id is recorded, and every place that records it agrees.                     | Nothing. Existing remote items are never updated. |
| `LINK ONLY`       | Created, but its story link failed or is pending (Jira).                                   | Retries the link only.                            |
| `RECONCILE FIRST` | An earlier create has an unknown outcome.                                                  | Refuses every create (section 4).                 |
| `BLOCKED`         | A recorded id is malformed, or `testlink_id`, `external_ids` and the sync record disagree. | Leaves the item untouched and exits 1.            |

The scripts never edit an item that already exists remotely. When a linked
case has changed locally since it was pushed, its `SKIP` line says so
(`changed locally since it was pushed; ... is NOT updated`). Updating the
remote copy is a manual decision in the tool.

A `BLOCKED` item is never created, because it may already exist, and never
treated as linked, because its id cannot be trusted. Correct the id in the
file by hand: keep the right one, or remove a wrong one after checking the
tool.

## 4. Finishing an interrupted sync

1. Run the same script with `--reconcile`. It only reads from the tool:
   - Jira: searches the project for an issue labelled with the marker.
   - TestLink: looks up the case by name in the story's suite and accepts it
     only if its summary carries the marker.

   One match records the id (`created`). No match marks it `not_found`, so
   the next `--apply` creates it. Several matches, or a failed search, leave
   it `pending` and say so.

2. When reconciliation cannot decide, resolve it by hand after checking the
   tool:

   ```bash
   node scripts/create-jira-testcases.js SK-10 --resolve TC-002=SK-57   # it exists
   node scripts/create-jira-testcases.js SK-10 --resolve TC-002=none    # it does not
   ```

   This is also the fix when a script prints `CRITICAL: ... could not be
saved`: the tool created the item but the local file could not be
   written. The message gives the exact `--resolve` command.

3. Run `--apply` again. Items already created are skipped; only missing ones
   are created, and failed story links are retried without recreating the
   issue.

If a project rejects the `labels` field, the Jira create is resent without it
and the record notes `marker_searchable: false`. Such an item cannot be found
by `--reconcile`; resolve it by hand.

## 5. One sync at a time

Each target has a lock at `.qaizen/locks/<target>.lock` (gitignored), held
only while a sync writes. A second sync against the same target refuses while
the first is running. If a sync was killed and left its lock behind:

- On the same machine, re-run with `--release-stale-lock`. The lock is
  removed only if its process is gone.
- If the lock names another machine, or cannot be read, the script cannot
  prove it is stale. Check that no sync is running, then delete the file by
  hand.

## 6. Timeouts and selection

- Every request has a timeout: `QAIZEN_HTTP_TIMEOUT_MS` (default `30000`,
  allowed 100 to 120000).
- The test-case scripts run only when `TEST_MANAGEMENT_TOOL` selects them
  (`testlink`, `jira`, or `both`). An unset or unknown value is an error.
- Before any request, each script checks that its input belongs to the active
  story and run, and that the scope approval (Gate 2, or `qa_scope_approved`
  on the lite track) is current. Bug drafts must also name the active story
  and an approved test case.

## References

- `scripts/lib/integration-io.js` — the shared recovery logic.
- `docs/bug-draft-format.md` — the `## Sync State` section.
- `agents/test-management-adapter.md` — the adapter port.
- `docs/testlink-integration.md`, `skills/syncing-jira/SKILL.md` — the tools.
