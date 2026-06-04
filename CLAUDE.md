# CLAUDE.md

This file gives Claude Code its operating instructions for this project. Read it in full before doing any work. It stays valid from Phase 1 day-zero through Phase 3 and beyond; phase-specific work lives in the phase plan files.

---

## 1. What this project is

An AI-assisted QA pipeline that takes a user story (from Jira via MCP, or manual `story.md`), runs it through a chain of human-gated steps, and produces:

- Validated business test cases (with an Automation Decision Model: E2E / API / component / manual / skip).
- Playwright E2E specs and generated tests, via Playwright Native Agents (Planner / Generator / Healer).
- Postman collections executed with Newman for the API branch.
- A classified failure analysis and a release report.
- Bug drafts that can be promoted to Jira issues with explicit human approval.
- Optional sync of test cases and execution results to TestLink.

The system is built by combining mature open-source pieces (Playwright Native Agents, official MCPs for Atlassian/Playwright/Postman/TestLink, skills adapted from `dogkeeper886/ai-qa-workflow`) under a strict discipline layer (JSON Schemas + AJV, traceability IDs, four human gates, folder ownership, Architecture Stability Rule). The goal is ~40–50% less custom code than building from scratch, without losing any quality guarantees.

---

## 2. How to use this file

1. Read this `CLAUDE.md` first. Every session, every task.
2. Read `README.md` for the full architectural picture (traceability chain, folder ownership table, stack versions, the n8n decision, the full forbidden-work list).
3. Open the phase plan file for the phase you are currently in. Phase plans contain the Task Groups with their Definitions of Done.
4. Do not jump between phases. Each phase has hard prerequisites at the top and completion criteria at the bottom.

| If you are working on | Open this file |
|---|---|
| Foundation, schemas, first E2E vertical slice | `phase1-foundation-e2e.md` |
| Postman MCP + Newman + API Agent | `phase1.5-api-branch.md` |
| Jira/TestLink writes + GitHub Actions CI | `phase2-integrations.md` |
| Controlled healing, metrics, `/evolve`, hardening | `phase3-healing-scaling.md` |

If a user asks you to do something that doesn't fit the current phase, stop and ask before executing.

---

## 3. Operating principles (never violate)

These are the rules that govern your behavior on every task in this project, regardless of phase.

### 3.1 Work in small steps

At the start of every step, state out loud: *"I'm executing Task Group X of Phase Y."* Then do only the work that step requires. Don't bundle work from later task groups.

If a task takes more than three attempts without success, stop and report. Don't grind.

### 3.2 Respect folder ownership

The folder ownership table in `README.md` section 5 is binding. Every folder has a single owner.

- `test-cases/` belongs to the Test Designer Agent. The Failure Classifier never writes there.
- `specs/` belongs to the Playwright Planner. The Generator never writes there.
- `tests/` belongs to the Playwright Generator. The Planner never writes there.
- `api-tests/` belongs to the API Agent (Phase 1.5+).
- `analysis/` belongs to the Failure Classifier.
- `release/` belongs to the Reporter.
- `release/bug-drafts/` belongs to the Failure Classifier or Reporter.
- `release/healer-patches/` belongs to the Healer (Phase 3+).
- `schemas/`, `agents/`, `skills/`, `docs/`, `scripts/`, `examples/` belong to the human team.

If a task seems to require writing into a folder owned by another agent, stop and report. Don't cross boundaries silently.

### 3.3 Validate every JSON artifact against its schema

Any time an artifact JSON is created or modified — `context.json`, `test-cases/*.json`, `analysis/failure-analysis.json`, `release/release-report.json`, `api-tests/collections/*.postman_collection.json` — validate it immediately:

```bash
node scripts/validate-json.js schemas/<schema>.schema.json <artifact-path>
```

Exit 0 means valid. Anything else, fix before moving on. Do not propose a workaround that bypasses validation.

There is exactly one generic validator script. Do not create per-schema validators.

### 3.4 Respect traceability IDs

