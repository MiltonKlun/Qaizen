# Phase 1 — Foundation + Vertical Slice E2E

> **Para Claude Code:** este es el plan de Phase 1. Antes de empezar leé `README.md` para entender el contexto general, decisiones arquitecturales, traceability IDs, folder ownership, healer guardrails y forbidden work. No empieces nada de Phase 1.5 hasta que esta fase esté completa.

---

## 0. Objetivo de Phase 1

Probar el pipeline completo localmente con **una user story real (de Jira via MCP read-only)** que produzca toda la cadena de traceability:

```
JIRA-XXX → RISK-001 → TC-001 → SPEC-001 → PW-001 → FAIL-001 (si aplica) → BUG-001 (draft)
```

**Phase 1 termina cuando una historia produce:**
1. `context.json` validado contra schema.
2. `test-cases/STORY-001.json` validado.
3. `planner-input/STORY-001.planner-brief.md`.
4. `specs/` con ≥1 Markdown spec (output de Playwright Planner).
5. `tests/` con ≥1 `.spec.ts` (output de Playwright Generator).
6. Quality checks pasando (typecheck, lint, format).
7. `reports/results.json` (output de Playwright runner).
8. `analysis/failure-analysis.json` validado.
9. `release/release-report.md` + `release/release-report.json` validado.
10. Los 4 gates marcados como `true`.
11. `PHASE1-RETROSPECTIVE.md` escrito.

---

## 1. Phase 1 — Forbidden work

No construir en esta fase (deferir a fases posteriores):

- ❌ Writes a Jira (solo MCP en modo read-only).
- ❌ Sync a TestLink (Phase 2).
- ❌ Postman / API rama (Phase 1.5).
- ❌ GitHub Actions / CI (Phase 2).
- ❌ Jira bug creation automatizada (Phase 2; en Phase 1 solo bug drafts MD).
- ❌ Healer automático (Phase 3; en Phase 1 los guardrails están documentados pero no se aplican código).
- ❌ Dual-judge framework (Phase 3 opcional).
- ❌ `/evolve` loop (Phase 3).
- ❌ Multi-story batch.
- ❌ Web dashboard / DB / queue.
- ❌ Spec Reviewer Agent (Phase 3).
- ❌ TestDino.

---

## 2. Phase 1 — Stack que se instala en esta fase

| Componente | Versión | Cuándo |
|---|---|---|
| Node.js | 20+ | Task Group 1 |
| TypeScript | 5+ strict | Task Group 2 |
| Playwright | 1.56+ | Task Group 2 |
| `@playwright/test` | última | Task Group 2 |
| ESLint v9 + `eslint-plugin-playwright` | última | Task Group 2 |
| Prettier | última | Task Group 2 |
| AJV + `ajv-formats` | última | Task Group 2 |
| Playwright Native Agents | via `npx playwright init-agents --loop=claude` | Task Group 3 |
| `sooperset/mcp-atlassian` (Docker, modo read-only) | latest | Task Group 4 |
| Microsoft Playwright MCP | via `init-agents` | Task Group 3 |

**MCPs que NO se instalan en Phase 1**: Postman MCP (Phase 1.5), TestLink MCP (Phase 2).

---

## 3. Task Groups

### Task Group 1 — Repository initialization

- [ ] Crear repo Git `ai-qa-pipeline` (o el nombre que decida el project owner).
- [ ] Crear `README.md` en raíz que apunte al `README.md` del sistema (el que tenés).
- [ ] Crear `.gitignore`:
  ```
  node_modules/
  .env
  .env.local
  *.local
  reports/
  traces/
  playwright-report/
  test-results/
  .DS_Store
  .claude/
  ```
- [ ] Crear toda la folder structure de la sección 5 del README (las carpetas marcadas como "Phase introducido = 1").
- [ ] Agregar `.gitkeep` en carpetas vacías para que se versionen.
- [ ] **No crear** carpetas marcadas como Phase 1.5, 2 o 3 todavía.

**Definition of Done:**
- [ ] Repo existe.
- [ ] `docs/`, `schemas/`, `examples/stories/`, `examples/expected/`, `agents/`, `skills/`, `test-cases/`, `planner-input/`, `specs/`, `tests/`, `tests/fixtures/`, `reports/`, `analysis/`, `release/`, `release/bug-drafts/`, `scripts/` existen.
- [ ] `release/bug-drafts/` existe desde el día 1.

