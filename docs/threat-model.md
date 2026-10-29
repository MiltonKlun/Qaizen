# Threat model — agents that read untrusted text

Qaizen's agents read text written by other people: Jira stories and comments,
Confluence pages, pull-request diffs, the pages of the application under test,
API responses and Postman collections. Any of that text can carry
instructions. The human gates review what agents **produce**; this document
covers what agents can **do** while they work, which the gates cannot undo.

It describes the local, operator-driven setup: an operator runs Claude Code in
this repository, step by step, as `npm run pipeline` prints. CI runs no agent
(`.github/workflows/qa-pipeline.yml`).

## 1. What is worth protecting

| Asset               | Where it lives                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credentials         | `.env`: the Atlassian read credential (MCP), the Jira credential the scripts use, the GitHub token, the Postman key, TestLink credentials, test-user passwords for the app |
| Private content     | Jira projects and Confluence spaces, private repositories, Postman workspaces                                                                                              |
| External systems    | Jira and TestLink (writes), Postman workspaces, the GitHub repository                                                                                                      |
| The run's integrity | The artifacts each gate approves and the approval records                                                                                                                  |

## 2. Untrusted inputs, per agent step

A session is most dangerous when it combines all three of: untrusted input,
access to private data or credentials, and a way to change something or send
data out. Qaizen narrows the third leg for each step; it does not remove it.
Every session keeps Claude Code's built-in tools (shell, file edits, web
fetch), so for every step the permission prompts and `.claude/settings.json`
are the control over that leg, and some steps hold all three by the nature of
their job.

| Step                         | Untrusted input                                | Private access                                          | Can change state or send out                                                                                                             | What limits it                                                                                                 |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Analyst                      | Jira text and comments, Confluence, PR diffs   | Jira and Confluence (read), private repositories (read) | No MCP write tool (Atlassian and GitHub are read-only); built-in tools                                                                   | Permission prompts and the project policy                                                                      |
| Test Designer                | The story, through `context.json`              | No MCP server                                           | Built-in tools                                                                                                                           | Permission prompts and the project policy                                                                      |
| Planner, generator, healer   | Pages of the app under test                    | Test-user credentials for the app                       | The browser can navigate anywhere and submit forms; the native healer can edit files; built-in tools                                     | All three legs present: test environments and test-only users only; Gates 3 and 4 review the output afterwards |
| API agent                    | Collections, OpenAPI files, live API responses | The Postman workspace                                   | Postman minimal mode can create and update collections, environments, specs and workspaces, and create and publish mocks; built-in tools | All three legs present: Gates 3' and 4' review the collection afterwards                                       |
| Failure Classifier, Reporter | Test output and error messages                 | No MCP server                                           | Built-in tools; their bug drafts can later be filed to Jira                                                                              | Permission prompts; a person runs the filing script                                                            |
| Jira and TestLink writes     | The bug drafts and test cases being filed      | The Jira and TestLink credentials                       | Creating issues and cases                                                                                                                | A person runs the script with `--apply` (or `--apply-testlink`)                                                |

A gate reviews an artifact after the step that made it. It cannot undo
something an agent did while working.

## 3. Controls in place

- **No MCP server can write to Jira, Confluence or GitHub.** The Atlassian
  server runs with `READ_ONLY_MODE` and a read-only allowlist; the GitHub
  server loads three read tools with its own read-only and lockdown modes
  (`.mcp.json`, `docs/mcp-setup.md`).
- **Separate credentials.** The Atlassian MCP server uses its own credential,
  ideally from a read-only account; the write scripts use another one
  (`docs/secrets-management.md`).
- **One step, one session, only its servers.** The runner prints the command
  that starts each agent step with `--strict-mcp-config` and its config from
  `config/mcp/` (`docs/pipeline-runner.md` §3).
- **Writes are deterministic scripts behind an explicit flag.** Jira bugs and
  test cases (`scripts/create-jira-bugs.js`, `scripts/create-jira-testcases.js`)
  and TestLink sync (`scripts/sync-to-testlink.js --apply-testlink`,
  `scripts/sync-testlink-execution.js --apply-testlink-execution`) only print
  what they would do without the flag. The flag is a plain argument, not a
  terminal check, so an agent's shell could pass it too; see section 5.