Every artifact must locate itself in the traceability chain:

```
JIRA-XXX (story) → RISK-001 → TC-001 → SPEC-001 → PW-001 → FAIL-001 → BUG-001
                            ↘ API-001 → COL-001 → REQ-001 → FAIL-001 → BUG-001
```

- Every risk has a `risk_id`.
- Every test case references one or more risk_ids.
- Every planner brief references one or more test_case_ids.
- Every spec references one or more test_case_ids.
- Every generated Playwright test references its spec_id and test_case_id (in code comments or metadata).
- Every Postman request references its api_test_case_id.
- Every failure references the test (PW or REQ) and the originating test case.
- Every bug draft references the failure, the test case, and the risk.

If a link genuinely cannot be established, write `traceability_unresolved` with the reason. Don't fake links.

### 3.5 Respect the four human gates

| Gate | When | What the human checks |
|---|---|---|
| Gate 1 — Requirement Interpretation | After Analyst | AC accurate, ambiguities explicit, risks meaningful, no invented business rules |
| Gate 2 — Test Scope Approval | After Test Designer | Risk coverage, priorities reasonable, automation decisions justified, low-value cases marked `manual` or `skip` with reason |
| Gate 3 — Specs Review | After Playwright Planner (or Postman collection ready) | Specs match approved scope, negative cases present, no unrelated flows |
| Gate 4 — Code Review | After Playwright Generator (or final assertions in collection) | Locators stable and semantic, assertions test correct business behavior, code readable, no skipped tests, no hard waits without justification |

Gate 4 stays human permanently. Do not propose automating it. Do not skip any gate.

If `review_gates.<gate> != true` (or not set), do not execute the next agent. Stop and report.

### 3.6 Respect Healer guardrails (Green / Yellow / Red)

In Phase 1 these are documented. In Phase 3 they are enforced by code. Either way the rules apply.

**Green — auto-fix allowed as a reviewable patch (never a direct commit):**
- Broken locators or selectors.
- Unstable waits, timeout stabilization.
- Minor selector refactors preserving business meaning.

**Yellow — suggest only, requires human approval:**
- UI structural changes, layout or flow reorganization.
- New modal, new page, changed navigation.
- App behavior changed but possibly still valid.

**Red — bug draft only, never auto-fix:**
- Business logic assertions.
- Permission and role behavior.
- Security validations.
- Pricing calculations, payment flows.
- Compliance behavior, data integrity rules.
- Any assertion meaning change.

**Hard stops in all cases:**
- Max 3 fix attempts per test.
- Never change expected values.
- Never delete a test.
- Never add `.skip` or equivalent.
- Never update snapshots without explicit human approval.
- Every change surfaced as a reviewable patch file.
- If confidence is low, mark `unknown_needs_human_review`.

The Healer never targets API/Newman tests. Healing applies to Playwright tests only.

### 3.7 Do not invent requirements

If a story is ambiguous, an acceptance criterion is unclear, or you can't tell whether something is in scope:

- Do not guess.
- Write the ambiguity into `context.json.ambiguities` (or `docs/ambiguities.md` if no context exists yet) with a description and a `blocking: true|false` flag.
- Stop and ask the human.

This applies equally to test design, spec writing, and code generation. The Analyst flags ambiguities; the Test Designer respects them; the Planner does not paper over them.

### 3.8 Do not generate tests from text alone

When generating a Playwright test, the agent must use Playwright MCP to actually open the application, perform the steps, and observe the real behavior before writing the spec or the test. Inventing a test from the story text is forbidden. This is the most important rule for preventing brittle or fictional tests.

For the API branch, the equivalent is: do not invent endpoint shapes. If there is no OpenAPI spec and no working example, ask. The API Agent can call the endpoint via Postman MCP to verify the response shape before writing assertions.

### 3.9 Reuse before building

When deciding between two approaches, choose the one that reuses more.

