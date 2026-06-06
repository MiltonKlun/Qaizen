# Phase 3 — Controlled Healing, Métricas, /evolve, Hardening

> **Para Claude Code:** este es el plan de Phase 3. **No empieces esta fase hasta que Phase 2 esté completa** (3+ stories procesadas con CI/CD + writes a Jira y TestLink, `PHASE2-RETROSPECTIVE.md` revisado).

---

## 0. Objetivo de Phase 3

Escalar el sistema de forma segura: agregar healing controlado, dual-judge opcional, métricas, mejora continua con `/evolve`, security hardening, prompt versioning, soporte multi-feature.

**Esta fase mejora escala y seguridad, no autonomía sin review.** Gate 4 permanece humano. Healer nunca commitea directamente.

**Phase 3 termina cuando:**

1. Failure Classifier soporta clasificación híbrida (rule-based primero, LLM solo para ambiguous).
2. Healer puede aplicar patches Green en workspace temporal (nunca commits directos).
3. CI job opcional de Healer procesa solo Green failures.
4. Spec Reviewer Agent asiste Gate 3 (sin reemplazar humano).
5. `runs/` directory model existe para historia.
6. Pipeline metrics se computan después de cada 5 runs.
7. Prompt versioning activo.
8. Security & data safety docs existen.
9. `/evolve` corrió al menos una vez con session summaries reales.
10. (Opcional) Dual-judge framework evaluado y posiblemente integrado.
11. `PHASE3-RETROSPECTIVE.md` existe y fue revisado.

---

## 1. Phase 3 — Prerequisitos

No empezar hasta que todos sean `true`:

- [ ] Phase 1 + 1.5 + 2 completas y documentadas.
- [ ] Las 3 retrospectivas (P1, P1.5, P2) revisadas.
- [ ] Stories Jira-sourced corriendo regularmente.
- [ ] TestLink sync funcionando (o explícitamente deferido por decisión del equipo).
- [ ] GitHub Actions estable.
- [ ] Jira bug creation desde bug drafts funcionando.
- [ ] Evaluation dataset corriendo.
- [ ] **Al menos 3 runs completos de Phase 2** con métricas observadas.

Si Phase 2 está inestable, **stop**. Healing y scaling sobre integraciones inestables amplifica fallos.

---

## 2. Phase 3 — Non-negotiable rules

- Healer **nunca** commitea directamente a main.
- Healer **nunca** mergea.
- Green failures: patches generados y validados en workspace temporal solamente.
- Yellow failures: requieren aprobación humana.
- Red failures: solo bug drafts, sin auto-fix.
- Business expectations **nunca** se debilitan.
- Aserciones **no** cambian de meaning sin aprobación humana explícita.
- Gate 4 permanece humano permanentemente.
- Gate 3 puede recibir asistencia del Spec Reviewer, pero aprobación humana sigue siendo requerida para flujos high-risk.
- `context.json` sigue siendo manifest/index, no se convierte en DB.
- Run history preserva traceability IDs.
- TestDino (si se evalúa) es solo reporting opcional, nunca reemplaza `failure-analysis.json` ni Reporter Agent.
- Métricas guían improvement; no reescriben prompts ni contracts automáticamente.

---

## 3. Phase 3 — Forbidden work

- ❌ Direct Healer commits a main.
- ❌ Auto-merge de healed tests.
- ❌ Cambios autónomos de business assertions.
- ❌ Full web dashboard sin aprobación explícita.
- ❌ Database/queue orchestration sin aprobación.
- ❌ TestDino como required core dependency.
- ❌ Remoción de Gate 4.
- ❌ Remoción de Gate 3 humano para flujos high-risk.
- ❌ Multi-story autonomous batch execution sin aprobación.
- ❌ n8n (decisión global, ver README sección 1.4).

---

## 4. Task Groups

### Task Group 1 — Rule-based pre-classifier

Optimización del Failure Classifier: clasificar primero con reglas determinísticas (rápido + cero costo de LLM), llamar LLM solo para ambiguous.