- **A project permission policy.** `.claude/settings.json` denies Playwright's
  code-running tool, reading or editing `.env`, and force pushes; asks before
  `git push`, `npm install` and `npx -y`; and stops `npx` from downloading
  packages silently (`docs/security-and-data-safety.md` §5).
  `npm run check:agents` checks regenerated Playwright agents against it.
- **Hidden text is shown at Gate 1.** The brief flags comments, invisible
  characters and text addressed to an AI in `story.md`
  (`scripts/lib/hidden-text.js`, `docs/review-gates.md`).
- **Pinned dependencies.** MCP servers by digest or exact version, GitHub
  Actions by commit SHA, npm through the lockfile
  (`docs/dependency-maintenance.md`).
- **Healer patches are checked before review.** A candidate that goes through
  `npm run heal` may only change a locator string, is validated in an isolated
  copy and ends as a patch a person reviews (`docs/healer-guardrails.md`). The
  native healer agent itself can edit files, so start it only with the
  invocation in `docs/native-healer-handoff.md`.
- **Agents are told that text they read is data.** Defence in depth only: a
  prompt sentence is not a control.

## 4. OWASP Top 10 for Agentic Applications (2026)

Mapped from the [OWASP list](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)
to this setup.

| ID    | Risk                               | Relevance here                                 | Main controls                                                         | What remains                                                                                                                            |
| ----- | ---------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| ASI01 | Agent goal hijack                  | High: every agent reads text from other people | Read-only servers, per-step sessions, hidden-text check, gates        | An instruction the reviewer misses can still shape an artifact                                                                          |
| ASI02 | Tool misuse and exploitation       | High                                           | No MCP writes; permission policy; writes only through flagged scripts | Built-in shell and web tools, which could also run a write script with its flag; Postman minimal-mode writes, including published mocks |
| ASI03 | Identity and privilege abuse       | High                                           | Separate read credential; read-only GitHub token; per-step servers    | Until a read-only Atlassian account exists, the read token can write                                                                    |
| ASI04 | Agentic supply chain               | High                                           | Pinned servers and Actions; `npm_config_yes=false`; dependency review | `npx`-launched Postman's own dependencies are not pinned                                                                                |
| ASI05 | Unexpected code execution          | Medium                                         | `browser_run_code_unsafe` denied; generated agents checked            | Shell commands, under permission prompts                                                                                                |
| ASI06 | Memory and context poisoning       | Medium                                         | Agents load only their step's files; artifacts are schema-validated   | A poisoned story or page persists into later steps through the artifacts                                                                |
| ASI07 | Insecure inter-agent communication | Low                                            | Agents never talk to each other; they hand off validated files        | —                                                                                                                                       |
| ASI08 | Cascading failures                 | Medium                                         | Gates up to Gate 4; approvals bound to what was reviewed              | Classification, bug drafts and the release report after Gate 4 have no gate, and bug drafts can be filed to Jira                        |
| ASI09 | Human-agent trust exploitation     | High: the gates are the main control           | Briefs show mechanical checks; approvals are bound and recorded       | How often a reviewer catches a problem is not yet measured                                                                              |
| ASI10 | Rogue agents                       | Low: no autonomous loop                        | The runner never launches agents; the healer is bounded               | —                                                                                                                                       |

## 5. Residual risks and how to reduce them

- **Built-in tools stay available in every session.** Keep permission
  prompts on for shell commands and web fetches in agent sessions; do not run
  agent steps with permission checks bypassed.
- **The browser is not confined to the app under test.** Point agents only at
  test environments, use test-only users, and never give a test user access
  to production data.
- **The read credential may still write.** Create a read-only Atlassian
  account for `ATLASSIAN_READ_*` and a fine-grained, read-only GitHub token.
- **Human review is unmeasured.** Until gate catch rates are measured, treat a
  fast approval as unverified, especially for payment, permission and
  security stories.
- **An agent's shell could run a write script.** The scripts load the write
  credential from `.env` and act on a plain `--apply` argument. Keep shell
  permission prompts on, read every prompt that runs one of these scripts,
  and file bug drafts yourself after reading them: text injected upstream can
  travel into a draft after Gate 4, where no gate reviews it.
- **Reports can hold secrets.** A Playwright HTML report or trace can contain
  values typed into the app, and CI uploads the HTML report; see
  `docs/security-and-data-safety.md` §4 before pointing the pipeline at a
  real environment.
- **Drill it.** Periodically plant a harmless instruction in a test story and
  on a test page, run the Analyst and planner steps with their per-step
  configs, and confirm that no tool call follows it.
