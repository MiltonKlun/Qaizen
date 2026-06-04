# Phase 2 — Integraciones, writes habilitados, CI/CD

> **Para Claude Code:** este es el plan de Phase 2. **No empieces esta fase hasta que Phase 1 + Phase 1.5 estén completas** (vertical slice E2E funcional, vertical slice API funcional, `PHASE1-RETROSPECTIVE.md` y `PHASE1.5-RETROSPECTIVE.md` revisados).

---

## 0. Objetivo de Phase 2

Pasar de pipeline local manual a **pipeline en CI/CD con writes controlados a Jira y TestLink**, manteniendo todos los gates humanos.

**Phase 2 termina cuando:**

1. GitHub Actions corre quality checks como required en PRs.
2. GitHub Actions ejecuta Playwright y Newman, sube artifacts.
3. Jira bugs pueden crearse desde bug drafts con human approval (vía MCP Atlassian con writes habilitados).
4. TestLink MCP sincroniza test cases aprobados a TestLink.
5. TestLink MCP sincroniza execution results a TestLink.
6. Review audit fields (reviewer, timestamp, notes) existen en context.json.
7. Evaluation dataset corre.
8. **3+ stories** han pasado por el pipeline completo con Jira como source.
9. `PHASE2-RETROSPECTIVE.md` existe y fue revisado.

---

## 1. Phase 2 — Prerequisitos

No empezar hasta que todos sean `true`:

- [ ] Phase 1 está completa y `PHASE1-RETROSPECTIVE.md` revisado.
- [ ] Phase 1.5 está completa y `PHASE1.5-RETROSPECTIVE.md` revisado.
- [ ] Una story (de Phase 1) y una story con API (de Phase 1.5) corrieron exitosamente.
- [ ] El equipo acordó qué Jira project se usa.
- [ ] El equipo acordó qué TestLink project se usa.
- [ ] App under test y environment strategy confirmados.

Si Phase 1 o 1.5 está inestable, **stop**. Agregar integraciones a un pipeline inestable amplifica fallos.

---

## 2. Phase 2 — Non-negotiable rules

- Mantener modo manual de Phase 1 funcionando (no romper Analyst mode A).
- Integraciones como modos opcionales, no reemplazos.
- No remover `context.json` como manifest.
- No reintroducir validadores específicos por schema (mantener `validate-json.js` genérico).
- Preservar `artifact_paths`, `run_id`, status fields, traceability IDs.
- No romper Phase 1/1.5 examples.
- **No** dejar que ninguna integración bypassee human gates.
- **No** crear Jira bugs sin comando o configuración explícita aprobada por humano.
- Hardcodear nada de mapping (priorities, statuses) — todo configurable.
- Mantener Gate 4 humano permanentemente.
- No agregar Healer automation aún (Phase 3).

---

## 3. Phase 2 — Forbidden work

- ❌ Application automática de Healer patches en CI (Phase 3).
- ❌ TestDino integration.
- ❌ `runs/` directory migration (Phase 3).
- ❌ Metrics dashboard (Phase 3).
- ❌ Multi-story batch processing (Phase 3).
- ❌ Database o queue-backed orchestration.
- ❌ Web dashboard.
- ❌ Auto-approval de Gate 3.
- ❌ Auto-merge de tests generados o healed.
- ❌ Crear bugs en Jira durante reporting normal sin flag explícita.
- ❌ Auto-cambiar estados de issues en Jira sin gate.

---

## 4. Phase 2 — Stack adicional

| Componente | Cómo |
|---|---|
| **GitHub Actions** | Workflows en `.github/workflows/` |
| **`sooperset/mcp-atlassian` con writes habilitados** | Lista expandida en `ENABLED_TOOLS` (modo apply) |
| **`dogkeeper886/testlink-mcp`** | Docker, agregado a `.mcp.json` |
| **`migrate-context-v1-to-v2.js`** (si aplica) | Script de migración para review audit fields |

---

## 5. Task Groups

### Task Group 1 — Environment files actualizados

