<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/Qaizen_logo_dark.png">
  <img src="docs/assets/Qaizen_logo.png" alt="Qaizen logo" width="200">
</picture>

# Qaizen

**AI-assisted, human-gated, QA workflow.**

[![QA Pipeline](https://github.com/MiltonKlun/Qaizen/actions/workflows/qa-pipeline.yml/badge.svg?event=pull_request)](https://github.com/MiltonKlun/Qaizen/actions/workflows/qa-pipeline.yml)
[![Node](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FMiltonKlun%2FQaizen%2Fmain%2Fpackage.json&query=%24.engines.node&label=node&logo=nodedotjs&logoColor=white&color=339933)](package.json)
[![Playwright](https://img.shields.io/github/package-json/dependency-version/MiltonKlun/Qaizen/dev/%40playwright%2Ftest?label=Playwright&logo=playwright&color=2EAD33)](package.json)
[![License](https://img.shields.io/github/license/MiltonKlun/Qaizen)](LICENSE)

</div>

Give Qaizen a user story (a Jira issue or a `story.md`) and it produces
validated test cases, Playwright E2E tests, Postman/Newman API checks, a
classified failure analysis, a release report and ready-to-file bug drafts.
**Human gates** sit between the stages: nothing moves past one until a person
approves it, and the runner has no way to approve from a flag, script or CI job.

> QA + _kaizen_ (改善, "change for the better"): small steps, with people and
> system improving together. Qaizen makes a QA engineer faster, not absent.

---

## Why it exists

Asking an AI to "write Playwright tests for this story" gets a plausible answer
fast. Qaizen gets a _trustworthy_ one:

| You get | Because |
| --- | --- |
| **Traceability** | Every test links back to a risk and a story, and every failure forward to a bug, so nothing is tested without a reason or left out unnoticed. |
| **Auditability** | Every artifact is schema-validated and every gate decision recorded, so you can show _why_ a release was signed off. |
| **Guardrails that hold** | A proposed fix is re-run in isolation and handed to you as a patch; nothing that weakens, skips or deletes a test gets through. |
| **Tests grounded in the app** | Tests are written against the running app (Playwright MCP), not guessed from the story text. |

A capable agent can ground itself, but it won't gate, trace or record itself;
that is what the pipeline adds ([evidence](docs/evidence.md)). For a throwaway
script or a one-line change, prompting an AI directly is the honest call
([when to use it](docs/when-to-use.md)).

---

## Quickstart: 3 doors

```bash
npm install

# 1. See it: an offline, deterministic walkthrough of every gate and the
#    failure -> bug draft -> release report chain (~10 minutes).
npm run demo:pipeline

# 2. Use one piece: the failure classifier, healer or test designer on its own
#    (docs/standalone-*.md).

# 3. Run it: drive a real story through the gates.
npm run pipeline -- --story <path-to-story.md | JIRA-KEY>
```

---

## How it works

Four human gates divide the work. At each one the run stops until you approve
what the AI produced:

| Gate | It answers | What you review |
| --- | --- | --- |
| **1. Requirements** | Did the AI understand the story? | The acceptance criteria copied word for word, the open questions, and the risks. No tests exist yet. |
| **2. Test scope** | Are these the right tests? | One test case per risk, each with its priority and how it will be tested. |
| **3. Specs** | Is the plan based on the real app? | Step-by-step scenarios written after an agent actually used the app. |
| **4. Code** | Can this test code be trusted? | The generated Playwright tests, plus an automatic scan for hard-coded waits, skipped tests, fragile locators and missing IDs. |

AI agents do the work; the purple steps are human decisions.

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 22, "rankSpacing": 26, "padding": 6}}}%%
flowchart TD
    analyst[Analyst reads the story] --> g1{{Gate 1 · Requirements}}
    g1 --> designer[Test Designer] --> g2{{Gate 2 · Test scope}}

    g2 -->|E2E| planner[Planner] --> g3{{Gate 3 · Specs}}
    g3 --> generator[Generator] --> g4{{Gate 4 · Code}}

    g2 -->|API| apiagent[API Agent] --> g3a{{Gate 3′ · Collection}}
    g3a --> g4a{{Gate 4′ · Assertions}}

    g2 -->|manual · component · skip| plan[External plan] --> g3e{{Gate 3 · Plan}}
    g3e -->|record results| g4e{{Gate 4 · Evidence}}

    g4 -->|run Playwright| classify[Failure Classifier]
    g4a -->|run Newman| classify
    g4e --> classify
    classify --> report([Release report + bug drafts])
    classify -. green only .-> healer[Healer patch]

    classDef gate fill:#8250df,stroke:#8250df,color:#fff
    class g1,g2,g3,g4,g3a,g4a,g3e,g4e gate
```

In more detail:

| Gate | After | The human checks |
| --- | --- | --- |
| **1. Requirements** | Analyst | Acceptance criteria accurate, risks meaningful, no invented rules |
| **2. Test scope** | Test Designer | Coverage, priorities, and each automation decision justified |
| **3. Specs** | Planner | Specs match the approved scope, negative cases present |
| **4. Code** | Generator | Stable locators, real assertions, nothing skipped or weakened |

Each branch has its own Gate 3 and Gate 4; one branch's approval never stands in
for another's. Routine stories may take the `lite` track, where Gates 1 and 2
are one decision; a story that touches payments, permissions, security or data
integrity, or is too large to be routine, always gets all four
([review gates](docs/review-gates.md)).

**Traceability.** Every artifact carries its place in the chain; a link that
can't be proven is recorded as `traceability_unresolved`, never faked.

```mermaid
flowchart LR
    STORY[JIRA-123] --> RISK[RISK-001] --> TC[TC-001]
    TC -- E2E branch --> SPEC[SPEC-001] --> PW[PW-001] --> FAIL[FAIL-001] --> BUG[BUG-001]
    TC -. API branch .-> API[API-001] --> COL[COL-001] --> REQ[REQ-001] --> FAIL

    classDef e2e fill:#2ead33,stroke:#2ead33,color:#fff
    classDef api fill:#ff6c37,stroke:#ff6c37,color:#fff
    class SPEC,PW e2e
    class API,COL,REQ api
```

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run pipeline -- --story <ref>` | Drive a story through the gates |
| `npm run demo:pipeline` | Offline demo of the full flow |
| `npm test` · `npm run test:api` | Run the Playwright suite · the Postman collections (Newman) |
| `npm run normalize -- --story <id> ...` | Merge runner reports into one execution ledger |
| `npm run classify` | Draft Green / Yellow / Red failure classification from the ledger |
| `npm run import:execution -- --case TC-X ...` | Record a manual or component result with its evidence |
| `npm run heal` | Healer triage; with `--failure` and `--candidate`, validate a fix into a reviewable patch |
| `npm run scan:gate4 -- <spec>` | Static pre-Gate-4 scan to assist review |
| `npm run validate:all` | Validate every committed artifact against its schema |
| `npm run metrics` · `npm run evolve` | Aggregate run metrics · propose improvements from them |

How the runner works, step by step: [docs/pipeline-runner.md](docs/pipeline-runner.md).

---

## Built from

| Layer | Pieces |
| --- | --- |
| **Discipline** | JSON Schemas + AJV · traceability IDs · folder ownership · human gates · one PR per contract change |
| **Agents** | Custom: analyst · test-designer · api-agent · failure-classifier · reporter · spec-reviewer. Playwright Native: planner · generator · healer |
| **Official MCPs** | Atlassian (Jira) · Playwright · Postman · TestLink, reused, never rewritten |
| **Runtime** | Node · TypeScript (strict) · Playwright · Newman · ESLint · Prettier · GitHub Actions |

Design choices:

- **Reuse before building.** Official MCPs and Playwright Native Agents over
  custom code.
- **Schemas are contracts.** A schema change ships with its agent prompts, docs
  and examples in the same PR.
- **Healer guardrails.** Green: a locator fix, validated into a patch for
  review. Yellow: a suggestion only. Red: a bug draft, never touched. A fix
  never changes an expected value, deletes a test or adds `.skip`.
- **Out of scope by design.** No autonomous gate approval, no n8n, no web
  dashboard, no database or queue.

---

## Repository layout

| Path | Contents |
| --- | --- |
| `agents` · `skills` | Agent prompts · lifecycle skills adapted from `dogkeeper886/ai-qa-workflow` |
| `schemas` | JSON Schema contract for every artifact |
| `scripts` | The runner, validators, classifier, healer, metrics, demo |
| `docs` | Architecture, gates, traceability, integration and fit guides |
| `examples` | Example stories, expected outputs, demo fixtures |
| `tests` · `api-tests` | Generated Playwright tests · Postman collections |
| `external-evidence` | Recorded manual and component results with their evidence |
| `test` | Unit tests for the pipeline's own scripts |
| `runs` · `evidence` | Archived run history · benchmark records |

---

## Continuous improvement

`npm run evolve` reads git history, run metrics and the friction notes you
capture after a run (`npm run session-summary -- --friction "..."`), groups
them into themes, and scores each by how often it recurs. It writes a proposal
and **changes nothing**; you accept, defer or reject each finding. See
[docs/evolve-loop.md](docs/evolve-loop.md).

---

## Documentation

- [When to use it](docs/when-to-use.md): an honest fit guide
- [Pipeline runner](docs/pipeline-runner.md) · [Review gates](docs/review-gates.md) · [Architecture](docs/pipeline-architecture.md)
- [Traceability](docs/traceability.md) · [Healer guardrails](docs/healer-guardrails.md) · [Automation decisions](docs/automation-decision-model.md)
- [Artifact ownership](docs/artifact-boundaries.md) · [Runtime contracts](docs/runtime-contracts.md)
- [Design decisions](docs/design-decisions.md) · [Evolve loop](docs/evolve-loop.md)
- [CLAUDE.md](CLAUDE.md): operating rules for an AI agent working in this repo

---

## License

[MIT](LICENSE)

## Author

**Milton Klun**  
*QA Automation Engineer · AI Quality Testing*

<div align="left">
  <a href="https://www.linkedin.com/in/milton-klun/"><img src="https://img.shields.io/badge/LINKEDIN-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white" alt="LinkedIn"/></a><a href="mailto:miltonericklun@gmail.com"><img src="https://img.shields.io/badge/EMAIL-D14836?style=for-the-badge" alt="Email"/></a><a href="https://www.miltonklun.com"><img src="https://img.shields.io/badge/PORTFOLIO-000000?style=for-the-badge" alt="Live Site"/></a>
</div>
