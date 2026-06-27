# STRATEGY.md — what this project is, and the question it answers

> One page. `CLAUDE.md` is the binding operating manual and `README.md` is the
> project overview; this is the shorter "why does this exist and what is it
> betting on" that an agent or a new teammate can read in a minute.

## The tension (the reason this project exists)

**Why use this ceremony — schemas, four gates, traceability, versioned prompts
— instead of just asking an AI to "write Playwright tests for this story"?**

That is the honest, central question. Raw prompting is
faster to first output. This pipeline is slower but buys **auditability,
repeatability, traceability, and a guarantee that tests were written against
the running app, not invented from text.** Whether that trade is worth it is
not asserted here — it is _measured_ (`docs/evidence.md`, the
pipeline-vs-raw benchmark). Until that run series lands, the project says so
plainly rather than overclaiming.

## The answer the system gives

Not "always use the pipeline." The answer is **tiered, and honest about its own
limits** (`docs/when-to-use.md`):

- High-stakes / red-domain / auditable work → the full pipeline; the value is
  the discipline.
- Routine, low-risk work → the **lite track** (less prose, same validation and
  traceability), with a **principled floor** that refuses lite for
  money/permissions/security/data/compliance work.
- Trivial, throwaway work → **don't use the pipeline**; prompt directly, knowing
  exactly what you forfeit.
- Want one capability, not the flow → an **à-la-carte piece**
  (`docs/standalone-*.md`).

## The non-negotiables (the "taste" any agent must honor)

These never bend, in any phase (`CLAUDE.md` §3):

1. **Four human gates; Gate 4 is permanently human.** No flag, no CI job, no
   agent can pass a gate — the runner refuses non-TTY approval by construction.
2. **Traceability:** STORY → RISK → TC → SPEC/API → PW/REQ → FAIL → BUG. No
   faked links; an unresolvable one is recorded as such.
3. **Validate before saving:** every JSON artifact against its schema, through
   the one generic validator.
4. **Healer guardrails:** Green/Yellow/Red; never commit/merge, never weaken or
   delete a test.
5. **Reuse before building; the stack is closed** (zero new runtime deps).
6. **Architecture Stability Rule:** a contract change moves schema + prompts +
   docs + examples together, in one PR.

## Status

The core build is complete; the system is in **continuous improvement**
(gate telemetry, the thin gated runner, the offline demo, the lite track, the
evidence benchmark tooling, the Gate-3/4 assist). What remains is a human-led
benchmark run series (`docs/benchmark-protocol.md`) and the deferred items with
explicit triggers (`docs/deferred.md`).

## Deliberately out of scope

Autonomous gate approval / agentic batch without a human (contradicts
non-negotiable #1); n8n, a web dashboard, a DB, or a queue (`README.md` §1.4);
replacing Playwright Native Agents with custom automation; rewriting an
official MCP. Non-Playwright test runners and extra story-source/CI ports are
not rejected, just **deferred with triggers** (`docs/deferred.md`).

## Read next

- `CLAUDE.md` — the binding operating instructions.
- `docs/when-to-use.md` — the fit / don't-fit decision.
- `docs/evidence.md` — the measured answer to the tension above.
- `README.md` — the full architectural index.