- [ ] Verificar que `.env` está gitignored (ya debería estarlo desde Phase 1).
- [ ] Actualizar `.env.example` con keys nuevas (sin values):
  ```
  # Phase 1 (ya existentes)
  JIRA_URL=
  JIRA_USERNAME=
  JIRA_API_TOKEN=
  JIRA_PROJECT_KEY=
  CONFLUENCE_URL=
  CONFLUENCE_USERNAME=
  CONFLUENCE_API_TOKEN=
  BASE_URL=

  # Phase 1.5 (ya existentes)
  POSTMAN_API_KEY=
  POSTMAN_WORKSPACE_ID=

  # Phase 2 nuevas
  TESTLINK_URL=
  TESTLINK_API_KEY=
  TESTLINK_PROJECT_KEY=
  TESTLINK_TEST_PLAN_ID=
  ATLASSIAN_ENABLED_TOOLS_WRITE=jira_get_issue,jira_search,jira_create_issue,jira_update_issue,jira_add_comment,confluence_get_page,confluence_search
  ```
- [ ] Crear `docs/secrets-management.md`:
  - Cómo crear API tokens para Jira y TestLink.
  - Por qué credenciales nunca se commitean.
  - Cómo configurar GitHub Actions secrets (para Phase 2 CI).

**Definition of Done:**
- [ ] `.env.example` actualizado con keys nuevas (vacías).
- [ ] `docs/secrets-management.md` existe.

---

### Task Group 2 — Habilitar writes en MCP Atlassian

- [ ] Crear un segundo entry en `.mcp.json` o usar variable de entorno para alternar modes:
  ```json
  {
    "mcpServers": {
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
          "ENABLED_TOOLS": "${ATLASSIAN_ENABLED_TOOLS_WRITE}"
        }
      }
    }
  }
  ```
- [ ] Documentar en `docs/mcp-setup.md`:
  - Phase 1 usa `ENABLED_TOOLS` solo con read tools.
  - Phase 2 expande a write tools (`jira_create_issue`, `jira_update_issue`, `jira_add_comment`).
  - Cómo alternar entre dev/prod (recomendación: dos `.env` separados: `.env.dev` y `.env.prod`).
- [ ] **Crítico**: el agent NO crea Jira issues automáticamente como side effect de un command. Solo cuando hay aprobación explícita en el contexto (ver Task Group 5).

**Definition of Done:**
- [ ] MCP Atlassian con writes habilitados funcional.
- [ ] `docs/mcp-setup.md` actualizado.
- [ ] Test manual: pedirle al agent "create test issue in JIRA-XX" debe funcionar; pero no debe pasar como side effect de otras commands.

---

### Task Group 3 — Configurar TestLink MCP

- [ ] Tener TestLink corriendo (puede ser self-hosted; el agent NO instala TestLink por vos).
- [ ] Obtener API key del usuario en TestLink (User Settings → Generate API key).
- [ ] Agregar a `.mcp.json`:
  ```json
  {
    "mcpServers": {
      "testlink": {
        "command": "docker",
        "args": [
          "run", "--rm", "-i",
          "-e", "TESTLINK_URL",
          "-e", "TESTLINK_API_KEY",
          "dogkeeper886/testlink-mcp:latest"
        ],
        "env": {
          "TESTLINK_URL": "${TESTLINK_URL}",
          "TESTLINK_API_KEY": "${TESTLINK_API_KEY}"
        }
      }
    }
  }
  ```
- [ ] Crear `docs/testlink-integration.md`:
  - Cómo obtener TestLink API key.
  - Estructura recomendada de project/suite en TestLink (ej: una suite por feature, una test plan por release).
  - Mapeo de fields entre nuestro `test-cases.json` y TestLink:
    | Nuestro field | TestLink field |
    |---|---|
    | `test_case_id` (TC-XXX) | external_id o custom field |
    | `title` | name |
    | `description` | summary |
    | `preconditions` | preconditions |
    | `steps` | steps (formato actions/expected) |
    | `priority` | importance |
    | `automation_decision` | execution_type (manual=1, automated=2) |
