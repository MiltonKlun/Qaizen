# Phase 2 vertical slice — runbook (TG13)

> **Purpose:** a step-by-step guide for running the full Phase 2 pipeline
> end-to-end across **3+ Jira-sourced stories**, with TestLink sync, Jira
> bug creation (`--apply`), and CI on every PR — then writing
> `PHASE2-RETROSPECTIVE.md`. This is the last task group of Phase 2.
>
> **Who does what:** the agent (Claude) drives the agent steps and the
> scripts. **You** approve the four human gates, push branches, open/merge
> PRs, and type every `--apply`. Writes to Jira/TestLink and git pushes are
> never automatic.

---

## 0. One-time setup (do this once, before story 1)

These are the TG13 blockers that aren't done yet. Knock them out first.

### 0.1 Git: first commit + remote

The repo has **no commits and no remote yet**. CI can't run until code is
pushed to GitHub.

```powershell
# from c:\Users\miste\Desktop\AI_QA
git add -A
git status                      # sanity: confirm .env is NOT listed (it's gitignored)
git commit -m "Phase 2 foundation: integrations, CI, scripts, docs"
git branch -M main              # the repo's main branch
git remote add origin https://github.com/MiltonKlun/AI-Assisted-QA.git
git push -u origin main
```

> **Check before pushing:** `git status` must NOT show `.env`. It's in
> `.gitignore`, but confirm — the `.env` holds live tokens. If you ever see
> it staged, `git restore --staged .env` and re-check `.gitignore`.

### 0.2 GitHub repo secrets / variables (for the informational CI jobs)

In the GitHub repo → **Settings → Secrets and variables → Actions**:

- **Variable** `BASE_URL` = `https://www.saucedemo.com` (optional; the
  workflow defaults to this).