---

### Task Group 2 — Initialize tooling

- [ ] `npm init -y`.
- [ ] Instalar dev dependencies:
  ```bash
  npm install --save-dev \
    typescript \
    @playwright/test \
    eslint \
    eslint-plugin-playwright \
    prettier \
    ajv \
    ajv-formats
  ```
- [ ] Verificar `@playwright/test` ≥ 1.56 con `npx playwright --version`.
- [ ] Crear `tsconfig.json`:
  - strict mode `true`.
  - target ES2022.
  - includes: `tests/**/*.ts`, `playwright.config.ts`, `scripts/**/*.ts`.
- [ ] Crear `playwright.config.ts`:
  - `testDir: './tests'`.
  - HTML report a `reports/html`.
  - JSON report a `reports/results.json`.
  - `trace: 'on-first-retry'`.
  - `screenshot: 'only-on-failure'`.
  - `baseURL` desde `process.env.BASE_URL`.
- [ ] Crear `eslint.config.mjs` (v9 flat config):
  - Habilitar plugin Playwright.
  - Activar regla `playwright/missing-playwright-await` (verificá el nombre exacto en el plugin; los nombres pueden cambiar entre versiones).
- [ ] Crear `.prettierrc`:
  - 2-space tabs.
  - single quotes.
  - trailing comma `es5`.
- [ ] Agregar scripts a `package.json`:
  ```json
  {
    "scripts": {
      "typecheck": "tsc --noEmit",
      "lint": "eslint .",
      "lint:fix": "eslint . --fix",
      "format:check": "prettier --check .",
      "format:write": "prettier --write .",
      "test": "playwright test",
      "validate:context": "node scripts/validate-json.js schemas/context.schema.json context.json",
      "validate:examples": "node scripts/validate-examples.js"
    }
  }
  ```

**Definition of Done:**
- [ ] `npm run typecheck` corre (puede fallar si no hay archivos TS aún, pero el comando existe).
- [ ] `npm run lint` corre.
- [ ] `npm run format:check` corre.
- [ ] `npm run test` corre (puede fallar sin tests, pero el comando existe).
- [ ] Falta de `await` en Playwright es detectable por el linter.

---

### Task Group 3 — Install Playwright Native Agents

- [ ] `npx playwright install` (instala browsers).
- [ ] `npx playwright init-agents --loop=claude`.
  - Esto crea `.claude/agents/` con tres archivos: `planner.md`, `generator.md`, `healer.md`.
  - Crea `.mcp.json` apuntando a `microsoft/playwright-mcp`.
  - Si la flag `--loop=claude` no funciona en tu setup, probá `--loop=vscode` y documentá en `PHASE1-RETROSPECTIVE.md`.
- [ ] Verificar que existen:
  - `.claude/agents/planner.md`
  - `.claude/agents/generator.md`
  - `.claude/agents/healer.md`
  - `.mcp.json` con entry para Playwright MCP.
- [ ] No editar estos archivos (son scaffolding regenerable).
- [ ] **Importante**: si los filenames difieren, documentarlo en `PHASE1-RETROSPECTIVE.md`. No fallar solo por eso.

**Definition of Done:**
- [ ] Los 3 agent files existen.
- [ ] `.mcp.json` existe.
- [ ] Las locations exactas están documentadas en `PHASE1-RETROSPECTIVE.md`.

---

### Task Group 4 — Configurar MCP Atlassian en modo read-only

- [ ] Tener Docker instalado y corriendo.
- [ ] Pull de imagen: `docker pull ghcr.io/sooperset/mcp-atlassian:latest`.
- [ ] Crear `.env.example` con:
  ```
  JIRA_URL=https://your-domain.atlassian.net
  JIRA_USERNAME=
  JIRA_API_TOKEN=
  JIRA_PROJECT_KEY=
  CONFLUENCE_URL=
  CONFLUENCE_USERNAME=
  CONFLUENCE_API_TOKEN=
  BASE_URL=
  ```