- [ ] Crear `scripts/run-failure-classifier.js`:
  - Lee `reports/results.json` (Playwright) + `reports/newman-results.json` (Newman) + `context.json`.
  - Aplica pre-classification determinístico:
    - Locator/selector signals + no business assertion → `locator_or_selector` o `ui_structural_change`.
    - Timeout/wait signals → `wait_or_timeout` (a menos que evidence sugiera environment).
    - Expected/received business value mismatch → `product_bug` o `unknown_needs_human_review`.
    - Setup/fixture failure → `test_bug` o `test_data_issue`.
    - Connection/network failure → `environment_issue`.
    - Para API: status code mismatch en business endpoint → `product_bug`.
    - Para API: 5xx → escalar a LLM.
  - Llama al LLM **solo** para ambiguous (cuando ninguna regla matches con high confidence).
  - Escribe `analysis/failure-analysis.json` validado contra schema.
  - Exit non-zero si product_bug failures existen y se corre en modo blocking.

**Definition of Done:**
- [x] Script existe y valida outputs. (`scripts/run-failure-classifier.js`,
      `npm run classify`; output verified against the schema incl. all 4
      conditional rules.)
- [x] Falla obvia clasifica sin costo de LLM. (locator→green, timeout→green,
      assertion-mismatch→product_bug/red, connection→environment, etc.)
- [x] Falla ambigua escala. (→ `unknown_needs_human_review`/yellow; a headless
      script has no LLM to call, so escalation = flag-for-human; the Failure
      Classifier Agent / human resolves it — documented in the script header.)
- [x] Output valida contra `schemas/failure-analysis.schema.json`.
- [x] Gate 4 precondition enforced (refuses unless code_reviewed passed);
      `--blocking` exits 1 on product_bug.

> **Honest scope:** the deterministic pre-classifier maps obvious failures and
> escalates ambiguous ones; it does NOT resolve TC-XXX linkage (sets
> traceability_unresolved) — the Failure Classifier Agent finishes that from
> test metadata. Pre-classifier + agent together = the hybrid TG1 intent.

---

### Task Group 2 — Healer patch script con guardrails

Acá implementamos por código los Healer guardrails Green/Yellow/Red que están documentados desde Phase 1.

- [ ] Crear `scripts/run-healer.js`:

  **Comportamiento seguro (no negociable)**:
  - **No** commitea directamente.
  - **No** mergea.
  - Puede aplicar patches solo en workspace temporal o branch temporal.
  - Siempre produce archivos `.patch` reviewable.

  **Lógica**:
  - Lee `analysis/failure-analysis.json`.
  - Para failures **Green** solamente:
    - Genera o aplica candidate patch en workspace aislado.
    - Re-corre **solo** el test afectado (usar `npx playwright test path/to/file.spec.ts -g "test name"`).
    - Si patch works → escribe `release/healer-patches/FAIL-XXX.patch` + `analysis/healer-validation/FAIL-XXX.md` (before/after).
    - Si patch falla → incrementa attempt count.
    - Stop at 3 attempts.
  - Para failures **Yellow**:
    - Escribe patch suggestion (NO aplica).
    - Marca explícitamente que requiere human review.
  - Para failures **Red**:
    - No tocar. Solo bug drafts (ya generados por Failure Classifier).
  - **Nunca**:
    - Cambia expected values.
    - Borra tests.
    - Agrega `.skip` o equivalente.
    - Updatea snapshots sin aprobación explícita.

  **Optional later**:
  - Abrir PR draft para human review, pero nunca mergear.

- [ ] Crear carpeta `analysis/healer-validation/` (ya en folder ownership del README).
- [ ] Crear carpeta `release/healer-patches/`.
- [ ] Actualizar `.gitignore` si los workspace temporales se crean en raíz.

**Definition of Done:**
- [ ] Script existe.
- [ ] Green failures producen `.patch` validados.
- [ ] No commits ni merges automáticos.
- [ ] Guardrails enforced programáticamente (intentar cambiar un expected value = error).

