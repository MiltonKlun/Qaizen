# Security & Data Safety

> **Status:** Phase 3 (TG9). This document is the single reference for the
> pipeline's data-safety posture: what data may enter an LLM prompt, how test
> data is sourced, how traces and screenshots are kept clean of sensitive
> values, and the result of the credential-logging audit. For credential
> _handling_ specifically (where tokens live, how they reach CI), see
> `docs/secrets-management.md` — this doc does not duplicate it, it builds on it.

The pipeline drives a real application, talks to real services (Jira, TestLink,
Postman, the app under test), and feeds artifacts into LLM prompts. Each of
those is a place sensitive data could leak — into a prompt, a report, a trace, a
build artifact, or a log. This document states the rules that prevent that and
records the audit that confirmed the current code obeys them.

The governing principle, consistent with `CLAUDE.md`: **the pipeline never
needs production data to do its job.** Everything it does — design cases, drive
the app, classify failures, report — works on synthetic data against a
non-production target. There is no scenario in this design that requires real
customer data, so there is no scenario in which leaking it is an acceptable
trade-off.

---

## 1. The rules at a glance

| Area               | Rule                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| Secrets in prompts | No secret ever enters an LLM prompt. Reference env-var **names**, never values.                       |
| Secrets in reports | No release report, failure analysis, or bug draft contains a literal token, cookie, or password.      |
| Logs               | Mask credentials. Never `console.log` a token, `Authorization` header, cookie, or password.           |
| Test data          | Test fixtures use **synthetic** data only. No production data in fixtures or in prompts.              |
| Target environment | Point the pipeline at **staging/dev with synthetic data only** — never a production-data instance.    |
| Traces/screenshots | Captured artifacts may contain typed credentials; treat them as sensitive, redact or scope them (§4). |
| LLM prompt limits  | Pass large artifacts by **path**, summarized; never paste raw reports, traces, or full logs (§5).     |

---

## 2. Secret handling (pointer, not a copy)

`docs/secrets-management.md` is the authority for:

- The one rule — credentials live in `.env` (local) or the CI secret store,
  never in a committed file.
- Creating each token (Jira, TestLink, Postman, reqres) and adding it to
  `.env.example` as an empty key.
- Run-time injection (`--env-var "api_key=$REQRES_API_KEY"`) so committed
  files keep secrets empty.
- The known Newman-results leak (A5): a results file can capture a live
  `x-api-key` header; scrub auth headers before CI uploads it.
- Rotation, and the pre-commit checklist.

This document adds the data-safety surface _around_ those secrets: prompts,
test data, the target environment, and captured evidence.

---

## 3. Test-data policy

**Synthetic data only.** Every fixture, every credential used to drive the app
under test, every value pasted into a test case must be synthetic — invented for
testing, traceable to no real person.

- The reference target is `saucedemo.com`, a public demo app with published
  throwaway logins (`standard_user`, `locked_out_user`, etc.). These are
  synthetic by construction — safe to commit, safe to put in a spec, safe in a
  trace.
- When the pipeline is pointed at a different app (this project is
  generic/reusable), the same rule binds: drive it with **test accounts that
  hold no real data**, on a **non-production** instance.