- [ ] Crear `.env` (gitignored) con valores reales.
- [ ] **Modo read-only en Phase 1**: limitar tools habilitados con `ENABLED_TOOLS`:
  ```
  ENABLED_TOOLS=jira_get_issue,jira_search,jira_get_issue_link_types,confluence_get_page,confluence_search
  ```
  Esto deja afuera `jira_create_issue`, `jira_update_issue`, `jira_add_comment`, etc. — todos los writes.
- [ ] Configurar el MCP en `.mcp.json` (mergear con la entry de Playwright MCP):
  ```json
  {
    "mcpServers": {
      "playwright": {
        "command": "npx",
        "args": ["@playwright/mcp@latest"]
      },
      "atlassian": {
        "command": "docker",
        "args": [
          "run", "-i", "--rm",
          "-e", "JIRA_URL",
          "-e", "JIRA_USERNAME",
          "-e", "JIRA_API_TOKEN",
          "-e", "CONFLUENCE_URL",
          "-e", "CONFLUENCE_USERNAME",
          "-e", "CONFLUENCE_API_TOKEN",
          "-e", "ENABLED_TOOLS",
          "ghcr.io/sooperset/mcp-atlassian:latest"
        ],
        "env": {
          "JIRA_URL": "${JIRA_URL}",
          "JIRA_USERNAME": "${JIRA_USERNAME}",
          "JIRA_API_TOKEN": "${JIRA_API_TOKEN}",
          "CONFLUENCE_URL": "${CONFLUENCE_URL}",
          "CONFLUENCE_USERNAME": "${CONFLUENCE_USERNAME}",
          "CONFLUENCE_API_TOKEN": "${CONFLUENCE_API_TOKEN}",
          "ENABLED_TOOLS": "${ENABLED_TOOLS}"
        }
      }
    }
  }
  ```
- [ ] Crear `docs/mcp-setup.md` documentando:
  - Cómo obtener API token de Jira.
  - Cómo verificar la conexión.
  - Por qué Phase 1 es read-only.
  - Lista exacta de `ENABLED_TOOLS` para Phase 1.

**Definition of Done:**
- [ ] Docker pull exitoso.
- [ ] `.env.example` versionado, `.env` NO versionado.
- [ ] `.mcp.json` contiene ambos MCPs.
- [ ] `docs/mcp-setup.md` existe.
- [ ] Test manual: pedirle al agent "fetch Jira issue XXX" debe retornar datos. Pedirle "create Jira issue" debe fallar (porque el tool no está en ENABLED_TOOLS).

---

### Task Group 5 — Adaptar skills de `ai-qa-workflow`

No clonamos `ai-qa-workflow` como dependencia. Copiamos los skills relevantes y los adaptamos a nuestro stack.

- [ ] Clonar el repo `dogkeeper886/ai-qa-workflow` en una carpeta temporal fuera del proyecto (solo para leer).
- [ ] De ese repo, **copiar y adaptar** los siguientes skills a `skills/` de nuestro proyecto:
  - `receiving-tickets/SKILL.md` → `skills/receiving-tickets/SKILL.md` (adaptado: en lugar de crear workspace de proyecto, llena `context.json` siguiendo nuestro schema).
  - `planning-tests/SKILL.md` → `skills/planning-tests/SKILL.md` (adaptado: en lugar de publicar a Confluence, escribe en `test-cases/` y `planner-input/` siguiendo nuestro flow).
  - `designing-cases/SKILL.md` → `skills/designing-cases/SKILL.md` (adaptado: incluye Automation Decision Model obligatorio).
  - `analyzing-logs/SKILL.md` → `skills/analyzing-logs/SKILL.md` (adaptado: escribe `analysis/failure-analysis.json` siguiendo nuestro schema).
- [ ] **No copiar** estos skills en Phase 1 (vienen después):
  - `syncing-testlink/` → Phase 2.
  - `executing-tests/` → Phase 2 (Phase 1 ejecuta manualmente con `npm run test`).
  - `creating-demo/`, `reviewing-typography/`, `drafting-review-email/` → no relevantes para este proyecto.
- [ ] Adaptar cada SKILL.md adaptado para que:
  - Referencie `schemas/*.schema.json` para validación.
  - Use traceability IDs `RISK-XXX`, `TC-XXX`, etc.
  - Apunte a los gates correctos (Gate 1 después de receiving-tickets, Gate 2 después de planning+designing).
  - Mencione que debe respetar folder ownership.