- [ ] Test manual: pedirle al agent "list TestLink projects" debe retornar al menos el project configurado.

**Definition of Done:**
- [ ] TestLink MCP configurado y funcional.
- [ ] `docs/testlink-integration.md` existe.
- [ ] Test de conexión exitoso.

---

### Task Group 4 — Adaptar skill `syncing-testlink` desde `ai-qa-workflow`

- [ ] Clonar (temporalmente, fuera del proyecto) `dogkeeper886/ai-qa-workflow` v3.0+.
- [ ] Copiar `skills/syncing-testlink/` a nuestro proyecto en `skills/syncing-testlink/`.
- [ ] Adaptar para que:
  - Lea de nuestro `test-cases/[story-id].json` (no de los formatos custom de `ai-qa-workflow`).
  - Sincronice solo test cases con `status == "approved"`.
  - No sincronice `draft`, `rejected`, o `skip`.
  - Mapee fields según la tabla del TG3.
  - Después de sincronizar, escriba el `testlink_id` de vuelta en `test-cases.json`.
  - Linkee al Jira issue cuando `story.jira_issue_key` exista.
- [ ] Crear `scripts/sync-to-testlink.js` (mismo concepto, alternativo, en CI):
  - Lee `context.json` y `test-cases/[story-id].json`.
  - Llama al MCP TestLink (via stdin/stdout si el script lo soporta, o directamente XML-RPC si es más limpio).
  - Imprime summary de created/updated.
  - Exit 1 si falla.
  - Útil para CI/CD donde no hay agent humano.

**Definition of Done:**
- [ ] Skill `syncing-testlink` adaptado en `skills/`.
- [ ] `scripts/sync-to-testlink.js` existe.
- [ ] Test manual: sincronizar test cases de una story de Phase 1 a TestLink. Verificar que aparecen en TestLink con los fields correctos.

---

### Task Group 5 — Jira bug creation con human approval

- [ ] Documentar `docs/bug-draft-format.md`:
  - Format obligatorio para `release/bug-drafts/BUG-XXX.md`:
    ```markdown
    # BUG-XXX

    ## Summary
    [Brief description]

    ## Severity
    [red/yellow]

    ## Linked Story
    JIRA-XXX (o STORY-XXX)

    ## Linked Failure
    FAIL-XXX

    ## Linked Risk
    RISK-XXX

    ## Linked Test Case
    TC-XXX (o API-XXX)

    ## Steps to Reproduce
    1. ...
    2. ...

    ## Expected Behavior
    [What should happen]

    ## Actual Behavior
    [What happens]

    ## Environment
    [URL, version, browser/runtime]

    ## Evidence
    - reports/...
    - traces/...

    ## Jira Issue Key
    [Empty initially. Populated after successful Jira creation.]
    ```
- [ ] Actualizar `agents/failure-classifier.md` y `agents/reporter.md` para que los bug drafts sigan exactamente este format.
- [ ] Crear `scripts/create-jira-bugs.js`:
  - Lee `release/bug-drafts/BUG-*.md`.
  - Parsea las secciones level-2 del MD.
  - Check si "Jira Issue Key" ya tiene value → skip (evita duplicados).
  - Crea Jira issue via MCP Atlassian usando los datos parseados.
  - Tipo de issue: configurable via `JIRA_BUG_ISSUETYPE` env var (default "Bug").
  - Mapea severity → priority (configurable via `config/jira-priority-map.json`):
    ```json
    {
      "red": "Highest",
      "yellow": "Medium"
    }
    ```
  - Linkea el bug al original Jira story si `story.jira_issue_key` está en context.
  - Escribe el `Jira Issue Key` de vuelta al bug draft.
  - Imprime summary.
  - **Requiere flag explícito `--apply`** para crear de verdad; sin la flag, modo dry-run que solo printea qué haría.
