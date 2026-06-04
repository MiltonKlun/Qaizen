# Phase 1.5 — Rama API con Postman MCP

> **Para Claude Code:** este es el plan de Phase 1.5. **No empieces esta fase hasta que Phase 1 esté completa** (vertical slice E2E funcional + `PHASE1-RETROSPECTIVE.md` revisado).
>
> Esta fase corre en paralelo conceptualmente con E2E, pero la implementás después porque depende de los schemas y agentes ya validados en Phase 1.

---

## 0. Objetivo de Phase 1.5

Habilitar la **rama API** del pipeline. Cuando el Test Designer marca un test case como `automate_api`, hay infraestructura para:

1. Crear o adaptar una Postman Collection.
2. Definir environments con variables.
3. Ejecutar con Newman (CLI de Postman).
4. Recibir resultados estructurados.
5. Clasificar failures con el mismo Failure Classifier.
6. Producir bug drafts y release report unificados con la rama E2E.

**Phase 1.5 termina cuando una story con al menos un test case `automate_api` produce:**

1. `api-tests/collections/[story-id].postman_collection.json` validado.
2. `api-tests/environments/[story-id].postman_environment.json` validado.
3. `reports/newman-results.json` con resultados de ejecución.
4. `analysis/failure-analysis.json` que incluye failures de API (no solo E2E).
5. `release/release-report.md` cubre ambas ramas.
6. Los 4 gates aprobados (Gate 1, 2 igual; Gate 3 = collection review; Gate 4 = code review de assertions).

---

## 1. Phase 1.5 — Forbidden work

- ❌ Reescribir Postman MCP server (usar el oficial).
- ❌ Mockear APIs externos sin necesidad (usar mocks de Postman si hace falta, no inventar tooling).
- ❌ Validar contratos OpenAPI sin schema source-of-truth (si no existe OpenAPI spec, deferir contract testing a Phase 3).
- ❌ Crear un Failure Classifier separado para API. Se extiende el existente.
- ❌ Reescribir Reporter para API. Se extiende para que cubra ambas ramas.
- ❌ GitHub Actions / CI (sigue siendo Phase 2).
- ❌ Hardcodear credentials en collections (siempre vía environments).

---

## 2. Phase 1.5 — Stack adicional

| Componente | Cómo |
|---|---|
| **Newman** | `npm install --save-dev newman newman-reporter-htmlextra` |
| **Postman MCP Server oficial** | Configurado en `.mcp.json` (siguiente sección) |
| **Postman Tool Generation MCP** (opcional) | Solo si se necesita generar tools type-safe; deferir a Phase 3 |

---

## 3. Task Groups

### Task Group 1 — Instalar Newman y configurar Postman MCP

- [ ] Instalar Newman:
  ```bash
  npm install --save-dev newman newman-reporter-htmlextra
  ```
- [ ] Agregar a `package.json` scripts:
  ```json
  {
    "scripts": {
      "test:api": "newman run api-tests/collections/$STORY_ID.postman_collection.json -e api-tests/environments/$STORY_ID.postman_environment.json --reporters cli,json,htmlextra --reporter-json-export reports/newman-results.json --reporter-htmlextra-export reports/newman-html"
    }
  }
  ```
- [ ] Setup Postman MCP Server. Opción A (recomendada, npm-based):
  ```json
  {
    "mcpServers": {
      "postman": {
        "command": "npx",
        "args": ["@postman/mcp-server", "--full"],
        "env": {
          "POSTMAN_API_KEY": "${POSTMAN_API_KEY}"
        }
      }
    }
  }
  ```
  (Verificar el nombre exacto del paquete npm consultando el repo oficial `postmanlabs/postman-mcp-server`; el nombre puede haber cambiado).
- [ ] Agregar a `.env.example`:
  ```
  POSTMAN_API_KEY=
  POSTMAN_WORKSPACE_ID=
  ```