- [ ] Documentar el origen en cada SKILL.md adaptado:
  ```markdown
  ---
  name: receiving-tickets
  description: ...
  adapted_from: dogkeeper886/ai-qa-workflow @ v3.0
  ---
  ```

**Definition of Done:**
- [ ] 4 skills adaptados existen en `skills/`.
- [ ] Cada skill referencia el schema correcto.
- [ ] Cada skill documenta su origen.
- [ ] Ningún skill escribe fuera de su folder ownership.

---

### Task Group 6 — Documentación base

Crear con contenido real (no placeholders):

- [ ] `docs/pipeline-architecture.md`:
  - Propósito del sistema.
  - Scope de Phase 1.
  - Pipeline flow con diagrama.
  - Responsabilidades por agente/skill.
  - Traceability chain.
  - Out-of-scope items por fase.
- [ ] `docs/artifact-boundaries.md`:
  - Folder ownership table (copiar de README sección 5).
  - Collision-prevention rules.
- [ ] `docs/review-gates.md`:
  - 4 gates con criterios concretos.
  - Quién aprueba cada uno.
  - Qué pasa en caso de rechazo.
- [ ] `docs/healer-guardrails.md`:
  - Green/Yellow/Red con ejemplos.
  - Stop conditions.
  - Patch-only rule.
- [ ] `docs/seed-test-guidelines.md`:
  - Qué hace `tests/seed.spec.ts`.
  - Cómo se usa para el Planner.
  - Por qué fixtures se difieren.
- [ ] `docs/context-json-guide.md`:
  - Estructura de `context.json`.
  - Inline data vs file paths.
  - `artifact_paths` keys.
  - `run_id`, status fields, review_gates.
- [ ] `docs/traceability.md`:
  - Cadena completa.
  - Reglas (cada artefacto debe declarar a qué nivel superior pertenece).
  - Qué hacer si no se puede establecer link.
- [ ] `docs/automation-decision-model.md`:
  - Las 5 decisiones.
  - Cuándo usar cada una.
  - Ejemplos.
- [ ] `docs/mcp-setup.md` (ya creado en TG4).

**Definition of Done:**
- [ ] Los 8 docs existen con contenido real.
- [ ] Los docs prohíben explícitamente trabajo de Phase 1.5/2/3.

---

### Task Group 7 — Crear JSON Schemas

JSON Schema draft-07. `additionalProperties: false` donde sea práctico. Incluir traceability y status fields.

- [ ] Crear `schemas/context.schema.json`:
  ```
  Required:
  - schema_version (string)
  - run_id (string)
  - story:
      - id (string, e.g., "JIRA-123" or "STORY-001")
      - title (string)
      - source (enum: "manual" | "jira")
      - path (string)
      - description (string, optional)
      - jira_issue_key (string, optional, only if source=jira)
  - acceptance_criteria (array of strings)
  - ambiguities (array of objects {description, blocking})
  - risks (array of objects {risk_id, description, severity, related_acs})
  - artifact_paths (object):
      - test_cases (string)
      - planner_brief (string)
      - playwright_spec (string)
      - generated_test (string)
      - execution_results (string)
      - html_report (string)
      - traces (string)
      - screenshots (string)
      - failure_analysis (string)
      - release_report_md (string)
      - release_report_json (string)
      - bug_drafts_dir (string)
  - review_gates:
      - requirements_reviewed (boolean)
      - test_scope_reviewed (boolean)
      - specs_reviewed (boolean)
      - code_reviewed (boolean)
  - status (enum: "draft" | "in_progress" | "completed" | "blocked")
  ```
- [ ] Crear `schemas/test-cases.schema.json`:
  ```
  Required:
  - schema_version
  - run_id
  - story_id
  - generated_at (string, optional)
  - test_cases (array of):
      - test_case_id (string, e.g., "TC-001")
      - title
      - description
      - risk_ids (array of strings, ≥1)
      - acceptance_criteria_refs (array of strings)
      - priority (enum: "P0" | "P1" | "P2" | "P3")
      - test_level_recommendation (enum: "unit" | "component" | "integration" | "e2e" | "api")
      - automation_decision (enum: "automate_e2e" | "automate_api" | "automate_component" | "manual" | "skip")
      - automation_decision_reason (string, required)
      - preconditions (array of strings)
      - steps (array of objects {step_id, action, data})
      - expected_results (array of strings)
      - status (enum: "draft" | "approved" | "rejected")
      - qmetry_fields (object, optional placeholder for future)
      - testlink_id (string, optional, populated by Phase 2 sync)
  ```