- [ ] Actualizar `agents/reporter.md`:
  - Después de crear bugs en Jira (si fueron creados), actualizar `release/release-report.md` con los Jira keys.
  - El reporter NO crea bugs por su cuenta. Solo el script con `--apply`.

**Definition of Done:**
- [ ] `docs/bug-draft-format.md` existe.
- [ ] `scripts/create-jira-bugs.js` existe con flag `--apply`.
- [ ] `config/jira-priority-map.json` existe.
- [ ] Sin `--apply`, el script no crea nada (verificado manualmente).
- [ ] Con `--apply`, los bugs aparecen en Jira linkeados a la story original.

---

### Task Group 6 — Review audit fields

Architecture Stability Rule: schema + agent + docs + examples + migration en mismo PR.

- [ ] Actualizar `schemas/context.schema.json`:
  - Cambiar `review_gates` de booleans a estructura más rica (backward-compatible vía oneOf):
    ```
    review_gates: {
      requirements_reviewed: oneOf:
        - boolean (legacy, Phase 1)
        - object: { status: boolean, reviewer: string, reviewed_at: ISO date, notes: string }
      test_scope_reviewed: oneOf: ... idem
      specs_reviewed: oneOf: ... idem
      code_reviewed: oneOf: ... idem
    }
    ```
- [ ] Crear `scripts/migrate-context-v1-to-v2.js`:
  - Si `review_gates.X` es boolean, lo wrappea en `{ status: <boolean>, reviewer: null, reviewed_at: null, notes: null }`.
  - Idempotente (correr 2 veces no rompe nada).
- [ ] Actualizar `agents/analyst.md`, `agents/test-designer.md`, `agents/failure-classifier.md`, `agents/reporter.md`:
  - Cuando setean un gate como aprobado, ahora pueden (opcionalmente) escribir reviewer + timestamp + notes.
  - El humano que aprueba puede pasar esa info al agent ("Aprobado por @alice, motivo: AC clarificados").
- [ ] Actualizar `docs/review-gates.md`:
  - Explicar que Phase 1 booleans siguen siendo válidos.
  - Explicar el nuevo formato con audit fields.
  - Migration path.
- [ ] Actualizar examples en `examples/expected/` con un ejemplo nuevo que use el formato extendido.

**Definition of Done:**
- [ ] Schema actualizado, examples viejos siguen validando.
- [ ] Migration script funciona.
- [ ] Docs actualizados.
- [ ] Agentes saben usar el nuevo formato sin romper el viejo.

---

### Task Group 7 — Consolidación opcional de Gates 1 y 2

**Opcional pero útil**: si después de varios runs el equipo ve que Gates 1 y 2 siempre se aprueban juntos, agregar la opción de fusionarlos.

- [ ] Agregar campo opcional al schema:
  ```
  qa_scope_approved: oneOf:
    - boolean
    - object: { status, reviewer, reviewed_at, notes }
  ```
- [ ] Mantener `requirements_reviewed` y `test_scope_reviewed` como deprecated pero válidos.
- [ ] Documentar en `docs/review-gates.md`:
  - Cuándo conviene consolidar (después de 10+ runs sin discrepancia entre G1 y G2).
  - Cómo migrar (set `qa_scope_approved` y mantener los viejos por compat).
  - Gate 4 NUNCA se consolida (permanece humano permanente).

**Definition of Done:**
- [ ] Opción de consolidación disponible.
- [ ] Backward-compatible.

---

### Task Group 8 — GitHub Actions workflow