- [ ] Mergear el bloque `postman` en `.mcp.json` con los existentes (playwright, atlassian).
- [ ] Crear `docs/postman-integration.md`:
  - Cómo obtener API key de Postman.
  - Workspace structure recomendado (separar collections por story-id).
  - Por qué Phase 1.5 usa Newman para ejecución (CLI determinístico, fácil de integrar a CI en Phase 2).
  - Diferencia entre Postman MCP (para que el agente lea/escriba collections) y Newman (para ejecutar).

**Definition of Done:**
- [ ] Newman instalado y `npm run test:api` ejecutable (puede fallar si no hay collection todavía, pero el comando existe).
- [ ] Postman MCP configurado en `.mcp.json`.
- [ ] `.env.example` actualizado.
- [ ] `docs/postman-integration.md` existe.

---

### Task Group 2 — Actualizar folder ownership y crear carpetas

- [ ] Crear:
  ```
  api-tests/
  api-tests/collections/
  api-tests/environments/
  ```
- [ ] Agregar a `.gitignore`:
  ```
  reports/newman-html/
  reports/newman-results.json
  ```
  (Los results no se versionan; van a CI artifacts).
- [ ] Actualizar `docs/artifact-boundaries.md` con las nuevas filas de folder ownership de la sección 5 del README:
  - `api-tests/` → API Agent.
  - `api-tests/collections/` → API Agent.
  - `api-tests/environments/` → API Agent.

**Definition of Done:**
- [ ] Carpetas existen con `.gitkeep`.
- [ ] `docs/artifact-boundaries.md` refleja la realidad post-Phase 1.5.

---

### Task Group 3 — Extender JSON schemas para rama API

Cambio de schema = Architecture Stability Rule (ver README sección 6). Hay que actualizar en mismo PR: schema + agent prompt + docs + examples + migration si aplica.

- [ ] Actualizar `schemas/test-cases.schema.json` para soportar API test cases:
  - Agregar campo opcional `api_metadata` cuando `automation_decision == "automate_api"`:
    ```
    api_metadata (object, optional):
      - method (enum: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS")
      - endpoint (string)
      - request_body_schema_ref (string, optional)
      - response_schema_ref (string, optional)
      - auth_required (boolean)
      - expected_status_codes (array of numbers)
    ```
- [ ] Crear `schemas/postman-collection.schema.json`:
  - Schema simple que valida la estructura clave de una collection:
    - `info.name`, `info.schema`.
    - `item` array no vacío.
    - Cada item tiene `name` y `request`.
    - Cada item con tests tiene `event` array con `script.exec`.
  - Esto NO es el schema oficial de Postman (es demasiado grande). Es un schema mínimo para garantizar que lo que generamos es coherente.
- [ ] Actualizar `schemas/failure-analysis.schema.json` para incluir failures de API:
  - Agregar al `failures[]`:
    - `source` (enum: "playwright" | "newman").
    - `request_id` (string, opcional, e.g., "REQ-001").
    - `api_metadata` (object, opcional con status_code, response_body_snippet).
- [ ] Actualizar `schemas/release-report.schema.json`:
  - `execution_summary` agrupado por source:
    ```
    execution_summary:
      e2e: { total, passed, failed, skipped, pass_rate }
      api: { total, passed, failed, skipped, pass_rate }
      combined: { total, passed, failed, skipped, pass_rate }
    ```
- [ ] Actualizar `examples/expected/` con un ejemplo que incluya un test case con `automate_api` y validar.
- [ ] Crear migration script si es necesario:
  - `scripts/migrate-context-v1-to-v1.1.js` (si los `context.json` viejos no son válidos con los nuevos schemas).
  - Si los cambios son backward-compatible (todos opcionales), no necesitás migration.

**Definition of Done:**
- [ ] Los 3 schemas actualizados.
- [ ] `schemas/postman-collection.schema.json` existe.
- [ ] Examples actualizados y validan.
- [ ] Migration script existe si fue necesario.