---

### Task Group 3 — Healer CI job

- [ ] Actualizar `.github/workflows/qa-pipeline.yml` con job opcional `healer`:

  **Reglas**:
  - Corre **solo** si el Playwright job falla.
  - Descarga report artifacts del Playwright job.
  - Corre `scripts/run-failure-classifier.js`.
  - Corre `scripts/run-healer.js` solo para Green failures.
  - Re-corre tests afectados (no toda la suite).
  - Upload de healer patch artifacts.
  - Posta PR comment con summary:
    - ✅ Green fixes validated: N.
    - ⚠️ Yellow fixes needing review: N.
    - ❌ Red failures requiring bug handling: N.
  - **No** pushea commits.
  - **No** mergea.

**Definition of Done:**
- [ ] CI puede asistir con Green fixes sin debilitar review controls.
- [ ] PR comments resumen el estado.
- [ ] No commits automáticos.

---

### Task Group 4 — Spec Reviewer Agent (asistencia a Gate 3)

- [ ] Crear `agents/spec-reviewer.md` con las 11 secciones estándar.

  **Role**: asistir al humano en Gate 3 (review de specs). NO aprueba ni rechaza automáticamente.

  **Inputs**:
  - `context.json`.
  - `test-cases/[story-id].json`.
  - `planner-input/[story-id].planner-brief.md`.
  - `specs/[story-id].md`.

  **Output**:
  - `analysis/spec-reviews/[story-id].spec-review.json` (machine-readable).
  - `analysis/spec-reviews/[story-id].spec-review.md` (human-readable).

  **Checklist que aplica**:
  - [ ] Cada scenario tiene expected outcome claro.
  - [ ] Casos negativos presentes donde el riesgo lo requiere.
  - [ ] Todos los TCs E2E aprobados están representados en specs.
  - [ ] High-risk items cubiertos.
  - [ ] Low-value visual-only E2E scenarios flagged como candidatos a manual.
  - [ ] Scope matches `planner-input/`.
  - [ ] Traceability IDs preservadas (`SPEC-XXX` → `TC-XXX` → `RISK-XXX`).
  - [ ] No se introducen flows no soportados/aprobados.

  **Output format del JSON**:
  ```
  {
    "schema_version": "1.0",
    "story_id": "JIRA-1234",
    "reviewed_at": "ISO",
    "findings": [
      { "type": "missing_negative_case", "tc_id": "TC-003", "description": "..." },
      ...
    ],
    "recommendations": [...],
    "auto_approval_eligible": boolean (heurística: true si findings está vacío Y todos los high-risk TCs cubiertos)
  }
  ```

  **Crítico**: `auto_approval_eligible` es solo hint. El humano siempre decide.

- [ ] Actualizar `docs/review-gates.md`:
  - Gate 3 ahora muestra el output del Spec Reviewer antes de decidir.
  - Humano sigue siendo el approval final.

**Definition of Done:**
- [x] Spec Reviewer existe. (`agents/spec-reviewer.md`, 11 secciones;
      `schemas/spec-review.schema.json`; `analysis/spec-reviews/`.)
- [x] Asiste pero no reemplaza humano. (No setea gates; `auto_approval_eligible`
      es solo hint; Gate 3 sigue humano — `CLAUDE.md` §3.5.)
- [x] Output JSON validable. (Schema + example
      `examples/expected/spec-review-uncovered.expected-spec-review.json`;
      validate-examples + validate-all reconocen el suffix.)
- [x] **§4.5.a** incorporado: `risk_coverage` + `uncovered_risks` +
      `uncovered_high_severity_count` determinísticos; high-severity uncovered
      ⇒ `blocker` finding ⇒ `auto_approval_eligible: false`. `docs/review-gates.md`
      Gate 3 actualizado.

---

### Task Group 5 — Run history (`runs/` directory)

Para soporte de múltiples runs sin overwrite.