- **No production data in an LLM prompt — ever.** Not in the story, not in a
  fixture, not in a failure excerpt. If a real user record would be needed to
  reproduce a bug, describe it abstractly ("a user whose cart total exceeds the
  free-shipping threshold"), do not paste the record.
- If the app under test only exists with production data in some instance, **do
  not point the pipeline there.** Stand up a staging/dev instance with synthetic
  data first. This is a hard stop, not a preference.

---

## 4. Traces, screenshots, and video

Playwright capture is configured conservatively in `playwright.config.ts`:

```ts
use: {
  trace: 'on-first-retry',
  screenshot: 'only-on-failure',
}
```

So nothing is captured on a green run, and traces only on a retry. But **a
trace or screenshot of a login flow records the credentials that were typed** —
even synthetic ones, and certainly any real one if the rules above were
violated. Treat every captured artifact as sensitive:

- **Keep them out of git.** `reports/`, `traces/`, and `screenshots/` are
  gitignored (and `runs/**/reports|traces|screenshots/` for archived runs).
  They live as CI artifacts with a retention window, not in history.
- **They are secret-bearing in CI.** A trace uploaded as a build artifact is
  downloadable by anyone with repo access. Because we drive synthetic logins,
  this is acceptable for the demo target — but if the pipeline is pointed at an
  app where the typed values are sensitive, **mask the inputs or restrict the
  artifact**.
- **Reducing what gets captured:**
  - Lower capture: `trace: 'off'` / `screenshot: 'off'` for a suite that drives
    a sensitive app, accepting the loss of debug evidence.
  - Mask at the source: type sensitive values via a step that the test does not
    snapshot around, or use a fixture that injects them outside the recorded
    actions.
  - Redact after the fact: a trace is a zip of JSON + resources; a sensitive
    value can be scrubbed from the captured network/snapshot data before the
    artifact is shared. Do this before uploading anywhere others can read it.
- **Never paste a trace or screenshot into an LLM prompt.** The Failure
  Classifier and Reporter consume `evidence_paths` and summarized JSON, not the
  raw artifact (§5).

---

## 5. LLM prompt data limits

`context.json` is a **manifest**: it carries _paths to_ large artifacts, never
their contents (`docs/context-json-guide.md`). That token-efficiency rule is
also a data-safety rule — what is never inlined cannot leak through a prompt.

- Agents load **only** the files their step needs, by path.
- The Reporter and Failure Classifier consume **summarized** failure analysis +
  `evidence_paths`, not raw HTML reports, traces, screenshots, or full logs.
- Never paste a full report, a trace, a large log, or a database dump into a
  prompt. If a failure excerpt is needed, include the **minimal** relevant lines
  — and confirm they carry no secret or production value first.
- Phase 3 TG7 (token-efficient context handling) formalizes the per-agent
  "loads only these files" declaration; the data-safety motivation is here.

---

## 6. Credential-logging audit (Phase 3 TG9)

Audited every `agents/*.md` and every `scripts/*.js` for credential exposure.
Method: searched for credential identifiers (`*_TOKEN`, `*_API_KEY`,
`PASSWORD`, `SECRET`, `Authorization`, `cookie`) and inspected every
`console.*` / stdout / stderr site near them.

**Result: clean.** Findings:

- **Scripts read secrets from `env` and use them only inside an
  `Authorization` header** (`fetch-jira-story.js`, `create-jira-bugs.js`,
  `create-jira-testcases.js`, `sync-to-testlink.js`,
  `sync-testlink-execution.js`). The token value is composed into the header
  and never printed.
- **Error messages reference env-var _names_, never values** — e.g.
  `'Requires JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN in .env.'`. No
  `console.*` call anywhere emits a token, auth string, cookie, or password.
- **`run-newman.js`** injects `REQRES_API_KEY` via `--env-var` at run time so
  the committed environment file stays empty; it does not log the value. (The
  separate Newman-_results_ leak is tracked in `docs/secrets-management.md` §5
  / ambiguities A5 — scrub before CI upload.)
- **Agent prompts** already instruct: credentials from env, never hardcoded
  into collections/specs/reports (`api-agent.md`, `test-management-adapter.md`).
  No prompt instructs an agent to print or inline a secret.

**Standing rule for new code:** before adding a `console.*`, `print`, or report
field, confirm it cannot carry a token, cookie, password, `Authorization`
header, or production value. If a value _might_ be sensitive, log a masked form
(`****` + last 4) or omit it. Re-run this audit when a new script or agent that
touches credentials is added.

---

## 7. Checklist before pointing the pipeline at a new app

- [ ] Target is a **staging/dev** instance, not production.
- [ ] The instance holds **synthetic** data only.
- [ ] Test/login accounts hold **no real user data**.
- [ ] Trace/screenshot capture level is appropriate for the app's sensitivity
      (§4) — lowered or masked if typed values are sensitive.
- [ ] No production value will reach a fixture, a spec, a report, or a prompt.
- [ ] New credentials added per `docs/secrets-management.md` (`.env` + empty
      `.env.example` key + CI secret store; not exposed to fork-PR jobs).

---

## 8. References

- `docs/secrets-management.md` — credential handling, CI secrets, rotation.
- `docs/context-json-guide.md` — manifest rule (paths, not contents) and
  token-efficient context handling.
- `docs/ambiguities.md` A5 — the Newman-results secret-leak follow-up.
- `playwright.config.ts` — trace/screenshot capture configuration.