- [ ] Crear `.github/workflows/qa-pipeline.yml`:

  **Triggers**:
  - Pull requests a `main` y `develop`.
  - Manual dispatch con optional `STORY_ID`.

  **Jobs**:

  1. **`quality-checks`** (required, blocking):
     - Checkout.
     - Setup Node 20.
     - `npm ci`.
     - `npm run typecheck`.
     - `npm run lint`.
     - `npm run format:check`.
     - Validate todos los JSON contra sus schemas (script genérico).
     - Falla si cualquier check falla.

  2. **`playwright-smoke`** (opcionalmente required tras stability):
     - Corre subset smoke si existen markers/tags (ej. `@smoke`).
     - Upload de Playwright reports como artifacts.

  3. **`playwright-full`** (initially non-blocking):
     - Corre toda la suite generada.
     - `continue-on-error: true` initially (reporting only).
     - Upload de reports, traces, screenshots.

  4. **`newman-api`** (Phase 1.5 introduced, initially non-blocking):
     - Corre Newman si existe `api-tests/collections/`.
     - Upload de Newman reports.

  5. **`ci-summary`** (siempre corre):
     - Lee `reports/results.json` (Playwright) y `reports/newman-results.json` (Newman).
     - Posta summary en `$GITHUB_STEP_SUMMARY`.
     - Exit 0 solo si todos los blocking jobs pasaron.

- [ ] **Correction importante**: no crear contradicciones tipo "job non-blocking que exit 1 pero está marked as required". Si full suite es informational, `continue-on-error: true` y job separado de summary. Si smoke suite es required, dejar que falle normalmente.

- [ ] Crear `scripts/ci-summary.js`:
  - Lee `reports/results.json` y `reports/newman-results.json`.
  - Cuenta total/passed/failed/skipped por source.
  - Escribe Markdown summary a stdout y `$GITHUB_STEP_SUMMARY` si está disponible.
  - No reemplaza `failure-analysis.json` (que es generado por el Failure Classifier Agent).
  - Exit non-zero solo para blocking jobs.

- [ ] Actualizar `docs/pipeline-architecture.md`:
  - Explicar required vs informational CI jobs.
  - Por qué `quality-checks` es siempre blocking.
  - Cuándo smoke se vuelve blocking.
  - Por qué full suite puede ser non-blocking hasta estable.

- [ ] Configurar branch protection en GitHub:
  - `quality-checks` required antes de merge.
  - `playwright-smoke` opcionalmente required (decisión del project owner).

**Definition of Done:**
- [ ] `.github/workflows/qa-pipeline.yml` existe.
- [ ] CI corre en PRs.
- [ ] Quality checks blocking.
- [ ] Playwright + Newman reports suben como artifacts.
- [ ] CI summary aparece en PR.
- [ ] No commits ni merges automáticos desde CI.

---

### Task Group 9 — Update Analyst Agent input modes

- [ ] Actualizar `agents/analyst.md` con dos modes:

  **Mode A — Manual** (Phase 1, ya existe):
  - Lee `story.md` del root.
  - `story.source = "manual"`.
  - `story.id = "STORY-XXX"`.

  **Mode B — Jira (Phase 2 enhancement, ahora con writes opcionales)**:
  - Fetchea issue de Jira via `jira_get_issue` (read-only en P1, sigue siendo read-only en P2 para fetch).
  - Extrae `summary` → `story.title`.
  - Extrae `description` y `acceptance criteria` de los fields configurados.
  - Escribe copia local en `story.md` para reproducibility.
  - `story.source = "jira"`.
  - `story.id = "JIRA-XXX"` (issue key).
  - `story.jira_issue_key = "JIRA-XXX"`.
  - Opcional: si el agent tiene writes habilitados Y el humano lo aprueba explícitamente, postear comentario en Jira "QA pipeline started — context.json created".

- [ ] El switch entre modos se decide por:
  - Si hay flag `--jira JIRA-XXX` en el comando → Mode B.
  - Si hay `story.md` en root y no hay flag → Mode A.
  - Si ambos, error y stop.

**Definition of Done:**
- [ ] Analyst soporta ambos modos.
- [ ] Mode A sigue funcionando idéntico a Phase 1.
- [ ] Mode B fetchea de Jira y crea `story.md` local.

---

### Task Group 10 — Update Test Designer y Reporter para TestLink

- [ ] Actualizar `agents/test-designer.md`:
  - Después de generar `test-cases/[story-id].json` y de Gate 2 aprobado, **opcionalmente** invocar skill `syncing-testlink` para crear los test cases en TestLink.
  - Sync solo casos con `status == "approved"`.
  - Escribir `testlink_id` de vuelta en el JSON.
  - Modo dry-run por default (sin flag `--apply-testlink`); con la flag, escribe a TestLink.