- [ ] Crear `schemas/failure-analysis.schema.json`:
  ```
  Required:
  - schema_version
  - run_id
  - story_id
  - execution_date (string ISO)
  - total_tests (number)
  - passed (number)
  - failed (number)
  - skipped (number)
  - failures (array of objects):
      - failure_id (e.g., "FAIL-001")
      - test_case_id (reference)
      - playwright_test_id (e.g., "PW-001")
      - classification (enum):
          - locator_or_selector
          - wait_or_timeout
          - ui_structural_change
          - product_bug
          - test_bug
          - flaky
          - environment_issue
          - test_data_issue
          - unknown_needs_human_review
      - severity (enum: "green" | "yellow" | "red")
      - error_message (string)
      - evidence_paths (array of strings)
      - bug_draft_path (string, optional)
  - status (enum: "draft" | "finalized")
  ```
- [ ] Crear `schemas/release-report.schema.json`:
  ```
  Required:
  - schema_version
  - run_id
  - story_id
  - report_date (ISO string)
  - summary (string)
  - coverage_by_risk (array of objects {risk_id, covered_by_tcs, status})
  - execution_summary (object {total, passed, failed, skipped, pass_rate})
  - blocking_failures (array of failure_id references)
  - non_blocking_failures (array of failure_id references)
  - release_recommendation (enum: "pass" | "fail" | "conditional_pass" | "blocked")
  - release_recommendation_reasoning (string)
  - bug_drafts (array of objects {bug_id, severity, path, jira_key_if_exists})
  - evidence_paths (array of strings)
  - open_questions (array of strings)
  - status (enum: "draft" | "finalized")
  ```

**Definition of Done:**
- [ ] Los 4 schemas existen.
- [ ] Cada schema usa `additionalProperties: false` en objects.
- [ ] Schemas incluyen traceability IDs (RISK, TC, SPEC, PW, FAIL, BUG).
- [ ] Schemas incluyen `run_id` y `status`.

---

### Task Group 8 — Generic schema validation script

- [ ] Crear `scripts/validate-json.js`:
  - Acepta 2 argumentos: schema path y data path.
  - Usa AJV con `ajv-formats`.
  - Imprime success si valida.
  - Imprime errores con path completo si falla.
  - Exit 0 si valida, exit 1 si no.
- [ ] Crear `scripts/validate-examples.js`:
  - Itera sobre todos los `examples/expected/*.json`.
  - Cada archivo debe declarar implícita o explícitamente contra qué schema validar (puede ser por filename pattern: `*.expected-context.json` → context schema, etc.).
  - Reporta cuáles validan y cuáles no.
  - Exit 1 si alguno falla.

**Definition of Done:**
- [ ] `scripts/validate-json.js` existe y funciona.
- [ ] Usage examples documentados:
  ```
  node scripts/validate-json.js schemas/context.schema.json context.json
  node scripts/validate-json.js schemas/test-cases.schema.json test-cases/STORY-001.json
  node scripts/validate-json.js schemas/failure-analysis.schema.json analysis/failure-analysis.json
  node scripts/validate-json.js schemas/release-report.schema.json release/release-report.json
  ```
- [ ] **No** crear validadores específicos por schema. Un solo validador genérico es la fuente de verdad.

---

### Task Group 9 — Examples mínimos (evaluation-lite)

- [ ] Crear `examples/stories/`:
  - `login-success.md` (si tu app under test tiene login; si no, crear otro story que matche tu app).
  - `checkout-expired-card.md` (o equivalente).
- [ ] Crear `examples/expected/`:
  - `login-success.expected-context.json` (debe validar contra `context.schema.json`).
  - `login-success.expected-test-cases.json` (debe validar contra `test-cases.schema.json`).

**Reglas**:
- Keep examples small (no benchmark scoring en Phase 1).
- Expected outputs muestran estructura deseada, no perfect business coverage.

**Definition of Done:**
- [ ] Al menos 2 stories existen.
- [ ] Al menos 1 expected-context valida.
- [ ] Al menos 1 expected-test-cases valida.
- [ ] `npm run validate:examples` corre y todo valida.

