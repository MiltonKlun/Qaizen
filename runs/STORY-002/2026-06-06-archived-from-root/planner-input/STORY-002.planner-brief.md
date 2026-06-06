# Planner Brief — STORY-002: Account access and provisioning

## Story summary

A registered user signs in through the Saucedemo web UI. This brief
covers ONLY the UI / E2E portion of STORY-002 (acceptance criteria 1
and 2). The API provisioning portion (ACs 3–4) is handled by the API
Agent against reqres.in and is NOT the Playwright Planner's concern.

## Acceptance criteria (E2E portion)

1. (UI) Given a registered, non-locked user with valid credentials,
   when they submit the login form, then they are taken to the home
   page and see the inventory list.
2. (UI) Given an invalid password, when the user submits the form,
   then they remain on the login page and an error message explains
   the credentials were not accepted. No session is created.

## Risks (anchors)

- **RISK-001** (high): A session is created on failed login, or the
  invalid path leaves the user in an ambiguous authenticated state.
  Related ACs: 1, 2.
- **RISK-002** (high): API provisioning accepts bad data. **Not a
  Planner concern** — addressed by the API branch (TC-003, TC-004).
  Listed here only so the Planner knows it exists and is out of scope
  for UI exploration.

## In-scope scenarios for the Playwright Planner

- **Happy-path login** (addresses the positive baseline for RISK-001).
  Maps to TC-001. Drive the login form with `standard_user` /
  `secret_sauce`; observe the URL change to `/inventory.html` and the
  inventory grid.
- **Invalid-password rejection** (addresses RISK-001). Maps to TC-002.
  Submit a wrong password; observe the URL does not change, the error
  banner appears, and no `session-username` cookie is set.

## Out-of-scope for the Planner

- **The entire API branch** (ACs 3–4, TC-003, TC-004). The Planner does
  not explore reqres.in; the API Agent owns that.
- **Other Saucedemo features** — cart, checkout, sort, product detail,
  anything past the inventory landing.
- Password reset, account creation, MFA, "remember me".
- Visual styling of the error banner.

## UI baseline notes

Saucedemo is the same target validated in Phase 1 (STORY-001). Known
facts from that run: login fields are `getByRole('textbox', { name:
'Username' / 'Password' })`, the button is `getByRole('button', {
name: 'Login' })`, the post-login URL is
`https://www.saucedemo.com/inventory.html`, the invalid-credentials
error is the `h3` "Epic sadface: Username and password do not match
any user in this service", and a successful login sets a
`session-username` cookie (absent after a failed login). The Planner
should still confirm these by driving the live app, not assume them.

## Ambiguities still open

The composite-demo-story note from `context.json.ambiguities`
(non-blocking): the UI and API ACs target different demo services.
Does not affect the Planner — it only works the UI side.

## Traceability

- Story: STORY-002
- Risks covered by this brief: RISK-001 (E2E side)
- This brief is the source for: `planner-input/STORY-002.planner-brief.md`
  → `specs/STORY-002.md` (SPEC-XXX) → `tests/STORY-002.spec.ts` (PW-XXX)
- The API side (RISK-002, TC-003/TC-004) flows through the API Agent →
  `api-tests/collections/STORY-002.postman_collection.json`, not through
  the Planner.