- **Secret** `REQRES_API_KEY` = your reqres.in key (needed for the
  `newman-api` job's assertions).

> The Jira/TestLink `--apply` writes run **locally from your machine**
> (using `.env`), not in CI — so CI does **not** need the Jira/TestLink
> secrets. CI only runs quality checks + tests + summary.

### 0.3 Branch protection (so `quality-checks` actually gates)

Repo → **Settings → Branches → Add rule** for `main`:

- Require a pull request before merging.
- Require status checks to pass → select **`quality-checks`**.
- Leave `playwright-full`, `newman-api`, `contract-stability` **unchecked**
  (they're informational by design — see `docs/pipeline-architecture.md`
  §6.1).

### 0.4 Confirm TestLink is up (only needed when you do `--apply-testlink`)

TestLink runs in Docker locally. If you've restarted since last time:

```powershell
docker start testlink-db
docker rm -f testlink
docker run -d --name testlink --network testlink-net -p 8080:80 `
  --restart unless-stopped ai-qa-testlink:1.9.20
```

(See `docs/testlink-integration.md` §8 for why the app container is
recreated, not just started.)

### 0.5 Pick the 3 stories

Recommended (already in your `SK` project, AC-bearing, Saucedemo-aligned):

| Story     | Title                           | Branch mix       | Why                                             |
| --------- | ------------------------------- | ---------------- | ----------------------------------------------- |
| **SK-10** | valid user logs in successfully | pure E2E         | simplest — warm up the full chain               |
| **SK-13** | sort products by name and price | **E2E + API**    | exercises both branches + the API sort contract |
| **SK-16** | complete checkout successfully  | E2E (multi-step) | a longer UI journey                             |

You can swap any of these for SK-11/12/14/15/17/18 — they're all valid.
Three is the minimum; more is fine.

---

## 1. The per-story loop

Run this loop **once per story**. Steps marked **[YOU]** are yours; steps
marked **[AGENT]** are ones to ask Claude to do; **[SCRIPT]** is a command.

> **Artifact slots are single-occupancy.** `context.json`,
> `test-cases/<id>.json`, etc. describe _one_ run. Before starting a new
> story, the previous story's artifacts are either committed on its branch
> (so they're safe in git history) or you snapshot them. The runbook commits
> each story on its own branch, which preserves them. Don't start story 2
> until story 1's branch is pushed.

### Step 1 — [YOU] Start a branch for the story

```powershell
git checkout main
git pull
git checkout -b slice/SK-10
```

### Step 2 — [SCRIPT] Fetch the Jira story (Mode B, read-only)

```powershell
npm run fetch-story SK-10            # writes story.md from the Jira issue
```

This writes `story.md`. Jira is **not** modified.

### Step 3 — [AGENT] Run the Analyst (Mode B)

Ask Claude: **"Run the Analyst on story.md in Mode B for SK-10."**
It produces `context.json` with `story.source = "jira"`,
`story.id = "SK-10"`, `story.jira_issue_key = "SK-10"`, mints risks, and
stops at Gate 1.

```powershell
npm run validate:context             # must exit 0
```

### Step 3.5 — [OPTIONAL][YOU] "Pipeline started" Jira comment

Only if you want it. Ask Claude explicitly: **"post the pipeline-started
comment on SK-10."** Requires `atlassian-write` + your explicit ask
(`agents/analyst.md` §2). Skip otherwise.

### Step 4 — [YOU] GATE 1 — Requirement Interpretation

Read `context.json` against the Jira issue. Criteria in
`docs/review-gates.md` §"Gate 1". When satisfied, tell Claude:
**"Gate 1 approved"** (optionally: "by <name>, note: <reason>" to use the
audit-field form). Claude flips `requirements_reviewed` and re-validates.

> If you reject: say what's wrong; Claude re-runs the Analyst. Do not
> proceed until the gate is green.

### Step 5 — [AGENT] Run the Test Designer

Ask: **"Run the Test Designer for SK-10."** Produces
`test-cases/SK-10.json` + `planner-input/SK-10.planner-brief.md`, stops at
Gate 2.

```powershell
node scripts/validate-json.js schemas/test-cases.schema.json test-cases/SK-10.json
```

### Step 6 — [YOU] GATE 2 — Test Scope Approval

Review per `docs/review-gates.md` §"Gate 2" (risk coverage, priorities,
automation decisions justified, not E2E-heavy). Then mark each TC
`approved`/`rejected` and tell Claude **"Gate 2 approved"**.

### Step 6.5 — [OPTIONAL][SCRIPT] Sync approved cases to TestLink

Dry-run first (always safe):

```powershell
node scripts/sync-to-testlink.js SK-10                  # preview
node scripts/sync-to-testlink.js SK-10 --apply-testlink # real write — YOU type --apply
```

Writes `testlink_id` back into `test-cases/SK-10.json`. (Needs TestLink up,
§0.4.)

### Step 7 — Branch per sub-flow

**E2E branch (every story):**

- **[AGENT]** Ask: **"Run the Playwright Planner for SK-10."** → `specs/SK-10.md`.
- **[YOU] GATE 3 — Specs Review** (`docs/review-gates.md` §"Gate 3"). Approve.
- **[AGENT]** Ask: **"Run the Playwright Generator for SK-10."** → `tests/SK-10.spec.ts`.
- **[YOU] GATE 4 — Code Review** (permanent human gate). Approve.

**API branch (only stories with `automate_api` cases, e.g. SK-13):**

- **[AGENT]** Ask: **"Run the API Agent for SK-13."** → collection + environment.
- **[YOU] GATE 3' — Collection Review**, then **GATE 4' — API Assertion Review**.

### Step 8 — [SCRIPT] Execute

```powershell
npm test                             # Playwright -> reports/results.json
$env:STORY_ID="SK-13"; npm run test:api   # Newman (only if API branch) -> reports/newman-results.json
```

### Step 9 — [AGENT] Failure Classifier → Reporter

Ask: **"Run the Failure Classifier, then the Reporter, for SK-10."**
Produces `analysis/failure-analysis.json`, any `release/bug-drafts/BUG-*.md`
(Red only), and `release/release-report.{md,json}`.

```powershell
node scripts/validate-json.js schemas/failure-analysis.schema.json analysis/failure-analysis.json
node scripts/validate-json.js schemas/release-report.schema.json release/release-report.json
```

### Step 10 — [SCRIPT] Validate everything + local CI preview

```powershell
npm run validate:all                 # all committed artifacts
npm run ci:summary                   # the table CI will post
```

### Step 11 — [YOU] Commit + push + open PR

```powershell
git add -A
git status                           # confirm no .env, no reports/
git commit -m "QA slice SK-10: context, test cases, spec, test, analysis, report"
git push -u origin slice/SK-10
```

Open a PR to `main` on GitHub. **CI runs now:** `quality-checks` (blocking),
`playwright-full` / `newman-api` / `contract-stability` (informational), and
`ci-summary` posts the table to the PR.

### Step 12 — [OPTIONAL][SCRIPT] Promote Red bug drafts to Jira

Only if the Failure Classifier produced Red bug drafts you've reviewed:

```powershell
node scripts/create-jira-bugs.js                 # dry-run: shows what it would file
node scripts/create-jira-bugs.js --apply         # real Jira issues — YOU type --apply
```

Each bug links back to the story issue (since `story.jira_issue_key` is set
in Mode B) and the new key is written back into the draft.

### Step 13 — [OPTIONAL][SCRIPT] Sync execution results to TestLink

```powershell
node scripts/sync-testlink-execution.js SK-10                            # preview
node scripts/sync-testlink-execution.js SK-10 --apply-testlink-execution # real — YOU type the flag
```

### Step 14 — [YOU] Review + merge the PR

After `quality-checks` is green and you've reviewed, merge. CI never merges
for you.

### Step 15 — [YOU] Post-run habits (continuous improvement)

Two cheap habits that keep the system's own feedback loop honest — do them
right after the run, while it's fresh:

- **Record the gate decisions.** Append each Gate 1–4 approval/rejection to
  `context.json.gate_decisions[]` (especially a _rejection_ and why). This is
  what makes the per-run Gate 3/4 rejection metric — and the prompt-stability
  signal — real (`docs/review-gates.md`). `npm run migrate:gate-decisions`
  seeds an empty log if the context lacks one.
- **Write a session summary.** One line about what rubbed:
  ```bash
  npm run session-summary -- --friction "…" --timesink "…" --note "…"
  ```
  It writes a versioned `session-summaries/<date>.md` — the highest-signal
  source `/evolve` mines (`docs/evolve-loop.md`).

Then archive the run with `npm run new-run <story-id>` so `runs/` keeps the
history (and `gate_decisions` + `prompt_versions` travel with it).

---

## 2. Repeat for stories 2 and 3

Back to Step 1 with `SK-13`, then `SK-16` (each on its own
`slice/SK-13`, `slice/SK-16` branch). SK-13 is the one that exercises the
**API branch** (Step 7 API sub-flow + Step 8 Newman).

> After merging each story's PR, `git checkout main && git pull` before
> branching the next, so each branch starts from the merged state.

---

## 3. After 3 stories — write the retrospective

`PHASE2-RETROSPECTIVE.md` already exists as a skeleton with prompts. Fill
it in from what you observed: stories processed, CI friction, time per
story, whether the gates stayed useful (or want consolidating per TG7),
whether TestLink sync was smooth, whether Jira bug creation duplicated
anything, and recommendations for Phase 3 (controlled healing).

That file's existence + review is the final Phase 2 completion criterion.

---

## 4. Quick reference — the `--apply` operations (all yours to type)

| Operation                     | Command                                                                   | Writes to |
| ----------------------------- | ------------------------------------------------------------------------- | --------- |
| Sync test cases to TestLink   | `node scripts/sync-to-testlink.js <id> --apply-testlink`                  | TestLink  |
| Promote bug drafts to Jira    | `node scripts/create-jira-bugs.js --apply`                                | Jira      |
| Sync exec results to TestLink | `node scripts/sync-testlink-execution.js <id> --apply-testlink-execution` | TestLink  |
| Pipeline-started Jira comment | (ask the Analyst explicitly)                                              | Jira      |

Every one is dry-run by default. Nothing writes outward without the flag
you type. CI never runs any of these.

---

## 5. If something goes wrong

- **A gate isn't satisfied** → reject, tell Claude what's wrong, it re-runs
  that agent. Don't flip the gate to proceed.
- **`quality-checks` red on the PR** → run `npm run typecheck`,
  `npm run lint`, `npm run format:check`, `npm run validate:all` locally;
  fix; push again.
- **TestLink `--apply` fails** → confirm the container is up (§0.4) and
  `TESTLINK_*` in `.env`; the script prints the XML-RPC fault.
- **Jira `--apply` fails** → the script prints the REST error; check the
  issue type exists (`JIRA_BUG_ISSUETYPE`) and the token is still valid.
- **A schema needed to change mid-slice** → STOP. That's the Architecture
  Stability Rule (`CLAUDE.md` §3.10) — schema + agents + docs + examples +
  migration in one change, as its own PR, not buried in a story slice.

---

## References

- `phase2-integrations.md` TG13 — the plan this runbook executes.
- `docs/review-gates.md` — the four gate criteria.
- `docs/pipeline-architecture.md` §6.1 — the CI job model.
- `docs/testlink-integration.md` — TestLink setup + sync.
- `docs/bug-draft-format.md` — the bug-draft format the promotion reads.
- `agents/analyst.md` §2 — Mode B + the optional comment.
