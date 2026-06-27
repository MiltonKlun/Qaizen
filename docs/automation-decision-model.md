# Automation Decision Model

> **Status:** Phase 1 baseline. The model applies from Phase 1 day-zero.
> Phase 1.5 wires the `automate_api` decision to actual Postman / Newman
> tooling; until then `automate_api` cases are recorded but not yet
> executed.

Every test case the Test Designer writes carries an
`automation_decision` field. This document is the canonical reference
for the five possible values, when each is right, and the failure
modes the model is designed to prevent.

The model is one of the most-policed rules in the pipeline. It is
enforced at three places:

- `schemas/test-cases.schema.json` requires the field to be one of
  the five enum values, and requires `automation_decision_reason` to
  be non-empty.
- `skills/designing-cases/SKILL.md` instructs the Test Designer to
  apply the model to every TC.
- `docs/review-gates.md` Gate 2 rejects E2E-heavy lists and generic
  reasons.

The model is **track-independent**: `automation_decision` and a real
`automation_decision_reason` are mandatory on every test case in **every**
track, including `lite` (`docs/context-json-guide.md`). Lite trims narrative
_prose_, never this decision — choosing the right test level is a judgment
lite must still make.

---

## 1. The five decisions

| Value                | When to use                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `automate_e2e`       | High-value user journey, smoke / regression critical, UI-critical flow that an API call alone cannot validate.                                         |
| `automate_api`       | Business logic, validations, permissions, filtering, data-heavy checks that do not require UI verification.                                            |
| `automate_component` | UI state that lives below the E2E level — a single component in isolation. Use sparingly; in this pipeline most "component" needs are absorbed by E2E. |
| `manual`             | Exploratory, usability, subjective visual checks, accessibility review with human judgment.                                                            |
| `skip`               | Low-risk, duplicate of another case, or out-of-scope.                                                                                                  |

Every TC gets exactly one of the five. Every TC also gets an
`automation_decision_reason` that is a real explanation, not a
restatement of the decision.

---

## 2. The failure mode the model exists to prevent

> The "everything is E2E" failure mode.

Without the model, test designers default to `automate_e2e` because
E2E "feels comprehensive". The result: a 30-case suite where 25
cases drive the UI to test things the API could verify in a fraction
of the time and a fraction of the flakiness.

That suite then:

- Takes hours to run.
- Flakes intermittently because the UI is the most flaky layer.
- Misses obvious bugs that an API check would catch immediately
  (permission bypass, validation off-by-one, broken filter).
- Costs the team's confidence in the suite — when 5% of runs fail
  for "Playwright reasons" rather than "a bug", people stop reading
  the failures.

The model exists so this conversation happens at Gate 2 instead of
six months in. A Gate 2 reviewer who sees > ~60% `automate_e2e` is
explicitly instructed (see `docs/review-gates.md`) to push back.

---

## 3. `automate_e2e` — use when

The thing you're testing **is** the user journey. The UI's visible
state is the thing the AC speaks about. There is no faster, more
reliable layer that would tell you the same answer.

Good signals:

- The AC talks about what the user sees and does — "the user can
  complete checkout", "the dashboard shows the right widget".
- The path crosses multiple pages and back-end calls; checking each
  call separately would not validate the integration.
- A regression here is high-cost and customer-visible.

Examples:

- "User can sign up, verify email, and reach the dashboard."
- "Adding an item to the cart, applying a promo code, and checking
  out arrives at the order confirmation page."
- "The admin can edit a user's role and the change takes effect on
  the user's next page load."

Anti-patterns (don't use `automate_e2e` for):

- Validation of a single field's format. An API test verifies that
  faster and more reliably.
- Permission checks where the UI happens to render an error page —
  the actual permission is enforced at the API; test it there.
- Data filtering / sorting / pagination where the UI just renders
  whatever the API returned.

---

## 4. `automate_api` — use when

The thing you're testing **is** the contract or business rule, not
the UI representation of it.

Good signals:

- The AC is about server-side behavior — "the API rejects payloads
  larger than 1 MB", "only admins can call `/users/:id/delete`",
  "the search returns at most 100 results".
- The check is deterministic given input → output, and the UI is
  just a window onto it.
- Data-heavy: filtering, sorting, pagination, aggregation.
- Permission / security checks.

Examples:

- "POST /reservations with a past date returns 400 with code
  `invalid_date`."
- "A user with role `viewer` cannot call DELETE /projects/:id (gets
  403)."
- "Search results are paginated to 50 by default and accept a
  `limit` up to 200."
- "Adding a comment to an issue triggers a webhook with the comment
  payload."

Cases marked `automate_api` are executed by the API branch (Postman +
Newman) via the API Agent.

Anti-patterns:

- Hitting an API endpoint just to set up state for a UI test. That's
  not an API _test_ — that's a fixture. Fixtures live in
  `tests/fixtures/`.
- Testing what the UI renders. If the assertion is "the user sees
  X on the screen", that's E2E, not API.

---

## 5. `automate_component` — use when

A single UI component's behavior needs to be exercised in isolation,
without dragging the rest of the application into the test.

Good signals:

- The component has rich internal state (a wizard, a date-range
  picker, a multi-step form).
- That state is hard or expensive to reach via E2E.
- The component is reused across multiple flows and a regression
  here propagates everywhere.

Examples:

- "The date-range picker disables dates outside the configured
  min/max range."
- "The autocomplete debounces input by 200 ms and merges queries
  while typing."