- [ ] Diseño del modelo:
  ```
  runs/[story-id]/[run-id]/context.json
  runs/[story-id]/[run-id]/test-cases/
  runs/[story-id]/[run-id]/planner-input/
  runs/[story-id]/[run-id]/specs/
  runs/[story-id]/[run-id]/tests/
  runs/[story-id]/[run-id]/api-tests/
  runs/[story-id]/[run-id]/reports/
  runs/[story-id]/[run-id]/analysis/
  runs/[story-id]/[run-id]/release/
  ```
- [ ] El `context.json` root puede:
  - Opción A: mantenerse como pointer al run activo/latest.
  - Opción B: copiarse al run actual y eliminarse del root.
  - El project owner decide. Recomendación: Opción A (root es siempre "current" y `runs/` es la historia completa).
- [ ] Crear `scripts/new-run.js`:
  - Acepta `story-id` y optional `label`.
  - Genera unique `run-id` (timestamp + short hash).
  - Crea folder structure de run.
  - Inicializa run-local `context.json`.
  - Actualiza root pointer al latest run.
  - Ejemplos:
    ```
    node scripts/new-run.js JIRA-1234
    node scripts/new-run.js JIRA-1234 sprint-42-regression
    ```
- [ ] Actualizar `docs/pipeline-architecture.md` con explicación del `runs/` model.
- [ ] Actualizar `.gitignore` si los `runs/` no se versionan (recomendación: versionar solo `context.json` y `release/release-report.{md,json}` de cada run, ignorar `reports/`, `traces/`, `screenshots/`).

**Definition of Done:**
- [x] `runs/` model existe. (Option A: root = current, runs/ = history.)
- [x] `new-run.js` funciona. (`scripts/new-run.js`, `npm run new-run`,
      dry-run + real archive + story-mismatch guard verified.)
- [x] Multiple runs coexisten sin overwrite. (Snapshot copies the root;
      never deletes it. Per-story `runs/<id>/<run-id>/` + `runs/latest.json`.)
- [x] Traceability intacta per-run. (Each archived context keeps its
      run_id + chain; `run-manifest.json` records source run_id + status.)
- [x] `docs/pipeline-architecture.md` §8.1 documents the model;
      `.gitignore` versions durable artifacts, ignores reports/traces/screenshots.

> **Built early (Phase 2.6→3 bridge), not the full Phase 3.** Prioritized per
> the Phase 2 retrospective (single-occupancy clobber pain) and §4.5.b. The
> rest of Phase 3 (Healer, metrics, etc.) is unchanged.

---

### Task Group 6 — Pipeline metrics

- [ ] Crear `scripts/pipeline-metrics.js`:
  - Lee todos los completed runs en `runs/`.
  - Computa:
    - Total runs.
    - Average pass rate por story area.
    - Test cases que más fallan.
    - Tests más flakeantes.
    - Healer patch validation success rate.
    - Green patch acceptance rate por humanos (si está tracked).
    - Average # de Gate 3 rejections por story.
    - Average # de Gate 4 rejections por story.
    - Product bugs encontrados por tests generados.
    - Untested high-risk items.
  - Outputs:
    - `metrics/pipeline-metrics.md` (human).
    - `metrics/pipeline-metrics.json` (machine).
  - Recomendación: correr después de cada 5 runs completados.

- [ ] Actualizar `docs/pipeline-architecture.md` con sección "Metrics and Monitoring":
  - Qué significa cada métrica.
  - Cómo interpretar high Gate 3 rejection rate (= specs malos = prompt malo).
  - Cómo interpretar high Gate 4 rejection rate (= generator malo = prompt malo).
  - Cómo decidir cuándo los prompts son stable.
  - Threshold sugerido: menos de 10% rejection rate en gates relevantes sobre 10 runs consecutivos.

**Definition of Done:**
- [ ] Script de métricas funciona.
- [ ] Output MD + JSON.
- [ ] Equipo puede medir si el pipeline mejora QA o crea ruido.

---

### Task Group 7 — Token-efficient context handling