- Official MCP > custom script.
- Existing skill (adapted from `ai-qa-workflow`) > new agent prompt.
- Playwright Native Agent > custom browser automation.
- AJV + JSON Schema > custom validation logic.
- GitHub Actions > external orchestrator.

If you find yourself writing custom code that duplicates an MCP tool or an existing skill, stop and reconsider.

### 3.10 Architecture Stability Rule

When you change a contract, you change it everywhere in the same PR. A schema change is a database migration: it touches schema + agent prompts + docs + examples + migration script together.

When modifying a `schemas/*.schema.json`, the same PR must also update:

1. Every agent prompt that produces or consumes that artifact (`agents/*.md`).
2. `docs/artifact-boundaries.md`.
3. `docs/pipeline-architecture.md` (if the change is structural).
4. Affected expected examples in `examples/expected/`.
5. A migration script in `scripts/migrate-*.js` if old artifacts must remain valid.

If you cannot update all of these in the same PR, do not change the schema. Propose the change first.

### 3.11 Stop conditions

Stop and report when:

- An ambiguity blocks progress (3.7).
- A task asks you to write outside your folder ownership (3.2).
- A task asks you to skip schema validation (3.3).
- A task asks you to skip a human gate (3.5).
- A task asks you to violate a Healer guardrail (3.6).
- A task asks you to commit or merge Healer changes directly (3.6).
- A task asks you to create real Jira tickets without an explicit `--apply` flag from the human (Phase 2+).
- A task asks you to introduce a dependency not listed in section 4.
- A task asks you to introduce n8n, a web dashboard, a database, or a queue system (see `README.md` section 1.4 and the per-phase forbidden-work lists).

Don't try to negotiate around these. Stop and ask.

---

## 4. Stack constraints

You can install and use these. Anything else needs explicit human approval.

**Runtime and tooling:**

- Node.js 20+.
- TypeScript 5+ with `strict: true`.
- Playwright 1.56+ (required for Native Agents).
- ESLint v9 with `eslint.config.mjs` and `eslint-plugin-playwright`.
- Prettier.
- AJV + `ajv-formats` for JSON Schema validation.
- Newman + `newman-reporter-htmlextra` (Phase 1.5+).
- Docker 20+ (for MCPs that run as containers).

**MCPs (use the official or widely-adopted version, do not rewrite):**

- `microsoft/playwright-mcp` (installed via `npx playwright init-agents --loop=claude`).
- `ghcr.io/sooperset/mcp-atlassian:latest` (Jira + Confluence; read-only in Phase 1, write-enabled with `ENABLED_TOOLS` in Phase 2+).
- `postmanlabs/postman-mcp-server` (Phase 1.5+).
- `dogkeeper886/testlink-mcp:latest` (Phase 2+).

**Reference, not runtime dependency:**

- `dogkeeper886/ai-qa-workflow` — clone temporarily outside the project, copy and adapt specific skills (`receiving-tickets`, `planning-tests`, `designing-cases`, `analyzing-logs`, `syncing-testlink`). Don't add it as a submodule.

**Explicitly forbidden:**

- n8n (decision documented in `README.md` section 1.4).
- TestDino as a required core dependency (may be evaluated as optional reporting layer in Phase 3).
- QMetry hardcoded as test management (the system uses TestLink and is adapter-friendly; QMetry would be an adapter, not a hardcoded coupling).
- Custom browser automation replacing Playwright Native Agents.
- Custom MCP servers when an official one exists.
- Database, queue system, or web dashboard without explicit human approval.

---

## 5. The agents and skills

This project has a small number of custom agents and a small number of adapted skills. Know the difference.

**Custom agents** (live in `agents/*.md`, written by the human team):

- `agents/analyst.md` — reads the story (manual or from Jira via MCP) and produces `context.json`.
- `agents/test-designer.md` — produces `test-cases/[story-id].json` and `planner-input/[story-id].planner-brief.md`, applying the Automation Decision Model.
- `agents/api-agent.md` — produces `api-tests/collections/[story-id].postman_collection.json` and the matching environment (Phase 1.5+).
- `agents/failure-classifier.md` — produces `analysis/failure-analysis.json` and bug drafts.
- `agents/reporter.md` — produces `release/release-report.{md,json}`.
- `agents/spec-reviewer.md` — assists Gate 3 with a checklist (Phase 3+).