---

### Task Group 4 — Crear API Agent

Este es el único agente custom nuevo en Phase 1.5. Genera y mantiene Postman collections desde test cases marcados como `automate_api`.

- [ ] Crear `agents/api-agent.md` con las 11 secciones estándar (ver README sección 10 / `agents/analyst.md`).

  - **Role**: lee test cases marcados como `automate_api`, genera o actualiza Postman collection + environment para esa story.
  - **Inputs**:
    - `context.json`.
    - `test-cases/[story-id].json` (filtrar solo `automation_decision == "automate_api"`).
    - Opcional: OpenAPI spec si existe en `docs/api-spec.yaml`.
  - **Outputs**:
    - `api-tests/collections/[story-id].postman_collection.json`.
    - `api-tests/environments/[story-id].postman_environment.json`.
  - **Owned files**: `api-tests/`.
  - **Forbidden**:
    - Hardcodear credentials (siempre via environment variables).
    - Modificar collections de production en Postman cloud sin aprobación.
    - Cambiar el test case (eso lo hace el Test Designer).
  - **Required schema validation**: `postman-collection.schema.json`.
  - **Traceability rules**:
    - Cada request tiene `REQ-XXX` ID (en el nombre o en custom metadata).
    - Cada request referencia el `TC-XXX` que la origina (en description).
    - La collection tiene `COL-XXX` ID en su name.
  - **When to stop and ask for human review**:
    - Si el endpoint no está documentado.
    - Si requiere auth que no está en el environment.
    - Si la response shape no está clara.
  - **Output format**: Postman Collection v2.1 format.

- [ ] El API Agent debe usar Postman MCP para:
  - Leer collections existentes (si la story ya tiene una collection, actualizar en vez de duplicar).
  - Escribir collections al workspace de Postman (opcional; primary storage es el filesystem en `api-tests/`).

**Definition of Done:**
- [ ] `agents/api-agent.md` existe con las 11 secciones.
- [ ] Apunta a `schemas/postman-collection.schema.json`.
- [ ] Documenta traceability `COL-XXX → REQ-XXX → TC-XXX`.

---

### Task Group 5 — Extender Failure Classifier para API failures

Como dijo el README: Architecture Stability Rule. Cambio coordinado.

- [ ] Actualizar `agents/failure-classifier.md`:
  - Ahora lee ambos: `reports/results.json` (Playwright) y `reports/newman-results.json` (Newman).
  - Mergea ambos en un único `analysis/failure-analysis.json` siguiendo el schema actualizado.
  - Para failures Newman:
    - Si status code no es el esperado y no es 5xx → posible `product_bug`.
    - Si status code es 5xx → posible `environment_issue` o `product_bug` (escalar a LLM).
    - Si timeout → `wait_or_timeout`.
    - Si test (post-response) script falló pero response es ok → `test_bug`.
  - Marca severidad Green/Yellow/Red:
    - Green API: timeouts esporádicos, retry-able.
    - Yellow API: cambios en shape de response que no rompen el contrato.
    - Red API: status codes incorrectos en business endpoints, data mismatch en endpoints críticos.
- [ ] Actualizar `docs/healer-guardrails.md`:
  - Healer NO toca tests de API en Phase 1.5 (ni en Phase 3 sin aprobación explícita por separado).
  - Para failures de API, siempre se generan bug drafts.

**Definition of Done:**
- [ ] `agents/failure-classifier.md` actualizado.
- [ ] `docs/healer-guardrails.md` clarifica que healer = solo Playwright tests, no Newman.

---

### Task Group 6 — Extender Reporter

- [ ] Actualizar `agents/reporter.md`:
  - Lee resultados unificados (post-classification).
  - Produce release report cubriendo ambas ramas (E2E y API) con el `execution_summary` agrupado.
  - `release_recommendation`: si **cualquiera** de las dos ramas tiene blocking failures, `fail` o `conditional_pass`.
  - Coverage_by_risk incluye TCs de ambas ramas.

