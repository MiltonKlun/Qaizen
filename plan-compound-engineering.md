# Plan — Compound Engineering (CE) adoption

> **Status:** planned, not started. Derived from the CE evaluation in this
> project's history (the `everyinc/compound-engineering-plugin` + the every.to
> guide). **Decision recorded there: borrow the frame, do NOT install the
> plugin wholesale, and explicitly reject CE's Stage-5 autonomy endpoint.**
> This plan implements that decision as small, atomic, own-PR steps.
>
> **Core divergence (binding for every task below):** CE trends toward removing
> the human ("operate with smaller headcount", Stage-5 proactive agents). This
> project's non-negotiable is the opposite — **Gate 4 is permanently human, no
> autonomous batch** (`CLAUDE.md` §3.5, Phase 3 §2). Every CE primitive adopted
> here keeps the human gate where CE would remove it.

This project already independently embodies CE's "compound step":
`/evolve` ≈ `/ce-compound`, the retrospectives ≈ pulse reports, `CLAUDE.md` ≈
"taste extraction". So this plan is mostly **naming + filling the front-of-loop
gap (strategy/ideate/brainstorm)** the pipeline lacks — not rebuilding what
exists. Reuse-first (`CLAUDE.md` §3.9): prefer mapping to existing primitives
over adding a dependency.

**Discipline (same as every phase plan):** each Task Group ships as its own
branch → PR → green CI → merge. One PR off `main` at a time. A schema change
triggers the Architecture Stability Rule (schema + agents + docs + examples +
migration in ONE PR). Stop-and-ask before introducing a new dependency.

---

## Order of work (sequential)