**Playwright Native Agents** (live in `.claude/agents/`, generated by `init-agents`):

- `planner` — explores the app and writes a Markdown spec.
- `generator` — turns the spec into a Playwright test file.
- `healer` — repairs failing tests within the Healer guardrails.

Do not edit these by hand. Regenerate with `npx playwright init-agents` after Playwright upgrades.

**Adapted skills** (live in `skills/*/SKILL.md`, copied and adapted from `dogkeeper886/ai-qa-workflow`):

- `receiving-tickets` — Discover phase. Reads Jira/Confluence, populates `context.json`.
- `planning-tests` — Plan phase. Writes the test plan.
- `designing-cases` — Design phase. Writes test cases with Automation Decision Model.
- `analyzing-logs` — Report phase. Helps the Failure Classifier.
- `syncing-testlink` — Manage phase. Syncs approved test cases to TestLink (Phase 2+).

Each adapted skill declares `adapted_from: dogkeeper886/ai-qa-workflow @ v3.0` in its frontmatter.

---

## 6. Phase-agnostic file layout

These files exist from day one and are touched in every phase:

```
README.md                        Architectural picture, decisions, traceability chain
CLAUDE.md                        This file. Operating instructions.
phase1-foundation-e2e.md         Phase 1 task groups
phase1.5-api-branch.md           Phase 1.5 task groups
phase2-integrations.md           Phase 2 task groups
phase3-healing-scaling.md        Phase 3 task groups
PHASE1-RETROSPECTIVE.md          Written at the end of Phase 1 (input to Phase 1.5)
PHASE1.5-RETROSPECTIVE.md        Written at the end of Phase 1.5 (input to Phase 2)
PHASE2-RETROSPECTIVE.md          Written at the end of Phase 2 (input to Phase 3)
PHASE3-RETROSPECTIVE.md          Written at the end of Phase 3 (input to continuous improvement)
```

The phase plan files are checklists. The retrospective files are written by the team at the end of each phase and reviewed before the next phase begins. Do not start the next phase if its retrospective prerequisite is missing.

---

## 7. Per-session checklist for Claude Code

Every time you start a session on this project, run this mental checklist before doing anything:

1. Have I read `CLAUDE.md`? (Yes — you're reading it now.)
2. Have I read `README.md` for architectural context?
3. Which phase are we in? Open the matching phase plan.
4. Which task group am I about to execute? State it out loud at the start of the response.
5. Does this work require schema changes? If yes, do I have time to update schema + agents + docs + examples + migration in the same PR? (Architecture Stability Rule.)
6. Will this work cross folder ownership boundaries? If yes, stop and ask.
7. Will this work skip a gate, weaken a Healer guardrail, or introduce a forbidden dependency? If yes, stop and ask.
8. Is the change reversible and small? If no, break it down further.

When in doubt: smaller steps, more validation, more stop-and-ask. The system is designed to make rushing impossible. Trying to skip is the failure mode it was built to prevent.

---

## 8. When the human asks you something not in the plan

If the human asks for something that is not in any phase plan:

- If it is a clarification or an explanation, answer.
- If it is a small improvement to docs or a fix that fits within the current phase scope, do it.
- If it is new functionality, propose it as a future task and ask whether to add it to a phase plan or treat it as out of scope.
- If it is a request to skip a rule from sections 3–4, refuse and explain which rule it violates and why the rule exists.

Don't be rigid for its own sake. Be rigid about gates, traceability, schemas, folder ownership, healer guardrails, and forbidden dependencies. Everything else is negotiable with the human present.

---

## 9. The single sentence to remember

> Reuse before building, validate before saving, stop before guessing.

If you only remember one thing from this file, remember that.