**Definition of Done:**
- [ ] `agents/reporter.md` actualizado.
- [ ] Examples de expected outputs reflejan la estructura combinada.

---

### Task Group 7 — Workflow integrado del API Agent en el vertical slice

Actualizar el flujo de Phase 1 (Task Group 13) para incluir la rama API.

El flujo nuevo es:

```
Step 1-7: igual que Phase 1 (Analyst → Gate 1 → Test Designer → Gate 2)

Step 7.5: Classifier de ramas (no es un agente nuevo, es lógica simple)
  - Lee test-cases/[story-id].json.
  - Cuenta cuántos casos son automate_e2e vs automate_api.
  - Si hay automate_api > 0 → ejecutar rama API en paralelo a rama E2E.

Step 8-13 (rama E2E): igual que Phase 1.

Step 8'-13' (rama API, en paralelo):
  - Step 8': API Agent lee test-cases con automate_api.
  - Step 9': API Agent genera api-tests/collections/[story-id].postman_collection.json.
  - Step 10': API Agent genera api-tests/environments/[story-id].postman_environment.json.
  - Step 11' — Gate 3 API: review humano de la collection.
    Criterios:
      - Endpoints, métodos, payloads matchean el AC.
      - Auth está configurada correctamente.
      - Aserciones en tests cubren happy path + negative cases.
      - No hay credentials hardcodeados.
    Si aprobás: setear flag (puede ser en context.json un boolean específico) y avanzar.
  - Step 12': Validar collection contra schema:
    node scripts/validate-json.js schemas/postman-collection.schema.json api-tests/collections/[story-id].postman_collection.json
  - Step 13' — Gate 4 API: review humano de assertions específicas.
    Criterios:
      - Aserciones testan business behavior correcto.
      - Status codes esperados son correctos.
      - Response shape validations cubren campos críticos.
    Si aprobás: avanzar a ejecución.

Step 14: Ejecución
  - npm run test (E2E)
  - npm run test:api STORY_ID=[story-id] (API)

Step 15-20: Failure Classifier + Reporter procesan ambos sources.
  - Failure Classifier lee reports/results.json + reports/newman-results.json.
  - Reporter produce release-report unificado.

Step 21: PHASE1.5-RETROSPECTIVE.md
```

- [ ] Documentar este flujo en `docs/pipeline-architecture.md` (sección "API Branch — Phase 1.5+").
- [ ] Actualizar `docs/review-gates.md` para incluir el equivalente API de Gates 3 y 4.

**Definition of Done:**
- [ ] `docs/pipeline-architecture.md` cubre el flujo dual E2E/API.
- [ ] `docs/review-gates.md` lista gates equivalentes para API.

---

### Task Group 8 — Examples de API

- [ ] Crear `examples/stories/api-create-user.md` (o equivalente que matchee la app under test).
- [ ] Crear `examples/expected/api-create-user.expected-context.json`.
- [ ] Crear `examples/expected/api-create-user.expected-test-cases.json` (con al menos 1 test case `automate_api`).
- [ ] Crear `examples/expected/api-create-user.expected-collection.json` (Postman collection mínima).
- [ ] Todos deben validar.

**Definition of Done:**
- [ ] 4 archivos de ejemplo existen.
- [ ] `npm run validate:examples` corre y todo valida (incluyendo el ejemplo de API).

---

### Task Group 9 — Vertical slice de API

Igual que Phase 1 Task Group 13, pero ejecutando una story que tenga al menos 1 test case con `automate_api`.

- [ ] **Step 1**: Elegir o crear una story con componente API (puede ser la misma story de Phase 1 si tiene tanto UI como API; recomendado para validar el flujo completo).
- [ ] **Step 2-7**: Igual que Phase 1 (Analyst → Gate 1 → Test Designer → Gate 2).
  - Verificar que el Test Designer marcó al menos un TC como `automate_api`.