- [ ] Actualizar `docs/context-json-guide.md`:
  - `context.json` es índice/manifest.
  - Large files siempre por path, nunca inlined.
  - Agents cargan **solo** los archivos que necesitan para su step.
  - No pastear full HTML reports, traces, screenshots, o large logs en prompts.
  - Reporter usa summarized JSON, evidence paths, y failure analysis en vez de raw reports.

- [ ] Actualizar prompts de agents (`agents/*.md`):
  - Cada agent declara explícitamente: "loads only these files from context.json.artifact_paths: [list]".
  - Si el agent necesita data adicional, paths primero.

**Definition of Done:**
- [ ] Doc actualizado.
- [ ] Cada agent prompt declara qué carga.
- [ ] Token usage controlado.

---

### Task Group 8 — Prompt versioning

- [ ] Agregar version header a cada agent file:
  ```yaml
  ---
  name: analyst
  version: 2.1.0
  changed_in_run: <run_id>
  changelog: |
    - v2.1.0: Added Mode B (Jira) for story ingestion.
    - v2.0.0: Refactored to use traceability IDs.
    - v1.0.0: Initial version.
  ---
  ```
- [ ] Linkear `prompt_version` a `run_id` en `context.json` (extender schema; mismo PR debe actualizar schema + docs + examples).
- [ ] Storage de prompt history en Git (ya está, pero formalizarlo en `docs/prompt-versioning.md`).
- [ ] **Requerir evaluation dataset run antes de adoptar major prompt changes**:
  - PR que cambia un agent prompt → CI corre `scripts/evaluate-agents.js`.
  - Si % de matches baja > 10%, warning (no blocking inicialmente).
- [ ] Crear `docs/prompt-versioning.md`.

**Definition of Done:**
- [ ] Cada agent tiene version.
- [ ] Context.json registra versions usadas en cada run.
- [ ] Evaluation antes de adopción de major changes documentado.

---

### Task Group 9 — Security & data safety

- [ ] Crear `docs/security-and-data-safety.md`:
  - Secret handling:
    - No secrets en prompts.
    - No secrets en reports.
    - Mask credentials en logs.
    - API keys solo en env vars o secret managers.
  - Test data policy:
    - No production data en LLM prompts.
    - Test fixtures usan synthetic data.
  - LLM prompt data limits.
  - Trace/screenshot redaction guidance:
    - Cómo configurar Playwright para no capturar fields sensitive.
    - Cómo redactar después-de-hecho si es necesario.
- [ ] Auditar agent prompts y scripts para asegurar:
  - No log de credentials.
  - No print de tokens/cookies/passwords completos.
- [ ] Si la app under test tiene production data en alguna instancia, **no apuntar el pipeline ahí**. Solo staging/dev con data sintética.

**Definition of Done:**
- [ ] Doc existe.
- [ ] Audit pasó.
- [ ] Constraints documentados y enforced.

---

### Task Group 10 — `/evolve` loop (self-improvement)

Adaptación del concepto `/evolve` de `ai-qa-workflow`.

- [ ] Crear `scripts/evolve.js` (o un agent `agents/evolver.md`):
  - Lee:
    - GitHub issues del repo (últimos 90 días).
    - Git commits (últimos 90 días).
    - `metrics/pipeline-metrics.json`.
    - Si existen, `session-summaries/*.md` (humanos pueden escribir notas después de cada run).
  - Detecta:
    - Workflow gaps (steps que el humano hace manualmente repetidamente).
    - Friction points (3+ ocurrencias = high-confidence insight).
    - Usage patterns.
    - Knowledge decay (docs desactualizados vs realidad del código).
  - Score cada finding por confidence.
  - Propone grouped actions: cambios a CLAUDE.md, agents, skills, schemas, docs.
  - **No aplica cambios solo**. Sugiere; humano confirma; entonces aplica.

- [ ] Opcionalmente, crear `scripts/session-summary.js`:
  - Helper interactivo que pregunta al humano al cerrar sesión: "¿qué friccionó hoy?", "¿qué te hizo perder tiempo?".
  - Guarda en `session-summaries/[date].md`.