---

### Task Group 10 — Agent instruction files

Crear los prompts de los agentes custom. **Estos son los únicos agentes custom que escribimos**; el resto reusa skills de `ai-qa-workflow`.

Cada archivo debe incluir: Role, Inputs, Outputs, Owned files, Instructions, Rules, Forbidden actions, Required schema validation, Traceability rules, When to stop and ask for human review, Output format.

- [ ] `agents/analyst.md`:
  - Role: lee story (manual desde `story.md` o desde Jira via MCP read-only) y produce `context.json`.
  - Outputs: `context.json` validado.
  - Owned files: `context.json` (creación inicial).
  - Forbidden: generar test cases, generar tests, hacer writes a Jira.
  - Traceability: crea `RISK-XXX` IDs, declara `story.id`.
  - Stop conditions: ambigüedades sin resolver → escribir en `context.json/ambiguities` y parar para Gate 1.
- [ ] `agents/test-designer.md`:
  - Role: lee `context.json` + skills/planning-tests + skills/designing-cases. Produce `test-cases/[story-id].json` y `planner-input/[story-id].planner-brief.md`.
  - **Requiere `review_gates.requirements_reviewed == true`**. Si es false, parar.
  - Aplica obligatoriamente Automation Decision Model.
  - Owned files: `test-cases/`, `planner-input/`.
  - Forbidden: escribir en `specs/`, generar código Playwright.
  - Traceability: crea `TC-XXX`, cada TC referencia ≥1 RISK.
- [ ] `agents/failure-classifier.md`:
  - Role: lee `reports/results.json` + `context.json` + `test-cases/`. Produce `analysis/failure-analysis.json` y bug drafts.
  - Owned files: `analysis/`, `release/bug-drafts/`.
  - **En Phase 1: solo clasificación + bug drafts. No auto-fix.**
  - Forbidden: modificar tests, modificar specs, commitear cambios.
  - Traceability: cada `FAIL-XXX` referencia el `PW-XXX` y el `TC-XXX` originales.
- [ ] `agents/reporter.md`:
  - Role: lee todo (context, test cases, specs, reports, analysis). Produce `release/release-report.md` + `.json`.
  - Owned files: `release/release-report.md`, `release/release-report.json`.
  - Forbidden: inventar resultados, crear Jira issues reales (Phase 2).
  - Traceability: el reporte usa la cadena completa para coverage_by_risk.

**Definition of Done:**
- [ ] Los 4 agent files existen.
- [ ] Cada uno tiene las 11 secciones listadas arriba.
- [ ] Cada uno apunta a su schema correspondiente para validación.
- [ ] Ninguno tiene instrucciones que rompan folder ownership.

---

### Task Group 11 — Seed test

- [ ] Crear `tests/seed.spec.ts`:
  ```typescript
  import { test, expect } from '@playwright/test';

  /**
   * Seed test: usado por Playwright Planner como starting point.
   * No prueba lógica de negocio, solo valida que la app carga.
   * El Planner lo usa para explorar la app desde un estado conocido.
   */
  test.describe('Seed: Environment Setup', () => {
    test('app loads at BASE_URL', async ({ page }) => {
      const baseURL = process.env.BASE_URL;
      if (!baseURL) {
        throw new Error('BASE_URL env var not set');
      }
      await page.goto(baseURL);
      // Aserción no-business: solo que el título no es vacío
      const title = await page.title();
      expect(title.length).toBeGreaterThan(0);
    });
  });

  // TODO Phase 2+: si la app requiere auth, usar storageState aquí
  // ver https://playwright.dev/docs/auth
  ```
- [ ] Crear `tests/fixtures/README.md`:
  ```markdown
  # Fixtures

  Las fixtures son app-specific y se difieren hasta que sean necesarias.
  En Phase 1 esta carpeta es un placeholder.

  Cuando se necesiten:
  - Crear `tests/fixtures.ts` con custom fixtures de Playwright.
  - Documentar cada fixture en este README.
  ```

**Definition of Done:**
- [ ] `seed.spec.ts` corre con `npm run test`.
- [ ] No incluye business assertions.

---

### Task Group 12 — Demo app y story compatibility

