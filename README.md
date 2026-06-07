# AI-Assisted QA Pipeline — Sistema fusionado

[![QA Pipeline](https://github.com/MiltonKlun/AI-Assisted-QA/actions/workflows/qa-pipeline.yml/badge.svg)](https://github.com/MiltonKlun/AI-Assisted-QA/actions/workflows/qa-pipeline.yml)

> **Estado:** Phases 1, 1.5, 2 y 3 **completas**. El sistema está en **modo de
> mejora continua** (no hay Phase 4 planificada). Ver `PHASE3-RETROSPECTIVE.md`
> §10 para la cadencia (`/evolve` cada 90 días o 10 runs, métricas cada 5 runs,
> evaluación de prompts en cada cambio mayor). Las cuatro retrospectivas
> (`PHASE1`/`PHASE1.5`/`PHASE2`/`PHASE3-RETROSPECTIVE.md`) registran el camino.

> **Para Claude Code (IDE agent):** este documento es el índice maestro del proyecto. Contiene la visión completa, decisiones arquitecturales, y el orden de los planes de fase. Antes de empezar a trabajar, leé este archivo completo y luego el archivo de la fase que estés ejecutando.

---

## 0. Qué es este sistema

Sistema de QA asistido con IA que automatiza el ciclo completo desde una user story en Jira hasta un release report con bugs creados, validando E2E vía Playwright y APIs vía Postman, manteniendo trazabilidad estricta y human gates.

**Fuente del diseño:** fusión de dos sistemas previos —
- "Pipeline 3-fases" (disciplina, contratos JSON, gates, traceability, healer guardrails).
- "Guía v2" (reuso de MCPs oficiales, skills de `ai-qa-workflow`, dual-judge, `/evolve`).

El sistema fusionado mantiene la disciplina del primero y reusa los componentes maduros del segundo. Esto reduce código propio en ~40-50% vs construir todo desde cero.

---

## 1. Decisiones arquitecturales (no negociables)

Estas decisiones están tomadas. No cambiar sin aprobación explícita del project owner.

### 1.1 Stack de orquestación y agentes

- **Playwright Native Agents** (Planner / Generator / Healer) como motor E2E. Generados con `npx playwright init-agents --loop=claude`. Requiere Playwright 1.56+.
- **`dogkeeper886/ai-qa-workflow`** como capa de skills lifecycle (`/receiving-tickets`, `/planning-tests`, `/designing-cases`, `/analyzing-logs`, etc.). NO reescribir estos skills desde cero.
- **Agentes custom solo donde no hay equivalente reusable**: Analyst (lectura Jira+contexto), Test Designer (Automation Decision Model), Failure Classifier (rule-based + LLM ambiguous), Reporter (release report con schema).

### 1.2 Stack de MCPs (todos oficiales o ampliamente adoptados)

- **`sooperset/mcp-atlassian`** — Jira + Confluence. 72 tools. Docker. OAuth 2.0 + API Token. Soporta Cloud y Server/DC.
- **`microsoft/playwright-mcp`** (oficial) — browser automation con accessibility snapshots.
- **`postmanlabs/postman-mcp-server`** (oficial) — collections, environments, runner via Newman, monitors.
- **`dogkeeper886/testlink-mcp`** — TestLink management. 22 tools. Docker. XML-RPC nativo.

### 1.3 Stack de ejecución y validación

- **TypeScript 5+ con strict mode**.
- **JSON Schemas con AJV** (draft-07) para todos los artefactos JSON.
- **ESLint v9 + eslint-plugin-playwright + Prettier**.
- **GitHub Actions** para CI/CD (no Jenkins, no orchestrator externo).

### 1.4 NO usar n8n en este proyecto

**Decisión y justificación:** evalué incorporar n8n como capa de orquestación y la descarto.

Razones:
- Todo el sistema vive dentro del codebase (skills, schemas, agentes, CI/CD). Claude Code + GitHub Actions cubren orquestación nativamente.
- n8n agrega un runtime externo, una UI separada, autenticación dual (Claude Code + n8n MCP), y un Bearer token adicional a mantener.
- La regla de la industria es clara: n8n se justifica cuando la automatización "es parte del sistema operativo de la empresa" (conecta múltiples áreas: ventas, marketing, soporte, IT). En cambio, cuando "la automatización vive dentro del codebase del producto", Claude Code + CI/CD es suficiente.
- Nuestro caso es claramente el segundo: pipeline QA dentro de un repo, ejecutándose en GitHub Actions, con artefactos versionados en Git.
- Agregar n8n duplicaría el storage de logs (n8n tiene los suyos + GitHub Actions tiene los suyos) y crearía un punto de falla adicional.

**Cuándo reconsiderar n8n** (no en este proyecto, pero como referencia futura):
- Si el sistema se expande para incluir notificaciones cross-equipo (Slack a producto, email a stakeholders, sync con CRM).
- Si surge la necesidad de exponer workflows del pipeline como tools para otros sistemas no técnicos.
- Si el equipo no-developer necesita modificar el flujo visualmente.

Nada de eso aplica hoy. Decisión: NO n8n. GitHub Actions + scripts en `scripts/` son suficientes.

### 1.5 Test management

**Decisión del project owner**: Jira sí o sí + TestLink si los MCPs facilitan integración.

Confirmado: **TestLink se incluye** porque `dogkeeper886/testlink-mcp` está maduro (22 tools, Docker-ready) y `dogkeeper886/ai-qa-workflow` ya viene optimizado para TestLink. No requiere adapter custom.

### 1.6 Rama API es obligatoria, no opcional

**Decisión del project owner**: la rama API debe estar completa y funcional. Se construye en **Phase 1.5**, paralela a la rama E2E de Phase 1. Ambas deben funcionar antes de Phase 2.

---

## 2. Arquitectura general

```
┌──────────────────────────────────────────────────────────────────────┐
│ CAPA 0: DISCIPLINA (heredada del Pipeline original)                   │
│ JSON Schemas + AJV · Folder ownership · Traceability IDs              │
│ Architecture Stability Rule · Forbidden work lists                    │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ CAPA 1: SKILLS LIFECYCLE (de ai-qa-workflow, adaptados)               │
│ /receiving-tickets · /planning-tests · /designing-cases               │
│ /syncing-testlink · /executing-tests · /analyzing-logs                │
│ /classifying-tests [nuevo] · /evolve [continuo]                       │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ CAPA 2: AGENTES CUSTOM (donde no hay reuso)                           │
│ agents/analyst.md · agents/test-designer.md                           │
│ agents/failure-classifier.md · agents/reporter.md                     │
│ agents/spec-reviewer.md [Phase 3]                                     │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ CAPA 3: MCPs OFICIALES (no reescribir)                                │
│ mcp-atlassian (Jira+Confluence) · playwright-mcp · postman-mcp        │
│ testlink-mcp                                                          │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ CAPA 4: 4 HUMAN GATES (no se saltan)                                  │
│ Gate 1: Requirements · Gate 2: Test Scope                             │
│ Gate 3: Specs Review · Gate 4: Code Review [PERMANENTE]               │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                  ┌───────────────┴───────────────┐
                  ▼                               ▼
┌──────────────────────────────┐   ┌──────────────────────────────────┐
│ RAMA E2E                     │   │ RAMA API                         │
│ Playwright Native Agents     │   │ Postman MCP + Newman             │
│ (Planner/Generator/Healer)   │   │ Collections + Environments       │
│ Playwright MCP               │   │ Contract testing opcional        │
└──────────────────────────────┘   └──────────────────────────────────┘
                  │                               │
                  └───────────────┬───────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ CAPA 5: EJECUCIÓN + REPORTING                                         │
│ Failure Classifier (rule-based + LLM) · Healer guardrails G/Y/R       │
│ Bug drafts → Jira con human approval · TestLink sync de resultados    │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ CAPA 6: MEJORA CONTINUA                                               │
│ PHASE-RETROSPECTIVE.md por fase · /evolve cada 90 días                │
│ Métricas pipeline cada 5 runs                                         │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. Plan general de fases

| Fase | Objetivo | Estado | Documento |
|---|---|---|---|
| **Phase 1** | Foundation + vertical slice E2E con MCP Atlassian read-only | ✅ Completa | `phase1-foundation-e2e.md` |
| **Phase 1.5** | Rama API completa con Postman MCP | ✅ Completa | `phase1.5-api-branch.md` |
| **Phase 2** | Writes habilitados (Jira bugs, TestLink sync) + GitHub Actions CI | ✅ Completa | `phase2-integrations.md` |
| **Phase 3** | Controlled healing + dual-judge optional + métricas + /evolve | ✅ Completa | `phase3-healing-scaling.md` |

Las cuatro fases están completas; el sistema entró en mejora continua (ver el
encabezado de Estado y `PHASE3-RETROSPECTIVE.md` §10). Las reglas de avance
abajo se preservan como registro de cómo se construyó.

**Reglas de avance entre fases (hard) — cumplidas:**
- Phase 1.5 no comienza hasta Phase 1 vertical slice E2E funcionando.
- Phase 2 no comienza hasta Phase 1 + 1.5 completas y `PHASE1-RETROSPECTIVE.md` revisado.
- Phase 3 no comienza hasta 3+ runs completos de Phase 2 y `PHASE2-RETROSPECTIVE.md` revisado.

---

## 4. Traceability IDs (cadena global)

Toda artefacto debe ubicarse en esta cadena:

```
JIRA-XXX (story) → RISK-001 → TC-001 → SPEC-001 → PW-001 → FAIL-001 → BUG-001
                            ↘ API-001 → COL-001 → REQ-001 → FAIL-001 → BUG-001
```

**Reglas**:
- `JIRA-XXX` (o `STORY-001` en modo manual): identifica la user story.
- `RISK-001`: identifica un riesgo de producto/negocio (lo escribe el Analyst).
- `TC-001`: identifica un test case (lo escribe el Test Designer; debe referenciar ≥1 risk).
- `SPEC-001`: identifica un Playwright Planner spec (debe referenciar ≥1 TC).
- `PW-001`: identifica un Playwright test generado (debe referenciar SPEC + TC).
- `API-001`: identifica un API test case (rama paralela a TC para casos `automate_api`).
- `COL-001`: identifica una Postman collection.
- `REQ-001`: identifica una request específica dentro de la collection.
- `FAIL-001`: identifica una falla de ejecución.
- `BUG-001`: identifica un bug draft (que puede ascender a Jira issue real en Phase 2).

Si una traceability link no se puede establecer: escribir `traceability_unresolved` con razón.

---

## 5. Folder ownership table

Ningún agente o tool escribe fuera de su carpeta sin permiso explícito del project owner.

| Path | Owner | Phase introducido | Propósito |
|---|---|---|---|
| `docs/` | Human/team | 1 | Arquitectura, rules, integration guides |
| `schemas/` | Human/team | 1 | JSON Schema contracts |
| `examples/stories/` | Human/team | 1 | Story examples para evaluation |
| `examples/expected/` | Human/team | 1 | Expected outputs (validan vs schemas) |
| `examples/evaluation/` | Human/team | 2 | Evaluation dataset extendido |
| `agents/` | Human/team | 1 | Agent prompt files (no generan artefactos acá) |
| `skills/` | Human/team | 1 | Skills lifecycle adaptados de ai-qa-workflow |
| `test-cases/` | Test Designer Agent | 1 | Business test cases JSON |
| `planner-input/` | Test Designer Agent | 1 | Adapter Markdown brief para Planner |
| `specs/` | Playwright Planner | 1 | Specs Markdown (solo Planner escribe) |
| `tests/` | Playwright Generator | 1 | Playwright tests generados + `seed.spec.ts` |
| `tests/fixtures/` | Human/team | 1 | Fixtures app-specific (placeholder en P1) |
| `api-tests/` | API Agent | 1.5 | Postman collections + environments |
| `api-tests/collections/` | API Agent | 1.5 | `.postman_collection.json` files |
| `api-tests/environments/` | API Agent | 1.5 | `.postman_environment.json` files |
| `reports/` | Playwright Runner / Newman | 1 / 1.5 | Reports JSON/HTML, traces, screenshots |
| `analysis/` | Failure Classifier | 1 | `failure-analysis.json` |
| `analysis/spec-reviews/` | Spec Reviewer | 3 | Asistencia a Gate 3 |
| `analysis/healer-validation/` | Healer | 3 | Validación antes/después de patches |
| `release/` | Reporter | 1 | Release report MD + JSON |
| `release/bug-drafts/` | Failure Classifier / Reporter | 1 | `BUG-XXX.md` drafts |
| `release/healer-patches/` | Healer | 3 | `.patch` files reviewable |
| `runs/` | new-run.js | 3 | Historia per-story/per-run |
| `metrics/` | pipeline-metrics.js | 3 | Métricas pipeline |
| `scripts/` | Human/team | 1 | Helper scripts (validate-json, etc.) |
| `.github/workflows/` | Human/team | 2 | GitHub Actions CI |

---

## 6. Architecture Stability Rule

**Crítica**: tratar schemas como database migrations.

Cuando cambia un schema JSON, **todos** los siguientes archivos deben actualizarse juntos en el mismo PR:

1. El schema afectado (`schemas/*.schema.json`).
2. El agent prompt afectado (`agents/*.md`).
3. `docs/artifact-boundaries.md`.
4. `docs/pipeline-architecture.md`.
5. Expected examples afectados (`examples/expected/*.json`).
6. Migration script si artefactos viejos deben seguir siendo válidos (`scripts/migrate-*.js`).

Si falta cualquiera de los 6, el PR se rechaza.

---

## 7. Healer guardrails Green/Yellow/Red

Desde Phase 1 (definidas en docs). Aplicación automática en Phase 3.

**Green** (auto-fix permitido como patch reviewable, nunca commit directo):
- Locators rotos.
- Selectors rotos.
- Waits inestables.
- Timeout stabilization.
- Minor selector refactors preservando business meaning.

**Yellow** (sugerencia + aprobación humana):
- Cambios estructurales UI.
- Layout o flow reorganization.
- New modal, new page, changed navigation.
- App behavior changed pero puede seguir siendo válido.

**Red** (bug draft only, NUNCA auto-fix):
- Business logic assertions.
- Permission and role behavior.
- Security validations.
- Pricing calculations.
- Payment flows.
- Compliance behavior.
- Data integrity rules.
- Cualquier cambio de meaning de aserción.

**Hard stops** (siempre):
- Máximo 3 fix attempts por test.
- Nunca cambiar expected values.
- Nunca borrar tests.
- Nunca `.skip` ni equivalente.
- Nunca update snapshots sin aprobación explícita.
- Toda change debe ser reviewable patch.
- Si confidence baja, marcar `unknown_needs_human_review`.

---

## 8. Automation Decision Model

El Test Designer Agent **debe** clasificar cada test case con uno de estos valores y dar razón escrita. Está prohibido marcar todo como E2E.

| Decision | Cuándo usar |
|---|---|
| `automate_e2e` | User journeys high-value, smoke/regression críticos, flujos UI-críticos |
| `automate_api` | Business logic, validations, permissions, filtering, data-heavy checks sin UI verification |
| `automate_component` | UI states por debajo del nivel E2E (componentes aislados) |
| `manual` | Exploratory, usability, subjective visual, accessibility review con juicio humano |
| `skip` | Low-risk, duplicate, o out-of-scope |

Cada test case incluye `automation_decision` + `automation_decision_reason` en su JSON.

---

## 9. Forbidden work (siempre, en cualquier fase)

Nunca, sin aprobación explícita del project owner:

- Custom browser automation engine reemplazando Playwright Native Agents.
- Custom MCP servers cuando hay equivalente oficial.
- Skip de Gate 4 (Code Review humano es permanente).
- Healer commits directos a main.
- Auto-merge de tests generados o healed.
- Cambio de business assertions sin human approval explícito.
- TestDino como dependencia core (puede evaluarse como reporting layer opcional en Phase 3, pero no requerido).
- Web dashboard / DB-backed orchestration / queue system sin aprobación.
- n8n como orquestador (decidido en sección 1.4).
- Generar tests inventando comportamiento sin observar la app real con Playwright MCP.

---

## 10. Para Claude Code: instrucciones operativas

Cuando trabajes en este proyecto:

1. **Leé este `README.md` primero.** Luego el archivo de la fase actual.
2. **Trabajá en pasos pequeños.** Al inicio de cada step, decí: "Estoy ejecutando Task Group X de Phase Y".
3. **No saltes fases.** Si Phase 1 no está completa, no empieces Phase 2.
4. **No inventes requirements.** Si algo no está claro, escribilo en `docs/ambiguities.md` y pará.
5. **Validá schemas siempre.** Después de cualquier artefacto JSON, corré `node scripts/validate-json.js`.
6. **Respetá folder ownership.** Si un task te pide escribir en una carpeta de otro owner, parate y reportá.
7. **No introduzcas dependencias externas no listadas.** El stack está cerrado en sección 1.
8. **Cuando dudes entre dos enfoques, elegí el que reusa más** (MCP oficial > script custom; skill existente > prompt nuevo).
9. **Si una task lleva más de 3 intentos sin éxito**, parate y reportá. No insistas.
10. **Al final de cada Phase**, escribí `PHASE{N}-RETROSPECTIVE.md` con lo que funcionó, lo que no, y recomendaciones para la siguiente fase.

---

## 11. Stack final (lista canónica de versiones)

| Componente | Versión mínima | Notas |
|---|---|---|
| Node.js | 20+ | LTS recomendado |
| TypeScript | 5+ | strict mode obligatorio |
| Playwright | 1.56+ | Para Playwright Native Agents |
| VS Code | 1.105+ | Solo si usás agentic experience en VS Code |
| Claude Code | última | Cualquier IDE agent equivalente sirve |
| ESLint | v9 | con `eslint.config.mjs` |
| `eslint-plugin-playwright` | última | |
| Prettier | última | |
| AJV + `ajv-formats` | última | JSON Schema validation |
| Newman | última | CLI runner para Postman collections |
| Docker | 20+ | Para MCPs en containers (Atlassian, TestLink) |

**MCPs (todos via Docker o npm):**
- `ghcr.io/sooperset/mcp-atlassian:latest`
- `microsoft/playwright-mcp` (via `npx playwright init-agents`)
- `postmanlabs/postman-mcp-server` (npm)
- `dogkeeper886/testlink-mcp:latest` (Docker Hub)

**Repos a clonar como referencia (no como dependencia runtime):**
- `dogkeeper886/ai-qa-workflow` — copiar skills relevantes y adaptar.

---

## 12. Próximo paso — mejora continua

Las cuatro fases están completas. El sistema ya no avanza por fases; opera en
**modo de mejora continua** (`PHASE3-RETROSPECTIVE.md` §10):

- **Cada 90 días o cada 10 runs** (lo que venga primero): `npm run evolve` →
  revisar `evolve/evolve-proposal.md`, aceptar/diferir/rechazar cada hallazgo.
- **Cada 5 runs:** `npm run metrics`.
- **Cada cambio de prompt mayor:** la evaluación corre sola en CI (`prompt-eval`
  cuando el PR toca `agents/`); ver `docs/prompt-versioning.md`.
- **Después de cada run:** `npm run session-summary -- --friction "…"` para que
  `/evolve` tenga la señal más alta (ver `docs/evolve-loop.md`).
- **Registrar las decisiones de gate** en `context.gate_decisions[]` para que la
  métrica de estabilidad de prompts (rechazos de Gate 3/4) sea real
  (`docs/review-gates.md`).
- **Cada trimestre:** revisar docs vs. realidad; corregir drift.

Para retomar trabajo de funcionalidad sobre una historia nueva, el flujo es el
de siempre (Analyst → 4 gates → Reporter); ver `docs/phase2-vertical-slice-runbook.md`.

Rechazado permanentemente por diseño: batch agéntico sin gates (contradice el
principio fundacional human-in-the-loop en Gate 4).