- [ ] Crear `docs/evolve-loop.md`:
  - Cuándo correr `/evolve` (recomendación: cada 90 días o cada 10 runs, lo que venga primero).
  - Cómo interpretar los outputs.
  - Cómo aceptar/rechazar cambios sugeridos.

**Definition of Done:**
- [ ] `scripts/evolve.js` (o agent) existe.
- [ ] Corrió al menos una vez con datos reales.
- [ ] Produjo al menos una recomendación útil.
- [ ] Doc explica el loop.

---

### Task Group 11 — Multi-feature support

Soporte para múltiples stories en paralelo, **sin** autonomía de batch.

- [ ] Asegurar que `runs/` soporta múltiples story IDs simultáneamente.
- [ ] Asegurar que traceability se mantiene local a cada story/run (no cross-pollination).
- [ ] Reports pueden agregar links a múltiples story-level reports sin mergear artefactos incorrectamente.
- [ ] Single-story run sigue siendo la unidad base (sin batch autónomo).

- [ ] Crear `scripts/list-runs.js`:
  - Lista todos los runs en `runs/`.
  - Imprime status, story_id, run_id, timestamp.
  - Útil para dashboard simple (sin web UI).

**Definition of Done:**
- [ ] Multiple story runs coexisten.
- [ ] No artifact collisions.

---

### Task Group 12 — Enhanced release reporting

- [ ] Actualizar `agents/reporter.md` + `schemas/release-report.schema.json`:
  - Release summary por risk level (high/medium/low).
  - High-risk untested items.
  - Coverage gaps.
  - Flaky test summary (si tracked).
  - Open bug summary.
  - QMetry/TestLink y Jira links.
  - Evidence path table.
  - Conditional release criteria explícita.

  **Reglas**:
  - No claim `pass` si high-risk product bugs unresolved.
  - No esconder untested risks.
  - `conditional_pass` debe listar conditions explícitas.

**Definition of Done:**
- [ ] Reports útiles para decisiones de release reales.
- [ ] Schema y prompt actualizados juntos (Architecture Stability).

---

### Task Group 13 — (Opcional) Dual-judge framework evaluation

**Solo evaluar después de 10+ runs completos de Phase 3**.

`dogkeeper886/test-framework-template` propone un dual-judge: cada test YAML pasa por simple judge (deterministic) + LLM judge (semantic). Útil para tests donde "técnicamente pasó" pero semánticamente algo está raro.

- [ ] Crear `docs/dual-judge-evaluation.md` con criteria:
  - ¿Failure Classifier actual atrapa suficientes casos?
  - ¿Hay falsos positivos (tests que pasan pero deberían fallar)?
  - ¿Justifica la complejidad de YAML-driven tests vs Playwright nativo?
  - ¿El equipo está dispuesto a migrar tests a YAML?
- [ ] Si 3+ criteria justifican adopción, integrar como capa adicional (no reemplazar Playwright).

**Definition of Done:**
- [ ] Evaluación realizada.
- [ ] Decisión documentada (adoptar / deferir / rechazar).
- [ ] Si se adopta: integración como reporting layer adicional, sin reemplazar core.

---

### Task Group 14 — Vertical slice Phase 3

Correr el pipeline completo con Phase 3 capabilities activas:

- [ ] **Story con un Green failure conocido**: meter intencionalmente un locator roto, verificar que Healer:
  - Detecta el failure.
  - Clasifica como Green.
  - Genera patch.
  - Re-corre el test.
  - Produce `.patch` file reviewable.
  - **No** commitea.
- [ ] **Story con un Red failure conocido** (business assertion broken intencionalmente):
  - Verifica que Healer **no** intenta arreglar.
  - Bug draft generado.
  - Bug creable en Jira con `create-jira-bugs.js --apply`.
