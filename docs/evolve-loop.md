# The `/evolve` loop

> **Status:** Phase 3 (TG10). `/evolve` reads signals about how the pipeline is
> actually used and **proposes** grouped, scored improvements. It never applies
> a change — a human reviews and confirms each one. This is the same
> "script gathers + scores deterministically, human judges" pattern as the
> failure classifier and the healer harness.

The pipeline is a discipline layer over reusable parts. Over time, reality
drifts from the design: a step that was supposed to be automatic gets done by
hand every run, a doc describes a flag the code no longer has, the same kind of
fix lands three sprints in a row. `/evolve` is the scheduled moment to notice
that drift and decide what to do about it — deliberately, with a human in the
loop, never by silent self-rewrite.

---

## 1. What it reads

`scripts/evolve.js` (`npm run evolve`) gathers, each source optional and skipped
silently if absent:

| Source                          | What it tells `/evolve`                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git commits/merges (90d)        | Where effort concentrated; recurring fix/recover/revert themes (churn).                                                                                   |
| `metrics/pipeline-metrics.json` | Untested high-risk items, prompt-stability status (run `npm run metrics` first).                                                                          |
| `session-summaries/*.md`        | **Highest signal** — friction in the human's own words after a run.                                                                                       |
| GitHub issues                   | _Not_ fetched by the script (no token in a plain Node context) — fed via the agent path if the repo uses issues. Declared as a gap, not silently ignored. |

The script reads **subjects and bullet lines only** — never diffs, never raw
reports — consistent with the token-efficient / data-safety rules
(`docs/context-json-guide.md` §5.1, `docs/security-and-data-safety.md`).

---

## 2. How it scores

Confidence is deterministic, from occurrence counts — the plan's rule:
**3+ occurrences of a theme = high confidence.** 2 = medium, 1 = low.

- Session-summary bullets are grouped into coarse themes (stacked PRs, artifact
  clobber, recovery/rework, CI/merge friction). A theme mentioned 3+ times
  across summaries surfaces as a 🔴 high-confidence finding.
- Recurring fix/recover commit subjects raise a friction finding.
- Metrics flags (untested high-risk, prompt-stability not met) raise coverage /
  prompt findings.
- Usage patterns and input gaps are surfaced as ⚪ low-confidence context.

Findings sort high → medium → low.

---

## 3. What it writes

`evolve/evolve-proposal.{json,md}` (gitignored — regenerable). Each finding:

```
{ theme, confidence, evidence[], proposed_action, targets[] }
```

The proposal is a **suggestion**. `/evolve` never edits a prompt, schema, doc,
or script. The proposal's targets point at where a change _would_ go
(`CLAUDE.md`, `agents/`, `scripts/`, `docs/`); a human edits those, with the
usual discipline (e.g. a prompt change bumps the version and runs the
evaluation dataset — `docs/prompt-versioning.md`).

---

## 4. When to run it

Per the plan: **every 90 days or every 10 runs, whichever comes first.** Also a
good idea right after a phase retrospective, when friction is fresh.

The single highest-leverage habit is to capture a session note while the
friction is fresh:

```bash
npm run session-summary -- \
  --friction "stacked PRs orphaned again" \
  --timesink "rebuilding a story's spec after a clobber" \
  --note "metrics + list-runs were genuinely useful"
```

That writes `session-summaries/YYYY-MM-DD.md` (versioned — it is durable human
input, not a regenerable artifact). The next `/evolve` mines it.

---

## 5. How to accept or reject a suggestion

1. Run `npm run metrics` then `npm run evolve`.
2. Read `evolve/evolve-proposal.md`, top (🔴) findings first.
3. For each finding, decide:
   - **Accept** → make the change at the named target, with the right
     discipline (schema change ⇒ Architecture Stability Rule; prompt change ⇒
     version bump + evaluation; new rule ⇒ `CLAUDE.md`). Record the rationale
     (a commit message, or a line in the next retrospective).
   - **Defer** → leave it; it will resurface next run if it is real.
   - **Reject** → note why (e.g. the metric was stale), so it is not
     re-litigated each run.
4. Nothing is applied automatically. The human is the gate.

---

## 6. Worked example (the first real run)

The first `/evolve` run, against this repo's own 90-day history + the recorded
session summary, produced two 🔴 high-confidence findings that match exactly the
real systemic pain of building Phase 2–3:

- **stacked / orphaned PRs** (3 mentions) — PRs branched off another feature
  branch auto-closed when the base branch was deleted on merge. Accepted →
  hardened into the "one PR off main at a time" discipline.
- **artifact clobber / single-occupancy** (3 mentions) — a shared single-
  occupancy artifact got overwritten between stories. Accepted → addressed by
  the `runs/` archival model (TG5).

This is the loop working as intended: real friction in, scored proposal out,
human decides — no self-rewrite.

---

## 7. References

- `scripts/evolve.js` — the gatherer/scorer (`npm run evolve`).
- `scripts/session-summary.js` — capture friction (`npm run session-summary`).
- `docs/prompt-versioning.md` — discipline for accepting a prompt change.
- `docs/pipeline-architecture.md` §8.2 — metrics meanings + stability threshold.
- `phase3-healing-scaling.md` §6 — the continuous-improvement cadence.