- [ ] Actualizar `agents/reporter.md`:
  - Después de generar release report, **opcionalmente** sincronizar execution results a TestLink.
  - Para cada TC con `testlink_id`, actualizar el status en TestLink:
    | Failure classification | TestLink status |
    |---|---|
    | passed (test pasó) | Pass |
    | product_bug | Fail |
    | flaky | Blocked |
    | environment_issue | Blocked |
    | test_bug | Blocked |
    | test_data_issue | Blocked |
    | skipped | Not Run |
    | unknown_needs_human_review | Blocked |
  - Externalizar este map en `config/testlink-status-map.json`.
  - Modo dry-run por default; con flag `--apply-testlink-execution` escribe.

- [ ] Crear `config/testlink-status-map.json` con el mapping arriba.

**Definition of Done:**
- [ ] Test Designer puede sincronizar a TestLink (con human-approved flag).
- [ ] Reporter puede actualizar execution results en TestLink (con human-approved flag).
- [ ] Status map externalizado.
- [ ] Sin flag, ninguno escribe a TestLink.

---

### Task Group 11 — Evaluation dataset estructural

- [ ] Crear `examples/evaluation/`.
- [ ] Agregar más story examples hasta tener al menos 5 (variedad: pure UI, pure API, mixed, bug fix, enhancement).
- [ ] Expected context/test-cases outputs para cada story clave.
- [ ] Crear `scripts/evaluate-agents.js`:
  - Itera sobre `examples/stories/`.
  - Corre Analyst Agent contra cada story (en modo manual).
  - Corre Test Designer Agent.
  - Compara outputs vs expected en `examples/expected/`:
    - Compara **estructura**, no wording exact.
    - Verifica required fields.
    - Verifica patterns de IDs.
    - Verifica linkage TC → RISK.
    - Verifica presencia de `automation_decision` con reason.
  - Guarda resultados en `examples/evaluation/latest-results.json`.
  - Imprime % de matches por story.

**Definition of Done:**
- [ ] 5+ stories.
- [ ] Script de evaluación corre.
- [ ] Output JSON tiene estructura clara.
- [ ] Cambios futuros a prompts pueden evaluarse antes de adopción.

---

### Task Group 12 — Architecture Stability Rule formalizada en CI

- [ ] Agregar a `.github/workflows/qa-pipeline.yml` un check que detecta cambios a contracts:
  ```yaml
  - name: Check contract changes
    run: |
      git fetch origin main
      CHANGED_SCHEMAS=$(git diff --name-only origin/main HEAD | grep "schemas/" || true)
      CHANGED_AGENTS=$(git diff --name-only origin/main HEAD | grep "agents/" || true)
      CHANGED_DOCS=$(git diff --name-only origin/main HEAD | grep "docs/" || true)
      CHANGED_EXAMPLES=$(git diff --name-only origin/main HEAD | grep "examples/expected/" || true)

      if [ -n "$CHANGED_SCHEMAS" ] && ([ -z "$CHANGED_AGENTS" ] || [ -z "$CHANGED_DOCS" ] || [ -z "$CHANGED_EXAMPLES" ]); then
        echo "::warning::Schema changed but agents/docs/examples not updated together. See Architecture Stability Rule."
        # Esto es warning, no fail. Decisión del equipo si convierten en blocking después.
      fi
  ```
- [ ] Actualizar `docs/pipeline-architecture.md` con el Architecture Stability Rule formalizado y el check de CI.

**Definition of Done:**
- [ ] CI emite warning si schema cambia sin acompañamiento.
- [ ] Docs explican la regla.

---

### Task Group 13 — Vertical slice de Phase 2

Correr el pipeline completo con story de Jira + sync a TestLink + bug creation en Jira con human approval.