- [ ] **Spec Reviewer corre** en Gate 3 y produce review JSON.
- [ ] **Pipeline metrics corren** después de este run (debería ser el run 4+).
- [ ] **`/evolve` corre** con session summaries acumuladas; propone al menos 1 mejora.
- [ ] Escribir `PHASE3-RETROSPECTIVE.md`:
  - Healer guardrails funcionaron como esperado?
  - Spec Reviewer agregó valor real?
  - Métricas útiles?
  - `/evolve` propuso algo accionable?
  - Decisiones sobre dual-judge (adoptar/deferir).
  - Total: estado del sistema, próximos pasos.

**Definition of Done:**
- [ ] Healer probado con Green y Red.
- [ ] Spec Reviewer probado en Gate 3.
- [ ] Métricas computadas.
- [ ] `/evolve` corrió.
- [ ] `PHASE3-RETROSPECTIVE.md` existe.

---

## 4.5 Enhancement cross-references (from IMPROVEMENTS.md, approved 2026-06-04)

These vetted enhancements attach to existing Phase 3 Task Groups (or add one
new item). They are **additions, not redesigns** — see `phase2.6-enhancements.md`
for the companion Phase-2 items and the shared discipline rule. This project is
generic/reusable; keep these tool-agnostic and configurable.

### 4.5.a — Spec Reviewer uncovered-risk coverage (folds into TG4)

Improvement 3 (full). The Phase 2.6 partial version surfaces uncovered risks
in the **release report**; here the **Spec Reviewer** (TG4) surfaces them at
**Gate 3**, before tests are generated. Extend the spec-review output
(`analysis/spec-reviews/[story-id].spec-review.json` + `.md`) with:

```
risk_coverage (array): { risk_id, severity, covering_test_case_ids[], covered (bool) }
uncovered_risks (array of risk_id)
uncovered_high_severity_count (number)
```

Computed deterministically from the `RISK → TC` chain — **no LLM call by
default**. The Spec Reviewer's `auto_approval_eligible` hint MUST be `false`
when `uncovered_high_severity_count > 0`. The human at Gate 3 reviews the
uncovered list before approving (Gate 3 stays human; `CLAUDE.md` §3.5). Only
add a second-model semantic-coverage pass if retrospectives prove the
deterministic check misses real gaps — and then as an addition, not a
replacement.

### 4.5.b — `runs/` layout (this is TG5; raise its priority)

The Phase 2 retrospective flagged single-occupancy artifacts
(`context.json`, `analysis/`, `release/` each hold one run) as the top pain —
a story overwrites the previous one. **TG5 (`runs/[story-id]/[run-id]/`) is
the fix; prioritize it early in Phase 3.** It also becomes more necessary once
Phase 2.6's `design_stage` exists (a story can have a `pre_development` run and
a `ready_for_qa` run).

### 4.5.c — Code-change awareness via GitHub MCP (NEW Task Group — see below)

Improvement 1. No existing TG covers it; added as TG15.

---

### Task Group 15 — Code-change awareness (Improvement 1)

Optional, PR-dependent. When a Jira story has a linked PR, the Analyst fetches
the diff (deployed/base SHA → PR head SHA) via a **read-only GitHub MCP** and
records it as **secondary context** in `context.json`. The diff sharpens risk
prioritization and regression scope; **it never defines expected behavior** —
acceptance criteria remain the source of truth (reinforces `CLAUDE.md` §3.8).

- [ ] Add the official **GitHub MCP** (read-only) to `.mcp.json`. Do NOT write
      a custom diff engine; do NOT add ECR/AWS/deploy-tracking infra
      ("deployed SHA" = a configured branch like `main`).
- [ ] **Schema change** (`schemas/context.schema.json`, Architecture Stability
      Rule): add optional `code_change_context` { linked_pr, base_sha,
      head_sha, changed_files[ {path, change_type, related_risk_ids[]} ],
      summary, fetched_at }. Optional ⇒ backward-compatible, existing artifacts
      still validate.
- [ ] `agents/analyst.md` Mode B: if a linked PR exists, fetch the diff and
      write `code_change_context`; if not, skip silently (no error, no block).