- [ ] **Step 8-13** (rama E2E): igual que Phase 1.
- [ ] **Step 8'-13'** (rama API, ver flujo en TG7).
- [ ] **Step 14**: Ejecutar ambas ramas.
- [ ] **Step 15-19**: Failure Classifier + Reporter procesan unificado.
- [ ] **Step 20**: Validar context.json final.
- [ ] **Step 21**: Escribir `PHASE1.5-RETROSPECTIVE.md`:
  - Qué funcionó del API Agent.
  - Cómo fue la integración Postman MCP + Newman.
  - Si hubo confusión sobre cuándo `automate_api` vs `automate_e2e`.
  - Si las aserciones generadas son robustas.
  - Recomendaciones para Phase 2 (CI/CD + writes a Jira).

**Definition of Done:**
- [ ] Una story con al menos 1 TC `automate_api` y 1 TC `automate_e2e` pasó por el pipeline completo.
- [ ] `api-tests/collections/[story-id].postman_collection.json` existe y valida.
- [ ] `api-tests/environments/[story-id].postman_environment.json` existe.
- [ ] `reports/newman-results.json` existe con resultados de ejecución.
- [ ] `analysis/failure-analysis.json` incluye failures (si las hubo) de ambas ramas.
- [ ] `release/release-report.md` cubre ambas ramas con `execution_summary` agrupado.
- [ ] `PHASE1.5-RETROSPECTIVE.md` existe.

---

## 4. Phase 1.5 completion criteria

Phase 1.5 está completa cuando:

- [ ] Postman MCP configurado y funcional.
- [ ] Newman instalado y ejecutable.
- [ ] `api-tests/` folder structure existe.
- [ ] Schemas actualizados (test-cases, failure-analysis, release-report, + nuevo postman-collection).
- [ ] API Agent existe (`agents/api-agent.md`).
- [ ] Failure Classifier y Reporter actualizados para cubrir ambas ramas.
- [ ] Vertical slice de API ejecutó exitosamente con al menos 1 TC `automate_api`.
- [ ] `PHASE1.5-RETROSPECTIVE.md` existe y fue revisado.

Si algún criterio falla, no avanzar a Phase 2.

---

## 5. Decisión opcional: contract testing

Si tu API tiene OpenAPI spec, podés validar contratos automáticamente. Pero NO en Phase 1.5 — deferir a Phase 3.

Por qué deferir:
- Contract testing añade complejidad (necesita herramienta separada: Pact, Dredd, o validar el spec con AJV).
- En Phase 1.5 lo crítico es que el flujo dual E2E/API funcione end-to-end.

Cuándo evaluar contract testing:
- Phase 3, después de 3+ runs exitosos.
- Si los failures Yellow ("shape change") son recurrentes → contract testing los atrapa antes.

---

## 6. Final instruction al IDE agent

Trabajá en pasos pequeños. En cada paso:

- Declará qué Task Group estás ejecutando.
- Verificá que el cambio respeta Architecture Stability Rule (schema + agent + docs + examples + migration).
- No introduzcas dependencias externas no listadas en sección 2.
- Si una task indica que un campo nuevo es opcional, hacelo opcional de verdad (no romper validación de artefactos de Phase 1).
- Si te encontrás escribiendo un Failure Classifier separado para API, parate. Es extensión, no agente nuevo.

**El primer task es Task Group 1**: instalar Newman y configurar Postman MCP.

**Después de Task Group 6** (Reporter extendido), correr el vertical slice de Phase 1 viejo (Phase 1 TG13) para verificar que sigue funcionando sin cambios. Architecture Stability Rule: no romper compatibilidad.

**Después de Task Group 9**, escribí la retrospectiva antes de tocar Phase 2.
