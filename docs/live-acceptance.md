# Live Jira and TestLink acceptance

The steps that move each path in `docs/sync-recovery.md` §7 from **Pending**
to **Accepted**. The adapters are already tested against local fake services;
this run proves that a real Jira and a real TestLink instance accept their
requests. Every step is run by a person, and nothing is written until that
person types the apply flag.

---

## 1. Before you start

- **Targets.** Use a Jira project and a TestLink project and test plan that
  you are authorized to write to and that can hold throwaway items. Never a
  production project.
- **Credentials.** They go in the repository's `.env` (gitignored), or in the
  shell's environment, which wins over `.env`. Never in a run folder, a doc
  or a commit.
- **Issue types.** The Jira project must have the issue types the adapters
  create: `JIRA_TESTCASE_ISSUETYPE` (default `Test`) and `JIRA_BUG_ISSUETYPE`
  (default `Bug`).

| Variable                                        | Used by                                                    |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `TEST_MANAGEMENT_TOOL`                          | `testlink`, `jira`, `both`                                 |
| `TESTLINK_URL`                                  | TestLink (the XML-RPC endpoint; `localhost` for a CLI run) |
| `TESTLINK_API_KEY`, `TESTLINK_PROJECT_KEY`      | TestLink                                                   |
| `TESTLINK_TEST_PLAN_ID`                         | TestLink execution results                                 |
| `JIRA_URL`, `JIRA_USERNAME`, `JIRA_API_TOKEN`   | Jira                                                       |
| `JIRA_PROJECT_KEY`                              | Jira                                                       |
| `JIRA_TESTCASE_ISSUETYPE`, `JIRA_BUG_ISSUETYPE` | Jira (optional)                                            |

## 2. The source run

Run the offline demo and make every decision yourself:

```bash
npm run demo:pipeline
```

It prints its run folder, `runs/DEMO-1/<run-id>/`. When it completes, that
folder holds two approved cases (TC-001 passing, TC-002 failing), a finalized
failure analysis with one Red product bug (FAIL-001) and its bug draft
BUG-001. Every command below runs from that folder; the adapters take their
schemas, maps and `.env` from the repository (`docs/sync-recovery.md` §6).

```bash
cd runs/DEMO-1/<run-id>
```

DEMO-1 has no Jira story key, so the adapters create cases and bugs without
linking them to a story ("will not be linked" in the plan). Story linking is
accepted separately, on a Jira-sourced run (§6).

Each step is a dry run first. Read the plan, then repeat the command with the
apply flag.

## 3. TestLink

| Step | Command                                                                              | Expect                                                                               |
| ---- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 1    | `node ../../../scripts/sync-to-testlink.js DEMO-1`                                   | `Create 2 · skip 0`, then `DRY RUN`                                                  |
| 2    | `node ../../../scripts/sync-to-testlink.js DEMO-1 --apply-testlink`                  | Two cases in the suite `DEMO-1 — ...`; their ids written to `test-cases/DEMO-1.json` |
| 3    | Step 2 again                                                                         | `Create 0 · skip 2`; nothing new in TestLink                                         |
| 4    | `node ../../../scripts/sync-testlink-execution.js DEMO-1`                            | `To report: 2`: TC-001 `Pass (p)`, TC-002 `Fail (f)` (the confirmed product failure) |
| 5    | `node ../../../scripts/sync-testlink-execution.js DEMO-1 --apply-testlink-execution` | Both results visible on the test plan in TestLink                                    |

## 4. Jira

| Step | Command                                                         | Expect                                                              |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| 6    | `node ../../../scripts/create-jira-testcases.js DEMO-1`         | `Create 2`, `Story link: (no jira_issue_key ...)`, then `DRY RUN`   |
| 7    | `node ../../../scripts/create-jira-testcases.js DEMO-1 --apply` | Two issues; their keys written under `external_ids.jira`            |
| 8    | Step 7 again                                                    | `Create 0`; nothing new in Jira                                     |
| 9    | `node ../../../scripts/create-jira-bugs.js`                     | `To create: 1`, BUG-001 with priority `Highest`                     |
| 10   | `node ../../../scripts/create-jira-bugs.js --apply`             | One Bug issue; its key written into `release/bug-drafts/BUG-001.md` |
| 11   | Step 10 again                                                   | `Already filed (skipped): 1`; nothing new in Jira                   |

## 5. If a create ends without a clear answer

A timeout or dropped connection leaves that create **pending**: the script
says so and refuses further creates. Do not repeat the apply. Run the same
command with `--reconcile`, which searches for the item by its marker and
records it if it exists. If the search cannot settle it, look in Jira or
TestLink yourself and record what you find:

```bash
node ../../../scripts/create-jira-testcases.js DEMO-1 --resolve TC-001=<KEY>   # or TC-001=none
```

`docs/sync-recovery.md` §3–§4 describes every state. A pending create that you
settle this way is worth recording too: it is the recovery path working
against a real service.

## 6. Story linking

Linking a case or bug to its story needs a run whose story came from Jira
(`npm run pipeline -- --story <JIRA-KEY>` on a story in the disposable
project), so `context.json` carries `story.jira_issue_key`. Run steps 6 to 11
in that run's folder; the plans then show `Story link: <KEY>` and each create
is followed by a link.

## 7. Record the result

For each path, add to `docs/sync-recovery.md` §7: the date, the instance
(host and version, never credentials), the project or test plan, what was
created (ids or keys) and that the repeat created nothing. A path is
**Accepted** once that is written there.

The items stay in the disposable project; remove them there when you no
longer need them. The run folder is gitignored and can be deleted.