- [ ] `agents/test-designer.md`: use `code_change_context` for regression
      prioritization + file→risk linkage only; still anchor primary design on
      ACs/risks. The diff never generates expected-behavior assertions.
- [ ] Incompatible-by-design with shift-left (`design_stage: pre_development`):
      no code/PR exists yet, so no diff — confirms requirement-anchoring is the
      primary path and diff is the optional enhancement.

**Definition of Done:**
- [x] GitHub MCP configured read-only (`github` in `.mcp.json`,
      `GITHUB_TOOLSETS=repos,pull_requests`); `code_change_context` optional
      in `schemas/context.schema.json` + validates (new example
      `examples/expected/code-change-aware.expected-context.json`).
- [x] Story with a linked PR produces it; story without one runs identically
      (Analyst Mode B step 2.5 skips silently when no PR — documented).
- [x] Diff used for regression scope + file→risk linkage, never expected
      behavior (analyst.md §2 + step 3, test-designer.md §2 — secondary only).
- [x] Architecture Stability Rule satisfied in one PR (schema + analyst +
      test-designer + docs (mcp-setup, context-json-guide) + example;
      optional field ⇒ no migration; .mcp.json + .env.example for the MCP).

> **Built early (enhancement bridge), not the full Phase 3.** Latent value
> until stories link real code PRs; harmless (skips when no PR).

---

## 5. Phase 3 completion criteria

Phase 3 está completa cuando:

- [ ] `scripts/run-failure-classifier.js` existe y outputs validan.
- [ ] `scripts/run-healer.js` crea patches reviewable únicamente y enforces stop conditions.
- [ ] Healer CI job procesa solo Green failures, no commits.
- [ ] Yellow y Red failures siempre requieren acción humana.
- [ ] Spec Reviewer Agent asiste Gate 3 sin reemplazar humano.
- [ ] `runs/` model existe.
- [ ] `scripts/new-run.js` funciona.
- [ ] `scripts/pipeline-metrics.js` produce métricas después de completed runs.
- [ ] Context handling token-efficient.
- [ ] Dual-judge evaluado (adoptar/deferir/rechazar documentado).
- [ ] Security/data safety docs existen.
- [ ] Agent prompts versionados.
- [ ] Reporting mejorado para release decisions.
- [ ] `/evolve` corrió al menos una vez con datos reales.
- [ ] `PHASE3-RETROSPECTIVE.md` existe.

---

## 6. Post-Phase 3: continuous improvement

Después de Phase 3, el sistema entra en modo **continuous improvement**:

- Cada 90 días o cada 10 runs: correr `/evolve`.
- Cada 5 runs: correr pipeline metrics.
- Cada major prompt change: correr evaluation dataset.
- Cada quarter: review docs vs realidad; actualizar si hay drift.

No hay Phase 4 planificada. Si surge necesidad de:
- Web dashboard → evaluar como project separado, no como extensión del pipeline.
- Multi-tenant / multi-project → evaluar como project separado.
- Full agentic batch processing sin gates → **rechazar**. Va contra el principio fundacional del sistema (human-in-the-loop en Gate 4).

---

## 7. Final instruction al IDE agent

Trabajá en pasos pequeños. En cada paso:

- Declará qué Task Group estás ejecutando.
- Preservá Phase 1, 1.5, 2 behavior.
- Validá schemas después de cambios.
- Mantené artifacts en folders ownership.
- **Nunca debilites Healer guardrails**.
- **Nunca commitees ni merguees Healer changes automáticamente**.
- Usá métricas para guiar improvements, no para bypassear humanos.
- Si un contract cambia, actualizá schema + prompt + docs + examples + migration en mismo PR.

**El primer task es Task Group 1**: verificar Phase 2 completion, luego crear `scripts/run-failure-classifier.js`.

**Después de Task Group 4** (Spec Reviewer), correr todo el vertical slice de Phase 2 para verificar que el Spec Reviewer no rompe nada.

**Después de Task Group 14**, escribí la retrospectiva. El sistema entonces entra en continuous improvement mode — no hay Phase 4.