- [ ] **Step 1**: Elegir una user story real en Jira (ej. `JIRA-1234`).
- [ ] **Step 2**: Invocar Analyst en mode B (Jira):
  ```
  analyst --jira JIRA-1234
  ```
- [ ] **Step 3-7**: Gate 1, Test Designer, Gate 2 (igual que Phase 1).
- [ ] **Step 7.5**: Sync test cases aprobados a TestLink:
  ```
  test-designer --apply-testlink
  ```
  Verificar en TestLink que los test cases aparecen.
- [ ] **Step 8-13**: E2E branch (Playwright Planner, Gate 3, Generator, Gate 4).
- [ ] **Step 8'-13' (paralelo)**: API branch (si aplica, ver Phase 1.5).
- [ ] **Step 14**: Push branch y crear PR. CI debe correr quality checks + Playwright + Newman.
- [ ] **Step 15**: Mergear PR (después de pasar checks + revisión humana).
- [ ] **Step 16**: Failure Classifier procesa results.
- [ ] **Step 17**: Reporter genera release report.
- [ ] **Step 18**: Si hay bug drafts Red, correr (con aprobación humana):
  ```
  node scripts/create-jira-bugs.js --apply
  ```
  Verificar que los bugs aparecen en Jira linkeados a la story original.
- [ ] **Step 19**: Reporter sincroniza execution results a TestLink (con flag):
  ```
  reporter --apply-testlink-execution
  ```
- [ ] **Step 20**: Repetir steps 1-19 con **2 stories más** (mínimo 3 stories totales en Phase 2).
- [ ] **Step 21**: Escribir `PHASE2-RETROSPECTIVE.md`:
  - Stories procesadas.
  - Friction points en CI.
  - Tiempo total por story.
  - Si los gates siguen siendo útiles o aparece consolidación.
  - Si TestLink sync funcionó bien o tuvo fricción.
  - Si Jira bug creation duplicó o no duplicó issues.
  - Recomendaciones para Phase 3 (healing controlado).

**Definition of Done:**
- [ ] 3+ stories procesadas end-to-end con Jira como source.
- [ ] Test cases sincronizados a TestLink.
- [ ] Bugs creados en Jira con human approval.
- [ ] CI corriendo en cada PR.
- [ ] `PHASE2-RETROSPECTIVE.md` existe.

---

## 6. Phase 2 completion criteria

Phase 2 está completa cuando:

- [ ] Jira story ingestion via MCP funciona (mode B).
- [ ] Manual story input sigue funcionando (mode A).
- [ ] TestLink sync de test cases aprobados funciona con human-approved flag.
- [ ] TestLink sync de execution results funciona con human-approved flag.
- [ ] GitHub Actions corre quality checks blocking.
- [ ] Playwright + Newman reports suben como artifacts en CI.
- [ ] Jira bugs creables desde bug drafts con human control y duplicate-safe.
- [ ] Review audit fields disponibles (opcional, backward-compatible).
- [ ] Gate consolidation backward-compatible.
- [ ] Evaluation dataset corre.
- [ ] 3+ runs completos con stories de Jira.
- [ ] `PHASE2-RETROSPECTIVE.md` existe y fue revisado.

---

## 7. Final instruction al IDE agent

Trabajá en pasos pequeños. En cada paso:

- Declará qué Task Group estás ejecutando.
- Mantené Phase 1/1.5 compatibility (modo manual sigue funcionando).
- Validá schemas después de cualquier cambio.
- No rompas folder boundaries.
- No hardcodees status semantics (ni TestLink ni Jira priority).
- No crees Jira tickets reales sin instrucción explícita del humano con flag `--apply`.
- Si un contract cambia, actualizá schema + prompt + docs + examples + migration juntos en el mismo PR.

**El primer task es Task Group 1**: actualizar `.env.example` con keys nuevas.

**Después de Task Group 8** (GitHub Actions), correr el vertical slice de Phase 1 + 1.5 dentro del CI para verificar que sigue funcionando idéntico a local.

**Después de Task Group 13** (3 stories procesadas), escribí la retrospectiva antes de pensar en Phase 3.