1. **CE-1** — Evaluation & decision doc (the anchor; do first).
2. **CE-2** — Vocabulary map (CE term ↔ this project's primitive).
3. **CE-3** — `STRATEGY.md` product anchor (front-of-loop, missing today).
4. **CE-4** — Lightweight ideate/brainstorm front-end (own skills, no plugin).
5. **CE-5** — Reconcile the compound loop (`/evolve` ↔ `/ce-compound`) — no duplication.
6. **CE-6** — (Gated) re-evaluate the plugin itself, with a trigger.

---

## CE-1 — Evaluation & decision doc

Anchor the whole plan in one reviewed decision, mirroring the dual-judge format
(`docs/dual-judge-evaluation.md`).

- [ ] Create `docs/compound-engineering.md`:
  - [ ] §1 What CE is (philosophy + the 7-step loop ideate→…→compound).
  - [ ] §2 Where this project already embodies it (evidence: `/evolve`,
        retrospectives, `CLAUDE.md`, metrics, prompt-versioning).
  - [ ] §3 The deliberate divergence on autonomy (keep the human gate; reject
        Stage-5 "smaller headcount" endpoint). State it as binding.
  - [ ] §4 Decision: **borrow the frame, do not install the plugin now** —
        with reasons (overlap, external dep, QA-vs-engineering shape).
  - [ ] §5 Re-evaluation trigger for the plugin (see CE-6).

**Definition of Done:**

- [ ] Doc exists, reviewed, merged.
- [ ] Cross-referenced from `README.md` §12 (continuous-improvement) and
      `PHASE3-RETROSPECTIVE.md` §10.
- [ ] No code/schema change (doc-only PR).

---

## CE-2 — Vocabulary map (CE term ↔ project primitive)

Make the equivalence explicit so the team can use CE language without confusion
or duplication.

- [ ] In `docs/compound-engineering.md`, add a mapping table:
  - [ ] `/ce-compound` ↔ `npm run evolve` + `/evolve` loop.
  - [ ] CE pulse reports ↔ `PHASE*-RETROSPECTIVE.md` + `npm run metrics`.
  - [ ] CE "taste extraction" ↔ `CLAUDE.md` + `docs/*` + agent prompts.
  - [ ] `/ce-code-review` ↔ Spec Reviewer (Gate 3) + the `code-review` skill.
  - [ ] `/ce-plan` + `/ce-work` ↔ the (future) thin gated runner (`plan-poor-fit-improvements.md` PFI-2).
  - [ ] Mark each row: **have it / partial / gap**.
- [ ] For each "gap" row, link the task that closes it (CE-3, CE-4).

**Definition of Done:**

- [ ] Table present; every CE primitive classified have/partial/gap.
- [ ] Gaps point at a concrete task. Doc-only PR.

---

## CE-3 — `STRATEGY.md` product anchor

CE's front-of-loop anchor; this project has no equivalent. Lightweight, doc-only.

- [ ] Create `STRATEGY.md` at repo root:
  - [ ] What this project is + is NOT (one paragraph each; reuse the memory/README framing).
  - [ ] The non-negotiables (4 gates, Gate 4 human, contracts, traceability, reuse-first) as the "taste" an agent must honor.
  - [ ] Current status (all phases complete; continuous-improvement mode).
  - [ ] What's intentionally out of scope (n8n, dashboards, autonomous batch — from the forbidden-work lists).
- [ ] Reference `STRATEGY.md` from `CLAUDE.md` §2 (read-order) and `README.md`.

**Definition of Done:**

- [ ] `STRATEGY.md` exists; agents/humans can read "what & why" in one place.
- [ ] No duplication of `CLAUDE.md` rules — it links, not copies. Doc-only PR.

---

## CE-4 — Lightweight ideate / brainstorm front-end

Close the genuine gap: the pipeline starts at a _story_, with no "is this worth
testing / what should we test first" step. Build as **own skills**, not the CE
plugin (reuse-first; no external dep).

- [ ] Decide the form (stop-and-ask if unsure): a `skills/qa-ideate/SKILL.md` + `skills/qa-brainstorm/SKILL.md`, OR a single `docs/qa-discovery.md`
      convention. Recommendation: skills, so they're invocable.
- [ ] **`qa-brainstorm`** — interactive AC/risk elicitation when a story is
      vague (the Analyst already flags ambiguities; this is the front-end that
      resolves them _before_ `context.json`).
  - [ ] Inputs: a raw story / ticket. Output: a refined story + open questions.
  - [ ] Never invents requirements (`CLAUDE.md` §3.7) — surfaces gaps, asks.
- [ ] **`qa-ideate`** — given a feature/epic, propose _which_ stories/areas
      carry the most test risk (prioritization aid), feeding Gate-2 scope.
- [ ] Wire both as **optional pre-Analyst** steps in the runbook (they do not
      replace Gate 1; they feed it).

**Definition of Done:**

- [ ] At least the brainstorm front-end exists and is documented.
- [ ] It feeds the existing flow (→ Analyst → Gate 1), never bypasses a gate.
- [ ] No new runtime dependency; no autonomous action.

---

## CE-5 — Reconcile the compound loop (no duplication)

Ensure there is **one** compound loop, not two competing ones.

- [ ] Audit `/evolve` vs `/ce-compound` overlap; confirm `/evolve` stays the
      single compound mechanism (it already reads metrics + session-summaries + git).
- [ ] In `docs/evolve-loop.md`, add a note: "this IS the CE compound step;
      `/ce-compound` is not separately adopted (see `docs/compound-engineering.md`)."
- [ ] If CE-4 added discovery skills, ensure their friction is also captured by
      `session-summary` so `/evolve` mines it (one loop, all sources).

**Definition of Done:**

- [ ] One documented compound loop; `/evolve` is it.
- [ ] No second, parallel "compound" command introduced. Doc-only PR.

---

## CE-6 — (Gated) re-evaluate installing the plugin

Only if the frame proves to need the actual tooling.

- [ ] **Trigger to re-open** (any one): the team adopts Cursor/Copilot/Codex and
      wants the CE layer there; OR the front-of-loop skills (CE-4) prove
      insufficient and the plugin's versions are clearly better; OR a coworker
      already uses CE and integration would reduce friction.
- [ ] If re-opened: spike the plugin in a throwaway branch, measure overlap vs
      benefit, and decide — **never** adopting its Stage-5 autonomy (CE-1 §3).

**Definition of Done:**

- [ ] Trigger documented in `docs/compound-engineering.md`.
- [ ] No install until a trigger fires + a human approves.

---

## Completion criteria (this plan)

- [ ] `docs/compound-engineering.md` exists (eval + decision + divergence + map + trigger).
- [ ] `STRATEGY.md` exists and is linked from `CLAUDE.md` + `README.md`.
- [ ] A brainstorm (and ideally ideate) front-end exists, feeding Gate 1.
- [ ] Exactly one compound loop, documented.
- [ ] The autonomy divergence is recorded and honored everywhere.
