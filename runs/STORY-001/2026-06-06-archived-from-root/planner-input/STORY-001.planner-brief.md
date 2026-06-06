# Planner Brief — STORY-001: Login — Successful sign-in

## Story summary

A registered, non-locked user can sign in to Saucedemo with valid
credentials and reach the inventory page that lists their available
items. The story covers the happy path plus two negative cases
(invalid password, locked account), with explicit guarantees that no
session is created on failure.

## Acceptance criteria

1. Given a registered, non-locked user with valid credentials, when
   they submit the login form, then they are taken to the home page
   and see the inventory list.
2. Given an invalid password, when the user submits the form, then
   they remain on the login page and an error message explains the
   credentials were not accepted. No partial session is created.
3. Given a locked user, when they submit valid credentials, then
   they remain on the login page and an error message explains the
   account is locked. No session is created.

## Risks (anchors)

- **RISK-001** (high): A partial session is created on failed login,
  leaving the user in an ambiguous authenticated state. Related ACs:
  2, 3.
- **RISK-002** (high): Locked-account check is enforced only in the
  UI, allowing API-level bypass. Related ACs: 3.

## In-scope scenarios for the Playwright Planner

- **Happy-path login** (addresses RISK-001 indirectly: confirms the
  positive baseline against which negative cases diverge). Maps to
  TC-001. Drive the login form with `standard_user` / `secret_sauce`,
  observe the URL change and the inventory grid.
- **Invalid-password rejection** (addresses RISK-001). Maps to
  TC-002. Submit the form with a deliberately-wrong password;
  observe that the URL does not change and an error banner appears
  with credential-rejection copy.
- _(API-only — Planner does NOT explore this; the API Agent will
  pick it up in Phase 1.5.)_ Locked-account rejection at the
  authentication boundary (addresses RISK-002). Maps to TC-003.
  Listed here only so the Planner knows TC-003 exists and is NOT
  its responsibility.

## Out-of-scope for the Planner

- **Other Saucedemo features.** Cart, checkout, product detail
  pages, sort, and any flow past the inventory landing are not part
  of this story. Do not explore them even if the seed test or the
  happy path lands on a page that exposes them.
- **Password reset, account creation, social login, MFA, "remember
  me".** Explicitly excluded by the story's "Out of scope" section.
- **Performance / login latency.** Excluded by the story.
- **Visual styling** of the error banner. Covered by TC-004 as
  `manual`; the Planner does not script it.
- **The locked-account check** as a UI scenario. The Test Designer
  classified the meaningful assertion as `automate_api` (TC-003,
  see TC list). The Planner may navigate the UI path only as
  observation, but does NOT write an automated scenario for it
  here — that would create an E2E sibling that duplicates the API
  test.

## UI baseline notes

Saucedemo is a long-running public demo SPA. The landing page lists
the four test usernames (`standard_user`, `locked_out_user`,
`problem_user`, `performance_glitch_user`) and the shared password
(`secret_sauce`) directly on the login screen. This is intentional
documentation, not a security oversight to flag. The Planner may
read these values from the page; no separate test-data fixture is
needed.

The post-login URL is `/inventory.html` (single page); inventory
items render in a grid with `.inventory_item` selectors. Modern
selectors (`getByRole`, `getByText`) should be preferred over
class-based locators per Gate 4 criteria.

## Ambiguities still open

None. The story is well-defined for Phase 1 scope.

## Traceability

- Story: STORY-001
- Risks covered: RISK-001, RISK-002
- This brief is the source for:
  `planner-input/STORY-001.planner-brief.md` →
  `specs/STORY-001.md` (SPEC-XXX scenarios) →
  `tests/STORY-001.spec.ts` (PW-XXX tests)
- Out-of-band sibling: TC-003 (`automate_api`) is handled by the
  Phase 1.5 API Agent against a separate target (`reqres.in`; see
  `docs/ambiguities.md` A3 for the reasoning). In Phase 1 it is
  recorded but not executed.
