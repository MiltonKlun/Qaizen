# Phase 2 — Retrospective

> **Status:** SKELETON — fill in during/after the TG13 vertical slice.
> This file's existence + team review is the final Phase 2 completion
> criterion (`phase2-integrations.md` §6). Do not start Phase 3 until this
> is written and reviewed. Convert relative dates to absolute.

---

## 1. Stories processed

List every story run end-to-end through the Phase 2 pipeline (Jira source).
Minimum 3.

| Story | Title | Branches (E2E / API) | Result (pass/cond/fail) | PR | Notes |
| ----- | ----- | -------------------- | ----------------------- | -- | ----- |
| SK-10 | valid user logs in successfully | E2E | | | |
| SK-13 | sort products by name and price | E2E + API | | | |
| SK-16 | complete checkout successfully | E2E | | | |

---

## 2. CI friction points

What was awkward in GitHub Actions?

- First-run setup (secrets, branch protection):
- `quality-checks` false positives / flakes:
- Playwright in CI (browser install, timing, BASE_URL):
- Newman in CI (REQRES_API_KEY, env injection):
- The `ci-summary` / artifact upload experience:
- The `contract-stability` warning — useful signal or noise?

---

## 3. Time per story

Rough wall-clock, to see where the cost is.

| Story | Analyst→Gate1 | Designer→Gate2 | E2E author→Gate4 | API author→Gate4' | Exec+report | TestLink/Jira sync | Total |
| ----- | ------------- | -------------- | ---------------- | ----------------- | ----------- | ------------------ | ----- |
| SK-10 | | | | (n/a) | | | |
| SK-13 | | | | | | | |
| SK-16 | | | | (n/a) | | | |

---

## 4. Are the gates still useful?

- Did any gate catch a real problem? Which, and what?
- Did Gate 1 and Gate 2 ever disagree, or are they always approved
  together? (If always together after enough runs → consider the TG7
  `qa_scope_approved` consolidation. If they diverged even once, keep them
  separate.)
- Did Gate 4 (and 4') stay worth the human time? (It is permanent
  regardless — but record whether it earned its keep.)

---

## 5. TestLink sync — smooth or friction?

- Did `sync-to-testlink.js --apply-testlink` create the cases cleanly?
- Did `testlink_id` write-back work / survive re-runs (idempotent)?
- Did execution-result sync (`--apply-testlink-execution`) map outcomes
  correctly (Pass/Fail/Blocked/Not Run)?
- Anything about the local TestLink container that bit you?

---

## 6. Jira bug creation — duplicates or clean?

- Did `create-jira-bugs.js --apply` file the Red bugs correctly?
- Did the de-dup (skip drafts with a filled `Jira Issue Key`) prevent
  duplicates on re-run?
- Did the story-link (`Relates`) attach to the right issue?
- Any priority/issue-type mapping surprises?

---

## 7. Recommendations for Phase 3 (controlled healing)

Phase 3 adds the Healer (Green-only auto-patches, never commits), Spec
Reviewer assist, `runs/` history, metrics, `/evolve`.

- Which failures in this slice would a Green-only Healer have safely fixed?
- Which were Yellow/Red and correctly stayed human?
- Did the single-occupancy artifact layout (`context.json` etc.) get
  painful across 3 stories? (This is the motivation for the Phase 3
  `runs/[story-id]/[run-id]/` layout.)
- Anything in the prompts that the evaluation harness (`npm run evaluate`)
  should start checking?

---

## 8. Phase 2 completion checklist

Tick when true (mirrors `phase2-integrations.md` §6):

- [ ] Jira story ingestion (Mode B) worked.
- [ ] Manual story input (Mode A) still works.
- [ ] TestLink test-case sync worked with the `--apply` flag.
- [ ] TestLink execution-result sync worked with the `--apply` flag.
- [ ] GitHub Actions ran `quality-checks` blocking on PRs.
- [ ] Playwright + Newman reports uploaded as CI artifacts.
- [ ] Jira bugs creatable from drafts, duplicate-safe, human-controlled.
- [ ] Review audit fields available (TG6) — backward-compatible.
- [ ] Gate consolidation option available (TG7) — backward-compatible.
- [ ] Evaluation dataset runs (`npm run evaluate`).
- [ ] 3+ stories processed end-to-end with Jira as source.
- [ ] This retrospective written and reviewed.