- "The accordion preserves open/closed state across re-renders."

In this pipeline `automate_component` is **rare**. The system does
not ship a component-test runner separate from Playwright; component
tests would run as Playwright Component Tests, which require their
own scaffolding. Defer this until there is a real need; document
the deferral in the TC's `automation_decision_reason`.

Anti-patterns:

- Using `automate_component` for things that are really small E2E
  flows. If two clicks reach the component from a known page,
  `automate_e2e` is usually right.

---

## 6. `manual` — use when

The check requires human judgment that an automated assertion cannot
make reliably.

Good signals:

- Subjective: "the layout looks balanced on a 13-inch screen", "the
  copy reads professionally".
- Accessibility review: an automated a11y scan (axe, lighthouse)
  catches the mechanical issues; a human still has to walk through
  with a screen reader to find the ones the scan misses.
- Exploratory: poking around the new flow looking for things the
  spec didn't anticipate.
- Usability research: watching a real user complete the task.

Examples:

- "The empty-state illustration is clear and on-brand."
- "Tabbing through the form reaches every interactive element in
  reading order."
- "Exploratory: poke at the new permissions UI for 30 minutes."

The TC still gets written down. Manual cases go into TestLink in
Phase 2 (via `skills/syncing-testlink`) and into the release report's
manual section. They are not silently dropped.

Anti-patterns:

- Marking a flaky case as `manual` to avoid debugging it. Flakiness
  is a classification, not a decision. Use the Failure Classifier
  in `analysis/failure-analysis.json`; don't escape automation by
  declaring the test manual.
- Marking everything as `manual` because automation is hard. The
  whole pipeline assumes most cases are automated; if the suite is
  > 50% manual, the team has a tooling problem, not a model problem.

---

## 7. `skip` — use when

The case shouldn't run, and the reason needs to be written down.

Good signals:

- Duplicate of another case (cite the TC).
- Out-of-scope for this story (cite the boundary in the planner
  brief).
- Low-risk to the point that running it costs more than the
  information is worth.
- Blocked by a missing precondition that is out of scope to fix.

Examples:

- "TC-007: duplicate of TC-003 — same login flow, different valid
  credentials. Skip."
- "TC-019: tests admin promotion, but this story does not change
  admin behavior. Skip."

`skip` is the only decision where the reason is most of the value.
A skipped case with reason `"low value"` is useless — the next
person reading the file can't tell whether the skip was justified.
Demand specificity.

Anti-patterns:

- Marking failing tests as `skip` to make the suite green. That's
  the Healer guardrail violation pattern; see
  `docs/healer-guardrails.md`.
- Marking everything you didn't write a case for as `skip`.
  `skip` is for cases the Test Designer wrote down and then decided
  not to run. It's not a catch-all for unwritten things.

---

## 8. Distribution sanity check

A rough sanity check for the Gate 2 reviewer:

| Decision             | Typical share of TCs (rough)                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `automate_e2e`       | 20–40%. Higher than this is a red flag unless the story is mostly UI journey.                            |
| `automate_api`       | 30–60%. Higher than this means the story is mostly back-end; that's fine.                                |
| `automate_component` | 0–10%. Higher than this means the team is doing component-test work that probably belongs in unit tests. |
| `manual`             | 5–15%. Higher than this means automation is missing something; investigate before accepting.             |
| `skip`               | 0–10%. Higher than this means the Test Designer cast too wide a net at the AC level.                     |

These are sanity ranges, not targets. A story that genuinely has 80%
API surface and a thin UI will have 80% `automate_api` and that's
right. The point of the table is to make outliers visible enough to
ask why.

---

## 9. Writing a real `automation_decision_reason`

What a real reason looks like:

> `"automate_api"` — "This is a server-side validation rule. The UI
> only displays whatever error the API returns. Testing via API is
> deterministic (no UI render time, no animation flake) and covers
> the actual rule that matters."

What a generic reason looks like (Gate 2 rejection):

> `"automate_e2e"` — "It's UI."

> `"automate_api"` — "API test."

> `"skip"` — "Low priority."

The reason serves two purposes:

1. **Defending the choice today** to the Gate 2 reviewer.
2. **Re-deciding later** when the team revisits the suite — the
   reason should still make sense in six months without the
   original author present.

---

## 10. Phase scope reminder

| Phase | What works                                                                                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | All five decisions are recorded. `automate_e2e` runs end-to-end. `automate_api` is recorded but not yet executed (no Postman / Newman). |
| 1.5   | `automate_api` cases feed the API Agent and run via Newman. `automate_component` is still rare / deferred.                              |
| 2     | `manual` cases sync to TestLink. `skip` cases sync as not-run. Bugs from any branch promote to Jira on `--apply`.                       |
| 3     | All of the above, plus pipeline metrics tracking the distribution of decisions over time. `/evolve` flags drift in the model.           |

Do not invent new decision values. The five above are the canonical
set. If a TC genuinely doesn't fit any of the five, that's a
Gate 2 conversation, not a freelance schema change.

---

## 11. References

- `schemas/test-cases.schema.json` — the enum is defined here
  (Phase 1 TG7).
- `skills/designing-cases/SKILL.md` — instructs the Test Designer
  to apply the model.
- `docs/review-gates.md` Gate 2 — checks the distribution and the
  reasons.
- `docs/pipeline-architecture.md` section 5 — how `automate_api`
  feeds the Phase 1.5 API branch.
- `README.md` section 8 — the decision model as a system-level rule.