**Regla crítica**: no correr una story contra una app que no la soporta. Por ejemplo, no correr `login-success.md` contra TodoMVC (TodoMVC no tiene login).

- [ ] El project owner debe decidir:
  - Opción A: usar una app pública de demo (ej. https://www.saucedemo.com, https://demo.playwright.dev).
  - Opción B: usar la app real bajo test.
  - Opción C: crear una app local de demo.
- [ ] Setear `BASE_URL` en `.env` apuntando a la app elegida.
- [ ] Confirmar que la story de Phase 1 matchea la app:
  - Si la app tiene login → usar `login-success.md`.
  - Si la app es e-commerce → usar `checkout-expired-card.md`.
  - Si ninguna matchea → escribir una story custom que matchee.

**Definition of Done:**
- [ ] `BASE_URL` configurado.
- [ ] Una story específica elegida y existe el archivo `story.md` en root con su contenido.

---

### Task Group 13 — Primer vertical slice manual

Acá ejecutás el pipeline completo manualmente con una story real.

Steps:

- [ ] **Step 1**: Copiar story elegida a `story.md` en root.
- [ ] **Step 2**: Invocar Analyst Agent (con prompt de `agents/analyst.md`).
  - Si la story es manual: lee `story.md` directamente.
  - Si la story es Jira (modo opcional desde P1 ya que tenemos MCP read-only): el agent usa `jira_get_issue` del MCP Atlassian para fetchear y luego escribe una copia local en `story.md`.
  - El agent produce `context.json`.
- [ ] **Step 3**: Validar `context.json`:
  ```bash
  node scripts/validate-json.js schemas/context.schema.json context.json
  ```
- [ ] **Step 4 — Gate 1**: review humano de requirement interpretation.
  - Criterios (de `docs/review-gates.md`):
    - Acceptance criteria son accurate.
    - Ambigüedades explícitas.
    - Riesgos meaningful.
    - No se inventaron business rules.
  - Si aprobás: setear `review_gates.requirements_reviewed = true` en `context.json`, re-validar.
  - Si rechazás: volver a Analyst con correcciones explícitas.
- [ ] **Step 5**: Invocar Test Designer Agent.
  - Verifica que `requirements_reviewed == true`. Si no, para.
  - Lee `context.json` + skills `planning-tests` y `designing-cases`.
  - Aplica Automation Decision Model.
  - Produce `test-cases/[story-id].json` y `planner-input/[story-id].planner-brief.md`.
  - Actualiza `context.json.artifact_paths`.
- [ ] **Step 6**: Validar test-cases:
  ```bash
  node scripts/validate-json.js schemas/test-cases.schema.json test-cases/[story-id].json
  ```
- [ ] **Step 7 — Gate 2**: review humano de test scope.
  - Criterios:
    - Cobertura de riesgos es buena.
    - Prioridades razonables.
    - Automation decisions sensatas (no todo es E2E).
    - Cases low-value marcados como `manual` o `skip` con razón.
    - E2E scope no bloated.
  - Si aprobás: setear `review_gates.test_scope_reviewed = true`, re-validar.
  - Si rechazás: volver a Test Designer con correcciones.
- [ ] **Step 8**: Preparar y correr `tests/seed.spec.ts`:
  ```bash
  BASE_URL=https://your-app.com npm run test -- tests/seed.spec.ts
  ```
- [ ] **Step 9**: Invocar Playwright Planner Agent.
  - El agent usa el seed test como starting point + `planner-input/[story-id].planner-brief.md`.
  - Explora la app via Playwright MCP.
  - Produce `specs/[story-id].md` (Markdown spec).
  - Actualiza `context.json.artifact_paths.playwright_spec`.
- [ ] **Step 10 — Gate 3**: review humano de specs.
  - Criterios:
    - `specs/` matchea scope aprobado.
    - Expected outcomes meaningful.
    - Casos negativos presentes donde aplica.
    - No se agregaron flows no relacionados.
  - Si aprobás: setear `review_gates.specs_reviewed = true`.
  - Si rechazás: actualizar `planner-input/` y volver a correr Planner.
- [ ] **Step 11**: Invocar Playwright Generator Agent.
  - Lee `specs/[story-id].md`.
  - Produce `tests/[story-id].spec.ts`.
  - Actualiza `context.json.artifact_paths.generated_test`.
- [ ] **Step 12**: Quality checks:
  ```bash
  npm run typecheck
  npm run lint
  npm run format:check
  ```
- [ ] **Step 13 — Gate 4 (PERMANENTE)**: review humano del código generado.
  - Criterios:
    - Locators estables y semánticos.
    - Aserciones testan business behavior correcto.
    - Código legible y mantenible.
    - No hay tests skipped o weakened sin aprobación explícita.
    - No hay hard waits sin justificación.
  - Si aprobás: setear `review_gates.code_reviewed = true`.
  - Si rechazás: volver a Generator con correcciones, o editar manualmente.
- [ ] **Step 14**: Ejecutar tests:
  ```bash
  npm run test
  ```
- [ ] **Step 15**: Actualizar `context.json` con paths de reports:
  - `artifact_paths.execution_results = "reports/results.json"`
  - `artifact_paths.html_report = "reports/html"`
- [ ] **Step 16**: Invocar Failure Classifier Agent.
  - Lee `reports/results.json` + `context.json` + `test-cases/`.
  - Clasifica failures usando las clases del schema.
  - Marca severidad Green/Yellow/Red según healer guardrails.
  - Para failures Red: crea `release/bug-drafts/BUG-XXX.md`.
  - Produce `analysis/failure-analysis.json`.
- [ ] **Step 17**: Validar failure-analysis:
  ```bash
  node scripts/validate-json.js schemas/failure-analysis.schema.json analysis/failure-analysis.json
  ```
- [ ] **Step 18**: Invocar Reporter Agent.
  - Lee todo.
  - Produce `release/release-report.md` + `release/release-report.json`.
  - Incluye coverage_by_risk usando la traceability chain.
- [ ] **Step 19**: Validar release-report:
  ```bash
  node scripts/validate-json.js schemas/release-report.schema.json release/release-report.json
  ```
- [ ] **Step 20**: Validar `context.json` final:
  - Los 4 gates deben estar `true`.
  - Todos los `artifact_paths` deben apuntar a archivos existentes.
  - `status` debe ser `completed`.
- [ ] **Step 21**: Escribir `PHASE1-RETROSPECTIVE.md`:
  - Qué funcionó.
  - Qué friccionó (donde el agent se trabó, donde hubo que iterar mucho).
  - Bugs encontrados en agents/skills/schemas/docs.
  - Recomendaciones para Phase 1.5 (rama API).
  - Locations exactas de agent files generados (de TG3).
  - Si la story matcheaba la app under test.

**Definition of Done:**
- [ ] `context.json` existe y valida.
- [ ] Los 4 gates son `true`.
- [ ] `test-cases/[story-id].json` existe y valida.
- [ ] `planner-input/[story-id].planner-brief.md` existe.
- [ ] `specs/` contiene ≥1 Markdown spec.
- [ ] `tests/` contiene ≥1 `.spec.ts` generado (más el seed).
- [ ] Typecheck, lint, format checks pasan.
- [ ] `reports/results.json` existe.
- [ ] `analysis/failure-analysis.json` existe y valida.
- [ ] `release/release-report.md` existe.
- [ ] `release/release-report.json` existe y valida.
- [ ] `PHASE1-RETROSPECTIVE.md` existe.

---

## 4. Phase 1 completion criteria

Phase 1 está completa **solo si** una story produjo la cadena completa de traceability y todos los Definition of Done de los 13 task groups están marcados.

Si algún DoD no está cumplido, no avanzar a Phase 1.5.

---

## 5. Final instruction al IDE agent

Trabajá en pasos pequeños. En cada paso:

- Declará qué Task Group estás ejecutando.
- Creá solo los archivos requeridos por ese task group.
- No inventes requirements.
- No saltes validación de schemas.
- No muevas artefactos entre folders.
- No introduzcas integraciones externas no listadas en sección 2.
- Si algo no está claro, escribilo en `docs/ambiguities.md` y parate.

**El primer task es Task Group 1**: crear repo skeleton + folder structure.

**Después de Task Group 7** (schemas creados), validá con un ejemplo manual antes de avanzar — esto garantiza que los schemas son usables.

**Después de Task Group 13** (vertical slice completo), escribí la retrospectiva antes de pensar siquiera en Phase 1.5.
